#!/usr/bin/env node
// weave-node.mjs — Weave node runner for Node.js (V8's web WebAssembly API).
//
//   node js/weave-node.mjs run --module M.wasm --invoke NAME [--arg V]...
//   node js/weave-node.mjs serve --listen HOST:PORT
//        [--module M.wasm --invoke NAME [--arg V]...] [--exit-on-done]
//        [--yield-ms N] [--budget BYTES] [--max-rounds N] [--dirty-threshold N]
//   node js/weave-node.mjs migrate --node HOST:PORT --to HOST:PORT
//   node js/weave-node.mjs status --node HOST:PORT
//
// Interoperates over the exact same wire protocol as the wasmtime node: a
// workload can live-migrate wasmtime → Node → wasmtime and never notice.
// The built-in host services (env.emit / env.emit32 / env.emit64) are
// byte-compatible with the Rust CLI's.

import net from "node:net";
import fs from "node:fs";
import {
  WeaveInstance, SourceMigration, acceptMigration, readFrame, frame,
  Writer, FT, G, FLAG_DONE, PROTO_VERSION,
} from "./weave.mjs";

// ---------------------------------------------------------------- transport

class TcpTransport {
  constructor(socket) {
    this.socket = socket;
    this.chunks = [];
    this.len = 0;
    this.waiters = [];
    this.err = null;
    socket.on("data", (buf) => {
      this.chunks.push(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice());
      this.len += buf.length;
      this._pump();
    });
    socket.on("error", (e) => {
      this.err = e;
      this._pump();
    });
    socket.on("close", () => {
      this.err = this.err ?? new Error("connection closed");
      this._pump();
    });
  }

  _pump() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.len >= w.n) {
        this.waiters.shift();
        w.resolve(this._take(w.n));
      } else if (this.err) {
        this.waiters.shift();
        w.reject(this.err);
      } else {
        break;
      }
    }
  }

  _take(n) {
    const out = new Uint8Array(n);
    let off = 0;
    while (off < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - off);
      out.set(head.subarray(0, take), off);
      off += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
      this.len -= take;
    }
    return out;
  }

  readExact(n) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this._pump();
    });
  }

  write(bytes) {
    return new Promise((resolve, reject) => {
      this.socket.write(Buffer.from(bytes), (e) => (e ? reject(e) : resolve()));
    });
  }
}

function connect(addr) {
  const [host, port] = splitAddr(addr);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port, noDelay: true }, () => resolve(new TcpTransport(sock)));
    sock.on("error", reject);
  });
}

function splitAddr(addr) {
  const i = addr.lastIndexOf(":");
  return [addr.slice(0, i), Number(addr.slice(i + 1))];
}

// ---------------------------------------------------------------- services

const MASK64 = (1n << 64n) - 1n;
const toI64 = (v) => BigInt.asIntN(64, v & MASK64);

function makeEmitServices() {
  const mk = (name, print) => {
    const st = { count: 0n, sum: 0n };
    return {
      state: st,
      imports: { env: { [name.split(".")[1]]: print(st) } },
      snapshot() {
        const b = new Uint8Array(16);
        const dv = new DataView(b.buffer);
        dv.setBigUint64(0, st.count & MASK64, true);
        dv.setBigInt64(8, toI64(st.sum), true);
        return b;
      },
      restore(blob) {
        const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
        st.count = dv.getBigUint64(0, true);
        st.sum = dv.getBigInt64(8, true);
      },
    };
  };
  const services = new Map();
  services.set(
    "env.emit",
    mk("env.emit", (st) => (i, h) => {
      st.count += 1n;
      st.sum = toI64(st.sum + h + BigInt(i));
      console.log(`EMIT ${i} ${h}`);
    }),
  );
  services.set(
    "env.emit32",
    mk("env.emit32", (st) => (v) => {
      st.count += 1n;
      st.sum = toI64(st.sum + BigInt(v));
      console.log(`EMIT32 ${v}`);
    }),
  );
  services.set(
    "env.emit64",
    mk("env.emit64", (st) => (v) => {
      st.count += 1n;
      st.sum = toI64(st.sum + v);
      console.log(`EMIT64 ${v}`);
    }),
  );
  return services;
}

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const flags = new Map();
  const multi = [];
  const positional = [];
  const valueFlags = new Set([
    "module", "invoke", "arg", "listen", "node", "to", "yield-ms",
    "budget", "max-rounds", "dirty-threshold",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (valueFlags.has(name)) {
        const v = argv[++i];
        if (name === "arg") multi.push(v);
        else flags.set(name, v);
      } else {
        flags.set(name, true);
      }
    } else positional.push(a);
  }
  return { flags, args: multi, positional };
}

function entryArgs(meta, entry, raw) {
  const e = meta.entries.find((e) => e.name === entry);
  if (!e) throw new Error(`module has no entry ${entry}`);
  if (e.params.length !== raw.length) {
    throw new Error(`entry ${entry} takes ${e.params.length} args, got ${raw.length}`);
  }
  return e.params.map((ty, i) => {
    switch (ty) {
      case "i32": return Number(raw[i]) | 0;
      case "i64": return BigInt(raw[i]);
      case "f32":
      case "f64": return Number(raw[i]);
      default: throw new Error(`cannot pass ${ty} on the command line`);
    }
  });
}

function renderResults(vals) {
  return `[${vals.map((v) => v.toString()).join(", ")}]`;
}

// ---------------------------------------------------------------- commands

async function cmdRun(opts) {
  const bytes = new Uint8Array(fs.readFileSync(opts.flags.get("module")));
  const services = makeEmitServices();
  const inst = new WeaveInstance(bytes, services, { yieldMs: Number(opts.flags.get("yield-ms") ?? 50) });
  await inst.instantiate();
  inst.init();
  const entry = opts.flags.get("invoke");
  const args = entryArgs(inst.meta, entry, opts.args);
  const res = await inst.drive(entry, args, async () => "continue");
  console.log(`WEAVE_DONE ${renderResults(res.results)}`);
}

async function cmdServe(opts) {
  const listen = opts.flags.get("listen");
  const [host, port] = splitAddr(listen);
  const exitOnDone = opts.flags.has("exit-on-done");
  const yieldMs = Number(opts.flags.get("yield-ms") ?? 25);
  const sourceOpts = {
    budgetBytes: Number(opts.flags.get("budget") ?? 8 << 20),
    maxRounds: Number(opts.flags.get("max-rounds") ?? 10),
    dirtyPageThreshold: Number(opts.flags.get("dirty-threshold") ?? 64),
  };
  const moduleCache = new Map();

  const shared = { request: null, lastResult: null };
  let busy = false;

  // Workload driver: runs inst cooperatively; carries out migration when
  // requested; returns "migrated" | "done".
  async function driveWorkload(inst, entry, args) {
    busy = true;
    let migration = null;
    try {
      const res = await inst.drive(entry, args, async () => {
        // At every unwind-yield: let the event loop breathe so ctl/data
        // connections are serviced.
        await new Promise((r) => setImmediate(r));
        if (migration === null && shared.request) {
          const target = shared.request;
          try {
            const t = await connect(target);
            migration = new SourceMigration(t, inst, "node", sourceOpts);
            await migration.handshake();
          } catch (e) {
            shared.lastResult = `migration failed to start: ${e.message}`;
            shared.request = null;
            migration = null;
          }
        }
        if (migration) {
          try {
            const ready = await migration.precopyStep();
            if (ready) return "hold"; // stay unwound: state is checkpointed
          } catch (e) {
            shared.lastResult = `migration failed: ${e.message}`;
            shared.request = null;
            migration = null;
          }
        }
        return "continue";
      });
      if (res.status === "done") {
        if (migration) {
          // finished before checkpoint: abort the transfer
          try {
            await migration.t.write(frame(FT.ABORT, new Writer().u32(10).str("completed before checkpoint").out()));
          } catch {}
          shared.request = null;
        }
        const msg = `done: ${renderResults(res.results)}`;
        console.log(`WEAVE_DONE ${renderResults(res.results)}`);
        shared.lastResult = msg;
        return "done";
      }
      // held: guest is unwound with a converged pre-copy — go final.
      const stats = await migration.finish();
      const msg = `migrated: ${stats.rounds} rounds, ${stats.totalPages} pages total, ${stats.finalPages} in pause window`;
      console.error(`weave: ${msg}`);
      console.log("WEAVE_MIGRATED");
      shared.lastResult = msg;
      shared.request = null;
      return "migrated";
    } catch (e) {
      // migration failed after unwind: resume locally, seamlessly
      shared.lastResult = `migration failed: ${e.message}`;
      shared.request = null;
      console.error(`weave: migration failed (${e.message}), resuming locally`);
      const res = await inst.drive(null, null, async () => "continue");
      const msg = `done: ${renderResults(res.results)}`;
      console.log(`WEAVE_DONE ${renderResults(res.results)}`);
      shared.lastResult = msg;
      return "done";
    } finally {
      busy = false;
    }
  }

  const maybeExit = (outcome) => {
    if (exitOnDone && (outcome === "done" || outcome === "migrated")) {
      setTimeout(() => process.exit(0), 150);
    }
  };

  const server = net.createServer({ noDelay: true }, (sock) => {
    sock.once("readable", async () => {
      const first = sock.read(1);
      if (first === null) return;
      sock.unshift(first);
      const t = new TcpTransport(sock);
      try {
        if (first[0] === FT.HELLO) {
          if (busy) {
            await t.write(frame(FT.ABORT, new Writer().u32(9).str("node busy").out()));
            sock.end();
            return;
          }
          const { inst, sourceRuntime } = await acceptMigration(t, makeEmitServices, {
            runtimeName: "node",
            moduleCache,
            yieldMs,
          });
          console.error(`weave: workload received from ${sourceRuntime}, resuming`);
          sock.end();
          const outcome = await driveWorkload(inst, null, null);
          maybeExit(outcome);
        } else if (first[0] === FT.CTL_MIGRATE) {
          const f = await readFrame(t);
          const c = new DataView(f.payload.buffer, f.payload.byteOffset);
          const tlen = c.getUint32(0, true);
          const target = new TextDecoder().decode(f.payload.subarray(4, 4 + tlen));
          shared.request = target;
          shared.lastResult = null;
          const deadline = Date.now() + 120000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 25));
            if (shared.lastResult) break;
          }
          const msg = shared.lastResult ?? "timeout";
          const ok = msg.startsWith("migrated") || msg.startsWith("done");
          await t.write(frame(ok ? FT.CTL_OK : FT.CTL_ERR, new Writer().str(msg).out()));
          sock.end();
        } else if (first[0] === FT.CTL_STATUS) {
          await readFrame(t);
          const msg = shared.lastResult ?? (busy ? "running" : "idle");
          await t.write(frame(FT.CTL_OK, new Writer().str(msg).out()));
          sock.end();
        } else {
          sock.end();
        }
      } catch (e) {
        console.error(`weave: connection error: ${e.message}`);
        try { sock.end(); } catch {}
      }
    });
  });

  server.listen(port, host, () => {
    console.error(`weave: listening on ${listen} (node)`);
  });

  if (opts.flags.get("module")) {
    const bytes = new Uint8Array(fs.readFileSync(opts.flags.get("module")));
    const services = makeEmitServices();
    const inst = new WeaveInstance(bytes, services, { yieldMs });
    await inst.instantiate();
    inst.init();
    const entry = opts.flags.get("invoke");
    const args = entryArgs(inst.meta, entry, opts.args);
    console.error("weave: starting workload");
    const outcome = await driveWorkload(inst, entry, args);
    maybeExit(outcome);
  } else {
    console.error("weave: idle, waiting for workload");
  }
}

async function cmdCtl(opts, migrate) {
  const t = await connect(opts.flags.get("node"));
  if (migrate) {
    await t.write(frame(FT.CTL_MIGRATE, new Writer().str(opts.flags.get("to")).out()));
  } else {
    await t.write(frame(FT.CTL_STATUS));
  }
  const f = await readFrame(t);
  const dv = new DataView(f.payload.buffer, f.payload.byteOffset);
  const mlen = dv.getUint32(0, true);
  const msg = new TextDecoder().decode(f.payload.subarray(4, 4 + mlen));
  if (f.type === FT.CTL_OK) {
    console.log(`ok: ${msg}`);
    process.exit(0);
  } else {
    console.error(`node error: ${msg}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- main

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);
const commands = {
  run: () => cmdRun(opts),
  serve: () => cmdServe(opts),
  migrate: () => cmdCtl(opts, true),
  status: () => cmdCtl(opts, false),
};
if (!commands[cmd]) {
  console.error("usage: weave-node.mjs run|serve|migrate|status ...");
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(`weave: error: ${e.stack ?? e}`);
  process.exit(1);
});
