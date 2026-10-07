package io.github.dphilla.weave.endive;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/** Live migration through real sockets, against another Endive node or a scripted target. */
class NodeTest {
    private static final int N = 40_000_000;
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
        Matcher epoch =
                Pattern.compile("\"node_epoch\":\"([0-9a-f]{32})\"")
                        .matcher(
                                control(
                                        source.node,
                                        "{\"schema_version\":1,\"action\":\"status\"}"));
        assertTrue(epoch.find());
        String migrate =
                String.format(
                        "{\"schema_version\":1,\"action\":\"migrate\",\"node_epoch\":\"%s\","
                                + "\"operation_id\":\"op-1\",\"target\":\"%s\"}",
                        epoch.group(1), target.address());
        String accepted = control(source.node, migrate);
        assertTrue(accepted.contains("\"ok\":true,\"code\":\"ACCEPTED\""), accepted);
        assertTrue(control(source.node, migrate).contains("\"operation_id\":\"op-1\""));
        String conflict = control(source.node, migrate.replace(target.address(), "127.0.0.1:1"));
        assertTrue(conflict.contains("OPERATION_CONFLICT"), conflict);
        String stale = control(source.node, migrate.replace(epoch.group(1), "0".repeat(32)));
        assertTrue(stale.contains("NODE_EPOCH_MISMATCH"), stale);
        source.join();
        String lookup =
                control(
                        source.node,
                        String.format(
                                "{\"schema_version\":1,\"action\":\"operation\",\"node_epoch\":\"%s\","
                                    + "\"operation_id\":\"op-1\"}",
                                epoch.group(1)));
        assertTrue(lookup.contains("\"state\":\"succeeded\",\"code\":\"MIGRATED\""), lookup);
        assertTrue(lookup.contains("\"lifecycle\":\"retired\",\"ownership\":\"retired\""), lookup);
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
        String ok = control(node, "{\"schema_version\":1,\"action\":\"status\"}");
        assertTrue(ok.matches(".*\"node_epoch\":\"[0-9a-f]{32}\".*"), ok);
        assertTrue(ok.contains("\"ok\":true,\"code\":\"STATUS_OK\""), ok);
        assertTrue(ok.contains("\"lifecycle\":\"idle\",\"ownership\":\"none\""), ok);
        assertTrue(ok.contains("\"capabilities\":{\"runtime\":\"endive\""), ok);
        assertFalse(ok.contains("simd"), ok);
        assertTrue(
                control(node, "{\"schema_version\":2,\"action\":\"status\"}")
                        .contains("UNSUPPORTED_SCHEMA"));
        assertTrue(
                control(node, "{\"schema_version\":1,\"action\":\"status\",\"x\":1}")
                        .contains("INVALID_REQUEST"));
        assertTrue(
                control(node, "{\"schema_version\":1.0,\"action\":\"status\"}")
                        .contains("INVALID_REQUEST"));
        assertTrue(
                control(node, "{\"schema_version\":1,\"action\":\"status\",\"target\":\"a:1\"}")
                        .contains("INVALID_REQUEST"));
        assertTrue(
                control(node, "{\"schema_version\":1,\"action\":\"status\",\"target\":null}")
                        .contains("STATUS_OK"));
        assertTrue(control(node, "{\"schema_version\":1}").contains("INVALID_REQUEST"));
        assertTrue(
                control(node, "{\"schema_version\":1,\"action\":null}")
                        .contains("INVALID_REQUEST"));
    }

    private static void awaitIdle(Node node) throws InterruptedException {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (!control(node, "{\"schema_version\":1,\"action\":\"status\"}")
                .contains("\"lifecycle\":\"idle\"")) {
            assertTrue(System.nanoTime() < deadline, "the node did not return to idle");
            Thread.sleep(10);
        }
    }

    private static String control(Node node, String json) {
        return new String(node.control(Golden.utf8(json)), StandardCharsets.UTF_8);
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
