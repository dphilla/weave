# Safe library lifecycle

The JavaScript `WeaveInstance` and Rust/Wasmtime `WeaveInstance` enforce the
guest ABI's execution lifecycle at their public driving and restore boundaries.
You do not need to copy a demo's button guards to prevent overlapping library
calls. This guide covers embedding, not a new CLI, agent tool, package format,
or external-resource ownership service.

## Execution and ownership

| Instance condition | Allowed next execution operation |
| --- | --- |
| Fresh, initialized | Start an exported entry |
| Paused with a saved continuation | Resume; capture a checkpoint |
| Entry completed | Start another exported entry, not resume the old one |
| Uninitialized restore target | Apply a complete checkpoint; do not resume yet |
| Incoming migration staged | No guest execution until COMMIT |
| Source final copy in progress | No concurrent resume or second final copy |
| Source retired after PREPARED | No further execution, including after uncertain COMMIT |
| Guest trap or partially applied restore failed | Discard the instance |

Invalid lifecycle calls fail before executing the guest or applying a restore.
Bad entry names, arity, and argument types are checked before starting a call.
A rejected preflight does not destroy a ready instance or a held continuation.
Failures after guest execution or mutating restore begins are different: the
instance becomes failed because its state may already have changed.

Checkpointing copies state; it does not transfer ownership or undo effects.
When restoring a saved checkpoint, the application must choose which copy may
run. Do not resume both copies against externally visible services. Use the live
migration protocol for its PREPARED/COMMIT ownership transfer; durable recovery
across process crashes still requires application coordination/fencing.

## JavaScript

Import the existing browser-clean `js/weave.mjs` entry point. `instantiate()`
reserves the instance before awaiting compilation, runs no guest startup, and
may be retried if instantiation fails. After success, choose exactly one path:

```js
// Fresh workload:
const source = new WeaveInstance(wovenBytes, makeServices(), { yieldMs: 25 });
await source.instantiate();
source.init();
const outcome = await source.drive("run", [1000000], () => "hold");

if (outcome.status === "held") {
  const snapshot = source.checkpoint();

  // Restore into a different instance with NEW, isolated service objects.
  const target = new WeaveInstance(wovenBytes, makeServices());
  await target.instantiate();
  target.restore(snapshot); // Do not call init() on this path.
  // The application chooses target ownership and stops using source here.
  const result = await target.drive(null, null);
}
```

This is an embedding recipe: supply your woven module's entry/arguments and
its imports through `makeServices`. A short entry can return `done` without
ever yielding, so always inspect the outcome before checkpointing.

`lifecycle` is a read-only host-side view: `created`, `instantiating`,
`uninitialized`, `initializing`, `ready`, `running`, `paused`, `completed`,
`staged`, `finalizing`, `retired`, or `failed`. During an awaited `onYield`
callback the guest is `paused`, but the existing driver still owns it. Another
`drive`, `init`, or `restore` is rejected. Read-only `checkpoint()` is allowed
inside that callback; return `hold` if the driver should stop there.

`drive(entry, args, onYield?, { signal }?)` returns
`{ status: "done", results }` or `{ status: "held" }`. A null entry means
resume and takes null or empty arguments. `onYield` receives the instance
directly, then `{ signal }` as a second argument, and must return `continue`
or `hold` (possibly asynchronously). It does not receive `{ instance }` as its
first argument. Throwing/rejecting from the callback leaves the actual paused
continuation intact, unlike a guest trap.

The default driver yields a real event-loop turn at every unwind, even with
no callback or an immediately resolved callback. It therefore services timers
and control I/O without a caller-supplied `setTimeout`/`setImmediate`. `yieldMs`
must be finite and non-negative. Zero requests an unwind at each available
host poll; it does not prevent the continuation from advancing.

### Cooperative cancellation

```js
const controller = new AbortController();
const running = instance.drive("run", [1000000], undefined, {
  signal: controller.signal,
});
controller.abort(); // Normally called by another task, timer, or UI handler.
try {
  await running;
} catch (error) {
  if (error.name !== "AbortError") throw error;
  // If execution started, instance is paused and can be checkpointed/resumed.
}
```

A pre-aborted signal prevents entry execution and leaves the previous state
unchanged. Once execution starts, cancellation is observed at a safe unwind
boundary. It throws an `AbortError` with code `WEAVE_ABORTED`; it does not
restart the entry, erase its state, or undo host effects. Resume with a new
signal or no signal. If the guest completes before a cancellation can be
observed at an unwind, normal completion wins.

Cancellation is cooperative, not a way to interrupt synchronous guest startup,
a blocking host import, or an arbitrary never-settling `onYield` promise. The
callback receives the signal so it can bound/cancel its own I/O. The driver
retains ownership until that callback settles; releasing it earlier would let
late callback work race a resumed guest. Poll-period granularity still applies.

Lifecycle errors have code `WEAVE_INVALID_STATE`. Invalid API arguments use
`TypeError`/`RangeError`; guest and application errors preserve their cause.
This is not the separately proposed versioned control/CLI error protocol.

### Checkpoints and services

`checkpoint()` returns an owned in-memory object:

```text
moduleHash: Uint8Array
memories: Uint8Array[]
globals: [name, signedI32][]
services: [name, Uint8Array][]
```

Memory and service bytes are copied, not views into the live instance. This is
not a new on-disk encoding and must not be treated as JSON without an explicit
byte encoding. `restore(snapshot)` checks identity, memory sizes, exact control
and service contracts, and suspended-entry state before applying data. It uses
private copies of the supplied bytes. A failure during memory growth or
service restoration poisons the target; retry with a new instance and fresh
services, not the partially restored target.

Guest host imports, service `snapshot()`, and `restore(bytes)` are synchronous
operations. A Promise-returning host import is rejected, its rejection is
observed, and the executing instance fails; it cannot silently report guest
completion while host work is still pending. This does not undo any effects
already performed by an invalid asynchronous implementation.
Promise-returning restores are rejected and their rejections observed; an
unawaited restore must never be followed by PREPARED. Services must stage local
state without external publication. `weave.poll` is reserved, and two services
cannot silently replace each other's import with the same module/name.
The constructor owns a copy of input module bytes (including Node Buffers)
and of the supplied service-map membership. Service implementations themselves
remain application-owned and must follow their documented contract.

### Live migration

`SourceMigration` reserves one migration per `WeaveInstance`. Call `handshake`
once, then `precopyStep` as needed while the guest is paused in `onYield`.
Return `hold` and await the driver's result before calling `finish`.
Handshake, precopy, and finish operations cannot overlap. `finish` reserves
final-copy ownership before its first I/O await. Before PREPARED, a failure
releases the source as paused; resume it locally after closing the failed
transport. After valid PREPARED, the source is irrevocably retired before any
COMMIT write. Both confirmed and uncertain outcomes keep it retired.

`abort()` abandons an idle pre-commit migration and closes its transport when
that transport provides `close`. It cannot interrupt an in-flight operation
or revive a retired source. Discard failed migration/transport objects.
`acceptMigration()` keeps the target staged throughout receipt and service
restoration, and makes it resumable only after valid COMMIT. Lost COMMIT_OK
does not revoke target ownership.

## Rust / Wasmtime

`WeaveInstance::new_fresh` returns `InstanceState::Ready` after initialization.
`new_restored` returns `RestoreTarget` without startup; successful
`restore(&snapshot)` makes it `Paused`. Use `state()` to inspect the host-side
lifecycle. `call_entry` is allowed from `Ready`/`Completed`; `resume` and
`checkpoint` require `Paused`. Restoring into a fresh-initialized, already
restored, running, completed, failed, or retired instance is rejected.

The Rust API remains synchronous. Move execution to an application-owned
thread when your application needs an asynchronous event loop. Obtain
`cancellation_handle()` before starting; another thread can call `cancel()`.
The next instrumented poll consumes the request and returns
`WorkResult::Unwound`, leaving a checkpointable/resumable instance. The handle
is reusable for later requests. Cancellation does not interrupt blocking
imports/network calls or revert externally visible effects.

The Wasmtime migration paths attach an irreversible retirement latch to the
protocol source, including the lower-level `set_poller` / `take_poller` path.
Valid PREPARED sets it before COMMIT I/O; the source's public execution APIs
remain disabled even if acknowledgement is lost. Incoming wire state becomes
resumable only after `accept_conn` completes COMMIT processing.

## Low-level boundaries

Raw Wasm exports, memory/global setters, mutable host contexts, metadata,
service objects, underscore-prefixed JavaScript internals, and duck-typed
migration adapters remain advanced embedding surfaces, not a sandbox against
malicious host code. Do not mutate them behind a running driver. Writing a
control global alone does not change the guarded instance's lifecycle.
Custom raw protocol adapters must enforce their own suspension and ownership
rules. Arbitrary host-process state, WASI resources, durable exactly-once
failover, and resource fencing are not supplied by these guards.

## Verification

The normal JavaScript lane includes real transformed-guest lifecycle,
checkpoint/restore, cancellation, and migration ownership regressions. Its
bounded child processes test timer starvation without hanging the test runner.
The original WAT and recorded bytes are in `js/test-support`; set
`WEAVE_LIFECYCLE_FIXTURE` to freshly transformed bytes to repeat the same tests
against the current compiler. Rust library regressions are in
`crates/weave-wasmtime/tests/library_lifecycle.rs`. The full runtime matrix and
real-browser demos exercise the shared library changes through their normal
public paths.
