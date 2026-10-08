package io.github.dphilla.weave.endive;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import run.endive.wasm.WasmModule;
import run.endive.wasm.types.Export;
import run.endive.wasm.types.ExternalType;
import run.endive.wasm.types.FunctionImport;
import run.endive.wasm.types.FunctionType;
import run.endive.wasm.types.Global;
import run.endive.wasm.types.Import;
import run.endive.wasm.types.MutabilityType;
import run.endive.wasm.types.ValType;

/** Proves that untrusted weave.meta describes the module's real ABI, as weave-wasmtime does. */
final class Abi {
    static final List<String> FIXED =
            List.of(
                    "__weave_state",
                    "__weave_flag",
                    "__weave_entry",
                    "__weave_ctr",
                    "__weave_sp",
                    "__weave_stack_base",
                    "__weave_stack_end",
                    "__weave_rbase");
    private static final List<ValType> VAL_TYPES =
            List.of(
                    ValType.I32,
                    ValType.I64,
                    ValType.F32,
                    ValType.F64,
                    ValType.V128,
                    ValType.FuncRef);

    private Abi() {}

    static void validate(WasmModule module, Meta meta) {
        checkImports(module, meta);
        int slots = 0;
        for (Meta.Func e : meta.entries) {
            slots = Math.max(slots, e.results.size());
        }
        require(meta.resultsAreaSize == 16L * slots, "weave.meta results-area size mismatch");
        require(meta.globalsAreaSize % 16 == 0, "weave.meta globals area is not 16-byte aligned");
        checkFunction(module, "__weave_init", List.of(), List.of());
        checkFunction(module, "__weave_resume", List.of(), List.of());
        Set<String> names = new HashSet<>(List.of("__weave_init", "__weave_resume"));
        for (Meta.Func e : meta.entries) {
            require(names.add(e.name), "weave.meta entry " + e.name + " is duplicated or reserved");
            checkFunction(module, e.name, e.params, e.results);
        }
        checkGlobals(module, meta.controlGlobals);
        checkMemories(module, meta.memories);
    }

    static long initialMemoryBytes(WasmModule module) {
        long total = 0;
        if (module.memorySection().isPresent()) {
            var section = module.memorySection().get();
            for (int i = 0; i < section.memoryCount(); i++) {
                total += (long) section.getMemory(i).limits().initialPages() * Snapshot.WASM_PAGE;
            }
        }
        return total;
    }

    static List<ValType> valTypes(List<Meta.Type> types) {
        List<ValType> out = new ArrayList<>();
        for (Meta.Type t : types) {
            out.add(VAL_TYPES.get(t.ordinal()));
        }
        return out;
    }

    // Only function imports are accepted, so imported functions come first and globals start at 0.
    private static void checkImports(WasmModule module, Meta meta) {
        List<List<Object>> actual = new ArrayList<>();
        boolean poll = false;
        for (int i = 0; i < module.importSection().importCount(); i++) {
            Import imp = module.importSection().getImport(i);
            String name = imp.module() + "." + imp.name();
            require(
                    imp.importType() == ExternalType.FUNCTION,
                    "import " + name + " is not a function");
            FunctionType type = module.typeSection().getType(((FunctionImport) imp).typeIndex());
            if (name.equals("weave.poll")) {
                require(
                        !poll
                                && type.params().isEmpty()
                                && type.returns().equals(List.of(ValType.I32)),
                        "weave.poll must be imported once as [] -> [i32]");
                poll = true;
            } else {
                actual.add(List.<Object>of(name, type.params(), type.returns()));
            }
        }
        List<List<Object>> expected = new ArrayList<>();
        for (Meta.Func f : meta.imports) {
            expected.add(
                    List.<Object>of(
                            f.module + "." + f.name, valTypes(f.params), valTypes(f.results)));
        }
        require(
                actual.equals(expected),
                "weave.meta function imports do not match the module's imports");
    }

    private static void checkFunction(
            WasmModule module, String name, List<Meta.Type> params, List<Meta.Type> results) {
        int index = export(module, name, ExternalType.FUNCTION).index();
        int imported = module.importSection().importCount();
        int typeIndex =
                index < imported
                        ? ((FunctionImport) module.importSection().getImport(index)).typeIndex()
                        : module.functionSection().getFunctionType(index - imported);
        FunctionType type = module.typeSection().getType(typeIndex);
        require(
                type.params().equals(valTypes(params)) && type.returns().equals(valTypes(results)),
                "exported function " + name + " does not match its weave.meta signature");
    }

    private static void checkGlobals(WasmModule module, List<String> names) {
        int tables = (names.size() - FIXED.size()) / 2;
        List<String> expected = new ArrayList<>(FIXED);
        for (int t = 0; t < tables; t++) {
            expected.add("__weave_tsh" + t);
        }
        for (int t = 0; t < tables; t++) {
            expected.add("__weave_tshcap" + t);
        }
        require(
                names.equals(expected),
                "weave.meta control globals are not the fixed set and table shadows");
        List<String> exported = new ArrayList<>();
        for (int i = 0; i < module.exportSection().exportCount(); i++) {
            Export e = module.exportSection().getExport(i);
            if (e.exportType() == ExternalType.GLOBAL && e.name().startsWith("__weave")) {
                Global g = module.globalSection().getGlobal(e.index());
                require(
                        ValType.I32.equals(g.valueType())
                                && g.mutabilityType() == MutabilityType.Var,
                        "control global " + e.name() + " must be mutable i32");
                exported.add(e.name());
            }
        }
        require(
                exported.equals(names),
                "weave.meta control globals do not match the module's exports");
    }

    private static void checkMemories(WasmModule module, List<String> names) {
        int count = module.memorySection().map(s -> s.memoryCount()).orElse(0);
        require(
                names.size() == count && new HashSet<>(names).size() == count,
                "weave.meta memories do not match the module's memories");
        for (int i = 0; i < count; i++) {
            require(
                    export(module, names.get(i), ExternalType.MEMORY).index() == i,
                    "weave.meta memory " + i + " names the wrong export");
        }
    }

    private static Export export(WasmModule module, String name, ExternalType kind) {
        for (int i = 0; i < module.exportSection().exportCount(); i++) {
            Export e = module.exportSection().getExport(i);
            if (e.name().equals(name)) {
                require(e.exportType() == kind, "export " + name + " is not a " + kind);
                return e;
            }
        }
        throw new FormatException("module has no export " + name);
    }

    private static void require(boolean ok, String message) {
        if (!ok) {
            throw new FormatException(message);
        }
    }
}
