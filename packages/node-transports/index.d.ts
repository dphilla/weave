import type { Socket, TcpNetConnectOpts } from "node:net";

export const DEFAULT_MAX_TCP_BUFFERED_BYTES: number;
export const DEFAULT_TCP_CONNECT_TIMEOUT_MS: number;
export const DEFAULT_TCP_READ_TIMEOUT_MS: number;
export const DEFAULT_TCP_WRITE_TIMEOUT_MS: number;
export const DEFAULT_SOCKET_CLASSIFICATION_TIMEOUT_MS: number;

export interface TcpTransportOptions {
  /** Hard limit for unread bytes retained in memory. Default: 72 MiB. */
  maxBufferedBytes?: number;
  /** Soft pause threshold; incomplete exact reads override it. Default: 64 MiB. */
  pauseBytes?: number;
  /** Resume at this low-water mark, or when an exact read needs input. Default: 32 MiB. */
  resumeBytes?: number;
  /** Deadline for each exact read, in milliseconds. Default: 120000. */
  readTimeoutMs?: number;
  /** Deadline for each write callback, in milliseconds. Default: 120000. */
  writeTimeoutMs?: number;
}

export interface ConnectTcpOptions extends TcpTransportOptions {
  /** Deadline for establishing the TCP connection, in milliseconds. Default: 10000. */
  connectTimeoutMs?: number;
  /** Override socket construction, primarily for custom dialers and tests. */
  dial?: (options: TcpNetConnectOpts) => Socket;
  /**
   * Buffer and I/O settings for the returned transport. These override the
   * corresponding flat options when both forms are supplied.
   */
  transportOptions?: TcpTransportOptions;
}

/** A bounded exact-read byte stream backed by a Node TCP socket. */
export class TcpTransport {
  constructor(socket: Socket, options?: TcpTransportOptions);

  /** The underlying Node TCP socket. */
  socket: Socket;
  maxBufferedBytes: number;
  pauseBytes: number;
  resumeBytes: number;
  readTimeoutMs: number;
  writeTimeoutMs: number;

  /** Read exactly `size` bytes, regardless of TCP chunk boundaries. */
  readExact(size: number): Promise<Uint8Array>;
  /** Write the complete byte sequence or reject on socket failure or timeout. */
  write(bytes: Uint8Array): Promise<void>;
  /** Destroy the socket. */
  close(): void;
}

/**
 * Peek at and restore the first byte of a socket, rejecting on timeout or
 * premature close. Default timeout: 15000 ms.
 */
export function readFirstSocketByte(socket: Socket, timeoutMs?: number): Promise<number>;

/** Dial a TCP endpoint and wrap the connected socket in a bounded transport. */
export function connectTcp(
  host: string,
  port: number,
  options?: ConnectTcpOptions,
): Promise<TcpTransport>;
