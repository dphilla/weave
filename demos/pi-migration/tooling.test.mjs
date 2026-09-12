import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { REPOSITORY_ROOT, resolvePiCompiler } from "./compiler.mjs";
import { PI_FIXTURE } from "./pi-fixture.mjs";

const FILES = [
  "LICENSE", "js/weave.mjs", "js/weave-browser.mjs",
  "packages/browser-transports/src/index.mjs", "packages/webrtc-session/src/index.mjs",
  ...["app.mjs", "build.mjs", "compiler.mjs", "index.template.html", "pi-fixture.mjs",
    "pi.wat", "runtime.mjs", "style.css", "tab-indicator.mjs", "tab-stream.mjs", "test-fixture.mjs"]
    .map((filename) => `demos/pi-migration/${filename}`),
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const taggedWasm = (tag) => Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 0, 2, 1, tag.charCodeAt(0)]);

function isolated(t) {
  const directory = mkdtempSync(path.join(tmpdir(), "weave pi tooling "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "checkout with spaces");
  for (const filename of FILES) {
    mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
    copyFileSync(path.join(REPOSITORY_ROOT, filename), path.join(root, filename));
  }
  return { directory, root, demo: path.join(root, "demos/pi-migration") };
}

function environment(overrides = {}) {
  const env = { ...process.env };
  for (const name of ["WEAVE_BIN", "CARGO_TARGET_DIR", "WEAVE_PI_WASM", "WEAVE_PI_USE_FIXTURE", "WEAVE_PI_REQUIRE_CLI"]) delete env[name];
  env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
  return { ...env, ...overrides };
}

function fakeCompiler(filename, tag, mode = "success") {
  mkdirSync(path.dirname(filename), { recursive: true });
  // Real subprocess and argv handling, but no Rust toolchain or downloads.
  writeFileSync(filename, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(`${filename}.calls`)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (${JSON.stringify(mode)} === "fail") { process.stderr.write("selected compiler failed\\n"); process.exit(23); }
if (args[0] !== "transform" || args[2] !== "-o" || args[4] !== "--period" || args[5] !== "64" || args[6] !== "--stack-pages" || args[7] !== "2") throw new Error("unexpected transform arguments");
fs.writeFileSync(args[3], Buffer.from(${JSON.stringify((mode === "invalid" ? Buffer.from("invalid Wasm") : taggedWasm(tag)).toString("base64"))}, "base64"));
`);
  chmodSync(filename, 0o755);
  return filename;
}

function calls(filename) {
  if (!existsSync(`${filename}.calls`)) return [];
  return readFileSync(`${filename}.calls`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

function run(script, { cwd, env = environment(), expected = 0 } = {}) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd, env, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  if (expected === 0) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, "invalid selection unexpectedly succeeded");
  return result;
}

function loadScript(demo, body = "console.log(Buffer.from(loadPiWasm()).toString('base64'));") {
  return `import { loadPiWasm } from ${JSON.stringify(pathToFileURL(path.join(demo, "test-fixture.mjs")).href)};\n${body}`;
}

function load(demo, options) {
  return run(loadScript(demo), options).stdout.trim();
}

function build(demo, args = [], { cwd, env = environment(), expected = 0 } = {}) {
  const result = spawnSync(process.execPath, [path.join(demo, "build.mjs"), ...args], {
    cwd, env, encoding: "utf8", timeout: 15_000,
  });
  assert.ifError(result.error);
  if (expected === 0) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, "invalid build unexpectedly succeeded");
  return result;
}

test("compiler resolution honors caller-relative paths, absolute paths, PATH commands and explicit precedence", (t) => {
  const { directory, root } = isolated(t);
  const cwd = path.join(directory, "caller with spaces");
  mkdirSync(cwd);
  const defaultCompiler = fakeCompiler(path.join(root, "target/release/weave"), "D");
  const relocated = fakeCompiler(path.join(cwd, "relocated target/release/weave"), "R");
  const explicit = fakeCompiler(path.join(cwd, "custom tools/weave-dev"), "E");
  assert.equal(resolvePiCompiler({ root, cwd, env: {} }).command, defaultCompiler);
  for (const value of ["relocated target", path.join(cwd, "relocated target")]) {
    assert.equal(resolvePiCompiler({ root, cwd, env: { CARGO_TARGET_DIR: value } }).command, relocated);
  }
  for (const value of ["custom tools/weave-dev", explicit]) {
    const result = resolvePiCompiler({ root, cwd, env: { WEAVE_BIN: value, CARGO_TARGET_DIR: "ignored target" } });
    assert.equal(result.command, explicit);
    assert.equal(result.explicit, true);
  }
  assert.equal(resolvePiCompiler({ root, cwd, env: { WEAVE_BIN: "weave-dev", PATH: "custom tools" } }).command, explicit);
  fakeCompiler(path.join(cwd, "weave-dev"), "N");
  assert.throws(() => resolvePiCompiler({ root, cwd, env: { WEAVE_BIN: "weave-dev", PATH: path.join(directory, "absent PATH entry") } }), /not found on PATH/);
  assert.equal(resolvePiCompiler({ root, cwd, env: { CARGO_TARGET_DIR: "missing" } }).available, false);
  assert.throws(() => resolvePiCompiler({ root, cwd, env: { WEAVE_BIN: "" } }), /WEAVE_BIN must not be empty/);
  assert.throws(() => resolvePiCompiler({ root, cwd, env: { CARGO_TARGET_DIR: "" } }), /CARGO_TARGET_DIR must not be empty/);
});

test("guest loading prefers the fresh selected compiler and never checks checkout target after relocation", (t) => {
  const { directory, root, demo } = isolated(t);
  const defaultCompiler = fakeCompiler(path.join(root, "target/release/weave"), "D");
  const target = path.join(directory, "relocated target");
  const relocated = fakeCompiler(path.join(target, "release/weave"), "R");
  const explicit = fakeCompiler(path.join(directory, "explicit compiler"), "E");
  assert.equal(load(demo, { cwd: directory }), taggedWasm("D").toString("base64"));
  for (const value of [target, "relocated target"]) {
    assert.equal(load(demo, { cwd: directory, env: environment({ CARGO_TARGET_DIR: value }) }), taggedWasm("R").toString("base64"));
  }
  for (const value of [explicit, "./explicit compiler"]) {
    assert.equal(load(demo, { cwd: directory, env: environment({ WEAVE_BIN: value, CARGO_TARGET_DIR: target }) }), taggedWasm("E").toString("base64"));
  }
  assert.equal(load(demo, { cwd: directory, env: environment({ CARGO_TARGET_DIR: "absent target" }) }), PI_FIXTURE.base64);
  assert.equal(calls(defaultCompiler).length, 1, "relocated fallback must not execute the checkout compiler");
  assert.equal(calls(relocated).length, 2);
  assert.equal(calls(explicit).length, 2);
  for (const compiler of [defaultCompiler, relocated, explicit]) {
    assert.ok(calls(compiler).every((call) => realpathSync(call.cwd) === realpathSync(root)));
  }
});

test("a missing, failed, nonexecutable, or invalid selected compiler cannot silently become a fixture", (t) => {
  const { directory, root, demo } = isolated(t);
  const defaultCompiler = fakeCompiler(path.join(root, "target/release/weave"), "D");
  for (const mode of ["missing", "fail", "invalid", "nonexecutable"]) {
    const cli = path.join(directory, mode, "release/weave");
    if (mode !== "missing") fakeCompiler(cli, "X", mode);
    if (mode === "nonexecutable") chmodSync(cli, 0o644);
    const explicit = run(loadScript(demo), { cwd: directory, env: environment({ WEAVE_BIN: cli }), expected: 1 });
    assert.match(explicit.stderr, mode === "missing" ? /ENOENT/ : mode === "fail" ? /selected compiler failed/ : mode === "invalid" ? /not valid WebAssembly/ : /EACCES/);
    if (mode !== "missing") {
      run(loadScript(demo), { cwd: directory, env: environment({ CARGO_TARGET_DIR: path.dirname(path.dirname(cli)) }), expected: 1 });
    }
  }
  assert.equal(calls(defaultCompiler).length, 0);
});

test("fixture and Wasm-byte overrides remain deliberate, validated exceptions to compiler discovery", (t) => {
  const { directory, root, demo } = isolated(t);
  const cli = fakeCompiler(path.join(root, "target/release/weave"), "X", "fail");
  assert.equal(load(demo, { cwd: directory, env: environment({ WEAVE_BIN: cli, WEAVE_PI_USE_FIXTURE: "1" }) }), PI_FIXTURE.base64);
  const supplied = path.join(directory, "provided module.wasm");
  writeFileSync(supplied, taggedWasm("P"));
  assert.equal(load(demo, { cwd: directory, env: environment({ WEAVE_BIN: cli, WEAVE_PI_USE_FIXTURE: "1", WEAVE_PI_WASM: "provided module.wasm" }) }), taggedWasm("P").toString("base64"));
  writeFileSync(supplied, "not Wasm");
  assert.match(run(loadScript(demo), { cwd: directory, env: environment({ WEAVE_PI_WASM: supplied }), expected: 1 }).stderr, /not valid WebAssembly/);
  assert.equal(calls(cli).length, 0);
  writeFileSync(path.join(demo, "pi.wat"), readFileSync(path.join(demo, "pi.wat"), "utf8") + "\n;; modified\n");
  assert.match(run(loadScript(demo), { cwd: directory, env: environment({ WEAVE_PI_USE_FIXTURE: "1" }), expected: 1 }).stderr, /regenerate pi-fixture/);
});

test("compiler-required CI mode rejects overrides and missing compilers instead of using a fixture", (t) => {
  const { directory, root, demo } = isolated(t);
  const compiler = fakeCompiler(path.join(root, "target/release/weave"), "R");
  const env = environment({ WEAVE_PI_REQUIRE_CLI: "1" });
  assert.equal(load(demo, { cwd: directory, env }), taggedWasm("R").toString("base64"));
  for (const overrides of [{ WEAVE_PI_USE_FIXTURE: "1" }, { WEAVE_PI_WASM: "provided.wasm" }]) {
    assert.match(run(loadScript(demo), { cwd: directory, env: { ...env, ...overrides }, expected: 1 }).stderr,
      /WEAVE_PI_REQUIRE_CLI=1 does not allow/);
  }
  for (const overrides of [{ CARGO_TARGET_DIR: "missing target" }, { WEAVE_BIN: "./missing CLI" }]) {
    const result = run(loadScript(demo), { cwd: directory, env: { ...env, ...overrides }, expected: 1 });
    assert.match(result.stderr, /requires a fresh compiler; selected compiler is missing/);
  }
  assert.equal(calls(compiler).length, 1);
  const body = `
const first = loadPiWasm();
process.env.WEAVE_PI_REQUIRE_CLI = "1";
const second = loadPiWasm();
if (!Buffer.from(first).equals(Buffer.from(second))) throw new Error("unexpected compiler change");
`;
  run(loadScript(demo, body), { cwd: directory });
  assert.equal(calls(compiler).length, 3, "require-compiler mode is part of the cache identity");
});

test("the fixture cache follows target, cwd, explicit CLI, PATH and compiler availability changes", (t) => {
  const { directory, root, demo } = isolated(t);
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const a = fakeCompiler(path.join(first, "target/release/weave"), "A");
  const b = fakeCompiler(path.join(second, "target/release/weave"), "B");
  const c = fakeCompiler(path.join(directory, "third/release/weave"), "C");
  const upcoming = path.join(directory, "upcoming/release/weave");
  const body = `
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
const result = [];
const take = () => result.push(Buffer.from(loadPiWasm()).toString("base64"));
process.env.CARGO_TARGET_DIR = "target";
process.chdir(${JSON.stringify(first)}); take();
const owned = loadPiWasm(); owned.fill(255); take();
process.chdir(${JSON.stringify(second)}); take();
process.env.CARGO_TARGET_DIR = ${JSON.stringify(path.join(directory, "third"))}; take();
process.env.WEAVE_BIN = ${JSON.stringify(a)}; take();
process.env.WEAVE_BIN = "weave";
process.env.PATH = ${JSON.stringify(path.dirname(b))} + ":" + ${JSON.stringify(path.dirname(process.execPath))}; take();
process.env.PATH = ${JSON.stringify(path.dirname(c))} + ":" + ${JSON.stringify(path.dirname(process.execPath))}; take();
delete process.env.WEAVE_BIN;
process.env.CARGO_TARGET_DIR = ${JSON.stringify(path.join(directory, "upcoming"))}; take();
mkdirSync(${JSON.stringify(path.dirname(upcoming))}, { recursive: true });
copyFileSync(${JSON.stringify(a)}, ${JSON.stringify(upcoming)}); take();
copyFileSync(${JSON.stringify(b)}, ${JSON.stringify(upcoming)}); take();
process.env.WEAVE_BIN = ${JSON.stringify(path.join(directory, "missing cli"))};
assert.throws(() => loadPiWasm(), /ENOENT/);
console.log(JSON.stringify(result));
`;
  const result = JSON.parse(run(loadScript(demo, body), { cwd: root }).stdout);
  assert.deepEqual(result, ["A", "A", "B", "C", "A", "B", "C", "fixture", "A", "B"]
    .map((tag) => tag === "fixture" ? PI_FIXTURE.base64 : taggedWasm(tag).toString("base64")));
  assert.equal(calls(a).length, 3, "same selection is cached, while environment selection changes retransform");
});

test("provided-byte cache follows caller cwd and replacement of the supplied file", (t) => {
  const { directory, root, demo } = isolated(t);
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  for (const [cwd, tag] of [[first, "A"], [second, "B"]]) {
    mkdirSync(cwd);
    writeFileSync(path.join(cwd, "pi.wasm"), taggedWasm(tag));
  }
  const body = `
import { writeFileSync } from "node:fs";
const result = [];
const take = () => result.push(Buffer.from(loadPiWasm()).toString("base64"));
process.env.WEAVE_PI_WASM = "pi.wasm";
process.chdir(${JSON.stringify(first)}); take();
process.chdir(${JSON.stringify(second)}); take();
writeFileSync("pi.wasm", Buffer.from(${JSON.stringify(taggedWasm("C").toString("base64"))}, "base64")); take();
console.log(JSON.stringify(result));
`;
  assert.deepEqual(JSON.parse(run(loadScript(demo, body), { cwd: root }).stdout),
    ["A", "B", "C"].map((tag) => taggedWasm(tag).toString("base64")));
});

test("the builder shares compiler selection and packages deterministically to absolute or relative out-dir paths", (t) => {
  const { directory, root, demo } = isolated(t);
  const defaultCompiler = fakeCompiler(path.join(root, "target/release/weave"), "D");
  const target = path.join(directory, "relocated target");
  const relocated = fakeCompiler(path.join(target, "release/weave"), "R");
  const originalFixture = readFileSync(path.join(demo, "pi-fixture.mjs"));
  const absoluteOutput = path.join(directory, "absolute output");
  build(demo, ["--out-dir", absoluteOutput], { cwd: directory, env: environment({ CARGO_TARGET_DIR: "relocated target" }) });
  build(demo, ["--out-dir", "relative output"], { cwd: directory, env: environment({ CARGO_TARGET_DIR: target }) });
  const first = readFileSync(path.join(absoluteOutput, "index.html"));
  const second = readFileSync(path.join(directory, "relative output/index.html"));
  assert.deepEqual(first, second);
  const manifest = JSON.parse(readFileSync(path.join(absoluteOutput, "build-manifest.json"), "utf8"));
  assert.equal(manifest.htmlSha256, hash(first));
  assert.equal(manifest.sha256, hash(taggedWasm("R")));
  assert.equal(manifest.htmlBytes, first.length);
  assert.match(first.toString(), /data:text\/javascript;base64,/);
  assert.ok(first.toString().includes(taggedWasm("R").toString("base64")));
  assert.deepEqual(readFileSync(path.join(absoluteOutput, "pi.woven.wasm")), taggedWasm("R"));
  assert.deepEqual(readFileSync(path.join(demo, "pi-fixture.mjs")), originalFixture);
  assert.equal(existsSync(path.join(demo, "dist")), false, "external output must not mutate tracked dist");
  assert.equal(calls(defaultCompiler).length, 0);
  assert.equal(calls(relocated).length, 2);
  build(demo, [], { cwd: directory, env: environment({ WEAVE_BIN: "./relocated target/release/weave" }) });
  assert.ok(existsSync(path.join(demo, "dist/index.html")), "default packaging location is unchanged");
  assert.deepEqual(readFileSync(path.join(demo, "dist/index.html")), first);
});

test("updating the guarded test fixture works with an external build directory", (t) => {
  const { directory, root, demo } = isolated(t);
  fakeCompiler(path.join(root, "target/release/weave"), "U");
  build(demo, ["--update-test-fixture", "--out-dir", "artifacts with spaces"], { cwd: directory });
  const fixture = JSON.parse(readFileSync(path.join(demo, "pi-fixture.mjs"), "utf8").match(/Object\.freeze\(([\s\S]+)\);/)[1]);
  assert.equal(fixture.base64, taggedWasm("U").toString("base64"));
  assert.equal(fixture.sourceSha256, hash(readFileSync(path.join(demo, "pi.wat"))));
  assert.equal(fixture.wasmSha256, hash(taggedWasm("U")));
  assert.equal(fixture.period, 64);
  assert.equal(fixture.stackPages, 2);
  assert.equal(existsSync(path.join(demo, "dist")), false);
  assert.equal(load(demo, { cwd: directory, env: environment({ WEAVE_PI_USE_FIXTURE: "1" }) }), taggedWasm("U").toString("base64"));
});

test("builder rejects invalid arguments before writing artifacts or invoking a compiler", (t) => {
  const { directory, root, demo } = isolated(t);
  const cli = fakeCompiler(path.join(root, "target/release/weave"), "D");
  for (const args of [["--unknown"], ["--out-dir"], ["--out-dir", ""], ["--out-dir", "--update-test-fixture"],
    ["--out-dir", "first", "--out-dir", "second"], ["--update-test-fixture", "--update-test-fixture"], ["unexpected"]]) {
    assert.match(build(demo, args, { cwd: directory, expected: 1 }).stderr, /usage: node demos\/pi-migration\/build\.mjs/);
  }
  assert.equal(calls(cli).length, 0);
  for (const output of [path.join(demo, "dist"), path.join(directory, "first"), path.join(directory, "second")]) {
    assert.equal(existsSync(output), false);
  }
});

test("builder never substitutes checkout output for a missing or broken selected compiler", (t) => {
  const { directory, root, demo } = isolated(t);
  const defaultCompiler = fakeCompiler(path.join(root, "target/release/weave"), "D");
  const broken = fakeCompiler(path.join(directory, "broken/release/weave"), "B", "fail");
  const invalid = fakeCompiler(path.join(directory, "invalid/release/weave"), "I", "invalid");
  const scenarios = [
    [{ CARGO_TARGET_DIR: "missing target" }, /ENOENT/],
    [{ WEAVE_BIN: "./missing compiler" }, /ENOENT/],
    [{ CARGO_TARGET_DIR: "broken" }, /selected compiler failed/],
    [{ WEAVE_BIN: broken }, /selected compiler failed/],
    [{ WEAVE_BIN: invalid }, /not valid WebAssembly/],
    [{ WEAVE_BIN: "" }, /WEAVE_BIN must not be empty/],
    [{ CARGO_TARGET_DIR: "" }, /CARGO_TARGET_DIR must not be empty/],
  ];
  for (const [overrides, diagnostic] of scenarios) {
    assert.match(build(demo, ["--out-dir", "failed output"], { cwd: directory, env: environment(overrides), expected: 1 }).stderr, diagnostic);
  }
  assert.equal(calls(defaultCompiler).length, 0);
  assert.equal(existsSync(path.join(directory, "failed output/index.html")), false);
});
