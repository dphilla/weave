# Pi demo qualification — 2026-09-07

The shipped artifact is `dist/index.html`. Only that file is served in browser
tests; every other HTTP path returns 404. The ZIP contains only `index.html`.
The build manifest records original library source hashes, and a regression
test compares every embedded module against its current source with only
static import specifiers rewritten. No existing migration/transport/session
library was patched for this demo.

## Browser-tab visibility update

The current HTML is **339,956 bytes**, SHA-256
`a925e7f4095c6c617500f268d082d7046658faf703dc6778f3963989216cc7a5`.
The ZIP is rebuilt from this same file. This update changes only presentation,
packaging and tests, not the runtime, migration libraries, guest, or scheduler.

- The actual owner gets a lime play favicon and a leading **RUNNING π** title.
- Transfer, ready, moved, uncertain, paused and stopped states have distinct
  SVGs/title prefixes. The dashboard is always visibly **CONTROL**.
- Indicators update synchronously from observed runtime/lifecycle events;
  repeated progress never rewrites the icon or adds a network dependency.
- Real freeze is distinguished from merely being a hidden/background tab.
- Stop is labeled **STOP REQUESTED** until acknowledgement, then **STOPPED**;
  a failed/unconfirmed stop says **CHECK TABS**.
- Six new tests cover the state/ownership matrix, numbered identity, SVG
  injection rejection, retirement, uncertainty, freeze/thaw, controller labels,
  synchronous updates and lack of redundant DOM writes.
- Complete JavaScript regression: **398 passed**, no failures/skips, plus all
  five package installation/import checks. Demo-only suite: **60 passed**.

The final HTML passed a full stock headless Chrome run and a stock visible
Chrome quick replay (Chrome 152.0.7977.82); both exited 0. The tests read actual
document and Chrome target titles, decode/check changed SVG icons, and follow
all six background tabs without focusing them to update metadata. Each move
left exactly one settled **RUNNING π** tab and changed the previous owner to
**MOVED**. The full run additionally checked Auto tour, a genuinely frozen
owner's **PAUSED π** badge, return to **RUNNING π** on thaw, and owner closure.
Both observed **STOP REQUESTED** while a tab still ran and **STOPPED** only after
all six stopped. No test-owned browser/server processes remain.

Evidence:

- `/private/tmp/weave-pi-icons-final-headless.399rnG` — full final-artifact run.
- `/private/tmp/weave-pi-icons-final-headed-replay.iS7tN9` — visible quick replay.
- `/private/tmp/weave-pi-tab-indicator-final-regression.log` — 398 tests + package smoke.

Page screenshots do not include browser chrome. macOS denied the attempted
capture of the disposable Chrome window, so the tab-bar checks rely on actual
Chrome target metadata and favicon SVG contents, not a claimed OS screenshot.
One headed attempt failed because the test mouse click raced smooth scrolling;
the harness now waits for scrolling, hit-tests the intended button, and requires
a trusted click event. No application command is invoked as a test bypass.

Review follow-up (pre-existing demo metadata, not changed here): a pending
migration can retain the previous operation's round/commit statistics in its
downloaded record. Execution and these indicators use the current operation
ID/status and ownership, not those stale statistics. A separate cleanup should
reset optional statistics when a new operation ID begins.

## Previous compute/migration artifact

The remaining sections record the earlier full compute/migration qualification
before the tab-bar presentation update above. Its 370-second soak is historical
evidence for the unchanged runtime/scheduler, not a claim that the newer HTML
was subjected to another six-minute soak.

- HTML: 329,788 bytes.
- HTML SHA-256: `59ebe0cee15b17776548d6b7cca56e4ebddb5c02147774ac62f0baa839c52fb3`.
- Embedded woven Wasm: 2,156 bytes.
- Wasm SHA-256: `625677af70b6054a1eb2baac406b3b2f47cf2ce6a47ae3546d6367b6274f6234`.
- Environment: macOS, Node 22.16.0, Chrome 152.0.7977.82.
- Current release CLI verified with `cargo build --locked --offline --release -p weave-cli`.

## Automated and library-level checks

| Check | Result |
| --- | --- |
| Complete JavaScript CI lane, fresh Pi guest transformation | 392 passed, 0 failed, 0 skipped |
| Clean npm archive installation and import smoke test | All 5 packages passed |
| Demo-only tests using the no-CLI fixture | 54 passed, 0 failed, 0 skipped |
| Single-file/source/Wasm/style/license integrity | Passed |
| Existing core/transport/session source changes | None |

The demo-only suite includes:

- Numerical convergence from actual Wasm, nested live frames, bounded memory,
  and bit-for-bit `f64` equivalence after six fresh checkpoint restores.
- Six complete protocol handoffs, distinct destination instances/memories,
  consecutive host event numbers and exactly 32,768 additional series terms
  at each final/resume boundary.
- Irrevocable source retirement, failed pre-copy and retry, lost start replies,
  lost commit confirmation, replayed commands, burst operations, duplicate
  controllers/slots, controller reload/close, owner close, and terminal Stop.
- Actual native BroadcastChannels, copied byte ownership, arbitrary
  read/write fragmentation, 16 KiB packets, acknowledgement backpressure,
  late/missing peers, malformed messages, timeouts, bounded queues and buffers,
  and cleanup after local/remote closure.
- A message-task scheduler that permits one outstanding yield, cancels through
  AbortSignal, ignores stale cancelled deliveries, fails closed on message
  errors, and closes both ports when its driver ends.
- Source-hash-guarded JavaScript-only fixtures, explicit CLI failures that cannot
  silently fall back, and consistency of the deployable artifact with sources.

## Browser interaction checks

These are real Chrome UI interactions automated through DevTools mouse events,
not calls that bypass the app's controls. Desktop/mobile screenshots were also
visually inspected. This is not a claim of a separate human operating every
test manually, nor a cross-browser compatibility certification.

| Browser run on the shipping HTML | Result |
| --- | --- |
| Stock visible Chrome, full local flow at a renamed nested URL | Passed |
| Stock headless Chrome, full local flow plus 370-second hidden-tab soak | Passed; 370,292 ms, then another handoff without focusing the owner |
| Optional WebRTC, explicit literal-ICE diagnostic profile | Passed, including pre-commit timeout and explicit retry |
| Desktop and 390-pixel mobile screenshot review | Passed |

All three baseline browser runs used the baseline HTML hash above. Each
also passed the actual `file://` guard and **Start → handoff → Stop** flow.
The extended local run passed 253 billion evaluated terms across its soak and
subsequent recovery checks. This does not promise a particular throughput on
other machines. Final artifact evidence from this local session is retained at:

- `/private/tmp/weave-pi-shipping-headed.kRm78Q` — visible Chrome, renamed path.
- `/private/tmp/weave-pi-shipping-soak.FQP8QB` — hidden/offline soak and recovery.
- `/private/tmp/weave-pi-shipping-webrtc.p8ZiUT` — explicit literal-ICE WebRTC regression.
- `/private/tmp/weave-pi-regression.SHljOl` — JavaScript/package/fixture logs.

The full harness exercises the following user-visible workflows:

1. Default pop-up policy opens one compute tab from the bulk-open click. Five
   additional individual **Open next tab** gestures produce exactly six nodes.
2. The full demo has seven browsing contexts: dashboard plus six compute tabs.
   Burst **Start** clicks cannot create multiple calculations.
3. Local-mode tests switch **all seven pages offline before migration** and
   check `navigator.onLine === false`. They then move 1 → 2 → 3 → 4 → 5 → 6 → 1
   with exact final/resume boundaries, inspect retired sources, and verify
   continued progress beyond outstanding connection timer lifetimes.
4. **Auto tour** performs at least two more handoffs; its pause button stops
   movement but leaves the current computation running.
5. Browser lifecycle freeze experiments inspect real freeze/resume events,
   ownership, continued/stalled computation, and behavior after thawing. Tests
   distinguish successful ownership transfer to a suspended tab from a
   pre-commit failure rather than assuming every suspension has one outcome.
6. Closing the current owner cannot cause automatic failover or a new Start.
   The separate **Start → move → Stop** workflow checks terminal, idempotent
   stopping, frozen progress, and disabled restart controls.
7. A 390-pixel viewport has no horizontal overflow. Log download, license
   dialog, repository link, transport selection/locking, and a renamed nested
   deployment path are checked. No external application assets are requested.
8. The long soak keeps all six compute tabs actually hidden for more than six
   minutes, never evaluates/focuses those tabs during the soak, and checks
   progress/ownership/liveness from the visible controller. Background timer
   throttling is **not** disabled.

An observed offline roundtrip from the baseline HTML in visible Chrome:

| Move | Final source event → first target event | Final terms → first resumed terms |
| --- | --- | --- |
| 1 → 2 | 8,213 → 8,214 | 269,123,584 → 269,156,352 |
| 2 → 3 | 36,423 → 36,424 | 1,193,508,864 → 1,193,541,632 |
| 3 → 4 | 64,488 → 64,489 | 2,113,142,784 → 2,113,175,552 |
| 4 → 5 | 93,207 → 93,208 | 3,054,206,976 → 3,054,239,744 |
| 5 → 6 | 121,712 → 121,713 | 3,988,258,816 → 3,988,291,584 |
| 6 → 1 | 149,864 → 149,865 | 4,910,743,552 → 4,910,776,320 |

Every boundary advances exactly one event / 32,768 terms. This real-browser
run also crossed both signed and unsigned 32-bit counter limits without a
restart, wrap, or loss of ownership. Counts are workload observations, not
portable performance benchmarks.

## Findings made during development

**Local WebRTC connectivity was not reliable on this machine/network.** Both
normal headed and headless Chrome failed to resolve `.local` mDNS ICE
candidates. Exposing literal candidates in disposable diagnostic Chrome
profiles made the real WebRTC migration suite pass. The default presentation
therefore uses an explicitly labeled same-browser byte-stream adapter to the
unchanged protocol engine; optional WebRTC remains available without any silent
mid-handoff transport fallback. This is a reachability finding, not evidence
that protocol state was simulated or that a specific STUN service would fix
every network.

**The first long hidden-tab soak found a genuine scheduling limitation.** At
about 301 seconds the tabs were still online and ownership correct, but Pi
made no observable progress for over 20 seconds. This is consistent with
[Chrome's documented intensive throttling of chained timers](https://developer.chrome.com/blog/timer-throttling-in-chrome-88/).
The demo now awaits a MessageChannel task in the existing `Weave.drive`
callback, separating timer chains without modifying the core or adding a busy
loop. Normal browser CPU budgeting, full suspension, discard, and machine
sleep still apply; a short soak cannot guarantee unlimited background execution.
The repeated **370-second** soak passed on the baseline HTML, followed by a
successful handoff without focusing or evaluating the hidden source tab.

**Background heartbeat timers alone could falsely report absent tabs.** Nodes
now answer their pinned controller's presence probes, independently of their
own throttled heartbeat timer. Tests prove bounded replies and no echo loop.

**A frozen target's unanswered preparation does not mean the source moved.**
The controller distinguishes failure before issuing a source command from an
ambiguous response after issuing it. Lost start or ambiguous commit results
never authorize restarting another copy. Tests cover both transports.

**The new byte adapter had a queue-accounting race.** It originally released
write capacity after resolving the write promise, which could reject an
immediate next write incorrectly. Capacity is now released before completion,
with a regression test. Byte and packet-count bounds also prevent unbounded
small-packet object allocations.

**Secure context does not necessarily mean a usable deployment URL.** Chrome
can regard `file://` as secure, while opaque/file origins cannot supply this
demo's same-origin tab setup. The page now explicitly rejects non-HTTP(S)
launches before opening tabs and explains how to serve the single file.

**The freeze test itself needed correction.** A foreground-switch helper could
wake a destination after freezing it. The harness now focuses the dashboard
first, freezes the destination, records actual lifecycle events, and refuses
to claim a valid suspension if Chrome resumes it automatically. Local
BroadcastChannel handlers can also deliver a valid handoff while timer-driven
guest execution is suspended; that is a distinct safe ownership outcome,
not necessarily a preparation timeout.

## Limits and replay

Chrome desktop is the verified presentation target. Mobile layout was checked,
not six-tab mobile reliability. Firefox, Safari, a third-party production host,
cross-device ICE, STUN/TURN services, and native hosting of this guest's custom
progress import/service were not qualified in this task. The broader repository
has separate native/browser integration examples and tests.

See [README.md](README.md#build-and-test) for exact local replay commands.
The browser harness retains `results.json`, Chrome/request logs, final tab
snapshots and screenshots under its explicit `--artifacts` directory, including
the tested HTML hash and Chrome version. Test-created Chrome profiles/processes
are cleaned up; no existing user browser profile is used.
