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
import {
  OutboundMigrationAdmission,
  TargetAdmission,
} from "./weave-node-admission.mjs";
import {
  connectTcp,
  readFirstSocketByte,
  TcpTransport,
} from "./weave-node-transport.mjs";
import { makeEmitServices } from "./weave-node-services.mjs";
import { ControlState, builtinCapabilities, decodeRequest, encodeResponse } from "./weave-node-control.mjs";

// ---------------------------------------------------------------- transport

function connect(addr) {
  const [host, port] = splitAddr(addr);
  return connectTcp(host, port);
}

function splitAddr(addr) {
  const i = addr.lastIndexOf(":");
  return [addr.slice(0, i).replace(/^\[|\]$/g, ""), Number(addr.slice(i + 1))];
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
  for (const [flag, value] of [["budget", sourceOpts.budgetBytes], ["max-rounds", sourceOpts.maxRounds]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`--${flag} must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(sourceOpts.dirtyPageThreshold) || sourceOpts.dirtyPageThreshold < 0) {
    throw new RangeError("--dirty-threshold must be a non-negative safe integer");
  }
  if (!Number.isFinite(yieldMs) || yieldMs < 0) throw new RangeError("--yield-ms must be a finite non-negative number");
  const moduleCache = new Map();

  const shared = { lastResult: null };
  const admission = new TargetAdmission(opts.flags.has("module"));
  const outbound = new OutboundMigrationAdmission(() => admission.isRunning());
  const control = new ControlState(builtinCapabilities(), opts.flags.has("module") ? "running" : "idle");
  let activeInstance = null;

  const completeOutbound = (request, completion, message) => {
    // Only the owner may publish a request outcome. This identity check keeps a
    // delayed failure from resolving or overwriting a later control request.
    if (request !== null && outbound.current() !== request) return false;
    shared.lastResult = message;
    control.complete(completion, message);
    return request === null || outbound.complete(request, message);
  };

  const closeTransport = (transport) => {
    try { transport?.close?.(); } catch { /* best-effort transport cleanup */ }
  };
  const closeMigration = (migration) => closeTransport(migration?.t);

  // Workload driver: runs inst cooperatively; carries out migration when
  // requested; returns "migrated" | "done".
  async function driveWorkload(inst, entry, args) {
    admission.startRunning();
    activeInstance = inst;
    control.setLifecycle("running");
    try {
      for (;;) {
        let migration = null;
        let migrationRequest = null;
        try {
          const res = await inst.drive(entry, args, async () => {
            // At every unwind-yield: let the event loop breathe so ctl/data
            // connections are serviced.
            await new Promise((r) => setImmediate(r));
            if (migration === null && outbound.current() !== null) {
              const request = outbound.current();
              let transport = null;
              try {
                transport = await connect(request.target);
                migration = new SourceMigration(transport, inst, "node", sourceOpts);
                await migration.handshake();
                migrationRequest = request;
              } catch (e) {
                completeOutbound(request, "failed_before_commit", `migration failed to start: ${e.message}`);
                closeTransport(transport);
                migration = null;
                migrationRequest = null;
              }
            }
            if (migration) {
              try {
                const ready = await migration.precopyStep();
                if (ready) return "hold"; // stay unwound: state is checkpointed
              } catch (e) {
                completeOutbound(migrationRequest, "failed_before_commit", `migration failed: ${e.message}`);
                closeMigration(migration);
                migration = null;
                migrationRequest = null;
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
              closeMigration(migration);
            }
            const msg = `done: ${renderResults(res.results)}`;
            console.log(`WEAVE_DONE ${renderResults(res.results)}`);
            completeOutbound(migrationRequest ?? outbound.current(), "workload_completed", msg);
            return "done";
          }
          // held: guest is unwound with a converged pre-copy — go final.
          const stats = await migration.finish();
          closeMigration(migration);
          const summary = `${stats.rounds} rounds, ${stats.totalPages} pages total, ${stats.finalPages} in pause window`;
          const msg = stats.commitConfirmed
            ? `migrated: ${summary}`
            : `commit uncertain: ${summary}; COMMIT_OK unconfirmed — source retired (${stats.commitError})`;
          console.error(`weave: ${msg}`);
          console.log(stats.commitConfirmed ? "WEAVE_MIGRATED" : "WEAVE_MIGRATED_UNCONFIRMED");
          completeOutbound(migrationRequest, stats.commitConfirmed ? "migrated" : "commit_uncertain", msg);
          return "migrated";
        } catch (e) {
          if (inst.lifecycle === "retired") {
            completeOutbound(migrationRequest ?? outbound.current(), "commit_uncertain", `source retired: ${e.message}`);
            closeMigration(migration);
            return "migrated";
          }
          if (inst.lifecycle === "failed") {
            completeOutbound(migrationRequest ?? outbound.current(), "workload_trapped", `trap: ${e.message}`);
            closeMigration(migration);
            console.error(`weave: workload trapped: ${e.message}`);
            return "done";
          }
          // A failed final copy before PREPARED retains source execution authority.
          completeOutbound(migrationRequest, "failed_before_commit", `migration failed: ${e.message}`);
          closeMigration(migration);
          console.error(`weave: migration failed (${e.message}), resuming locally`);
          // Resume through the full driver, including control admission. A new
          // operation must remain actionable after a rollback-safe failure.
          entry = null;
          args = null;
        }
      }
    } finally {
      if (inst.lifecycle === "failed" && control.lifecycle !== "failed") {
        completeOutbound(outbound.current(), "workload_trapped", "workload trapped while resuming");
      }
      activeInstance = null;
      admission.finishRunning();
    }
  }

  const maybeExit = (outcome) => {
    if (exitOnDone && (outcome === "done" || outcome === "migrated")) {
      setTimeout(() => process.exit(0), 150);
    }
  };

  const server = net.createServer({ noDelay: true }, async (sock) => {
    let first;
    try {
      first = await readFirstSocketByte(sock);
    } catch (error) {
      console.error(`weave: connection classification failed: ${error.message}`);
      try { sock.destroy(); } catch {}
      return;
    }

    const t = new TcpTransport(sock);
    let incomingReservation = null;
    try {
      if (first === FT.HELLO) {
          incomingReservation = admission.tryReserve();
          if (incomingReservation === null) {
            await t.write(frame(FT.ABORT, new Writer().u32(9).str("node busy").out()));
            sock.end();
            return;
          }
          shared.lastResult = null;
          control.setLifecycle("accepting");
          const { inst, sourceRuntime, commitAckError } = await acceptMigration(t, makeEmitServices, {
            runtimeName: "node",
            moduleCache,
            yieldMs,
          });
          // acceptMigration returns only after COMMIT. Transition directly
          // from accepting to running in this turn, before any further await.
          admission.commit(incomingReservation);
          incomingReservation = null;
          if (commitAckError) {
            console.error(`weave: COMMIT received but COMMIT_OK delivery failed (${commitAckError}); resuming as owner`);
          }
          console.error(`weave: workload received from ${sourceRuntime}, resuming`);
          sock.end();
          const outcome = await driveWorkload(inst, null, null);
          maybeExit(outcome);
      } else if (first === FT.CTL_MIGRATE) {
          const f = await readFrame(t);
          const c = new DataView(f.payload.buffer, f.payload.byteOffset);
          const tlen = c.getUint32(0, true);
          const target = new TextDecoder().decode(f.payload.subarray(4, 4 + tlen));
          const attempt = outbound.tryReserve(target);
          if (!attempt.ok) {
            await t.write(frame(FT.CTL_ERR, new Writer().str(attempt.error).out()));
            sock.end();
            return;
          }
          shared.lastResult = null;
          control.setLifecycle("migrating");
          let timeout;
          const timeoutResult = new Promise((resolve) => {
            timeout = setTimeout(() => resolve("timeout"), 120000);
          });
          const msg = await Promise.race([attempt.request.result, timeoutResult]);
          clearTimeout(timeout);
          const ok = msg.startsWith("migrated") || msg.startsWith("done");
          await t.write(frame(ok ? FT.CTL_OK : FT.CTL_ERR, new Writer().str(msg).out()));
          sock.end();
      } else if (first === FT.CTL_STATUS) {
          await readFrame(t);
          const msg = shared.lastResult ?? admission.status();
          await t.write(frame(FT.CTL_OK, new Writer().str(msg).out()));
          sock.end();
      } else if (first === FT.CTL_REQUEST) {
          const f = await readFrame(t);
          if (activeInstance?.lifecycle === "retired") control.sourceRetired();
          let response;
          try {
            const result = control.handle(decodeRequest(f.payload), admission.isRunning() && outbound.current() === null);
            response = result.response;
            if (result.accepted) {
              // No await between the ledger and execution reservation.
              const attempt = outbound.tryReserve(result.accepted.target);
              if (!attempt.ok) throw new Error(`control admission invariant: ${attempt.error}`);
              shared.lastResult = null;
            }
          } catch (error) {
            response = control.invalidRequest(error.message);
          }
          await t.write(frame(FT.CTL_RESPONSE, encodeResponse(response)));
          sock.end();
      } else {
        sock.end();
      }
    } catch (e) {
      if (incomingReservation !== null) {
        admission.release(incomingReservation);
        control.setLifecycle("idle");
      }
      console.error(`weave: connection error: ${e.message}`);
      // A receive timeout leaves readExact pending; fully destroy the socket
      // so the stalled peer cannot retain this connection or admission slot.
      try { sock.destroy(); } catch {}
    }
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
