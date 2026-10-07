package io.github.dphilla.weave.endive.spike;

import io.github.dphilla.weave.endive.EmitService;
import io.github.dphilla.weave.endive.HostService;
import io.github.dphilla.weave.endive.Meta;
import io.github.dphilla.weave.endive.PrecompiledModule;
import io.github.dphilla.weave.endive.Snapshot;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import run.endive.runtime.Instance;
import run.endive.runtime.Memory;

/**
 * M0 feasibility spike: the woven counter, compiled at build time, driven through the generated
 * {@code Counter_ModuleExports} and {@code Counter_ModuleImports}.
 *
 * <pre>
 *   run        --arg N
 *   checkpoint --arg N --after-polls K -o SNAP
 *   restore    SNAP
 * </pre>
 */
public final class CounterSpike {
    private static final long GUEST_STACK = 256L << 20;

    private final PrecompiledModule module =
            PrecompiledModule.load(new CounterModule(), "counter.woven.wasm");
    private final List<HostService> services = new ArrayList<>();
    private final EmitService emit = new EmitService(EmitService.EMIT, System.out::println);
    private boolean initializing = true;
    private long unwindAfter = -1;

    private CounterSpike() {
        services.add(emit);
        services.add(new EmitService(EmitService.EMIT32, System.out::println));
        services.add(new EmitService(EmitService.EMIT64, System.out::println));
    }

    public static void main(String[] args) throws Throwable {
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread guest =
                new Thread(
                        null,
                        () -> {
                            try {
                                new CounterSpike().command(args);
                            } catch (Throwable t) {
                                failure.set(t);
                            }
                        },
                        "weave-guest",
                        GUEST_STACK);
        guest.start();
        guest.join();
        if (failure.get() != null) {
            System.err.println("weave-endive spike: error: " + failure.get());
            System.exit(1);
        }
    }

    private int poll() {
        if (initializing || unwindAfter < 0) {
            return 0;
        }
        if (unwindAfter == 0) {
            return 1;
        }
        unwindAfter--;
        return 0;
    }

    private Instance instantiate() {
        Counter_ModuleImports imports =
                new Counter_ModuleImports() {
                    @Override
                    public Counter_Env env() {
                        return emit::emit;
                    }

                    @Override
                    public Counter_Weave weave() {
                        return CounterSpike.this::poll;
                    }
                };
        return Instance.builder(module.compiled().wasmModule())
                .withMachineFactory(module.compiled().machineFactory())
                .withImportValues(imports.toImportValues())
                .withStart(false)
                .build();
    }

    private void command(String[] args) throws Exception {
        String cmd = args[0];
        int n = 0;
        String out = null;
        String snap = null;
        for (int i = 1; i < args.length; i++) {
            switch (args[i]) {
                case "--arg":
                    n = Integer.parseInt(args[++i]);
                    break;
                case "--after-polls":
                    unwindAfter = Long.parseLong(args[++i]);
                    break;
                case "-o":
                    out = args[++i];
                    break;
                default:
                    snap = args[i];
            }
        }
        switch (cmd) {
            case "run":
            case "checkpoint":
                fresh(n, out);
                break;
            case "restore":
                restore(Snapshot.decode(Files.readAllBytes(Path.of(snap))));
                break;
            default:
                throw new IllegalArgumentException("unknown command " + cmd);
        }
    }

    private void fresh(int n, String out) throws Exception {
        Instance instance = instantiate();
        Counter_ModuleExports exports = new Counter_ModuleExports(instance);
        exports._WeaveInit();
        initializing = false;
        long result = exports.run(n);
        if ((int) exports._WeaveFlag().getValue() == 0) {
            System.out.println("WEAVE_DONE [" + result + "]");
            return;
        }
        if (out == null) {
            throw new IllegalStateException("workload unwound without a checkpoint in flight");
        }
        Files.write(Path.of(out), checkpoint(instance).encode());
        System.out.println("WEAVE_CHECKPOINTED");
    }

    private Snapshot checkpoint(Instance instance) {
        Meta meta = module.meta();
        List<byte[]> memories = new ArrayList<>();
        for (String name : meta.memories) {
            Memory m = instance.exports().memory(name);
            memories.add(m.readBytes(0, m.pages() * Snapshot.WASM_PAGE));
        }
        List<Map.Entry<String, Integer>> globals = new ArrayList<>();
        for (String name : meta.controlGlobals) {
            globals.add(Map.entry(name, (int) instance.exports().global(name).getValue()));
        }
        List<Map.Entry<String, byte[]>> blobs = new ArrayList<>();
        services.stream()
                .sorted((a, b) -> a.name().compareTo(b.name()))
                .forEach(s -> blobs.add(Map.entry(s.name(), s.snapshot())));
        return new Snapshot(module.sha256(), memories, globals, blobs);
    }

    private void restore(Snapshot snap) {
        Meta meta = module.meta();
        if (!MessageDigest.isEqual(snap.moduleHash, module.sha256())) {
            throw new IllegalStateException("snapshot module hash does not match this module");
        }
        Instance instance = instantiate();
        initializing = false;
        for (int i = 0; i < meta.memories.size(); i++) {
            Memory m = instance.exports().memory(meta.memories.get(i));
            byte[] bytes = snap.memories.get(i);
            m.zero();
            int want = bytes.length / Snapshot.WASM_PAGE;
            if (want > m.pages() && m.grow(want - m.pages()) < 0) {
                throw new IllegalStateException("cannot grow memory " + i + " to " + want);
            }
            m.write(0, bytes);
        }
        for (Map.Entry<String, Integer> g : snap.globals) {
            instance.exports().global(g.getKey()).setValue(g.getValue());
        }
        for (Map.Entry<String, byte[]> blob : snap.services) {
            services.stream()
                    .filter(s -> s.name().equals(blob.getKey()))
                    .findFirst()
                    .orElseThrow()
                    .restore(blob.getValue());
        }
        Counter_ModuleExports exports = new Counter_ModuleExports(instance);
        exports._WeaveResume();
        if ((int) exports._WeaveFlag().getValue() != 0) {
            throw new IllegalStateException("restored workload unwound unexpectedly");
        }
        int base =
                (int) exports._WeaveRbase().getValue() + (int) meta.globalsAreaSize;
        long result = exports.memory().readLong(base);
        System.out.println("WEAVE_DONE [" + result + "]");
    }
}
