export const DEFAULT_MAX_BUFFERED_BYTES: number;
export const DEFAULT_MAX_WRITE_BYTES: number;

export type ByteSource = ArrayBuffer | ArrayBufferView;
export type TransportEventListener = (...args: any[]) => void;

export interface DOMEventTargetLike {
  addEventListener(type: string, listener: TransportEventListener): void;
  removeEventListener(type: string, listener: TransportEventListener): void;
}

export interface EventEmitterLike {
  on(type: string, listener: TransportEventListener): void;
  off(type: string, listener: TransportEventListener): void;
}

export type EventTargetLike = DOMEventTargetLike | EventEmitterLike;

export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: TransportEventListener,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: TransportEventListener): void;
}

export interface ExactByteStream {
  readonly opened: Promise<this>;
  readonly closed: Promise<unknown>;
  readonly bufferedBytes: number;
  readonly error: Error | null;
  readExact(size: number): Promise<Uint8Array>;
  write(bytes: ByteSource): Promise<void>;
}

export interface ByteStreamOptions {
  /** Maximum unread inbound bytes. Defaults to 72 MiB. */
  maxBufferedBytes?: number;
  /** Maximum bytes per logical write, checked before copying input. Defaults to 64 MiB. */
  maxWriteBytes?: number;
  /** Output bufferedAmount threshold. Defaults to 1 MiB. */
  highWaterMark?: number;
  /** Maximum output backpressure wait; zero disables. Defaults to 120 seconds. */
  drainTimeoutMs?: number;
  /** Abort the stream and close its transport when signaled. */
  signal?: AbortSignalLike;
}

export type WebSocketLike = EventTargetLike & {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: ByteSource): void;
  close(code?: number, reason?: string): void;
};

export interface WebSocketConstructor {
  new(url: string | URL, protocols?: string | string[]): WebSocketLike;
}

export interface WebSocketByteStreamOptions extends ByteStreamOptions {
  /** Maximum handshake wait; zero disables. Defaults to 15 seconds. */
  connectTimeoutMs?: number;
}

export interface ConnectWebSocketOptions extends WebSocketByteStreamOptions {
  /** No protocol is requested when omitted, null, an empty string, or an empty array. */
  protocols?: string | string[] | null;
  /** Constructor injection for compatible environments and tests. */
  WebSocket?: WebSocketConstructor;
}

export interface WebSocketCloseInfo {
  code: number;
  reason: string;
  error: Error | null;
}

export class WebSocketByteStream implements ExactByteStream {
  constructor(socket: WebSocketLike, options?: WebSocketByteStreamOptions);

  readonly socket: WebSocketLike;
  readonly maxBufferedBytes: number;
  readonly maxWriteBytes: number;
  readonly highWaterMark: number;
  readonly drainTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly opened: Promise<this>;
  readonly closed: Promise<WebSocketCloseInfo>;
  readonly bufferedBytes: number;
  readonly error: Error | null;

  readExact(size: number): Promise<Uint8Array>;
  write(bytes: ByteSource): Promise<void>;
  close(code?: number, reason?: string): Promise<WebSocketCloseInfo>;
}

export function connectWebSocket(
  url: string | URL,
  options?: ConnectWebSocketOptions,
): Promise<WebSocketByteStream>;

export type RTCDataChannelLike = EventTargetLike & {
  readonly readyState: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly protocol: string;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: string;
  send(data: ByteSource): void;
  close(): void;
};

export interface RTCDataChannelByteStreamOptions extends ByteStreamOptions {
  /** Maximum bytes per DataChannel message. Defaults to 16 KiB. */
  maxChunkBytes?: number;
  /** Negotiated SCTP ceiling; null, zero, or Infinity means unknown/unbounded. */
  maxMessageSize?: number | null;
  /** Maximum channel-close wait; zero disables. Defaults to 5 seconds. */
  closeTimeoutMs?: number;
  /** Maximum channel-open wait; zero disables. Defaults to 30 seconds. */
  connectTimeoutMs?: number;
  /**
   * Validate channel.protocol against this value. Omitted or null disables
   * validation; the adapter never selects an application protocol itself.
   */
  requiredProtocol?: string | null;
}

export interface RTCDataChannelCloseInfo {
  error: Error | null;
}

export class RTCDataChannelByteStream implements ExactByteStream {
  constructor(
    channel: RTCDataChannelLike,
    options?: RTCDataChannelByteStreamOptions,
  );

  readonly channel: RTCDataChannelLike;
  readonly maxBufferedBytes: number;
  readonly maxWriteBytes: number;
  readonly maxChunkBytes: number;
  readonly highWaterMark: number;
  readonly drainTimeoutMs: number;
  readonly closeTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly opened: Promise<this>;
  readonly closed: Promise<RTCDataChannelCloseInfo>;
  readonly bufferedBytes: number;
  readonly error: Error | null;

  readExact(size: number): Promise<Uint8Array>;
  write(bytes: ByteSource): Promise<void>;
  close(): Promise<RTCDataChannelCloseInfo>;
}
