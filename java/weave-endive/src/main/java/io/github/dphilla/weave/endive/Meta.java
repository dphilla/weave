package io.github.dphilla.weave.endive;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/** The weave.meta custom section, byte-compatible with weave-core's Meta. */
final class Meta {
    private static final byte[] MAGIC = {'W', 'V', 'M', 'T'};
    private static final byte[] WASM = {0, 'a', 's', 'm', 1, 0, 0, 0};

    /** Value types in weave-core code order. */
    enum Type {
        I32,
        I64,
        F32,
        F64,
        V128,
        FUNCREF
    }

    /** An entry export or a host import with its signature. */
    static final class Func {
        final String module;
        final String name;
        final List<Type> params;
        final List<Type> results;

        Func(String module, String name, List<Type> params, List<Type> results) {
            this.module = module;
            this.name = name;
            this.params = params;
            this.results = results;
        }
    }

    final long pollPeriod;
    final List<Func> entries;
    final List<String> memories;
    final List<Func> imports;
    final List<String> controlGlobals;
    final long globalsAreaSize;
    final long resultsAreaSize;

    private Meta(Bytes.Reader r) {
        int version = r.u16();
        if (version != 1) {
            throw new FormatException("weave.meta: unsupported version " + version);
        }
        pollPeriod = r.u32();
        entries = funcs(r, false);
        memories = names(r);
        imports = funcs(r, true);
        controlGlobals = names(r);
        globalsAreaSize = r.u32();
        resultsAreaSize = r.u32();
        r.end("weave.meta");
    }

    static Meta decode(byte[] payload) {
        if (payload.length < 4 || !Arrays.equals(payload, 0, 4, MAGIC, 0, 4)) {
            throw new FormatException("weave.meta: bad magic");
        }
        return new Meta(new Bytes.Reader(payload, 4, payload.length));
    }

    /** The raw weave.meta payload of a woven module, which must not have a start section. */
    static byte[] section(byte[] wasm) {
        if (wasm.length < 8 || !Arrays.equals(wasm, 0, 8, WASM, 0, 8)) {
            throw new FormatException("not a wasm module");
        }
        Bytes.Reader r = new Bytes.Reader(wasm, 8, wasm.length);
        byte[] meta = null;
        while (r.remaining() > 0) {
            int id = r.u8();
            Bytes.Reader section = r.slice(r.leb());
            if (id == 8) {
                throw new FormatException(
                        "woven migration module must not contain a start section");
            }
            if (id == 0 && meta == null && section.text(section.leb()).equals("weave.meta")) {
                meta = section.rest();
            }
        }
        if (meta == null) {
            throw new FormatException("module has no weave.meta section");
        }
        return meta;
    }

    int entryIndex(String name) {
        for (int i = 0; i < entries.size(); i++) {
            if (entries.get(i).name.equals(name)) {
                return i;
            }
        }
        return -1;
    }

    private static List<Func> funcs(Bytes.Reader r, boolean imports) {
        List<Func> out = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            String module = imports ? r.str() : null;
            out.add(new Func(module, r.str(), types(r), types(r)));
        }
        return Collections.unmodifiableList(out);
    }

    private static List<String> names(Bytes.Reader r) {
        List<String> out = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            out.add(r.str());
        }
        return Collections.unmodifiableList(out);
    }

    private static List<Type> types(Bytes.Reader r) {
        List<Type> out = new ArrayList<>();
        for (int i = 0, n = r.u16(); i < n; i++) {
            int code = r.u8();
            if (code >= Type.values().length) {
                throw new FormatException("unknown value type " + code);
            }
            out.add(Type.values()[code]);
        }
        return Collections.unmodifiableList(out);
    }
}
