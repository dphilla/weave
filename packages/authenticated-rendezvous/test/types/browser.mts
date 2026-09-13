import {
  createNodeIdentity,
  generateNodeIdentity,
  nodeIdFromPublicKey,
  verifyNodeId,
  type CryptoProviderLike,
  type NodeIdentity,
} from "@weave-net/authenticated-rendezvous";

// Compile against actual DOM types, without Node ambient declarations.
export async function browserConsumer(): Promise<NodeIdentity> {
  const provider: CryptoProviderLike = globalThis.crypto;
  const random: Uint8Array = provider.getRandomValues(new Uint8Array(24));
  const keys: CryptoKeyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" }, false, ["sign", "verify"],
  );
  const identity = await createNodeIdentity(keys, { crypto: globalThis.crypto });
  await generateNodeIdentity({ crypto: globalThis.crypto });
  await generateNodeIdentity();
  const nodeId = await nodeIdFromPublicKey(keys.publicKey, { crypto: provider });
  const verified: true = await verifyNodeId(nodeId, keys.publicKey, { crypto: provider });
  const signer: NodeIdentity = {
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    sign: (bytes) => crypto.subtle.sign({ name: "Ed25519" }, keys.privateKey, bytes),
  };
  void random;
  void verified;
  // @ts-expect-error Node globals must not leak into the browser-only lane.
  void process;
  return signer;
}
