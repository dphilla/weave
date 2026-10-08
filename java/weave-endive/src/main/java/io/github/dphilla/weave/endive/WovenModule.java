package io.github.dphilla.weave.endive;

import java.util.function.Function;
import run.endive.compiler.InterpreterFallback;
import run.endive.compiler.MachineFactoryCompiler;
import run.endive.runtime.Instance;
import run.endive.runtime.Machine;
import run.endive.wasm.Parser;
import run.endive.wasm.WasmModule;

/** A validated woven module, compiled once; its factory only works with the module it came from. */
final class WovenModule {
    static final long MAX_MEMORY_BYTES = 1L << 30;

    private final byte[] bytes;
    private final byte[] sha256;
    private final byte[] metaRaw;
    private final Meta meta;
    private final WasmModule module;
    private final Function<Instance, Machine> machineFactory;

    // Takes ownership of the bytes; compiles with Endive's runtime compiler, never its interpreter.
    private WovenModule(byte[] bytes) {
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
        Function<Instance, Machine> factory;
        try {
            factory =
                    MachineFactoryCompiler.builder(module)
                            .withInterpreterFallback(InterpreterFallback.FAIL)
                            .compile();
        } catch (RuntimeException e) {
            throw new FormatException("Endive cannot compile this module: " + e.getMessage());
        }
        this.machineFactory = factory;
    }

    static WovenModule compile(byte[] woven) {
        return new WovenModule(woven);
    }

    byte[] bytes() {
        return bytes;
    }

    byte[] sha256() {
        return sha256.clone();
    }

    String hex() {
        return Bytes.hex(sha256);
    }

    byte[] metaRaw() {
        return metaRaw;
    }

    Meta meta() {
        return meta;
    }

    WasmModule wasmModule() {
        return module;
    }

    Function<Instance, Machine> machineFactory() {
        return machineFactory;
    }
}
