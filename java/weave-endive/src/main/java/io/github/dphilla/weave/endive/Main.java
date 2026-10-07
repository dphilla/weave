package io.github.dphilla.weave.endive;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** weave-endive: the Weave node runner on Endive; guest code runs on a large-stack thread. */
public final class Main {
    private static final String USAGE =
            String.join(
                    "\n",
                    "usage:",
                    "  weave-endive run --module M --invoke NAME [--arg V]...",
                    "  weave-endive serve --listen HOST:PORT [--module M --invoke NAME [--arg"
                            + " V]...]",
                    "               [--exit-on-done] [--budget BYTES] [--max-rounds N]"
                            + " [--dirty-threshold PAGES]",
                    "  weave-endive migrate --node HOST:PORT --to HOST:PORT",
                    "  weave-endive status --node HOST:PORT",
                    "  weave-endive checkpoint --module M --invoke NAME [--arg V]... --after-polls"
                            + " N -o SNAP",
                    "  weave-endive restore --module M SNAP");
    private static final Set<String> VALUE_FLAGS =
            Set.of(
                    "module",
                    "invoke",
                    "arg",
                    "listen",
                    "node",
                    "to",
                    "budget",
                    "max-rounds",
                    "dirty-threshold",
                    "after-polls",
                    "o");

    private final PrintStream out =
            new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
    private final Map<String, String> flags = new HashMap<>();
    private final List<String> args = new ArrayList<>();
    private final List<String> positional = new ArrayList<>();
    private boolean exitOnDone;

    public static void main(String[] argv) throws InterruptedException {
        int[] code = {1};
        Thread executor =
                new Thread(
                        null,
                        () -> code[0] = new Main().dispatch(argv),
                        "weave-executor",
                        256L << 20);
        executor.start();
        executor.join();
        System.exit(code[0]);
    }

    int dispatch(String[] argv) {
        try {
            parse(argv);
        } catch (IllegalArgumentException e) {
            System.err.println("weave: " + e.getMessage() + "\n" + USAGE);
            return 2;
        }
        try {
            switch (argv[0]) {
                case "run":
                    return run();
                case "serve":
                    return serve();
                case "migrate":
                case "status":
                    return control(argv[0].equals("migrate"));
                case "checkpoint":
                    return checkpoint();
                case "restore":
                    return restore();
                default:
                    System.err.println("weave: unknown command " + argv[0] + "\n" + USAGE);
                    return 2;
            }
        } catch (Exception | Error e) {
            System.err.println("weave: error: " + (e.getMessage() == null ? e : e.getMessage()));
            return 1;
        }
    }

    private void parse(String[] argv) {
        if (argv.length == 0) {
            throw new IllegalArgumentException("missing command");
        }
        for (int i = 1; i < argv.length; i++) {
            String name = argv[i].equals("-o") ? "o" : argv[i].replaceFirst("^--", "");
            if (name.equals("exit-on-done")) {
                exitOnDone = true;
            } else if (name.equals(argv[i])) {
                positional.add(argv[i]);
            } else if (!VALUE_FLAGS.contains(name) || i + 1 >= argv.length) {
                throw new IllegalArgumentException("unknown flag or missing value: " + argv[i]);
            } else if (name.equals("arg")) {
                args.add(argv[++i]);
            } else if (flags.put(name, argv[++i]) != null) {
                throw new IllegalArgumentException("duplicate flag " + argv[i - 1]);
            }
        }
    }

    private String required(String name) {
        String v = flags.get(name);
        if (v == null) {
            throw new IllegalArgumentException("missing --" + name);
        }
        return v;
    }

    private long number(String flag, long fallback) {
        long n = flags.containsKey(flag) ? Long.parseLong(flags.get(flag)) : fallback;
        if (n < 0) {
            throw new IllegalArgumentException("--" + flag + " must not be negative");
        }
        return n;
    }

    private WovenModule load() throws IOException {
        return WovenModule.compile(Files.readAllBytes(Path.of(required("module"))));
    }

    private long[] entryArgs(Meta meta, String entry) {
        int index = meta.entryIndex(entry);
        if (index < 0 || meta.entries.get(index).params.size() != args.size()) {
            throw new IllegalArgumentException(
                    "module has no entry " + entry + " taking " + args.size() + " args");
        }
        long[] out = new long[args.size()];
        for (int i = 0; i < out.length; i++) {
            String s = args.get(i);
            switch (meta.entries.get(index).params.get(i)) {
                case I32:
                    out[i] = Integer.parseInt(s);
                    break;
                case I64:
                    out[i] = Long.parseLong(s);
                    break;
                case F32:
                    out[i] = Float.floatToRawIntBits(Float.parseFloat(s));
                    break;
                case F64:
                    out[i] = Double.doubleToRawLongBits(Double.parseDouble(s));
                    break;
                default:
                    throw new IllegalArgumentException(
                            "entry " + entry + " takes a value the command line cannot pass");
            }
        }
        return out;
    }

    private int run() throws IOException {
        WovenModule module = load();
        String entry = required("invoke");
        long[] call = entryArgs(module.meta(), entry);
        WovenInstance instance = Node.instance(module, out, true);
        if (instance.call(entry, call)) {
            throw new IllegalStateException("workload unwound without a migration in flight");
        }
        out.println("WEAVE_DONE [" + String.join(", ", instance.results()) + "]");
        return 0;
    }

    private int serve() throws IOException, InterruptedException {
        SourceMigration.Options d = SourceMigration.Options.DEFAULTS;
        Node node =
                new Node(
                        out,
                        System.err,
                        new SourceMigration.Options(
                                number("budget", d.budgetBytes),
                                number("dirty-threshold", d.dirtyThreshold),
                                number("max-rounds", d.maxRounds)));
        node.bind(required("listen"));
        WovenModule module = flags.containsKey("module") ? load() : null;
        String entry = module == null ? null : required("invoke");
        node.serve(
                module, entry, module == null ? null : entryArgs(module.meta(), entry), exitOnDone);
        return 0;
    }

    private int control(boolean migrate) throws IOException {
        // A node answers a legacy migrate only when it finishes, after up to 120 s.
        try (Conn conn = Conn.dial(required("node"), migrate ? 130_000 : Conn.IO_TIMEOUT_MS)) {
            if (migrate) {
                conn.send(Wire.CTL_MIGRATE, Wire.str(required("to")));
            } else {
                conn.send(Wire.CTL_STATUS, Wire.EMPTY);
            }
            Wire.Frame reply = conn.read();
            String msg = reply.reader().str();
            if (reply.type != Wire.CTL_OK) {
                throw new IOException("node error: " + msg);
            }
            out.println("ok: " + msg);
            return 0;
        }
    }

    private int checkpoint() throws IOException {
        WovenModule module = load();
        String entry = required("invoke");
        long[] call = entryArgs(module.meta(), entry);
        long[] polls = {number("after-polls", 0)};
        Path snapshot = Path.of(required("o"));
        WovenInstance instance = Node.instance(module, out, true);
        instance.onPoll(() -> polls[0]-- > 0 ? 0 : 1);
        if (!instance.call(entry, call)) {
            System.err.println("workload completed before checkpoint");
            out.println("WEAVE_DONE [" + String.join(", ", instance.results()) + "]");
            return 0;
        }
        Files.write(snapshot, instance.checkpoint().encode());
        System.err.println("checkpoint written to " + snapshot);
        out.println("WEAVE_CHECKPOINTED");
        return 0;
    }

    private int restore() throws IOException {
        if (positional.size() != 1) {
            throw new IllegalArgumentException("restore takes exactly one snapshot path");
        }
        WovenModule module = load();
        WovenInstance instance = Node.instance(module, out, false);
        instance.restore(Snapshot.decode(Files.readAllBytes(Path.of(positional.get(0)))));
        if (instance.resume()) {
            throw new IllegalStateException("restored workload unwound unexpectedly");
        }
        out.println("WEAVE_DONE [" + String.join(", ", instance.results()) + "]");
        return 0;
    }
}
