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
  "services": ["env"],
  "imports": [{"module":"env","name":"emit","params":["i32"],"results":[]}],
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
`tail_call`, `memory64`, `threads`, `exceptions`, `gc`, `relaxed_simd`). Missing
features are not an assurance of support. Target receive limits do not promise
that sufficient host resources are currently available, or that external
services are semantically compatible. An unadvertised resource limit is null.

Advertisements are bounded to 32 KiB when constructing the shared Rust
control state so status retains room for a bounded active operation record.
The source-compatible Rust `serve` API advertises custom services/imports as
unknown; `serve_with_capabilities` accepts an explicit truthful advertisement.
Inspection does not call service factories, link imports, instantiate a guest,
or execute its original start function to discover capabilities.
