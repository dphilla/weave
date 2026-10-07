package io.github.dphilla.weave.endive;

import java.io.IOException;
import java.io.PrintStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.stream.Collectors;
import run.endive.runtime.HostFunction;

/** A symmetric Weave node, as weave-wazero's serve; the serving thread owns every Endive object. */
public final class Node {
    static final String RUNTIME = "endive";

    private static final class Request {
        final String target;
        final CompletableFuture<String> result = new CompletableFuture<>();

        Request(String target) {
            this.target = target;
        }
    }

    private final PrintStream out;
    private final PrintStream log;
    private final SourceMigration.Options opts;
    private final ArrayBlockingQueue<Conn> incoming = new ArrayBlockingQueue<>(1);
    private final Semaphore handlers = new Semaphore(64);
    private final Map<String, WovenModule> cache =
            new LinkedHashMap<>(16, 0.75f, true) {
                private static final long serialVersionUID = 1L;

                @Override
                protected boolean removeEldestEntry(Map.Entry<String, WovenModule> eldest) {
                    return size() > 8;
                }
            };

    // Guarded by this; polls read the request without the lock.
    private final Control control = new Control("idle");
    private volatile Request request;
    private String lastResult = "";
    private boolean active;
    private boolean incomingReserved;

    // Owned by the serving thread.
    private SourceMigration migration;
    private ServerSocket server;

    public Node(PrintStream out, PrintStream log, SourceMigration.Options opts) {
        this.out = out;
        this.log = log;
        this.opts = opts;
    }

    /** A fresh workload, or a restore target, with the built-in services printing to out. */
    static WovenInstance instance(WovenModule module, PrintStream out, boolean fresh) {
        List<EmitService> services = EmitService.builtins(out::println);
        List<HostFunction> imports =
                services.stream().map(EmitService::hostFunction).collect(Collectors.toList());
        return fresh
                ? WovenInstance.fresh(module, List.copyOf(services), imports)
                : WovenInstance.restoreTarget(module, List.copyOf(services), imports);
    }

    /** Binds before serving, so that port 0 resolves to the actual port. */
    public int bind(String listen) throws IOException {
        int colon = listen.lastIndexOf(':');
        String host = listen.substring(0, colon).replaceAll("^\\[(.*)]$", "$1");
        server = new ServerSocket();
        server.setReuseAddress(true);
        server.bind(
                new InetSocketAddress(
                        InetAddress.getByName(host), Integer.parseInt(listen.substring(colon + 1))),
                64);
        log.println("weave: listening on " + listen + " (endive)");
        return server.getLocalPort();
    }

    /** Runs the optional workload, then hosts incoming ones; exitOnDone returns after the first. */
    public void serve(WovenModule module, String entry, long[] args, boolean exitOnDone)
            throws InterruptedException {
        WovenInstance first = module == null ? null : instance(module, out, true);
        if (first != null) {
            cache.put(module.hex(), module);
            synchronized (this) {
                active = true;
                control.set("running");
            }
        }
        Thread acceptor = new Thread(this::acceptLoop, "weave-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        log.println(
                first == null ? "weave: idle, waiting for workload" : "weave: starting workload");
        if (first != null && drive(first, entry, args, false, exitOnDone)) {
            return;
        }
        while (true) {
            Conn conn = incoming.take();
            TargetSession session = new TargetSession(conn);
            WovenInstance received;
            try {
                received = session.receive(RUNTIME, cache, m -> instance(m, out, false));
            } catch (IOException | RuntimeException e) {
                conn.close();
                synchronized (this) {
                    incomingReserved = false;
                    control.set("idle");
                }
                log.println("weave: incoming migration failed: " + e.getMessage());
                continue;
            }
            synchronized (this) {
                incomingReserved = false;
                active = true;
                lastResult = "";
                control.set("running");
            }
            log.println("weave: workload received from " + session.source + ", resuming");
            if (drive(received, null, null, true, exitOnDone)) {
                return;
            }
        }
    }

    // Runs one workload to completion, trap or handoff; true when the node should exit.
    private boolean drive(
            WovenInstance instance, String entry, long[] args, boolean resume, boolean exitOnDone)
            throws InterruptedException {
        instance.onPoll(() -> poll(instance));
        try {
            boolean unwound = resume ? instance.resume() : instance.call(entry, args);
            while (unwound && !handOff(instance)) {
                unwound = instance.resume();
            }
            if (!instance.retired()) {
                finished(instance);
            }
        } catch (WovenInstance.Trap t) {
            if (migration != null) {
                migration.abort(10, "workload trapped before handoff");
                migration = null;
            }
            log.println("weave: workload trapped: " + t.getMessage());
            complete(Control.Completion.TRAPPED, "trap: " + t.getMessage());
        }
        if (exitOnDone) {
            Thread.sleep(150);
        }
        return exitOnDone;
    }

    // The guest unwound: finish a pending migration; true once ownership moved.
    private boolean handOff(WovenInstance instance) {
        SourceMigration m = migration;
        migration = null;
        if (m == null) {
            log.println("weave: unwound outside migration; resuming");
            return false;
        }
        long start = System.nanoTime();
        try (m) {
            SourceMigration.Handoff h = m.finish(instance, this::sourceRetired);
            boolean confirmed = h.commitError == null;
            String msg =
                    confirmed
                            ? "migrated: " + h.stats
                            : "commit uncertain: "
                                    + h.stats
                                    + "; COMMIT_OK unconfirmed (source retired)";
            if (!confirmed) {
                log.println("weave: " + h.commitError);
            }
            log.println(
                    String.format(
                            Locale.ROOT,
                            "weave: %s (handoff %.1f ms)",
                            msg,
                            (System.nanoTime() - start) / 1e6));
            out.println(confirmed ? "WEAVE_MIGRATED" : "WEAVE_MIGRATED_UNCONFIRMED");
            complete(
                    confirmed ? Control.Completion.MIGRATED : Control.Completion.COMMIT_UNCERTAIN,
                    msg);
            return true;
        } catch (IOException | RuntimeException e) {
            if (instance.retired()) {
                complete(
                        Control.Completion.COMMIT_UNCERTAIN, "commit uncertain: " + e.getMessage());
                return true;
            }
            log.println("weave: final copy failed (" + e.getMessage() + "), resuming locally");
            complete(
                    Control.Completion.FAILED_BEFORE_COMMIT, "migration failed: " + e.getMessage());
            return false;
        }
    }

    private void finished(WovenInstance instance) {
        if (migration != null) {
            migration.abort(10, "workload completed before checkpoint");
            migration = null;
        }
        String results;
        try {
            results = String.join(", ", instance.results());
        } catch (RuntimeException e) {
            log.println("weave: reading workload results failed: " + e.getMessage());
            complete(Control.Completion.TRAPPED, "trap: reading results: " + e.getMessage());
            return;
        }
        out.println("WEAVE_DONE [" + results + "]");
        complete(Control.Completion.COMPLETED, "done: [" + results + "]");
    }

    // Runs inside the guest: a migration failure must never unwind or trap the workload.
    private int poll(WovenInstance instance) {
        Request r = request;
        try {
            if (migration == null && r != null) {
                try {
                    migration = SourceMigration.connect(r.target, RUNTIME, instance.module(), opts);
                } catch (IOException | RuntimeException e) {
                    complete(
                            Control.Completion.FAILED_BEFORE_COMMIT,
                            "migration failed to start: " + e.getMessage());
                    return 0;
                }
            }
            return migration != null && migration.precopyStep(instance) ? 1 : 0;
        } catch (Throwable e) {
            if (migration != null) {
                migration.close();
                migration = null;
            }
            complete(Control.Completion.FAILED_BEFORE_COMMIT, "migration failed: " + e);
            return 0;
        }
    }

    private synchronized void sourceRetired() {
        control.sourceRetired();
    }

    private synchronized void complete(Control.Completion completion, String result) {
        Control.Completion effective = control.complete(completion, result);
        active = active && effective == Control.Completion.FAILED_BEFORE_COMMIT;
        lastResult = result;
        Request r = request;
        request = null;
        if (r != null) {
            r.result.complete(result);
        }
    }

    private void acceptLoop() {
        while (true) {
            Socket socket;
            try {
                socket = server.accept();
            } catch (IOException e) {
                return;
            }
            if (!handlers.tryAcquire()) {
                closeQuietly(socket);
                continue;
            }
            Thread t =
                    new Thread(
                            () -> {
                                try {
                                    handle(socket);
                                } finally {
                                    handlers.release();
                                }
                            },
                            "weave-conn");
            t.setDaemon(true);
            t.start();
        }
    }

    // Dispatches on the first frame: HELLO queues an incoming migration, the rest is control.
    private void handle(Socket socket) {
        Conn conn;
        try {
            conn = new Conn(socket, Conn.IO_TIMEOUT_MS);
            if (conn.peek() == Wire.HELLO) {
                offerIncoming(conn);
                return;
            }
        } catch (IOException e) {
            closeQuietly(socket);
            return;
        }
        try (conn) {
            Wire.Frame f = conn.read();
            if (f.type == Wire.CTL_MIGRATE) {
                legacyMigrate(conn, f);
            } else if (f.type == Wire.CTL_STATUS) {
                conn.send(Wire.CTL_OK, Wire.str(legacyStatus()));
            } else if (f.type == Wire.CTL_REQUEST) {
                conn.send(Wire.CTL_RESPONSE, control(f.payload));
            }
        } catch (IOException | RuntimeException e) {
            // a broken control client only loses its own connection
        }
    }

    private void offerIncoming(Conn conn) {
        synchronized (this) {
            if (!active && !incomingReserved && incoming.offer(conn)) {
                incomingReserved = true;
                control.set("accepting");
                return;
            }
        }
        conn.abort(9, "node busy");
        conn.close();
    }

    private void legacyMigrate(Conn conn, Wire.Frame f) throws IOException {
        String target;
        try {
            Bytes.Reader r = f.reader();
            target = r.str();
            r.end("CTL_MIGRATE");
        } catch (FormatException e) {
            conn.send(Wire.CTL_ERR, Wire.str("malformed migrate request"));
            return;
        }
        Request req = new Request(target);
        String rejection = null;
        synchronized (this) {
            if (target.strip().isEmpty()) {
                rejection = "migration target must not be empty";
            } else if (!active) {
                rejection = "node has no active workload";
            } else if (request != null) {
                rejection = "migration already in progress";
            } else {
                request = req;
                lastResult = "";
                control.set("migrating");
            }
        }
        String result = rejection;
        if (result == null) {
            try {
                result = req.result.get(120, TimeUnit.SECONDS);
            } catch (TimeoutException | ExecutionException | InterruptedException e) {
                result = "timeout waiting for migration result";
            }
        }
        boolean ok = result.startsWith("migrated") || result.startsWith("done");
        conn.send(ok ? Wire.CTL_OK : Wire.CTL_ERR, Wire.str(result));
    }

    private synchronized String legacyStatus() {
        if (!lastResult.isEmpty()) {
            return lastResult;
        }
        return active ? "running" : incomingReserved ? "accepting" : "idle";
    }

    synchronized byte[] control(byte[] payload) {
        byte[] response = control.handle(payload, active && request == null && !incomingReserved);
        if (control.accepted != null) {
            request = new Request(control.accepted);
            lastResult = "";
        }
        return response;
    }

    private static void closeQuietly(Socket s) {
        try {
            s.close();
        } catch (IOException e) {
            // already gone
        }
    }
}
