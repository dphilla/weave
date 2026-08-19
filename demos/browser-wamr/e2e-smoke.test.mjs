import assert from "node:assert/strict";
import test from "node:test";

import { firstAppendedEmit } from "./e2e-smoke.mjs";

test("firstAppendedEmit follows a capped log's logical append position", () => {
  const before = [
    "00:00:00.000 · old",
    "00:00:00.001 · EMIT 100 1",
    "00:00:00.002 · armed",
  ].join("\n") + "\n";
  const after = [
    // The capped UI evicted the first line while appending two more.
    "00:00:00.001 · EMIT 100 1",
    "00:00:00.002 · armed",
    "00:00:00.003 · EMIT 100 1",
    "00:00:00.004 · EMIT 150 2",
  ].join("\n") + "\n";
  assert.equal(firstAppendedEmit(before, after), 100, "must not scan past a duplicate");
});

test("firstAppendedEmit refuses to guess after its marker is evicted", () => {
  assert.throws(
    () => firstAppendedEmit("old marker\n", "EMIT 200 2\n"),
    /rotated past the pre-arm continuity position/,
  );
});
