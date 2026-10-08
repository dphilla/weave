package io.github.dphilla.weave.endive;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Live migration through real sockets, against another Endive node or a scripted target. */
class NodeTest {
    private static final int N = 40_000_000;
    private static final String STATUS = "{\"schema_version\":1,\"action\":\"status\"}";
    private static WovenModule counter;
    private static List<String> golden;

    @BeforeAll
    static void uninterruptedRun() throws Exception {
        counter = WovenModule.compile(Golden.bytes("counter.woven.wasm"));
        Golden.Sink sink = new Golden.Sink();
        Golden.onGuestThread(
                () -> {
                    WovenInstance instance = Node.instance(counter, sink.out, true);
                    assertFalse(instance.call("run", N));
                    sink.out.println("WEAVE_DONE [" + String.join(", ", instance.results()) + "]");
                    return null;
                });
        golden = sink.events();
        assertTrue(golden.size() > 100);
    }

    /** A node serving on its own large-stack executor thread. */
    private static final class Running {
        final Golden.Sink sink = new Golden.Sink();
        final Node node = new Node(sink.out, System.err, SourceMigration.Options.DEFAULTS);
        final int port;
        final Thread executor;
        final AtomicReference<Throwable> failure = new AtomicReference<>();

        Running(WovenModule module) throws IOException {
            port = node.bind("127.0.0.1:0");
            executor =
                    new Thread(
                            null,
                            () -> {
                                try {
                                    node.serve(
                                            module,
                                            "run",
                                            module == null ? null : new long[] {N},
                                            true);
                                } catch (Throwable t) {
                                    failure.set(t);
                                }
                            },
                            "test-executor",
                            256L << 20);
            executor.setDaemon(true);
            executor.start();
        }

        String address() {
            return "127.0.0.1:" + port;
        }

        void awaitEvents(int n) throws InterruptedException {
            long deadline = System.nanoTime() + 60_000_000_000L;
            while (sink.events().size() < n) {
                assertTrue(System.nanoTime() < deadline, "timed out waiting for events");
                Thread.sleep(5);
            }
        }

        void join() throws InterruptedException {
            executor.join(120_000);
            assertFalse(executor.isAlive(), "node did not finish");
            assertEquals(null, failure.get());
        }
    }

    private static Wire.Frame legacy(String node, int type, byte[] payload) throws IOException {
        try (Conn conn = Conn.dial(node, Conn.IO_TIMEOUT_MS)) {
            conn.send(type, payload);
            return conn.read();
        }
    }

    private static String message(Wire.Frame f) {
        return f.reader().str();
    }

    @Test
    void liveMigrationBetweenEndiveNodesContinuesTheStream() throws Exception {
        Running target = new Running(null);
        Running source = new Running(counter);
        source.awaitEvents(2);
        Wire.Frame reply = legacy(source.address(), Wire.CTL_MIGRATE, Wire.str(target.address()));
        assertEquals(Wire.CTL_OK, reply.type, message(reply));
        assertTrue(message(reply).startsWith("migrated: "), message(reply));
        source.join();
        target.join();
        List<String> combined = new ArrayList<>(source.sink.events());
        combined.addAll(target.sink.events());
        assertEquals(golden, combined);
        assertTrue(target.sink.events().size() > 1, "the target ran part of the workload");
    }

    @Test
    void structuredMigrationIsAcceptedOnceAndQueryableToCompletion() throws Exception {
        Running target = new Running(null);
        Running source = new Running(counter);
        source.awaitEvents(2);
        String epoch = control(source.node, STATUS).get("node_epoch").asText();
        String migrate =
                String.format(
                        "{\"schema_version\":1,\"action\":\"migrate\",\"node_epoch\":\"%s\","
                                + "\"operation_id\":\"op-1\",\"target\":\"%s\"}",
                        epoch, target.address());
        JsonNode accepted = control(source.node, migrate);
        assertTrue(accepted.get("ok").asBoolean(), accepted.toString());
        assertEquals("ACCEPTED", accepted.get("code").asText());
        assertEquals("op-1", control(source.node, migrate).at("/operation/operation_id").asText());
        assertEquals(
                "OPERATION_CONFLICT",
                code(source.node, migrate.replace(target.address(), "127.0.0.1:1")));
        assertEquals(
                "NODE_EPOCH_MISMATCH", code(source.node, migrate.replace(epoch, "0".repeat(32))));
        source.join();
        JsonNode lookup =
                control(
                        source.node,
                        String.format(
                                "{\"schema_version\":1,\"action\":\"operation\",\"node_epoch\":\"%s\","
                                    + "\"operation_id\":\"op-1\"}",
                                epoch));
        assertEquals("succeeded", lookup.at("/operation/state").asText(), lookup.toString());
        assertEquals("MIGRATED", lookup.at("/operation/code").asText());
        assertEquals("retired", lookup.get("lifecycle").asText());
        assertEquals("retired", lookup.get("ownership").asText());
        target.join();
        List<String> combined = new ArrayList<>(source.sink.events());
        combined.addAll(target.sink.events());
        assertEquals(golden, combined);
    }

    @Test
    void restoreTargetsClearActiveDataSegments() throws Exception {
        WovenModule module = WovenModule.compile(Golden.bytes("multi-memory.woven.wasm"));
        int secondary = module.meta().memories.indexOf("secondary");
        byte[][] first =
                Golden.onGuestThread(
                        () ->
                                new byte[][] {
                                    Node.instance(module, new Golden.Sink().out, true)
                                            .read(secondary, 0, 1),
                                    Node.instance(module, new Golden.Sink().out, false)
                                            .read(secondary, 0, 1)
                                });
        assertEquals(0x7f, first[0][0], "the fixture's active data segment is present");
        assertEquals(0, first[1][0], "a target must not keep it under sparse pages");
    }

    @Test
    void busyNodeRejectsAnIncomingMigration() throws Exception {
        Running source = new Running(counter);
        source.awaitEvents(1);
        try (Conn conn = Conn.dial(source.address(), Conn.IO_TIMEOUT_MS)) {
            conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_SOURCE, "test"));
            Wire.Frame f = conn.read();
            assertEquals(Wire.ABORT, f.type);
            assertEquals(9, f.reader().u32());
        }
        source.join();
        assertEquals(golden, source.sink.events());
    }

    @Test
    void targetDyingDuringPrecopyLeavesTheSourceRunning() throws Exception {
        assertSourceRewinds(FakeTarget.Mode.CLOSE_AT_FIRST_ROUND_END);
    }

    @Test
    void abortBeforePreparedRewindsTheSourceLocally() throws Exception {
        assertSourceRewinds(FakeTarget.Mode.ABORT_AT_FINAL_END);
    }

    private void assertSourceRewinds(FakeTarget.Mode mode) throws Exception {
        try (FakeTarget target = new FakeTarget(mode)) {
            Running source = new Running(counter);
            source.awaitEvents(2);
            Wire.Frame reply =
                    legacy(source.address(), Wire.CTL_MIGRATE, Wire.str(target.address()));
            assertEquals(Wire.CTL_ERR, reply.type);
            assertTrue(message(reply).startsWith("migration failed: "), message(reply));
            source.join();
            assertEquals(golden, source.sink.events());
            assertTrue(target.reachedMode, "the scripted failure was exercised");
        }
    }

    @Test
    void lostCommitAcknowledgementRetiresTheSourceForGood() throws Exception {
        try (FakeTarget target = new FakeTarget(FakeTarget.Mode.PREPARED_THEN_VANISH)) {
            Running source = new Running(counter);
            source.awaitEvents(2);
            Wire.Frame reply =
                    legacy(source.address(), Wire.CTL_MIGRATE, Wire.str(target.address()));
            assertEquals(Wire.CTL_ERR, reply.type);
            assertTrue(message(reply).startsWith("commit uncertain: "), message(reply));
            source.join();
            List<String> events = source.sink.events();
            assertTrue(events.size() < golden.size());
            assertEquals(golden.subList(0, events.size()), events);
            assertFalse(source.sink.text().contains("WEAVE_DONE"));
        }
    }

    @Test
    void simdModuleIsRejectedBeforeStagingAndTheTargetStaysIdle() throws Exception {
        Running target = new Running(null);
        byte[] simd = Golden.bytes("simd-multi-memory.woven.wasm");
        try (Conn conn = Conn.dial(target.address(), Conn.IO_TIMEOUT_MS)) {
            conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_SOURCE, "test"));
            conn.expect(Wire.HELLO, "HELLO");
            conn.send(
                    Wire.MODULE_META,
                    new Bytes.Writer()
                            .raw(Bytes.sha256(simd))
                            .u64(simd.length)
                            .blob(Meta.section(simd))
                            .toByteArray());
            conn.expect(Wire.MODULE_NEED, "MODULE_NEED");
            conn.send(Wire.MODULE_DATA, new Bytes.Writer().u64(0).raw(simd).toByteArray());
            Wire.Frame f = conn.read();
            assertEquals(Wire.ABORT, f.type);
            Bytes.Reader r = f.reader();
            assertEquals(3, r.u32());
            assertTrue(r.str().startsWith("instantiation failed"));
        }
        awaitIdle(target.node);
    }

    @Test
    void serviceSetMismatchIsRejectedBeforeAnyRestore() throws Exception {
        Running target = new Running(null);
        byte[] woven = Golden.bytes("counter.woven.wasm");
        try (Conn conn = Conn.dial(target.address(), Conn.IO_TIMEOUT_MS)) {
            conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_SOURCE, "test"));
            conn.expect(Wire.HELLO, "HELLO");
            conn.send(
                    Wire.MODULE_META,
                    new Bytes.Writer()
                            .raw(Bytes.sha256(woven))
                            .u64(woven.length)
                            .blob(Meta.section(woven))
                            .toByteArray());
            conn.expect(Wire.MODULE_NEED, "MODULE_NEED");
            conn.send(Wire.MODULE_DATA, new Bytes.Writer().u64(0).raw(woven).toByteArray());
            conn.expect(Wire.MODULE_OK, "MODULE_OK");
            conn.send(Wire.FINAL_BEGIN, Wire.EMPTY);
            Bytes.Writer globals = new Bytes.Writer().u16(Abi.FIXED.size());
            Abi.FIXED.forEach(name -> globals.str(name).u32(1));
            conn.send(Wire.GLOBALS, globals.toByteArray());
            Bytes.Writer services = new Bytes.Writer().u16(1);
            services.str("env.unknown").blob(new byte[16]);
            conn.send(Wire.SERVICES, services.toByteArray());
            Wire.Frame f = conn.read();
            assertEquals(Wire.ABORT, f.type);
            assertEquals(5, f.reader().u32());
        }
        awaitIdle(target.node);
    }

    @Test
    void structuredStatusSpeaksControlSchemaV1() {
        Node node = new Node(new Golden.Sink().out, System.err, SourceMigration.Options.DEFAULTS);
        JsonNode ok = control(node, STATUS);
        assertTrue(ok.get("ok").asBoolean(), ok.toString());
        assertEquals("STATUS_OK", ok.get("code").asText());
        assertTrue(ok.get("node_epoch").asText().matches("[0-9a-f]{32}"), ok.toString());
        assertEquals("idle", ok.get("lifecycle").asText());
        assertEquals("none", ok.get("ownership").asText());
        assertTrue(ok.get("operation").isNull());
        assertEquals("endive", ok.at("/capabilities/runtime").asText());
        assertEquals(1 << 30, ok.at("/capabilities/limits/memory_bytes").asLong());
        assertFalse(ok.toString().contains("simd"), ok.toString());
        assertEquals(
                "UNSUPPORTED_SCHEMA", code(node, "{\"schema_version\":2,\"action\":\"status\"}"));
        assertEquals(
                "STATUS_OK",
                code(node, "{\"schema_version\":1,\"action\":\"status\",\"target\":null}"));
    }

    @Test
    void controlRequestsAreAsStrictAsWeaveCore() {
        Node node = new Node(new Golden.Sink().out, System.err, SourceMigration.Options.DEFAULTS);
        String epoch = control(node, STATUS).get("node_epoch").asText();
        // Each would be accepted, or answered differently, by a lenient parser.
        for (String bad :
                List.of(
                        "{\"schema_version\":1,\"action\":\"status\",\"x\":1}",
                        "{\"schema_version\":1,\"schema_version\":1,\"action\":\"status\"}",
                        "{\"schema_version\":1,\"action\":\"status\"} x",
                        "{\"schema_version\":1.0,\"action\":\"status\"}",
                        "{\"schema_version\":-0,\"action\":\"status\"}",
                        "{\"schema_version\":\"1\",\"action\":\"status\"}",
                        "{\"schema_version\":4294967297,\"action\":\"status\"}",
                        "{\"schema_version\":1,\"action\":\" status\"}",
                        "{\"schema_version\":1,\"action\":0}",
                        "{\"schema_version\":1,\"action\":null}",
                        "{\"schema_version\":1}",
                        "{\"schema_version\":1,\"action\":\"status\",\"target\":\"a:1\"}",
                        "{\"schema_version\":1,\"action\":\"operation\",\"node_epoch\":\"E\","
                                + "\"operation_id\":12345}",
                        "{\"schema_version\":1,\"action\":\"migrate\",\"node_epoch\":\"E\","
                                + "\"operation_id\":\"x\",\"target\":\"\\ud800h:1\"}",
                        "null",
                        "[]")) {
            assertEquals(
                    "INVALID_REQUEST", code(node, bad.replace("\"E\"", '"' + epoch + '"')), bad);
        }
        assertEquals("INVALID_REQUEST", code(node, new byte[] {(byte) 0xff}));
    }

    private static void awaitIdle(Node node) throws InterruptedException {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (!control(node, STATUS).get("lifecycle").asText().equals("idle")) {
            assertTrue(System.nanoTime() < deadline, "the node did not return to idle");
            Thread.sleep(10);
        }
    }

    private static JsonNode control(Node node, String json) {
        return control(node, Golden.utf8(json));
    }

    private static JsonNode control(Node node, byte[] payload) {
        try {
            return new ObjectMapper().readTree(node.control(payload));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static String code(Node node, String json) {
        return control(node, json).get("code").asText();
    }

    private static String code(Node node, byte[] payload) {
        return control(node, payload).get("code").asText();
    }

    /** A scripted protocol-v2 target that fails at a chosen point. */
    static final class FakeTarget implements AutoCloseable {
        enum Mode {
            CLOSE_AT_FIRST_ROUND_END,
            ABORT_AT_FINAL_END,
            PREPARED_THEN_VANISH
        }

        private final ServerSocket server;
        private final Mode mode;
        volatile boolean reachedMode;

        FakeTarget(Mode mode) throws IOException {
            this.mode = mode;
            this.server = new ServerSocket();
            server.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 1);
            Thread t = new Thread(this::serveOne, "fake-target");
            t.setDaemon(true);
            t.start();
        }

        String address() {
            return "127.0.0.1:" + server.getLocalPort();
        }

        private void serveOne() {
            try (Conn conn = new Conn(server.accept(), Conn.IO_TIMEOUT_MS)) {
                conn.expect(Wire.HELLO, "HELLO");
                conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_TARGET, "fake"));
                Bytes.Reader meta = conn.expect(Wire.MODULE_META, "MODULE_META").reader();
                meta.bytes(32);
                long size = meta.u64();
                conn.send(Wire.MODULE_NEED, new byte[0]);
                long got = 0;
                while (got < size) {
                    got += conn.expect(Wire.MODULE_DATA, "MODULE_DATA").payload.length - 8;
                }
                conn.send(Wire.MODULE_OK, new byte[0]);
                while (true) {
                    Wire.Frame f = conn.read();
                    if (f.type == Wire.ROUND_END) {
                        if (mode == Mode.CLOSE_AT_FIRST_ROUND_END) {
                            reachedMode = true;
                            return;
                        }
                        conn.send(Wire.ROUND_ACK, new byte[0]);
                    } else if (f.type == Wire.FINAL_END) {
                        reachedMode = true;
                        if (mode == Mode.ABORT_AT_FINAL_END) {
                            conn.abort(4, "scripted state hash mismatch");
                        } else {
                            conn.send(Wire.PREPARED, new byte[0]);
                        }
                        return;
                    }
                }
            } catch (IOException e) {
                // the source closes first in some scripts
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }
}
