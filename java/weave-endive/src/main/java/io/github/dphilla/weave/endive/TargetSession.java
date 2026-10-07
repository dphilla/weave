package io.github.dphilla.weave.endive;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.BitSet;
import java.util.List;
import java.util.Map;
import java.util.function.Function;

/** Target side of a live migration, as weave-host's target.rs; no guest code runs before COMMIT. */
final class TargetSession {
    static final long MAX_MODULE_BYTES = 256L << 20;

    private enum Phase {
        PRECOPY,
        FINAL_PAGES,
        FINAL_GLOBALS,
        FINAL_SERVICES
    }

    private final Conn conn;
    String source;
    private Meta meta;
    private WovenInstance instance;
    private Phase phase = Phase.PRECOPY;
    private long[] layout;
    private BitSet[] seen;
    private long round = 1;
    private long roundPages;
    private List<Map.Entry<String, Integer>> globals;
    private List<Map.Entry<String, byte[]>> services;

    TargetSession(Conn conn) {
        this.conn = conn;
    }

    /** Receives one workload and returns it once COMMIT arrived. */
    WovenInstance receive(
            String runtime,
            Map<String, WovenModule> cache,
            Function<WovenModule, WovenInstance> stage)
            throws IOException {
        hello(runtime);
        WovenModule module = module(cache);
        try {
            instance = stage.apply(module);
        } catch (RuntimeException e) {
            throw reject(3, "instantiation failed: " + e.getMessage());
        }
        conn.send(Wire.MODULE_OK, Wire.EMPTY);
        seen = new BitSet[meta.memories.size()];
        Arrays.setAll(seen, i -> new BitSet());
        try {
            boolean prepared = false;
            while (!prepared) {
                prepared = apply(conn.read());
            }
        } catch (FormatException e) {
            throw reject(5, "malformed migration frame: " + e.getMessage());
        }
        Wire.Frame f = conn.read();
        if (f.type != Wire.COMMIT) {
            throw f.type == Wire.ABORT
                    ? Wire.unexpected(f, "COMMIT")
                    : reject(5, "expected COMMIT, got frame " + f.type);
        }
        instance.commit();
        Thread ack =
                new Thread(
                        () -> {
                            try {
                                conn.send(Wire.COMMIT_OK, Wire.EMPTY);
                            } catch (IOException e) {
                                // ownership already moved; the ack is best effort
                            } finally {
                                conn.close();
                            }
                        },
                        "weave-commit-ok");
        ack.setDaemon(true);
        ack.start();
        return instance;
    }

    private void hello(String runtime) throws IOException {
        Wire.Frame f = conn.read();
        if (f.type != Wire.HELLO) {
            throw new IOException("expected HELLO, got frame " + f.type);
        }
        int proto;
        int role;
        try {
            Bytes.Reader r = f.reader();
            proto = r.u8();
            role = r.u8();
            source = r.str();
            r.end("HELLO");
        } catch (FormatException e) {
            throw reject(1, "malformed HELLO");
        }
        if (proto != Wire.PROTO || role != Wire.ROLE_SOURCE) {
            throw reject(1, "unsupported protocol " + proto + " or role " + role);
        }
        conn.send(Wire.HELLO, Wire.hello(Wire.ROLE_TARGET, runtime));
    }

    private WovenModule module(Map<String, WovenModule> cache) throws IOException {
        byte[] hash;
        long size;
        byte[] offered;
        try {
            Bytes.Reader r = conn.expect(Wire.MODULE_META, "MODULE_META").reader();
            hash = r.bytes(32);
            size = r.u64();
            offered = r.blob();
            r.end("MODULE_META");
            meta = Meta.decode(offered);
        } catch (FormatException e) {
            throw reject(2, "malformed module offer: " + e.getMessage());
        }
        if (Long.compareUnsigned(size, MAX_MODULE_BYTES) > 0) {
            throw reject(2, "module exceeds " + MAX_MODULE_BYTES + " byte receive limit");
        }
        if (meta.memories.size() > 255) {
            throw reject(3, "module has too many memories for migration wire format");
        }
        WovenModule module = cache.get(Bytes.hex(hash));
        if (module == null) {
            conn.send(Wire.MODULE_NEED, Wire.EMPTY);
            ByteArrayOutputStream bytes = new ByteArrayOutputStream(Math.min((int) size, 1 << 20));
            while (bytes.size() < size) {
                Wire.Frame f = conn.expect(Wire.MODULE_DATA, "MODULE_DATA");
                int length = f.payload.length - 8;
                if (length <= 0
                        || f.reader().u64() != bytes.size()
                        || length > size - bytes.size()) {
                    throw reject(2, "invalid module chunk");
                }
                bytes.write(f.payload, 8, length);
            }
            if (!MessageDigest.isEqual(Bytes.sha256(bytes.toByteArray()), hash)) {
                throw reject(2, "module hash mismatch");
            }
            try {
                module = WovenModule.compile(bytes.toByteArray());
            } catch (RuntimeException e) {
                throw reject(3, "instantiation failed: " + e.getMessage());
            }
            cache.put(module.hex(), module);
        } else {
            conn.write(Wire.MODULE_HAVE, Wire.EMPTY);
        }
        if (!Arrays.equals(module.metaRaw(), offered)) {
            throw reject(2, "offered weave.meta does not match the module's weave.meta");
        }
        return module;
    }

    // Applies one pre-copy or final-state frame; true once PREPARED was sent.
    private boolean apply(Wire.Frame f) throws IOException {
        Bytes.Reader r = f.reader();
        boolean pages = phase == Phase.PRECOPY || phase == Phase.FINAL_PAGES;
        switch (f.type) {
            case Wire.MEM_LAYOUT:
                if (!pages) {
                    throw reject(5, "MEM_LAYOUT after final globals");
                }
                layout(r);
                return false;
            case Wire.PAGE:
                if (!pages) {
                    throw reject(5, "PAGE after final globals");
                }
                page(f, r);
                return false;
            case Wire.ROUND_END:
                if (phase != Phase.PRECOPY || r.u32() != round || r.u64() != roundPages) {
                    throw reject(5, "invalid round terminator");
                }
                conn.send(Wire.ROUND_ACK, Wire.EMPTY);
                round++;
                roundPages = 0;
                Arrays.stream(seen).forEach(BitSet::clear);
                return false;
            case Wire.FINAL_BEGIN:
                if (phase != Phase.PRECOPY || roundPages != 0) {
                    throw reject(5, "FINAL_BEGIN inside an incomplete round");
                }
                phase = Phase.FINAL_PAGES;
                Arrays.stream(seen).forEach(BitSet::clear);
                return false;
            case Wire.GLOBALS:
                globals = new ArrayList<>();
                for (int i = 0, n = r.u16(); i < n; i++) {
                    globals.add(Map.entry(r.str(), r.i32()));
                }
                r.end("GLOBALS");
                if (phase != Phase.FINAL_PAGES
                        || !WovenInstance.keys(globals).equals(meta.controlGlobals)) {
                    throw reject(5, "GLOBALS out of order or not matching the control globals");
                }
                phase = Phase.FINAL_GLOBALS;
                return false;
            case Wire.SERVICES:
                services = new ArrayList<>();
                for (int i = 0, n = r.u16(); i < n; i++) {
                    services.add(Map.entry(r.str(), r.blob()));
                }
                r.end("SERVICES");
                if (phase != Phase.FINAL_GLOBALS
                        || !WovenInstance.keys(services).equals(instance.serviceNames())) {
                    throw reject(5, "SERVICES out of order or not matching this host's services");
                }
                phase = Phase.FINAL_SERVICES;
                return false;
            case Wire.FINAL_END:
                if (phase != Phase.FINAL_SERVICES || f.payload.length != 32) {
                    throw reject(5, "FINAL_END before complete final state");
                }
                if (!MessageDigest.isEqual(instance.stateHash(globals, services), f.payload)) {
                    throw reject(4, "migrated state hash mismatch — refusing to resume");
                }
                try {
                    instance.stage(globals, services);
                } catch (RuntimeException e) {
                    throw reject(5, "restoring staged state failed: " + e.getMessage());
                }
                conn.send(Wire.PREPARED, Wire.EMPTY);
                return true;
            case Wire.ABORT:
                throw Wire.unexpected(f, "migration state");
            default:
                throw new IOException("unexpected frame " + f.type);
        }
    }

    private void layout(Bytes.Reader r) throws IOException {
        long[] pages = new long[r.u8()];
        if (pages.length != meta.memories.size()) {
            throw reject(5, "memory layout count mismatch");
        }
        long total = 0;
        for (int m = 0; m < pages.length; m++) {
            pages[m] = r.u64();
            if (layout != null && Long.compareUnsigned(pages[m], layout[m]) < 0) {
                throw reject(5, "memory layout cannot shrink during migration");
            }
            if (Long.compareUnsigned(pages[m], WovenModule.MAX_MEMORY_BYTES / Snapshot.WASM_PAGE)
                            > 0
                    || (total += pages[m] * Snapshot.WASM_PAGE) > WovenModule.MAX_MEMORY_BYTES) {
                throw reject(5, "announced memory layout exceeds target limit");
            }
        }
        r.end("MEM_LAYOUT");
        try {
            for (int m = 0; m < pages.length; m++) {
                instance.growTo(m, pages[m]);
            }
        } catch (RuntimeException e) {
            throw reject(5, "memory growth failed");
        }
        layout = pages;
    }

    private void page(Wire.Frame f, Bytes.Reader r) throws IOException {
        if (f.payload.length != 9 + Wire.WPAGE) {
            throw reject(5, "invalid page payload size: " + f.payload.length);
        }
        int m = r.u8();
        long page = r.u64();
        if (layout == null || m >= layout.length) {
            throw reject(5, "PAGE before a matching MEM_LAYOUT");
        }
        if (page < 0 || page >= layout[m] * (Snapshot.WASM_PAGE / Wire.WPAGE)) {
            throw reject(5, "PAGE exceeds announced memory layout");
        }
        if (seen[m].get((int) page)) {
            throw reject(5, "duplicate PAGE in migration round");
        }
        seen[m].set((int) page);
        instance.write(m, page * Wire.WPAGE, f.payload, 9, Wire.WPAGE);
        roundPages += phase == Phase.PRECOPY ? 1 : 0;
    }

    private IOException reject(int code, String message) {
        conn.abort(code, message);
        return new IOException("rejected (" + code + "): " + message);
    }
}
