import {
  createNodeIdentity,
  generateNodeIdentity,
  type ConnectionCapabilityClaims,
  type CryptoBytes,
  type CryptoKeyLike,
  type CryptoProviderLike,
  type NodeIdentity,
  type SessionPolicyEnforcer,
  type SubtleCryptoLike,
} from "@weave-net/authenticated-rendezvous";

const privateKey: CryptoKeyLike = {
  type: "private", algorithm: { name: "Ed25519" }, usages: ["sign"],
};
const subtle: SubtleCryptoLike = {
  async digest() { return new ArrayBuffer(32); },
  async generateKey() { return { publicKey: privateKey, privateKey }; },
  async exportKey() { return new ArrayBuffer(32); },
  async importKey() { return privateKey; },
  async sign() { return new ArrayBuffer(64); },
  async verify() { return true; },
};
const { verify: omittedVerify, ...withoutVerify } = subtle;

// @ts-expect-error A provider requires the subtle methods and secure randomness.
void generateNodeIdentity({ crypto: {} });
// @ts-expect-error Subtle alone is insufficient without secure randomness.
void generateNodeIdentity({ crypto: { subtle } });
// @ts-expect-error Every required subtle method, including verify, must exist.
void generateNodeIdentity({ crypto: { subtle: withoutVerify, getRandomValues(array) { return array; } } });
// @ts-expect-error Key metadata must contain an algorithm.
void createNodeIdentity({ publicKey: { type: "public", usages: ["verify"] }, privateKey });
// @ts-expect-error Key metadata must contain usages.
void createNodeIdentity({ publicKey: { type: "public", algorithm: { name: "Ed25519" } }, privateKey });
// @ts-expect-error A single key is not a key pair.
void createNodeIdentity(privateKey);
// @ts-expect-error Identity signing hooks must return bytes, not a string.
const wrongSigner: NodeIdentity = { nodeId: "example", publicKey: "example", sign: () => "signature" };
// @ts-expect-error Subtle verification must produce a boolean.
const wrongVerify: SubtleCryptoLike["verify"] = async () => "verified";
// @ts-expect-error Subtle signing must return bytes, not text.
const wrongSign: SubtleCryptoLike["sign"] = async () => "signature";
// @ts-expect-error Key generation must produce key metadata, not a string.
const wrongGeneratedKey: SubtleCryptoLike["generateKey"] = async () => "key";
// @ts-expect-error Native-crypto inputs must not admit SharedArrayBuffer backing.
const wrongSharedBytes: CryptoBytes = new Uint8Array(new SharedArrayBuffer(32));
// @ts-expect-error A policy enforcer must return a boolean, not a truthy string.
const wrongPolicy: SessionPolicyEnforcer = () => "accepted";
// @ts-expect-error Unknown privacy modes must not become permissive strings.
const wrongPrivacy: ConnectionCapabilityClaims["privacy"] = "allow-anything";
// @ts-expect-error Randomness must return the requested bytes, not a number.
const wrongRandom: CryptoProviderLike["getRandomValues"] = () => 7;
// @ts-expect-error All required subtle methods, including verify, must exist.
const missingSubtle: SubtleCryptoLike = {};

void [wrongSigner, wrongVerify, wrongSign, wrongGeneratedKey, wrongSharedBytes, wrongPolicy, wrongPrivacy,
  wrongRandom, missingSubtle, omittedVerify];
