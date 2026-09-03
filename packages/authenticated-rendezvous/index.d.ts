export const RENDEZVOUS_PROTOCOL: "weave-rendezvous.v1";
export const CAPABILITY_SIGNATURE_DOMAIN: "weave.rendezvous.capability.v1\0";
export const SIGNAL_SIGNATURE_DOMAIN: "weave.rendezvous.signal.v1\0";

export const DEFAULT_CLOCK_SKEW_MS: 30000;
export const DEFAULT_CAPABILITY_TTL_MS: 300000;
export const MAX_CAPABILITY_LIFETIME_MS: 600000;
export const DEFAULT_SIGNAL_TTL_MS: 30000;
export const MAX_SIGNAL_LIFETIME_MS: 60000;
export const DEFAULT_MAX_SIGNALS: 512;
export const MAX_SIGNALS: 4096;
export const DEFAULT_MAX_SIGNAL_BYTES: 262144;
export const MAX_SIGNAL_BYTES: 262144;
export const DEFAULT_MAX_SESSION_DURATION_MS: 600000;
export const MAX_CHANNELS: 8;
export const MAX_CAPABILITY_BYTES: 16384;
export const MAX_CANONICAL_JSON_BYTES: 1048576;
export const MAX_CANONICAL_JSON_DEPTH: 32;
export const MAX_CANONICAL_JSON_NODES: 16384;
export const DEFAULT_MAX_REPLAY_ENTRIES: 4096;

export const RENDEZVOUS_ERROR_CODES: Readonly<{
  INVALID_ARGUMENT: "ERR_RENDEZVOUS_INVALID_ARGUMENT";
  INVALID_JSON: "ERR_RENDEZVOUS_INVALID_JSON";
  LIMIT_EXCEEDED: "ERR_RENDEZVOUS_LIMIT_EXCEEDED";
  CRYPTO_UNAVAILABLE: "ERR_RENDEZVOUS_CRYPTO_UNAVAILABLE";
  KEY_INVALID: "ERR_RENDEZVOUS_KEY_INVALID";
  NODE_ID_INVALID: "ERR_RENDEZVOUS_NODE_ID_INVALID";
  NODE_ID_MISMATCH: "ERR_RENDEZVOUS_NODE_ID_MISMATCH";
  SIGNATURE_INVALID: "ERR_RENDEZVOUS_SIGNATURE_INVALID";
  CAPABILITY_INVALID: "ERR_RENDEZVOUS_CAPABILITY_INVALID";
  CAPABILITY_UNTRUSTED_ISSUER: "ERR_RENDEZVOUS_CAPABILITY_UNTRUSTED_ISSUER";
  CAPABILITY_NOT_YET_VALID: "ERR_RENDEZVOUS_CAPABILITY_NOT_YET_VALID";
  CAPABILITY_EXPIRED: "ERR_RENDEZVOUS_CAPABILITY_EXPIRED";
  CAPABILITY_MISMATCH: "ERR_RENDEZVOUS_CAPABILITY_MISMATCH";
  SIGNAL_INVALID: "ERR_RENDEZVOUS_SIGNAL_INVALID";
  SIGNAL_EXPIRED: "ERR_RENDEZVOUS_SIGNAL_EXPIRED";
  SIGNAL_MISMATCH: "ERR_RENDEZVOUS_SIGNAL_MISMATCH";
  SIGNAL_SEQUENCE: "ERR_RENDEZVOUS_SIGNAL_SEQUENCE";
  SIGNAL_CHAIN: "ERR_RENDEZVOUS_SIGNAL_CHAIN";
  REPLAYED: "ERR_RENDEZVOUS_REPLAYED";
  REPLAY_STORE_FULL: "ERR_RENDEZVOUS_REPLAY_STORE_FULL";
  REPLAY_STORE_FAILED: "ERR_RENDEZVOUS_REPLAY_STORE_FAILED";
  CLOCK_FAILED: "ERR_RENDEZVOUS_CLOCK_FAILED";
  SESSION_POLICY_REJECTED: "ERR_RENDEZVOUS_SESSION_POLICY_REJECTED";
  SESSION_CLOSED: "ERR_RENDEZVOUS_SESSION_CLOSED";
  HANDLER_FAILED: "ERR_RENDEZVOUS_HANDLER_FAILED";
}>;

export type RendezvousErrorCode =
  (typeof RENDEZVOUS_ERROR_CODES)[keyof typeof RENDEZVOUS_ERROR_CODES];

export class RendezvousError extends Error {
  constructor(message: string, options?: {
    code?: RendezvousErrorCode;
    phase?: string;
    retryable?: boolean;
    cause?: unknown;
  });
  readonly name: "RendezvousError";
  readonly code: RendezvousErrorCode;
  readonly phase: string;
  readonly retryable: boolean;
  readonly cause?: unknown;
}

export type ByteSource = ArrayBuffer | ArrayBufferView;
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CanonicalJsonOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
}

export function encodeBase64Url(value: ByteSource): string;
export function decodeBase64Url(value: string, options?: { maxBytes?: number }): Uint8Array;
export function encodeBase32(value: ByteSource): string;
export function decodeBase32(value: string, options?: { maxBytes?: number }): Uint8Array;
export function canonicalizeJson(value: JsonValue, options?: CanonicalJsonOptions): string;
export function canonicalizeJsonBytes(
  value: JsonValue,
  options?: CanonicalJsonOptions,
): Uint8Array;
export function parseCanonicalJson(
  input: string | ByteSource,
  options?: CanonicalJsonOptions,
): JsonValue;

export interface CryptoKeyLike {
  readonly type: "public" | "private" | "secret";
  readonly algorithm: { readonly name: string; [key: string]: unknown };
  readonly usages: readonly string[];
}

export interface SubtleCryptoLike {
  digest(algorithm: string, data: ByteSource): Promise<ArrayBuffer>;
  generateKey(
    algorithm: { name: "Ed25519" },
    extractable: boolean,
    usages: string[],
  ): Promise<{ publicKey: CryptoKeyLike; privateKey: CryptoKeyLike }>;
  exportKey(format: "raw", key: CryptoKeyLike): Promise<ArrayBuffer>;
  importKey(
    format: "raw",
    keyData: ByteSource,
    algorithm: { name: "Ed25519" },
    extractable: boolean,
    usages: string[],
  ): Promise<CryptoKeyLike>;
  sign(
    algorithm: { name: "Ed25519" },
    key: CryptoKeyLike,
    data: ByteSource,
  ): Promise<ArrayBuffer>;
  verify(
    algorithm: { name: "Ed25519" },
    key: CryptoKeyLike,
    signature: ByteSource,
    data: ByteSource,
  ): Promise<boolean>;
}

export interface CryptoProviderLike {
  readonly subtle: SubtleCryptoLike;
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

export interface CryptoOptions {
  crypto?: CryptoProviderLike;
}

/** `wn1-` plus the lowercase unpadded base32 SHA-256 digest of an Ed25519 public key. */
export type NodeID = string;

export interface NodeIdentity {
  readonly nodeId: NodeID;
  /** Canonical unpadded base64url raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly verificationKey?: CryptoKeyLike;
  readonly signingKey?: CryptoKeyLike;
  /** Structural signing hook for hardware keys and remote KMS implementations. */
  sign?(bytes: Uint8Array): ByteSource | Promise<ByteSource>;
}

export function nodeIdFromPublicKey(
  publicKey: string | ByteSource | CryptoKeyLike,
  options?: CryptoOptions,
): Promise<NodeID>;
export function verifyNodeId(
  nodeId: NodeID,
  publicKey: string | ByteSource | CryptoKeyLike,
  options?: CryptoOptions,
): Promise<true>;
export function createNodeIdentity(
  keyPair: { publicKey: CryptoKeyLike; privateKey: CryptoKeyLike },
  options?: CryptoOptions,
): Promise<NodeIdentity>;
export function generateNodeIdentity(
  options?: CryptoOptions & { extractable?: boolean },
): Promise<NodeIdentity>;

export type PrivacyMode =
  | "direct-preferred"
  | "relay-only"
  | "organization-only"
  | "offline-local";
export type SignalingVisibility = "rendezvous-visible";
export type WebRTCSessionRole = "offerer" | "answerer";

export interface AuthorizedChannel {
  label: string;
  protocol: string;
}

export interface ConnectionLimits {
  maxSignals: number;
  maxSignalBytes: number;
  maxSessionDurationMs: number;
}

export interface ConnectionCapabilityUnsigned {
  v: 1;
  type: "capability";
  id: string;
  issuer: NodeID;
  issuerPublicKey: string;
  subject: NodeID;
  audience: NodeID;
  sessionId: string;
  action: string;
  resource: string;
  applicationProtocol: string;
  channels: AuthorizedChannel[];
  privacy: PrivacyMode;
  signalingVisibility: SignalingVisibility;
  limits: ConnectionLimits;
  actor: string;
  onBehalfOf: string | null;
  serviceId: string;
  profile: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  singleUse: true;
}

export interface ConnectionCapability extends ConnectionCapabilityUnsigned {
  signature: string;
}

export interface ConnectionCapabilityClaims {
  id?: string;
  issuer?: NodeID;
  issuerPublicKey?: string;
  subject: NodeID;
  audience: NodeID;
  sessionId?: string;
  action: string;
  resource: string;
  applicationProtocol: string;
  channels: AuthorizedChannel[];
  privacy: PrivacyMode;
  signalingVisibility?: SignalingVisibility;
  limits: ConnectionLimits;
  actor: string;
  onBehalfOf: string | null;
  serviceId: string;
  profile: string;
  issuedAt?: number;
  notBefore?: number;
  expiresAt?: number;
  singleUse?: true;
}

export interface ClockOptions {
  now?: number | (() => number);
  clockSkewMs?: number;
}

export interface ReplayClaimStoreLike {
  claim(key: string, expiresAt: number, now?: number): boolean | Promise<boolean>;
}

export type ReplayReservationDisposition = "reserved" | "matched" | "conflict";

export interface ReplayStoreLike extends ReplayClaimStoreLike {
  /**
   * Atomically reserve value when key is absent, compare when it exists, and
   * retain the decision through expiresAt. A matched reservation does not by
   * itself restore authenticated-session chain state.
   */
  compareAndReserve(
    key: string,
    value: string,
    expiresAt: number,
    now?: number,
  ): ReplayReservationDisposition | Promise<ReplayReservationDisposition>;
}

export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(
    type: "abort",
    listener: (...args: any[]) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: (...args: any[]) => void): void;
}

export interface RendezvousPublishResult {
  accepted: true;
  duplicate: boolean;
  cursor?: string;
}

export interface RendezvousPublishOptions {
  /** Untrusted routing hint; the recipient still verifies signed envelope.to. */
  recipient: NodeID;
  idempotencyKey?: string;
  signal?: AbortSignalLike;
}

export interface RendezvousReceiveRequest {
  recipient: NodeID;
  cursor?: string;
  waitMs?: number;
  signal?: AbortSignalLike;
}

export interface RendezvousReceiveResult {
  /** Exact canonical UTF-8 records; verify before decoding into application state. */
  envelopes: Uint8Array[];
  cursor: string;
}

/** Replaceable signaling transport; authentication remains in signed records. */
export interface RendezvousTransport {
  publish(
    envelope: Uint8Array,
    options: RendezvousPublishOptions,
  ): Promise<RendezvousPublishResult>;
  receive(request: RendezvousReceiveRequest): Promise<RendezvousReceiveResult>;
  close?(): void | Promise<void>;
}

export interface CapabilityVerificationOptions extends CryptoOptions, ClockOptions {
  expectedIssuer?: NodeID;
  trustedIssuers?: Iterable<NodeID>;
  /** Explicitly disables issuer authorization; intended only for inspection/tests. */
  allowUntrustedIssuer?: boolean;
  expectedSubject?: NodeID;
  expectedAudience?: NodeID;
  expectedSessionId?: string;
  expectedAction?: string;
  expectedResource?: string;
  expectedApplicationProtocol?: string;
  expectedChannels?: AuthorizedChannel[];
  expectedPrivacy?: PrivacyMode;
  expectedSignalingVisibility?: SignalingVisibility;
  expectedLimits?: ConnectionLimits;
  expectedActor?: string;
  expectedOnBehalfOf?: string | null;
  expectedServiceId?: string;
  expectedProfile?: string;
  consume?: boolean;
  replayStore?: ReplayClaimStoreLike;
}

export interface VerifiedConnectionCapability {
  capability: Readonly<ConnectionCapability>;
  digest: string;
}

export function issueConnectionCapability(
  claims: ConnectionCapabilityClaims,
  issuerIdentity: NodeIdentity,
  options?: CryptoOptions & ClockOptions,
): Promise<Readonly<ConnectionCapability>>;
/** Already-decoded, policy-parametric primitive; prefer the byte verifier at wire edges. */
export function verifyConnectionCapability(
  value: unknown,
  options?: CapabilityVerificationOptions,
): Promise<Readonly<VerifiedConnectionCapability>>;
export function verifyConnectionCapabilityBytes(
  input: string | ByteSource,
  options?: CapabilityVerificationOptions,
): Promise<Readonly<VerifiedConnectionCapability>>;
export function serializeConnectionCapability(value: unknown): Uint8Array;
export function digestConnectionCapability(
  value: unknown,
  options?: CryptoOptions,
): Promise<string>;

export interface RTCSessionDescriptionSignal {
  type: "description";
  description: {
    type: "offer" | "answer";
    sdp: string;
  };
}

export interface RTCIceCandidateValue {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface RTCIceCandidateSignal {
  type: "candidate";
  candidate: RTCIceCandidateValue | null;
}

export type WebRTCSignalMessage = RTCSessionDescriptionSignal | RTCIceCandidateSignal;

export interface SignalEnvelopeUnsigned {
  v: 1;
  type: "signal";
  sessionId: string;
  capabilityDigest: string;
  from: NodeID;
  fromPublicKey: string;
  to: NodeID;
  role: WebRTCSessionRole;
  seq: number;
  prev: string | null;
  issuedAt: number;
  expiresAt: number;
  message: WebRTCSignalMessage;
}

export interface SignalEnvelope extends SignalEnvelopeUnsigned {
  signature: string;
}

export interface SignalEnvelopeFields {
  sessionId: string;
  capabilityDigest: string;
  to: NodeID;
  role: WebRTCSessionRole;
  seq: number;
  prev: string | null;
  issuedAt?: number;
  expiresAt?: number;
  message: WebRTCSignalMessage;
}

export interface SignalVerificationOptions extends CryptoOptions, ClockOptions {
  capability?: VerifiedConnectionCapability;
  /** Signature-only inspection; never grants authorization. */
  allowUnscoped?: boolean;
  maxSignalBytes?: number;
  expectedSessionId?: string;
  expectedCapabilityDigest?: string;
  expectedFrom?: NodeID;
  expectedTo?: NodeID;
  expectedRole?: WebRTCSessionRole;
  expectedSeq?: number;
  expectedPrev?: string | null;
  replayStore?: ReplayClaimStoreLike;
  consume?: boolean;
}

export interface VerifiedSignalEnvelope {
  envelope: Readonly<SignalEnvelope>;
  digest: string;
  message: Readonly<WebRTCSignalMessage>;
}

export interface AuthenticatedInboundSignal {
  envelope: Readonly<SignalEnvelope>;
  digest: string;
  message: Readonly<WebRTCSignalMessage> | null;
  duplicate: boolean;
}

export function createSignalEnvelope(
  fields: SignalEnvelopeFields,
  identity: NodeIdentity,
  options?: CryptoOptions & ClockOptions & { maxSignalBytes?: number },
): Promise<Readonly<SignalEnvelope>>;
/** Already-decoded primitive; session.inbound() is the stateful safe boundary. */
export function verifySignalEnvelope(
  value: unknown,
  options?: SignalVerificationOptions,
): Promise<Readonly<VerifiedSignalEnvelope>>;
export function verifySignalEnvelopeBytes(
  input: string | ByteSource,
  options?: SignalVerificationOptions,
): Promise<Readonly<VerifiedSignalEnvelope>>;
export function serializeSignalEnvelope(
  value: unknown,
  options?: { maxSignalBytes?: number },
): Uint8Array;
export function digestSignalEnvelope(
  value: unknown,
  options?: CryptoOptions & { maxSignalBytes?: number },
): Promise<string>;

export interface InMemoryReplayStoreOptions {
  maxEntries?: number;
  clock?: () => number;
}

export class InMemoryReplayStore implements ReplayStoreLike {
  constructor(options?: InMemoryReplayStoreOptions);
  readonly maxEntries: number;
  readonly size: number;
  prune(now?: number): number;
  has(key: string, now?: number): boolean;
  claim(key: string, expiresAt: number, now?: number): boolean;
  compareAndReserve(
    key: string,
    value: string,
    expiresAt: number,
    now?: number,
  ): ReplayReservationDisposition;
  clear(): void;
}

export interface AuthenticatedSignalContext {
  envelope: Readonly<SignalEnvelope>;
  digest: string;
  session: AuthenticatedSession;
}

export type AuthenticatedSignalHandler = (
  message: Readonly<WebRTCSignalMessage>,
  context: AuthenticatedSignalContext,
) => void | Promise<void>;

export interface SessionPolicyContext {
  privacy: PrivacyMode;
  signalingVisibility: SignalingVisibility;
  role: WebRTCSessionRole;
  localNodeId: NodeID;
  peerNodeId: NodeID;
  /** Earliest capability expiry or authorized maximum-session deadline. */
  deadline: number;
  capability: Readonly<ConnectionCapability>;
}

/**
 * Trusted integration assertion that the surrounding connection enforces the
 * signed privacy, channel, application, and lifetime policy. The integration
 * must arrange closure of the live data plane no later than `deadline`.
 * Returning anything except exactly true rejects session construction.
 */
export type SessionPolicyEnforcer = (
  context: Readonly<SessionPolicyContext>,
) => boolean | Promise<boolean>;

export interface AuthenticatedSessionBaseOptions extends CryptoOptions, ClockOptions {
  identity: NodeIdentity;
  peerNodeId: NodeID;
  role: WebRTCSessionRole;
  capability: ConnectionCapability;
  expectedIssuer?: NodeID;
  trustedIssuers?: Iterable<NodeID>;
  allowUntrustedIssuer?: boolean;
  sessionId: string;
  action: string;
  resource: string;
  applicationProtocol: string;
  channels: AuthorizedChannel[];
  privacy: PrivacyMode;
  signalingVisibility: SignalingVisibility;
  limits: ConnectionLimits;
  actor: string;
  onBehalfOf: string | null;
  serviceId: string;
  profile: string;
  enforceSessionPolicy: SessionPolicyEnforcer;
  maxReplayEntries?: number;
  clock?: () => number;
  onMessage?: AuthenticatedSignalHandler;
}

export type AuthenticatedSessionOptions = AuthenticatedSessionBaseOptions & (
  | {
      /** Recommended: claim the single-use capability in caller-owned shared state. */
      consumeCapability?: true;
      replayStore: ReplayStoreLike;
    }
  | {
      /** Development-only escape hatch; a local in-memory replay store may be created. */
      consumeCapability: false;
      replayStore?: ReplayClaimStoreLike;
    }
);

export interface AuthenticatedSession {
  readonly nodeId: NodeID;
  readonly peerNodeId: NodeID;
  readonly role: WebRTCSessionRole;
  readonly sessionId: string;
  /** Authorization deadline; the integration must also close its live data plane by this time. */
  readonly deadline: number;
  readonly capability: Readonly<ConnectionCapability>;
  readonly capabilityDigest: string;
  readonly replayStore: ReplayClaimStoreLike;
  readonly closed: boolean;
  readonly closeReason: string | null;
  readonly outboundSequence: number;
  readonly inboundSequence: number;
  outbound(
    message: WebRTCSignalMessage,
    options?: { now?: number | (() => number); ttlMs?: number },
  ): Promise<Readonly<SignalEnvelope>>;
  /** Canonical bytes are required at untrusted transport boundaries. */
  inbound(
    envelope: string | ByteSource,
    options?: { now?: number | (() => number); onMessage?: AuthenticatedSignalHandler },
  ): Promise<Readonly<AuthenticatedInboundSignal>>;
  /** Object input is for trusted in-memory composition only. */
  inbound(
    envelope: unknown,
    options?: { now?: number | (() => number); onMessage?: AuthenticatedSignalHandler },
  ): Promise<Readonly<AuthenticatedInboundSignal>>;
  /** Prevents in-flight operations from committing session cursors after their current await. */
  close(reason?: string): boolean;
}

export function createAuthenticatedSession(
  options: AuthenticatedSessionOptions,
): Promise<Readonly<AuthenticatedSession>>;
