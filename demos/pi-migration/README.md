# π, in transit

A single-file, real WebAssembly live-migration demonstration: one dashboard,
six compute tabs, and one continuing π calculation. The dashboard observes and
directs; it does not calculate the displayed approximation.

## Deploy and present

Upload **`dist/index.html`** to a static HTTPS host. That is the entire deployed
application: JavaScript, Wasm, styles, fonts (system fonts), and the license are
self-contained. No build step on the host, npm install, account, backend,
signaling server, STUN, TURN, or special cross-origin-isolation headers are
required for the default **Same-browser** mode. The calculation and handoffs
continue without networking once the seven pages have loaded.

For an offline local presentation, a static localhost server also works. If
Python 3 is installed, run this from the repository root and open
`http://localhost:8080/index.html`:

```sh
python3 -m http.server 8080 --bind 127.0.0.1 --directory demos/pi-migration/dist
```

This is only a static file server, not an application backend or relay.

Open the direct page URL in a current desktop Chrome browser, not an embedded
hosting preview. All tabs must share the same origin and browser profile/storage
partition. Serve the page over HTTPS or localhost; double-clicking a `file://`
file is not a supported deployment. A host-injected Content Security Policy
must allow this page's inline scripts/import map, `data:` JavaScript modules,
and WebAssembly compilation.
Do not weaken a site's existing security policy without evaluating it; use a
dedicated demo site if necessary.

For a presentation:

1. Leave **Same-browser · no setup** selected. Click **Open 6 compute tabs**.
   This creates six compute tabs **in addition to the dashboard**.
2. Most browsers block opening all six in one gesture. Allow pop-ups for the
   demo site, or click **Open next tab** separately for each remaining tab.
   Return to the original dashboard and wait for **6 / 6 connected**.
3. Click **Start calculating**. The approximation and evaluated-term count now
   come from real Wasm. Only tab 1 initially runs the program.
4. Click **Move to the next tab**, a destination's **Move here**, or **Auto tour**.
   Watch the active card move, the old card's count freeze, the approximation
   continue, and consecutive host progress-event numbers appear in the log.
   Use **View tab** to inspect an actual compute tab, then return to the dashboard.
   The dashboard counts all confirmed handoffs; a compute tab's handoff count
   covers the moves it initiated. Its approximation/term count is its own local
   observation and stays frozen while that tab is retired.
5. Use the GitHub CTA to explain the wider cross-runtime project. **Pause tour**
   stops automatic movement but keeps computing; **Stop demo** ends the work.

**Watch the browser's tab bar, not just the dashboard.** The current compute
owner has a bright lime-green play favicon and a title beginning **RUNNING π**.
During transfer, orange arrow icons and **SENDING / RECEIVING / HANDOFF** titles
identify the participating tabs. The old source switches to a grey numbered
icon and **MOVED**; idle tabs say **READY**. The dashboard remains **CONTROL**,
with a separate blue-grey icon and the current destination in its title.

Icons/titles follow real runtime events immediately, without an animation
timer or waiting for a hidden page's normal render timer. A genuinely frozen
owner says **PAUSED π**; merely switching away from a tab does not mark its
computation paused. An uncertain outcome is marked **UNCONFIRMED**, not running.
Browser chrome can take a moment to paint metadata changes, and very brief
transfer phases may finish before their orange icon is visible.

To repeat, close the six compute tabs and reopen the original URL **without its
`#room=…` fragment**. A new room is intentionally a new calculation. Do not
refresh/duplicate the controller midway through a session: the original
controller identity is pinned, and a replacement cannot silently take over.

Keep the dashboard visible during a talk. Background-tab throttling can slow
the calculation; tab discard, computer sleep, or closing the owner can suspend
or destroy it. Missing or ambiguous ownership stops the tour rather than
starting a second copy. After a failed pre-commit move, wait for the target to
be ready and explicitly retry. After an uncertain result, inspect the tabs and
download the session log; do not assume a timeout means nothing happened.
Operation replay records are bounded to 512 commands per compute tab. A very
long automatic tour eventually asks for a fresh room; explicit Stop remains
available even when that limit is reached.

## What is real, and what is new

`pi.wat` evaluates the paired Leibniz series
`π = Σ 8 / ((4k + 1)(4k + 3))` using compensated `f64` summation. Its counter,
sum, and compensation live in a nested Wasm call frame. Every 32,768 original
series terms it calls `demo.progress(i64, f64)`; JavaScript only records and
visualizes that observation. `Math.PI` is used solely as the comparison
reference. This is a long-running computation, **not arbitrary-precision digit
generation**; a deliberate 2^52-term bound prevents claiming exact integer
arithmetic indefinitely.

The build transforms the guest with the existing Weave CLI (`--period 64
--stack-pages 2`). The existing `Weave`, `SourceMigration`, and
`acceptMigration` APIs move the genuine continuation, memory, control globals,
and `demo.pi.progress.v1` host-service state. A source irreversibly retires
when ownership is transferred. A target restores the entry instead of calling
the π function from the beginning. Tests compare exact floating-point bits
against uninterrupted execution, as well as consecutive term/event boundaries.
The guest's first unwind grows its memory from 128 KiB to 256 KiB for lazy
continuation storage; subsequent tested restores stay at 256 KiB.

The demo uses the public driver's yield callback to await a cancellable
MessageChannel task at each safe point, avoiding an uninterrupted chain of
timers in long-hidden tabs. This does not override browser CPU budgeting,
suspension, or discard, and never manufactures progress observations.

The existing core, browser transport, and WebRTC session libraries are **not
modified**. The demo adds its UI/controller, Pi host-service implementation,
and a small `TabByteStream` adapter to the public transport-agnostic API. That
adapter carries actual protocol bytes over a dedicated BroadcastChannel per
operation, with peer binding, packet acknowledgements, bounded buffers, and
timeouts. Another BroadcastChannel handles discovery/control. This is not
WebRTC disguised by a fallback: the selected transport is always labeled,
locked once tabs open, and never silently switched during a handoff.

`dist/build-manifest.json` records the HTML, guest, and original source hashes.
Embedding only rewrites static module specifiers so the original libraries can
load from the single file. `dist/pi.woven.wasm` and the manifest are useful for
inspection but **are not deployment dependencies**.

## Optional WebRTC and cross-machine use

Select **WebRTC · network dependent** before opening any tabs to use the
existing reliable ordered DataChannel transport and WebRTC session library.
This mode still uses local BroadcastChannel signaling and configures
`iceServers: []`: it does **not** connect separate devices. Local ICE connectivity
must work. Normal Chrome on the development machine failed to resolve its
`.local` mDNS ICE candidates in both headed and headless tests. A separate test
with literal-ICE browser flags verified the actual WebRTC handoff path; those
flags are diagnostic, **not a requirement for the default presentation mode**.

The repository's other examples demonstrate server/runtime and browser/native
migrations. See [browser ↔ browser WebRTC](../browser-webrtc/README.md),
[browser ↔ native sidecar](../browser-sidecar/README.md), and
[Chrome ↔ WAMR](../browser-wamr/README.md). Across devices you need reachable,
appropriately secured signaling and a suitable transport/bridge; some networks
need your own authorized STUN/TURN infrastructure. The default local adapter
cannot provide that reachability.

“Bare-metal” here means compatible Wasm runtimes on those hosts, not migrating
arbitrary OS processes. This particular Pi guest requires `demo.progress` and
the matching `demo.pi.progress.v1` service on every host: it cannot simply be
sent to an unmodified native CLI with unrelated built-in host imports.

## Build and test

From the repository root, with Rust and Node 22+ installed:

```sh
cargo build --locked --release -p weave-cli
node demos/pi-migration/build.mjs
node --test demos/pi-migration/*.test.mjs
node demos/pi-migration/e2e.mjs --artifacts /tmp/weave-pi-check
node demos/pi-migration/e2e.mjs --headed --artifacts /tmp/weave-pi-visible
node demos/pi-migration/e2e.mjs --soak-ms 360000 --artifacts /tmp/weave-pi-soak
```

The guest/runtime tests freshly transform `pi.wat` when a CLI exists. On a
JavaScript-only checkout they use `pi-fixture.mjs`, guarded by source/options
and Wasm hashes, without skipping the integration tests. Set
`WEAVE_PI_USE_FIXTURE=1` to exercise that fallback deliberately. After changing
the guest, regenerate it with `node demos/pi-migration/build.mjs
--update-test-fixture`. An explicitly configured but broken `WEAVE_BIN` is a
test failure, not permission to silently use the fixture.

`WEAVE_BIN` can select another built CLI. `CHROME_BIN` or `--chrome` selects the
Chrome executable. The browser harness uses Node's built-in DevTools WebSocket
client, so there is no Playwright/Puppeteer download. It launches disposable
browser profiles, clicks actual page controls, serves only the HTML (all other
HTTP paths return 404), and records screenshots, requests, browser version,
artifact SHA-256, and exact continuation boundaries. It does not disable
background timer throttling. Default local tests put all seven loaded pages
into actual browser offline mode before migrating.

The optional network-path check is separate and explicitly labeled:

```sh
node demos/pi-migration/e2e.mjs --transport webrtc --literal-ice --artifacts /tmp/weave-pi-rtc
```

Unit tests cover numerical correctness, nested continuation restores, six-hop
protocol migration, cancellation, duplicate controllers/nodes, command races,
lost replies and commit confirmation, pre-commit failure/retry, retired-source
safety, real BroadcastChannels, malformed transport packets, timeouts, and
allocation/queue limits. The full browser run also exercises popup blocking,
burst clicks, manual and automatic tours, suspended-target recovery, closed
owner safety, mobile layout, license/log controls, and lack of external assets.
See [TESTING.md](TESTING.md) for the recorded qualification results.
