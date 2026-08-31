# Chrome ↔ WAMR live-migration demo

This demo exercises the same Weave v2 byte stream in both directions:

```text
Chrome WebAssembly API ⇄ WebSocket relay ⇄ raw TCP ⇄ WAMR
```

The relay does not interpret, reframe, or terminate Weave messages. It only
converts the browser's WebSocket transport to the TCP transport used by the
native nodes. The browser can therefore be either the migration source or the
migration target.

The byte-transparent, backpressured bridge is the reusable
`@weave-net/ws-tcp-gateway` package. This demo file supplies the intentionally
separate WebSocket handshake, routes, target allowlist, origin/token policy,
TCP dialing, and browser/native pairing.

## Prerequisites

- Chrome (or another current browser with BigInt-enabled WebAssembly)
- Node.js 18 or newer, used only for the dependency-free relay/static server
- Rust and CMake
- `wasm-micro-runtime` checked out at the tag named in `wamr/WAMR_VERSION`

Build the WAMR host adapter and the Weave CLI from the repository root:

```sh
git clone --depth 1 --branch WAMR-2.4.4 \
  https://github.com/bytecodealliance/wasm-micro-runtime.git /tmp/weave-wamr-runtime

WAMR_ROOT=/tmp/weave-wamr-runtime \
  cargo build --manifest-path wamr/Cargo.toml
cargo build -p weave-cli
```

The WAMR executable used below is:

```sh
WAMR=wamr/target/debug/weave-wamr
WEAVE=target/debug/weave
```

Transform the included counter. A short poll period makes the UI responsive
and gives pre-copy plenty of opportunities to run:

```sh
$WEAVE transform guests/counter.wat \
  -o demos/browser-wamr/counter.woven.wasm \
  --period 256
```

`counter.woven.wasm` is generated and intentionally ignored by git. You may
instead choose any already-woven `.wasm` file in the page.

## Start the two endpoints

Terminal 1 — start an idle WAMR node on `7777`:

```sh
$WAMR serve --listen 127.0.0.1:7777
```

Terminal 2 — start the demo relay:

```sh
node demos/browser-wamr/relay.mjs \
  --http 127.0.0.1:8787 \
  --ingress 127.0.0.1:7778 \
  --target wamr=127.0.0.1:7777
```

Open <http://127.0.0.1:8787/> in Chrome.

The two relay paths have deliberately different roles:

| Direction | Browser path | Native endpoint |
|---|---|---|
| Chrome → WAMR | `/v1/connect/wamr` dials the named allowlisted target | WAMR listens on `127.0.0.1:7777` |
| WAMR → Chrome | `/v1/accept` waits to be paired | WAMR dials relay ingress `127.0.0.1:7778` |

The `/v1/` prefix versions the relay's HTTP routes; the carried migration
protocol and WebSocket subprotocol are Weave v2 (`weave.v2`).

## Demo A: Chrome → WAMR

1. Click **Load generated counter**.
2. Click **Start workload in Chrome**.
3. While it is running, click **Migrate active workload**.
4. Watch the event log reach `migration committed`; WAMR reports that it
   received the workload and continues at the captured instruction.

The page sends the module on a target cache miss, performs iterative pre-copy,
unwinds the guest, and sends the final dirty pages/globals/service state. When
WAMR returns `PREPARED`, the browser crosses the irreversible ownership
boundary, sends `COMMIT`, and normally receives `COMMIT_OK`. A lost commit
acknowledgement is reported as uncertain but the browser never rewinds its
source copy, preventing two runtimes from executing the workload.

For this interactive demo, cold module upload/compilation begins from a guest
yield and contributes to migration pause time. Pre-stage the same woven module
on production targets when low downtime matters; final-delta transfer and the
full-state verification pass remain workload-size/dirty-rate dependent.

## Demo B: WAMR → Chrome → WAMR

Start WAMR with the workload (restart the idle node first if needed):

```sh
$WAMR serve --listen 127.0.0.1:7777 \
  --module demos/browser-wamr/counter.woven.wasm \
  --invoke run --arg 250000000
```

1. In Chrome, click **Arm browser target**. The page now waits on
   `/v1/accept`.
2. Ask WAMR to migrate to the relay's TCP ingress:

   ```sh
   $WAMR migrate --node 127.0.0.1:7777 --to 127.0.0.1:7778
   ```

3. The page verifies the complete state hash and resumes the workload in
   Chrome.
4. The WAMR node is idle after the successful handoff. Click **Migrate active
   workload** in Chrome to send the same running workload back to WAMR.

Use a larger counter argument if the workload completes before you can move
it. The current state can also be inspected with:

```sh
$WAMR status --node 127.0.0.1:7777
```

## What “arbitrary workload” means

The transport and migration engine do not special-case the counter. A module
can move through this path when all of the following hold:

- it was processed by `weave transform` and stays within Weave's documented
  core-Wasm support boundary;
- every imported host function exists in both hosts; and
- stateful host functions expose the same portable snapshot format on both
  hosts.

The demo page and WAMR adapter both provide `env.emit`, `env.emit32`, and
`env.emit64`, including their identical 16-byte service snapshots. A module
with application-specific imports needs corresponding browser services in
`app.mjs` and WAMR services in the host adapter. Opaque browser objects, open
sockets, DOM nodes, filesystem descriptors, and arbitrary WASI process state
cannot be inferred or serialized automatically.

Chrome may throttle timers in a background tab, which slows cooperative
polling and pre-copy but does not alter the captured state. Closing the tab is
equivalent to losing the source machine; move important work to WAMR first.

## Relay safety

Outbound TCP destinations are aliases configured with `--target`; URL callers
cannot supply arbitrary hostnames or ports. By default the HTTP listener is
loopback-only, browser Origins must match the configured listener (not the
request's client-controlled `Host` header), receive messages are bounded,
WebSocket frames are validated, and backpressure is propagated in both
directions.

For anything beyond a local demo:

- expose `wss://` through a TLS reverse proxy;
- pass a high-entropy `--token` to the relay and enter it in the page;
- pass one or more exact `--allow-origin https://example.test` values;
- keep `--target` entries narrowly allowlisted; and
- firewall the unauthenticated TCP ingress to trusted WAMR sources.

The relay refuses a non-loopback HTTP bind without `--token`. The native
Weave v2 TCP protocol itself does not provide transport authentication.

## Focused tests

The tests use only Node core modules:

```sh
node --test js/weave.test.mjs demos/browser-wamr/*.test.mjs
```

They cover byte-stream coalescing/splitting and failure handling in the
browser adapter, protocol-v2 prepare/commit failure cuts, target commit
gating, plus real-socket WebSocket↔TCP forwarding in both relay directions.

## Optional real-browser smoke test

`e2e-smoke.mjs` launches an isolated headless Chrome profile, the relay, and
an idle `weave-wamr` node. It drives the actual page through Chrome DevTools
Protocol and performs this chain:

```text
Chrome → WAMR → Chrome → WAMR
```

At every handoff it checks the visible UI state, migration log, target runtime
state, and the counter's first newly appended `EMIT` index. An exact 50,000
increment across each runtime boundary rejects a skipped or repeated boundary
counter event. All listeners, Chrome processes, WAMR processes, and the
temporary browser profile are cleaned up on success, failure, or
`SIGINT`/`SIGTERM`.

The smoke script uses only Node core APIs. It needs Node 22 or newer for the
built-in WebSocket client, Chrome/Chromium, the built WAMR executable, and the
generated `counter.woven.wasm` from the preparation steps above:

```sh
node demos/browser-wamr/e2e-smoke.mjs
```

Missing prerequisites produce a successful `SKIP`, making the command safe
for developer machines without Chrome or WAMR. Make a skip fail in CI with:

```sh
WEAVE_SMOKE_REQUIRED=1 node demos/browser-wamr/e2e-smoke.mjs
```

Paths can be overridden with `CHROME_BIN`, `WAMR_BIN`, and
`WEAVE_DEMO_WASM`, or with the corresponding `--chrome`, `--wamr`, and
`--wasm` flags. Run `node demos/browser-wamr/e2e-smoke.mjs --help` for timeout,
iteration-count, and profile-retention options.
