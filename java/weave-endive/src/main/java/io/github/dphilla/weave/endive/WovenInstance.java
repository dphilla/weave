package io.github.dphilla.weave.endive;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.IntSupplier;
import run.endive.runtime.ExportFunction;
import run.endive.runtime.GlobalInstance;
import run.endive.runtime.HostFunction;
import run.endive.runtime.ImportValues;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;
import run.endive.wasm.types.FunctionType;
import run.endive.wasm.types.ValType;

/** One Endive instance of a woven module with the guest ABI lifecycle enforced; thread-confined. */
final class WovenInstance implements PageTracker.Memories {
    /** The guest trapped or failed; the instance must be discarded. */
    static final class Trap extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Trap(String message, Throwable cause) {
            super(cause == null ? message : message + ": " + cause, cause);
        }
    }

    private enum State {
        READY,
        RESTORE_TARGET,
        RUNNING,
        PAUSED,
        COMPLETED,
        FAILED
    }

    // Positions in Abi.FIXED.
    private static final int STATE = 0;
    private static final int FLAG = 1;
    private static final int ENTRY = 2;
    private static final int RBASE = 7;

    private final WovenModule module;
    private final Meta meta;
    private final List<HostService> services;
    private final Instance instance;
    private final Memory[] memories;
    private final GlobalInstance[] controls;
    private final AtomicBoolean retired = new AtomicBoolean();
    private IntSupplier poll = () -> 0;
    private boolean initializing;
    private State state = State.RUNNING;

    private WovenInstance(
            WovenModule module, List<HostService> services, List<HostFunction> imports) {
        this.module = module;
        this.meta = module.meta();
        this.services = canonical(services);
        Map<String, HostFunction> provided = new HashMap<>();
        for (HostFunction f : imports) {
            String key = f.module() + "." + f.name();
            if (key.equals("weave.poll") || provided.put(key, f) != null) {
                throw new IllegalArgumentException("duplicate or reserved import " + key);
            }
        }
        List<HostFunction> linked = new ArrayList<>();
        linked.add(
                new HostFunction(
                        "weave",
                        "poll",
                        FunctionType.of(List.of(), List.of(ValType.I32)),
                        (inst, args) -> new long[] {initializing ? 0 : poll.getAsInt()}));
        for (Meta.Func imp : meta.imports) {
            HostFunction f = provided.get(imp.module + "." + imp.name);
            if (f == null
                    || !f.paramTypes().equals(Abi.valTypes(imp.params))
                    || !f.returnTypes().equals(Abi.valTypes(imp.results))) {
                throw new FormatException(
                        "this host does not provide "
                                + imp.module
                                + "."
                                + imp.name
                                + " as imported");
            }
            linked.add(f);
        }
        instance =
                Instance.builder(module.wasmModule())
                        .withMachineFactory(module.machineFactory())
                        .withImportValues(
                                ImportValues.builder()
                                        .addFunction(linked.toArray(new HostFunction[0]))
                                        .build())
                        .withStart(false)
                        .build();
        memories = new Memory[meta.memories.size()];
        for (int i = 0; i < memories.length; i++) {
            memories[i] = instance.exports().memory(meta.memories.get(i));
        }
        controls = new GlobalInstance[meta.controlGlobals.size()];
        for (int i = 0; i < controls.length; i++) {
            controls[i] = instance.exports().global(meta.controlGlobals.get(i));
        }
    }

    /** A fresh workload: runs __weave_init with polls answered by zero. */
    static WovenInstance fresh(
            WovenModule module, List<HostService> services, List<HostFunction> imports) {
        WovenInstance w = new WovenInstance(module, services, imports);
        w.initializing = true;
        try {
            w.instance.exports().function("__weave_init").apply();
        } catch (RuntimeException | Error e) {
            w.state = State.FAILED;
            throw new Trap("running __weave_init", e);
        }
        w.initializing = false;
        w.state = State.READY;
        return w;
    }

    /** A restore or migration target, never initialized and with memories cleared for sparse pages. */
    static WovenInstance restoreTarget(
            WovenModule module, List<HostService> services, List<HostFunction> imports) {
        WovenInstance w = new WovenInstance(module, services, imports);
        for (Memory m : w.memories) {
            m.zero();
        }
        w.state = State.RESTORE_TARGET;
        return w;
    }

    WovenModule module() {
        return module;
    }

    void onPoll(IntSupplier poll) {
        this.poll = poll;
    }

    /** Runs an entry with raw arguments; true means the guest unwound. */
    boolean call(String name, long... args) {
        require(State.READY, State.COMPLETED);
        int index = meta.entryIndex(name);
        if (index < 0 || meta.entries.get(index).params.size() != args.length) {
            throw new IllegalArgumentException(
                    "module has no entry " + name + " taking " + args.length + " args");
        }
        ExportFunction f = instance.exports().function(name);
        return execute(() -> f.apply(args));
    }

    boolean resume() {
        require(State.PAUSED);
        ExportFunction f = instance.exports().function("__weave_resume");
        return execute(() -> f.apply());
    }

    private boolean execute(Runnable guest) {
        state = State.RUNNING;
        try {
            guest.run();
        } catch (RuntimeException | Error e) {
            state = State.FAILED;
            throw new Trap("guest trapped", e);
        }
        int flag = control(FLAG);
        if (flag != 0 && flag != 1) {
            state = State.FAILED;
            throw new Trap("invalid guest completion flag " + flag, null);
        }
        state = flag == 1 ? State.PAUSED : State.COMPLETED;
        return flag == 1;
    }

    /** The completed entry's results from the results area, rendered like the Rust CLI. */
    List<String> results() {
        require(State.COMPLETED);
        int index = control(ENTRY);
        if (index < 0 || index >= meta.entries.size()) {
            throw new FormatException("bad entry index " + index);
        }
        long at = Integer.toUnsignedLong(control(RBASE)) + meta.globalsAreaSize;
        List<String> out = new ArrayList<>();
        for (Meta.Type type : meta.entries.get(index).results) {
            if (memories.length == 0 || at + 16 > memoryBytes(0)) {
                throw new FormatException("results area lies outside primary memory");
            }
            Bytes.Reader r = new Bytes.Reader(read(0, (int) at, 16));
            at += 16;
            if (type == Meta.Type.I32) {
                out.add(Integer.toString(r.i32()));
            } else if (type == Meta.Type.I64) {
                out.add(Long.toString(r.u64()));
            } else if (type == Meta.Type.F32) {
                float v = Float.intBitsToFloat(r.i32());
                out.add(display(v, true));
            } else if (type == Meta.Type.F64) {
                double v = Double.longBitsToDouble(r.u64());
                out.add(display(v, false));
            } else {
                throw new FormatException("cannot render a " + type + " result");
            }
        }
        return out;
    }

    // Rust's Display: the shortest digits that round-trip, the nearer on a tie upward, no exponent.
    static String display(double v, boolean f32) {
        if (Double.isNaN(v)) {
            return "NaN";
        }
        if (Double.isInfinite(v)) {
            return v > 0 ? "inf" : "-inf";
        }
        if (v == 0) {
            return 1 / v < 0 ? "-0" : "0";
        }
        BigDecimal exact = new BigDecimal(v);
        for (int digits = 1; ; digits++) {
            BigDecimal down = exact.round(new MathContext(digits, RoundingMode.DOWN));
            BigDecimal up = exact.round(new MathContext(digits, RoundingMode.UP));
            boolean downOk = f32 ? down.floatValue() == (float) v : down.doubleValue() == v;
            boolean upOk = f32 ? up.floatValue() == (float) v : up.doubleValue() == v;
            if (upOk
                    && (!downOk
                            || up.subtract(exact).abs().compareTo(exact.subtract(down).abs())
                                    <= 0)) {
                return up.stripTrailingZeros().toPlainString();
            }
            if (downOk) {
                return down.stripTrailingZeros().toPlainString();
            }
        }
    }

    Snapshot checkpoint() {
        require(State.PAUSED);
        List<byte[]> mems = new ArrayList<>();
        for (int m = 0; m < memories.length; m++) {
            mems.add(read(m, 0, (int) memoryBytes(m)));
        }
        return new Snapshot(module.sha256(), mems, controlGlobals(), serviceBlobs());
    }

    /** Applies a complete checkpoint to a restore target, which becomes resumable. */
    void restore(Snapshot snap) {
        require(State.RESTORE_TARGET);
        if (!MessageDigest.isEqual(snap.moduleHash, module.sha256())
                || snap.memories.size() != memories.length) {
            throw new FormatException("snapshot does not belong to this module");
        }
        for (int m = 0; m < memories.length; m++) {
            int length = snap.memories.get(m).length;
            if (length % Snapshot.WASM_PAGE != 0 || length < memoryBytes(m)) {
                throw new FormatException("snapshot memory " + m + " has an invalid size");
            }
        }
        check(snap.globals, snap.services);
        state = State.FAILED;
        for (int m = 0; m < memories.length; m++) {
            growTo(m, snap.memories.get(m).length / Snapshot.WASM_PAGE);
            memories[m].write(0, snap.memories.get(m));
        }
        apply(snap.globals, snap.services);
        state = State.PAUSED;
    }

    void growTo(int m, long pages) {
        int have = memories[m].pages();
        if (pages > have && memories[m].grow((int) (pages - have)) < 0) {
            throw new FormatException("cannot grow memory " + m + " to " + pages + " pages");
        }
    }

    void write(int m, long offset, byte[] buf, int from, int length) {
        memories[m].write((int) offset, buf, from, length);
    }

    /** Applies verified globals and services to a staged target, which stays stopped. */
    void stage(List<Map.Entry<String, Integer>> globals, List<Map.Entry<String, byte[]>> blobs) {
        require(State.RESTORE_TARGET);
        check(globals, blobs);
        state = State.FAILED;
        apply(globals, blobs);
        state = State.RESTORE_TARGET;
    }

    /** COMMIT arrived: the staged workload may resume. */
    void commit() {
        require(State.RESTORE_TARGET);
        state = State.PAUSED;
    }

    private void check(
            List<Map.Entry<String, Integer>> globals, List<Map.Entry<String, byte[]>> blobs) {
        if (!keys(globals).equals(meta.controlGlobals)) {
            throw new FormatException("control-global contract mismatch");
        }
        int entry = globals.get(ENTRY).getValue();
        if (globals.get(FLAG).getValue() != 1
                || globals.get(STATE).getValue() != 1
                || entry < 0
                || entry >= meta.entries.size()) {
            throw new FormatException("state is not a suspended checkpoint");
        }
        if (!keys(blobs).equals(serviceNames())) {
            throw new FormatException("host-service contract mismatch");
        }
    }

    private void apply(
            List<Map.Entry<String, Integer>> globals, List<Map.Entry<String, byte[]>> blobs) {
        for (int i = 0; i < controls.length; i++) {
            controls[i].setValue(globals.get(i).getValue());
        }
        for (int i = 0; i < services.size(); i++) {
            services.get(i).restore(blobs.get(i).getValue());
        }
    }

    static List<String> keys(List<? extends Map.Entry<String, ?>> entries) {
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, ?> e : entries) {
            out.add(e.getKey());
        }
        return out;
    }

    @Override
    public int memoryCount() {
        return memories.length;
    }

    @Override
    public long memoryBytes(int m) {
        return (long) memories[m].pages() * Snapshot.WASM_PAGE;
    }

    @Override
    public byte[] read(int m, int offset, int length) {
        return memories[m].readBytes(offset, length);
    }

    List<Map.Entry<String, Integer>> controlGlobals() {
        List<Map.Entry<String, Integer>> out = new ArrayList<>();
        for (int i = 0; i < controls.length; i++) {
            out.add(Map.entry(meta.controlGlobals.get(i), control(i)));
        }
        return out;
    }

    List<Map.Entry<String, byte[]>> serviceBlobs() {
        List<Map.Entry<String, byte[]>> out = new ArrayList<>();
        for (HostService s : services) {
            out.add(Map.entry(s.name(), s.snapshot()));
        }
        return out;
    }

    List<String> serviceNames() {
        List<String> out = new ArrayList<>();
        for (HostService s : services) {
            out.add(s.name());
        }
        return out;
    }

    /** The state hash over the live memories, streamed in 64 KiB chunks. */
    byte[] stateHash(
            List<Map.Entry<String, Integer>> globals, List<Map.Entry<String, byte[]>> blobs) {
        Snapshot.StateHasher h = new Snapshot.StateHasher(memories.length);
        for (int m = 0; m < memories.length; m++) {
            long size = memoryBytes(m);
            h.memory(size);
            for (long off = 0; off < size; off += Snapshot.WASM_PAGE) {
                h.update(read(m, (int) off, Snapshot.WASM_PAGE));
            }
        }
        return h.finish(globals, blobs);
    }

    /** PREPARED arrived: this instance must never run again, whatever happens to COMMIT. */
    void retire() {
        retired.set(true);
    }

    boolean retired() {
        return retired.get();
    }

    private int control(int index) {
        return (int) controls[index].getValue();
    }

    private void require(State... allowed) {
        if (retired.get() || !Arrays.asList(allowed).contains(state)) {
            throw new IllegalStateException(
                    retired.get() ? "instance is retired" : "instance is " + state);
        }
    }

    private static List<HostService> canonical(List<HostService> services) {
        List<HostService> sorted = new ArrayList<>(services);
        sorted.sort((a, b) -> Bytes.UTF8_ORDER.compare(a.name(), b.name()));
        for (int i = 0; i < sorted.size(); i++) {
            String name = sorted.get(i).name();
            if (!new String(Bytes.utf8(name), StandardCharsets.UTF_8).equals(name)
                    || (i > 0 && sorted.get(i - 1).name().equals(name))) {
                throw new IllegalArgumentException("invalid or duplicate service name " + name);
            }
        }
        return sorted;
    }
}
