package io.github.dphilla.weave.endive;

import java.util.List;
import java.util.function.Consumer;
import run.endive.runtime.HostFunction;
import run.endive.wasm.types.FunctionType;
import run.endive.wasm.types.ValType;

/** The built-in env.emit* services; the blob is count u64 LE then sum i64 LE, as in every runner. */
final class EmitService implements HostService {
    private final String name;
    private final Consumer<String> log;
    private long count;
    private long sum;

    private EmitService(String name, Consumer<String> log) {
        this.name = name;
        this.log = log;
    }

    static List<EmitService> builtins(Consumer<String> log) {
        return List.of(
                new EmitService("env.emit", log),
                new EmitService("env.emit32", log),
                new EmitService("env.emit64", log));
    }

    HostFunction hostFunction() {
        switch (name) {
            case "env.emit":
                return function(
                        "emit",
                        List.of(ValType.I32, ValType.I64),
                        a -> record((int) a[0] + a[1], "EMIT " + (int) a[0] + " " + a[1]));
            case "env.emit32":
                return function(
                        "emit32",
                        List.of(ValType.I32),
                        a -> record((int) a[0], "EMIT32 " + (int) a[0]));
            default:
                return function(
                        "emit64", List.of(ValType.I64), a -> record(a[0], "EMIT64 " + a[0]));
        }
    }

    private HostFunction function(String field, List<ValType> params, Consumer<long[]> body) {
        return new HostFunction(
                "env",
                field,
                FunctionType.of(params, List.of()),
                (inst, args) -> {
                    body.accept(args);
                    return null;
                });
    }

    private void record(long delta, String line) {
        count++;
        sum += delta;
        log.accept(line);
    }

    @Override
    public String name() {
        return name;
    }

    @Override
    public byte[] snapshot() {
        return new Bytes.Writer().u64(count).u64(sum).toByteArray();
    }

    @Override
    public void restore(byte[] blob) {
        if (blob.length != 16) {
            throw new FormatException("bad emit service snapshot");
        }
        Bytes.Reader r = new Bytes.Reader(blob);
        count = r.u64();
        sum = r.u64();
    }
}
