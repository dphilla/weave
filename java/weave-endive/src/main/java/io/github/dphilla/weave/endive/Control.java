package io.github.dphilla.weave.endive;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.List;
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

    private static final List<String> FIELDS =
            List.of("schema_version", "action", "node_epoch", "operation_id", "target");
    // Only what this node verifiably supports: Endive's compiler has no SIMD.
    private static final String CAPABILITIES =
            "{\"runtime\":\"endive\",\"adapter_version\":\"0.1.0\",\"migration_protocol\":2,"
                + "\"services\":[\"env.emit\",\"env.emit32\",\"env.emit64\"],\"imports\":["
                + "{\"module\":\"env\",\"name\":\"emit\",\"params\":[\"i32\",\"i64\"],\"results\":[]},"
                + "{\"module\":\"env\",\"name\":\"emit32\",\"params\":[\"i32\"],\"results\":[]},"
                + "{\"module\":\"env\",\"name\":\"emit64\",\"params\":[\"i64\"],\"results\":[]}],"
                + "\"features\":[\"multi_memory\",\"reference_types\",\"bulk_memory\",\"multi_value\","
                + "\"sign_extension\",\"saturating_float_to_int\"],\"limits\":{"
                + "\"control_frame_bytes\":65536,\"retained_operations\":256,\"operation_id_bytes\":128,"
                + "\"memory_bytes\":"
                    + WovenModule.MAX_MEMORY_BYTES
                    + ",\"module_bytes\":"
                    + TargetSession.MAX_MODULE_BYTES
                    + "}}";

    private static final class Operation {
        final String id;
        final String target;
        String state = "accepted";
        String code = "ACCEPTED";
        String ownership = "retained";
        String retry = "same_operation";
        String message = "migration accepted; query this operation ID for its outcome";

        Operation(String id, String target) {
            this.id = id;
            this.target = target;
        }

        String json() {
            return String.format(
                    "{\"operation_id\":%s,\"target\":%s,\"state\":%s,\"code\":%s,\"ownership\":%s,"
                            + "\"retry\":%s,\"message\":%s}",
                    Json.quote(id),
                    Json.quote(target),
                    Json.quote(state),
                    Json.quote(code),
                    Json.quote(ownership),
                    Json.quote(retry),
                    Json.quote(message));
        }
    }

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
        Map<String, Object> req;
        try {
            req = Json.parseObject(payload);
        } catch (FormatException e) {
            return error("INVALID_REQUEST", e.getMessage(), "never");
        }
        Object version = req.get("schema_version");
        Object action = req.get("action");
        boolean typed =
                FIELDS.containsAll(req.keySet())
                        && version instanceof Json.Num
                        && List.of("status", "migrate", "operation").contains(action)
                        && optionalStrings(req);
        if (!typed || !isU32(((Json.Num) version).token)) {
            return error(
                    "INVALID_REQUEST", "unknown field, invalid type or invalid action", "never");
        }
        if (!((Json.Num) version).token.equals("1")) {
            return error("UNSUPPORTED_SCHEMA", "unsupported control schema version", "never");
        }
        String nodeEpoch = (String) req.get("node_epoch");
        String id = (String) req.get("operation_id");
        String target = (String) req.get("target");
        if (action.equals("status")) {
            return nodeEpoch == null && id == null && target == null
                    ? status()
                    : error("INVALID_REQUEST", "status does not accept operation fields", "never");
        }
        if (!epoch.equals(nodeEpoch)) {
            return error(
                    "NODE_EPOCH_MISMATCH",
                    "node epoch is missing or changed; inspect ownership before submitting a new"
                            + " operation",
                    "inspect_ownership");
        }
        if (id == null || !id.matches("[A-Za-z0-9._-]{1,128}")) {
            return error(
                    "INVALID_REQUEST",
                    "operation_id must be 1..128 ASCII letters, digits, '.', '_' or '-'",
                    "never");
        }
        Operation op = operations.get(id);
        if (action.equals("operation")) {
            if (target != null) {
                return error("INVALID_REQUEST", "operation lookup does not accept target", "never");
            }
            return op != null
                    ? response(op)
                    : error(
                            "OPERATION_NOT_FOUND",
                            "operation was not accepted in this node epoch",
                            "same_operation");
        }
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
        if (operations.size() >= 256) {
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
            boolean ok, String code, String message, String retry, Operation op, String caps) {
        return Bytes.utf8(
                String.format(
                        "{\"schema_version\":1,\"ok\":%s,\"code\":%s,\"message\":%s,\"node_epoch\":%s,"
                            + "\"lifecycle\":%s,\"ownership\":%s,\"retry\":%s,\"operation\":%s,"
                            + "\"capabilities\":%s}",
                        ok,
                        Json.quote(code),
                        Json.quote(Wire.bounded(message)),
                        Json.quote(epoch),
                        Json.quote(lifecycle),
                        Json.quote(ownership),
                        Json.quote(retry),
                        op == null ? "null" : op.json(),
                        caps == null ? "null" : caps));
    }

    private static boolean optionalStrings(Map<String, Object> req) {
        for (String field : List.of("node_epoch", "operation_id", "target")) {
            Object v = req.get(field);
            if (v != null && !(v instanceof String)) {
                return false;
            }
        }
        return true;
    }

    private static boolean isU32(String token) {
        return token.matches("[0-9]{1,10}") && Long.parseLong(token) <= 0xffff_ffffL;
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
