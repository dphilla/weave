// JavaScript-only CI still runs genuine transformed guest integration tests.
// When a CLI is available, always prefer its fresh output. A supplied CLI
// failing is a test failure, never a reason to hide behind the fixture.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_FIXTURE } from "./pi-fixture.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = fileURLToPath(new URL("./pi.wat", import.meta.url));
const PERIOD = 64;
const STACK_PAGES = 2;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let cached;
let cacheKey;

export function verifyPiFixtureSource(source) {
  if (hash(source) !== PI_FIXTURE.sourceSha256
    || PI_FIXTURE.period !== PERIOD || PI_FIXTURE.stackPages !== STACK_PAGES) {
    throw new Error("Pi source or transform options changed: regenerate pi-fixture.mjs before using the JavaScript-only fixture");
  }
  return true;
}

export function loadPiWasm() {
  const provided = process.env.WEAVE_PI_WASM;
  const explicitCli = process.env.WEAVE_BIN;
  const forceFixture = process.env.WEAVE_PI_USE_FIXTURE === "1";
  const key = JSON.stringify([provided, explicitCli, forceFixture]);
  if (cached && key === cacheKey) return cached.slice();
  let bytes;
  if (provided) {
    bytes = new Uint8Array(readFileSync(provided));
  } else {
    const cli = explicitCli ?? join(ROOT, "target/release/weave");
    if (!forceFixture && (explicitCli !== undefined || existsSync(cli))) {
      const directory = mkdtempSync(join(tmpdir(), "weave-pi-fixture-"));
      try {
        const output = join(directory, "pi.wasm");
        execFileSync(cli, ["transform", SOURCE, "-o", output,
          "--period", String(PERIOD), "--stack-pages", String(STACK_PAGES)], { stdio: "pipe", timeout: 30_000 });
        bytes = new Uint8Array(readFileSync(output));
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } else {
      verifyPiFixtureSource(readFileSync(SOURCE));
      bytes = new Uint8Array(Buffer.from(PI_FIXTURE.base64, "base64"));
      if (hash(bytes) !== PI_FIXTURE.wasmSha256) throw new Error("Generated Pi fixture binary digest is invalid");
    }
  }
  if (!WebAssembly.validate(bytes)) throw new Error("Pi test fixture is not valid WebAssembly");
  cached = bytes;
  cacheKey = key;
  return bytes.slice();
}
