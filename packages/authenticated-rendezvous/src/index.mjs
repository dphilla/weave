// Browser-safe authenticated rendezvous primitives. The package deliberately
// owns identity, authorization, and signaling integrity, but no HTTP routes,
// persistence, discovery, WebRTC objects, or application data transport.

export const RENDEZVOUS_PROTOCOL = "weave-rendezvous.v1";
export const CAPABILITY_SIGNATURE_DOMAIN = "weave.rendezvous.capability.v1\0";
export const SIGNAL_SIGNATURE_DOMAIN = "weave.rendezvous.signal.v1\0";

export const DEFAULT_CLOCK_SKEW_MS = 30_000;
export const DEFAULT_CAPABILITY_TTL_MS = 5 * 60_000;
export const MAX_CAPABILITY_LIFETIME_MS = 10 * 60_000;
export const DEFAULT_SIGNAL_TTL_MS = 30_000;
export const MAX_SIGNAL_LIFETIME_MS = 60_000;
export const DEFAULT_MAX_SIGNALS = 512;
export const MAX_SIGNALS = 4_096;
export const DEFAULT_MAX_SIGNAL_BYTES = 256 * 1024;
export const MAX_SIGNAL_BYTES = 256 * 1024;
export const DEFAULT_MAX_SESSION_DURATION_MS = 10 * 60_000;
export const MAX_CHANNELS = 8;
export const MAX_CAPABILITY_BYTES = 16 * 1024;
export const MAX_CANONICAL_JSON_BYTES = 1024 * 1024;
export const MAX_CANONICAL_JSON_DEPTH = 32;
export const MAX_CANONICAL_JSON_NODES = 16_384;
export const DEFAULT_MAX_REPLAY_ENTRIES = 4_096;

export const RENDEZVOUS_ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "ERR_RENDEZVOUS_INVALID_ARGUMENT",
  INVALID_JSON: "ERR_RENDEZVOUS_INVALID_JSON",
  LIMIT_EXCEEDED: "ERR_RENDEZVOUS_LIMIT_EXCEEDED",
  CRYPTO_UNAVAILABLE: "ERR_RENDEZVOUS_CRYPTO_UNAVAILABLE",
  KEY_INVALID: "ERR_RENDEZVOUS_KEY_INVALID",
  NODE_ID_INVALID: "ERR_RENDEZVOUS_NODE_ID_INVALID",
  NODE_ID_MISMATCH: "ERR_RENDEZVOUS_NODE_ID_MISMATCH",
  SIGNATURE_INVALID: "ERR_RENDEZVOUS_SIGNATURE_INVALID",
  CAPABILITY_INVALID: "ERR_RENDEZVOUS_CAPABILITY_INVALID",
  CAPABILITY_UNTRUSTED_ISSUER: "ERR_RENDEZVOUS_CAPABILITY_UNTRUSTED_ISSUER",
  CAPABILITY_NOT_YET_VALID: "ERR_RENDEZVOUS_CAPABILITY_NOT_YET_VALID",
  CAPABILITY_EXPIRED: "ERR_RENDEZVOUS_CAPABILITY_EXPIRED",
  CAPABILITY_MISMATCH: "ERR_RENDEZVOUS_CAPABILITY_MISMATCH",
  SIGNAL_INVALID: "ERR_RENDEZVOUS_SIGNAL_INVALID",
  SIGNAL_EXPIRED: "ERR_RENDEZVOUS_SIGNAL_EXPIRED",
  SIGNAL_MISMATCH: "ERR_RENDEZVOUS_SIGNAL_MISMATCH",
  SIGNAL_SEQUENCE: "ERR_RENDEZVOUS_SIGNAL_SEQUENCE",
  SIGNAL_CHAIN: "ERR_RENDEZVOUS_SIGNAL_CHAIN",
  REPLAYED: "ERR_RENDEZVOUS_REPLAYED",
  REPLAY_STORE_FULL: "ERR_RENDEZVOUS_REPLAY_STORE_FULL",
  REPLAY_STORE_FAILED: "ERR_RENDEZVOUS_REPLAY_STORE_FAILED",
  CLOCK_FAILED: "ERR_RENDEZVOUS_CLOCK_FAILED",
  SESSION_POLICY_REJECTED: "ERR_RENDEZVOUS_SESSION_POLICY_REJECTED",
  SESSION_CLOSED: "ERR_RENDEZVOUS_SESSION_CLOSED",
  HANDLER_FAILED: "ERR_RENDEZVOUS_HANDLER_FAILED",
});

const UTF8 = new TextEncoder();
const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const BASE64URL_VALUES = new Map(
  [...BASE64URL_ALPHABET].map((character, index) => [character, index]),
);
const BASE32_VALUES = new Map(
  [...BASE32_ALPHABET].map((character, index) => [character, index]),
);
const NODE_ID_RE = /^wn1-[a-z2-7]{52}$/;
const DIGEST_RE = /^sha256-[A-Za-z0-9_-]{43}$/;
const OFFER_ROLES = new Set(["offerer", "answerer"]);
const PRIVACY_MODES = new Set([
  "direct-preferred",
  "relay-only",
  "organization-only",
  "offline-local",
]);
// V1 signaling is authenticated but intentionally visible to its broker.
// Confidential signaling requires a separately specified key-agreement layer.
const SIGNALING_VISIBILITIES = new Set(["rendezvous-visible"]);
const ED25519 = Object.freeze({ name: "Ed25519" });
const IDENTITY_CHECK_DOMAIN = UTF8.encode("weave.rendezvous.identity-check.v1\0");
const VERIFIED_CAPABILITIES = new WeakSet();
const PACKAGE_IDENTITIES = new WeakSet();
const INTERNAL_ERRORS = new WeakSet();

export class RendezvousError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "RendezvousError";
    this.code = options.code ?? RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT;
    this.phase = options.phase ?? "rendezvous";
    this.retryable = options.retryable === true;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function internalError(message, options = {}) {
  const error = new RendezvousError(message, options);
  INTERNAL_ERRORS.add(error);
  return error;
}

function fail(code, message, phase, cause) {
  throw internalError(message, { code, phase, cause });
}

function normalizeError(value, fallback, code, phase) {
  if (INTERNAL_ERRORS.has(value)) return value;
  return internalError(fallback, { code, phase });
}

function replayStoreFailure(error) {
  const full = error instanceof RendezvousError &&
    error.code === RENDEZVOUS_ERROR_CODES.REPLAY_STORE_FULL;
  return internalError(
    full ? "replay store is full" : "replay store operation failed",
    {
      code: full
        ? RENDEZVOUS_ERROR_CODES.REPLAY_STORE_FULL
        : RENDEZVOUS_ERROR_CODES.REPLAY_STORE_FAILED,
      phase: "replay",
      retryable: !full,
    },
  );
}

function replayStoreMethod(store, name) {
  let method;
  try {
    method = store?.[name];
  } catch {
    throw replayStoreFailure();
  }
  if (typeof method !== "function") {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `replayStore must provide ${name}()`,
      "replay",
    );
  }
  return method;
}

async function replayClaim(store, key, expiresAt, now) {
  const claim = replayStoreMethod(store, "claim");
  let result;
  try {
    result = await claim.call(store, key, expiresAt, now);
  } catch (error) {
    throw replayStoreFailure(error);
  }
  if (typeof result !== "boolean") throw replayStoreFailure();
  return result;
}

async function replayCompareAndReserve(store, key, value, expiresAt, now) {
  const compareAndReserve = replayStoreMethod(store, "compareAndReserve");
  let result;
  try {
    result = await compareAndReserve.call(store, key, value, expiresAt, now);
  } catch (error) {
    throw replayStoreFailure(error);
  }
  if (result !== "reserved" && result !== "matched" && result !== "conflict") {
    throw replayStoreFailure();
  }
  return result;
}

function asBytes(value, name = "value") {
  if (value instanceof Uint8Array) return value.slice();
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  fail(
    RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
    `${name} must be an ArrayBuffer or typed array`,
    "encoding",
  );
}

function assertByteLength(bytes, expected, name, code = RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT) {
  if (bytes.length !== expected) {
    fail(code, `${name} must contain exactly ${expected} bytes`, "encoding");
  }
  return bytes;
}

export function encodeBase64Url(value) {
  const bytes = asBytes(value, "base64url input");
  let output = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const remaining = bytes.length - offset;
    const word = (bytes[offset] << 16) |
      ((remaining > 1 ? bytes[offset + 1] : 0) << 8) |
      (remaining > 2 ? bytes[offset + 2] : 0);
    output += BASE64URL_ALPHABET[(word >>> 18) & 63];
    output += BASE64URL_ALPHABET[(word >>> 12) & 63];
    if (remaining > 1) output += BASE64URL_ALPHABET[(word >>> 6) & 63];
    if (remaining > 2) output += BASE64URL_ALPHABET[word & 63];
  }
  return output;
}

export function decodeBase64Url(value, options = {}) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "base64url value must be canonical, unpadded base64url",
      "encoding",
    );
  }
  const expectedBytes = Math.floor(value.length * 6 / 8);
  if (expectedBytes > (options.maxBytes ?? MAX_CANONICAL_JSON_BYTES)) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      "base64url value exceeds its decoded byte limit",
      "encoding",
    );
  }
  const output = new Uint8Array(expectedBytes);
  let accumulator = 0;
  let bits = 0;
  let outputOffset = 0;
  for (const character of value) {
    const decoded = BASE64URL_VALUES.get(character);
    if (decoded === undefined) {
      fail(RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT, "invalid base64url value", "encoding");
    }
    accumulator = (accumulator << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[outputOffset++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0 || outputOffset !== output.length || encodeBase64Url(output) !== value) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "base64url value is not canonically encoded",
      "encoding",
    );
  }
  return output;
}

export function encodeBase32(value) {
  const bytes = asBytes(value, "base32 input");
  let output = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(accumulator >>> bits) & 31];
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(value, options = {}) {
  if (typeof value !== "string" || !/^[a-z2-7]*$/.test(value)) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "base32 value must be canonical lowercase unpadded RFC 4648 base32",
      "encoding",
    );
  }
  const expectedBytes = Math.floor(value.length * 5 / 8);
  if (expectedBytes > (options.maxBytes ?? MAX_CANONICAL_JSON_BYTES)) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      "base32 value exceeds its decoded byte limit",
      "encoding",
    );
  }
  const output = new Uint8Array(expectedBytes);
  let accumulator = 0;
  let bits = 0;
  let outputOffset = 0;
  for (const character of value) {
    accumulator = (accumulator << 5) | BASE32_VALUES.get(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output[outputOffset++] = (accumulator >>> bits) & 0xff;
      accumulator &= (1 << bits) - 1;
    }
  }
  if (bits > 0 && accumulator !== 0 || outputOffset !== output.length || encodeBase32(output) !== value) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "base32 value is not canonically encoded",
      "encoding",
    );
  }
  return output;
}

function validateUnicodeScalarString(value, name, maxBytes = 256 * 1024) {
  if (typeof value !== "string") {
    fail(RENDEZVOUS_ERROR_CODES.INVALID_JSON, `${name} must be a string`, "canonicalize");
  }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        fail(
          RENDEZVOUS_ERROR_CODES.INVALID_JSON,
          `${name} contains an unpaired UTF-16 surrogate`,
          "canonicalize",
        );
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_JSON,
        `${name} contains an unpaired UTF-16 surrogate`,
        "canonicalize",
      );
    }
  }
  if (UTF8.encode(value).length > maxBytes) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      `${name} exceeds its UTF-8 byte limit`,
      "canonicalize",
    );
  }
  return value;
}

function canonicalize(value, state, depth) {
  if (depth > state.maxDepth) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      `JSON nesting exceeds ${state.maxDepth}`,
      "canonicalize",
    );
  }
  state.nodes += 1;
  if (state.nodes > state.maxNodes) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      `JSON value exceeds ${state.maxNodes} nodes`,
      "canonicalize",
    );
  }
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean": return value ? "true" : "false";
    case "string":
      validateUnicodeScalarString(value, "JSON string", state.maxStringBytes);
      return JSON.stringify(value);
    case "number": {
      if (!Number.isFinite(value)) {
        fail(
          RENDEZVOUS_ERROR_CODES.INVALID_JSON,
          "I-JSON numbers must be finite IEEE 754 values",
          "canonicalize",
        );
      }
      return JSON.stringify(value);
    }
    case "object": break;
    default:
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_JSON,
        `I-JSON cannot contain ${typeof value}`,
        "canonicalize",
      );
  }
  if (state.ancestors.has(value)) {
    fail(RENDEZVOUS_ERROR_CODES.INVALID_JSON, "I-JSON cannot contain cycles", "canonicalize");
  }
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      if (ownNames.length !== value.length + 1 || ownNames.at(-1) !== "length") {
        fail(
          RENDEZVOUS_ERROR_CODES.INVALID_JSON,
          "I-JSON arrays must be dense and cannot have extra properties",
          "canonicalize",
        );
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail(
          RENDEZVOUS_ERROR_CODES.INVALID_JSON,
          "I-JSON arrays cannot have symbol properties",
          "canonicalize",
        );
      }
      const items = [];
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) {
          fail(
            RENDEZVOUS_ERROR_CODES.INVALID_JSON,
            "I-JSON arrays must not contain holes",
            "canonicalize",
          );
        }
        items.push(canonicalize(value[index], state, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_JSON,
        "I-JSON objects must be plain data objects",
        "canonicalize",
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_JSON,
        "I-JSON objects cannot have symbol properties",
        "canonicalize",
      );
    }
    const names = Object.getOwnPropertyNames(value);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      if (!descriptor.enumerable || descriptor.get || descriptor.set) {
        fail(
          RENDEZVOUS_ERROR_CODES.INVALID_JSON,
          "I-JSON objects may contain only enumerable data properties",
          "canonicalize",
        );
      }
      validateUnicodeScalarString(name, "JSON member name", state.maxStringBytes);
    }
    names.sort();
    return `{${names.map((name) =>
      `${JSON.stringify(name)}:${canonicalize(value[name], state, depth + 1)}`
    ).join(",")}}`;
  } finally {
    state.ancestors.delete(value);
  }
}

/** Canonicalize a strict I-JSON data value using RFC 8785/JCS ordering and numbers. */
export function canonicalizeJson(value, options = {}) {
  const state = {
    maxBytes: positiveSafeInteger(
      options.maxBytes ?? MAX_CANONICAL_JSON_BYTES,
      "maxBytes",
    ),
    maxDepth: positiveSafeInteger(
      options.maxDepth ?? MAX_CANONICAL_JSON_DEPTH,
      "maxDepth",
    ),
    maxNodes: positiveSafeInteger(
      options.maxNodes ?? MAX_CANONICAL_JSON_NODES,
      "maxNodes",
    ),
    maxStringBytes: positiveSafeInteger(
      options.maxStringBytes ?? 256 * 1024,
      "maxStringBytes",
    ),
    nodes: 0,
    ancestors: new WeakSet(),
  };
  const result = canonicalize(value, state, 0);
  if (UTF8.encode(result).length > state.maxBytes) {
    fail(
      RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
      `canonical JSON exceeds ${state.maxBytes} bytes`,
      "canonicalize",
    );
  }
  return result;
}

export function canonicalizeJsonBytes(value, options = {}) {
  return UTF8.encode(canonicalizeJson(value, options));
}

/**
 * Parse a wire JSON value only if its UTF-8 bytes are already canonical JCS.
 * This rejects whitespace, duplicate members, BOMs, invalid UTF-8, and number
 * or escape spellings that would otherwise disappear during JSON.parse().
 */
export function parseCanonicalJson(input, options = {}) {
  let text;
  if (typeof input === "string") {
    text = validateUnicodeScalarString(
      input,
      "canonical JSON input",
      options.maxBytes ?? MAX_CANONICAL_JSON_BYTES,
    );
  } else {
    const bytes = asBytes(input, "canonical JSON input");
    if (bytes.length > (options.maxBytes ?? MAX_CANONICAL_JSON_BYTES)) {
      fail(
        RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
        "canonical JSON input exceeds its byte limit",
        "parse",
      );
    }
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw normalizeError(
        error,
        "canonical JSON input is not valid UTF-8",
        RENDEZVOUS_ERROR_CODES.INVALID_JSON,
        "parse",
      );
    }
  }
  if (text.charCodeAt(0) === 0xfeff) {
    fail(RENDEZVOUS_ERROR_CODES.INVALID_JSON, "canonical JSON must not have a BOM", "parse");
  }
  let value;
  try { value = JSON.parse(text); }
  catch (error) {
    throw normalizeError(
      error,
      "canonical JSON input is not valid JSON",
      RENDEZVOUS_ERROR_CODES.INVALID_JSON,
      "parse",
    );
  }
  const canonical = canonicalizeJson(value, options);
  if (canonical !== text) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_JSON,
      "wire JSON is not in canonical JCS form",
      "parse",
    );
  }
  return deepFreeze(value);
}

function positiveSafeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a positive safe integer no greater than ${maximum}`,
      "validate",
    );
  }
  return value;
}

function nonNegativeSafeInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a non-negative safe integer no greater than ${maximum}`,
      "validate",
    );
  }
  return value;
}

function exactKeys(value, required, name, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${name} must be an object`, "validate");
  }
  const keys = Object.keys(value);
  if (keys.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    fail(code, `${name} does not have the exact v1 field set`, "validate");
  }
}

function boundedString(value, name, maxBytes, { nullable = false, empty = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !empty && value.length === 0) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be ${nullable ? "null or " : ""}a${empty ? "" : " non-empty"} string`,
      "validate",
    );
  }
  validateUnicodeScalarString(value, name, maxBytes);
  return value;
}

function canonicalOpaqueId(value, name) {
  const bytes = decodeBase64Url(value, { maxBytes: 48 });
  if (bytes.length < 16 || bytes.length > 48) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must encode between 16 and 48 bytes`,
      "validate",
    );
  }
  return value;
}

function canonicalDigest(value, name) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      `${name} must be a canonical sha256- digest`,
      "validate",
    );
  }
  assertByteLength(decodeBase64Url(value.slice(7)), 32, name);
  return value;
}

function canonicalNodeId(value, name = "NodeID") {
  if (typeof value !== "string" || !NODE_ID_RE.test(value)) {
    fail(
      RENDEZVOUS_ERROR_CODES.NODE_ID_INVALID,
      `${name} must be wn1- plus a canonical 32-byte lowercase base32 digest`,
      "identity",
    );
  }
  assertByteLength(
    decodeBase32(value.slice(4), { maxBytes: 32 }),
    32,
    name,
    RENDEZVOUS_ERROR_CODES.NODE_ID_INVALID,
  );
  return value;
}

function cryptoProvider(options = {}) {
  let provider;
  try {
    provider = options.crypto ?? globalThis.crypto;
    // Read structural-provider members inside the sanitized boundary too:
    // injected Web Crypto adapters may implement them with getters.
    if (provider && typeof provider.getRandomValues === "function" && provider.subtle) {
      return provider;
    }
  } catch {
    throw internalError("a usable Web Crypto provider is required", {
      code: RENDEZVOUS_ERROR_CODES.CRYPTO_UNAVAILABLE,
      phase: "crypto",
    });
  }
  fail(
    RENDEZVOUS_ERROR_CODES.CRYPTO_UNAVAILABLE,
    "a Web Crypto provider with getRandomValues and subtle is required",
    "crypto",
  );
}

function randomId(provider, bytes = 24) {
  const value = new Uint8Array(bytes);
  try {
    provider.getRandomValues(value);
  } catch {
    throw internalError("secure random generation failed", {
      code: RENDEZVOUS_ERROR_CODES.CRYPTO_UNAVAILABLE,
      phase: "crypto",
    });
  }
  return encodeBase64Url(value);
}

async function sha256(value, options = {}) {
  try {
    return new Uint8Array(await cryptoProvider(options).subtle.digest("SHA-256", value));
  } catch {
    throw internalError("SHA-256 failed", {
      code: RENDEZVOUS_ERROR_CODES.CRYPTO_UNAVAILABLE,
      phase: "crypto",
    });
  }
}

function looksLikeCryptoKey(value) {
  return value && typeof value === "object" && typeof value.type === "string" &&
    value.algorithm && typeof value.algorithm.name === "string";
}

function validateCryptoKey(key, type, usage, name) {
  if (!looksLikeCryptoKey(key) || key.type !== type || key.algorithm.name !== "Ed25519" ||
      !Array.isArray(key.usages) || !key.usages.includes(usage)) {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      `${name} must be an Ed25519 ${type} CryptoKey usable for ${usage}`,
      "identity",
    );
  }
  return key;
}

async function rawPublicKey(value, options = {}) {
  if (typeof value === "string") {
    return assertByteLength(
      decodeBase64Url(value, { maxBytes: 32 }),
      32,
      "Ed25519 public key",
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
    );
  }
  if (looksLikeCryptoKey(value)) {
    validateCryptoKey(value, "public", "verify", "verificationKey");
    try {
      return assertByteLength(
        new Uint8Array(await cryptoProvider(options).subtle.exportKey("raw", value)),
        32,
        "Ed25519 public key",
        RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      );
    } catch {
      throw internalError("could not export Ed25519 public key", {
        code: RENDEZVOUS_ERROR_CODES.KEY_INVALID,
        phase: "identity",
      });
    }
  }
  return assertByteLength(
    asBytes(value, "Ed25519 public key"),
    32,
    "Ed25519 public key",
    RENDEZVOUS_ERROR_CODES.KEY_INVALID,
  );
}

async function importVerificationKey(publicKey, options = {}) {
  const provider = cryptoProvider(options);
  const bytes = await rawPublicKey(publicKey, options);
  try {
    return await provider.subtle.importKey("raw", bytes, ED25519, false, ["verify"]);
  } catch {
    throw internalError("could not import Ed25519 public key", {
      code: RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      phase: "identity",
    });
  }
}

export async function nodeIdFromPublicKey(publicKey, options = {}) {
  const bytes = await rawPublicKey(publicKey, options);
  return `wn1-${encodeBase32(await sha256(bytes, options))}`;
}

export async function verifyNodeId(nodeId, publicKey, options = {}) {
  canonicalNodeId(nodeId);
  const derived = await nodeIdFromPublicKey(publicKey, options);
  if (derived !== nodeId) {
    fail(
      RENDEZVOUS_ERROR_CODES.NODE_ID_MISMATCH,
      "NodeID does not match the supplied Ed25519 public key",
      "identity",
    );
  }
  return true;
}

export async function createNodeIdentity(keyPair, options = {}) {
  if (!keyPair || typeof keyPair !== "object") {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      "keyPair must contain Ed25519 publicKey and privateKey CryptoKeys",
      "identity",
    );
  }
  const verificationKey = validateCryptoKey(
    keyPair.publicKey,
    "public",
    "verify",
    "publicKey",
  );
  const signingKey = validateCryptoKey(
    keyPair.privateKey,
    "private",
    "sign",
    "privateKey",
  );
  const provider = cryptoProvider(options);
  const publicBytes = await rawPublicKey(verificationKey, options);
  let proof;
  let valid;
  try {
    proof = await provider.subtle.sign(ED25519, signingKey, IDENTITY_CHECK_DOMAIN);
    valid = await provider.subtle.verify(
      ED25519,
      verificationKey,
      proof,
      IDENTITY_CHECK_DOMAIN,
    );
  } catch {
    throw internalError("could not validate Ed25519 key pair", {
      code: RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      phase: "identity",
    });
  }
  if (!valid) {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      "Ed25519 public and private keys do not form a pair",
      "identity",
    );
  }
  const identity = {
    nodeId: await nodeIdFromPublicKey(publicBytes, options),
    publicKey: encodeBase64Url(publicBytes),
    verificationKey,
    signingKey,
  };
  Object.freeze(identity);
  PACKAGE_IDENTITIES.add(identity);
  return identity;
}

export async function generateNodeIdentity(options = {}) {
  const provider = cryptoProvider(options);
  let keyPair;
  try {
    keyPair = await provider.subtle.generateKey(
      ED25519,
      options.extractable === true,
      ["sign", "verify"],
    );
  } catch {
    throw internalError("could not generate Ed25519 identity", {
      code: RENDEZVOUS_ERROR_CODES.CRYPTO_UNAVAILABLE,
      phase: "identity",
    });
  }
  return createNodeIdentity(keyPair, options);
}

const CAPABILITY_FIELDS = Object.freeze([
  "v",
  "type",
  "id",
  "issuer",
  "issuerPublicKey",
  "subject",
  "audience",
  "sessionId",
  "action",
  "resource",
  "applicationProtocol",
  "channels",
  "privacy",
  "signalingVisibility",
  "limits",
  "actor",
  "onBehalfOf",
  "serviceId",
  "profile",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "singleUse",
  "signature",
]);
const CAPABILITY_UNSIGNED_FIELDS = CAPABILITY_FIELDS.slice(0, -1);
const CAPABILITY_CLAIM_FIELDS = new Set([
  "id",
  "issuer",
  "issuerPublicKey",
  "subject",
  "audience",
  "sessionId",
  "action",
  "resource",
  "applicationProtocol",
  "channels",
  "privacy",
  "signalingVisibility",
  "limits",
  "actor",
  "onBehalfOf",
  "serviceId",
  "profile",
  "issuedAt",
  "notBefore",
  "expiresAt",
  "singleUse",
]);
const REQUIRED_CAPABILITY_POLICY_FIELDS = Object.freeze([
  "subject",
  "audience",
  "action",
  "resource",
  "applicationProtocol",
  "channels",
  "privacy",
  "limits",
  "actor",
  "onBehalfOf",
  "serviceId",
  "profile",
]);
const LIMIT_FIELDS = Object.freeze([
  "maxSignals",
  "maxSignalBytes",
  "maxSessionDurationMs",
]);
const CHANNEL_FIELDS = Object.freeze(["label", "protocol"]);

function clockFailure() {
  return internalError("clock operation failed", {
    code: RENDEZVOUS_ERROR_CODES.CLOCK_FAILED,
    phase: "clock",
  });
}

function callClock(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw clockFailure();
  }
  try {
    return nonNegativeSafeInteger(value, "current time");
  } catch {
    throw clockFailure();
  }
}

function nowFrom(options = {}) {
  let configured;
  try {
    configured = options.now;
  } catch {
    throw clockFailure();
  }
  if (typeof configured === "function") return callClock(configured);
  if (configured === undefined) return callClock(Date.now);
  return nonNegativeSafeInteger(configured, "current time");
}

function normalizeChannels(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANNELS) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      `channels must contain between 1 and ${MAX_CHANNELS} entries`,
      "capability",
    );
  }
  const labels = new Set();
  return value.map((channel, index) => {
    exactKeys(
      channel,
      CHANNEL_FIELDS,
      `channels[${index}]`,
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
    );
    const label = boundedString(channel.label, `channels[${index}].label`, 256);
    const protocol = boundedString(
      channel.protocol,
      `channels[${index}].protocol`,
      256,
      { empty: true },
    );
    if (labels.has(label)) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
        "duplicate channel label",
        "capability",
      );
    }
    labels.add(label);
    return { label, protocol };
  });
}

function sortedChannels(value) {
  return normalizeChannels(value).sort((left, right) => {
    if (left.label !== right.label) return left.label < right.label ? -1 : 1;
    if (left.protocol === right.protocol) return 0;
    return left.protocol < right.protocol ? -1 : 1;
  });
}

function normalizeLimits(value, maximumDurationMs = MAX_CAPABILITY_LIFETIME_MS) {
  exactKeys(
    value,
    LIMIT_FIELDS,
    "limits",
    RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
  );
  return {
    maxSignals: positiveSafeInteger(value.maxSignals, "limits.maxSignals", MAX_SIGNALS),
    maxSignalBytes: positiveSafeInteger(
      value.maxSignalBytes,
      "limits.maxSignalBytes",
      MAX_SIGNAL_BYTES,
    ),
    maxSessionDurationMs: positiveSafeInteger(
      value.maxSessionDurationMs,
      "limits.maxSessionDurationMs",
      Math.min(MAX_CAPABILITY_LIFETIME_MS, maximumDurationMs),
    ),
  };
}

function normalizeCapabilityRecord(value) {
  exactKeys(
    value,
    CAPABILITY_FIELDS,
    "connection capability",
    RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
  );
  if (value.v !== 1 || value.type !== "capability") {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "connection capability must use v:1 and type:capability",
      "capability",
    );
  }
  const issuedAt = nonNegativeSafeInteger(value.issuedAt, "issuedAt");
  const notBefore = nonNegativeSafeInteger(value.notBefore, "notBefore");
  const expiresAt = nonNegativeSafeInteger(value.expiresAt, "expiresAt");
  if (notBefore < issuedAt || expiresAt <= notBefore ||
      expiresAt - issuedAt > MAX_CAPABILITY_LIFETIME_MS) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      `capability lifetime must be positive and at most ${MAX_CAPABILITY_LIFETIME_MS} ms`,
      "capability",
    );
  }
  const issuerPublicBytes = assertByteLength(
    decodeBase64Url(value.issuerPublicKey, { maxBytes: 32 }),
    32,
    "issuerPublicKey",
    RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
  );
  const signatureBytes = assertByteLength(
    decodeBase64Url(value.signature, { maxBytes: 64 }),
    64,
    "capability signature",
    RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
  );
  const privacy = boundedString(value.privacy, "privacy", 32);
  if (!PRIVACY_MODES.has(privacy)) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "privacy is not a supported v1 privacy mode",
      "capability",
    );
  }
  const signalingVisibility = boundedString(
    value.signalingVisibility,
    "signalingVisibility",
    32,
  );
  if (!SIGNALING_VISIBILITIES.has(signalingVisibility)) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "v1 supports only rendezvous-visible authenticated signaling",
      "capability",
    );
  }
  if (value.singleUse !== true) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "v1 connection capabilities must be single-use",
      "capability",
    );
  }
  const subject = canonicalNodeId(value.subject, "subject");
  const audience = canonicalNodeId(value.audience, "audience");
  if (subject === audience) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "capability subject and audience must be different NodeIDs",
      "capability",
    );
  }
  const result = {
    v: 1,
    type: "capability",
    id: canonicalOpaqueId(value.id, "capability id"),
    issuer: canonicalNodeId(value.issuer, "issuer"),
    issuerPublicKey: encodeBase64Url(issuerPublicBytes),
    subject,
    audience,
    sessionId: canonicalOpaqueId(value.sessionId, "sessionId"),
    action: boundedString(value.action, "action", 128),
    resource: boundedString(value.resource, "resource", 512),
    applicationProtocol: boundedString(
      value.applicationProtocol,
      "applicationProtocol",
      128,
    ),
    channels: normalizeChannels(value.channels),
    privacy,
    signalingVisibility,
    limits: normalizeLimits(value.limits),
    actor: boundedString(value.actor, "actor", 512),
    onBehalfOf: boundedString(value.onBehalfOf, "onBehalfOf", 512, { nullable: true }),
    serviceId: boundedString(value.serviceId, "serviceId", 128),
    profile: boundedString(value.profile, "profile", 128),
    issuedAt,
    notBefore,
    expiresAt,
    singleUse: true,
    signature: encodeBase64Url(signatureBytes),
  };
  canonicalizeJson(result, { maxBytes: MAX_CAPABILITY_BYTES });
  return result;
}

function capabilityUnsigned(capability) {
  return Object.fromEntries(
    CAPABILITY_UNSIGNED_FIELDS.map((field) => [field, capability[field]]),
  );
}

function concatBytes(left, right) {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

function signingInput(domain, value, maxBytes) {
  return concatBytes(
    UTF8.encode(domain),
    canonicalizeJsonBytes(value, { maxBytes }),
  );
}

async function signValue(domain, value, signer, maxBytes, options = {}) {
  const input = signingInput(domain, value, maxBytes);
  const signingKey = looksLikeCryptoKey(signer) ? signer : signer?.signingKey;
  try {
    let raw;
    if (signingKey !== undefined) {
      validateCryptoKey(signingKey, "private", "sign", "signingKey");
      raw = await cryptoProvider(options).subtle.sign(ED25519, signingKey, input);
    } else if (typeof signer?.sign === "function") {
      // This structural hook permits hardware keys and remote KMS signers.
      // The package still verifies the returned Ed25519 signature against the
      // self-certifying public key before returning a signed record.
      raw = await signer.sign(input.slice());
    } else {
      fail(
        RENDEZVOUS_ERROR_CODES.KEY_INVALID,
        "identity requires an Ed25519 signingKey or sign(bytes) function",
        "sign",
      );
    }
    const signature = asBytes(raw, "Ed25519 signature");
    return encodeBase64Url(assertByteLength(
      signature,
      64,
      "Ed25519 signature",
      RENDEZVOUS_ERROR_CODES.SIGNATURE_INVALID,
    ));
  } catch {
    throw internalError("Ed25519 signing failed", {
      code: RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      phase: "sign",
    });
  }
}

async function verifyValue(
  domain,
  value,
  signature,
  publicKey,
  maxBytes,
  options = {},
) {
  const signatureBytes = assertByteLength(
    decodeBase64Url(signature, { maxBytes: 64 }),
    64,
    "Ed25519 signature",
    RENDEZVOUS_ERROR_CODES.SIGNATURE_INVALID,
  );
  const verificationKey = await importVerificationKey(publicKey, options);
  let valid;
  try {
    valid = await cryptoProvider(options).subtle.verify(
      ED25519,
      verificationKey,
      signatureBytes,
      signingInput(domain, value, maxBytes),
    );
  } catch {
    throw internalError("Ed25519 verification failed", {
      code: RENDEZVOUS_ERROR_CODES.SIGNATURE_INVALID,
      phase: "verify",
    });
  }
  if (!valid) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNATURE_INVALID,
      "Ed25519 signature is invalid",
      "verify",
    );
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function validateIdentity(identity, options = {}) {
  if (!identity || typeof identity !== "object") {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      "identity must be created by generateNodeIdentity or createNodeIdentity",
      "identity",
    );
  }
  let nodeIdValue;
  let publicKeyValue;
  let signingKey;
  let sign;
  try {
    nodeIdValue = identity.nodeId;
    publicKeyValue = identity.publicKey;
    signingKey = identity.signingKey;
    sign = identity.sign;
  } catch {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      "identity fields could not be read",
      "identity",
    );
  }
  const nodeId = canonicalNodeId(nodeIdValue);
  const publicBytes = assertByteLength(
    decodeBase64Url(publicKeyValue, { maxBytes: 32 }),
    32,
    "identity publicKey",
    RENDEZVOUS_ERROR_CODES.KEY_INVALID,
  );
  if (signingKey !== undefined) {
    validateCryptoKey(signingKey, "private", "sign", "identity.signingKey");
  } else if (typeof sign !== "function") {
    fail(
      RENDEZVOUS_ERROR_CODES.KEY_INVALID,
      "identity requires an Ed25519 signingKey or sign(bytes) function",
      "identity",
    );
  }
  await verifyNodeId(nodeId, publicBytes, options);
  if (PACKAGE_IDENTITIES.has(identity)) return { identity, publicBytes };

  // Snapshot arbitrary structural/KMS identities. Reading caller-controlled
  // getters again after proof-of-possession could otherwise relabel a session.
  const stableIdentity = {
    nodeId,
    publicKey: encodeBase64Url(publicBytes),
    ...(signingKey === undefined
      ? { sign: (bytes) => sign.call(identity, bytes) }
      : { signingKey }),
  };
  Object.freeze(stableIdentity);
  const proofValue = {
    nodeId: stableIdentity.nodeId,
    publicKey: stableIdentity.publicKey,
  };
  const proof = await signValue(
    "weave.rendezvous.identity-proof.v1\0",
    proofValue,
    stableIdentity,
    1024,
    options,
  );
  await verifyValue(
    "weave.rendezvous.identity-proof.v1\0",
    proofValue,
    proof,
    stableIdentity.publicKey,
    1024,
    options,
  );
  return { identity: stableIdentity, publicBytes };
}

/** Issue one exact, short-lived connection capability with an Ed25519 NodeID. */
export async function issueConnectionCapability(claims, issuerIdentity, options = {}) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
      "capability claims must be an object",
      "capability",
    );
  }
  for (const key of Object.keys(claims)) {
    if (!CAPABILITY_CLAIM_FIELDS.has(key)) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
        "capability claims contain an unsupported field",
        "capability",
      );
    }
  }
  for (const field of REQUIRED_CAPABILITY_POLICY_FIELDS) {
    if (!Object.hasOwn(claims, field) || claims[field] === undefined) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_INVALID,
        `capability issuance requires explicit ${field}`,
        "capability",
      );
    }
  }
  const { identity } = await validateIdentity(issuerIdentity, options);
  if (claims.issuer !== undefined && claims.issuer !== identity.nodeId ||
      claims.issuerPublicKey !== undefined && claims.issuerPublicKey !== identity.publicKey) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
      "capability issuer fields do not match its signing identity",
      "capability",
    );
  }
  const provider = cryptoProvider(options);
  const issuedAt = claims.issuedAt ?? nowFrom(options);
  const notBefore = claims.notBefore ?? issuedAt;
  const expiresAt = claims.expiresAt ?? issuedAt + DEFAULT_CAPABILITY_TTL_MS;
  const unsigned = {
    v: 1,
    type: "capability",
    id: claims.id ?? randomId(provider),
    issuer: identity.nodeId,
    issuerPublicKey: identity.publicKey,
    subject: claims.subject,
    audience: claims.audience,
    sessionId: claims.sessionId ?? randomId(provider),
    action: claims.action,
    resource: claims.resource,
    applicationProtocol: claims.applicationProtocol,
    channels: claims.channels,
    privacy: claims.privacy,
    signalingVisibility: claims.signalingVisibility ?? "rendezvous-visible",
    limits: claims.limits,
    actor: claims.actor,
    onBehalfOf: claims.onBehalfOf,
    serviceId: claims.serviceId,
    profile: claims.profile,
    issuedAt,
    notBefore,
    expiresAt,
    singleUse: claims.singleUse ?? true,
  };
  const provisional = normalizeCapabilityRecord({ ...unsigned, signature: encodeBase64Url(new Uint8Array(64)) });
  const normalizedUnsigned = capabilityUnsigned(provisional);
  const signature = await signValue(
    CAPABILITY_SIGNATURE_DOMAIN,
    normalizedUnsigned,
    identity,
    MAX_CAPABILITY_BYTES,
    options,
  );
  await verifyValue(
    CAPABILITY_SIGNATURE_DOMAIN,
    normalizedUnsigned,
    signature,
    identity.publicKey,
    MAX_CAPABILITY_BYTES,
    options,
  );
  return deepFreeze(normalizeCapabilityRecord({ ...normalizedUnsigned, signature }));
}

/** Normalize and serialize one exact-schema capability to canonical UTF-8 bytes. */
export function serializeConnectionCapability(value) {
  return canonicalizeJsonBytes(normalizeCapabilityRecord(value), {
    maxBytes: MAX_CAPABILITY_BYTES,
  });
}

export async function digestConnectionCapability(value, options = {}) {
  return `sha256-${encodeBase64Url(await sha256(
    serializeConnectionCapability(value),
    options,
  ))}`;
}

function trustedIssuer(issuer, options) {
  if (options.expectedIssuer !== undefined) {
    if (issuer !== canonicalNodeId(options.expectedIssuer, "expectedIssuer")) return false;
  }
  if (options.trustedIssuers !== undefined) {
    let values;
    try { values = [...options.trustedIssuers]; }
    catch {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
        "trustedIssuers must be iterable",
        "capability",
      );
    }
    return values.some((value) => canonicalNodeId(value, "trusted issuer") === issuer);
  }
  return options.expectedIssuer !== undefined || options.allowUntrustedIssuer === true;
}

function matchCapability(capability, options) {
  for (const [option, field] of [
    ["expectedSubject", "subject"],
    ["expectedAudience", "audience"],
    ["expectedSessionId", "sessionId"],
    ["expectedAction", "action"],
    ["expectedResource", "resource"],
    ["expectedApplicationProtocol", "applicationProtocol"],
    ["expectedServiceId", "serviceId"],
    ["expectedProfile", "profile"],
  ]) {
    if (options[option] !== undefined && capability[field] !== options[option]) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
        `capability ${field} does not match ${option}`,
        "capability",
      );
    }
  }
  for (const [option, field, normalize] of [
    ["expectedChannels", "channels", sortedChannels],
    ["expectedLimits", "limits", (value) => normalizeLimits(value)],
  ]) {
    const actual = field === "channels" ? sortedChannels(capability[field]) : capability[field];
    if (options[option] !== undefined && canonicalizeJson(actual) !==
        canonicalizeJson(normalize(options[option]))) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
        `capability ${field} does not match ${option}`,
        "capability",
      );
    }
  }
  for (const [option, field] of [
    ["expectedPrivacy", "privacy"],
    ["expectedSignalingVisibility", "signalingVisibility"],
    ["expectedActor", "actor"],
    ["expectedOnBehalfOf", "onBehalfOf"],
  ]) {
    if (options[option] !== undefined && capability[field] !== options[option]) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
        `capability ${field} does not match ${option}`,
        "capability",
      );
    }
  }
}

/**
 * Verify an already-decoded capability object. At an untrusted byte boundary,
 * use verifyConnectionCapabilityBytes() so canonical encoding and wire bounds
 * are enforced before object decoding can erase duplicate keys or whitespace.
 */
export async function verifyConnectionCapability(value, options = {}) {
  const capability = normalizeCapabilityRecord(value);
  await verifyNodeId(capability.issuer, capability.issuerPublicKey, options);
  if (!trustedIssuer(capability.issuer, options)) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_UNTRUSTED_ISSUER,
      "capability issuer is not in the caller's trust policy",
      "capability",
    );
  }
  await verifyValue(
    CAPABILITY_SIGNATURE_DOMAIN,
    capabilityUnsigned(capability),
    capability.signature,
    capability.issuerPublicKey,
    MAX_CAPABILITY_BYTES,
    options,
  );
  const now = nowFrom(options);
  const skew = nonNegativeSafeInteger(
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
    "clockSkewMs",
    MAX_CAPABILITY_LIFETIME_MS,
  );
  if (now + skew < capability.notBefore) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_NOT_YET_VALID,
      "connection capability is not yet valid",
      "capability",
    );
  }
  if (capability.issuedAt > now + skew) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_NOT_YET_VALID,
      "connection capability was issued too far in the future",
      "capability",
    );
  }
  if (now - skew >= capability.expiresAt) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_EXPIRED,
      "connection capability has expired",
      "capability",
    );
  }
  matchCapability(capability, options);
  const digest = await digestConnectionCapability(capability, options);
  if (options.consume === true) {
    if (!options.replayStore) {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
        "consume requires a replayStore with claim()",
        "capability",
      );
    }
    replayStoreMethod(options.replayStore, "claim");
    const claimed = await replayClaim(
      options.replayStore,
      `capability-inspection:v1:${digest}`,
      Math.min(Number.MAX_SAFE_INTEGER, capability.expiresAt + skew),
      now,
    );
    if (!claimed) {
      fail(
        RENDEZVOUS_ERROR_CODES.REPLAYED,
        "connection capability has already been consumed",
        "capability",
      );
    }
  }
  const result = { capability: deepFreeze(capability), digest };
  VERIFIED_CAPABILITIES.add(result);
  return deepFreeze(result);
}

/** Verify an exact canonical UTF-8 capability received from an untrusted transport. */
export async function verifyConnectionCapabilityBytes(input, options = {}) {
  const value = parseCanonicalJson(input, { maxBytes: MAX_CAPABILITY_BYTES });
  return verifyConnectionCapability(value, options);
}

const SIGNAL_FIELDS = Object.freeze([
  "v",
  "type",
  "sessionId",
  "capabilityDigest",
  "from",
  "fromPublicKey",
  "to",
  "role",
  "seq",
  "prev",
  "issuedAt",
  "expiresAt",
  "message",
  "signature",
]);
const SIGNAL_UNSIGNED_FIELDS = SIGNAL_FIELDS.slice(0, -1);
const SIGNAL_INPUT_FIELDS = new Set([
  "sessionId",
  "capabilityDigest",
  "to",
  "role",
  "seq",
  "prev",
  "issuedAt",
  "expiresAt",
  "message",
]);
const DESCRIPTION_FIELDS = Object.freeze(["type", "description"]);
const DESCRIPTION_VALUE_FIELDS = Object.freeze(["type", "sdp"]);
const CANDIDATE_KEYS = new Set([
  "candidate",
  "sdpMid",
  "sdpMLineIndex",
  "usernameFragment",
]);

function onlyKeys(value, allowed, name, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    fail(code, `${name} contains unsupported fields`, "signal");
  }
}

function normalizeSignalMessage(value, role, maximumBytes = MAX_SIGNAL_BYTES) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "signal message must be an object",
      "signal",
    );
  }
  let result;
  if (value.type === "description") {
    exactKeys(
      value,
      DESCRIPTION_FIELDS,
      "description signal",
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
    );
    exactKeys(
      value.description,
      DESCRIPTION_VALUE_FIELDS,
      "session description",
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
    );
    const expected = role === "offerer" ? "offer" : "answer";
    if (value.description.type !== expected) {
      fail(
        RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
        `${role} descriptions must have type ${expected}`,
        "signal",
      );
    }
    result = {
      type: "description",
      description: {
        type: expected,
        sdp: boundedString(value.description.sdp, "description.sdp", MAX_SIGNAL_BYTES),
      },
    };
  } else if (value.type === "candidate") {
    exactKeys(
      value,
      ["type", "candidate"],
      "candidate signal",
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
    );
    if (value.candidate === null) {
      result = { type: "candidate", candidate: null };
    } else {
      onlyKeys(
        value.candidate,
        CANDIDATE_KEYS,
        "ICE candidate",
        RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      );
      if (!Object.hasOwn(value.candidate, "candidate")) {
        fail(
          RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
          "ICE candidate requires candidate",
          "signal",
        );
      }
      const candidate = {
        candidate: boundedString(
          value.candidate.candidate,
          "candidate.candidate",
          16 * 1024,
        ),
      };
      for (const field of ["sdpMid", "usernameFragment"]) {
        if (Object.hasOwn(value.candidate, field)) {
          candidate[field] = value.candidate[field] === null
            ? null
            : boundedString(value.candidate[field], `candidate.${field}`, 1024, {
              empty: true,
            });
        }
      }
      if (Object.hasOwn(value.candidate, "sdpMLineIndex")) {
        candidate.sdpMLineIndex = value.candidate.sdpMLineIndex === null
          ? null
          : nonNegativeSafeInteger(
            value.candidate.sdpMLineIndex,
            "candidate.sdpMLineIndex",
            65_535,
          );
      }
      result = { type: "candidate", candidate };
    }
  } else {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "unknown WebRTC signal message type",
      "signal",
    );
  }
  canonicalizeJson(result, {
    maxBytes: result.type === "candidate" ? Math.min(maximumBytes, 16 * 1024) : maximumBytes,
  });
  return result;
}

function normalizeSignalRecord(value, maximumBytes = MAX_SIGNAL_BYTES) {
  maximumBytes = positiveSafeInteger(maximumBytes, "maxSignalBytes", MAX_SIGNAL_BYTES);
  exactKeys(value, SIGNAL_FIELDS, "signal envelope", RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID);
  if (value.v !== 1 || value.type !== "signal") {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "signal envelope must use v:1 and type:signal",
      "signal",
    );
  }
  const role = boundedString(value.role, "role", 16);
  if (!OFFER_ROLES.has(role)) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "signal role must be offerer or answerer",
      "signal",
    );
  }
  const seq = nonNegativeSafeInteger(value.seq, "seq", MAX_SIGNALS - 1);
  const prev = value.prev === null ? null : canonicalDigest(value.prev, "prev");
  if (seq === 0 && prev !== null || seq > 0 && prev === null) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_CHAIN,
      "signal seq 0 requires prev:null and later signals require a previous digest",
      "signal",
    );
  }
  const issuedAt = nonNegativeSafeInteger(value.issuedAt, "issuedAt");
  const expiresAt = nonNegativeSafeInteger(value.expiresAt, "expiresAt");
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_SIGNAL_LIFETIME_MS) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      `signal lifetime must be positive and at most ${MAX_SIGNAL_LIFETIME_MS} ms`,
      "signal",
    );
  }
  const publicBytes = assertByteLength(
    decodeBase64Url(value.fromPublicKey, { maxBytes: 32 }),
    32,
    "fromPublicKey",
    RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
  );
  const signatureBytes = assertByteLength(
    decodeBase64Url(value.signature, { maxBytes: 64 }),
    64,
    "signal signature",
    RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
  );
  const from = canonicalNodeId(value.from, "from");
  const to = canonicalNodeId(value.to, "to");
  if (from === to) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "signal source and target must differ",
      "signal",
    );
  }
  const result = {
    v: 1,
    type: "signal",
    sessionId: canonicalOpaqueId(value.sessionId, "sessionId"),
    capabilityDigest: canonicalDigest(value.capabilityDigest, "capabilityDigest"),
    from,
    fromPublicKey: encodeBase64Url(publicBytes),
    to,
    role,
    seq,
    prev,
    issuedAt,
    expiresAt,
    message: normalizeSignalMessage(value.message, role, maximumBytes),
    signature: encodeBase64Url(signatureBytes),
  };
  if (seq === 0 && result.message.type !== "description") {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
      "the first signal in each sender chain must be its session description",
      "signal",
    );
  }
  canonicalizeJson(result, { maxBytes: maximumBytes + 64 * 1024 });
  return result;
}

function signalUnsigned(signal) {
  return Object.fromEntries(SIGNAL_UNSIGNED_FIELDS.map((field) => [field, signal[field]]));
}

/** Create one sequenced, hash-chainable peer-signed WebRTC signal envelope. */
export async function createSignalEnvelope(fields, identityValue, options = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    fail(RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID, "signal fields must be an object", "signal");
  }
  for (const key of Object.keys(fields)) {
    if (!SIGNAL_INPUT_FIELDS.has(key)) {
      fail(
        RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
        "signal fields contain an unsupported field",
        "signal",
      );
    }
  }
  const { identity } = await validateIdentity(identityValue, options);
  const issuedAt = fields.issuedAt ?? nowFrom(options);
  const unsigned = {
    v: 1,
    type: "signal",
    sessionId: fields.sessionId,
    capabilityDigest: fields.capabilityDigest,
    from: identity.nodeId,
    fromPublicKey: identity.publicKey,
    to: fields.to,
    role: fields.role,
    seq: fields.seq,
    prev: fields.prev,
    issuedAt,
    expiresAt: fields.expiresAt ?? issuedAt + DEFAULT_SIGNAL_TTL_MS,
    message: fields.message,
  };
  const provisional = normalizeSignalRecord({
    ...unsigned,
    signature: encodeBase64Url(new Uint8Array(64)),
  }, options.maxSignalBytes ?? MAX_SIGNAL_BYTES);
  const normalizedUnsigned = signalUnsigned(provisional);
  const signature = await signValue(
    SIGNAL_SIGNATURE_DOMAIN,
    normalizedUnsigned,
    identity,
    (options.maxSignalBytes ?? MAX_SIGNAL_BYTES) + 64 * 1024,
    options,
  );
  await verifyValue(
    SIGNAL_SIGNATURE_DOMAIN,
    normalizedUnsigned,
    signature,
    identity.publicKey,
    (options.maxSignalBytes ?? MAX_SIGNAL_BYTES) + 64 * 1024,
    options,
  );
  return deepFreeze(normalizeSignalRecord(
    { ...normalizedUnsigned, signature },
    options.maxSignalBytes ?? MAX_SIGNAL_BYTES,
  ));
}

/** Normalize and serialize one exact-schema signal to canonical UTF-8 bytes. */
export function serializeSignalEnvelope(value, options = {}) {
  const maximumBytes = positiveSafeInteger(
    options.maxSignalBytes ?? MAX_SIGNAL_BYTES,
    "maxSignalBytes",
    MAX_SIGNAL_BYTES,
  );
  return canonicalizeJsonBytes(
    normalizeSignalRecord(value, maximumBytes),
    { maxBytes: maximumBytes + 64 * 1024 },
  );
}

export async function digestSignalEnvelope(value, options = {}) {
  return `sha256-${encodeBase64Url(await sha256(
    serializeSignalEnvelope(value, options),
    options,
  ))}`;
}

function verifiedCapabilityOption(value) {
  if (!value || typeof value !== "object" || !VERIFIED_CAPABILITIES.has(value) ||
      !value.capability || typeof value.digest !== "string") {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "capability must be an unmodified result of verifyConnectionCapability()",
      "signal",
    );
  }
  const capability = normalizeCapabilityRecord(value.capability);
  canonicalDigest(value.digest, "verified capability digest");
  return { capability, digest: value.digest };
}

function matchSignal(signal, options) {
  for (const [option, field] of [
    ["expectedSessionId", "sessionId"],
    ["expectedCapabilityDigest", "capabilityDigest"],
    ["expectedFrom", "from"],
    ["expectedTo", "to"],
    ["expectedRole", "role"],
    ["expectedSeq", "seq"],
    ["expectedPrev", "prev"],
  ]) {
    if (options[option] !== undefined && signal[field] !== options[option]) {
      const code = field === "seq"
        ? RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE
        : field === "prev"
          ? RENDEZVOUS_ERROR_CODES.SIGNAL_CHAIN
          : RENDEZVOUS_ERROR_CODES.SIGNAL_MISMATCH;
      fail(code, `signal ${field} does not match ${option}`, "signal");
    }
  }
}

/**
 * Verify an already-decoded signal object. At an untrusted byte boundary, use
 * verifySignalEnvelopeBytes() before applying anything to WebRTC state.
 */
export async function verifySignalEnvelope(value, options = {}) {
  if (options.capability === undefined && options.allowUnscoped !== true) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_MISMATCH,
      "signal verification requires a verified connection capability",
      "signal",
    );
  }
  const verifiedCapability = options.capability === undefined
    ? null
    : verifiedCapabilityOption(options.capability);
  const configuredMaximumBytes = positiveSafeInteger(
    options.maxSignalBytes ?? MAX_SIGNAL_BYTES,
    "maxSignalBytes",
    MAX_SIGNAL_BYTES,
  );
  const maximumBytes = Math.min(
    verifiedCapability?.capability.limits.maxSignalBytes ?? MAX_SIGNAL_BYTES,
    configuredMaximumBytes,
  );
  const signal = normalizeSignalRecord(value, maximumBytes);
  await verifyNodeId(signal.from, signal.fromPublicKey, options);
  await verifyValue(
    SIGNAL_SIGNATURE_DOMAIN,
    signalUnsigned(signal),
    signal.signature,
    signal.fromPublicKey,
    maximumBytes + 64 * 1024,
    options,
  );
  const now = nowFrom(options);
  const skew = nonNegativeSafeInteger(
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
    "clockSkewMs",
    MAX_CAPABILITY_LIFETIME_MS,
  );
  if (signal.issuedAt > now + skew) {
    fail(
      RENDEZVOUS_ERROR_CODES.SIGNAL_INVALID,
      "signal issuedAt is too far in the future",
      "signal",
    );
  }
  if (now - skew >= signal.expiresAt) {
    fail(RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED, "signal has expired", "signal");
  }
  if (verifiedCapability) {
    const { capability, digest } = verifiedCapability;
    const pairMatches = signal.from === capability.subject && signal.to === capability.audience ||
      signal.from === capability.audience && signal.to === capability.subject;
    const expectedCapabilityRole = signal.from === capability.subject
      ? "offerer"
      : "answerer";
    if (!pairMatches || signal.role !== expectedCapabilityRole ||
        signal.sessionId !== capability.sessionId ||
        signal.capabilityDigest !== digest || signal.seq >= capability.limits.maxSignals ||
        signal.issuedAt < capability.notBefore ||
        signal.expiresAt > capability.expiresAt) {
      fail(
        RENDEZVOUS_ERROR_CODES.SIGNAL_MISMATCH,
        "signal is outside the verified connection capability",
        "signal",
      );
    }
  }
  matchSignal(signal, options);
  const digest = await digestSignalEnvelope(signal, { ...options, maxSignalBytes: maximumBytes });
  if (options.replayStore && options.consume !== false) {
    replayStoreMethod(options.replayStore, "claim");
    const claimed = await replayClaim(
      options.replayStore,
      `signal:v1:${digest}`,
      Math.min(Number.MAX_SAFE_INTEGER, signal.expiresAt + skew),
      now,
    );
    if (!claimed) {
      fail(RENDEZVOUS_ERROR_CODES.REPLAYED, "signal has already been consumed", "signal");
    }
  }
  return deepFreeze({ envelope: deepFreeze(signal), digest, message: signal.message });
}

/** Verify an exact canonical UTF-8 signal received from an untrusted transport. */
export async function verifySignalEnvelopeBytes(input, options = {}) {
  const verifiedCapability = options.capability === undefined
    ? null
    : verifiedCapabilityOption(options.capability);
  const configuredMaximumBytes = positiveSafeInteger(
    options.maxSignalBytes ?? MAX_SIGNAL_BYTES,
    "maxSignalBytes",
    MAX_SIGNAL_BYTES,
  );
  const maximumBytes = Math.min(
    verifiedCapability?.capability.limits.maxSignalBytes ?? MAX_SIGNAL_BYTES,
    configuredMaximumBytes,
  );
  const value = parseCanonicalJson(input, { maxBytes: maximumBytes + 64 * 1024 });
  return verifySignalEnvelope(value, options);
}

/** A bounded replay cache that never evicts an unexpired security decision. */
export class InMemoryReplayStore {
  constructor(options = {}) {
    this.maxEntries = positiveSafeInteger(
      options.maxEntries ?? DEFAULT_MAX_REPLAY_ENTRIES,
      "maxEntries",
      1_000_000,
    );
    let clock;
    try {
      clock = options.clock;
    } catch {
      throw clockFailure();
    }
    if (clock !== undefined && typeof clock !== "function") {
      fail(
        RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
        "clock must be a function",
        "replay",
      );
    }
    this.clock = clock ?? Date.now;
    this.entries = new Map();
  }

  get size() { return this.entries.size; }

  prune(now) {
    const current = now === undefined
      ? callClock(this.clock)
      : nonNegativeSafeInteger(now, "current time");
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= current) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  has(key, now) {
    boundedString(key, "replay key", 512);
    const current = now === undefined
      ? callClock(this.clock)
      : nonNegativeSafeInteger(now, "current time");
    this.prune(current);
    return this.entries.has(key);
  }

  claim(key, expiresAt, now) {
    boundedString(key, "replay key", 512);
    const current = now === undefined
      ? callClock(this.clock)
      : nonNegativeSafeInteger(now, "current time");
    nonNegativeSafeInteger(expiresAt, "replay expiry");
    this.prune(current);
    if (expiresAt <= current) return false;
    if (this.entries.has(key)) return false;
    if (this.entries.size >= this.maxEntries) {
      fail(
        RENDEZVOUS_ERROR_CODES.REPLAY_STORE_FULL,
        `replay store reached its ${this.maxEntries} unexpired-entry limit`,
        "replay",
      );
    }
    this.entries.set(key, { expiresAt, value: null, reservation: false });
    return true;
  }

  compareAndReserve(key, value, expiresAt, now) {
    boundedString(key, "replay key", 512);
    boundedString(value, "replay reservation value", 512);
    const current = now === undefined
      ? callClock(this.clock)
      : nonNegativeSafeInteger(now, "current time");
    nonNegativeSafeInteger(expiresAt, "replay expiry");
    this.prune(current);
    if (expiresAt <= current) return "conflict";
    const existing = this.entries.get(key);
    if (existing) {
      return existing.reservation && existing.value === value ? "matched" : "conflict";
    }
    if (this.entries.size >= this.maxEntries) {
      fail(
        RENDEZVOUS_ERROR_CODES.REPLAY_STORE_FULL,
        `replay store reached its ${this.maxEntries} unexpired-entry limit`,
        "replay",
      );
    }
    this.entries.set(key, { expiresAt, value, reservation: true });
    return "reserved";
  }

  clear() { this.entries.clear(); }
}

function sessionNow(baseOptions, operationOptions = {}) {
  let operationNow;
  let baseClock;
  try {
    operationNow = operationOptions.now;
    baseClock = baseOptions.clock;
  } catch {
    throw clockFailure();
  }
  if (operationNow !== undefined) return nowFrom({ now: operationNow });
  if (typeof baseClock === "function") return nowFrom({ now: baseClock });
  if (baseClock !== undefined) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "clock must be a function",
      "clock",
    );
  }
  return nowFrom(baseOptions);
}

function oppositeRole(role) { return role === "offerer" ? "answerer" : "offerer"; }

function sessionClosedError() {
  return internalError("authenticated rendezvous session is closed", {
    code: RENDEZVOUS_ERROR_CODES.SESSION_CLOSED,
    phase: "session",
  });
}

/**
 * Bind one verified connection capability to a local identity and peer.
 * `outbound()` serializes signatures and advances the local hash chain;
 * `inbound()` verifies and applies one remote signal before advancing its
 * cursor. Transport and retry policy remain caller-owned.
 */
export async function createAuthenticatedSession(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "authenticated session options must be an object",
      "session",
    );
  }
  const { identity } = await validateIdentity(options.identity, options);
  const peerNodeId = canonicalNodeId(options.peerNodeId, "peerNodeId");
  if (peerNodeId === identity.nodeId) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
      "authenticated session peer must differ from the local NodeID",
      "session",
    );
  }
  if (!OFFER_ROLES.has(options.role)) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "authenticated session role must be offerer or answerer",
      "session",
    );
  }
  for (const field of [
    "sessionId",
    "action",
    "resource",
    "applicationProtocol",
    "channels",
    "privacy",
    "signalingVisibility",
    "limits",
    "actor",
    "onBehalfOf",
    "serviceId",
    "profile",
  ]) {
    if (!Object.hasOwn(options, field) || options[field] === undefined) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
        `authenticated session requires an explicit ${field} policy`,
        "session",
      );
    }
  }
  if (options.onMessage !== undefined && typeof options.onMessage !== "function") {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "onMessage must be a function",
      "session",
    );
  }
  let enforceSessionPolicy;
  try {
    enforceSessionPolicy = options.enforceSessionPolicy;
  } catch {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "authenticated session policy callback could not be read",
      "session",
    );
  }
  if (typeof enforceSessionPolicy !== "function") {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "authenticated session requires an enforceSessionPolicy() callback",
      "session",
    );
  }
  const consumeCapability = options.consumeCapability !== false;
  if (consumeCapability && options.replayStore == null) {
    fail(
      RENDEZVOUS_ERROR_CODES.INVALID_ARGUMENT,
      "single-use capability enforcement requires an explicit shared replayStore",
      "session",
    );
  }
  const replayStore = options.replayStore ?? new InMemoryReplayStore({
    maxEntries: options.maxReplayEntries ?? DEFAULT_MAX_REPLAY_ENTRIES,
    clock: options.clock,
  });
  replayStoreMethod(replayStore, "claim");
  if (consumeCapability) replayStoreMethod(replayStore, "compareAndReserve");
  const createdAt = sessionNow(options);
  const verified = await verifyConnectionCapability(options.capability, {
    crypto: options.crypto,
    now: createdAt,
    clockSkewMs: options.clockSkewMs,
    expectedIssuer: options.expectedIssuer,
    trustedIssuers: options.trustedIssuers,
    allowUntrustedIssuer: options.allowUntrustedIssuer,
    expectedSubject: options.role === "offerer" ? identity.nodeId : peerNodeId,
    expectedAudience: options.role === "offerer" ? peerNodeId : identity.nodeId,
    expectedSessionId: options.sessionId,
    expectedAction: options.action,
    expectedResource: options.resource,
    expectedApplicationProtocol: options.applicationProtocol,
    expectedChannels: options.channels,
    expectedPrivacy: options.privacy,
    expectedSignalingVisibility: options.signalingVisibility,
    expectedLimits: options.limits,
    expectedActor: options.actor,
    expectedOnBehalfOf: options.onBehalfOf,
    expectedServiceId: options.serviceId,
    expectedProfile: options.profile,
  });
  const { capability, digest: capabilityDigest } = verified;
  const pairMatches = capability.subject === identity.nodeId &&
      capability.audience === peerNodeId ||
    capability.subject === peerNodeId && capability.audience === identity.nodeId;
  if (!pairMatches) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
      "connection capability does not authorize this local/peer NodeID pair",
      "session",
    );
  }
  const expectedLocalRole = capability.subject === identity.nodeId ? "offerer" : "answerer";
  if (options.role !== expectedLocalRole) {
    fail(
      RENDEZVOUS_ERROR_CODES.CAPABILITY_MISMATCH,
      "capability subject must be offerer and audience must be answerer",
      "session",
    );
  }
  const skew = nonNegativeSafeInteger(
    options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS,
    "clockSkewMs",
    MAX_CAPABILITY_LIFETIME_MS,
  );
  const deadline = Math.min(
    capability.expiresAt,
    createdAt + capability.limits.maxSessionDurationMs,
  );
  const assertConstructionActive = () => {
    if (sessionNow(options) >= deadline) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_EXPIRED,
        "authenticated session authorization has expired",
        "session",
      );
    }
  };
  assertConstructionActive();
  let sessionPolicyAccepted;
  try {
    sessionPolicyAccepted = await enforceSessionPolicy(Object.freeze({
      privacy: capability.privacy,
      signalingVisibility: capability.signalingVisibility,
      role: options.role,
      localNodeId: identity.nodeId,
      peerNodeId,
      deadline,
      capability,
    }));
  } catch {
    fail(
      RENDEZVOUS_ERROR_CODES.SESSION_POLICY_REJECTED,
      "session integration policy was not accepted",
      "session",
    );
  }
  if (sessionPolicyAccepted !== true) {
    fail(
      RENDEZVOUS_ERROR_CODES.SESSION_POLICY_REJECTED,
      "session integration policy was not accepted",
      "session",
    );
  }
  assertConstructionActive();
  const capabilityOfferKey =
    `capability-offer:v1:${capabilityDigest}:${identity.nodeId}`;
  const replayRetention = Math.min(Number.MAX_SAFE_INTEGER, capability.expiresAt + skew);
  let closed = false;
  let closeReason = null;
  let outboundSeq = 0;
  let outboundPrev = null;
  let inboundSeq = 0;
  let inboundPrev = null;
  let outboundDescriptionSeen = false;
  let inboundDescriptionSeen = false;
  let outboundCandidatesEnded = false;
  let inboundCandidatesEnded = false;
  let capabilityOfferBound = false;
  const inboundDigests = new Map();
  let outboundTail = Promise.resolve();
  let inboundTail = Promise.resolve();

  const bindCapabilityOffer = async (offerDigest, now) => {
    if (capabilityOfferBound) return;
    if (!consumeCapability) {
      capabilityOfferBound = true;
      return;
    }
    const disposition = await replayCompareAndReserve(
      replayStore,
      capabilityOfferKey,
      offerDigest,
      replayRetention,
      now,
    );
    if (disposition !== "reserved") {
      closed = true;
      closeReason = disposition === "matched"
        ? "capability-offer-already-accepted"
        : "capability-offer-conflict";
      fail(
        RENDEZVOUS_ERROR_CODES.REPLAYED,
        disposition === "matched"
          ? "connection capability is already bound to this offer"
          : "connection capability is already bound to a different offer",
        "session",
      );
    }
    capabilityOfferBound = true;
  };

  const assertActive = (now) => {
    if (closed) throw sessionClosedError();
    if (now < capability.notBefore) {
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_NOT_YET_VALID,
        "authenticated session authorization is not yet valid",
        "session",
      );
    }
    if (now >= deadline) {
      closed = true;
      closeReason = "expired";
      fail(
        RENDEZVOUS_ERROR_CODES.CAPABILITY_EXPIRED,
        "authenticated session authorization has expired",
        "session",
      );
    }
  };

  const api = {
    nodeId: identity.nodeId,
    peerNodeId,
    role: options.role,
    sessionId: capability.sessionId,
    deadline,
    capability,
    capabilityDigest,
    replayStore,
    get closed() { return closed; },
    get closeReason() { return closeReason; },
    get outboundSequence() { return outboundSeq; },
    get inboundSequence() { return inboundSeq; },
    outbound(message, operationOptions = {}) {
      const operation = outboundTail.then(async () => {
        let irreversible = false;
        try {
          const now = sessionNow(options, operationOptions);
          assertActive(now);
          if (outboundSeq >= capability.limits.maxSignals) {
            fail(
              RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
              "outbound signal count exceeds the connection capability",
              "session",
            );
          }
          const ttlMs = positiveSafeInteger(
            operationOptions.ttlMs ?? DEFAULT_SIGNAL_TTL_MS,
            "ttlMs",
            MAX_SIGNAL_LIFETIME_MS,
          );
          if (outboundSeq === 0 && options.role === "answerer" &&
              !capabilityOfferBound) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
              "answerer cannot signal before accepting the capability-bound offer",
              "session",
            );
          }
          if (message?.type === "description") {
            if (outboundDescriptionSeen || outboundSeq !== 0) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "each sender may publish exactly one description at sequence 0",
                "session",
              );
            }
          } else if (message?.type === "candidate") {
            if (!outboundDescriptionSeen) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "candidate cannot precede the sender description",
                "session",
              );
            }
            if (outboundCandidatesEnded) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "candidate cannot follow the null end-of-candidates marker",
                "session",
              );
            }
          }
          const envelope = await createSignalEnvelope({
            sessionId: capability.sessionId,
            capabilityDigest,
            to: peerNodeId,
            role: options.role,
            seq: outboundSeq,
            prev: outboundPrev,
            issuedAt: now,
            expiresAt: Math.min(
              deadline,
              now + ttlMs,
            ),
            message,
          }, identity, {
            crypto: options.crypto,
            now,
            maxSignalBytes: capability.limits.maxSignalBytes,
          });
          let completionNow = sessionNow(options, operationOptions);
          assertActive(completionNow);
          if (completionNow >= envelope.expiresAt) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
              "outbound signal expired before signing completed",
              "session",
            );
          }
          const envelopeDigest = await digestSignalEnvelope(envelope, {
            crypto: options.crypto,
            maxSignalBytes: capability.limits.maxSignalBytes,
          });
          completionNow = sessionNow(options, operationOptions);
          assertActive(completionNow);
          if (completionNow >= envelope.expiresAt) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
              "outbound signal expired before hashing completed",
              "session",
            );
          }
          if (outboundSeq === 0 && options.role === "offerer") {
            // A replay-store call may have committed even when its Promise later
            // rejects. From this point onward, any failure must make the session
            // terminal rather than permit another sequence-zero offer.
            irreversible = true;
            await bindCapabilityOffer(envelopeDigest, completionNow);
            completionNow = sessionNow(options, operationOptions);
            assertActive(completionNow);
            if (completionNow >= envelope.expiresAt) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
                "outbound signal expired before replay binding completed",
                "session",
              );
            }
          }
          outboundPrev = envelopeDigest;
          if (envelope.message.type === "description") outboundDescriptionSeen = true;
          if (envelope.message.type === "candidate" && envelope.message.candidate === null) {
            outboundCandidatesEnded = true;
          }
          outboundSeq += 1;
          return envelope;
        } catch (error) {
          if (irreversible && !closed) {
            closed = true;
            closeReason = "outbound-incomplete";
          }
          throw error;
        }
      });
      outboundTail = operation.catch(() => {});
      return operation;
    },
    inbound(envelope, operationOptions = {}) {
      const operation = inboundTail.then(async () => {
        let irreversible = false;
        try {
          const now = sessionNow(options, operationOptions);
          assertActive(now);
          const verifyInbound = typeof envelope === "string" ||
              envelope instanceof ArrayBuffer || ArrayBuffer.isView(envelope)
            ? verifySignalEnvelopeBytes
            : verifySignalEnvelope;
          const verifiedSignal = await verifyInbound(envelope, {
            crypto: options.crypto,
            now,
            clockSkewMs: skew,
            capability: verified,
            expectedSessionId: capability.sessionId,
            expectedCapabilityDigest: capabilityDigest,
            expectedFrom: peerNodeId,
            expectedTo: identity.nodeId,
            expectedRole: oppositeRole(options.role),
            consume: false,
          });
          let completionNow = sessionNow(options, operationOptions);
          assertActive(completionNow);
          if (completionNow - skew >= verifiedSignal.envelope.expiresAt) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
              "signal expired before verification completed",
              "session",
            );
          }
          if (verifiedSignal.envelope.seq < inboundSeq) {
            const priorDigest = inboundDigests.get(verifiedSignal.envelope.seq);
            if (priorDigest === verifiedSignal.digest) {
              return deepFreeze({
                envelope: verifiedSignal.envelope,
                digest: verifiedSignal.digest,
                message: null,
                duplicate: true,
              });
            }
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
              "a consumed signal sequence was reused with different content",
              "session",
            );
          }
          if (inboundSeq >= capability.limits.maxSignals) {
            fail(
              RENDEZVOUS_ERROR_CODES.LIMIT_EXCEEDED,
              "inbound signal count exceeds the connection capability",
              "session",
            );
          }
          if (verifiedSignal.envelope.seq !== inboundSeq) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
              `expected inbound sequence ${inboundSeq}`,
              "session",
            );
          }
          if (verifiedSignal.envelope.prev !== inboundPrev) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_CHAIN,
              "inbound signal does not continue the authenticated hash chain",
              "session",
            );
          }
          if (verifiedSignal.message.type === "description") {
            if (inboundDescriptionSeen || inboundSeq !== 0) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "each sender may publish exactly one description at sequence 0",
                "session",
              );
            }
          } else {
            if (!inboundDescriptionSeen) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "candidate cannot precede the sender description",
                "session",
              );
            }
            if (inboundCandidatesEnded) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "candidate cannot follow the null end-of-candidates marker",
                "session",
              );
            }
          }
          const isInboundOffer = options.role === "answerer" && inboundSeq === 0;
          if (isInboundOffer) {
            // Replay mutation and message-handler effects cannot be rolled back.
            // Once either can begin, an incomplete operation closes the session so
            // different content can never reuse the uncommitted sequence cursor.
            irreversible = true;
            await bindCapabilityOffer(verifiedSignal.digest, completionNow);
          } else {
            if (inboundSeq === 0 && !capabilityOfferBound) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_SEQUENCE,
                "offerer cannot accept an answer before publishing its capability-bound offer",
                "session",
              );
            }
            const replayKey = `signal:v1:${verifiedSignal.digest}`;
            irreversible = true;
            const claimed = await replayClaim(
              replayStore,
              replayKey,
              Math.min(
                Number.MAX_SAFE_INTEGER,
                verifiedSignal.envelope.expiresAt + skew,
              ),
              completionNow,
            );
            if (!claimed) {
              fail(
                RENDEZVOUS_ERROR_CODES.REPLAYED,
                "signal has already been consumed",
                "session",
              );
            }
          }
          completionNow = sessionNow(options, operationOptions);
          assertActive(completionNow);
          if (completionNow - skew >= verifiedSignal.envelope.expiresAt) {
            fail(
              RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
              "signal expired before replay validation completed",
              "session",
            );
          }
          const handler = operationOptions.onMessage ?? options.onMessage;
          if (handler) {
            try {
              await handler(verifiedSignal.message, {
                envelope: verifiedSignal.envelope,
                digest: verifiedSignal.digest,
                session: api,
              });
            } catch {
              closed = true;
              closeReason = "handler-failed";
              throw internalError(
                "authenticated signal consumer failed; session was closed",
                {
                  code: RENDEZVOUS_ERROR_CODES.HANDLER_FAILED,
                  phase: "session",
                },
              );
            }
            completionNow = sessionNow(options, operationOptions);
            assertActive(completionNow);
            if (completionNow - skew >= verifiedSignal.envelope.expiresAt) {
              fail(
                RENDEZVOUS_ERROR_CODES.SIGNAL_EXPIRED,
                "signal expired before its consumer completed",
                "session",
              );
            }
          }
          if (verifiedSignal.message.type === "description") inboundDescriptionSeen = true;
          if (verifiedSignal.message.type === "candidate" &&
              verifiedSignal.message.candidate === null) {
            inboundCandidatesEnded = true;
          }
          inboundDigests.set(inboundSeq, verifiedSignal.digest);
          inboundPrev = verifiedSignal.digest;
          inboundSeq += 1;
          return deepFreeze({ ...verifiedSignal, duplicate: false });
        } catch (error) {
          if (irreversible && !closed) {
            closed = true;
            closeReason = "inbound-incomplete";
          }
          throw error;
        }
      });
      inboundTail = operation.catch(() => {});
      return operation;
    },
    close(reason = "closed") {
      if (closed) return false;
      closeReason = boundedString(reason, "close reason", 128);
      closed = true;
      return true;
    },
  };
  return Object.freeze(api);
}
