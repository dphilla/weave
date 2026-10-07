package io.github.dphilla.weave.endive;

import java.util.function.Function;
import run.endive.compiler.InterpreterFallback;
import run.endive.compiler.MachineFactoryCompiler;
import run.endive.runtime.Instance;
import run.endive.runtime.Machine;
import run.endive.wasm.Parser;
import run.endive.wasm.WasmModule;

/** A validated woven module, compiled once; its factory only works with the module it came from. */
public final class WovenModule {
    public static final long MAX_MEMORY_BYTES = 1L << 30;

    private final byte[] bytes;
    private final byte[] sha256;
    private final byte[] metaRaw;
    private final Meta meta;
    private final WasmModule module;
    private final Function<Instance, Machine> machineFactory;
    private final long compileMillis;

    private WovenModule(byte[] bytes, Function<WasmModule, Function<Instance, Machine>> compiler) {
        this.bytes = bytes;
        this.sha256 = Bytes.sha256(bytes);
        this.metaRaw = Meta.section(bytes);
        this.meta = Meta.decode(metaRaw);
        this.module = Parser.parse(bytes);
        Abi.validate(module, meta);
        if (Abi.initialMemoryBytes(module) > MAX_MEMORY_BYTES) {
            throw new FormatException(
                    "declared initial memory exceeds " + MAX_MEMORY_BYTES + " bytes");
        }
        long start = System.nanoTime();
        this.machineFactory = compiler.apply(module);
        this.compileMillis = (System.nanoTime() - start) / 1_000_000;
    }

    /** Validates and compiles with Endive's runtime compiler, never falling back to the interpreter. */
    public static WovenModule compile(byte[] woven) {
        return compile(
                woven,
                m ->
                        MachineFactoryCompiler.builder(m)
                                .withInterpreterFallback(InterpreterFallback.FAIL)
                                .compile());
    }

    public static WovenModule compile(
            byte[] woven, Function<WasmModule, Function<Instance, Machine>> compiler) {
        return new WovenModule(woven.clone(), compiler);
    }

    byte[] bytes() {
        return bytes;
    }

    public byte[] sha256() {
        return sha256.clone();
    }

    String hex() {
        return Bytes.hex(sha256);
    }

    byte[] metaRaw() {
        return metaRaw;
    }

    public Meta meta() {
        return meta;
    }

    public long compileMillis() {
        return compileMillis;
    }

    WasmModule wasmModule() {
        return module;
    }

    Function<Instance, Machine> machineFactory() {
        return machineFactory;
    }
}
