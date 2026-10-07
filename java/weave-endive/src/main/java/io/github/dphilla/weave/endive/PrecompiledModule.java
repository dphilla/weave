package io.github.dphilla.weave.endive;

import java.io.IOException;
import java.io.InputStream;
import java.io.UncheckedIOException;
import java.util.HashSet;
import java.util.Set;
import run.endive.runtime.CompiledModule;
import run.endive.wasm.types.Export;
import run.endive.wasm.types.ExternalType;

/**
 * A woven module compiled by Endive's build-time compiler, paired with the exact woven bytes it was
 * compiled from. The generated {@code .meta} module drops custom sections and function bodies, so
 * the woven bytes supply {@code weave.meta}, the content address and MODULE_DATA for peers.
 */
public final class PrecompiledModule {
    private final byte[] woven;
    private final byte[] sha256;
    private final byte[] metaRaw;
    private final Meta meta;
    private final CompiledModule compiled;

    private PrecompiledModule(byte[] woven, CompiledModule compiled) {
        this.woven = woven;
        this.sha256 = Bytes.sha256(woven);
        this.metaRaw = WovenBytes.metaPayload(woven);
        this.meta = Meta.decode(metaRaw);
        this.compiled = compiled;
        validate();
    }

    public static PrecompiledModule of(byte[] woven, CompiledModule compiled) {
        return new PrecompiledModule(woven.clone(), compiled);
    }

    /** Loads the woven bytes bundled next to the generated class. */
    public static PrecompiledModule load(CompiledModule compiled, String wovenResource) {
        try (InputStream in = compiled.getClass().getResourceAsStream(wovenResource)) {
            if (in == null) {
                throw new IllegalArgumentException(
                        "missing woven resource " + wovenResource + " next to " + compiled.getClass());
            }
            return new PrecompiledModule(in.readAllBytes(), compiled);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // The build-time .meta module must expose the ABI that weave.meta describes.
    private void validate() {
        var module = compiled.wasmModule();
        if (module.startSection().isPresent()) {
            throw new FormatException("woven migration module must not contain a start section");
        }
        Set<String> functions = new HashSet<>();
        Set<String> memories = new HashSet<>();
        Set<String> globals = new HashSet<>();
        for (int i = 0; i < module.exportSection().exportCount(); i++) {
            Export e = module.exportSection().getExport(i);
            if (e.exportType() == ExternalType.FUNCTION) {
                functions.add(e.name());
            } else if (e.exportType() == ExternalType.MEMORY) {
                memories.add(e.name());
            } else if (e.exportType() == ExternalType.GLOBAL) {
                globals.add(e.name());
            }
        }
        require(functions.contains("__weave_init"), "__weave_init");
        require(functions.contains("__weave_resume"), "__weave_resume");
        for (Meta.Func entry : meta.entries) {
            require(functions.contains(entry.name), "entry " + entry.name);
        }
        for (String m : meta.memories) {
            require(memories.contains(m), "memory " + m);
        }
        for (String g : meta.controlGlobals) {
            require(globals.contains(g), "control global " + g);
        }
    }

    private static void require(boolean ok, String what) {
        if (!ok) {
            throw new FormatException("precompiled module does not export " + what);
        }
    }

    public byte[] wovenBytes() {
        return woven.clone();
    }

    public byte[] sha256() {
        return sha256.clone();
    }

    public byte[] metaRaw() {
        return metaRaw.clone();
    }

    public Meta meta() {
        return meta;
    }

    public CompiledModule compiled() {
        return compiled;
    }
}
