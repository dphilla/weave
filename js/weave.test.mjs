import assert from "node:assert/strict";
import test from "node:test";

import {
  FINAL_SCAN_BATCH_BYTES,
  FT,
  PageTracker,
  PROTO_VERSION,
  SourceMigration,
  WeaveInstance,
  Writer,
  acceptMigration,
  compareUtf8Strings,
  declaredInitialMemoryBytes,
  frame,
  sha256,
  validateModuleAbi,
} from "./weave.mjs";
import { makeEmitServices } from "./weave-node-services.mjs";

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

test("protocol v2 uses stable prepare/commit frame IDs", () => {
  assert.equal(PROTO_VERSION, 2);
  assert.equal(FT.PREPARED, 15);
  assert.equal(FT.COMMIT, 21);
  assert.equal(FT.COMMIT_OK, 22);
  assert.equal(FT.RESUME_OK, undefined);
});

function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

function uleb(value) {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

function wasmName(value) {
  const bytes = new TextEncoder().encode(value);
  return [...uleb(bytes.length), ...bytes];
}

test("declaredInitialMemoryBytes sums imported and defined memories", () => {
  const imports = [
    2, // two imports
    1, 0x6d, 1, 0x66, 0, 0, // m.f: function type 0
    1, 0x6d, 1, 0x78, 2, 0, 3, // m.x: memory(min=3)
  ];
  const memories = [1, 0, 2]; // one memory(min=2)
  const wasm = new Uint8Array([
    ...HEADER,
    ...section(2, imports),
    ...section(5, memories),
  ]);
  assert.equal(declaredInitialMemoryBytes(wasm), 5n * 65536n);
});

test("declaredInitialMemoryBytes handles memory64 page counts", () => {
  const memories = [1, 4, 0x80, 0x80, 0x04]; // one memory64(min=65536)
  const wasm = new Uint8Array([...HEADER, ...section(5, memories)]);
  assert.equal(declaredInitialMemoryBytes(wasm), 4n * 1024n * 1024n * 1024n);
});

test("declaredInitialMemoryBytes rejects unsupported memory flags", () => {
  const wasm = new Uint8Array([...HEADER, ...section(5, [1, 8, 0])]);
  assert.throws(() => declaredInitialMemoryBytes(wasm), /unsupported flags/);
});

class ScriptTransport {
  constructor(incoming = [], failWriteType = null) {
    const length = incoming.reduce((sum, bytes) => sum + bytes.length, 0);
    this.incoming = new Uint8Array(length);
    let offset = 0;
    for (const bytes of incoming) {
      this.incoming.set(bytes, offset);
      offset += bytes.length;
    }
    this.offset = 0;
    this.failWriteType = failWriteType;
    this.writes = [];
  }

  async readExact(length) {
    if (this.offset + length > this.incoming.length) throw new Error("scripted peer closed");
    const bytes = this.incoming.slice(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }

  async write(bytes) {
    this.writes.push(bytes.slice());
    if (bytes[0] === this.failWriteType) throw new Error(`scripted write failure for ${bytes[0]}`);
  }
}

class StalledTransport extends ScriptTransport {
  async readExact(length) {
    if (this.offset + length <= this.incoming.length) return super.readExact(length);
    return new Promise(() => {});
  }
}

class PushTransport {
  constructor(failWriteType = null) {
    this.incoming = new Uint8Array(0);
    this.readers = [];
    this.writes = [];
    this.writeWaiters = [];
    this.failWriteType = failWriteType;
  }

  push(bytes) {
    const joined = new Uint8Array(this.incoming.length + bytes.length);
    joined.set(this.incoming);
    joined.set(bytes, this.incoming.length);
    this.incoming = joined;
    this.pump();
  }

  readExact(length) {
    return new Promise((resolve) => {
      this.readers.push({ length, resolve });
      this.pump();
    });
  }

  pump() {
    while (this.readers.length > 0 && this.incoming.length >= this.readers[0].length) {
      const { length, resolve } = this.readers.shift();
      const bytes = this.incoming.slice(0, length);
      this.incoming = this.incoming.slice(length);
      resolve(bytes);
    }
  }

  async write(bytes) {
    this.writes.push(bytes.slice());
    for (const waiter of this.writeWaiters.splice(0)) waiter();
    if (bytes[0] === this.failWriteType) throw new Error(`scripted write failure for ${bytes[0]}`);
  }

  async waitForWrite(type) {
    while (!this.writes.some((bytes) => bytes[0] === type)) {
      await new Promise((resolve) => this.writeWaiters.push(resolve));
    }
  }
}

class StalledAckWriteTransport extends PushTransport {
  write(bytes) {
    if (bytes[0] !== FT.COMMIT_OK) return super.write(bytes);
    this.writes.push(bytes.slice());
    for (const waiter of this.writeWaiters.splice(0)) waiter();
    return new Promise(() => {});
  }
}

const META_TYPE = new Map([
  ["i32", 0], ["i64", 1], ["f32", 2], ["f64", 3], ["v128", 4], ["funcref", 5],
]);
const CORE_TYPE = new Map([
  ["i32", 0x7f], ["i64", 0x7e], ["f32", 0x7d], ["f64", 0x7c],
  ["v128", 0x7b], ["funcref", 0x70],
]);
const FIXED_CONTROLS = [
  "__weave_state",
  "__weave_flag",
  "__weave_entry",
  "__weave_ctr",
  "__weave_sp",
  "__weave_stack_base",
  "__weave_stack_end",
  "__weave_rbase",
];

function putMetaTypes(writer, types) {
  writer.u16(types.length);
  for (const type of types) writer.u8(META_TYPE.get(type));
}

function zeroInitializer(type) {
  switch (type) {
    case "i32": return [0x41, 0];
    case "i64": return [0x42, 0];
    case "f32": return [0x43, 0, 0, 0, 0];
    case "f64": return [0x44, 0, 0, 0, 0, 0, 0, 0, 0];
    default: throw new Error(`test helper has no zero initializer for ${type}`);
  }
}

function wovenModule({
  functionImports = [],
  initInstructions = [],
  entries = [],
  actualEntries = entries,
  includeResume = true,
  exportResume = true,
  resumeParams = [],
  memories = [],
  memoryCount = memories.length,
  memoryExports = memories.map((name, index) => ({ name, index })),
  controlGlobals = FIXED_CONTROLS,
  actualGlobals = controlGlobals.map((name) => ({ name, type: "i32", mutable: true })),
  globalExports = actualGlobals.map(({ name }, index) => ({ name, index })),
  startFunctionIndex = null,
  globalsAreaSize = 0,
  resultsAreaSize = entries.reduce(
    (largest, entry) => Math.max(largest, entry.results.length),
    0,
  ) * 16,
} = {}) {
  const encoder = new TextEncoder();
  const metaWriter = new Writer()
    .raw(encoder.encode("WVMT"))
    .u16(1)
    .u32(1)
    .u16(entries.length);
  for (const entry of entries) {
    metaWriter.str(entry.name);
    putMetaTypes(metaWriter, entry.params);
    putMetaTypes(metaWriter, entry.results);
  }
  metaWriter.u16(memories.length);
  for (const name of memories) metaWriter.str(name);
  metaWriter.u16(functionImports.length);
  for (const imported of functionImports) {
    metaWriter.str(imported.module).str(imported.name);
    putMetaTypes(metaWriter, imported.params);
    putMetaTypes(metaWriter, imported.results);
  }
  metaWriter.u16(controlGlobals.length);
  for (const name of controlGlobals) metaWriter.str(name);
  const meta = metaWriter.u32(globalsAreaSize).u32(resultsAreaSize).out();

  const functions = [
    { name: "__weave_init", params: [], results: [], exported: true },
    ...(includeResume
      ? [{ name: "__weave_resume", params: resumeParams, results: [], exported: exportResume }]
      : []),
    ...actualEntries.map((entry) => ({ ...entry, exported: true })),
  ];
  const signatures = [...functionImports, ...functions];
  const types = signatures.flatMap(({ params, results }) => [
    0x60,
    ...uleb(params.length),
    ...params.map((type) => CORE_TYPE.get(type)),
    ...uleb(results.length),
    ...results.map((type) => CORE_TYPE.get(type)),
  ]);
  const functionSection = [
    ...uleb(functions.length),
    ...functions.flatMap((_, index) => uleb(functionImports.length + index)),
  ];
  const exports = [];
  functions.forEach((func, index) => {
    if (func.exported) exports.push({ name: func.name, kind: 0, index: functionImports.length + index });
  });
  exports.push(...memoryExports.map(({ name, index }) => ({ name, kind: 2, index })));
  exports.push(...globalExports.map(({ name, index }) => ({ name, kind: 3, index })));
  const exportSection = [
    ...uleb(exports.length),
    ...exports.flatMap(({ name, kind, index }) => [...wasmName(name), kind, ...uleb(index)]),
  ];
  const codeSection = [
    ...uleb(functions.length),
    ...functions.flatMap((_, index) => {
      const body = [0, ...(index === 0 ? initInstructions : []), 0x0b];
      return [...uleb(body.length), ...body];
    }),
  ];
  const custom = [...wasmName("weave.meta"), ...meta];
  const wasmParts = [
    ...HEADER,
    ...section(1, [...uleb(signatures.length), ...types]),
  ];
  if (functionImports.length > 0) {
    wasmParts.push(...section(2, [
      ...uleb(functionImports.length),
      ...functionImports.flatMap(({ module, name }, index) => [
        ...wasmName(module), ...wasmName(name), 0, ...uleb(index),
      ]),
    ]));
  }
  wasmParts.push(...section(3, functionSection));
  if (memoryCount > 0) {
    wasmParts.push(...section(5, [
      ...uleb(memoryCount),
      ...Array.from({ length: memoryCount }, () => [0, 1]).flat(),
    ]));
  }
  if (actualGlobals.length > 0) {
    const globals = [
      ...uleb(actualGlobals.length),
      ...actualGlobals.flatMap(({ type, mutable }) => [
        CORE_TYPE.get(type), mutable ? 1 : 0, ...zeroInitializer(type), 0x0b,
      ]),
    ];
    wasmParts.push(...section(6, globals));
  }
  wasmParts.push(...section(7, exportSection));
  if (startFunctionIndex !== null) {
    wasmParts.push(...section(8, uleb(startFunctionIndex)));
  }
  wasmParts.push(...section(10, codeSection), ...section(0, custom));
  const wasm = Uint8Array.from(wasmParts);
  return { wasm, meta };
}

function minimalWovenModule() {
  return wovenModule();
}

test("initialization completes across expired time slices and forced unwind polls", async (t) => {
  let now = 100;
  t.mock.method(Date, "now", () => now);
  const { wasm } = wovenModule({
    functionImports: [
      { module: "weave", name: "poll", params: [], results: ["i32"] },
      { module: "test", name: "tick", params: [], results: [] },
    ],
    initInstructions: [
      0x10, 0, 0x04, 0x40, 0x0f, 0x0b, // if poll(): return
      0x10, 1,                         // tick advances past the time slice
      0x10, 0, 0x04, 0x40, 0x0f, 0x0b, // if poll(): return
      0x41, 42, 0x24, 2,               // publish initialized value in G.entry
    ],
  });
  for (const pollMode of ["run", "unwind", { afterPolls: 0 }]) {
    const instance = new WeaveInstance(wasm, new Map([["test.tick", {
      imports: { test: { tick() { now += 25; } } },
    }]]), { yieldMs: 1 });
    await instance.instantiate();
    instance.lastYield = now;
    instance.pollMode = pollMode;
    instance.init();
    assert.equal(instance.g("__weave_entry"), 42, "initialization must reach its final side effect");
    assert.equal(instance.pollCount, 2);
    assert.equal(instance.pollMode, pollMode, "restore the caller's exact poll mode");
    assert.equal(instance._poll(), 1, "normal yield policy resumes after initialization");
  }
});

test("initialization restores polling policy when the guest traps", async () => {
  const { wasm } = wovenModule({
    functionImports: [{ module: "weave", name: "poll", params: [], results: ["i32"] }],
    initInstructions: [0x10, 0, 0x1a, 0x00], // poll; drop; unreachable
  });
  const instance = new WeaveInstance(wasm, new Map());
  await instance.instantiate();
  const pollMode = { afterPolls: 0 };
  instance.pollMode = pollMode;
  assert.throws(() => instance.init(), WebAssembly.RuntimeError);
  assert.equal(instance.pollMode, pollMode);
  assert.equal(instance._poll(), 1);
});

function makeNamedTestServices(names, restored = []) {
  return new Map(names.map((name, index) => [name, {
    imports: {},
    snapshot: () => Uint8Array.of(index + 1),
    restore: (blob) => restored.push([name, [...blob]]),
  }]));
}

test("service names use canonical UTF-8 byte order", () => {
  const nonBmp = "\u{10000}";
  const privateUseBmp = "\uE000";
  assert.deepEqual(
    [nonBmp, privateUseBmp].sort(compareUtf8Strings),
    [privateUseBmp, nonBmp],
    "UTF-8 orders EE... (U+E000) before F0... (U+10000)",
  );

  const restored = [];
  const instance = new WeaveInstance(
    minimalWovenModule().wasm,
    makeNamedTestServices([nonBmp, privateUseBmp], restored),
  );
  const blobs = instance.serviceBlobs();
  assert.deepEqual(blobs.map(([name]) => name), [privateUseBmp, nonBmp]);
  instance.restoreServices(blobs);
  assert.deepEqual(restored.map(([name]) => name), [privateUseBmp, nonBmp]);

  const globals = FIXED_CONTROLS.map((name) => [name, 0]);
  assert.deepEqual(
    instance.stateHash(globals, blobs),
    instance.stateHash(globals, [...blobs].reverse()),
    "state hash must canonicalize service order by UTF-8 bytes",
  );
});

test("service names must be Unicode scalar strings", () => {
  assert.throws(
    () => new WeaveInstance(
      minimalWovenModule().wasm,
      makeNamedTestServices(["bad-\uD800-name"]),
    ),
    /host service name must be a Unicode scalar string/,
  );
});

test("woven ABI rejects a missing or wrongly typed resume export", () => {
  const missing = wovenModule({ includeResume: false }).wasm;
  assert.throws(
    () => new WeaveInstance(missing, new Map()),
    /module has no exported function __weave_resume/,
  );

  const wrong = wovenModule({ resumeParams: ["i32"] }).wasm;
  assert.throws(
    () => new WeaveInstance(wrong, new Map()),
    /__weave_resume signature mismatch/,
  );
});

test("woven ABI rejects WebAssembly start sections", () => {
  const withStart = wovenModule({ startFunctionIndex: 0 }).wasm;
  assert.equal(WebAssembly.validate(withStart), true, "forged module must otherwise be valid Wasm");
  assert.throws(() => validateModuleAbi(withStart), /must not define a start section/);
  assert.throws(
    () => new WeaveInstance(withStart, new Map()),
    /must not define a start section/,
  );
});

test("woven ABI rejects an entry signature that disagrees with weave.meta", () => {
  const wasm = wovenModule({
    entries: [{ name: "run", params: ["i32"], results: [] }],
    actualEntries: [{ name: "run", params: ["i64"], results: [] }],
  }).wasm;
  assert.throws(() => new WeaveInstance(wasm, new Map()), /run signature mismatch/);
});

test("woven ABI requires one selected export per memory and allows aliases", () => {
  const omitted = wovenModule({
    memories: ["memory"],
    memoryCount: 1,
    memoryExports: [],
  }).wasm;
  assert.throws(
    () => new WeaveInstance(omitted, new Map()),
    /no memory export memory/,
  );

  const wrongIndex = wovenModule({
    memories: ["memory0", "memory1"],
    memoryCount: 2,
    memoryExports: [
      { name: "memory0", index: 0 },
      { name: "memory1", index: 0 },
    ],
  }).wasm;
  assert.throws(() => new WeaveInstance(wrongIndex, new Map()), /maps to memory 0/);

  const preservedAlias = wovenModule({
    memories: ["memory"],
    memoryCount: 1,
    memoryExports: [
      { name: "memory", index: 0 },
      { name: "original_memory_alias", index: 0 },
    ],
  }).wasm;
  assert.equal(WebAssembly.validate(preservedAlias), true);
  assert.doesNotThrow(() => new WeaveInstance(preservedAlias, new Map()));
});

test("woven ABI requires every unique control global to export mutable i32", () => {
  const omittedFromMeta = wovenModule({
    controlGlobals: FIXED_CONTROLS.slice(0, -1),
  }).wasm;
  assert.throws(
    () => new WeaveInstance(omittedFromMeta, new Map()),
    /required fixed prefix\/order/,
  );

  const omittedExport = wovenModule({
    globalExports: FIXED_CONTROLS.slice(1).map((name, index) => ({ name, index: index + 1 })),
  }).wasm;
  assert.throws(
    () => new WeaveInstance(omittedExport, new Map()),
    /complete injected global-export set/,
  );

  const immutable = wovenModule({
    actualGlobals: FIXED_CONTROLS.map((name, index) => ({
      name,
      type: "i32",
      mutable: index !== 0,
    })),
  }).wasm;
  assert.throws(() => new WeaveInstance(immutable, new Map()), /must be mutable i32/);

  const wrongType = wovenModule({
    actualGlobals: FIXED_CONTROLS.map((name, index) => ({
      name,
      type: index === 0 ? "i64" : "i32",
      mutable: true,
    })),
  }).wasm;
  assert.equal(WebAssembly.validate(wrongType), true);
  assert.throws(() => new WeaveInstance(wrongType, new Map()), /must be mutable i32/);

  const sameGlobalTwice = wovenModule({
    globalExports: FIXED_CONTROLS.map((name, index) => ({
      name,
      index: index === 1 ? 0 : index,
    })),
  }).wasm;
  assert.throws(() => new WeaveInstance(sameGlobalTwice, new Map()), /listed more than once/);
});

test("woven ABI validates table-shadow names and metadata layout", () => {
  const validShadows = [...FIXED_CONTROLS, "__weave_tsh0", "__weave_tshcap0"];
  assert.doesNotThrow(() => new WeaveInstance(
    wovenModule({ controlGlobals: validShadows }).wasm,
    new Map(),
  ));

  const incomplete = [...FIXED_CONTROLS, "__weave_tsh0"];
  assert.throws(
    () => new WeaveInstance(wovenModule({ controlGlobals: incomplete }).wasm, new Map()),
    /table-shadow control globals are incomplete/,
  );

  const reversed = [...FIXED_CONTROLS, "__weave_tshcap0", "__weave_tsh0"];
  assert.throws(
    () => new WeaveInstance(wovenModule({ controlGlobals: reversed }).wasm, new Map()),
    /table-shadow control globals are out of order/,
  );

  assert.throws(
    () => new WeaveInstance(wovenModule({ globalsAreaSize: 1 }).wasm, new Map()),
    /globals-area size is not 16-byte aligned/,
  );
  assert.throws(
    () => new WeaveInstance(wovenModule({
      entries: [{ name: "run", params: [], results: ["i64"] }],
      actualEntries: [{ name: "run", params: [], results: ["i64"] }],
      resultsAreaSize: 0,
    }).wasm, new Map()),
    /results-area size mismatch/,
  );
});

function offerModuleForValidation(transport, { wasm, meta }, opts = {}) {
  const hello = new Writer().u8(PROTO_VERSION).u8(1).str("test-source").out();
  const moduleMeta = new Writer()
    .raw(sha256(wasm))
    .u64(wasm.length)
    .bytes(meta)
    .out();
  transport.push(frame(FT.HELLO, hello));
  transport.push(frame(FT.MODULE_META, moduleMeta));
  transport.push(frame(FT.MODULE_DATA, new Writer().u64(0).raw(wasm).out()));
  return acceptMigration(transport, () => new Map(), {
    runtimeName: "test-target",
    ...opts,
  });
}

test("target rejects an invalid module ABI before PREPARED", async () => {
  const transport = new PushTransport();
  const accepting = offerModuleForValidation(transport, wovenModule({ resumeParams: ["i32"] }));
  await assert.rejects(accepting, /__weave_resume signature mismatch/);
  assert.ok(transport.writes.some((bytes) => bytes[0] === FT.ABORT));
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.PREPARED));
});

test("target rejects a module start section before PREPARED", async () => {
  const transport = new PushTransport();
  const module = wovenModule({ startFunctionIndex: 0 });
  assert.equal(WebAssembly.validate(module.wasm), true);
  const accepting = offerModuleForValidation(transport, module);
  // Deterministic sentinel for the pre-fix behavior: an implementation that
  // wrongly instantiates the module consumes this next and fails with the
  // wrong reason, instead of waiting for its target read deadline.
  transport.push(frame(
    FT.ABORT,
    new Writer().u32(99).str("start-section regression sentinel").out(),
  ));
  await assert.rejects(accepting, /must not define a start section/);
  assert.ok(transport.writes.some((bytes) => bytes[0] === FT.ABORT));
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.PREPARED));
});

test("target rejects forged control/layout metadata before PREPARED", async () => {
  const transport = new PushTransport();
  const accepting = offerModuleForValidation(transport, wovenModule({ globalsAreaSize: 1 }));
  await assert.rejects(accepting, /globals-area size is not 16-byte aligned/);
  assert.ok(transport.writes.some((bytes) => bytes[0] === FT.ABORT));
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.PREPARED));
});

test("target admission can reject an offered module before transfer", async () => {
  const transport = new PushTransport();
  let offer = null;
  const module = minimalWovenModule();
  const accepting = offerModuleForValidation(transport, module, {
    authorizeOffer(value) {
      offer = value;
      return false;
    },
  });
  await assert.rejects(accepting, /target policy rejected the module offer/);
  assert.equal(offer.sourceRuntime, "test-source");
  assert.equal(offer.moduleSize, module.wasm.length);
  assert.equal(offer.moduleHashHex, Buffer.from(sha256(module.wasm)).toString("hex"));
  assert.ok(transport.writes.some((bytes) => bytes[0] === FT.ABORT));
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.MODULE_NEED));
});

function offerFinalStateMigration(transport, {
  sourceServices = new Map(),
  makeTargetServices = () => new Map(),
  mutateServices = (services) => services,
  mutateGlobals = (globals) => globals,
  opts = {},
} = {}) {
  // This protocol-only fixture models a held entry. Real stack reconstruction
  // and execution are covered by weave-lifecycle-migration.test.mjs.
  const { wasm, meta } = wovenModule({ entries: [{ name: "run", params: [], results: [] }] });
  const sourceInstance = new WeaveInstance(wasm, sourceServices);
  const globals = mutateGlobals(FIXED_CONTROLS.map((name) => [name,
    name === "__weave_flag" || name === "__weave_state" ? 1 : 0,
  ]));
  const services = mutateServices(sourceInstance.serviceBlobs().map(
    ([name, blob]) => [name, blob.slice()],
  ));
  const stateHash = sourceInstance.stateHash(globals, services);
  const hello = new Writer().u8(PROTO_VERSION).u8(1).str("test-source").out();
  const moduleMeta = new Writer()
    .raw(sha256(wasm))
    .u64(wasm.length)
    .bytes(meta)
    .out();
  for (const bytes of [
    frame(FT.HELLO, hello),
    frame(FT.MODULE_META, moduleMeta),
    frame(FT.MODULE_DATA, new Writer().u64(0).raw(wasm).out()),
    frame(FT.FINAL_BEGIN),
    frame(FT.GLOBALS, globals.reduce(
      (writer, [name, value]) => writer.str(name).u32(value),
      new Writer().u16(globals.length),
    ).out()),
    frame(FT.SERVICES, services.reduce(
      (writer, [name, blob]) => writer.str(name).bytes(blob),
      new Writer().u16(services.length),
    ).out()),
    frame(FT.FINAL_END, stateHash),
  ]) transport.push(bytes);
  return acceptMigration(transport, makeTargetServices, {
    runtimeName: "test-target",
    ...opts,
  });
}

function offerEmptyMigration(transport, opts = {}) {
  return offerFinalStateMigration(transport, { opts });
}

test("target rejects non-suspended execution state before PREPARED", async () => {
  for (const control of ["__weave_flag", "__weave_state", "__weave_entry"]) {
    const transport = new PushTransport();
    const accepting = offerFinalStateMigration(transport, {
      mutateGlobals: (globals) => globals.map(([name, value]) => [
        name, name === control ? (control === "__weave_entry" ? 99 : 0) : value,
      ]),
    });
    await assert.rejects(accepting, /not a suspended entry/);
    assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.PREPARED));
  }
});

test("target canonicalizes non-BMP service names by UTF-8 bytes", async () => {
  const names = ["\u{10000}", "\uE000"];
  const transport = new PushTransport();
  const accepting = offerFinalStateMigration(transport, {
    sourceServices: makeNamedTestServices(names),
    makeTargetServices: () => makeNamedTestServices(names),
  });
  await transport.waitForWrite(FT.PREPARED);
  transport.push(frame(FT.COMMIT));
  await accepting;
});

test("built-in emit services reject trailing state before PREPARED", async () => {
  for (const serviceName of makeEmitServices().keys()) {
    const service = makeEmitServices().get(serviceName);
    assert.doesNotThrow(() => service.restore(new Uint8Array(16)));
    assert.throws(
      () => service.restore(new Uint8Array(17)),
      new RegExp(`${serviceName} service state must be exactly 16 bytes`),
    );

    const transport = new PushTransport();
    const accepting = offerFinalStateMigration(transport, {
      sourceServices: makeEmitServices(),
      makeTargetServices: makeEmitServices,
      mutateServices: (services) => services.map(([name, blob]) => [
        name,
        name === serviceName ? new Uint8Array(17) : blob,
      ]),
    });
    // Keep the regression deterministic against the pre-fix behavior: a
    // target that wrongly accepts the trailing byte proceeds through COMMIT
    // immediately instead of sitting at PREPARED until its read deadline.
    transport.push(frame(FT.COMMIT));
    await assert.rejects(
      accepting,
      new RegExp(`${serviceName} service state must be exactly 16 bytes`),
    );
    assert.ok(transport.writes.some((bytes) => bytes[0] === FT.ABORT));
    assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.PREPARED));
  }
});

function finalOnlyMigration(transport, opts = {}) {
  const instance = {
    meta: { memories: [] },
    captureGlobals: () => [],
    serviceBlobs: () => [],
    stateHash: () => new Uint8Array(32),
  };
  const migration = new SourceMigration(transport, instance, "test", opts);
  // Isolate final-copy framing after a simulated successful handshake.
  migration._phase = "precopy";
  migration.syncLayout = async () => {};
  return migration;
}

test("final dirty scan materializes only a bounded page batch", () => {
  const pageSize = 4096;
  const pageCount = 257;
  const memory = new Uint8Array(pageCount * pageSize);
  memory.fill(1);
  const instance = {
    meta: { memories: ["memory"] },
    memBytes: () => memory,
  };
  const tracker = new PageTracker(1);
  let total = 0;
  let largestBatch = 0;
  let expectedPage = 0;
  for (const batch of tracker.scanFullBatches(instance, 7 * pageSize)) {
    largestBatch = Math.max(largestBatch, batch.length);
    for (const [memoryIndex, pageIndex] of batch) {
      assert.equal(memoryIndex, 0);
      assert.equal(pageIndex, expectedPage++);
      total++;
    }
  }
  assert.equal(total, pageCount);
  assert.ok(largestBatch <= 7, `materialized ${largestBatch} pages in one batch`);
  assert.equal(FINAL_SCAN_BATCH_BYTES, 64 * pageSize);
});

test("stop-and-copy writes each batch before scanning the next", async () => {
  const transport = new ScriptTransport([
    frame(FT.PREPARED),
    frame(FT.COMMIT_OK),
  ]);
  const migration = finalOnlyMigration(transport);
  migration.tracker.scanFullBatches = function* () {
    yield [[0, 0, new Uint8Array(4096)]];
    assert.equal(
      transport.writes.filter((bytes) => bytes[0] === FT.PAGE).length,
      1,
      "first page must be written before the second batch is materialized",
    );
    yield [[0, 1, new Uint8Array(4096)]];
  };
  const stats = await migration.finish();
  assert.equal(stats.finalPages, 2);
  assert.equal(transport.writes.filter((bytes) => bytes[0] === FT.PAGE).length, 2);
});

test("source sends COMMIT and confirms the ownership transfer", async () => {
  const transport = new ScriptTransport([
    frame(FT.PREPARED),
    frame(FT.COMMIT_OK),
  ]);
  const stats = await finalOnlyMigration(transport).finish();
  assert.equal(stats.commitConfirmed, true);
  assert.deepEqual(transport.writes.map((bytes) => bytes[0]), [
    FT.FINAL_BEGIN,
    FT.GLOBALS,
    FT.SERVICES,
    FT.FINAL_END,
    FT.COMMIT,
  ]);
  assert.equal(transport.writes.at(-1).length, 5, "COMMIT has an empty payload");
});

test("source still throws before the target is prepared", async () => {
  const transport = new ScriptTransport([]);
  await assert.rejects(finalOnlyMigration(transport).finish(), /scripted peer closed/);
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.COMMIT));
});

test("source uses a finite deadline for a stalled pre-PREPARED read", async () => {
  const transport = new StalledTransport([]);
  await assert.rejects(
    finalOnlyMigration(transport, { readTimeoutMs: 10 }).finish(),
    /timed out waiting for PREPARED after 10 ms/,
  );
  assert.ok(!transport.writes.some((bytes) => bytes[0] === FT.COMMIT));
});

test("source retires without rollback when COMMIT acknowledgement is lost", async () => {
  const transport = new ScriptTransport([frame(FT.PREPARED)]);
  const stats = await finalOnlyMigration(transport).finish();
  assert.equal(stats.commitConfirmed, false);
  assert.match(stats.commitError, /scripted peer closed/);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT);
});

test("source retires when the COMMIT write itself is uncertain", async () => {
  const transport = new ScriptTransport([frame(FT.PREPARED)], FT.COMMIT);
  const stats = await finalOnlyMigration(transport).finish();
  assert.equal(stats.commitConfirmed, false);
  assert.match(stats.commitError, /scripted write failure/);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT);
});

test("source retires after a finite stalled COMMIT_OK deadline", async () => {
  const transport = new StalledTransport([frame(FT.PREPARED)]);
  const stats = await finalOnlyMigration(transport, { commitTimeoutMs: 10 }).finish();
  assert.equal(stats.commitConfirmed, false);
  assert.match(stats.commitError, /timed out waiting for COMMIT_OK after 10 ms/);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT);
});

test("target stays prepared and does not return until COMMIT", async () => {
  const transport = new PushTransport();
  let settled = false;
  const accepting = offerEmptyMigration(transport);
  accepting.then(() => { settled = true; }, () => { settled = true; });
  await transport.waitForWrite(FT.PREPARED);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "target must not become runnable at PREPARED");

  transport.push(frame(FT.COMMIT));
  const accepted = await accepting;
  assert.equal(accepted.sourceRuntime, "test-source");
  assert.equal(accepted.commitAckError, null);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT_OK);
  assert.equal(transport.writes.at(-1).length, 5, "COMMIT_OK has an empty payload");
});

test("target resumes as owner when COMMIT_OK delivery fails", async () => {
  const transport = new PushTransport(FT.COMMIT_OK);
  const accepting = offerEmptyMigration(transport);
  await transport.waitForWrite(FT.PREPARED);
  transport.push(frame(FT.COMMIT));
  const accepted = await accepting;
  assert.match(accepted.commitAckError, /scripted write failure/);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT_OK);
});

test("target resumes as owner when COMMIT_OK write never settles", async () => {
  const transport = new StalledAckWriteTransport();
  const accepting = offerEmptyMigration(transport, { commitAckWriteTimeoutMs: 10 });
  await transport.waitForWrite(FT.PREPARED);
  transport.push(frame(FT.COMMIT));
  const accepted = await accepting;
  assert.match(accepted.commitAckError, /timed out waiting for COMMIT_OK write after 10 ms/);
  assert.equal(transport.writes.at(-1)[0], FT.COMMIT_OK);
});

test("target read deadlines reject stalled inbound sessions before PREPARED", async () => {
  const helloStall = new PushTransport();
  await assert.rejects(
    acceptMigration(helloStall, () => new Map(), {
      runtimeName: "test-target",
      targetReadTimeoutMs: 10,
      targetSessionTimeoutMs: 100,
    }),
    /timed out waiting for HELLO after 10 ms/,
  );

  const precopyStall = new PushTransport();
  const accepting = offerModuleForValidation(precopyStall, minimalWovenModule(), {
    targetReadTimeoutMs: 10,
    targetSessionTimeoutMs: 100,
  });
  await assert.rejects(accepting, /timed out waiting for migration frame after 10 ms/);
  assert.ok(precopyStall.writes.some((bytes) => bytes[0] === FT.MODULE_OK));
  assert.ok(!precopyStall.writes.some((bytes) => bytes[0] === FT.PREPARED));
});
