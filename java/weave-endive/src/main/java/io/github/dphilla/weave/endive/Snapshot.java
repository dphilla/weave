package io.github.dphilla.weave.endive;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/** The portable WVSN snapshot, byte-compatible with weave-core's Snapshot. */
final class Snapshot {
    static final int WASM_PAGE = 65536;
    private static final byte[] MAGIC = {'W', 'V', 'S', 'N'};

    final byte[] moduleHash;
    final List<byte[]> memories;
    final List<Map.Entry<String, Integer>> globals;
    final List<Map.Entry<String, byte[]>> services;

    Snapshot(
            byte[] moduleHash,
            List<byte[]> memories,
            List<Map.Entry<String, Integer>> globals,
            List<Map.Entry<String, byte[]>> services) {
        this.moduleHash = moduleHash.clone();
        this.memories = List.copyOf(memories);
        this.globals = List.copyOf(globals);
        this.services = List.copyOf(services);
    }

    byte[] stateHash() {
        StateHasher h = new StateHasher(memories.size());
        for (byte[] m : memories) {
            h.memory(m.length).update(m);
        }
        return h.finish(globals, services);
    }

    byte[] encode() {
        Bytes.Writer w = new Bytes.Writer().raw(MAGIC).u16(1).raw(moduleHash);
        w.u32(memories.size());
        for (byte[] m : memories) {
            w.u64(m.length).raw(m);
        }
        w.u32(globals.size());
        for (Map.Entry<String, Integer> g : globals) {
            w.str(g.getKey()).u32(g.getValue());
        }
        w.u32(services.size());
        for (Map.Entry<String, byte[]> s : services) {
            w.str(s.getKey()).blob(s.getValue());
        }
        return w.raw(stateHash()).toByteArray();
    }

    static Snapshot decode(byte[] buf) {
        if (buf.length < 6 || !Arrays.equals(buf, 0, 4, MAGIC, 0, 4)) {
            throw new FormatException("snapshot: bad magic");
        }
        Bytes.Reader head = new Bytes.Reader(buf, 4, buf.length);
        int version = head.u16();
        if (version != 1) {
            throw new FormatException("snapshot: unsupported version " + version);
        }
        if (head.remaining() < 32 + 12 + 32) {
            throw new FormatException("snapshot: truncated");
        }
        byte[] moduleHash = head.bytes(32);
        Bytes.Reader r = new Bytes.Reader(buf, buf.length - head.remaining(), buf.length - 32);
        int n = count(r, 8);
        List<byte[]> memories = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            memories.add(r.bytes(r.u64()));
        }
        n = count(r, 4);
        List<Map.Entry<String, Integer>> globals = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            globals.add(Map.entry(r.str(), r.i32()));
        }
        n = count(r, 0);
        List<Map.Entry<String, byte[]>> services = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            services.add(Map.entry(r.str(), r.blob()));
        }
        r.end("snapshot");
        Snapshot snap = new Snapshot(moduleHash, memories, globals, services);
        byte[] stored = Arrays.copyOfRange(buf, buf.length - 32, buf.length);
        if (!MessageDigest.isEqual(snap.stateHash(), stored)) {
            throw new FormatException("snapshot: state hash mismatch (corrupt snapshot)");
        }
        return snap;
    }

    // Every item needs eight bytes; tail reserves the later collection counts.
    private static int count(Bytes.Reader r, int tail) {
        long count = r.u32();
        if (r.remaining() < tail || count > (r.remaining() - tail) / 8) {
            throw new FormatException("snapshot: count exceeds remaining input");
        }
        return (int) count;
    }

    /** The end-to-end state hash stream of weave-core's StateHasher. */
    static final class StateHasher {
        private final MessageDigest h = Bytes.sha256();

        StateHasher(int memories) {
            h.update(
                    new Bytes.Writer()
                            .raw(new byte[] {'W', 'V', 'S', 'H'})
                            .u32(memories)
                            .toByteArray());
        }

        StateHasher memory(long length) {
            h.update(new Bytes.Writer().u64(length).toByteArray());
            return this;
        }

        void update(byte[] bytes) {
            h.update(bytes);
        }

        byte[] finish(
                List<Map.Entry<String, Integer>> globals,
                List<Map.Entry<String, byte[]>> services) {
            Bytes.Writer w = new Bytes.Writer().u32(globals.size());
            for (Map.Entry<String, Integer> g : globals) {
                w.str(g.getKey()).u32(g.getValue());
            }
            List<Map.Entry<String, byte[]>> sorted = new ArrayList<>(services);
            sorted.sort((a, b) -> Bytes.UTF8_ORDER.compare(a.getKey(), b.getKey()));
            w.u32(sorted.size());
            for (Map.Entry<String, byte[]> s : sorted) {
                w.str(s.getKey()).u64(s.getValue().length).raw(s.getValue());
            }
            h.update(w.toByteArray());
            return h.digest();
        }
    }
}
