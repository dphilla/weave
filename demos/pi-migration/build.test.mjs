import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
const escape = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

test("deployable single HTML exactly embeds current sources, Wasm, style, template and license", async () => {
  const html = await readFile(path.join(here, "dist/index.html"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(here, "dist/build-manifest.json"), "utf8"));
  const workload = JSON.parse(html.match(/<script id="weave-workload" type="application\/json">(.*?)<\/script>/s)[1]);
  const importmap = JSON.parse(html.match(/<script type="importmap">(.*?)<\/script>/s)[1]);
  assert.equal(sha(html), manifest.htmlSha256);
  assert.equal(Buffer.byteLength(html), manifest.htmlBytes);
  const wasm = Buffer.from(workload.base64, "base64");
  assert.equal(sha(wasm), workload.sha256);
  assert.equal(wasm.byteLength, workload.bytes);
  assert.ok(WebAssembly.validate(wasm));
  assert.deepEqual(wasm, await readFile(path.join(here, "dist/pi.woven.wasm")));
  assert.deepEqual(workload.sources, manifest.sources);
  const modules = new Map([
    ["js/weave.mjs", "weave-demo:core"],
    ["js/weave-browser.mjs", "weave-demo:browser"],
    ["packages/browser-transports/src/index.mjs", "weave-demo:transports"],
    ["packages/webrtc-session/src/index.mjs", "weave-demo:session"],
    ["demos/pi-migration/runtime.mjs", "weave-demo:runtime"],
    ["demos/pi-migration/tab-stream.mjs", "weave-demo:tab-stream"],
    ["demos/pi-migration/tab-indicator.mjs", "weave-demo:tab-indicator"],
    ["demos/pi-migration/app.mjs", "weave-demo:app"],
  ]);
  assert.deepEqual(Object.keys(workload.sources).sort(), [...modules.keys()].sort());
  assert.deepEqual(Object.keys(importmap.imports).sort(), [...modules.values()].sort());
  for (const [file, name] of modules) {
    const original = await readFile(path.join(root, file), "utf8");
    assert.equal(sha(original), workload.sources[file], `${file}: rebuild the single-file artifact after source edits`);
    assert.ok(importmap.imports[name].startsWith("data:text/javascript;base64,"));
    const embedded = Buffer.from(importmap.imports[name].split(",")[1], "base64").toString("utf8");
    const expected = original.replace(/(^\s*import\s+(?:[^;]*?\s+from\s*)?)(["'])([^"']+)\2/gm, (_match, prefix, quote, specifier) => {
      const key = path.relative(root, path.resolve(root, path.dirname(file), specifier));
      assert.ok(modules.has(key), `no external or unresolved import: ${file}: ${specifier}`);
      return `${prefix}${quote}${modules.get(key)}${quote}`;
    });
    assert.equal(embedded, expected, `${file}: only module specifiers may change when embedding`);
  }
  const template = await readFile(path.join(here, "index.template.html"), "utf8");
  const css = await readFile(path.join(here, "style.css"), "utf8");
  const license = await readFile(path.join(root, "LICENSE"), "utf8");
  const expected = template.replace("/*__STYLE__*/", () => css)
    .replace("/*__WORKLOAD__*/", () => json(workload))
    .replace("/*__IMPORTMAP__*/", () => json(importmap))
    .replace("/*__LICENSE__*/", () => escape(license));
  assert.equal(html, expected, "single-file artifact must match current template, styling and license");
  assert.ok(!/<script[^>]+src=|<link[^>]+rel=["']stylesheet|@import\s|https?:\/\/[^\s"']+\.(?:js|css|woff)/i.test(html), "no script, stylesheet or font network dependencies");
});
