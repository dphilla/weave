package io.github.dphilla.weave.endive;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/** The portable {@code WVSN} snapshot, byte-compatible with weave-core's {@code Snapshot}. */
public final class Snapshot {
    public static final int WASM_PAGE = 65536;
    private static final byte[] MAGIC = {'W', 'V', 'S', 'N'};

    public final byte[] moduleHash;
    public final List<byte[]> memories;
    /** Control globals in meta order. */
    public final List<Map.Entry<String, Integer>> globals;
    /** Service blobs in canonical UTF-8 name order. */
    public final List<Map.Entry<String, byte[]>> services;

    public Snapshot(
            byte[] moduleHash,
            List<byte[]> memories,
            List<Map.Entry<String, Integer>> globals,
            List<Map.Entry<String, byte[]>> services) {
        if (moduleHash.length != 32) {
            throw new IllegalArgumentException("module hash must be 32 bytes");
        }
        this.moduleHash = moduleHash.clone();
        this.memories = Collections.unmodifiableList(new ArrayList<>(memories));
        this.globals = Collections.unmodifiableList(new ArrayList<>(globals));
        this.services = Collections.unmodifiableList(new ArrayList<>(services));
    }

    public byte[] stateHash() {
        StateHasher h = new StateHasher(memories.size());
        for (byte[] m : memories) {
            h.memBegin(m.length);
            h.memChunk(m, 0, m.length);
        }
        h.globals(globals);
        h.services(services);
        return h.finish();
    }

    public byte[] encode() {
        Bytes.Writer w = new Bytes.Writer().raw(MAGIC).u16(Meta.VERSION).raw(moduleHash);
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

    public static Snapshot decode(byte[] buf) {
        if (buf.length < 6 || !Arrays.equals(Arrays.copyOf(buf, 4), MAGIC)) {
            throw new FormatException("snapshot: bad magic");
        }
        Bytes.Reader head = new Bytes.Reader(buf, 4, buf.length);
        int version = head.u16();
        if (version != Meta.VERSION) {
            throw new FormatException("snapshot: unsupported version " + version);
        }
        if (head.remaining() < 32) {
            throw new FormatException("snapshot: truncated module hash");
        }
        byte[] moduleHash = head.bytes(32, "module hash");
        int payloadEnd = buf.length - 32;
        if (payloadEnd - head.pos() < 12) {
            throw new FormatException("snapshot: truncated counts or state hash");
        }
        Bytes.Reader r = new Bytes.Reader(buf, head.pos(), payloadEnd);
        int nMems = count(r, 8, "memories");
        List<byte[]> memories = new ArrayList<>(nMems);
        for (int i = 0; i < nMems; i++) {
            long len = r.u64();
            if (len > Integer.MAX_VALUE - 8) {
                throw new FormatException("snapshot: memory length does not fit host");
            }
            memories.add(r.bytes(len, "field"));
        }
        int nGlobals = count(r, 4, "globals");
        List<Map.Entry<String, Integer>> globals = new ArrayList<>(nGlobals);
        for (int i = 0; i < nGlobals; i++) {
            String name = r.str();
            globals.add(Map.entry(name, r.i32()));
        }
        int nServices = count(r, 0, "services");
        List<Map.Entry<String, byte[]>> services = new ArrayList<>(nServices);
        for (int i = 0; i < nServices; i++) {
            String name = r.str();
            services.add(Map.entry(name, r.blob()));
        }
        r.expectEnd("snapshot");
        Snapshot snap = new Snapshot(moduleHash, memories, globals, services);
        byte[] expected = Arrays.copyOfRange(buf, payloadEnd, buf.length);
        if (!MessageDigest.isEqual(snap.stateHash(), expected)) {
            throw new FormatException("snapshot: state hash mismatch (corrupt snapshot)");
        }
        return snap;
    }

    // Each item needs at least eight encoded bytes; tail reserves the later collection counts.
    private static int count(Bytes.Reader r, int tail, String kind) {
        long count = r.u32();
        long available = r.remaining();
        if (available < tail || count > (available - tail) / 8) {
            throw new FormatException("snapshot: " + kind + " count exceeds remaining input");
        }
        return (int) count;
    }

    /** Incremental end-to-end state hash, identical to weave-core's {@code StateHasher}. */
    public static final class StateHasher {
        private final MessageDigest h = Bytes.sha256();

        public StateHasher(int memoryCount) {
            h.update(new byte[] {'W', 'V', 'S', 'H'});
            h.update(new Bytes.Writer().u32(memoryCount).toByteArray());
        }

        public void memBegin(long length) {
            h.update(new Bytes.Writer().u64(length).toByteArray());
        }

        public void memChunk(byte[] bytes, int off, int len) {
            h.update(bytes, off, len);
        }

        public void globals(List<Map.Entry<String, Integer>> globals) {
            Bytes.Writer w = new Bytes.Writer().u32(globals.size());
            for (Map.Entry<String, Integer> g : globals) {
                w.str(g.getKey()).u32(g.getValue());
            }
            h.update(w.toByteArray());
        }

        /** Hashes in UTF-8 name order; a stable sort keeps duplicate names in input order. */
        public void services(List<Map.Entry<String, byte[]>> services) {
            List<Map.Entry<String, byte[]>> sorted = new ArrayList<>(services);
            sorted.sort((a, b) -> Bytes.UTF8_ORDER.compare(a.getKey(), b.getKey()));
            Bytes.Writer w = new Bytes.Writer().u32(sorted.size());
            for (Map.Entry<String, byte[]> s : sorted) {
                byte[] name = s.getKey().getBytes(StandardCharsets.UTF_8);
                w.u32(name.length).raw(name).u64(s.getValue().length).raw(s.getValue());
            }
            h.update(w.toByteArray());
        }

        public byte[] finish() {
            return h.digest();
        }
    }
}
