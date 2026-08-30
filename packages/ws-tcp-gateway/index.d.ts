export type GatewaySide = "websocket" | "duplex";

export interface GatewayErrorContext {
  label: string;
  side: GatewaySide;
}

export type BinaryHandler = (bytes: Uint8Array) => boolean | void;
export type EventListener = (...args: any[]) => void;

/**
 * A normalized, binary-only WebSocket endpoint. Adapters for concrete
 * WebSocket implementations must pause incoming binary delivery whenever the
 * installed handler returns false, then continue after resumeIncoming().
 */
export interface BinaryWebSocketEndpoint {
  readonly closed: boolean;
  once(event: "close" | "error" | "drain", listener: EventListener): unknown;
  off(event: "close" | "error" | "drain", listener: EventListener): unknown;
  setBinaryHandler(handler: BinaryHandler | null): void;
  resumeIncoming(): void;
  sendBinary(bytes: Uint8Array): boolean;
  close(code?: number, reason?: string): unknown;
}

/** The subset of a Node Duplex stream used by the gateway core. */
export interface DuplexEndpoint {
  readonly destroyed?: boolean;
  on(event: "data", listener: (bytes: Uint8Array) => void): unknown;
  once(event: "drain" | "end" | "close", listener: EventListener): unknown;
  once(event: "error", listener: (error: unknown) => void): unknown;
  off(event: "data" | "drain" | "end" | "close" | "error", listener: EventListener): unknown;
  write(bytes: Uint8Array): boolean;
  pause(): unknown;
  resume(): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
}

export interface BridgeOptions {
  /** Diagnostic label passed to onError. */
  label?: string;
  /** Grace period before a duplex that was ended is forcibly destroyed. Default: 2000. */
  closeTimeoutMs?: number;
  /** Receives endpoint and bridge-operation failures. Observer exceptions are suppressed. */
  onError?: (error: Error, context: GatewayErrorContext) => void;
}

export interface BridgeController {
  /** True once shutdown has begun, whether locally or from either endpoint. */
  readonly closed: boolean;
  /**
   * Close both endpoints. Returns true only for the call that initiated
   * shutdown; subsequent calls return false.
   */
  close(code?: number, reason?: string): boolean;
}

export const DEFAULT_CLOSE_TIMEOUT_MS: 2000;

export function bridgeWebSocketToDuplex(
  websocket: BinaryWebSocketEndpoint,
  duplex: DuplexEndpoint,
  options?: BridgeOptions,
): BridgeController;
