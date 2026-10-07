package io.github.dphilla.weave.endive;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.Closeable;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** A framed TCP connection with rolling deadlines; a watchdog bounds writes, which Java cannot. */
final class Conn implements Closeable {
    static final int IO_TIMEOUT_MS = 30_000;
    private static final ScheduledThreadPoolExecutor WATCHDOG =
            new ScheduledThreadPoolExecutor(
                    1,
                    r -> {
                        Thread t = new Thread(r, "weave-deadlines");
                        t.setDaemon(true);
                        return t;
                    });

    static {
        WATCHDOG.setRemoveOnCancelPolicy(true);
    }

    private interface Io {
        void run() throws IOException;
    }

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;

    Conn(Socket socket, int timeoutMs) throws IOException {
        this.socket = socket;
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(timeoutMs);
        in = new BufferedInputStream(socket.getInputStream(), 1 << 16);
        OutputStream raw = socket.getOutputStream();
        OutputStream bounded =
                new FilterOutputStream(raw) {
                    @Override
                    public void write(byte[] b, int off, int len) throws IOException {
                        guarded(() -> raw.write(b, off, len), timeoutMs);
                    }

                    @Override
                    public void flush() throws IOException {
                        guarded(raw::flush, timeoutMs);
                    }
                };
        out = new BufferedOutputStream(bounded, 1 << 16);
    }

    /** Dials host:port or [v6]:port, trying every resolved address. */
    static Conn dial(String target, int timeoutMs) throws IOException {
        int colon = target.lastIndexOf(':');
        if (colon <= 0) {
            throw new IOException("target must be host:port: " + target);
        }
        String host = target.substring(0, colon).replaceAll("^\\[(.*)]$", "$1");
        int port = Integer.parseInt(target.substring(colon + 1));
        IOException last = new IOException(target + " resolved to no addresses");
        for (InetAddress address : InetAddress.getAllByName(host)) {
            Socket socket = new Socket();
            try {
                socket.connect(new InetSocketAddress(address, port), 10_000);
                return new Conn(socket, timeoutMs);
            } catch (IOException e) {
                socket.close();
                last = e;
            }
        }
        throw last;
    }

    private void guarded(Io io, int timeoutMs) throws IOException {
        ScheduledFuture<?> alarm = WATCHDOG.schedule(this::close, timeoutMs, TimeUnit.MILLISECONDS);
        try {
            io.run();
        } finally {
            alarm.cancel(false);
        }
    }

    /** The next frame type without consuming it, or -1 at end of stream. */
    int peek() throws IOException {
        in.mark(1);
        int b = in.read();
        in.reset();
        return b;
    }

    Wire.Frame read() throws IOException {
        return Wire.read(in);
    }

    Wire.Frame expect(int type, String name) throws IOException {
        Wire.Frame f = read();
        if (f.type != type) {
            throw Wire.unexpected(f, name);
        }
        return f;
    }

    void write(int type, byte[] payload) throws IOException {
        Wire.write(out, type, payload);
    }

    void send(int type, byte[] payload) throws IOException {
        write(type, payload);
        out.flush();
    }

    void flush() throws IOException {
        out.flush();
    }

    /** Best-effort ABORT; the peer may already be gone. */
    void abort(int code, String message) {
        try {
            send(Wire.ABORT, Wire.abort(code, message));
        } catch (IOException | RuntimeException e) {
            // advisory only
        }
    }

    @Override
    public void close() {
        try {
            socket.close();
        } catch (IOException e) {
            // already closed
        }
    }
}
