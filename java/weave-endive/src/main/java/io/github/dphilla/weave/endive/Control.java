package io.github.dphilla.weave.endive;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.core.StreamReadFeature;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.PropertyNamingStrategies;
import com.fasterxml.jackson.databind.annotation.JsonDeserialize;
import com.fasterxml.jackson.databind.exc.MismatchedInputException;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import java.io.IOException;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/** Structured control schema v1, as weave-core's ControlState; callers hold the node lock. */
final class Control {
    enum Completion {
        MIGRATED,
        COMMIT_UNCERTAIN,
        FAILED_BEFORE_COMMIT,
        COMPLETED,
        TRAPPED
    }

    enum Action {
        STATUS,
        MIGRATE,
        OPERATION;

        // Exact names only: Jackson's own enum lookup trims whitespace and accepts ordinals.
        @JsonCreator(mode = JsonCreator.Mode.DELEGATING)
        static Action of(String name) {
            for (Action action : values()) {
                if (action.name().toLowerCase(Locale.ROOT).equals(name)) {
                    return action;
                }
            }
            throw new IllegalArgumentException("invalid action");
        }
    }

    /** weave-core's control::Request; an absent optional field and null are the same. */
    static final class Request {
        @JsonDeserialize(using = U32.class)
        public Long schemaVersion;

        public Action action;
        public String nodeEpoch;
        public String operationId;
        public String target;
    }

    /** weave-core's control::Operation, one ledger entry. */
    static final class Operation {
        public final String operationId;
        public final String target;
        public String state = "accepted";
        public String code = "ACCEPTED";
        public String ownership = "retained";
        public String retry = "same_operation";
        public String message = "migration accepted; query this operation ID for its outcome";

        Operation(String operationId, String target) {
            this.operationId = operationId;
            this.target = target;
        }
    }

    /** weave-core's control::Response. */
    static final class Response {
        public final int schemaVersion = 1;
        public final boolean ok;
        public final String code;
        public final String message;
        public final String nodeEpoch;
        public final String lifecycle;
        public final String ownership;
        public final String retry;
        public final Operation operation;
        public final Capabilities capabilities;

        Response(
                Control control,
                boolean ok,
                String code,
                String message,
                String retry,
                Operation operation,
                Capabilities capabilities) {
            this.ok = ok;
            this.code = code;
            this.message = Wire.bounded(message);
            this.nodeEpoch = control.epoch;
            this.lifecycle = control.lifecycle;
            this.ownership = control.ownership;
            this.retry = retry;
            this.operation = operation;
            this.capabilities = capabilities;
        }
    }

    /** Only what this node verifiably supports: Endive's compiler has no SIMD. */
    static final class Capabilities {
        public final String runtime = "endive";
        public final String adapterVersion = "0.1.0";
        public final int migrationProtocol = 2;
        public final List<String> services = List.of("env.emit", "env.emit32", "env.emit64");
        public final List<Import> imports =
                List.of(
                        new Import("emit", "i32", "i64"),
                        new Import("emit32", "i32"),
                        new Import("emit64", "i64"));
        public final List<String> features =
                List.of(
                        "multi_memory",
                        "reference_types",
                        "bulk_memory",
                        "multi_value",
                        "sign_extension",
                        "saturating_float_to_int");
        public final Limits limits = new Limits();
    }

    static final class Import {
        public final String module = "env";
        public final String name;
        public final List<String> params;
        public final List<String> results = List.of();

        Import(String name, String... params) {
            this.name = name;
            this.params = List.of(params);
        }
    }

    static final class Limits {
        public final int controlFrameBytes = Wire.MAX_CONTROL;
        public final int retainedOperations = MAX_OPERATIONS;
        public final int operationIdBytes = 128;
        public final long memoryBytes = WovenModule.MAX_MEMORY_BYTES;
        public final long moduleBytes = TargetSession.MAX_MODULE_BYTES;
    }

    // serde's u32: a plain integer token, so -0, 1.0, "1" and 2^32 are invalid.
    static final class U32 extends JsonDeserializer<Long> {
        @Override
        public Long deserialize(JsonParser p, DeserializationContext ctx) throws IOException {
            if (p.hasToken(JsonToken.VALUE_NUMBER_INT)
                    && p.getText().matches("0|[1-9][0-9]{0,9}")
                    && p.getLongValue() <= 0xffff_ffffL) {
                return p.getLongValue();
            }
            throw MismatchedInputException.from(p, Long.class, "expected a u32");
        }
    }

    // serde's String: never a coerced scalar, and never an unpaired surrogate.
    static final class Text extends JsonDeserializer<String> {
        @Override
        public String deserialize(JsonParser p, DeserializationContext ctx) throws IOException {
            if (p.hasToken(JsonToken.VALUE_STRING)
                    && p.getText()
                            .codePoints()
                            .noneMatch(
                                    c ->
                                            c >= Character.MIN_SURROGATE
                                                    && c <= Character.MAX_SURROGATE)) {
                return p.getText();
            }
            throw MismatchedInputException.from(p, String.class, "expected a well-formed string");
        }
    }

    // As strict as serde: duplicate or unknown fields and trailing tokens are errors.
    private static final ObjectMapper JSON =
            JsonMapper.builder()
                    .propertyNamingStrategy(PropertyNamingStrategies.SNAKE_CASE)
                    .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
                    .enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
                    .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
                    .addModule(new SimpleModule().addDeserializer(String.class, new Text()))
                    .build();
    private static final Capabilities CAPABILITIES = new Capabilities();
    private static final int MAX_OPERATIONS = 256;

    final String epoch;
    private final Map<String, Operation> operations = new HashMap<>();
    private Operation active;
    private String lifecycle;
    private String ownership;
    // The target of the migration the last handle() call accepted, if any.
    String accepted;

    Control(String lifecycle) {
        byte[] entropy = new byte[16];
        new SecureRandom().nextBytes(entropy);
        epoch = Bytes.hex(entropy);
        set(lifecycle);
    }

    void set(String lifecycle) {
        this.lifecycle = lifecycle;
        boolean retained = lifecycle.equals("running") || lifecycle.equals("migrating");
        ownership = retained ? "retained" : lifecycle.equals("retired") ? "retired" : "none";
    }

    byte[] handle(byte[] payload, boolean canMigrate) {
        accepted = null;
        Request req;
        try {
            req = JSON.readValue(Bytes.utf8(payload, 0, payload.length), Request.class);
        } catch (FormatException e) {
            return error("INVALID_REQUEST", e.getMessage(), "never");
        } catch (JsonProcessingException e) {
            return error("INVALID_REQUEST", e.getOriginalMessage(), "never");
        }
        if (req == null || req.schemaVersion == null || req.action == null) {
            return error("INVALID_REQUEST", "schema_version and action are required", "never");
        }
        if (req.schemaVersion != 1) {
            return error("UNSUPPORTED_SCHEMA", "unsupported control schema version", "never");
        }
        if (req.action == Action.STATUS) {
            return req.nodeEpoch == null && req.operationId == null && req.target == null
                    ? status()
                    : error("INVALID_REQUEST", "status does not accept operation fields", "never");
        }
        if (!epoch.equals(req.nodeEpoch)) {
            return error(
                    "NODE_EPOCH_MISMATCH",
                    "node epoch is missing or changed; inspect ownership before submitting a new"
                            + " operation",
                    "inspect_ownership");
        }
        String id = req.operationId;
        if (id == null || !id.matches("[A-Za-z0-9._-]{1,128}")) {
            return error(
                    "INVALID_REQUEST",
                    "operation_id must be 1..128 ASCII letters, digits, '.', '_' or '-'",
                    "never");
        }
        Operation op = operations.get(id);
        if (req.action == Action.OPERATION) {
            if (req.target != null) {
                return error("INVALID_REQUEST", "operation lookup does not accept target", "never");
            }
            return op != null
                    ? response(op)
                    : error(
                            "OPERATION_NOT_FOUND",
                            "operation was not accepted in this node epoch",
                            "same_operation");
        }
        String target = req.target;
        if (target == null || !validTarget(target)) {
            return error(
                    "INVALID_REQUEST",
                    "target must be a nonempty host:port address with port 1..65535",
                    "never");
        }
        if (op != null) {
            return op.target.equals(target)
                    ? response(op)
                    : error(
                            "OPERATION_CONFLICT",
                            "operation_id was already accepted with a different target",
                            "never");
        }
        if (operations.size() >= MAX_OPERATIONS) {
            return error(
                    "OPERATION_CAPACITY",
                    "node operation ledger is full; accepted IDs are never evicted",
                    "never");
        }
        if (active != null || lifecycle.equals("migrating") || lifecycle.equals("accepting")) {
            return error("NODE_BUSY", "node already has an active migration", "new_operation");
        }
        if (!canMigrate || !lifecycle.equals("running")) {
            return error("NO_ACTIVE_WORKLOAD", "node has no active workload", "never");
        }
        active = new Operation(id, target);
        operations.put(id, active);
        set("migrating");
        accepted = target;
        return response(active);
    }

    byte[] status() {
        return response(true, "STATUS_OK", "node status", "never", active, CAPABILITIES);
    }

    void sourceRetired() {
        set("retired");
        if (active != null) {
            active.code = "COMMIT_PENDING";
            active.ownership = "retired";
            active.retry = "inspect_ownership";
            active.message = "source retired; commit confirmation is pending";
        }
    }

    /** Records a runtime outcome; a retired source can never become a pre-commit failure. */
    Completion complete(Completion completion, String message) {
        if (completion == Completion.FAILED_BEFORE_COMMIT
                && active != null
                && active.ownership.equals("retired")) {
            completion = Completion.COMMIT_UNCERTAIN;
        }
        String state = "failed";
        String code;
        String retry = "never";
        switch (completion) {
            case MIGRATED:
                state = "succeeded";
                code = "MIGRATED";
                set("retired");
                break;
            case COMMIT_UNCERTAIN:
                state = "uncertain";
                code = "COMMIT_UNCERTAIN";
                retry = "inspect_ownership";
                set("retired");
                break;
            case FAILED_BEFORE_COMMIT:
                code = "MIGRATION_FAILED";
                retry = "new_operation";
                set("running");
                break;
            case COMPLETED:
                code = "WORKLOAD_COMPLETED";
                set("completed");
                break;
            default:
                code = "WORKLOAD_TRAPPED";
                set("failed");
        }
        if (active != null) {
            active.state = state;
            active.code = code;
            active.ownership = ownership;
            active.retry = retry;
            active.message = Wire.bounded(message);
            active = null;
        }
        return completion;
    }

    private byte[] response(Operation op) {
        boolean ok = op.state.equals("accepted") || op.state.equals("succeeded");
        return response(ok, op.code, op.message, op.retry, op, null);
    }

    private byte[] error(String code, String message, String retry) {
        return response(false, code, message, retry, null, null);
    }

    private byte[] response(
            boolean ok,
            String code,
            String message,
            String retry,
            Operation op,
            Capabilities caps) {
        try {
            return JSON.writeValueAsBytes(new Response(this, ok, code, message, retry, op, caps));
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    // Same rules as weave-core's valid_target; a bracketed literal never reaches DNS.
    private static boolean validTarget(String target) {
        if (Bytes.utf8(target).length > 4096
                || target.codePoints()
                        .anyMatch(
                                c ->
                                        Character.isWhitespace(c)
                                                || Character.isSpaceChar(c)
                                                || Character.isISOControl(c))) {
            return false;
        }
        int colon = target.lastIndexOf(':');
        String host = target.substring(0, Math.max(colon, 0));
        String port = target.substring(colon + 1).replaceFirst("^0+(?=.)", "");
        if (colon < 0
                || !port.matches("[0-9]{1,5}")
                || Integer.parseInt(port) == 0
                || Integer.parseInt(port) > 65535) {
            return false;
        }
        if (!host.startsWith("[")) {
            return !host.isEmpty() && host.chars().noneMatch(c -> c == ':' || c == '[' || c == ']');
        }
        if (!host.endsWith("]") || !host.contains(":") || host.contains("%")) {
            return false;
        }
        try {
            InetAddress.getByName(host);
            return true;
        } catch (UnknownHostException e) {
            return false;
        }
    }
}
