import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  CAPABILITY_SIGNATURE_DOMAIN,
  createNodeIdentity,
  generateNodeIdentity,
  issueConnectionCapability,
  nodeIdFromPublicKey,
  serializeConnectionCapability,
  verifyConnectionCapabilityBytes,
  verifyNodeId,
  type ConnectionCapabilityClaims,
  type CryptoProviderLike,
  type NodeIdentity,
} from "@weave-net/authenticated-rendezvous";

if (false) {
  // @ts-expect-error DOM globals must not leak into the Node-only lane.
  void document;
}

// Compiled and executed as an installed-package Node ESM consumer. No DOM lib.
const provider: CryptoProviderLike = webcrypto;
const random: Uint8Array = provider.getRandomValues(new Uint8Array(24));
assert.equal(random.byteLength, 24);
const generated = await generateNodeIdentity({ crypto: webcrypto });
const keys = await webcrypto.subtle.generateKey(
  { name: "Ed25519" }, false, ["sign", "verify"],
);
// Node's public declarations return a key-or-pair union for this overload.
// Narrow by its actual shape; do not cast away the consumer's native types.
if (!("publicKey" in keys)) throw new Error("Ed25519 must generate a key pair");
const imported = await createNodeIdentity(keys, { crypto: webcrypto });
const nodeId = await nodeIdFromPublicKey(keys.publicKey, { crypto: webcrypto });
const verified: true = await verifyNodeId(nodeId, keys.publicKey, { crypto: webcrypto });
assert.equal(verified, true);
assert.equal(imported.nodeId, nodeId);

const signedInputs: Uint8Array[] = [];
const signingBuffers: ArrayBuffer[] = [];
const remoteSigner: NodeIdentity = {
  nodeId: imported.nodeId,
  publicKey: imported.publicKey,
  sign(bytes) {
    assert.ok(bytes.buffer instanceof ArrayBuffer);
    assert.equal(bytes.byteOffset, 0);
    assert.equal(bytes.byteLength, bytes.buffer.byteLength);
    assert.ok(!signingBuffers.includes(bytes.buffer));
    signingBuffers.push(bytes.buffer);
    signedInputs.push(bytes.slice());
    return webcrypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, bytes);
  },
};
const claims: ConnectionCapabilityClaims = {
  subject: generated.nodeId,
  audience: imported.nodeId,
  action: "example.stream.open",
  resource: "urn:example:stream:typed-consumer",
  applicationProtocol: "example.stream.v1",
  channels: [{ label: "stream", protocol: "example.stream.v1" }],
  privacy: "direct-preferred",
  limits: { maxSignals: 16, maxSignalBytes: 4096, maxSessionDurationMs: 30_000 },
  actor: "principal:typecheck",
  onBehalfOf: null,
  serviceId: "example:stream-service",
  profile: "reliable-byte-stream.v1",
};
const capability = await issueConnectionCapability(claims, remoteSigner, { crypto: webcrypto });
const result = await verifyConnectionCapabilityBytes(serializeConnectionCapability(capability), {
  crypto: webcrypto,
  trustedIssuers: [imported.nodeId],
  expectedSubject: generated.nodeId,
});
// An arbitrary structural signer proves key possession, then signs the record.
assert.equal(signedInputs.length, 2);
assert.ok(new TextDecoder().decode(signedInputs[0]).startsWith("weave.rendezvous.identity-proof.v1\0"));
assert.ok(new TextDecoder().decode(signedInputs[1]).startsWith(CAPABILITY_SIGNATURE_DOMAIN));
assert.equal(result.capability.issuer, imported.nodeId);
assert.equal(result.capability.subject, generated.nodeId);
console.log("PASS installed Node ESM Web Crypto identity, native keys, and custom signing hook verification");
