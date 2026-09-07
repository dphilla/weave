// This probe must live in a child: a regression can starve the event loop,
// including any in-process test timeout or AbortSignal timer.
import assert from "node:assert/strict";
import { WeaveInstance } from "../weave.mjs";
import { lifecycleWasm } from "./lifecycle-fixture.mjs";

let ticks = 0;
const instance = new WeaveInstance(lifecycleWasm(), new Map([["host", {
  imports: { host: { initialized() {}, tick() { ticks++; } } },
  snapshot: () => new Uint8Array(),
  restore() {},
}]]), { yieldMs: 1 });
await instance.instantiate();
instance.init();

const mode = process.argv[2];
if (mode === "abort-timer") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timer cancelled the guest"), 20);
  try {
    await assert.rejects(instance.drive("forever", [], undefined, { signal: controller.signal }), {
      name: "AbortError", code: "WEAVE_ABORTED",
    });
  } finally {
    clearTimeout(timer);
  }
  assert.equal(instance.lifecycle, "paused");
  assert.ok(ticks > 0, "the guest must actually run before timer cancellation");
} else {
  instance.pollMode = { afterPolls: 0 };
  let timerRan = false;
  const timer = setTimeout(() => {
    timerRan = true;
    instance.pollMode = "run";
  }, 10);
  try {
    const onYield = mode === "immediate-callback" ? async () => "continue" : undefined;
    const result = await instance.drive("run", [1000], onYield);
    assert.deepEqual(result, { status: "done", results: [500500] });
    assert.equal(timerRan, true, "macrotasks must run between unwinds");
    assert.equal(ticks, 1000);
  } finally {
    clearTimeout(timer);
  }
}
process.stdout.write(`PASS ${mode}\n`);
