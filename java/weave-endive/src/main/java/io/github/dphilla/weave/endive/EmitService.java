package io.github.dphilla.weave.endive;

import java.util.function.Consumer;

/**
 * The built-in {@code env.emit}, {@code env.emit32} and {@code env.emit64} services. The blob is
 * {@code count: u64 LE, sum: i64 LE}, identical to the Rust, JS and Go runners.
 */
public final class EmitService implements HostService {
    public static final String EMIT = "env.emit";
    public static final String EMIT32 = "env.emit32";
    public static final String EMIT64 = "env.emit64";

    private final String name;
    private final Consumer<String> log;
    private long count;
    private long sum;

    public EmitService(String name, Consumer<String> log) {
        if (!EMIT.equals(name) && !EMIT32.equals(name) && !EMIT64.equals(name)) {
            throw new IllegalArgumentException("unknown emit service " + name);
        }
        this.name = name;
        this.log = log;
    }

    @Override
    public String name() {
        return name;
    }

    public void emit(int i, long h) {
        count++;
        sum += h + i;
        log.accept("EMIT " + i + " " + h);
    }

    public void emit32(int v) {
        count++;
        sum += v;
        log.accept("EMIT32 " + v);
    }

    public void emit64(long v) {
        count++;
        sum += v;
        log.accept("EMIT64 " + v);
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
