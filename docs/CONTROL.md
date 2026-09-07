# Structured node control, schema version 1

This is the inspectable control contract for serving nodes. It complements
the migration protocol; it is not an authentication layer, a durable job queue,
or a distributed ownership oracle. Keep raw node listeners on trusted networks
or behind an authenticated, authorized tunnel. Anyone who can reach a node can
inspect it or request migration to an address the node can reach.

## Framing and compatibility

Control uses the existing `[u8 type][u32 little-endian payload length][payload]`
framing on the node's TCP listener, with one request and one response per
connection. Type **23** (`CTL_REQUEST`) and type **24** (`CTL_RESPONSE`) carry
raw UTF-8 JSON, not a length-prefixed wire string. Each payload is capped at
65,536 bytes; receivers reject larger advertised lengths before allocating or
reading the payload. Oversized frames are disconnected, rather than drained.

Migration protocol version 2 and frame types 1–22 are unchanged. Legacy
`CTL_MIGRATE`/`CTL_STATUS`/`CTL_OK`/`CTL_ERR` frames 17–20 remain available;
legacy migration requests do not gain operation IDs or replay guarantees.
A client must not automatically fall back from an uncertain structured write
to a legacy migration request: that could start another operation.

JSON is an object with unique keys. Unknown request fields, unknown actions,
invalid JSON/UTF-8, and incorrectly typed values produce `INVALID_REQUEST`.
Unsupported numeric schema versions produce `UNSUPPORTED_SCHEMA`. Request
fields whose value is `null` are treated like omitted optional fields.

## Requests

Status requires only these fields:

```json
{"schema_version":1,"action":"status"}
```

The returned `node_epoch` identifies this process lifetime. The epoch is a
random 128-bit value encoded as 32 lowercase hexadecimal characters, not a
secret or credential. Use that exact epoch for a migration:

```json
{"schema_version":1,"action":"migrate","node_epoch":"0123456789abcdef0123456789abcdef","operation_id":"job-2026-09-07-001","target":"127.0.0.1:9002"}
```

Look up the same operation without starting work:

```json
{"schema_version":1,"action":"operation","node_epoch":"0123456789abcdef0123456789abcdef","operation_id":"job-2026-09-07-001"}
```

Both `migrate` and `operation` require `node_epoch` and `operation_id`.
`migrate` additionally requires `target`; `operation` rejects a non-null target.
Status rejects non-null epoch, operation ID, and target fields.

Operation IDs contain 1–128 ASCII letters, digits, `.`, `_`, or `-`. Targets
contain at most 4,096 UTF-8 bytes and must be `host:port` or `[IPv6]:port`, with
an ASCII decimal port from 1 through 65,535 and no whitespace/control
characters. Validation does not resolve DNS, connect, or reserve the target.

## Response envelope

Every structured response contains these fields; absent nested records are
JSON `null`, not omitted:

```json
{
  "schema_version": 1,
  "ok": true,
  "code": "ACCEPTED",
  "message": "migration accepted; query this operation ID for its outcome",
  "node_epoch": "0123456789abcdef0123456789abcdef",
  "lifecycle": "migrating",
  "ownership": "retained",
  "retry": "same_operation",
  "operation": {
    "operation_id": "job-2026-09-07-001",
    "target": "127.0.0.1:9002",
    "state": "accepted",
    "code": "ACCEPTED",
    "ownership": "retained",
    "retry": "same_operation",
    "message": "migration accepted; query this operation ID for its outcome"
  },
  "capabilities": null
}
```

Messages are explanatory, bounded to 2,048 UTF-8 bytes, and are not a stable
machine interface. Branch on version, code, state, ownership, and retry.
`ok: true` means the request was accepted/succeeded, not that a migration has
finished. In particular, `accepted` is nonterminal; `succeeded`, `failed`, and
`uncertain` are terminal operation states.

Node lifecycle is one of `idle`, `accepting`, `running`, `migrating`,
`completed`, `failed`, or `retired`. Top-level lifecycle and ownership describe
the node **now**. A retained operation record describes that operation's source
workload and may differ after the node receives another workload. Use the
operation record when interpreting an operation result.

### Ownership is source execution authority

| Value | Meaning |
| --- | --- |
| `retained` | The source retains execution authority. A pre-commit failure can leave it running locally. |
| `retired` | The source has irrevocably relinquished execution authority and must not resume this workload. |
| `none` | No active source workload exists, such as idle, completed, or trapped. |
| `unknown` | The observer cannot establish source execution authority; do not infer safe re-execution. |

Neither `retired` nor `MIGRATED` means the destination is *currently* running:
it may already have completed, trapped, or migrated onward. `MIGRATED` means
COMMIT was confirmed. `COMMIT_UNCERTAIN` means confirmation was lost; the
source is still retired. During the post-PREPARED COMMIT wait the operation
stays `accepted`, but its code becomes `COMMIT_PENDING` and source ownership
becomes `retired`. Adapters derive these facts from typed runtime events and
the irreversible retirement latch, never from English log messages.

### Stable result codes and retry guidance

| Code | Operation state, if present | Guidance |
| --- | --- | --- |
| `STATUS_OK` | Current active operation or null | Status read succeeded; inspect nested operation when present. |
| `ACCEPTED` | `accepted` | Query this ID; an exact same-ID replay is safe in this epoch. |
| `COMMIT_PENDING` | `accepted` | Source retired; await bounded observation or inspect ownership. Never start a replacement copy. |
| `MIGRATED` | `succeeded` | Handoff confirmed; do not repeat this operation. |
| `COMMIT_UNCERTAIN` | `uncertain` | Source retired; inspect destination/workload history before taking recovery action. |
| `MIGRATION_FAILED` | `failed` | Failed before handoff; source retains authority. A deliberate new attempt needs a new ID. |
| `WORKLOAD_COMPLETED` | `failed` | Workload completed before migration; no active source remains. |
| `WORKLOAD_TRAPPED` | `failed` | Workload trapped; no safe migration retry is inferred. |
| `INVALID_REQUEST` | None | Correct the request; no operation was accepted by this request. |
| `UNSUPPORTED_SCHEMA` | None | Use a supported schema; do not silently downgrade a possibly accepted write. |
| `NODE_EPOCH_MISMATCH` | None | Node lifetime changed or epoch is missing; inspect ownership before a new operation. |
| `OPERATION_NOT_FOUND` | None | ID was not accepted in this epoch. Exact original submission can be retried in this epoch. |
| `OPERATION_CONFLICT` | None | ID was already accepted with another target; never overwrite it. |
| `OPERATION_CAPACITY` | None | Ledger full; existing IDs remain queryable, new operations fail closed. |
| `NODE_BUSY` | None | Another migration/ingress is reserved; wait and reassess a deliberate new attempt. |
| `NO_ACTIVE_WORKLOAD` | None | There is no migratable active workload. |

The `retry` enum has four values:

- `never`: do not replay this as a new execution/migration attempt.
- `same_operation`: query or replay the exact original ID, epoch, and target.
- `new_operation`: only after observing the outcome, deliberately request a
  new attempt with a new ID. The old ID will always return the old result.
- `inspect_ownership`: no automatic execution retry; establish what happened.

Read-only status/lookup requests may be repeated with bounded deadlines.
`retry` describes operation recovery, not a ban on reading status again.

## Idempotency, retention, and client timeouts

A node atomically reserves the operation and the runtime migration request
before returning `ACCEPTED`. It does not wait for a guest poll, target
connection, or migration completion to reply. Structured and legacy callers
share the same single migration reservation.

Within one epoch, same ID plus the exact same target returns the retained
record without dispatching another migration. Same ID plus a different target
conflicts, including after failure. Node status can change between replies;
the operation identity and terminal outcome do not.

At most 256 accepted operation records are retained. Records are not evicted
or silently reused. Once full, new IDs fail with `OPERATION_CAPACITY`; old IDs
remain queryable. Invalid/rejected requests do not consume records. Restarting
a process creates a new epoch and loses this in-memory history. It is **not**
a safe way to retry an unknown handoff automatically.

A client deadline limits observation, not execution. Closing a connection or
timing out does not cancel an accepted migration. Preserve the original epoch,
ID, and target, then query that ID. If the epoch changed, do not assume that
the prior operation failed or that the source may run again. No control action
here offers force-resume, migration cancellation, or durable reconciliation.

## Capability advertisement

Status includes a `capabilities` object; other actions return it as `null`:

```json
{
  "runtime": "wasmtime",
  "adapter_version": "0.1.0",
  "migration_protocol": 2,
  "services": ["env.emit", "env.emit32", "env.emit64"],
  "imports": [
    {"module":"env","name":"emit","params":["i32","i64"],"results":[]},
    {"module":"env","name":"emit32","params":["i32"],"results":[]},
    {"module":"env","name":"emit64","params":["i64"],"results":[]}
  ],
  "features": ["simd", "multi_memory"],
  "limits": {
    "control_frame_bytes": 65536,
    "retained_operations": 256,
    "operation_id_bytes": 128,
    "memory_bytes": 1073741824,
    "module_bytes": 536870912
  }
}
```

The example is illustrative, not a universal built-in service set.
`adapter_version` is Weave's adapter version, not the embedded engine version.
Services and imports are the actual explicitly advertised embedding contract;
`null` means unknown/custom, whereas `[]` means explicitly none. Import type
names are Wasm types such as `i32`, `i64`, `f32`, `f64`, `v128`, `funcref`,
and `externref`. An import declaration includes its complete parameter/result
signature.

Features list only confidently known enabled runtime support, using the
preflight vocabulary (`multi_memory`, `simd`, `reference_types`, `bulk_memory`,
`multi_value`, `sign_extension`, `saturating_float_to_int`, `extended_const`,
`tail_call`, `memory64`, `threads`, `exceptions`, `gc`, `relaxed_simd`,
`function_references`). Missing
features are not an assurance of support. Target receive limits do not promise
that sufficient host resources are currently available, or that external
services are semantically compatible. An unadvertised resource limit is null.

Advertisements are bounded to 32 KiB when constructing the shared Rust
control state so status retains room for a bounded active operation record.
The source-compatible Rust `serve` API advertises custom services/imports as
unknown; `serve_with_capabilities` accepts an explicit truthful advertisement.
Inspection does not call service factories, link imports, instantiate a guest,
or execute its original start function to discover capabilities.

## Using the weave CLI

The central Rust `weave` binary controls Wasmtime, Node, wazero, and WAMR TCP
nodes with the same commands. Their existing adapter-specific legacy clients
continue to work. This is not a browser UI, hosted control service, agent SDK,
or authenticated rendezvous integration.

```sh
weave inspect guests/counter.wat --invoke run --arg 5000000
weave inspect app.woven.wasm --pre-woven --node 127.0.0.1:9002 --json
weave status --node 127.0.0.1:9001 --json
```

Save the status `node_epoch` and a unique operation ID in your application's
own durable state before submission. The following example uses a placeholder
epoch which must be replaced with the actual discovered value:

```sh
weave migrate --node 127.0.0.1:9001 --to 127.0.0.1:9002 \
  --operation-id job-001 --node-epoch ACTUAL_EPOCH --timeout-ms 10000 --json
weave operation --node 127.0.0.1:9001 \
  --operation-id job-001 --node-epoch ACTUAL_EPOCH --wait --timeout-ms 10000 --json
```

An exact replay uses the original ID, epoch, and target. Do not discover a new
epoch and quietly attach it to an old ID after a restart. A deliberate retry
after `MIGRATION_FAILED` uses a **new** ID: replaying the old one returns its
retained failure. `--operation-id` therefore requires `--node-epoch`.
Interactive migrations may omit both; the CLI generates a random ID and prints
the identity to stderr before submitting. JSON output includes the identity in
the result or ambiguous-delivery error. If the CLI itself is killed before
returning JSON, only a caller-persisted ID/epoch can reliably recover the query.

`migrate` waits by default, with a 120,000 ms total deadline. `--no-wait` returns
after acceptance. `operation` performs one lookup unless `--wait` is supplied.
Status, operation, and target discovery during inspection default to 5,000 ms.
`--timeout-ms` accepts 1–3,600,000 ms. One control deadline covers DNS,
connecting, every read/write, and polling—not a fresh timeout per byte or poll.
The inspection timeout bounds target discovery, not local transformation or
compilation. No control timeout cancels the accepted operation.

All commands have `--help`. Unknown/duplicate flags, missing values, unsupported
flag combinations, and invalid numeric options are errors. `--arg` is
repeatable and accepts negative numbers. `--` ends option parsing. Transform
options cannot be mixed with `--pre-woven`.

### Output and exit codes

`inspect`, `status`, `migrate`, and `operation` support `--json`: stdout is one
JSON value, with `schema_version`, `ok`, `code`, and `message`. Successful
control replies use the response envelope above. Local CLI errors use those
common fields and `retry`; ambiguous initial delivery also includes the
submitted `node_epoch`, `operation_id`, `target`, and `ownership: "unknown"`.
`inspect` returns a preflight report rather than a node response. Other commands
retain guest progress output and do not accept `--json`.

| Exit | Meaning |
| --- | --- |
| 0 | Successful read/check or accepted/successful operation; inspect `operation.state` to distinguish acceptance from completion. |
| 1 | A legacy/general command failure (`COMMAND_FAILED`); transform diagnostics and exit status remain compatible with corpus tooling. |
| 2 | `USAGE_ERROR`: invalid command-line input. |
| 3 | `MODULE_INVALID` or `PREFLIGHT_BLOCKED`: incompatible or unknown preflight facts; inspect findings. |
| 4 | A structured control failure, including a retained pre-commit migration failure. |
| 5 | `DELIVERY_UNCERTAIN`, `OBSERVATION_UNCERTAIN`, `COMMIT_UNCERTAIN`, or `NODE_EPOCH_MISMATCH`; no safe automatic re-execution is inferred. |
| 6 | `WAIT_TIMEOUT`: accepted work may still be running; query the same identity. |

`DELIVERY_UNCERTAIN` means the first write/reply could not be established.
`OBSERVATION_UNCERTAIN` means a later lookup failed after acceptance was
observed. That result preserves the last observed operation and known source
retirement, but is not a fresh node status. `WAIT_TIMEOUT` likewise preserves
the last record; nested `accepted` does not prove the operation is still
pending when the report is read. These client outcomes never trigger a fresh
ID or automatic legacy fallback.

### What preflight proves—and does not

`inspect MODULE` accepts raw `.wasm`/`.wat`, or a transformed module with
`--pre-woven`. It validates the transformed module's ABI, actual function
imports against metadata, and optional `--invoke`/`--arg` call. It lists entry
signatures, imports (including unsupported non-function imports), transformed
exports, module hash/size, features, and initial memory requirements. It never
instantiates, calls start/constructors, links services, or runs guest code.
Consequently a module that later traps or loops forever can pass static checks.

The `weave_cli_builtins` profile requires exact import signatures supplied by
the central CLI and the exact three-service snapshot set—extra destination
services are also incompatible. Imported memories/tables/globals are not
provided by that CLI and are explicit blockers, although custom library hosts
can support them. Unknown capability facts are blockers, not optimistic
successes. `--node` compares the same profile with a live advertisement and
includes its epoch/lifecycle so callers can assess availability separately.
No checks reserve an idle destination, prove host-service semantics, bound
future memory growth, or promise sufficient real-time host capacity.

### Legacy and one-shot nodes

`weave status --legacy --node ADDR` and
`weave migrate --legacy --node ADDR --to ADDR` explicitly use frames 17–20.
Legacy mode cannot combine with JSON, operation identity, or asynchronous
control. It is also how the existing one-shot `--exit-on-done` conformance
flows retain their synchronous completion reply.

Use persistent nodes (omit `--exit-on-done`) for structured operation polling.
An exit-on-done source can exit after handoff before a follow-up lookup reaches
it. That is reported as observation uncertainty, even if the handoff actually
succeeded. A shutdown grace period would only narrow this race, not supply
durability; this interface deliberately does not claim that guarantee.

## Reproducing the control checks

Run `.github/ci/control-interface.sh` with the documented Node/Go/Rust/WAMR
toolchains. It runs adversarial control-client peers and the actual four-runtime
CLI cycle, preserving commands, responses, and node logs in an explicitly
selected `WEAVE_CI_ARTIFACT_DIR`. Rust CLI binary tests additionally exercise
side-effect-free inspection, argument failures before file writes, malformed
import contracts, and negative arguments. See the CI guide for the broader
golden-event, browser, package, corpus, and library suites.
