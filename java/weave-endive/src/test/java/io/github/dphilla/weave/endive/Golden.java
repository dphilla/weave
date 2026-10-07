package io.github.dphilla.weave.endive;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.PrintStream;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.GZIPInputStream;

/** Golden inputs produced by the Rust CLI, plus a large-stack thread to run guests on. */
final class Golden {
    static final int COUNTER_N = 2_000_000;

    private Golden() {}

    static byte[] bytes(String name) {
        try (InputStream in = Golden.class.getResourceAsStream("/golden/" + name)) {
            InputStream src = name.endsWith(".gz") ? new GZIPInputStream(in) : in;
            return src.readAllBytes();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    static List<String> lines(String name) {
        return events(new String(bytes(name), StandardCharsets.UTF_8));
    }

    /** The host-visible event lines the conformance harness compares. */
    static List<String> events(String output) {
        List<String> out = new ArrayList<>();
        for (String line : output.split("\n")) {
            if (line.startsWith("EMIT") || line.startsWith("WEAVE_DONE")) {
                out.add(line);
            }
        }
        return out;
    }

    /** A line-flushed sink whose contents can be read while a guest writes to it. */
    static final class Sink {
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        final PrintStream out = new PrintStream(buf, true, StandardCharsets.UTF_8);

        synchronized String text() {
            synchronized (out) {
                return buf.toString(StandardCharsets.UTF_8);
            }
        }

        List<String> events() {
            return Golden.events(text());
        }
    }

    /** Runs a guest-driving body on a thread with the stack Endive needs. */
    static <T> T onGuestThread(Callable<T> body) throws Exception {
        AtomicReference<Object> result = new AtomicReference<>();
        Thread t =
                new Thread(
                        null,
                        () -> {
                            try {
                                result.set(body.call());
                            } catch (Throwable e) {
                                result.set(new Failure(e));
                            }
                        },
                        "test-guest",
                        256L << 20);
        t.start();
        t.join();
        if (result.get() instanceof Failure) {
            Throwable e = ((Failure) result.get()).cause;
            if (e instanceof Exception) {
                throw (Exception) e;
            }
            throw (Error) e;
        }
        @SuppressWarnings("unchecked")
        T value = (T) result.get();
        return value;
    }

    private static final class Failure {
        final Throwable cause;

        Failure(Throwable cause) {
            this.cause = cause;
        }
    }
}
