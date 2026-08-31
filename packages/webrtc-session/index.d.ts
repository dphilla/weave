export const DEFAULT_CONNECT_TIMEOUT_MS: 30000;
export const DEFAULT_MAX_PENDING_CANDIDATES: 256;
export const DEFAULT_MAX_SDP_BYTES: 262144;
export const DEFAULT_MAX_CANDIDATE_BYTES: 16384;

export type WebRTCSessionRole = "offerer" | "answerer";
export type WebRTCSessionState =
  | "new"
  | "starting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";
export type DataChannelOrigin = "local" | "remote";

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

export interface RTCSessionDescriptionInitLike {
  type: "offer" | "answer";
  sdp: string;
}

export type RTCSdpTypeLike = "offer" | "answer" | "pranswer" | "rollback";

export interface RTCSessionDescriptionValueLike {
  type: RTCSdpTypeLike;
  sdp?: string;
}

export interface RTCSessionDescriptionLike {
  readonly type: RTCSdpTypeLike;
  readonly sdp: string;
  toJSON?(): RTCSessionDescriptionValueLike;
}

export interface RTCIceCandidateInitLike {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface RTCIceCandidateValueLike {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface RTCIceCandidateLike extends RTCIceCandidateInitLike {
  toJSON?(): RTCIceCandidateValueLike;
}

export type WebRTCSessionSignal =
  | { type: "description"; description: RTCSessionDescriptionInitLike }
  | { type: "candidate"; candidate: RTCIceCandidateInitLike | null };

export interface RTCDataChannelInitLike {
  ordered?: boolean;
  maxPacketLifeTime?: number;
  maxRetransmits?: number;
  protocol?: string;
  negotiated?: boolean;
  id?: number;
  priority?: "very-low" | "low" | "medium" | "high";
}

export type RTCDataChannelSendData = string | ArrayBuffer | ArrayBufferView;

export interface RTCDataChannelLike {
  readonly label: string;
  readonly negotiated: boolean;
  readonly id: number | null;
  readonly ordered: boolean;
  readonly maxPacketLifeTime: number | null;
  readonly maxRetransmits: number | null;
  readonly protocol: string;
  readonly readyState: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  addEventListener(type: string, listener: RTCEventListener): void;
  removeEventListener(type: string, listener: RTCEventListener): void;
  send(data: RTCDataChannelSendData): void;
  close(): void;
}

export type RTCEventListener = (event: any) => void;

export interface RTCStatsLike {
  id?: string;
  type?: string;
  [field: string]: unknown;
}

export interface RTCStatsReportLike {
  get(id: string): RTCStatsLike | undefined;
  values(): IterableIterator<RTCStatsLike>;
}

export interface RTCPeerConnectionLike {
  readonly connectionState?: string;
  readonly iceConnectionState?: string;
  readonly localDescription?: RTCSessionDescriptionLike | null;
  readonly remoteDescription?: RTCSessionDescriptionLike | null;
  readonly sctp?: { readonly maxMessageSize?: number } | null;
  addEventListener(type: string, listener: RTCEventListener): void;
  removeEventListener(type: string, listener: RTCEventListener): void;
  createOffer(): Promise<RTCSessionDescriptionValueLike>;
  createAnswer(): Promise<RTCSessionDescriptionValueLike>;
  setLocalDescription(description: RTCSessionDescriptionValueLike): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInitLike): Promise<void>;
  addIceCandidate(candidate: RTCIceCandidateValueLike | null): Promise<void>;
  createDataChannel(label: string, init?: RTCDataChannelInitLike): RTCDataChannelLike;
  /** Required only when this object is passed to getSelectedCandidatePath(). */
  getStats?(): Promise<RTCStatsReportLike>;
  close(): void;
}

export interface RTCPeerConnectionConstructorLike {
  new(configuration?: any): RTCPeerConnectionLike;
}

/** Passed through unchanged to the injected or global RTCPeerConnection. */
export type RTCConfigurationLike = object;

export interface WebRTCSessionErrorOptions {
  code?: string;
  phase?: string;
  cause?: unknown;
}

export class WebRTCSessionError extends Error {
  constructor(message: string, options?: WebRTCSessionErrorOptions);
  readonly name: "WebRTCSessionError";
  readonly code: string;
  readonly phase: string;
  readonly cause?: unknown;
}

export interface SignalSendContext {
  signal: AbortSignalLike;
}

export interface DataChannelContext {
  origin: DataChannelOrigin;
  session: WebRTCSession;
}

export interface StateChangeInfo {
  state: WebRTCSessionState;
  connectionState: string;
  iceConnectionState: string;
  session: WebRTCSession;
}

export interface IceCandidateErrorContext {
  session: WebRTCSession;
}

export interface SessionErrorContext {
  fatal: boolean;
  phase: string;
  session: WebRTCSession;
}

export interface WebRTCSessionOptions {
  role: WebRTCSessionRole;
  rtcConfiguration?: RTCConfigurationLike;
  sendSignal(
    message: WebRTCSessionSignal,
    context: SignalSendContext,
  ): void | Promise<void>;
  /** Constructor injection for compatible WebRTC implementations and tests. */
  RTCPeerConnection?: RTCPeerConnectionConstructorLike;
  signal?: AbortSignalLike;
  /** Overall deadline to reach connected; zero disables. Default: 30000. */
  connectTimeoutMs?: number;
  /** Maximum queued local or remote candidates. Default: 256. */
  maxPendingCandidates?: number;
  /** Maximum UTF-8 bytes in an SDP string. Default: 256 KiB. */
  maxSdpBytes?: number;
  /** Maximum serialized bytes in one ICE candidate. Default: 16 KiB. */
  maxCandidateBytes?: number;
  onDataChannel?(channel: RTCDataChannelLike, context: DataChannelContext): void;
  onStateChange?(info: StateChangeInfo): void;
  onIceCandidateError?(event: unknown, context: IceCandidateErrorContext): void;
  onError?(error: Error, context: SessionErrorContext): void;
}

export interface WebRTCSessionCloseInfo {
  reason: "closed" | "failed";
  error: Error | null;
}

export interface SelectedCandidatePath {
  relayed: boolean;
  protocol: string;
  localCandidateType: string;
  remoteCandidateType: string;
}

export class WebRTCSession {
  constructor(options: WebRTCSessionOptions);

  readonly role: WebRTCSessionRole;
  readonly peerConnection: RTCPeerConnectionLike;
  readonly channels: ReadonlyMap<string, RTCDataChannelLike>;
  readonly connectTimeoutMs: number;
  readonly maxPendingCandidates: number;
  readonly maxSdpBytes: number;
  readonly maxCandidateBytes: number;
  readonly connected: Promise<this>;
  readonly closed: Promise<WebRTCSessionCloseInfo>;
  readonly started: boolean;
  readonly state: WebRTCSessionState;
  readonly error: Error | null;

  channel(label: string): RTCDataChannelLike | undefined;
  createDataChannel(label: string, init?: RTCDataChannelInitLike): RTCDataChannelLike;
  start(): Promise<this>;
  receiveSignal(message: unknown): Promise<void>;
  /** Fail the session. Returns true only for the call that began shutdown. */
  fail(error: unknown): boolean;
  /** Close normally. Repeated calls return the same always-resolving promise. */
  close(): Promise<WebRTCSessionCloseInfo>;
}

export function getSelectedCandidatePath(
  peerConnectionOrSession: RTCPeerConnectionLike | WebRTCSession,
): Promise<SelectedCandidatePath | null>;
