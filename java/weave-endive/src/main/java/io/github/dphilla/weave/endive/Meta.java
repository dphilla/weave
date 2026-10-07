package io.github.dphilla.weave.endive;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** The {@code weave.meta} custom section, byte-compatible with weave-core's {@code Meta}. */
public final class Meta {
    public static final int VERSION = 1;
    private static final byte[] MAGIC = {'W', 'V', 'M', 'T'};

    /** Value type codes used by meta, in weave-core order. */
    public enum Type {
        I32,
        I64,
        F32,
        F64,
        V128,
        FUNCREF;

        static Type of(int code) {
            Type[] all = values();
            if (code < 0 || code >= all.length) {
                throw new FormatException("unknown ValType code " + code);
            }
            return all[code];
        }
    }

    /** An entry export or a host import: name plus signature. */
    public static final class Func {
        public final String module;
        public final String name;
        public final List<Type> params;
        public final List<Type> results;

        Func(String module, String name, List<Type> params, List<Type> results) {
            this.module = module;
            this.name = name;
            this.params = Collections.unmodifiableList(params);
            this.results = Collections.unmodifiableList(results);
        }
    }

    public final long pollPeriod;
    public final List<Func> entries;
    public final List<String> memories;
    public final List<Func> imports;
    public final List<String> controlGlobals;
    public final long globalsAreaSize;
    public final long resultsAreaSize;

    private Meta(
            long pollPeriod,
            List<Func> entries,
            List<String> memories,
            List<Func> imports,
            List<String> controlGlobals,
            long globalsAreaSize,
            long resultsAreaSize) {
        this.pollPeriod = pollPeriod;
        this.entries = Collections.unmodifiableList(entries);
        this.memories = Collections.unmodifiableList(memories);
        this.imports = Collections.unmodifiableList(imports);
        this.controlGlobals = Collections.unmodifiableList(controlGlobals);
        this.globalsAreaSize = globalsAreaSize;
        this.resultsAreaSize = resultsAreaSize;
    }

    public static Meta decode(byte[] payload) {
        if (payload.length < 4
                || payload[0] != MAGIC[0]
                || payload[1] != MAGIC[1]
                || payload[2] != MAGIC[2]
                || payload[3] != MAGIC[3]) {
            throw new FormatException("weave.meta: bad magic");
        }
        Bytes.Reader r = new Bytes.Reader(payload, 4, payload.length);
        int version = r.u16();
        if (version != VERSION) {
            throw new FormatException("weave.meta: unsupported version " + version);
        }
        long pollPeriod = r.u32();
        List<Func> entries = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            String name = r.str();
            entries.add(new Func(null, name, types(r), types(r)));
        }
        List<String> memories = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            memories.add(r.str());
        }
        List<Func> imports = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            String module = r.str();
            String name = r.str();
            imports.add(new Func(module, name, types(r), types(r)));
        }
        List<String> controlGlobals = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            controlGlobals.add(r.str());
        }
        long globalsAreaSize = r.u32();
        long resultsAreaSize = r.u32();
        r.expectEnd("weave.meta");
        return new Meta(
                pollPeriod,
                entries,
                memories,
                imports,
                controlGlobals,
                globalsAreaSize,
                resultsAreaSize);
    }

    private static List<Type> types(Bytes.Reader r) {
        int n = r.u16();
        List<Type> out = new ArrayList<>(n);
        for (int i = 0; i < n; i++) {
            out.add(Type.of(r.u8()));
        }
        return out;
    }

    public int entryIndex(String name) {
        for (int i = 0; i < entries.size(); i++) {
            if (entries.get(i).name.equals(name)) {
                return i;
            }
        }
        return -1;
    }
}
