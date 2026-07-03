# Weave wire protocol (v1)

Peer-to-peer, single TCP connection dialed by the **source** directly to the
**target** node's listen address. The same framing carries the tiny control
API used by `weave migrate/status`.

Framing: `[type: u8][len: u32 LE][payload: len bytes]`. Strings are
`u32 LE length + UTF-8`. Max frame 64 MiB.

| # | frame | payload | direction |
|---|---|---|---|
| 1 | HELLO | proto u8, role u8 (1 src / 2 dst / 3 ctl), runtime str | both |
| 2 | MODULE_META | module_sha256 [32], size u64, meta blob (raw `weave.meta` payload, u32-prefixed) | src→dst |
| 3 | MODULE_NEED | — | dst→src |
| 4 | MODULE_HAVE | — (content-addressed cache hit) | dst→src |
| 5 | MODULE_DATA | offset u64, bytes (≤256 KiB chunks) | src→dst |
| 6 | MODULE_OK | — (module instantiated, ready for pages) | dst→src |
| 7 | MEM_LAYOUT | n u8, then n × pages u64 (64 KiB wasm pages per memory) | src→dst |
| 8 | PAGE | mem u8, page_no u64 (4 KiB units), 4096 bytes | src→dst |
| 9 | ROUND_END | round u32, pages_sent u64 | src→dst |
| 10 | ROUND_ACK | — | dst→src |
| 11 | FINAL_BEGIN | — (guest has unwound; stop-and-copy begins) | src→dst |
| 12 | GLOBALS | u16 count × { name str, value u32 } | src→dst |
| 13 | SERVICES | u16 count × { name str, blob u32-prefixed } | src→dst |
| 14 | FINAL_END | state_sha256 [32] | src→dst |
| 15 | RESUME_OK | — (hash verified; source may retire its instance) | dst→src |
| 16 | ABORT | code u32, msg str | both |
| 17 | CTL_MIGRATE | target addr str | ctl→node |
| 18 | CTL_STATUS | — | ctl→node |
| 19 | CTL_OK | msg str | node→ctl |
| 20 | CTL_ERR | msg str | node→ctl |

## Phases

1. **HELLO** both ways (version check).
2. **Module sync** by content hash; the target instantiates immediately
   (without `__weave_init`) so pages stream directly into place.
3. **Pre-copy**: any number of MEM_LAYOUT/PAGE frames while the source guest
   keeps executing; ROUND_END/ROUND_ACK delimit full passes (ACK doubles as
   backpressure). All-zero never-sent pages are elided. Dirty detection is
   truncated SHA-256 per page — content-based, since Wasm has no dirty bits.
4. **Stop-and-copy**: FINAL_BEGIN, final page delta (which now includes the
   guest's self-spilled call stack and saved globals), GLOBALS, SERVICES,
   FINAL_END.
5. **Verify/ack**: the target recomputes the state hash; mismatch → ABORT(4)
   and the source rolls back. Match → RESUME_OK, then the target calls
   `__weave_resume` on its executor. Until RESUME_OK arrives, the source
   retains a complete valid checkpoint and can resume locally at any failure.

## State hash

`SHA-256` over, in order:

```
"WVSH"
u32 LE  number of memories
per memory (index order):  u64 LE byte length, then the full contents
u32 LE  number of control globals
per global (meta order):   u32 LE name length, name bytes, u32 LE value
u32 LE  number of services
per service (sorted by name): u32 LE name length, name bytes,
                              u64 LE blob length, blob bytes
```

Implemented independently in Rust (`weave-core`), JS (`weave.mjs`) and Go
(`weave-wazero`); every cross-runtime migration is an implicit conformance
test of all three.

## Node roles

A *node* (`weave serve`, `weave-node.mjs serve`, `weave-wazero serve`) is
symmetric: it runs at most one workload, accepts CTL commands, migrates out on
CTL_MIGRATE (the poll loop picks the request up while the workload runs), and
accepts incoming migrations when idle (busy nodes ABORT(9) new offers).
Chains (A→B→C…) fall out of the symmetry.

## Transports

Native nodes use raw TCP. The JS core (`js/weave.mjs`) is transport-agnostic —
it needs `{ readExact(n) -> Promise<Uint8Array>, write(bytes) -> Promise }`;
`weave-node.mjs` provides TCP for Node. In a browser, bridge a WebSocket:

```js
const ws = new WebSocket(url); ws.binaryType = "arraybuffer";
// queue incoming ArrayBuffers and serve readExact from the queue;
// write = ws.send — then pass that object to SourceMigration/acceptMigration.
```

(The browser side then needs a WS↔TCP relay or a WS-listening peer; the frame
bytes are identical.)
