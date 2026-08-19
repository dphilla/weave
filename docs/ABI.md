# Weave guest ABI

Everything a host plugin needs to drive a woven module, on any runtime. All of
this is expressed through standard Wasm imports/exports — no engine internals.

## Import (the only one Weave adds)

| import | signature | semantics |
|---|---|---|
| `weave.poll` | `[] -> [i32]` | Called at instrumented function entries and loop back-edges, gated by an in-guest countdown (`poll_period` sites per host call). Return `0` to continue, nonzero to request a full stack unwind. |

The module's own imports (host services) are listed in `weave.meta` →
`imports`; a host must provide all of them.

## Exports added / replaced

| export | kind | semantics |
|---|---|---|
| *original function exports* | func | Replaced by wrappers with identical signatures. After any call returns, read `__weave_flag`: `0` = completed (results also staged in the results area), `1` = unwound (returned values are dummies — ignore them). |
| `__weave_init` | func `[]->[]` | One-time init for a **fresh** run: allocates the weave region, seeds table shadows and segment flags, runs the module's original `start`. Idempotent. **Never call on restore.** |
| `__weave_resume` | func `[]->[]` | Rebuilds the stack from the shadow stack and continues execution. Call only when state is an unwound checkpoint. Sets `__weave_flag` like a wrapper. |
| memories | memory | Every memory is exported (existing export name reused, else `__weave_memN`); names listed in `weave.meta.memories`. |
| control globals | global (mut i32) | Listed in `weave.meta.control_globals`; the complete non-memory state. |

## Control globals

| name | meaning |
|---|---|
| `__weave_state` | 0 run / 1 unwinding / 2 rewinding |
| `__weave_flag` | last call outcome: 0 done / 1 unwound |
| `__weave_entry` | index into `weave.meta.entries` of the live entry |
| `__weave_ctr` | poll countdown |
| `__weave_sp`, `__weave_stack_base`, `__weave_stack_end` | shadow-stack pointers (byte addresses in memory 0) |
| `__weave_rbase` | base of the weave region (saved globals, segment flags, results area, table shadows) |
| `__weave_tshN`, `__weave_tshcapN` | per-table shadow array pointer/capacity (present only if the module mutates tables) |

## Results area

When a workload completes (on either side of a migration), each result `i` of
the entry is staged at `mem0[__weave_rbase + globals_area_size + 16*i]`,
little-endian, 16 bytes per slot. Types come from `weave.meta.entries`.
This is how a result outlives a migration and how JS hosts read i64/v128
results without Global API limitations.

## Snapshot / restore recipe (what every plugin does)

Capture (after `__weave_flag == 1`):
1. read all exported memories fully;
2. read every `control_globals` value;
3. collect service blobs.

Restore (fresh instance, **without** `__weave_init`):
1. grow memories to captured sizes, write bytes;
2. set every control global;
3. restore service blobs;
4. call `__weave_resume`.

## `weave.meta` custom section

Binary layout (all LE; `str` = u32 length + UTF-8; `types` = u16 count + one
byte per type: 0=i32 1=i64 2=f32 3=f64 4=v128 5=funcref):

```
magic          "WVMT"
version        u16 (=1)
poll_period    u32
entries        u16 count × { name: str, params: types, results: types }
memories       u16 count × str            (export name per memory index)
imports        u16 count × { module: str, name: str, params: types, results: types }
control_globals u16 count × str
globals_area_size u32
results_area_size u32
```

## Host-service state

A service is `{ name, snapshot() -> bytes, restore(bytes) }`. Blobs are opaque
to Weave but hashed into the state hash, so peers' implementations must be
byte-compatible. Built-ins (implemented identically in Rust/JS/Go runners):

| service | import | blob |
|---|---|---|
| `env.emit` | `env.emit(i32, i64)` | `count: u64 LE, sum: i64 LE` where `sum += h + i` (wrapping) |
| `env.emit32` | `env.emit32(i32)` | same, `sum += v` |
| `env.emit64` | `env.emit64(i64)` | same, `sum += v` |

## Contracts

- Single-threaded guest; one entry call in flight at a time.
- Hosts must not request an unwind from a reentrant host→guest call.
- Don't call entries while an unwound checkpoint is pending (resume it first).
- The countdown means checkpoint latency is bounded by `poll_period` site
  executions on any unbounded execution path.
