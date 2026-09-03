import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CAPABILITY_SIGNATURE_DOMAIN,
  SIGNAL_SIGNATURE_DOMAIN,
  canonicalizeJson,
  canonicalizeJsonBytes,
  createNodeIdentity,
  createSignalEnvelope,
  decodeBase64Url,
  digestConnectionCapability,
  digestSignalEnvelope,
  encodeBase64Url,
  issueConnectionCapability,
  nodeIdFromPublicKey,
  parseCanonicalJson,
  verifyConnectionCapability,
  verifyConnectionCapabilityBytes,
  verifySignalEnvelope,
  verifySignalEnvelopeBytes,
} from "../src/index.mjs";

const crypto = webcrypto;
const vector = JSON.parse(await readFile(
  new URL("../vectors/v1.json", import.meta.url),
  "utf8",
));

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

function withoutSignature(record) {
  const unsigned = { ...record };
  delete unsigned.signature;
  return unsigned;
}

async function importIdentity(record) {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    concatBytes(
      bytesFromHex("302e020100300506032b657004220420"),
      bytesFromHex(record.seedHex),
    ),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const publicKey = await crypto.subtle.importKey(
    "raw",
    bytesFromHex(record.publicKeyHex),
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return createNodeIdentity({ privateKey, publicKey }, { crypto });
}

async function assertSigningArtifact(artifact, domain, identity) {
  assert.equal(artifact.signatureDomain, domain);
  assert.equal(
    artifact.signatureDomainUtf8Hex,
    hexFromBytes(new TextEncoder().encode(domain)),
  );
  const unsigned = withoutSignature(artifact.signed);
  assert.equal(canonicalizeJson(unsigned), artifact.canonicalUnsignedJson);
  assert.deepEqual(parseCanonicalJson(artifact.canonicalUnsignedJson), unsigned);
  assert.equal(canonicalizeJson(artifact.signed), artifact.canonicalSignedJson);
  assert.deepEqual(parseCanonicalJson(artifact.canonicalSignedJson), artifact.signed);

  const signingInput = concatBytes(
    new TextEncoder().encode(domain),
    canonicalizeJsonBytes(unsigned),
  );
  const generatedSignature = new Uint8Array(await crypto.subtle.sign(
    { name: "Ed25519" },
    identity.signingKey,
    signingInput,
  ));
  assert.equal(encodeBase64Url(generatedSignature), artifact.signatureBase64Url);
  assert.equal(artifact.signed.signature, artifact.signatureBase64Url);
  assert.equal(await crypto.subtle.verify(
    { name: "Ed25519" },
    identity.verificationKey,
    decodeBase64Url(artifact.signatureBase64Url),
    signingInput,
  ), true);
}

let identitiesPromise;
function identities() {
  identitiesPromise ??= Promise.all(Object.entries(vector.identities).map(
    async ([name, record]) => [name, await importIdentity(record)],
  )).then(Object.fromEntries);
  return identitiesPromise;
}

test("v1 conformance vector carries explicit public test-key and standards metadata", () => {
  assert.equal(vector.format, "weave-authenticated-rendezvous-conformance-v1");
  assert.match(vector.warning, /public test vectors/i);
  assert.match(vector.warning, /never use/i);
  assert.deepEqual(vector.standards, {
    canonicalization: "RFC 8785 JSON Canonicalization Scheme",
    signature: "RFC 8032 Ed25519",
    keyEncoding: "RFC 8410 Ed25519",
    textEncoding: "UTF-8",
  });
  assert.equal(vector.now, 1_800_000_000_000);
});

test("all RFC 8032 identities reproduce their public keys and expected NodeIDs", async () => {
  const imported = await identities();
  for (const [name, record] of Object.entries(vector.identities)) {
    const identity = imported[name];
    assert.equal(identity.publicKey, record.publicKeyBase64Url, `${name} public key`);
    assert.equal(identity.nodeId, record.nodeId, `${name} NodeID`);
    assert.equal(
      await nodeIdFromPublicKey(bytesFromHex(record.publicKeyHex), { crypto }),
      record.nodeId,
      `${name} derived NodeID`,
    );
  }
});

test("the full capability reproduces canonical bytes, signature, and digest", async () => {
  const imported = await identities();
  await assertSigningArtifact(
    vector.capability,
    CAPABILITY_SIGNATURE_DOMAIN,
    imported.issuer,
  );

  const issued = await issueConnectionCapability(
    vector.capability.claims,
    imported.issuer,
    { crypto, now: vector.now },
  );
  assert.deepEqual(issued, vector.capability.signed);
  assert.equal(
    await digestConnectionCapability(issued, { crypto }),
    vector.capability.digest,
  );

  const capability = vector.capability.signed;
  const policy = {
    crypto,
    now: vector.now,
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
  const verified = await verifyConnectionCapability(capability, policy);
  assert.equal(verified.digest, vector.capability.digest);
  const verifiedBytes = await verifyConnectionCapabilityBytes(
    new TextEncoder().encode(vector.capability.canonicalSignedJson),
    policy,
  );
  assert.deepEqual(verifiedBytes.capability, capability);
  assert.equal(verifiedBytes.digest, vector.capability.digest);
});

test("offer and answer signals reproduce canonical bytes, signatures, and digests", async () => {
  const imported = await identities();
  const verifiedCapability = await verifyConnectionCapability(
    vector.capability.signed,
    {
      crypto,
      now: vector.now,
      clockSkewMs: 0,
      expectedIssuer: vector.identities.issuer.nodeId,
    },
  );

  for (const [name, identityName] of [
    ["offer", "offerer"],
    ["answer", "answerer"],
  ]) {
    const artifact = vector.signals[name];
    const identity = imported[identityName];
    await assertSigningArtifact(artifact, SIGNAL_SIGNATURE_DOMAIN, identity);

    const generated = await createSignalEnvelope(
      artifact.fields,
      identity,
      {
        crypto,
        now: artifact.fields.issuedAt,
        maxSignalBytes: vector.capability.signed.limits.maxSignalBytes,
      },
    );
    assert.deepEqual(generated, artifact.signed, `${name} signed envelope`);
    assert.equal(
      await digestSignalEnvelope(generated, {
        crypto,
        maxSignalBytes: vector.capability.signed.limits.maxSignalBytes,
      }),
      artifact.digest,
      `${name} digest`,
    );

    const verified = await verifySignalEnvelope(artifact.signed, {
      crypto,
      now: artifact.fields.issuedAt,
      clockSkewMs: 0,
      capability: verifiedCapability,
      expectedSessionId: artifact.fields.sessionId,
      expectedCapabilityDigest: artifact.fields.capabilityDigest,
      expectedFrom: identity.nodeId,
      expectedTo: artifact.fields.to,
      expectedRole: artifact.fields.role,
      expectedSeq: artifact.fields.seq,
      expectedPrev: artifact.fields.prev,
    });
    assert.equal(verified.digest, artifact.digest, `${name} verified digest`);
    assert.deepEqual(verified.message, artifact.fields.message, `${name} message`);

    const verifiedBytes = await verifySignalEnvelopeBytes(
      new TextEncoder().encode(artifact.canonicalSignedJson),
      {
        crypto,
        now: artifact.fields.issuedAt,
        clockSkewMs: 0,
        capability: verifiedCapability,
        expectedSessionId: artifact.fields.sessionId,
        expectedCapabilityDigest: artifact.fields.capabilityDigest,
        expectedFrom: identity.nodeId,
        expectedTo: artifact.fields.to,
        expectedRole: artifact.fields.role,
        expectedSeq: artifact.fields.seq,
        expectedPrev: artifact.fields.prev,
      },
    );
    assert.equal(verifiedBytes.digest, artifact.digest, `${name} byte digest`);
    assert.deepEqual(verifiedBytes.envelope, artifact.signed, `${name} byte envelope`);
  }
});
