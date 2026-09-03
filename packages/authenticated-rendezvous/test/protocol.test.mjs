import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import {
  CAPABILITY_SIGNATURE_DOMAIN,
  DEFAULT_CLOCK_SKEW_MS,
  InMemoryReplayStore,
  MAX_CANONICAL_JSON_DEPTH,
  MAX_CAPABILITY_LIFETIME_MS,
  MAX_CHANNELS,
  MAX_SIGNAL_BYTES,
  MAX_SIGNAL_LIFETIME_MS,
  RENDEZVOUS_ERROR_CODES,
  RENDEZVOUS_PROTOCOL,
  RendezvousError,
  SIGNAL_SIGNATURE_DOMAIN,
  canonicalizeJson,
  canonicalizeJsonBytes,
  createAuthenticatedSession,
  createNodeIdentity,
  createSignalEnvelope,
  decodeBase32,
  decodeBase64Url,
  digestConnectionCapability,
  digestSignalEnvelope,
  encodeBase32,
  encodeBase64Url,
  generateNodeIdentity,
  issueConnectionCapability,
  nodeIdFromPublicKey,
  parseCanonicalJson,
  serializeConnectionCapability,
  serializeSignalEnvelope,
  verifyConnectionCapability,
  verifyConnectionCapabilityBytes,
  verifyNodeId,
  verifySignalEnvelope,
  verifySignalEnvelopeBytes,
} from "../src/index.mjs";

const crypto = webcrypto;
const C = RENDEZVOUS_ERROR_CODES;
const NOW = 1_800_000_000_000;
const textEncoder = new TextEncoder();

// RFC 8032 section 7.1 test vectors 1-3. These make the NodeID and all
// protocol signatures deterministic without adding a crypto dependency.
const ED25519_VECTORS = [
  {
    seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
    emptySignature:
      "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
      "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b",
    nodeId: "wn1-eh7ddx5bksrgcytl7bkai36se4nxx3klnk7elksyq57pi74xeg4q",
    publicKeyBase64Url: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  },
  {
    seed: "4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb",
    publicKey: "3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c",
  },
  {
    seed: "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7",
    publicKey: "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025",
  },
];

function bytesFromHex(value) {
  assert.match(value, /^(?:[0-9a-f]{2})*$/);
  return Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function hexFromBytes(value) {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function concatBytes(...parts) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function opaqueId(fill) {
  return encodeBase64Url(new Uint8Array(24).fill(fill));
}

async function expectCode(action, code, options = {}) {
  let error;
  try {
    await (typeof action === "function" ? action() : action);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, `expected ${code} rejection`);
  assert.equal(error.name, "RendezvousError");
  assert.equal(error.code, code);
  assert.equal(typeof error.phase, "string");
  assert.equal(error.retryable, options.retryable ?? false);
  for (const secret of options.excludes ?? []) {
    assert.ok(!error.message.includes(secret), `error message exposed ${secret}`);
    assert.ok(!String(error.stack ?? "").includes(secret), `error stack exposed ${secret}`);
    assert.ok(!String(error.cause ?? "").includes(secret), `error cause exposed ${secret}`);
  }
  return error;
}

async function importFixedIdentity(vector) {
  // RFC 8410 PKCS#8 wrapping: AlgorithmIdentifier id-Ed25519 and a nested
  // 32-byte CurvePrivateKey OCTET STRING.
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    concatBytes(
      bytesFromHex("302e020100300506032b657004220420"),
      bytesFromHex(vector.seed),
    ),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(vector.publicKey),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return createNodeIdentity({ privateKey, publicKey }, { crypto });
}

let identityPromise;
function fixedIdentities() {
  identityPromise ??= Promise.all(ED25519_VECTORS.map(importFixedIdentity));
  return identityPromise;
}

function baseClaims(offerer, answerer, overrides = {}) {
  const claims = {
    id: opaqueId(0x11),
    subject: offerer.nodeId,
    audience: answerer.nodeId,
    sessionId: opaqueId(0x22),
    action: "webrtc.signal",
    resource: "weave://rooms/integration-test",
    applicationProtocol: "weave.test.v1",
    channels: [
      { label: "weave", protocol: "weave.v1" },
      { label: "telemetry", protocol: "weave.telemetry.v1" },
    ],
    privacy: "direct-preferred",
    signalingVisibility: "rendezvous-visible",
    limits: {
      maxSignals: 8,
      maxSignalBytes: 8 * 1024,
      maxSessionDurationMs: 60_000,
    },
    actor: "agent:planner",
    onBehalfOf: "human:alice",
    serviceId: "service:integration-test",
    profile: "interactive",
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 120_000,
    singleUse: true,
  };
  return { ...claims, ...overrides };
}

async function capabilityFixture(overrides = {}, options = {}) {
  const [issuer, offerer, answerer] = await fixedIdentities();
  const claims = baseClaims(offerer, answerer, overrides);
  const capability = await issueConnectionCapability(
    claims,
    options.issuerIdentity ?? issuer,
    { crypto, now: options.now ?? NOW },
  );
  return { issuer, offerer, answerer, claims, capability };
}

function verificationPolicy(capability) {
  return {
    crypto,
    now: NOW,
    clockSkewMs: 0,
    expectedIssuer: capability.issuer,
    expectedSubject: capability.subject,
    expectedAudience: capability.audience,
    expectedSessionId: capability.sessionId,
    expectedAction: capability.action,
    expectedResource: capability.resource,
    expectedApplicationProtocol: capability.applicationProtocol,
    expectedChannels: capability.channels,
    expectedPrivacy: capability.privacy,
    expectedSignalingVisibility: capability.signalingVisibility,
    expectedLimits: capability.limits,
    expectedActor: capability.actor,
    expectedOnBehalfOf: capability.onBehalfOf,
    expectedServiceId: capability.serviceId,
    expectedProfile: capability.profile,
  };
}

function sessionOptions(identity, peerNodeId, role, capability, overrides = {}) {
  return {
    identity,
    peerNodeId,
    role,
    capability,
    crypto,
    clock: () => NOW,
    clockSkewMs: 0,
    replayStore: new InMemoryReplayStore({ maxEntries: 64, clock: () => NOW }),
    expectedIssuer: capability.issuer,
    sessionId: capability.sessionId,
    action: capability.action,
    resource: capability.resource,
    applicationProtocol: capability.applicationProtocol,
    channels: capability.channels,
    privacy: capability.privacy,
    signalingVisibility: capability.signalingVisibility,
    limits: capability.limits,
    actor: capability.actor,
    onBehalfOf: capability.onBehalfOf,
    serviceId: capability.serviceId,
    profile: capability.profile,
    enforceSessionPolicy: () => true,
    ...overrides,
  };
}

function offerDescription(sdp = "v=0\r\no=offer 1 1 IN IP4 127.0.0.1\r\n") {
  return { type: "description", description: { type: "offer", sdp } };
}

function answerDescription(sdp = "v=0\r\no=answer 1 1 IN IP4 127.0.0.1\r\n") {
  return { type: "description", description: { type: "answer", sdp } };
}

function candidate(candidate = "candidate:1 1 UDP 1 192.0.2.1 9000 typ host") {
  return {
    type: "candidate",
    candidate: {
      candidate,
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "ufrag",
    },
  };
}

test("protocol constants and signature domains are versioned and separated", () => {
  assert.equal(RENDEZVOUS_PROTOCOL, "weave-rendezvous.v1");
  assert.equal(CAPABILITY_SIGNATURE_DOMAIN, "weave.rendezvous.capability.v1\0");
  assert.equal(SIGNAL_SIGNATURE_DOMAIN, "weave.rendezvous.signal.v1\0");
  assert.notEqual(CAPABILITY_SIGNATURE_DOMAIN, SIGNAL_SIGNATURE_DOMAIN);
});

test("RFC 8785 canonical JSON vectors use ECMAScript numbers and UTF-16 key order", () => {
  const value = {
    numbers: [333333333.33333329, 1e30, 4.50, 2e-3, 1e-27],
    string: "€$\u000f\nA'B\"\\\\\"/",
    literals: [null, true, false],
  };
  assert.equal(
    canonicalizeJson(value),
    "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
  );

  const ordered = {
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "דּ": "Hebrew Letter Dalet With Dagesh",
    1: "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    "ö": "Latin Small Letter O With Diaeresis",
  };
  assert.equal(
    canonicalizeJson(ordered),
    "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
  );
  assert.deepEqual(
    canonicalizeJsonBytes({ b: 2, a: 1 }),
    textEncoder.encode('{"a":1,"b":2}'),
  );
});

test("canonical JSON rejects values outside strict I-JSON and enforces bounds", async (t) => {
  const invalidValues = [
    [NaN, "non-finite"],
    [Infinity, "infinity"],
    [undefined, "undefined"],
    [1n, "bigint"],
    ["\ud800", "unpaired high surrogate"],
    ["\udc00", "unpaired low surrogate"],
    [new Date(0), "non-plain object"],
    [Object.assign([1], { extra: true }), "array property"],
    [[, 1], "sparse array"],
  ];
  const cyclic = {};
  cyclic.self = cyclic;
  invalidValues.push([cyclic, "cycle"]);

  for (const [value, name] of invalidValues) {
    await t.test(name, async () => {
      await expectCode(() => canonicalizeJson(value), C.INVALID_JSON);
    });
  }

  const getter = {};
  Object.defineProperty(getter, "value", { enumerable: true, get: () => 1 });
  await expectCode(() => canonicalizeJson(getter), C.INVALID_JSON);
  await expectCode(
    () => canonicalizeJson({ value: "too large" }, { maxBytes: 4 }),
    C.LIMIT_EXCEEDED,
  );
  await expectCode(
    () => canonicalizeJson({ a: { b: 1 } }, { maxDepth: 1 }),
    C.LIMIT_EXCEEDED,
  );
  await expectCode(
    () => canonicalizeJson([1, 2], { maxNodes: 2 }),
    C.LIMIT_EXCEEDED,
  );
  await expectCode(
    () => canonicalizeJson("1234", { maxStringBytes: 3 }),
    C.LIMIT_EXCEEDED,
  );
  assert.equal(MAX_CANONICAL_JSON_DEPTH, 32);
});

test("canonical wire parser accepts only exact canonical UTF-8 and freezes output", async (t) => {
  const canonical = '{"a":[1,{"b":"€"}],"z":true}';
  const parsed = parseCanonicalJson(textEncoder.encode(canonical));
  assert.deepEqual(parsed, { a: [1, { b: "€" }], z: true });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.a));
  assert.ok(Object.isFrozen(parsed.a[1]));
  assert.equal(parseCanonicalJson("null"), null);

  const invalid = [
    [" {\"a\":1}", "leading whitespace"],
    ["{\"a\":1 }", "trailing whitespace"],
    ["{\"b\":2,\"a\":1}", "key order"],
    ["{\"a\":1,\"a\":1}", "duplicate member"],
    ["{\"a\":1.0}", "number spelling"],
    ["{\"a\":1e0}", "exponent spelling"],
    ["{\"a\":\"\\u0062\"}", "escape spelling"],
    ["\ufeff{}", "BOM"],
    ["{", "syntax"],
  ];
  for (const [wire, name] of invalid) {
    await t.test(name, () => expectCode(() => parseCanonicalJson(wire), C.INVALID_JSON));
  }
  await t.test("invalid UTF-8", () =>
    expectCode(() => parseCanonicalJson(Uint8Array.of(0xff)), C.INVALID_JSON));
  await t.test("wire byte bound", () =>
    expectCode(
      () => parseCanonicalJson(textEncoder.encode(canonical), { maxBytes: 4 }),
      C.LIMIT_EXCEEDED,
    ));
});

test("base64url and lowercase base32 match RFC 4648 vectors", () => {
  const base64url = [
    ["", ""],
    ["f", "Zg"],
    ["fo", "Zm8"],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg"],
    ["fooba", "Zm9vYmE"],
    ["foobar", "Zm9vYmFy"],
  ];
  const base32 = [
    ["", ""],
    ["f", "my"],
    ["fo", "mzxq"],
    ["foo", "mzxw6"],
    ["foob", "mzxw6yq"],
    ["fooba", "mzxw6ytb"],
    ["foobar", "mzxw6ytboi"],
  ];
  for (const [plain, encoded] of base64url) {
    const bytes = textEncoder.encode(plain);
    assert.equal(encodeBase64Url(bytes), encoded);
    assert.deepEqual(decodeBase64Url(encoded), bytes);
  }
  for (const [plain, encoded] of base32) {
    const bytes = textEncoder.encode(plain);
    assert.equal(encodeBase32(bytes), encoded);
    assert.deepEqual(decodeBase32(encoded), bytes);
  }

  const backing = Uint8Array.of(9, 102, 111, 111, 9);
  assert.equal(encodeBase64Url(backing.subarray(1, 4)), "Zm9v");
  assert.equal(encodeBase32(backing.subarray(1, 4)), "mzxw6");
});

test("decoders reject padding, alternate alphabets, non-zero pad bits, and limits", async () => {
  for (const value of ["Zg=", "Zg==", "+w", "/w", "Zh", "A"]) {
    await expectCode(() => decodeBase64Url(value), C.INVALID_ARGUMENT);
  }
  for (const value of ["MY", "my======", "m1", "mz"]) {
    await expectCode(() => decodeBase32(value), C.INVALID_ARGUMENT);
  }
  await expectCode(() => decodeBase64Url("Zm9v", { maxBytes: 2 }), C.LIMIT_EXCEEDED);
  await expectCode(() => decodeBase32("mzxw6", { maxBytes: 2 }), C.LIMIT_EXCEEDED);
});

test("RFC 8032 key material yields the fixed public key, signature, and NodeID", async () => {
  const [identity] = await fixedIdentities();
  const vector = ED25519_VECTORS[0];
  assert.equal(identity.publicKey, vector.publicKeyBase64Url);
  assert.equal(identity.nodeId, vector.nodeId);
  assert.equal(
    await nodeIdFromPublicKey(bytesFromHex(vector.publicKey), { crypto }),
    vector.nodeId,
  );
  assert.equal(await verifyNodeId(vector.nodeId, identity.publicKey, { crypto }), true);
  assert.equal(
    hexFromBytes(await crypto.subtle.sign(
      { name: "Ed25519" },
      identity.signingKey,
      new Uint8Array(),
    )),
    vector.emptySignature,
  );
  await expectCode(
    () => verifyNodeId(
      vector.nodeId,
      bytesFromHex(ED25519_VECTORS[1].publicKey),
      { crypto },
    ),
    C.NODE_ID_MISMATCH,
  );
  await expectCode(() => verifyNodeId("wn1-not-a-node", identity.publicKey, { crypto }), C.NODE_ID_INVALID);
});

test("generated identities are self-certifying and mismatched key pairs are rejected", async () => {
  const generated = await generateNodeIdentity({ crypto, extractable: true });
  assert.match(generated.nodeId, /^wn1-[a-z2-7]{52}$/);
  assert.match(generated.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyNodeId(generated.nodeId, generated.verificationKey, { crypto }), true);

  const [first, second] = await fixedIdentities();
  await expectCode(
    () => createNodeIdentity(
      { publicKey: first.verificationKey, privateKey: second.signingKey },
      { crypto },
    ),
    C.KEY_INVALID,
  );
  await expectCode(() => generateNodeIdentity({ crypto: {} }), C.CRYPTO_UNAVAILABLE);
});

test("external Ed25519 signers support hardware/KMS-style identities", async () => {
  const [issuer, relabeled] = await fixedIdentities();
  let calls = 0;
  const externalIdentity = {
    nodeId: issuer.nodeId,
    publicKey: issuer.publicKey,
    async sign(bytes) {
      calls += 1;
      assert.ok(bytes instanceof Uint8Array);
      assert.ok(bytes.length > CAPABILITY_SIGNATURE_DOMAIN.length);
      return crypto.subtle.sign({ name: "Ed25519" }, issuer.signingKey, bytes);
    },
  };
  const { capability } = await capabilityFixture({}, { issuerIdentity: externalIdentity });
  assert.equal(calls, 2);
  await verifyConnectionCapability(capability, verificationPolicy(capability));

  await expectCode(
    () => capabilityFixture({}, {
      issuerIdentity: {
        ...externalIdentity,
        sign: () => new Uint8Array(64),
      },
    }),
    C.SIGNATURE_INVALID,
  );

  const mutableIdentity = {
    nodeId: issuer.nodeId,
    publicKey: issuer.publicKey,
    sign: (bytes) => crypto.subtle.sign({ name: "Ed25519" }, issuer.signingKey, bytes),
  };
  await capabilityFixture({}, { issuerIdentity: mutableIdentity });
  mutableIdentity.nodeId = relabeled.nodeId;
  mutableIdentity.publicKey = relabeled.publicKey;
  await expectCode(
    () => capabilityFixture({}, { issuerIdentity: mutableIdentity }),
    C.SIGNATURE_INVALID,
  );
});

test("injected random and signing provider failures are stable and sanitized", async () => {
  const [issuer, offerer, answerer] = await fixedIdentities();
  const randomSecret = "random provider access token";
  const claims = baseClaims(offerer, answerer);
  delete claims.id;
  delete claims.sessionId;
  await expectCode(
    () => issueConnectionCapability(claims, issuer, {
      crypto: {
        subtle: crypto.subtle,
        getRandomValues() {
          throw new RendezvousError(randomSecret, {
            code: C.INVALID_ARGUMENT,
          });
        },
      },
      now: NOW,
    }),
    C.CRYPTO_UNAVAILABLE,
    { excludes: [randomSecret] },
  );

  const signerSecret = "kms authorization header";
  await expectCode(
    () => issueConnectionCapability(baseClaims(offerer, answerer), {
      nodeId: issuer.nodeId,
      publicKey: issuer.publicKey,
      sign() {
        throw new RendezvousError(signerSecret, {
          code: C.REPLAYED,
        });
      },
    }, { crypto, now: NOW }),
    C.KEY_INVALID,
    { excludes: [signerSecret] },
  );
});

test("capability issuance is deterministic, exact-schema, immutable, and digestible", async () => {
  const fixture = await capabilityFixture();
  const again = await issueConnectionCapability(
    fixture.claims,
    fixture.issuer,
    { crypto, now: NOW },
  );
  assert.deepEqual(again, fixture.capability);
  assert.equal(Object.keys(fixture.capability).length, 24);
  assert.deepEqual(Object.keys(fixture.capability), [
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
  assert.ok(Object.isFrozen(fixture.capability));
  assert.ok(Object.isFrozen(fixture.capability.channels));
  assert.ok(Object.isFrozen(fixture.capability.channels[0]));
  assert.ok(Object.isFrozen(fixture.capability.limits));
  assert.match(fixture.capability.signature, /^[A-Za-z0-9_-]{86}$/);
  assert.match(await digestConnectionCapability(fixture.capability, { crypto }), /^sha256-[A-Za-z0-9_-]{43}$/);
});

test("capability verification requires issuer trust and enforces every policy field", async (t) => {
  const { issuer, capability } = await capabilityFixture();
  const policy = verificationPolicy(capability);
  const verified = await verifyConnectionCapability(capability, policy);
  assert.deepEqual(verified.capability, capability);
  assert.ok(Object.isFrozen(verified));
  assert.ok(Object.isFrozen(verified.capability));
  assert.match(verified.digest, /^sha256-[A-Za-z0-9_-]{43}$/);

  await verifyConnectionCapability(capability, {
    crypto,
    now: NOW,
    clockSkewMs: 0,
    trustedIssuers: new Set([issuer.nodeId]),
  });
  await verifyConnectionCapability(capability, {
    crypto,
    now: NOW,
    clockSkewMs: 0,
    allowUntrustedIssuer: true,
  });
  await expectCode(
    () => verifyConnectionCapability(capability, { crypto, now: NOW, clockSkewMs: 0 }),
    C.CAPABILITY_UNTRUSTED_ISSUER,
  );
  await expectCode(
    () => verifyConnectionCapability(capability, {
      crypto,
      now: NOW,
      clockSkewMs: 0,
      trustedIssuers: [],
    }),
    C.CAPABILITY_UNTRUSTED_ISSUER,
  );

  const mismatches = [
    ["expectedSubject", issuer.nodeId],
    ["expectedAudience", issuer.nodeId],
    ["expectedSessionId", opaqueId(0x44)],
    ["expectedAction", "webrtc.observe"],
    ["expectedResource", "weave://rooms/other"],
    ["expectedApplicationProtocol", "weave.other.v1"],
    ["expectedChannels", [{ label: "other", protocol: "weave.v1" }]],
    ["expectedPrivacy", "relay-only"],
    ["expectedSignalingVisibility", "private"],
    ["expectedLimits", { ...capability.limits, maxSignals: 7 }],
    ["expectedActor", "human:bob"],
    ["expectedOnBehalfOf", null],
    ["expectedServiceId", "service:other"],
    ["expectedProfile", "batch"],
  ];
  for (const [name, value] of mismatches) {
    await t.test(name, () => expectCode(
      () => verifyConnectionCapability(capability, { ...policy, [name]: value }),
      C.CAPABILITY_MISMATCH,
    ));
  }
  await expectCode(
    () => verifyConnectionCapability(capability, { ...policy, expectedIssuer: capability.subject }),
    C.CAPABILITY_UNTRUSTED_ISSUER,
  );
  await expectCode(
    () => verifyConnectionCapability(capability, {
      ...policy,
      trustedIssuers: [capability.subject],
    }),
    C.CAPABILITY_UNTRUSTED_ISSUER,
  );
});

test("capability signatures bind all claims and the issuer public key", async () => {
  const { capability, answerer } = await capabilityFixture();
  const secret = "DO_NOT_ECHO_SIGNED_CAPABILITY_CONTENT";
  for (const mutate of [
    (value) => { value.resource = `weave://${secret}`; },
    (value) => { value.action = "webrtc.observe"; },
    (value) => { value.signature = `${value.signature.startsWith("A") ? "B" : "A"}${value.signature.slice(1)}`; },
  ]) {
    const tampered = clone(capability);
    mutate(tampered);
    await expectCode(
      () => verifyConnectionCapability(tampered, {
        crypto,
        now: NOW,
        clockSkewMs: 0,
        expectedIssuer: capability.issuer,
      }),
      C.SIGNATURE_INVALID,
      { excludes: [secret, capability.signature, capability.issuerPublicKey] },
    );
  }

  const wrongKey = clone(capability);
  wrongKey.issuerPublicKey = answerer.publicKey;
  await expectCode(
    () => verifyConnectionCapability(wrongKey, {
      crypto,
      now: NOW,
      expectedIssuer: capability.issuer,
    }),
    C.NODE_ID_MISMATCH,
    { excludes: [answerer.publicKey] },
  );
});

test("capability times have strict lifetime bounds and explicit skew behavior", async () => {
  const { issuer, offerer, answerer } = await capabilityFixture();
  const future = await issueConnectionCapability(
    baseClaims(offerer, answerer, {
      issuedAt: NOW + 10_000,
      notBefore: NOW + 10_000,
      expiresAt: NOW + 20_000,
    }),
    issuer,
    { crypto, now: NOW },
  );
  await expectCode(
    () => verifyConnectionCapability(future, {
      crypto,
      expectedIssuer: issuer.nodeId,
      now: NOW,
      clockSkewMs: 0,
    }),
    C.CAPABILITY_NOT_YET_VALID,
  );
  await verifyConnectionCapability(future, {
    crypto,
    expectedIssuer: issuer.nodeId,
    now: NOW,
    clockSkewMs: 10_000,
  });
  const earlySession = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    future,
    { clockSkewMs: 10_000, consumeCapability: false },
  ));
  await expectCode(
    () => earlySession.outbound(offerDescription()),
    C.CAPABILITY_NOT_YET_VALID,
  );

  const short = await issueConnectionCapability(
    baseClaims(offerer, answerer, {
      issuedAt: NOW - 10_000,
      notBefore: NOW - 10_000,
      expiresAt: NOW,
      limits: { maxSignals: 2, maxSignalBytes: 1024, maxSessionDurationMs: 10_000 },
    }),
    issuer,
    { crypto, now: NOW - 10_000 },
  );
  await expectCode(
    () => verifyConnectionCapability(short, {
      crypto,
      expectedIssuer: issuer.nodeId,
      now: NOW,
      clockSkewMs: 0,
    }),
    C.CAPABILITY_EXPIRED,
  );
  await verifyConnectionCapability(short, {
    crypto,
    expectedIssuer: issuer.nodeId,
    now: NOW,
    clockSkewMs: 1,
  });

  await expectCode(
    () => issueConnectionCapability(
      baseClaims(offerer, answerer, {
        issuedAt: NOW,
        notBefore: NOW,
        expiresAt: NOW + MAX_CAPABILITY_LIFETIME_MS + 1,
      }),
      issuer,
      { crypto, now: NOW },
    ),
    C.CAPABILITY_INVALID,
  );
  await expectCode(
    () => issueConnectionCapability(
      baseClaims(offerer, answerer, { issuedAt: NOW, notBefore: NOW, expiresAt: NOW }),
      issuer,
      { crypto, now: NOW },
    ),
    C.CAPABILITY_INVALID,
  );
});

test("capability schemas reject attenuation-unsafe or unbounded fields", async () => {
  const [issuer, offerer, answerer] = await fixedIdentities();
  const issue = (overrides) => issueConnectionCapability(
    baseClaims(offerer, answerer, overrides),
    issuer,
    { crypto, now: NOW },
  );
  for (const field of ["privacy", "limits", "actor", "onBehalfOf"]) {
    const claims = baseClaims(offerer, answerer);
    delete claims[field];
    await expectCode(
      () => issueConnectionCapability(claims, issuer, { crypto, now: NOW }),
      C.CAPABILITY_INVALID,
    );
  }
  await expectCode(() => issue({ surprise: true }), C.CAPABILITY_INVALID);
  await expectCode(() => issue({ singleUse: false }), C.CAPABILITY_INVALID);
  await expectCode(
    () => issue({ audience: offerer.nodeId }),
    C.CAPABILITY_INVALID,
  );
  await expectCode(() => issue({ channels: [] }), C.CAPABILITY_INVALID);
  await expectCode(
    () => issue({ channels: Array.from({ length: MAX_CHANNELS + 1 }, (_, index) => ({
      label: `channel-${index}`,
      protocol: "weave.v1",
    })) }),
    C.CAPABILITY_INVALID,
  );
  await expectCode(
    () => issue({ channels: [
      { label: "same", protocol: "a" },
      { label: "same", protocol: "b" },
    ] }),
    C.CAPABILITY_INVALID,
  );
  await expectCode(() => issue({ privacy: "public" }), C.CAPABILITY_INVALID);
  await expectCode(() => issue({ signalingVisibility: "encrypted" }), C.CAPABILITY_INVALID);
  await expectCode(
    () => issue({ limits: { maxSignals: 0, maxSignalBytes: 1024, maxSessionDurationMs: 1 } }),
    C.INVALID_ARGUMENT,
  );
});

test("single-use capability consumption is atomic through a replay store", async () => {
  const { capability } = await capabilityFixture();
  const replayStore = new InMemoryReplayStore({ clock: () => NOW });
  const options = {
    ...verificationPolicy(capability),
    consume: true,
    replayStore,
  };
  await verifyConnectionCapability(capability, options);
  assert.equal(replayStore.size, 1);
  await expectCode(() => verifyConnectionCapability(capability, options), C.REPLAYED);
  await expectCode(
    () => verifyConnectionCapability(capability, {
      ...verificationPolicy(capability),
      consume: true,
    }),
    C.INVALID_ARGUMENT,
  );
});

test("signal envelopes bind sender, direction, role, capability, time, and message", async () => {
  const { capability, offerer } = await capabilityFixture();
  const verifiedCapability = await verifyConnectionCapability(
    capability,
    verificationPolicy(capability),
  );
  const envelope = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verifiedCapability.digest,
    to: capability.audience,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  }, offerer, { crypto, now: NOW, maxSignalBytes: capability.limits.maxSignalBytes });

  const result = await verifySignalEnvelope(envelope, {
    crypto,
    now: NOW,
    clockSkewMs: 0,
    capability: verifiedCapability,
    expectedSessionId: capability.sessionId,
    expectedCapabilityDigest: verifiedCapability.digest,
    expectedFrom: capability.subject,
    expectedTo: capability.audience,
    expectedRole: "offerer",
    expectedSeq: 0,
    expectedPrev: null,
  });
  assert.deepEqual(result.message, offerDescription());
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.envelope));
  assert.ok(Object.isFrozen(result.message));
  assert.equal(result.digest, await digestSignalEnvelope(envelope, {
    crypto,
    maxSignalBytes: capability.limits.maxSignalBytes,
  }));

  await expectCode(
    () => verifySignalEnvelope(envelope, { crypto, now: NOW }),
    C.SIGNAL_MISMATCH,
  );
  const unscoped = await verifySignalEnvelope(envelope, {
    crypto,
    now: NOW,
    allowUnscoped: true,
  });
  assert.equal(unscoped.digest, result.digest);
  await expectCode(
    () => verifySignalEnvelope(envelope, {
      crypto,
      now: NOW,
      capability: { capability, digest: verifiedCapability.digest },
    }),
    C.INVALID_ARGUMENT,
  );
});

test("signal tampering and validly signed authorization mismatches are rejected", async () => {
  const { capability, offerer, answerer, issuer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const fields = {
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  };
  const envelope = await createSignalEnvelope(fields, offerer, { crypto });
  const secret = "DO_NOT_ECHO_PRIVATE_SDP";
  const tampered = clone(envelope);
  tampered.message.description.sdp = secret;
  await expectCode(
    () => verifySignalEnvelope(tampered, { crypto, now: NOW, capability: verified }),
    C.SIGNATURE_INVALID,
    { excludes: [secret, envelope.signature, offerer.publicKey] },
  );

  const wrongTarget = await createSignalEnvelope(
    { ...fields, to: issuer.nodeId },
    offerer,
    { crypto },
  );
  await expectCode(
    () => verifySignalEnvelope(wrongTarget, { crypto, now: NOW, capability: verified }),
    C.SIGNAL_MISMATCH,
  );

  const wrongRole = await createSignalEnvelope({
    ...fields,
    to: offerer.nodeId,
    role: "offerer",
    message: offerDescription(),
  }, answerer, { crypto });
  await expectCode(
    () => verifySignalEnvelope(wrongRole, { crypto, now: NOW, capability: verified }),
    C.SIGNAL_MISMATCH,
  );

  for (const [option, value, code] of [
    ["expectedSessionId", opaqueId(0x77), C.SIGNAL_MISMATCH],
    ["expectedCapabilityDigest", `sha256-${encodeBase64Url(new Uint8Array(32))}`, C.SIGNAL_MISMATCH],
    ["expectedFrom", answerer.nodeId, C.SIGNAL_MISMATCH],
    ["expectedTo", issuer.nodeId, C.SIGNAL_MISMATCH],
    ["expectedRole", "answerer", C.SIGNAL_MISMATCH],
    ["expectedSeq", 1, C.SIGNAL_SEQUENCE],
    ["expectedPrev", `sha256-${encodeBase64Url(new Uint8Array(32))}`, C.SIGNAL_CHAIN],
  ]) {
    await expectCode(
      () => verifySignalEnvelope(envelope, {
        crypto,
        now: NOW,
        capability: verified,
        [option]: value,
      }),
      code,
    );
  }
});

test("signal message schemas, sequence-zero description rule, sizes, and times are bounded", async () => {
  const { capability, offerer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const base = {
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: capability.audience,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
  };
  await expectCode(
    () => createSignalEnvelope({ ...base, message: candidate() }, offerer, { crypto }),
    C.SIGNAL_SEQUENCE,
  );
  await expectCode(
    () => createSignalEnvelope({ ...base, message: answerDescription() }, offerer, { crypto }),
    C.SIGNAL_INVALID,
  );
  await expectCode(
    () => createSignalEnvelope({
      ...base,
      message: { ...offerDescription(), extra: true },
    }, offerer, { crypto }),
    C.SIGNAL_INVALID,
  );
  await expectCode(
    () => createSignalEnvelope({
      ...base,
      seq: 1,
      prev: `sha256-${encodeBase64Url(new Uint8Array(32))}`,
      message: { type: "candidate", candidate: { candidate: "" } },
    }, offerer, { crypto }),
    C.INVALID_ARGUMENT,
  );
  await expectCode(
    () => createSignalEnvelope({
      ...base,
      message: offerDescription("x".repeat(capability.limits.maxSignalBytes + 1)),
    }, offerer, { crypto, maxSignalBytes: capability.limits.maxSignalBytes }),
    C.LIMIT_EXCEEDED,
  );
  await expectCode(
    () => createSignalEnvelope(
      { ...base, message: offerDescription() },
      offerer,
      { crypto, maxSignalBytes: MAX_SIGNAL_BYTES + 1 },
    ),
    C.INVALID_ARGUMENT,
  );
  await expectCode(
    () => createSignalEnvelope({
      ...base,
      expiresAt: NOW + MAX_SIGNAL_LIFETIME_MS + 1,
      message: offerDescription(),
    }, offerer, { crypto }),
    C.SIGNAL_INVALID,
  );

  const future = await createSignalEnvelope({
    ...base,
    issuedAt: NOW + DEFAULT_CLOCK_SKEW_MS + 1,
    expiresAt: NOW + DEFAULT_CLOCK_SKEW_MS + 2_000,
    message: offerDescription(),
  }, offerer, { crypto });
  await expectCode(
    () => verifySignalEnvelope(future, {
      crypto,
      now: NOW,
      clockSkewMs: DEFAULT_CLOCK_SKEW_MS,
      capability: verified,
    }),
    C.SIGNAL_INVALID,
  );

  const expired = await createSignalEnvelope({
    ...base,
    issuedAt: NOW - 2_000,
    expiresAt: NOW - 1,
    message: offerDescription(),
  }, offerer, { crypto });
  await expectCode(
    () => verifySignalEnvelope(expired, {
      crypto,
      now: NOW,
      clockSkewMs: 0,
      capability: verified,
    }),
    C.SIGNAL_EXPIRED,
  );
});

test("ICE candidate envelopes preserve optional fields and end-of-candidates", async () => {
  const { capability, offerer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const description = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: capability.audience,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 20_000,
    message: offerDescription(),
  }, offerer, { crypto });
  const previous = await digestSignalEnvelope(description, { crypto });
  const withCandidate = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: capability.audience,
    role: "offerer",
    seq: 1,
    prev: previous,
    issuedAt: NOW + 1,
    expiresAt: NOW + 20_000,
    message: candidate(),
  }, offerer, { crypto });
  assert.deepEqual(
    (await verifySignalEnvelope(withCandidate, {
      crypto,
      now: NOW + 1,
      capability: verified,
    })).message,
    candidate(),
  );
  const end = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: capability.audience,
    role: "offerer",
    seq: 2,
    prev: await digestSignalEnvelope(withCandidate, { crypto }),
    issuedAt: NOW + 2,
    expiresAt: NOW + 20_000,
    message: { type: "candidate", candidate: null },
  }, offerer, { crypto });
  assert.equal((await verifySignalEnvelope(end, {
    crypto,
    now: NOW + 2,
    capability: verified,
  })).message.candidate, null);
});

test("signal replay consumption is atomic and opt-out is explicit", async () => {
  const { capability, offerer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const envelope = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: capability.audience,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  }, offerer, { crypto });
  const replayStore = new InMemoryReplayStore({ clock: () => NOW });
  const options = { crypto, now: NOW, capability: verified, replayStore };
  await verifySignalEnvelope(envelope, options);
  await expectCode(() => verifySignalEnvelope(envelope, options), C.REPLAYED);
  await verifySignalEnvelope(envelope, { ...options, consume: false });
});

test("bounded canonical-byte verifiers protect transport and session boundaries", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const policy = verificationPolicy(capability);
  const verified = await verifyConnectionCapabilityBytes(
    serializeConnectionCapability(capability),
    policy,
  );
  assert.deepEqual(
    serializeConnectionCapability(capability),
    canonicalizeJsonBytes(capability),
  );
  assert.equal(verified.digest, await digestConnectionCapability(capability, { crypto }));
  await expectCode(
    () => verifyConnectionCapabilityBytes(
      textEncoder.encode(` ${canonicalizeJson(capability)}`),
      policy,
    ),
    C.INVALID_JSON,
  );

  const envelope = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  }, offerer, { crypto });
  const wire = serializeSignalEnvelope(envelope);
  assert.deepEqual(wire, canonicalizeJsonBytes(envelope));
  const result = await verifySignalEnvelopeBytes(wire, {
    crypto,
    now: NOW,
    capability: verified,
  });
  assert.deepEqual(result.message, offerDescription());
  await expectCode(
    () => verifySignalEnvelopeBytes(
      textEncoder.encode(`${canonicalizeJson(envelope)}\n`),
      { crypto, now: NOW, capability: verified },
    ),
    C.INVALID_JSON,
  );

  const answerSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { consumeCapability: false },
  ));
  const accepted = await answerSession.inbound(wire);
  assert.equal(accepted.duplicate, false);
  assert.deepEqual(accepted.message, offerDescription());
});

test("first-offer reservation is atomic and never resumes a new session", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const replayStore = new InMemoryReplayStore({ maxEntries: 32, clock: () => NOW });
  assert.equal(replayStore.compareAndReserve("direct", "one", NOW + 1_000), "reserved");
  assert.equal(replayStore.compareAndReserve("direct", "one", NOW + 1_000), "matched");
  assert.equal(replayStore.compareAndReserve("direct", "two", NOW + 1_000), "conflict");

  const offer = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  }, offerer, { crypto });
  const first = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { replayStore },
  ));
  const sameOfferNewSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { replayStore },
  ));
  assert.equal((await first.inbound(offer)).duplicate, false);
  assert.equal((await first.inbound(offer)).duplicate, true);
  await expectCode(() => sameOfferNewSession.inbound(offer), C.REPLAYED);
  assert.equal(sameOfferNewSession.closed, true);
  assert.equal(
    sameOfferNewSession.closeReason,
    "capability-offer-already-accepted",
  );

  const conflict = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription("v=0\r\no=different-offer\r\n"),
  }, offerer, { crypto });
  const conflictingSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { replayStore },
  ));
  await expectCode(() => conflictingSession.inbound(conflict), C.REPLAYED);
  assert.equal(conflictingSession.closed, true);
  assert.equal(conflictingSession.closeReason, "capability-offer-conflict");
});

test("clock and replay backend failures are stable and sanitized", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const clockSecret = "clock backend password";
  await expectCode(
    () => verifyConnectionCapability(capability, {
      ...verificationPolicy(capability),
      now: () => { throw new Error(clockSecret); },
    }),
    C.CLOCK_FAILED,
    { excludes: [clockSecret] },
  );
  const clockStore = new InMemoryReplayStore({
    clock: () => { throw new Error(clockSecret); },
  });
  await expectCode(
    () => clockStore.has("clock-test"),
    C.CLOCK_FAILED,
    { excludes: [clockSecret] },
  );

  const replaySecret = "replay database connection string";
  await expectCode(
    () => verifyConnectionCapability(capability, {
      ...verificationPolicy(capability),
      consume: true,
      replayStore: {
        claim() { throw new Error(replaySecret); },
      },
    }),
    C.REPLAY_STORE_FAILED,
    { excludes: [replaySecret], retryable: true },
  );
  const session = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      replayStore: {
        claim: () => true,
        compareAndReserve() { throw new Error(replaySecret); },
      },
    },
  ));
  await expectCode(
    () => session.outbound(offerDescription()),
    C.REPLAY_STORE_FAILED,
    { excludes: [replaySecret], retryable: true },
  );
});

test("session composition requires an affirmative integration policy enforcer", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  await expectCode(
    () => createAuthenticatedSession(sessionOptions(
      offerer,
      answerer.nodeId,
      "offerer",
      capability,
      { enforceSessionPolicy: undefined },
    )),
    C.INVALID_ARGUMENT,
  );
  await expectCode(
    () => createAuthenticatedSession(sessionOptions(
      offerer,
      answerer.nodeId,
      "offerer",
      capability,
      { enforceSessionPolicy: () => false },
    )),
    C.SESSION_POLICY_REJECTED,
  );
  const policySecret = "turn credential";
  await expectCode(
    () => createAuthenticatedSession(sessionOptions(
      offerer,
      answerer.nodeId,
      "offerer",
      capability,
      { enforceSessionPolicy: () => { throw new Error(policySecret); } },
    )),
    C.SESSION_POLICY_REJECTED,
    { excludes: [policySecret] },
  );

  let context;
  const session = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      consumeCapability: false,
      enforceSessionPolicy(value) {
        context = value;
        return true;
      },
    },
  ));
  assert.equal(Object.isFrozen(context), true);
  assert.equal(context.privacy, capability.privacy);
  assert.equal(context.signalingVisibility, capability.signalingVisibility);
  assert.equal(context.localNodeId, offerer.nodeId);
  assert.equal(context.peerNodeId, answerer.nodeId);
  assert.equal(context.deadline, NOW + capability.limits.maxSessionDurationMs);
  assert.equal(session.deadline, context.deadline);
  assert.equal(context.capability, session.capability);
  assert.deepEqual(context.capability, capability);
  await expectCode(
    () => session.outbound(offerDescription(), { ttlMs: MAX_SIGNAL_LIFETIME_MS + 1 }),
    C.INVALID_ARGUMENT,
  );

  let policyNow = NOW;
  let policyStarted;
  let releasePolicy;
  const policyObserved = new Promise((resolve) => { policyStarted = resolve; });
  const policyReleased = new Promise((resolve) => { releasePolicy = resolve; });
  const pendingSession = createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      consumeCapability: false,
      clock: () => policyNow,
      async enforceSessionPolicy() {
        policyStarted();
        await policyReleased;
        return true;
      },
    },
  ));
  await policyObserved;
  policyNow = NOW + capability.limits.maxSessionDurationMs;
  releasePolicy();
  await expectCode(pendingSession, C.CAPABILITY_EXPIRED);
});

test("two authenticated sessions complete offer/answer and concurrent candidate hash chains", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const receivedByOfferer = [];
  const receivedByAnswerer = [];
  const sharedReplay = new InMemoryReplayStore({ maxEntries: 64, clock: () => NOW });
  const offerSession = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      replayStore: sharedReplay,
      onMessage: (message) => receivedByOfferer.push(message),
    },
  ));
  const answerSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    {
      replayStore: sharedReplay,
      onMessage: (message) => receivedByAnswerer.push(message),
    },
  ));

  const offer = await offerSession.outbound(offerDescription());
  const acceptedOffer = await answerSession.inbound(offer);
  const answer = await answerSession.outbound(answerDescription());
  const acceptedAnswer = await offerSession.inbound(answer);
  assert.equal(acceptedOffer.duplicate, false);
  assert.equal(acceptedAnswer.duplicate, false);

  const [offerCandidate1, offerCandidate2] = await Promise.all([
    offerSession.outbound(candidate("candidate:offer-1")),
    offerSession.outbound(candidate("candidate:offer-2")),
  ]);
  assert.deepEqual([offerCandidate1.seq, offerCandidate2.seq], [1, 2]);
  assert.equal(offerCandidate1.prev, await digestSignalEnvelope(offer, { crypto }));
  assert.equal(offerCandidate2.prev, await digestSignalEnvelope(offerCandidate1, { crypto }));
  const acceptedCandidates = await Promise.all([
    answerSession.inbound(offerCandidate1),
    answerSession.inbound(offerCandidate2),
  ]);
  assert.deepEqual(acceptedCandidates.map((value) => value.duplicate), [false, false]);

  const [answerCandidate1, answerCandidate2] = await Promise.all([
    answerSession.outbound(candidate("candidate:answer-1")),
    answerSession.outbound({ type: "candidate", candidate: null }),
  ]);
  assert.deepEqual([answerCandidate1.seq, answerCandidate2.seq], [1, 2]);
  assert.equal(answerCandidate1.prev, await digestSignalEnvelope(answer, { crypto }));
  assert.equal(answerCandidate2.prev, await digestSignalEnvelope(answerCandidate1, { crypto }));
  await Promise.all([
    offerSession.inbound(answerCandidate1),
    offerSession.inbound(answerCandidate2),
  ]);

  assert.equal(offerSession.outboundSequence, 3);
  assert.equal(offerSession.inboundSequence, 3);
  assert.equal(answerSession.outboundSequence, 3);
  assert.equal(answerSession.inboundSequence, 3);
  assert.deepEqual(receivedByAnswerer, [
    offerDescription(),
    candidate("candidate:offer-1"),
    candidate("candidate:offer-2"),
  ]);
  assert.deepEqual(receivedByOfferer, [
    answerDescription(),
    candidate("candidate:answer-1"),
    { type: "candidate", candidate: null },
  ]);
});

test("authenticated sessions compose through the byte-only rendezvous transport contract", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const queues = new Map([
    [offerer.nodeId, []],
    [answerer.nodeId, []],
  ]);
  const idempotencyKeys = new Set();
  let cursor = 0;
  const transport = {
    async publish(envelope, options) {
      assert.ok(envelope instanceof Uint8Array);
      assert.ok(queues.has(options.recipient));
      const key = `${options.recipient}:${options.idempotencyKey}`;
      if (idempotencyKeys.has(key)) {
        return { accepted: true, duplicate: true, cursor: String(cursor) };
      }
      idempotencyKeys.add(key);
      queues.get(options.recipient).push(envelope.slice());
      cursor += 1;
      return { accepted: true, duplicate: false, cursor: String(cursor) };
    },
    async receive({ recipient }) {
      assert.ok(queues.has(recipient));
      const envelopes = queues.get(recipient).splice(0);
      return { envelopes, cursor: String(cursor) };
    },
  };

  const replayStore = new InMemoryReplayStore({ maxEntries: 64, clock: () => NOW });
  const offerSession = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { replayStore },
  ));
  const answerSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { replayStore },
  ));

  const offer = await offerSession.outbound(offerDescription());
  const offerBytes = serializeSignalEnvelope(offer, {
    maxSignalBytes: capability.limits.maxSignalBytes,
  });
  const offerKey = await digestSignalEnvelope(offer, { crypto });
  assert.deepEqual(
    await transport.publish(offerBytes, {
      recipient: answerer.nodeId,
      idempotencyKey: offerKey,
    }),
    { accepted: true, duplicate: false, cursor: "1" },
  );
  assert.equal((await transport.publish(offerBytes, {
    recipient: answerer.nodeId,
    idempotencyKey: offerKey,
  })).duplicate, true);
  const deliveredOffers = await transport.receive({ recipient: answerer.nodeId });
  assert.equal(deliveredOffers.envelopes.length, 1);
  assert.notEqual(deliveredOffers.envelopes[0], offerBytes);
  assert.deepEqual(
    (await answerSession.inbound(deliveredOffers.envelopes[0])).message,
    offerDescription(),
  );

  const answer = await answerSession.outbound(answerDescription());
  const answerBytes = serializeSignalEnvelope(answer, {
    maxSignalBytes: capability.limits.maxSignalBytes,
  });
  await transport.publish(answerBytes, {
    recipient: offerer.nodeId,
    idempotencyKey: await digestSignalEnvelope(answer, { crypto }),
  });
  const deliveredAnswers = await transport.receive({ recipient: offerer.nodeId });
  assert.equal(deliveredAnswers.envelopes.length, 1);
  assert.deepEqual(
    (await offerSession.inbound(deliveredAnswers.envelopes[0])).message,
    answerDescription(),
  );
});

test("session duplicate delivery is idempotent but same-sequence equivocation is rejected", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  let handlerCalls = 0;
  const offerSession = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
  ));
  const answerSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    { onMessage: () => { handlerCalls += 1; } },
  ));
  const offer = await offerSession.outbound(offerDescription());
  const [first, duplicate] = await Promise.all([
    answerSession.inbound(offer),
    answerSession.inbound(offer),
  ]);
  assert.equal(first.duplicate, false);
  assert.deepEqual(first.message, offerDescription());
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.message, null);
  assert.equal(duplicate.digest, first.digest);
  assert.equal(answerSession.inboundSequence, 1);
  assert.equal(handlerCalls, 1);

  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const equivocation = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription("v=0\r\no=equivocation\r\n"),
  }, offerer, { crypto });
  await expectCode(() => answerSession.inbound(equivocation), C.SIGNAL_SEQUENCE);
  assert.equal(answerSession.inboundSequence, 1);
  assert.equal(handlerCalls, 1);
});

test("session rejects gaps, broken chains, candidates before descriptions, and post-terminal candidates", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const verified = await verifyConnectionCapability(capability, verificationPolicy(capability));
  const answerSession = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
  ));
  const description = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 0,
    prev: null,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: offerDescription(),
  }, offerer, { crypto });
  const digest = await digestSignalEnvelope(description, { crypto });
  const gap = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 2,
    prev: digest,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: candidate("candidate:gap"),
  }, offerer, { crypto });
  await expectCode(() => answerSession.inbound(gap), C.SIGNAL_SEQUENCE);

  const preDescription = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 1,
    prev: digest,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: candidate("candidate:too-early"),
  }, offerer, { crypto });
  await expectCode(() => answerSession.inbound(preDescription), C.SIGNAL_SEQUENCE);

  await answerSession.inbound(description);
  const wrongChain = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: verified.digest,
    to: answerer.nodeId,
    role: "offerer",
    seq: 1,
    prev: `sha256-${encodeBase64Url(new Uint8Array(32))}`,
    issuedAt: NOW,
    expiresAt: NOW + 10_000,
    message: candidate("candidate:wrong-chain"),
  }, offerer, { crypto });
  await expectCode(() => answerSession.inbound(wrongChain), C.SIGNAL_CHAIN);

  const offerSession = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false },
  ));
  await expectCode(() => offerSession.outbound(candidate()), C.SIGNAL_SEQUENCE);
  await offerSession.outbound(offerDescription());
  await offerSession.outbound({ type: "candidate", candidate: null });
  await expectCode(
    () => offerSession.outbound(candidate("candidate:after-end")),
    C.SIGNAL_SEQUENCE,
  );
});

test("sessions enforce exact capability policy, role, single use, and signal limits", async () => {
  const { capability, issuer, offerer, answerer } = await capabilityFixture({
    limits: { maxSignals: 1, maxSignalBytes: 4096, maxSessionDurationMs: 60_000 },
  });
  await expectCode(
    () => createAuthenticatedSession(sessionOptions(
      answerer,
      offerer.nodeId,
      "offerer",
      capability,
    )),
    C.CAPABILITY_MISMATCH,
  );
  await expectCode(
    () => createAuthenticatedSession(sessionOptions(
      offerer,
      answerer.nodeId,
      "offerer",
      capability,
      { resource: "weave://rooms/not-authorized" },
    )),
    C.CAPABILITY_MISMATCH,
  );

  const replayStore = new InMemoryReplayStore({ maxEntries: 8, clock: () => NOW });
  const options = sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { replayStore },
  );
  const session = await createAuthenticatedSession(options);
  const competingSession = await createAuthenticatedSession(options);
  await session.outbound(offerDescription());
  await expectCode(
    () => competingSession.outbound(offerDescription()),
    C.REPLAYED,
  );
  assert.equal(competingSession.closed, true);
  assert.equal(competingSession.closeReason, "capability-offer-already-accepted");
  const conflictingSession = await createAuthenticatedSession(options);
  await expectCode(
    () => conflictingSession.outbound(offerDescription("v=0\r\no=conflict\r\n")),
    C.REPLAYED,
  );
  assert.equal(conflictingSession.closed, true);
  assert.equal(conflictingSession.closeReason, "capability-offer-conflict");
  await expectCode(() => session.outbound(candidate()), C.LIMIT_EXCEEDED);
  assert.equal(session.outboundSequence, 1);

  await expectCode(
    () => createAuthenticatedSession({
      identity: offerer,
      peerNodeId: answerer.nodeId,
      role: "offerer",
      capability,
      crypto,
      now: NOW,
      expectedIssuer: issuer.nodeId,
    }),
    C.CAPABILITY_MISMATCH,
  );
});

test("session terminal states are explicit for close, expiry, and handler failure", async () => {
  const { capability, offerer, answerer } = await capabilityFixture({
    limits: { maxSignals: 4, maxSignalBytes: 4096, maxSessionDurationMs: 1_000 },
  });
  const manuallyClosed = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
  ));
  assert.equal(manuallyClosed.close("human-cancelled"), true);
  assert.equal(manuallyClosed.close("again"), false);
  assert.equal(manuallyClosed.closed, true);
  assert.equal(manuallyClosed.closeReason, "human-cancelled");
  await expectCode(() => manuallyClosed.outbound(offerDescription()), C.SESSION_CLOSED);

  const expiring = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false },
  ));
  await expectCode(
    () => expiring.outbound(offerDescription(), { now: NOW + 1_000 }),
    C.CAPABILITY_EXPIRED,
  );
  assert.equal(expiring.closed, true);
  assert.equal(expiring.closeReason, "expired");

  const sender = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false },
  ));
  const receiver = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    {
      consumeCapability: false,
      onMessage: () => { throw new Error("application detail"); },
    },
  ));
  const envelope = await sender.outbound(offerDescription());
  const failure = await expectCode(() => receiver.inbound(envelope), C.HANDLER_FAILED);
  assert.equal(failure.message, "authenticated signal consumer failed; session was closed");
  assert.equal(receiver.closed, true);
  assert.equal(receiver.closeReason, "handler-failed");
  await expectCode(() => receiver.inbound(envelope), C.SESSION_CLOSED);
});

test("in-flight session work fails closed across terminal and irreversible boundaries", async () => {
  const { capability, offerer, answerer } = await capabilityFixture();
  const domainBytes = textEncoder.encode(SIGNAL_SIGNATURE_DOMAIN);
  const gatedProvider = (operation) => {
    let release;
    let started;
    let armed = true;
    const released = new Promise((resolve) => { release = resolve; });
    const observed = new Promise((resolve) => { started = resolve; });
    const subtle = new Proxy(crypto.subtle, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === operation) {
          return async (...args) => {
            const input = new Uint8Array(args.at(-1));
            const isSignal = input.length >= domainBytes.length &&
              domainBytes.every((byte, index) => input[index] === byte);
            if (armed && isSignal) {
              armed = false;
              started();
              await released;
            }
            return value.apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return {
      provider: {
        subtle,
        getRandomValues: crypto.getRandomValues.bind(crypto),
      },
      observed,
      release,
    };
  };

  const closeGate = gatedProvider("sign");
  const manuallyClosed = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false, crypto: closeGate.provider },
  ));
  const pendingClose = manuallyClosed.outbound(offerDescription());
  await closeGate.observed;
  assert.equal(manuallyClosed.close("cancelled-in-flight"), true);
  closeGate.release();
  await expectCode(pendingClose, C.SESSION_CLOSED);
  assert.equal(manuallyClosed.outboundSequence, 0);

  let current = NOW;
  const deadlineGate = gatedProvider("sign");
  const deadlineClosed = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      consumeCapability: false,
      crypto: deadlineGate.provider,
      clock: () => current,
    },
  ));
  const pendingDeadline = deadlineClosed.outbound(offerDescription());
  await deadlineGate.observed;
  current = deadlineClosed.deadline;
  deadlineGate.release();
  await expectCode(pendingDeadline, C.CAPABILITY_EXPIRED);
  assert.equal(deadlineClosed.closed, true);
  assert.equal(deadlineClosed.closeReason, "expired");
  assert.equal(deadlineClosed.outboundSequence, 0);

  let reserveNow = NOW;
  let reserveStarted;
  let releaseReserve;
  const reserveObserved = new Promise((resolve) => { reserveStarted = resolve; });
  const reserveReleased = new Promise((resolve) => { releaseReserve = resolve; });
  const delayedReplayStore = {
    claim() { return true; },
    async compareAndReserve() {
      reserveStarted();
      await reserveReleased;
      return "reserved";
    },
  };
  const reserveClosed = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    {
      replayStore: delayedReplayStore,
      clock: () => reserveNow,
    },
  ));
  const pendingReserve = reserveClosed.outbound(offerDescription(), { ttlMs: 1 });
  await reserveObserved;
  reserveNow = NOW + 1;
  releaseReserve();
  await expectCode(pendingReserve, C.SIGNAL_EXPIRED);
  assert.equal(reserveClosed.closed, true);
  assert.equal(reserveClosed.closeReason, "outbound-incomplete");
  assert.equal(reserveClosed.outboundSequence, 0);
  await expectCode(() => reserveClosed.outbound(offerDescription()), C.SESSION_CLOSED);

  let handlerStarted;
  let releaseHandler;
  const handlerObserved = new Promise((resolve) => { handlerStarted = resolve; });
  const handlerReleased = new Promise((resolve) => { releaseHandler = resolve; });
  const sender = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false },
  ));
  const receiver = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    {
      consumeCapability: false,
      async onMessage() {
        handlerStarted();
        await handlerReleased;
      },
    },
  ));
  const inbound = receiver.inbound(await sender.outbound(offerDescription()));
  await handlerObserved;
  assert.equal(receiver.close("cancelled-handler"), true);
  releaseHandler();
  await expectCode(inbound, C.SESSION_CLOSED);
  assert.equal(receiver.inboundSequence, 0);

  let expiryNow = NOW;
  let expiryHandlerCalls = 0;
  const expiryReplayStore = new InMemoryReplayStore({
    maxEntries: 64,
    clock: () => expiryNow,
  });
  const expirySender = await createAuthenticatedSession(sessionOptions(
    offerer,
    answerer.nodeId,
    "offerer",
    capability,
    { consumeCapability: false },
  ));
  const expiryReceiver = await createAuthenticatedSession(sessionOptions(
    answerer,
    offerer.nodeId,
    "answerer",
    capability,
    {
      replayStore: expiryReplayStore,
      clock: () => expiryNow,
      onMessage(message, { envelope }) {
        expiryHandlerCalls += 1;
        if (message.type === "candidate") expiryNow = envelope.expiresAt;
      },
    },
  ));
  await expiryReceiver.inbound(await expirySender.outbound(offerDescription()));
  const shortLivedCandidate = await expirySender.outbound(
    candidate("candidate:expires-in-handler"),
    { ttlMs: 1 },
  );
  await expectCode(() => expiryReceiver.inbound(shortLivedCandidate), C.SIGNAL_EXPIRED);
  assert.equal(expiryReceiver.closed, true);
  assert.equal(expiryReceiver.closeReason, "inbound-incomplete");
  assert.equal(expiryReceiver.inboundSequence, 1);
  assert.equal(expiryHandlerCalls, 2);

  const sameSequenceDifferentSignal = await createSignalEnvelope({
    sessionId: capability.sessionId,
    capabilityDigest: await digestConnectionCapability(capability, { crypto }),
    to: answerer.nodeId,
    role: "offerer",
    seq: 1,
    prev: shortLivedCandidate.prev,
    issuedAt: expiryNow,
    expiresAt: expiryNow + 1_000,
    message: candidate("candidate:cannot-reuse-sequence"),
  }, offerer, { crypto, now: expiryNow });
  await expectCode(
    () => expiryReceiver.inbound(sameSequenceDifferentSignal),
    C.SESSION_CLOSED,
  );
  assert.equal(expiryHandlerCalls, 2);
});

test("InMemoryReplayStore never evicts live decisions and prunes expired ones", async () => {
  let now = 100;
  const store = new InMemoryReplayStore({ maxEntries: 2, clock: () => now });
  assert.equal(store.claim("a", 110), true);
  assert.equal(store.claim("a", 120), false);
  assert.equal(store.has("a"), true);
  assert.equal(store.claim("b", 120), true);
  assert.equal(store.size, 2);
  await expectCode(() => store.claim("c", 130), C.REPLAY_STORE_FULL);
  assert.equal(store.has("a"), true);
  assert.equal(store.has("b"), true);

  now = 110;
  assert.equal(store.prune(), 1);
  assert.equal(store.has("a"), false);
  assert.equal(store.claim("c", 130), true);
  assert.equal(store.size, 2);
  assert.equal(store.claim("already-expired", 110), false);
  assert.equal(store.prune(121), 1);
  assert.equal(store.size, 1);
  store.clear();
  assert.equal(store.size, 0);
  await expectCode(() => store.claim("", 130), C.INVALID_ARGUMENT);
  await expectCode(() => new InMemoryReplayStore({ maxEntries: 0 }), C.INVALID_ARGUMENT);
});
