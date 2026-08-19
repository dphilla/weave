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
export const PROTO_VERSION = 1;
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

// ---------------------------------------------------------------- meta

class Cursor {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }
  u8() { return this.b[this.pos++]; }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  u64() { const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  str() { const n = this.u32(); return new TextDecoder().decode(this.bytes(n)); }
  types() {
    const n = this.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(TY[this.u8()]);
    return out;
  }
}

/** Parse the weave.meta custom section out of a wasm binary. */
export function extractMeta(wasm) {
  // minimal wasm section walk
  const dv = new DataView(wasm.buffer, wasm.byteOffset, wasm.byteLength);
  if (dv.getUint32(0, true) !== 0x6d736100) throw new Error("not a wasm module");
  let pos = 8;
  const leb = () => {
    let r = 0, s = 0, b;
    do {
      b = wasm[pos++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  while (pos < wasm.length) {
    const id = wasm[pos++];
    const size = leb();
    const end = pos + size;
    if (id === 0) {
      const save = pos;
      const nameLen = leb();
      const name = new TextDecoder().decode(wasm.subarray(pos, pos + nameLen));
      pos += nameLen;
      if (name === "weave.meta") {
        return decodeMeta(wasm.subarray(pos, end));
      }
      pos = save;
    }
    pos = end;
  }
  throw new Error("module has no weave.meta section (run `weave transform` first)");
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
  FINAL_BEGIN: 11, GLOBALS: 12, SERVICES: 13, FINAL_END: 14, RESUME_OK: 15,
  ABORT: 16, CTL_MIGRATE: 17, CTL_STATUS: 18, CTL_OK: 19, CTL_ERR: 20,
};

export function frame(type, payload = new Uint8Array(0)) {
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
  const type = hdr[0];
  const len = new DataView(hdr.buffer, hdr.byteOffset).getUint32(1, true);
  if (len > 64 * 1024 * 1024) throw new Error(`frame too large: ${len}`);
  const payload = len ? await t.readExact(len) : new Uint8Array(0);
  return { type, payload };
}

// ---------------------------------------------------------------- instance

/**
 * services: Map name -> { imports: {module: {name: fn}}, snapshot(): Uint8Array,
 *                         restore(bytes): void }
 */
export class WeaveInstance {
  constructor(wasmBytes, services, opts = {}) {
    this.wasmBytes = wasmBytes;
    this.moduleHash = sha256(wasmBytes);
    this.meta = extractMeta(wasmBytes);
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
        default: throw new Error(`unsupported result type ${ty}`);
      }
    });
  }

  captureGlobals() {
    return this.meta.controlGlobals.map((n) => [n, this.g(n)]);
  }

  serviceBlobs() {
    const names = [...this.services.keys()].sort();
    return names.map((n) => [n, this.services.get(n).snapshot()]);
  }

  restoreServices(blobs) {
    for (const [name, blob] of blobs) {
      const svc = this.services.get(name);
      if (svc) svc.restore(blob);
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
    const sorted = [...services].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
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

  scanFull(inst) {
    const all = [];
    for (;;) {
      const s = this.scanStep(inst, Infinity);
      all.push(...s.pages);
      if (s.roundComplete) return all;
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
    this.converged = false;
  }

  async handshake() {
    const hw = new Writer();
    hw.u8(PROTO_VERSION).u8(1).str(this.runtimeName);
    await this.t.write(frame(FT.HELLO, hw.out()));
    const hello = await readFrame(this.t);
    if (hello.type !== FT.HELLO) throw new Error(`expected HELLO, got ${hello.type}`);
    // module sync (the meta blob is the raw weave.meta section payload)
    const metaBytes = rawMetaSection(this.inst.wasmBytes);
    const mm2 = new Writer();
    mm2.raw(this.inst.moduleHash);
    mm2.u64(this.inst.wasmBytes.length);
    mm2.bytes(metaBytes);
    await this.t.write(frame(FT.MODULE_META, mm2.out()));
    const resp = await readFrame(this.t);
    if (resp.type === FT.MODULE_NEED) {
      const CHUNK = 256 * 1024;
      for (let off = 0; off < this.inst.wasmBytes.length; off += CHUNK) {
        const chunk = this.inst.wasmBytes.subarray(off, Math.min(off + CHUNK, this.inst.wasmBytes.length));
        const dw = new Writer();
        dw.u64(off);
        dw.raw(chunk);
        await this.t.write(frame(FT.MODULE_DATA, dw.out()));
      }
    } else if (resp.type !== FT.MODULE_HAVE) {
      throw abortError(resp);
    }
    const ok = await readFrame(this.t);
    if (ok.type !== FT.MODULE_OK) throw abortError(ok);
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
      const ack = await readFrame(this.t);
      if (ack.type !== FT.ROUND_ACK) throw abortError(ack);
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
    const finalPages = this.tracker.scanFull(this.inst);
    for (const [mem, pageNo, bytes] of finalPages) {
      this.totalPages++;
      const w = new Writer();
      w.u8(mem).u64(pageNo).raw(bytes);
      await this.t.write(frame(FT.PAGE, w.out()));
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
    const ok = await readFrame(this.t);
    if (ok.type !== FT.RESUME_OK) throw abortError(ok);
    return {
      rounds: this.roundsCompleted,
      totalPages: this.totalPages,
      finalPages: finalPages.length,
    };
  }
}

function abortError(f) {
  if (f.type === FT.ABORT) {
    const c = new Cursor(f.payload);
    const code = c.u32();
    const msg = c.str();
    return new Error(`peer aborted (${code}): ${msg}`);
  }
  return new Error(`unexpected frame type ${f.type}`);
}

/** Extract the raw weave.meta section payload bytes. */
export function rawMetaSection(wasm) {
  const leb = (state) => {
    let r = 0, s = 0, b;
    do {
      b = wasm[state.pos++];
      r |= (b & 0x7f) << s;
      s += 7;
    } while (b & 0x80);
    return r >>> 0;
  };
  const st = { pos: 8 };
  while (st.pos < wasm.length) {
    const id = wasm[st.pos++];
    const size = leb(st);
    const end = st.pos + size;
    if (id === 0) {
      const nameLen = leb(st);
      const name = new TextDecoder().decode(wasm.subarray(st.pos, st.pos + nameLen));
      st.pos += nameLen;
      if (name === "weave.meta") return wasm.subarray(st.pos, end).slice();
    }
    st.pos = end;
  }
  throw new Error("no weave.meta section");
}

// ---------------------------------------------------------------- migration: target

/**
 * Accept one migration over `transport`. `makeServices()` builds the service
 * map for the incoming instance. Returns a ready-to-resume WeaveInstance.
 */
export async function acceptMigration(transport, makeServices, opts = {}) {
  const t = transport;
  const hello = await readFrame(t);
  if (hello.type !== FT.HELLO) throw new Error("expected HELLO");
  const hc = new Cursor(hello.payload);
  const proto = hc.u8();
  if (proto !== PROTO_VERSION) {
    await t.write(frame(FT.ABORT, new Writer().u32(1).str("bad protocol").out()));
    throw new Error(`source speaks protocol ${proto}`);
  }
  hc.u8(); // role
  const sourceRuntime = hc.str();
  const hw = new Writer();
  hw.u8(PROTO_VERSION).u8(2).str(opts.runtimeName ?? "js");
  await t.write(frame(FT.HELLO, hw.out()));

  const mm = await readFrame(t);
  if (mm.type !== FT.MODULE_META) throw new Error("expected MODULE_META");
  const mc = new Cursor(mm.payload);
  const moduleHash = mc.bytes(32).slice();
  const size = Number(mc.u64());

  let wasmBytes = opts.moduleCache?.get(hex(moduleHash));
  if (wasmBytes) {
    await t.write(frame(FT.MODULE_HAVE));
  } else {
    await t.write(frame(FT.MODULE_NEED));
    wasmBytes = new Uint8Array(size);
    let got = 0;
    while (got < size) {
      const f = await readFrame(t);
      if (f.type !== FT.MODULE_DATA) throw new Error("expected MODULE_DATA");
      const c = new Cursor(f.payload);
      const off = Number(c.u64());
      const chunk = f.payload.subarray(8);
      wasmBytes.set(chunk, off);
      got += chunk.length;
    }
    if (hex(sha256(wasmBytes)) !== hex(moduleHash)) {
      await t.write(frame(FT.ABORT, new Writer().u32(2).str("module hash mismatch").out()));
      throw new Error("module hash mismatch");
    }
    opts.moduleCache?.set(hex(moduleHash), wasmBytes);
  }

  const services = makeServices();
  const inst = new WeaveInstance(wasmBytes, services, opts);
  try {
    await inst.instantiate(); // NOTE: __weave_init is NOT called on restore
  } catch (e) {
    await t.write(frame(FT.ABORT, new Writer().u32(3).str(`instantiation failed: ${e}`).out()));
    throw e;
  }
  await t.write(frame(FT.MODULE_OK));

  let globals = [];
  let services_ = [];
  for (;;) {
    const f = await readFrame(t);
    switch (f.type) {
      case FT.MEM_LAYOUT: {
        const c = new Cursor(f.payload);
        const n = c.u8();
        for (let m = 0; m < n; m++) {
          inst.growMemTo(m, Number(c.u64()));
        }
        break;
      }
      case FT.PAGE: {
        const c = new Cursor(f.payload);
        const mem = c.u8();
        const pageNo = Number(c.u64());
        const bytes = f.payload.subarray(9);
        const off = pageNo * WPAGE;
        const memBytes = inst.memBytes(mem);
        if (off + bytes.length > memBytes.length) {
          inst.growMemTo(mem, Math.ceil((off + bytes.length) / WASM_PAGE));
        }
        inst.memBytes(mem).set(bytes, off);
        break;
      }
      case FT.ROUND_END:
        await t.write(frame(FT.ROUND_ACK));
        break;
      case FT.FINAL_BEGIN:
        break;
      case FT.GLOBALS: {
        const c = new Cursor(f.payload);
        const n = c.u16();
        globals = [];
        for (let i = 0; i < n; i++) {
          const name = c.str();
          const v = c.u32() | 0;
          globals.push([name, v]);
        }
        break;
      }
      case FT.SERVICES: {
        const c = new Cursor(f.payload);
        const n = c.u16();
        services_ = [];
        for (let i = 0; i < n; i++) {
          const name = c.str();
          const blob = c.bytes(c.u32()).slice();
          services_.push([name, blob]);
        }
        break;
      }
      case FT.FINAL_END: {
        for (const [n, v] of globals) inst.setG(n, v);
        inst.restoreServices(services_);
        const ours = inst.stateHash(globals, services_);
        if (hex(ours) !== hex(f.payload)) {
          await t.write(frame(FT.ABORT, new Writer().u32(4).str("state hash mismatch").out()));
          throw new Error("migrated state hash mismatch — refusing to resume");
        }
        await t.write(frame(FT.RESUME_OK));
        return { inst, sourceRuntime };
      }
      case FT.ABORT:
        throw abortError(f);
      default:
        throw new Error(`unexpected frame ${f.type}`);
    }
  }
}
