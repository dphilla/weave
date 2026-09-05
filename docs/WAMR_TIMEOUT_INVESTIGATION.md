# WAMR timeout investigation

This records the September 2 investigation with the then-selected classic
interpreter. The subsequent correctness fixes switched to fast interpretation
with pinned SIMDe and build-local indexed-memory adaptations; see
[`wamr/README.md`](../wamr/README.md). The historical timings below are not a
performance baseline for that updated configuration.

## Conclusion

The two retained aggregate qualification failures from September 2, 2026 were
caused by macOS sleep, not a WAMR slowdown or deterministic WAMR hang. Both
WAMR targets were making normal progress, produced an exact prefix of the
successful event stream, and stopped at the same second the host suspended.
The old Bash `SECONDS` deadline continued across sleep and expired before the
machine woke, so conformance terminated a healthy target immediately after
wake.

Raising the runtime timeout would hide the host interruption without fixing
it. No WAMR runtime source changed as a result of this investigation.

## Retained evidence

| Run | WAMR target interval before suspend | Last target event | macOS power log | Configured deadline |
|---|---:|---:|---|---:|
| `weave-qualification.32Ikqs` | 15:50:41–15:51:10/12 | `142750000` (2,852 target events) | sleep at 15:51:10 for 372s; dark wake at 15:57:22 | 180s |
| `weave-qualification.NZ1QIk` | 16:15:36–16:15:58/16:00 | `111250000` (2,222 target events) | sleep at 16:15:58 for 901s; dark wake at 16:30:59 | 360s |

The one-to-two-second overlap between the last file timestamp and the sleep
entry is macOS completing sleep notifications. In both cases:

- migration control reported success;
- source and target stderr contained no trap or runtime error;
- the partial output differed from a successful isolated WAMR→WAMR run only
  because the successful run had the remaining suffix; and
- pre-sleep throughput was approximately 4.6–5.0 million guest iterations per
  second, versus approximately 4.35 million per second in the successful
  isolated run.

At those rates the targets had only about 12–20 active seconds left. The
successful isolated WAMR→WAMR edge took about 46 seconds. An apparent
184-second isolated wazero→WAMR run independently contained 142 seconds of
logged host sleep and about 42 seconds of active work. This is strong evidence
against aggregate-state degradation.

The investigation also found no surviving Weave/WAMR process, abnormal
artifact growth, pipe backpressure, release/debug mismatch, or cross-case
runtime state. Each conformance route launches fresh processes and waits for
their exact PIDs.

## Harness correction

The correction stays entirely in the centralized CI subsystem:

1. `.github/ci/awake-guard.sh` re-execs long local macOS qualification and
   direct conformance commands under `caffeinate -i -s`. It does not prevent
   display sleep, and an inherited sentinel prevents nested assertions.
2. `.github/ci/wait-for.sh` replaces the three Bash `SECONDS` condition loops
   with Python monotonic deadlines. On this Mac, Python reports
   `mach_absolute_time()`; unlike `mach_continuous_time()`, it does not advance
   during system sleep. Linux uses its monotonic uptime clock as well.
3. A detected wall-time/active-time gap is reported as a likely suspend or
   wall-clock jump, and the conformance manifest records the awake-guard mode.

`WEAVE_CI_PREVENT_SLEEP=0` disables the proactive macOS assertion. It does not
disable suspend-safe timeout accounting.

## If an awake-machine failure recurs

Do not start by increasing iteration or timeout limits. Preserve the artifact
directory and establish whether output stopped, slowed, or completed before
teardown:

```sh
pmset -g log | rg 'Sleep|Wake|DarkWake'
ps -axo pid,ppid,state,etime,time,%cpu,%mem,command | rg 'weave-wamr|conformance'
```

Replay only the recorded route using its case manifest, a caller-owned
artifact directory, the same WAMR commit, and the same iteration count. If it
stops while the machine is verifiably awake, collect a process sample before
termination and begin the longer performance program below.

## Longer performance and soak plan

This work is not required to explain the September failures, but it is the
next useful step if the project wants a performance baseline or sees a true
awake-machine stall:

1. Add per-hop JSON telemetry at 5–10 second intervals: monotonic and wall
   time, final event index, process state, CPU time, and resident memory.
2. Separate readiness timeout, no-progress timeout, and active hard cap. On a
   hard failure, sample the process before terminating its process group.
3. Repeat and randomize the seven WAMR directions at 2M, 20M, and 200M
   iterations. Track median, p95, event throughput, RSS slope, and teardown
   duration over at least 30 repetitions.
4. Benchmark poll periods 64, 512, and 4096. The current period of 64 invokes
   the host poll roughly 3.125 million times over 200M iterations.
5. Measure an atomic no-request fast path and removal of the duplicate WAMR
   module-instance lookup before considering either change for production.
6. Rebaseline the fast interpreter against the historical classic results.
   Indexed nonzero `memory.grow` and combined SIMD/multiple-memory fixtures
   now cover the compatibility paths that originally required classic mode.
7. Add separate long-lived-node load coverage for module-cache bounds and
   connection-thread pressure. Those production soak concerns are not active
   in `--exit-on-done` conformance processes.

A later supervisor hardening pass should also terminate descendants by process
group, test TERM-ignoring grandchildren, and use a fake clock to prove suspend
jumps do not consume active deadlines.
