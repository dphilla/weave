// weave.mjs — the Weave host plugin for JavaScript WebAssembly runtimes
// (browsers, Node, Deno, Bun: anything exposing the standard WebAssembly API).
//
// This is a complete peer of the native plugins: it can run woven modules,
// checkpoint/restore them, and be either end of a live migration against any
// other Weave host (e.g. wasmtime). It is transport-agnostic — the caller
// supplies an object with `readExact(n) -> Promise<Uint8Array>` and
// `write(bytes) -> Promise<void>`; Node's TCP adapter lives in
// weave-node.mjs, a browser would supply a WebSocket bridge.
//
// Because JS hosts are single-threaded, the pre-copy phase uses Weave's
// unwind-yield mechanism: `weave.poll` asks the guest to unwind whenever the
// host needs control (time slice expired or a migration round is due); the
// host does its async work and immediately rewinds via `__weave_resume`.
// The guest's own state machinery makes this yield/resume exact, so the
// workload observes nothing.

// ---------------------------------------------------------------- sha256

export class Sha256 {
  constructor() {
    this.h = new Int32Array([
      0x6a09e667, 0xbb67ae85 | 0, 0x3c6ef372, 0xa54ff53a | 0, 0x510e527f,
      0x9b05688c | 0, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.buf = new Uint8Array(64);
    this.bufLen = 0;
    this.lenLo = 0;
    this.lenHi = 0;
    this.w = new Int32Array(64);
  }

  update(data) {
    if (typeof data === "string") data = new TextEncoder().encode(data);
    let l = this.lenLo + data.length;
    if (l > 0xffffffff) this.lenHi += Math.floor(l / 0x100000000);
    this.lenLo = l >>> 0;

    let off = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      off = take;
      if (this.bufLen === 64) {
        this._block(this.buf, 0);
        this.bufLen = 0;
      }
    }
    while (off + 64 <= data.length) {
      this._block(data, off);
      off += 64;
    }
    if (off < data.length) {
      this.buf.set(data.subarray(off), 0);
      this.bufLen = data.length - off;
    }
    return this;
  }

  _block(p, off) {
    const K = Sha256.K;
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      w[i] =
        (p[off + i * 4] << 24) |
        (p[off + i * 4 + 1] << 16) |
        (p[off + i * 4 + 2] << 8) |
        p[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const H = this.h;
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0;
    H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0;
    H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }

  finish() {
    const bitsLo = (this.lenLo << 3) >>> 0;
    const bitsHi = (this.lenHi * 8 + Math.floor(this.lenLo / 0x20000000)) >>> 0;
    this.update(new Uint8Array([0x80]));
    while (this.bufLen !== 56) {
      this.update(new Uint8Array(1));
    }
    const tail = new Uint8Array(8);
    new DataView(tail.buffer).setUint32(0, bitsHi);
    new DataView(tail.buffer).setUint32(4, bitsLo);
    this.update(tail);
    const out = new Uint8Array(32);
    const dv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) dv.setInt32(i * 4, this.h[i]);
    return out;
  }
}
Sha256.K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf | 0, 0xe9b5dba5 | 0, 0x3956c25b, 0x59f111f1,
  0x923f82a4 | 0, 0xab1c5ed5 | 0, 0xd807aa98 | 0, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe | 0, 0x9bdc06a7 | 0, 0xc19bf174 | 0, 0xe49b69c1 | 0, 0xefbe4786 | 0,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152 | 0, 0xa831c66d | 0, 0xb00327c8 | 0, 0xbf597fc7 | 0, 0xc6e00bf3 | 0, 0xd5a79147 | 0,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e | 0, 0x92722c85 | 0, 0xa2bfe8a1 | 0, 0xa81a664b | 0,
  0xc24b8b70 | 0, 0xc76c51a3 | 0, 0xd192e819 | 0, 0xd6990624 | 0, 0xf40e3585 | 0, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814 | 0, 0x8cc70208 | 0,
  0x90befffa | 0, 0xa4506ceb | 0, 0xbef9a3f7 | 0, 0xc67178f2 | 0,
]);

export function sha256(bytes) {
  return new Sha256().update(bytes).finish();
}

export function pageDigestHex(bytes) {
  const d = sha256(bytes);
  let s = "";
  for (let i = 0; i < 16; i++) s += d[i].toString(16).padStart(2, "0");
  return s;
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------- constants

export const WPAGE = 4096;
export const WASM_PAGE = 65536;
export const FINAL_SCAN_BATCH_BYTES = 256 * 1024;
export const PROTO_VERSION = 2;
export const STATE_RUN = 0, STATE_UNWIND = 1, STATE_REWIND = 2;
export const FLAG_DONE = 0, FLAG_UNWOUND = 1;

export const G = {
  state: "__weave_state",
  flag: "__weave_flag",
  entry: "__weave_entry",
  ctr: "__weave_ctr",
  sp: "__weave_sp",
  stackBase: "__weave_stack_base",
  stackEnd: "__weave_stack_end",
  rbase: "__weave_rbase",
};

const TY = { 0: "i32", 1: "i64", 2: "f32", 3: "f64", 4: "v128", 5: "funcref" };
const UTF8_ENCODER = new TextEncoder();
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function unicodeScalarUtf8(value, what = "string") {
  if (typeof value !== "string") throw new TypeError(`${what} must be a string`);
  const bytes = UTF8_ENCODER.encode(value);
  // TextEncoder silently replaces lone UTF-16 surrogates with U+FFFD. Such a
  // replacement would make the wire name differ from the Map key, so require
  // an exact round trip through canonical, fatal UTF-8 before using it.
  if (UTF8.decode(bytes) !== value) {
    throw new Error(`${what} must be a Unicode scalar string`);
  }
  return bytes;
}

/** Compare JavaScript strings by their unsigned UTF-8 bytes. */
export function compareUtf8Strings(left, right) {
  const a = unicodeScalarUtf8(left, "UTF-8 sort key");
  const b = unicodeScalarUtf8(right, "UTF-8 sort key");
  const common = Math.min(a.length, b.length);
  for (let i = 0; i < common; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

// ---------------------------------------------------------------- meta

class Cursor {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
  need(n) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.b.length - this.pos) {
      throw new Error("truncated protocol payload");
    }
  }
  u8() { this.need(1); return this.b[this.pos++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  u64() { this.need(8); const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
  bytes(n) { this.need(n); const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  str() { const n = this.u32(); return UTF8.decode(this.bytes(n)); }
  types() {
    const n = this.u16();
    const out = [];
    for (let i = 0; i < n; i++) {
      const code = this.u8();
      if (!(code in TY)) throw new Error(`unknown value type ${code}`);
      out.push(TY[code]);
    }
    return out;
  }
  done(context = "protocol payload") {
    if (this.pos !== this.b.length) {
      throw new Error(`${context} has ${this.b.length - this.pos} trailing bytes`);
    }
  }
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function requireUniqueStrings(names, what) {
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== "string") throw new Error(`${what} name must be a string`);
    if (seen.has(name)) throw new Error(`duplicate ${what} name: ${name}`);
    seen.add(name);
  }
}

function requireUnicodeScalarStrings(names, what) {
  for (const name of names) unicodeScalarUtf8(name, `${what} name`);
}

function equalNames(actual, expected) {
  return actual.length === expected.length && actual.every((name, i) => name === expected[i]);
}

/** Parse the weave.meta custom section out of a wasm binary. */
export function extractMeta(wasm) {
  return decodeMeta(rawMetaSection(wasm));
}

function readU32Leb(bytes, state, end, what) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (state.pos >= end) throw new Error(`truncated ${what}`);
    const byte = bytes[state.pos++];
    if (i === 4 && (byte & 0xf0) !== 0) throw new Error(`${what} overflows u32`);
    value += (byte & 0x7f) * 2 ** (i * 7);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error(`${what} is too long`);
}

function readU64Leb(bytes, state, end, what) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (state.pos >= end) throw new Error(`truncated ${what}`);
    const byte = bytes[state.pos++];
    if (i === 9 && (byte & 0xfe) !== 0) throw new Error(`${what} overflows u64`);
    value |= BigInt(byte & 0x7f) << BigInt(i * 7);
    if ((byte & 0x80) === 0) return value;
  }
  throw new Error(`${what} is too long`);
}

function skipName(bytes, state, end, what) {
  const length = readU32Leb(bytes, state, end, `${what} length`);
  if (length > end - state.pos) throw new Error(`${what} extends past its section`);
  // Decode now so malformed UTF-8 cannot hide a different import contract.
  UTF8.decode(bytes.subarray(state.pos, state.pos + length));
  state.pos += length;
}

function readName(bytes, state, end, what) {
  const length = readU32Leb(bytes, state, end, `${what} length`);
  if (length > end - state.pos) throw new Error(`${what} extends past its section`);
  const name = UTF8.decode(bytes.subarray(state.pos, state.pos + length));
  state.pos += length;
  return name;
}

function skipReferenceType(bytes, state, end, what) {
  if (state.pos >= end) throw new Error(`truncated ${what}`);
  const type = bytes[state.pos++];
  // Core funcref/externref are single-byte types. Typed reference encodings
  // carry a signed heap-type LEB, which we only need to bound and skip here.
  if (type !== 0x63 && type !== 0x64) return;
  for (let i = 0; i < 5; i++) {
    if (state.pos >= end) throw new Error(`truncated ${what}`);
    if ((bytes[state.pos++] & 0x80) === 0) return;
  }
  throw new Error(`${what} heap type is too long`);
}

function memoryLimits(bytes, state, end, what) {
  const flags = readU32Leb(bytes, state, end, `${what} flags`);
  if ((flags & ~0x7) !== 0) throw new Error(`${what} has unsupported flags 0x${flags.toString(16)}`);
  const memory64 = (flags & 0x4) !== 0;
  const readPageCount = (label) => memory64
    ? readU64Leb(bytes, state, end, label)
    : BigInt(readU32Leb(bytes, state, end, label));
  const initial = readPageCount(`${what} initial size`);
  if ((flags & 0x1) !== 0) readPageCount(`${what} maximum size`);
  return initial;
}

/** Return the aggregate declared initial linear-memory size without instantiating. */
export function declaredInitialMemoryBytes(wasm) {
  if (!ArrayBuffer.isView(wasm) || wasm.BYTES_PER_ELEMENT !== 1) {
    throw new Error("WebAssembly module bytes must be a byte array");
  }
  if (
    wasm.length < 8 ||
    wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d ||
    wasm[4] !== 0x01 || wasm[5] !== 0x00 || wasm[6] !== 0x00 || wasm[7] !== 0x00
  ) {
    throw new Error("not a WebAssembly 1 module");
  }

  let pages = 0n;
  const state = { pos: 8 };
  while (state.pos < wasm.length) {
    const id = wasm[state.pos++];
    const size = readU32Leb(wasm, state, wasm.length, "section size");
    const sectionEnd = state.pos + size;
    if (!Number.isSafeInteger(sectionEnd) || sectionEnd > wasm.length) {
      throw new Error("WebAssembly section extends past end of module");
    }
    if (id === 2) {
      const count = readU32Leb(wasm, state, sectionEnd, "import count");
      for (let i = 0; i < count; i++) {
        skipName(wasm, state, sectionEnd, "import module name");
        skipName(wasm, state, sectionEnd, "import field name");
        if (state.pos >= sectionEnd) throw new Error("truncated import descriptor");
        const kind = wasm[state.pos++];
        switch (kind) {
          case 0: // function
            readU32Leb(wasm, state, sectionEnd, "function type index");
            break;
          case 1: // table
            skipReferenceType(wasm, state, sectionEnd, "table reference type");
            memoryLimits(wasm, state, sectionEnd, "table limits");
            break;
          case 2: // memory
            pages += memoryLimits(wasm, state, sectionEnd, "imported memory");
            break;
          case 3: // global
            skipReferenceType(wasm, state, sectionEnd, "global value type");
            if (state.pos >= sectionEnd) throw new Error("truncated global mutability");
            state.pos++;
            break;
          case 4: // exception tag (rejected by the transformer, but bounded here)
            if (state.pos >= sectionEnd) throw new Error("truncated tag attribute");
            state.pos++;
            readU32Leb(wasm, state, sectionEnd, "tag type index");
            break;
          default:
            throw new Error(`unknown import descriptor ${kind}`);
        }
      }
      if (state.pos !== sectionEnd) throw new Error("import section has trailing bytes");
    } else if (id === 5) {
      const count = readU32Leb(wasm, state, sectionEnd, "memory count");
      for (let i = 0; i < count; i++) {
        pages += memoryLimits(wasm, state, sectionEnd, "defined memory");
      }
      if (state.pos !== sectionEnd) throw new Error("memory section has trailing bytes");
    }
    state.pos = sectionEnd;
  }
  return pages * 65536n;
}

const CORE_VALUE_TYPE = new Map([
  [0x7f, "i32"],
  [0x7e, "i64"],
  [0x7d, "f32"],
  [0x7c, "f64"],
  [0x7b, "v128"],
  [0x70, "funcref"],
]);
const FIXED_CONTROL_GLOBALS = Object.freeze([
  G.state,
  G.flag,
  G.entry,
  G.ctr,
  G.sp,
  G.stackBase,
  G.stackEnd,
  G.rbase,
]);

function readCoreValueType(bytes, state, end, what) {
  if (state.pos >= end) throw new Error(`truncated ${what}`);
  const code = bytes[state.pos++];
  const type = CORE_VALUE_TYPE.get(code);
  if (type === undefined) {
    throw new Error(`${what} has unsupported value type 0x${code.toString(16)}`);
  }
  return type;
}

function readTypeVector(bytes, state, end, what) {
  const count = readU32Leb(bytes, state, end, `${what} count`);
  // Every supported value type consumes at least one byte. Bound the loop and
  // its allocation before trusting an attacker-controlled vector length.
  if (count > end - state.pos) throw new Error(`${what} count exceeds its section`);
  const types = [];
  for (let i = 0; i < count; i++) {
    types.push(readCoreValueType(bytes, state, end, `${what} ${i}`));
  }
  return types;
}

function readGlobalType(bytes, state, end, what) {
  const value = readCoreValueType(bytes, state, end, `${what} value type`);
  if (state.pos >= end) throw new Error(`truncated ${what} mutability`);
  const flags = bytes[state.pos++];
  if ((flags & ~0x3) !== 0) {
    throw new Error(`${what} has invalid flags ${flags}`);
  }
  return { value, mutable: (flags & 0x1) !== 0, shared: (flags & 0x2) !== 0 };
}

function skipLeb(bytes, state, end, maxBytes, what) {
  for (let i = 0; i < maxBytes; i++) {
    if (state.pos >= end) throw new Error(`truncated ${what}`);
    if ((bytes[state.pos++] & 0x80) === 0) return;
  }
  throw new Error(`${what} is too long`);
}

function skipConstExpr(bytes, state, end, what) {
  for (;;) {
    if (state.pos >= end) throw new Error(`truncated ${what}`);
    const opcode = bytes[state.pos++];
    switch (opcode) {
      case 0x0b: // end
        return;
      case 0x23: // global.get
      case 0xd2: // ref.func
        readU32Leb(bytes, state, end, `${what} index`);
        break;
      case 0x41: // i32.const
        skipLeb(bytes, state, end, 5, `${what} i32 constant`);
        break;
      case 0x42: // i64.const
        skipLeb(bytes, state, end, 10, `${what} i64 constant`);
        break;
      case 0x43: // f32.const
        if (end - state.pos < 4) throw new Error(`truncated ${what} f32 constant`);
        state.pos += 4;
        break;
      case 0x44: // f64.const
        if (end - state.pos < 8) throw new Error(`truncated ${what} f64 constant`);
        state.pos += 8;
        break;
      case 0xd0: // ref.null heap type
        skipLeb(bytes, state, end, 5, `${what} reference heap type`);
        break;
      case 0xfd: { // SIMD prefix; v128.const is the only constant opcode here
        const simdOpcode = readU32Leb(bytes, state, end, `${what} SIMD opcode`);
        if (simdOpcode !== 12) {
          throw new Error(`${what} has unsupported SIMD opcode ${simdOpcode}`);
        }
        if (end - state.pos < 16) throw new Error(`truncated ${what} v128 constant`);
        state.pos += 16;
        break;
      }
      default:
        throw new Error(`${what} has unsupported opcode 0x${opcode.toString(16)}`);
    }
  }
}

function sameTypes(actual, expected) {
  return actual.length === expected.length && actual.every((type, i) => type === expected[i]);
}

/**
 * Validate the host-visible woven ABI directly from bounded core-Wasm
 * sections. WebAssembly.Module.exports() exposes export kinds but not function
 * signatures, global mutability, or the memory index behind each name.
 */
export function validateModuleAbi(wasm, meta = extractMeta(wasm)) {
  if (!ArrayBuffer.isView(wasm) || wasm.BYTES_PER_ELEMENT !== 1) {
    throw new Error("WebAssembly module bytes must be a byte array");
  }
  if (
    wasm.length < 8 ||
    wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d ||
    wasm[4] !== 0x01 || wasm[5] !== 0x00 || wasm[6] !== 0x00 || wasm[7] !== 0x00
  ) {
    throw new Error("not a WebAssembly 1 module");
  }

  requireUniqueStrings(meta.entries.map(({ name }) => name), "entry");
  requireUniqueStrings(meta.memories, "memory export");
  requireUniqueStrings(meta.controlGlobals, "control global");

  const expectedResultsArea = meta.entries.reduce(
    (largest, entry) => Math.max(largest, entry.results.length),
    0,
  ) * 16;
  if (meta.resultsAreaSize !== expectedResultsArea) {
    throw new Error(
      `weave.meta results-area size mismatch: expected ${expectedResultsArea}, got ${meta.resultsAreaSize}`,
    );
  }
  if (meta.globalsAreaSize % 16 !== 0) {
    throw new Error("weave.meta globals-area size is not 16-byte aligned");
  }
  if (
    meta.controlGlobals.length < FIXED_CONTROL_GLOBALS.length ||
    !FIXED_CONTROL_GLOBALS.every((name, i) => meta.controlGlobals[i] === name)
  ) {
    throw new Error("weave.meta control globals do not have the required fixed prefix/order");
  }
  const tableShadows = meta.controlGlobals.slice(FIXED_CONTROL_GLOBALS.length);
  if (tableShadows.length % 2 !== 0) {
    throw new Error("weave.meta table-shadow control globals are incomplete");
  }
  const tableShadowCount = tableShadows.length / 2;
  for (let table = 0; table < tableShadowCount; table++) {
    if (
      tableShadows[table] !== `__weave_tsh${table}` ||
      tableShadows[tableShadowCount + table] !== `__weave_tshcap${table}`
    ) {
      throw new Error("weave.meta table-shadow control globals are out of order");
    }
  }

  const types = [];
  const importedFunctionTypes = [];
  const definedFunctionTypes = [];
  const importedGlobalTypes = [];
  const definedGlobalTypes = [];
  const exports = new Map();
  let memoryCount = 0;
  const state = { pos: 8 };

  while (state.pos < wasm.length) {
    const id = wasm[state.pos++];
    const size = readU32Leb(wasm, state, wasm.length, "section size");
    const sectionEnd = state.pos + size;
    if (!Number.isSafeInteger(sectionEnd) || sectionEnd > wasm.length) {
      throw new Error("WebAssembly section extends past end of module");
    }
    // A start function runs as part of WebAssembly.instantiate(), before a
    // migration target can validate final state or receive COMMIT. Woven
    // workloads enter only through __weave_init/__weave_resume, so a start
    // section is both outside the ABI and unsafe for staged target creation.
    if (id === 8) {
      throw new Error("woven WebAssembly modules must not define a start section");
    }

    if (id === 1) {
      const count = readU32Leb(wasm, state, sectionEnd, "type count");
      if (count > sectionEnd - state.pos) throw new Error("type count exceeds its section");
      for (let i = 0; i < count; i++) {
        if (state.pos >= sectionEnd) throw new Error("truncated function type");
        const form = wasm[state.pos++];
        if (form !== 0x60) {
          throw new Error(`unsupported non-function type form 0x${form.toString(16)}`);
        }
        types.push({
          params: readTypeVector(wasm, state, sectionEnd, `function type ${i} parameters`),
          results: readTypeVector(wasm, state, sectionEnd, `function type ${i} results`),
        });
      }
      if (state.pos !== sectionEnd) throw new Error("type section has trailing bytes");
    } else if (id === 2) {
      const count = readU32Leb(wasm, state, sectionEnd, "import count");
      if (count > sectionEnd - state.pos) throw new Error("import count exceeds its section");
      for (let i = 0; i < count; i++) {
        skipName(wasm, state, sectionEnd, "import module name");
        skipName(wasm, state, sectionEnd, "import field name");
        if (state.pos >= sectionEnd) throw new Error("truncated import descriptor");
        const kind = wasm[state.pos++];
        switch (kind) {
          case 0:
            importedFunctionTypes.push(
              readU32Leb(wasm, state, sectionEnd, "imported function type index"),
            );
            break;
          case 1:
            skipReferenceType(wasm, state, sectionEnd, "imported table reference type");
            memoryLimits(wasm, state, sectionEnd, "imported table limits");
            break;
          case 2:
            memoryLimits(wasm, state, sectionEnd, "imported memory");
            memoryCount++;
            break;
          case 3:
            importedGlobalTypes.push(readGlobalType(wasm, state, sectionEnd, "imported global"));
            break;
          case 4:
            if (state.pos >= sectionEnd) throw new Error("truncated tag attribute");
            state.pos++;
            readU32Leb(wasm, state, sectionEnd, "tag type index");
            break;
          default:
            throw new Error(`unknown import descriptor ${kind}`);
        }
      }
      if (state.pos !== sectionEnd) throw new Error("import section has trailing bytes");
    } else if (id === 3) {
      const count = readU32Leb(wasm, state, sectionEnd, "function count");
      if (count > sectionEnd - state.pos) throw new Error("function count exceeds its section");
      for (let i = 0; i < count; i++) {
        definedFunctionTypes.push(
          readU32Leb(wasm, state, sectionEnd, "defined function type index"),
        );
      }
      if (state.pos !== sectionEnd) throw new Error("function section has trailing bytes");
    } else if (id === 5) {
      const count = readU32Leb(wasm, state, sectionEnd, "memory count");
      if (count > sectionEnd - state.pos) throw new Error("memory count exceeds its section");
      for (let i = 0; i < count; i++) {
        memoryLimits(wasm, state, sectionEnd, "defined memory");
        memoryCount++;
      }
      if (state.pos !== sectionEnd) throw new Error("memory section has trailing bytes");
    } else if (id === 6) {
      const count = readU32Leb(wasm, state, sectionEnd, "global count");
      if (count > sectionEnd - state.pos) throw new Error("global count exceeds its section");
      for (let i = 0; i < count; i++) {
        definedGlobalTypes.push(readGlobalType(wasm, state, sectionEnd, `global ${i}`));
        skipConstExpr(wasm, state, sectionEnd, `global ${i} initializer`);
      }
      if (state.pos !== sectionEnd) throw new Error("global section has trailing bytes");
    } else if (id === 7) {
      const count = readU32Leb(wasm, state, sectionEnd, "export count");
      if (count > sectionEnd - state.pos) throw new Error("export count exceeds its section");
      for (let i = 0; i < count; i++) {
        const name = readName(wasm, state, sectionEnd, "export name");
        if (state.pos >= sectionEnd) throw new Error("truncated export descriptor");
        const kind = wasm[state.pos++];
        if (kind > 4) throw new Error(`unknown export descriptor ${kind}`);
        const index = readU32Leb(wasm, state, sectionEnd, "export index");
        if (exports.has(name)) throw new Error(`module contains duplicate export ${name}`);
        exports.set(name, { kind, index });
      }
      if (state.pos !== sectionEnd) throw new Error("export section has trailing bytes");
    }
    state.pos = sectionEnd;
  }

  const functionTypes = [...importedFunctionTypes, ...definedFunctionTypes];
  const globalTypes = [...importedGlobalTypes, ...definedGlobalTypes];
  const checkFunction = (name, expectedParams, expectedResults) => {
    const exported = exports.get(name);
    if (exported === undefined) throw new Error(`module has no exported function ${name}`);
    if (exported.kind !== 0) throw new Error(`module export ${name} is not a function`);
    const typeIndex = functionTypes[exported.index];
    if (typeIndex === undefined) {
      throw new Error(`exported function ${name} has an invalid function index`);
    }
    const signature = types[typeIndex];
    if (signature === undefined) {
      throw new Error(`exported function ${name} has an invalid type index`);
    }
    if (!sameTypes(signature.params, expectedParams) || !sameTypes(signature.results, expectedResults)) {
      throw new Error(
        `exported function ${name} signature mismatch: weave.meta expects ` +
        `${JSON.stringify(expectedParams)} -> ${JSON.stringify(expectedResults)}, module has ` +
        `${JSON.stringify(signature.params)} -> ${JSON.stringify(signature.results)}`,
      );
    }
  };

  checkFunction("__weave_init", [], []);
  checkFunction("__weave_resume", [], []);
  for (const entry of meta.entries) {
    if (entry.name === "__weave_init" || entry.name === "__weave_resume") {
      throw new Error(`weave.meta entry ${entry.name} collides with a runtime export`);
    }
    checkFunction(entry.name, entry.params, entry.results);
  }

  if (meta.memories.length !== memoryCount) {
    throw new Error(
      `weave.meta memory count mismatch: module has ${memoryCount} memories, metadata lists ${meta.memories.length}`,
    );
  }
  for (let i = 0; i < meta.memories.length; i++) {
    const name = meta.memories[i];
    const exported = exports.get(name);
    if (exported === undefined) throw new Error(`module has no memory export ${name}`);
    if (exported.kind !== 2) throw new Error(`module export ${name} is not a memory`);
    if (exported.index !== i) {
      throw new Error(
        `weave.meta memory ${i} names export ${name}, but that export maps to memory ${exported.index}`,
      );
    }
  }

  const actualControlGlobals = [...exports.entries()]
    .filter(([name, exported]) => name.startsWith("__weave") && exported.kind === 3)
    .map(([name]) => name);
  if (!equalNames(actualControlGlobals, meta.controlGlobals)) {
    throw new Error(
      "weave.meta control globals do not match the module's complete injected global-export set",
    );
  }
  const controlGlobalIndices = new Set();
  for (const name of meta.controlGlobals) {
    const exported = exports.get(name);
    if (exported === undefined) throw new Error(`module has no exported control global ${name}`);
    if (exported.kind !== 3) throw new Error(`control-global export ${name} is not a global`);
    const type = globalTypes[exported.index];
    if (type === undefined) throw new Error(`control-global export ${name} has an invalid global index`);
    if (type.value !== "i32" || !type.mutable || type.shared) {
      throw new Error(`exported control global ${name} must be mutable i32`);
    }
    if (controlGlobalIndices.has(exported.index)) {
      throw new Error(`control global ${exported.index} is listed more than once`);
    }
    controlGlobalIndices.add(exported.index);
  }
}

function findCustomSection(wasm, wantedName) {
  if (!ArrayBuffer.isView(wasm) || wasm.BYTES_PER_ELEMENT !== 1) {
    throw new Error("WebAssembly module bytes must be a byte array");
  }
  if (
    wasm.length < 8 ||
    wasm[0] !== 0x00 || wasm[1] !== 0x61 || wasm[2] !== 0x73 || wasm[3] !== 0x6d ||
    wasm[4] !== 0x01 || wasm[5] !== 0x00 || wasm[6] !== 0x00 || wasm[7] !== 0x00
  ) {
    throw new Error("not a WebAssembly 1 module");
  }

  const state = { pos: 8 };
  while (state.pos < wasm.length) {
    const id = wasm[state.pos++];
    const size = readU32Leb(wasm, state, wasm.length, "section size");
    const sectionEnd = state.pos + size;
    if (!Number.isSafeInteger(sectionEnd) || sectionEnd > wasm.length) {
      throw new Error("WebAssembly section extends past end of module");
    }
    if (id === 0) {
      const nameLength = readU32Leb(wasm, state, sectionEnd, "custom-section name length");
      if (nameLength > sectionEnd - state.pos) {
        throw new Error("custom-section name extends past end of section");
      }
      const name = UTF8.decode(wasm.subarray(state.pos, state.pos + nameLength));
      state.pos += nameLength;
      if (name === wantedName) return wasm.subarray(state.pos, sectionEnd).slice();
    }
    state.pos = sectionEnd;
  }
  throw new Error(`module has no ${wantedName} section (run \`weave transform\` first)`);
}

export function decodeMeta(payload) {
  const c = new Cursor(payload);
  const magic = new TextDecoder().decode(c.bytes(4));
  if (magic !== "WVMT") throw new Error("bad weave.meta magic");
  const version = c.u16();
  if (version !== 1) throw new Error(`unsupported weave.meta version ${version}`);
  const pollPeriod = c.u32();
  const entries = [];
  const nEntries = c.u16();
  for (let i = 0; i < nEntries; i++) {
    entries.push({ name: c.str(), params: c.types(), results: c.types() });
  }
  const memories = [];
  const nMems = c.u16();
  for (let i = 0; i < nMems; i++) memories.push(c.str());
  const imports = [];
  const nImports = c.u16();
  for (let i = 0; i < nImports; i++) {
    imports.push({ module: c.str(), name: c.str(), params: c.types(), results: c.types() });
  }
  const controlGlobals = [];
  const nCg = c.u16();
  for (let i = 0; i < nCg; i++) controlGlobals.push(c.str());
  const globalsAreaSize = c.u32();
  const resultsAreaSize = c.u32();
  c.done("weave.meta");
  return {
    version,
    pollPeriod,
    entries,
    memories,
    imports,
    controlGlobals,
    globalsAreaSize,
    resultsAreaSize,
  };
}

// ---------------------------------------------------------------- wire

export const FT = {
  HELLO: 1, MODULE_META: 2, MODULE_NEED: 3, MODULE_HAVE: 4, MODULE_DATA: 5,
  MODULE_OK: 6, MEM_LAYOUT: 7, PAGE: 8, ROUND_END: 9, ROUND_ACK: 10,
  FINAL_BEGIN: 11, GLOBALS: 12, SERVICES: 13, FINAL_END: 14, PREPARED: 15,
  ABORT: 16, CTL_MIGRATE: 17, CTL_STATUS: 18, CTL_OK: 19, CTL_ERR: 20,
  COMMIT: 21, COMMIT_OK: 22,
};

export function frame(type, payload = new Uint8Array(0)) {
  if (!(payload instanceof Uint8Array)) throw new TypeError("frame payload must be Uint8Array");
  if (payload.length > 64 * 1024 * 1024) {
    throw new Error(`frame payload too large: ${payload.length}`);
  }
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, payload.length, true);
  out.set(payload, 5);
  return out;
}

export class Writer {
  constructor() { this.parts = []; this.len = 0; }
  u8(v) { this.parts.push(new Uint8Array([v])); this.len += 1; return this; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this.parts.push(b); this.len += 2; return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.parts.push(b); this.len += 4; return this; }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this.parts.push(b); this.len += 8; return this; }
  raw(bytes) { this.parts.push(bytes); this.len += bytes.length; return this; }
  str(s) { const b = new TextEncoder().encode(s); this.u32(b.length); this.raw(b); return this; }
  bytes(b) { this.u32(b.length); this.raw(b); return this; }
  out() {
    const out = new Uint8Array(this.len);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

/** Read one frame from a transport. Returns {type, payload}. */
export async function readFrame(t) {
  const hdr = await t.readExact(5);
  if (!(hdr instanceof Uint8Array) || hdr.length !== 5) {
    throw new Error("transport returned a short frame header");
  }
  const type = hdr[0];
  const len = new DataView(hdr.buffer, hdr.byteOffset).getUint32(1, true);
  if (len > 64 * 1024 * 1024) throw new Error(`frame too large: ${len}`);
  const payload = len ? await t.readExact(len) : new Uint8Array(0);
  if (!(payload instanceof Uint8Array) || payload.length !== len) {
    throw new Error("transport returned a short frame payload");
  }
  return { type, payload };
}

function withDeadline(operation, timeoutMs, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what} after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- instance

/**
 * services: Map name -> { imports: {module: {name: fn}}, snapshot(): Uint8Array,
 *                         restore(bytes): void }
 * restore() stages a fresh target before COMMIT and must not publish external
 * effects; fence external resource ownership at the application layer.
 */
export class WeaveInstance {
  constructor(wasmBytes, services, opts = {}) {
    this.wasmBytes = wasmBytes;
    this.moduleHash = sha256(wasmBytes);
    this.meta = extractMeta(wasmBytes);
    if (!(services instanceof Map)) throw new Error("services must be a Map");
    if (this.meta.memories.length > 255) {
      throw new Error("module has too many memories for migration wire format");
    }
    requireUniqueStrings(this.meta.memories, "memory export");
    requireUniqueStrings(this.meta.controlGlobals, "control global");
    validateModuleAbi(wasmBytes, this.meta);
    const serviceNames = [...services.keys()];
    requireUniqueStrings(serviceNames, "host service");
    requireUnicodeScalarStrings(serviceNames, "host service");
    this.services = services;
    this.yieldMs = opts.yieldMs ?? 50;
    this.lastYield = 0;
    // poll behavior: "run" | "unwind" | {afterPolls: n}
    this.pollMode = "run";
    this.pollCount = 0;
    this.instance = null;
  }

  async instantiate() {
    const imports = { weave: { poll: () => this._poll() } };
    for (const svc of this.services.values()) {
      for (const [mod, fns] of Object.entries(svc.imports ?? {})) {
        imports[mod] = { ...(imports[mod] ?? {}), ...fns };
      }
    }
    const { instance } = await WebAssembly.instantiate(this.wasmBytes, imports);
    this.instance = instance;
    return this;
  }

  _poll() {
    this.pollCount++;
    if (this.pollMode === "unwind") return 1;
    if (typeof this.pollMode === "object" && "afterPolls" in this.pollMode) {
      if (this.pollMode.afterPolls <= 0) return 1;
      this.pollMode.afterPolls--;
      return 0;
    }
    // time-sliced yield so the event loop (and control traffic) can breathe
    if (Date.now() - this.lastYield >= this.yieldMs) return 1;
    return 0;
  }

  ex() { return this.instance.exports; }
  g(name) { return this.ex()[name].value | 0; }
  setG(name, v) { this.ex()[name].value = v | 0; }
  mem(i = 0) { return this.ex()[this.meta.memories[i]]; }
  memBytes(i = 0) { return new Uint8Array(this.mem(i).buffer); }

  init() {
    this.ex().__weave_init();
  }

  /**
   * Run an entry (or resume) cooperatively until it completes or a callback
   * asks to keep the unwound state.
   *
   * onYield: async ({instance}) => "continue" | "hold"
   *   Called at every unwind. "continue" rewinds immediately; "hold" stops the
   *   driver loop with the guest checkpointed in memory.
   *
   * Returns {status: "done", results} | {status: "held"}.
   */
  async drive(entry, args, onYield) {
    let phase = entry === null ? "resume" : "start";
    for (;;) {
      this.lastYield = Date.now();
      if (phase === "start") {
        this.setG(G.state, STATE_RUN);
        this.ex()[entry](...args);
        phase = "resume";
      } else {
        this.ex().__weave_resume();
      }
      if (this.g(G.flag) === FLAG_DONE) {
        return { status: "done", results: this.readResults() };
      }
      // unwound
      const verdict = onYield ? await onYield(this) : "continue";
      if (verdict === "hold") return { status: "held" };
      // fall through: rewind and continue
    }
  }

  readResults() {
    const entryIdx = this.g(G.entry);
    const entry = this.meta.entries[entryIdx];
    const rbase = this.g(G.rbase) >>> 0;
    const base = rbase + this.meta.globalsAreaSize;
    const dv = new DataView(this.mem(0).buffer);
    return entry.results.map((ty, i) => {
      const off = base + i * 16;
      switch (ty) {
        case "i32": return dv.getInt32(off, true);
        case "i64": return dv.getBigInt64(off, true);
        case "f32": return dv.getFloat32(off, true);
        case "f64": return dv.getFloat64(off, true);
        case "v128": return new Uint8Array(dv.buffer, off, 16).slice();
        default: throw new Error(`unsupported result type ${ty}`);
      }
    });
  }

  captureGlobals() {
    return this.meta.controlGlobals.map((n) => [n, this.g(n)]);
  }

  serviceBlobs() {
    const names = [...this.services.keys()].sort(compareUtf8Strings);
    return names.map((n) => [n, this.services.get(n).snapshot()]);
  }

  restoreServices(blobs) {
    const expected = [...this.services.keys()].sort(compareUtf8Strings);
    const actual = blobs.map(([name]) => name);
    if (!equalNames(actual, expected)) throw new Error("host-service contract mismatch");
    for (const [name, blob] of blobs) {
      const svc = this.services.get(name);
      svc.restore(blob);
    }
  }

  growMemTo(i, pages) {
    const mem = this.mem(i);
    const cur = mem.buffer.byteLength / WASM_PAGE;
    if (pages > cur) mem.grow(pages - cur);
  }

  stateHash(globals, services) {
    const h = new Sha256();
    h.update("WVSH");
    const w = new Writer();
    w.u32(this.meta.memories.length);
    h.update(w.out());
    for (let m = 0; m < this.meta.memories.length; m++) {
      const bytes = this.memBytes(m);
      const lw = new Writer();
      lw.u64(bytes.length);
      h.update(lw.out());
      h.update(bytes);
    }
    const gw = new Writer();
    gw.u32(globals.length);
    for (const [n, v] of globals) {
      gw.str(n);
      gw.u32(v >>> 0);
    }
    h.update(gw.out());
    const sorted = [...services].sort((a, b) => compareUtf8Strings(a[0], b[0]));
    const sw = new Writer();
    sw.u32(sorted.length);
    for (const [n, blob] of sorted) {
      sw.str(n);
      sw.u64(blob.length);
      sw.raw(blob);
    }
    h.update(sw.out());
    return h.finish();
  }
}

// ---------------------------------------------------------------- migration: source

export class PageTracker {
  constructor(nMems) {
    this.digests = Array.from({ length: nMems }, () => []);
    this.cursorMem = 0;
    this.cursorPage = 0;
    this.round = 0;
  }

  /** Scan up to budgetBytes; returns {pages: [[mem, pageNo, bytes]...], roundComplete} */
  scanStep(inst, budgetBytes) {
    const pages = [];
    let scanned = 0;
    const nMems = inst.meta.memories.length;
    for (;;) {
      if (this.cursorMem >= nMems) {
        this.cursorMem = 0;
        this.cursorPage = 0;
        this.round++;
        return { pages, roundComplete: true };
      }
      const bytes = inst.memBytes(this.cursorMem);
      const nPages = Math.floor(bytes.length / WPAGE);
      const dig = this.digests[this.cursorMem];
      while (dig.length < nPages) dig.push(null); // null = known-zero, never sent
      if (this.cursorPage >= nPages) {
        this.cursorMem++;
        this.cursorPage = 0;
        continue;
      }
      if (scanned >= budgetBytes) return { pages, roundComplete: false };
      const off = this.cursorPage * WPAGE;
      const page = bytes.subarray(off, off + WPAGE);
      scanned += WPAGE;
      const prev = dig[this.cursorPage];
      let allZero = prev === null;
      if (allZero) {
        for (let i = 0; i < WPAGE; i++) {
          if (page[i] !== 0) { allZero = false; break; }
        }
      }
      if (!(prev === null && allZero)) {
        const d = pageDigestHex(page);
        if (d !== prev) {
          dig[this.cursorPage] = d;
          pages.push([this.cursorMem, this.cursorPage, page.slice()]);
        }
      }
      this.cursorPage++;
    }
  }

  *scanFullBatches(inst, budgetBytes = FINAL_SCAN_BATCH_BYTES) {
    if (!Number.isSafeInteger(budgetBytes) || budgetBytes <= 0) {
      throw new RangeError("final scan budget must be a positive safe integer");
    }
    for (;;) {
      const step = this.scanStep(inst, budgetBytes);
      if (step.pages.length > 0) yield step.pages;
      if (step.roundComplete) return;
    }
  }
}

export class SourceMigration {
  /**
   * transport: {readExact, write} — an open connection to the target.
   */
  constructor(transport, inst, runtimeName, opts = {}) {
    this.t = transport;
    this.inst = inst;
    this.runtimeName = runtimeName;
    this.tracker = new PageTracker(inst.meta.memories.length);
    this.sentLayout = [];
    this.roundPages = 0;
    this.roundsCompleted = 0;
    this.totalPages = 0;
    this.budget = opts.budgetBytes ?? 8 << 20;
    this.dirtyThreshold = opts.dirtyPageThreshold ?? 64;
    this.maxRounds = opts.maxRounds ?? 10;
    this.readTimeoutMs = opts.readTimeoutMs ?? 120_000;
    this.commitTimeoutMs = opts.commitTimeoutMs ?? 15_000;
    for (const [name, value] of [
      ["readTimeoutMs", this.readTimeoutMs],
      ["commitTimeoutMs", this.commitTimeoutMs],
    ]) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    this.converged = false;
  }

  _readFrame(what) {
    return withDeadline(readFrame(this.t), this.readTimeoutMs, what);
  }

  async handshake() {
    const hw = new Writer();
    hw.u8(PROTO_VERSION).u8(1).str(this.runtimeName);
    await this.t.write(frame(FT.HELLO, hw.out()));
    const hello = await this._readFrame("HELLO");
    if (hello.type !== FT.HELLO) throw abortError(hello);
    const hc = new Cursor(hello.payload);
    const proto = hc.u8();
    const role = hc.u8();
    hc.str(); // target runtime name (diagnostic only)
    hc.done("HELLO");
    if (proto !== PROTO_VERSION) {
      throw new Error(`target speaks protocol ${proto}, need ${PROTO_VERSION}`);
    }
    if (role !== 2) throw new Error(`expected target role, got ${role}`);
    // module sync (the meta blob is the raw weave.meta section payload)
    const metaBytes = rawMetaSection(this.inst.wasmBytes);
    const mm2 = new Writer();
    mm2.raw(this.inst.moduleHash);
    mm2.u64(this.inst.wasmBytes.length);
    mm2.bytes(metaBytes);
    await this.t.write(frame(FT.MODULE_META, mm2.out()));
    const resp = await this._readFrame("MODULE_HAVE or MODULE_NEED");
    if (resp.type === FT.MODULE_NEED) {
      if (resp.payload.length !== 0) throw new Error("MODULE_NEED must have an empty payload");
      const CHUNK = 256 * 1024;
      for (let off = 0; off < this.inst.wasmBytes.length; off += CHUNK) {
        const chunk = this.inst.wasmBytes.subarray(off, Math.min(off + CHUNK, this.inst.wasmBytes.length));
        const dw = new Writer();
        dw.u64(off);
        dw.raw(chunk);
        await this.t.write(frame(FT.MODULE_DATA, dw.out()));
      }
    } else if (resp.type === FT.MODULE_HAVE) {
      if (resp.payload.length !== 0) throw new Error("MODULE_HAVE must have an empty payload");
    } else {
      throw abortError(resp);
    }
    const ok = await this._readFrame("MODULE_OK");
    if (ok.type !== FT.MODULE_OK) throw abortError(ok);
    if (ok.payload.length !== 0) throw new Error("MODULE_OK must have an empty payload");
  }

  async syncLayout() {
    const cur = this.inst.meta.memories.map(
      (_, i) => Math.floor(this.inst.memBytes(i).length / WASM_PAGE),
    );
    if (JSON.stringify(cur) !== JSON.stringify(this.sentLayout)) {
      const w = new Writer();
      w.u8(cur.length);
      for (const p of cur) w.u64(p);
      await this.t.write(frame(FT.MEM_LAYOUT, w.out()));
      this.sentLayout = cur;
    }
  }

  /** One pre-copy round step. Returns true when converged (go final). */
  async precopyStep() {
    if (this.converged) return true;
    await this.syncLayout();
    const step = this.tracker.scanStep(this.inst, this.budget);
    for (const [mem, pageNo, bytes] of step.pages) {
      this.roundPages++;
      this.totalPages++;
      const w = new Writer();
      w.u8(mem).u64(pageNo).raw(bytes);
      await this.t.write(frame(FT.PAGE, w.out()));
    }
    if (step.roundComplete) {
      this.roundsCompleted++;
      const w = new Writer();
      w.u32(this.roundsCompleted).u64(this.roundPages);
      await this.t.write(frame(FT.ROUND_END, w.out()));
      const ack = await this._readFrame("ROUND_ACK");
      if (ack.type !== FT.ROUND_ACK) throw abortError(ack);
      if (ack.payload.length !== 0) throw new Error("ROUND_ACK must have an empty payload");
      const done =
        this.roundPages <= this.dirtyThreshold || this.roundsCompleted >= this.maxRounds;
      this.roundPages = 0;
      if (done) {
        this.converged = true;
        return true;
      }
    }
    return false;
  }

  /** Final stop-and-copy after the guest has unwound. */
  async finish() {
    await this.t.write(frame(FT.FINAL_BEGIN));
    await this.syncLayout();
    let finalPages = 0;
    for (const batch of this.tracker.scanFullBatches(this.inst)) {
      for (const [mem, pageNo, bytes] of batch) {
        finalPages++;
        this.totalPages++;
        const w = new Writer();
        w.u8(mem).u64(pageNo).raw(bytes);
        await this.t.write(frame(FT.PAGE, w.out()));
      }
    }
    const globals = this.inst.captureGlobals();
    const gw = new Writer();
    gw.u16(globals.length);
    for (const [n, v] of globals) {
      gw.str(n);
      gw.u32(v >>> 0);
    }
    await this.t.write(frame(FT.GLOBALS, gw.out()));
    const services = this.inst.serviceBlobs();
    const sw = new Writer();
    sw.u16(services.length);
    for (const [n, blob] of services) {
      sw.str(n);
      sw.bytes(blob);
    }
    await this.t.write(frame(FT.SERVICES, sw.out()));
    const hash = this.inst.stateHash(globals, services);
    await this.t.write(frame(FT.FINAL_END, hash));
    const prepared = await this._readFrame("PREPARED");
    if (prepared.type !== FT.PREPARED) throw abortError(prepared);
    if (prepared.payload.length !== 0) throw new Error("PREPARED must have an empty payload");

    // PREPARED means the peer has validated and restored the state but is not
    // executing it. From this point onward the source must never rewind
    // locally. COMMIT may have reached the target even when its write or the
    // acknowledgement appears to fail, so report uncertainty as data rather
    // than throwing into the caller's rollback path.
    const stats = {
      rounds: this.roundsCompleted,
      totalPages: this.totalPages,
      finalPages,
    };
    try {
      const committed = await withDeadline((async () => {
        await this.t.write(frame(FT.COMMIT));
        return readFrame(this.t);
      })(), this.commitTimeoutMs, "COMMIT_OK");
      if (committed.type !== FT.COMMIT_OK) throw abortError(committed);
      if (committed.payload.length !== 0) throw new Error("COMMIT_OK must have an empty payload");
      return { ...stats, commitConfirmed: true };
    } catch (error) {
      return {
        ...stats,
        commitConfirmed: false,
        commitError: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function abortError(f) {
  if (f.type === FT.ABORT) {
    const c = new Cursor(f.payload);
    const code = c.u32();
    const msg = c.str();
    c.done("ABORT");
    return new Error(`peer aborted (${code}): ${msg}`);
  }
  return new Error(`unexpected frame type ${f.type}`);
}

/** Extract the raw weave.meta section payload bytes. */
export function rawMetaSection(wasm) {
  return findCustomSection(wasm, "weave.meta");
}

// ---------------------------------------------------------------- migration: target

/**
 * Accept one migration over `transport`. `makeServices()` builds the service
 * map for the incoming instance. Returns a ready-to-resume WeaveInstance.
 */
async function rejectMigration(t, code, message, cause) {
  try {
    await t.write(frame(FT.ABORT, new Writer().u32(code).str(message).out()));
  } catch {
    // Preserve the validation error when the peer has already disappeared.
  }
  const error = new Error(message);
  if (cause !== undefined) error.cause = cause;
  throw error;
}

export async function acceptMigration(transport, makeServices, opts = {}) {
  const t = transport;
  const targetReadTimeoutMs = opts.targetReadTimeoutMs ?? 120_000;
  const targetSessionTimeoutMs = opts.targetSessionTimeoutMs ?? 10 * 60_000;
  const commitAckWriteTimeoutMs = opts.commitAckWriteTimeoutMs ?? 10;
  for (const [name, value] of [
    ["targetReadTimeoutMs", targetReadTimeoutMs],
    ["targetSessionTimeoutMs", targetSessionTimeoutMs],
    ["commitAckWriteTimeoutMs", commitAckWriteTimeoutMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  const sessionStarted = Date.now();
  const readTargetFrame = (what) => {
    const remaining = targetSessionTimeoutMs - (Date.now() - sessionStarted);
    if (remaining <= 0) {
      return Promise.reject(new Error(
        `target migration session timed out after ${targetSessionTimeoutMs} ms`,
      ));
    }
    return withDeadline(
      readFrame(t),
      Math.min(targetReadTimeoutMs, remaining),
      what,
    );
  };

  const hello = await readTargetFrame("HELLO");
  if (hello.type !== FT.HELLO) throw new Error("expected HELLO");
  const hc = new Cursor(hello.payload);
  const proto = hc.u8();
  if (proto !== PROTO_VERSION) {
    await t.write(frame(FT.ABORT, new Writer().u32(1).str("bad protocol").out()));
    throw new Error(`source speaks protocol ${proto}`);
  }
  const role = hc.u8();
  if (role !== 1) await rejectMigration(t, 1, `expected source role, got ${role}`);
  const sourceRuntime = hc.str();
  hc.done("HELLO");
  const hw = new Writer();
  hw.u8(PROTO_VERSION).u8(2).str(opts.runtimeName ?? "js");
  await t.write(frame(FT.HELLO, hw.out()));

  const mm = await readTargetFrame("MODULE_META");
  if (mm.type !== FT.MODULE_META) throw new Error("expected MODULE_META");
  const mc = new Cursor(mm.payload);
  const moduleHash = mc.bytes(32).slice();
  const size64 = mc.u64();
  const metaBytes = mc.bytes(mc.u32()).slice();
  mc.done("MODULE_META");
  try {
    decodeMeta(metaBytes);
  } catch (error) {
    await rejectMigration(t, 3, `invalid offered weave.meta: ${error}`, error);
  }
  const maxModuleBytes = opts.maxModuleBytes ?? 512 * 1024 * 1024;
  if (!Number.isSafeInteger(maxModuleBytes) || maxModuleBytes < 0) {
    throw new Error("maxModuleBytes must be a non-negative safe integer");
  }
  if (size64 > BigInt(maxModuleBytes)) {
    await rejectMigration(t, 2, `module size ${size64} exceeds target limit ${maxModuleBytes}`);
  }
  const size = Number(size64);
  const maxMemoryBytes = opts.maxMemoryBytes ?? 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxMemoryBytes) || maxMemoryBytes < 0) {
    throw new Error("maxMemoryBytes must be a non-negative safe integer");
  }

  const validateModule = async (bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== size) {
      await rejectMigration(t, 2, "module bytes do not match offered size");
    }
    if (!equalBytes(sha256(bytes), moduleHash)) {
      await rejectMigration(t, 2, "module hash mismatch");
    }
    let actualMeta;
    try {
      actualMeta = rawMetaSection(bytes);
    } catch (error) {
      await rejectMigration(t, 3, `invalid migrated module metadata: ${error}`, error);
    }
    if (!equalBytes(actualMeta, metaBytes)) {
      await rejectMigration(t, 3, "offered weave.meta does not match module weave.meta");
    }
    let initialMemoryBytes;
    try {
      initialMemoryBytes = declaredInitialMemoryBytes(bytes);
    } catch (error) {
      await rejectMigration(t, 3, `invalid migrated module memory declarations: ${error}`, error);
    }
    if (initialMemoryBytes > BigInt(maxMemoryBytes)) {
      await rejectMigration(
        t,
        3,
        `module declares ${initialMemoryBytes} initial memory bytes, exceeding target limit ${maxMemoryBytes}`,
      );
    }
  };

  let wasmBytes = opts.moduleCache?.get(hex(moduleHash));
  let cacheReceivedModule = false;
  if (wasmBytes !== undefined) {
    await validateModule(wasmBytes);
    await t.write(frame(FT.MODULE_HAVE));
  } else {
    await t.write(frame(FT.MODULE_NEED));
    try {
      wasmBytes = new Uint8Array(size);
    } catch (error) {
      await rejectMigration(t, 2, `cannot allocate ${size} module bytes`, error);
    }
    let got = 0;
    while (got < size) {
      const f = await readTargetFrame("MODULE_DATA");
      if (f.type !== FT.MODULE_DATA) throw new Error("expected MODULE_DATA");
      const c = new Cursor(f.payload);
      const off64 = c.u64();
      if (off64 > BigInt(Number.MAX_SAFE_INTEGER)) {
        await rejectMigration(t, 2, "module chunk offset exceeds JavaScript integer range");
      }
      const off = Number(off64);
      const chunk = c.bytes(f.payload.length - c.pos);
      c.done("MODULE_DATA");
      if (off !== got) {
        await rejectMigration(t, 2, `module chunk out of order: expected ${got}, got ${off}`);
      }
      if (chunk.length === 0 || chunk.length > 256 * 1024 || off + chunk.length > size) {
        await rejectMigration(t, 2, "invalid module chunk size or range");
      }
      wasmBytes.set(chunk, off);
      got += chunk.length;
    }
    await validateModule(wasmBytes);
    cacheReceivedModule = true;
  }

  let inst;
  try {
    const services = makeServices();
    inst = new WeaveInstance(wasmBytes, services, opts);
    await inst.instantiate(); // NOTE: __weave_init is NOT called on restore
    // The source omits never-dirtied all-zero pages. Active data segments make
    // a fresh instance nonzero, so reset every target memory to the baseline
    // assumed by PageTracker before accepting streamed pages.
    for (let m = 0; m < inst.meta.memories.length; m++) inst.memBytes(m).fill(0);
  } catch (e) {
    await rejectMigration(t, 3, `instantiation failed: ${e}`, e);
  }
  if (cacheReceivedModule) opts.moduleCache?.set(hex(moduleHash), wasmBytes);
  await t.write(frame(FT.MODULE_OK));

  const expectedGlobals = inst.meta.controlGlobals;
  const expectedServices = [...inst.services.keys()].sort(compareUtf8Strings);
  let phase = "precopy";
  let layout = null;
  let expectedRound = 1;
  let roundPages = 0n;
  let pagesSeen = new Set();
  let globals = [];
  let services_ = [];
  for (;;) {
    const f = await readTargetFrame("migration frame");
    switch (f.type) {
      case FT.MEM_LAYOUT: {
        if (phase !== "precopy" && phase !== "final-pages") {
          await rejectMigration(t, 5, "MEM_LAYOUT after final globals");
        }
        const c = new Cursor(f.payload);
        const n = c.u8();
        if (n !== inst.meta.memories.length) {
          await rejectMigration(
            t,
            5,
            `memory layout count mismatch: expected ${inst.meta.memories.length}, got ${n}`,
          );
        }
        const nextLayout = [];
        let totalBytes = 0n;
        for (let m = 0; m < n; m++) {
          const pages = c.u64();
          if (pages > BigInt(Number.MAX_SAFE_INTEGER)) {
            await rejectMigration(t, 5, "memory page count exceeds JavaScript integer range");
          }
          if (layout !== null && pages < layout[m]) {
            await rejectMigration(t, 5, "memory layout cannot shrink during migration");
          }
          totalBytes += pages * BigInt(WASM_PAGE);
          nextLayout.push(pages);
        }
        c.done("MEM_LAYOUT");
        if (totalBytes > BigInt(maxMemoryBytes)) {
          await rejectMigration(
            t,
            5,
            `announced memory layout is ${totalBytes} bytes, exceeding target limit ${maxMemoryBytes}`,
          );
        }
        try {
          for (let m = 0; m < n; m++) inst.growMemTo(m, Number(nextLayout[m]));
        } catch (error) {
          await rejectMigration(t, 5, `cannot apply memory layout: ${error}`, error);
        }
        layout = nextLayout;
        break;
      }
      case FT.PAGE: {
        if (phase !== "precopy" && phase !== "final-pages") {
          await rejectMigration(t, 5, "PAGE after final globals");
        }
        if (f.payload.length !== 9 + WPAGE) {
          await rejectMigration(t, 5, `invalid page payload size: ${f.payload.length - 9}`);
        }
        const c = new Cursor(f.payload);
        const mem = c.u8();
        const pageNo = c.u64();
        const bytes = c.bytes(WPAGE);
        c.done("PAGE");
        if (layout === null || mem >= layout.length) {
          await rejectMigration(t, 5, "PAGE before a matching MEM_LAYOUT");
        }
        const off64 = pageNo * BigInt(WPAGE);
        const end64 = off64 + BigInt(WPAGE);
        if (end64 > layout[mem] * BigInt(WASM_PAGE)) {
          await rejectMigration(t, 5, "PAGE exceeds announced memory layout");
        }
        if (off64 > BigInt(Number.MAX_SAFE_INTEGER)) {
          await rejectMigration(t, 5, "page offset exceeds JavaScript integer range");
        }
        const pageKey = `${mem}:${pageNo}`;
        if (pagesSeen.has(pageKey)) {
          await rejectMigration(t, 5, "duplicate PAGE in migration round");
        }
        pagesSeen.add(pageKey);
        inst.memBytes(mem).set(bytes, Number(off64));
        if (phase === "precopy") roundPages++;
        break;
      }
      case FT.ROUND_END: {
        if (phase !== "precopy") {
          await rejectMigration(t, 5, "ROUND_END during final transfer");
        }
        const c = new Cursor(f.payload);
        const round = c.u32();
        const pagesSent = c.u64();
        c.done("ROUND_END");
        if (round !== expectedRound || pagesSent !== roundPages) {
          await rejectMigration(
            t,
            5,
            `invalid round terminator: expected round ${expectedRound} with ${roundPages} pages, got round ${round} with ${pagesSent}`,
          );
        }
        await t.write(frame(FT.ROUND_ACK));
        expectedRound++;
        roundPages = 0n;
        pagesSeen.clear();
        break;
      }
      case FT.FINAL_BEGIN:
        if (f.payload.length !== 0 || phase !== "precopy" || roundPages !== 0n) {
          await rejectMigration(t, 5, "FINAL_BEGIN inside an incomplete round");
        }
        phase = "final-pages";
        pagesSeen = new Set();
        break;
      case FT.GLOBALS: {
        if (phase !== "final-pages") await rejectMigration(t, 5, "GLOBALS out of order");
        const c = new Cursor(f.payload);
        const n = c.u16();
        globals = [];
        for (let i = 0; i < n; i++) {
          const name = c.str();
          const v = c.u32() | 0;
          globals.push([name, v]);
        }
        c.done("GLOBALS");
        if (!equalNames(globals.map(([name]) => name), expectedGlobals)) {
          await rejectMigration(t, 5, "control-global contract mismatch");
        }
        phase = "final-globals";
        break;
      }
      case FT.SERVICES: {
        if (phase !== "final-globals") await rejectMigration(t, 5, "SERVICES out of order");
        const c = new Cursor(f.payload);
        const n = c.u16();
        services_ = [];
        for (let i = 0; i < n; i++) {
          const name = c.str();
          const blob = c.bytes(c.u32()).slice();
          services_.push([name, blob]);
        }
        c.done("SERVICES");
        if (!equalNames(services_.map(([name]) => name), expectedServices)) {
          await rejectMigration(t, 5, "host-service contract mismatch");
        }
        phase = "final-services";
        break;
      }
      case FT.FINAL_END: {
        if (phase !== "final-services") {
          await rejectMigration(t, 5, "FINAL_END before complete final state");
        }
        if (f.payload.length !== 32) await rejectMigration(t, 5, "invalid FINAL_END payload");
        const ours = inst.stateHash(globals, services_);
        if (!equalBytes(ours, f.payload)) {
          await rejectMigration(t, 4, "migrated state hash mismatch — refusing to resume");
        }
        try {
          for (const [n, v] of globals) inst.setG(n, v);
          inst.restoreServices(services_);
        } catch (error) {
          await rejectMigration(t, 5, `restoring migrated state failed: ${error}`, error);
        }
        await t.write(frame(FT.PREPARED));
        const commit = await readTargetFrame("COMMIT");
        if (commit.type === FT.ABORT) throw abortError(commit);
        if (commit.type !== FT.COMMIT) {
          await rejectMigration(t, 5, `expected COMMIT after PREPARED, got ${commit.type}`);
        }
        if (commit.payload.length !== 0) {
          await rejectMigration(t, 5, "COMMIT must have an empty payload");
        }

        // Receiving COMMIT transfers ownership to this target. Failure to
        // return COMMIT_OK cannot revoke that transfer: the source has already
        // retired, so the target must still return to its caller and resume.
        let commitAckError = null;
        try {
          await withDeadline(
            Promise.resolve().then(() => t.write(frame(FT.COMMIT_OK))),
            commitAckWriteTimeoutMs,
            "COMMIT_OK write",
          );
        } catch (error) {
          commitAckError = error instanceof Error ? error.message : String(error);
        }
        return { inst, sourceRuntime, commitAckError };
      }
      case FT.ABORT:
        throw abortError(f);
      default:
        throw new Error(`unexpected frame ${f.type}`);
    }
  }
}
