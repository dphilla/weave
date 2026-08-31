// Weave-specific compatibility entry point for browser transports. The
// byte-stream implementations are application-neutral and live in the
// installable @weave-net/browser-transports workspace package.

import {
  RTCDataChannelByteStream as GenericRTCDataChannelByteStream,
  WebSocketByteStream as GenericWebSocketByteStream,
} from "../packages/browser-transports/src/index.mjs";

export const WEAVE_WEBSOCKET_PROTOCOL = "weave.v2";
export const WEAVE_DATA_CHANNEL_PROTOCOL = "weave.v2";

const WEAVE_MAX_BUFFERED_BYTES = 72 * 1024 * 1024;
const WEAVE_MAX_WRITE_BYTES = 64 * 1024 * 1024 + 5;

/** Adapt a WebSocket while retaining Weave's frame-sized resource defaults. */
export class WebSocketByteStream extends GenericWebSocketByteStream {
  constructor(socket, options = {}) {
    super(socket, {
      ...options,
      maxBufferedBytes: options.maxBufferedBytes ?? WEAVE_MAX_BUFFERED_BYTES,
      maxWriteBytes: options.maxWriteBytes ?? WEAVE_MAX_WRITE_BYTES,
    });
  }
}

/** Open a WebSocket with the Weave v2 subprotocol unless explicitly disabled. */
export async function connectWebSocket(url, options = {}) {
  const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
  if (typeof WebSocketCtor !== "function") {
    throw new Error("this environment does not provide WebSocket");
  }
  const protocols = Object.prototype.hasOwnProperty.call(options, "protocols")
    ? options.protocols
    : [WEAVE_WEBSOCKET_PROTOCOL];
  const hasProtocols = protocols !== undefined
    && protocols !== null
    && protocols !== ""
    && (!Array.isArray(protocols) || protocols.length > 0);
  const socket = hasProtocols
    ? new WebSocketCtor(url, protocols)
    : new WebSocketCtor(url);
  const stream = new WebSocketByteStream(socket, options);
  await stream.opened;
  return stream;
}

/**
 * Adapt a reliable, ordered DataChannel and require weave.v2 unless callers
 * explicitly set requiredProtocol (including null to disable validation).
 */
export class RTCDataChannelByteStream extends GenericRTCDataChannelByteStream {
  constructor(channel, options = {}) {
    const requiredProtocol = Object.prototype.hasOwnProperty.call(options, "requiredProtocol")
      ? options.requiredProtocol
      : WEAVE_DATA_CHANNEL_PROTOCOL;
    super(channel, {
      ...options,
      requiredProtocol,
      maxBufferedBytes: options.maxBufferedBytes ?? WEAVE_MAX_BUFFERED_BYTES,
      maxWriteBytes: options.maxWriteBytes ?? WEAVE_MAX_WRITE_BYTES,
    });
  }
}

function relayUrl(baseUrl, route, options) {
  const base = new URL(baseUrl, globalThis.location?.href);
  if (base.protocol === "http:") base.protocol = "ws:";
  else if (base.protocol === "https:") base.protocol = "wss:";
  if (base.protocol !== "ws:" && base.protocol !== "wss:") {
    throw new TypeError("relay URL must use http(s) or ws(s)");
  }
  base.pathname = route;
  base.search = "";
  base.hash = "";
  if (options.token) base.searchParams.set("token", options.token);
  return base.href;
}

/** Connect a browser source to a named TCP target configured on the relay. */
export function connectRelay(baseUrl, target, options = {}) {
  if (!target || target.includes("/")) throw new TypeError("invalid relay target name");
  const url = relayUrl(baseUrl, `/v1/connect/${encodeURIComponent(target)}`, options);
  return connectWebSocket(url, options);
}

/** Register a browser target to accept the relay's next TCP ingress peer. */
export function acceptRelay(baseUrl, options = {}) {
  const url = relayUrl(baseUrl, "/v1/accept", options);
  return connectWebSocket(url, options);
}
