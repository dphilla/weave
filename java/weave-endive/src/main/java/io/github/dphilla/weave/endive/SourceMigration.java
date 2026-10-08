package io.github.dphilla.weave.endive;

import java.io.Closeable;
import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** Source side of a live migration, as weave-host's source.rs; it throws only before PREPARED. */
final class SourceMigration implements Closeable {
    static final class Options {
        static final Options DEFAULTS = new Options(8 << 20, 64, 10);

        final long budgetBytes;
        final long dirtyThreshold;
        final long maxRounds;

        Options(long budgetBytes, long dirtyThreshold, long maxRounds) {
            this.budgetBytes = budgetBytes;
            this.dirtyThreshold = dirtyThreshold;
            this.maxRounds = maxRounds;
        }
    }

    /** The outcome after PREPARED; ownership moved either way. */
    static final class Handoff {
        final String stats;
        final String commitError;

        Handoff(String stats, String commitError) {
            this.stats = stats;
            this.commitError = commitError;
        }
    }

    private final Conn conn;
    private final Options opts;
    private final PageTracker tracker;
    private long[] sentLayout;
    private long roundPages;
    private long totalPages;
    private long rounds;
    private boolean converged;

    private SourceMigration(Conn conn, Options opts, int memories) {
        this.conn = conn;
        this.opts = opts;
        this.tracker = new PageTracker(memories);
        this.sentLayout = new long[memories];
    }

    /** Dials the target, exchanges HELLO and synchronizes the module by content hash. */
    static SourceMigration connect(String target, String runtime, WovenModule module, Options opts)
            throws IOException {
        Conn conn = Conn.dial(target, Conn.IO_TIMEOUT_MS);
        try {
            conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_SOURCE, runtime));
            Bytes.Reader hello = conn.expect(Wire.HELLO, "HELLO").reader();
            int proto = hello.u8();
            int role = hello.u8();
            hello.str();
            hello.end("HELLO");
            if (proto != Wire.PROTO || role != Wire.ROLE_TARGET) {
                throw new IOException("invalid target HELLO: protocol=" + proto + " role=" + role);
            }
            byte[] bytes = module.bytes();
            conn.send(
                    Wire.MODULE_META,
                    new Bytes.Writer()
                            .raw(module.sha256())
                            .u64(bytes.length)
                            .blob(module.metaRaw())
                            .toByteArray());
            Wire.Frame reply = conn.read();
            if (reply.type == Wire.MODULE_NEED) {
                for (int off = 0; off < bytes.length; off += Wire.MODULE_CHUNK) {
                    Bytes.Writer chunk = new Bytes.Writer().u64(off);
                    chunk.write(bytes, off, Math.min(Wire.MODULE_CHUNK, bytes.length - off));
                    conn.write(Wire.MODULE_DATA, chunk.toByteArray());
                }
                conn.flush();
            } else if (reply.type != Wire.MODULE_HAVE) {
                throw Wire.unexpected(reply, "MODULE_NEED/HAVE");
            }
            conn.expect(Wire.MODULE_OK, "MODULE_OK");
            return new SourceMigration(conn, opts, module.meta().memories.size());
        } catch (IOException | RuntimeException e) {
            conn.close();
            throw e;
        }
    }

    private void syncLayout(PageTracker.Memories mems) throws IOException {
        long[] current = new long[mems.memoryCount()];
        Bytes.Writer w = new Bytes.Writer().u8(current.length);
        for (int m = 0; m < current.length; m++) {
            current[m] = mems.memoryBytes(m) / Snapshot.WASM_PAGE;
            w.u64(current[m]);
        }
        if (!Arrays.equals(current, sentLayout)) {
            conn.write(Wire.MEM_LAYOUT, w.toByteArray());
            sentLayout = current;
        }
    }

    private void sendPage(int memory, long pageNo, byte[] bytes) throws IOException {
        conn.write(Wire.PAGE, new Bytes.Writer().u8(memory).u64(pageNo).raw(bytes).toByteArray());
        totalPages++;
    }

    /** One bounded pre-copy step; true when the guest should unwind. */
    boolean precopyStep(PageTracker.Memories mems) throws IOException {
        if (converged) {
            return true;
        }
        syncLayout(mems);
        boolean roundComplete =
                tracker.scanStep(
                        mems,
                        opts.budgetBytes,
                        (m, p, bytes) -> {
                            roundPages++;
                            sendPage(m, p, bytes);
                        });
        conn.flush();
        if (!roundComplete) {
            return false;
        }
        rounds++;
        conn.send(Wire.ROUND_END, new Bytes.Writer().u32(rounds).u64(roundPages).toByteArray());
        conn.expect(Wire.ROUND_ACK, "ROUND_ACK");
        converged = roundPages <= opts.dirtyThreshold || rounds >= opts.maxRounds;
        roundPages = 0;
        return converged;
    }

    /** Stop-and-copy after the guest unwound; the instance is retired before COMMIT is written. */
    Handoff finish(WovenInstance instance, Runnable onPrepared) throws IOException {
        conn.write(Wire.FINAL_BEGIN, Wire.EMPTY);
        syncLayout(instance);
        long finalPages = tracker.scanFull(instance, this::sendPage);
        List<Map.Entry<String, Integer>> globals = instance.controlGlobals();
        List<Map.Entry<String, byte[]>> services = instance.serviceBlobs();
        Bytes.Writer g = new Bytes.Writer().u16(globals.size());
        for (Map.Entry<String, Integer> e : globals) {
            g.str(e.getKey()).u32(e.getValue());
        }
        conn.write(Wire.GLOBALS, g.toByteArray());
        Bytes.Writer s = new Bytes.Writer().u16(services.size());
        for (Map.Entry<String, byte[]> e : services) {
            s.str(e.getKey()).blob(e.getValue());
        }
        conn.write(Wire.SERVICES, s.toByteArray());
        conn.send(Wire.FINAL_END, instance.stateHash(globals, services));
        conn.expect(Wire.PREPARED, "PREPARED");

        instance.retire();
        try {
            onPrepared.run();
        } catch (RuntimeException e) {
            // bookkeeping must not undo the retirement
        }
        String stats =
                rounds
                        + " rounds, "
                        + totalPages
                        + " pages total, "
                        + finalPages
                        + " in pause window";
        try {
            conn.send(Wire.COMMIT, Wire.EMPTY);
            Wire.Frame ack = conn.read();
            return new Handoff(
                    stats,
                    ack.type == Wire.COMMIT_OK
                            ? null
                            : Wire.unexpected(ack, "COMMIT_OK").getMessage());
        } catch (IOException | RuntimeException e) {
            return new Handoff(stats, "COMMIT not confirmed: " + e.getMessage());
        }
    }

    void abort(int code, String message) {
        conn.abort(code, message);
        conn.close();
    }

    @Override
    public void close() {
        conn.close();
    }
}
