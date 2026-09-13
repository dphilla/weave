import {
  createNodeIdentity,
  encodeBase64Url,
  generateNodeIdentity,
  type ByteSource,
  type CryptoKeyLike,
  type CryptoProviderLike,
  type NodeIdentity,
} from "@weave-net/authenticated-rendezvous";

// General encoding inputs remain broader than the owned native-crypto bytes.
const sharedView: ByteSource = new DataView(new SharedArrayBuffer(32));
encodeBase64Url(sharedView);
encodeBase64Url(new Uint16Array(new ArrayBuffer(32), 4, 6));

// Structural compatibility only: this is not a cryptographic implementation.
// ES-only compilation proves no DOM or Node ambient types are necessary.
const publicKey: CryptoKeyLike = {
  type: "public", algorithm: { name: "Ed25519" }, usages: ["verify"],
};
const privateKey: CryptoKeyLike = {
  type: "private", algorithm: { name: "Ed25519" }, usages: ["sign"],
};
const provider: CryptoProviderLike = {
  getRandomValues(array) { return array; },
  subtle: {
    async digest() { return new ArrayBuffer(32); },
    async generateKey() { return { publicKey, privateKey }; },
    async exportKey() { return new ArrayBuffer(32); },
    async importKey() { return publicKey; },
    async sign() { return new ArrayBuffer(64); },
    async verify() { return true; },
  },
};
export async function customProviderConsumer(): Promise<NodeIdentity> {
  await generateNodeIdentity({ crypto: provider });
  return createNodeIdentity({ publicKey, privateKey }, { crypto: provider });
}
export const customSigner: NodeIdentity = {
  nodeId: "wn1-example",
  publicKey: "example",
  sign(bytes) { return Promise.resolve(bytes.slice()); },
};

// These globals must remain unavailable in this third, entirely ES-only lane.
// @ts-expect-error DOM globals must not leak into this configuration.
void document;
// @ts-expect-error Node ambient globals must not leak into this configuration.
void process;
