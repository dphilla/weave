# `@weave-net/ws-tcp-gateway`

A dependency-free, byte-transparent bridge between a normalized binary
WebSocket endpoint and a Node stream-like duplex. It contains no routing,
static serving, TCP dialing, WebSocket handshake, or application-protocol
logic, so the bridge can carry any ordered byte stream.

The package requires Node.js 18 or newer and is licensed under Apache-2.0.

## Install

```sh
npm install @weave-net/ws-tcp-gateway
```

Registry publication is not automated yet. From this checkout, create the same
installable artifact with `npm pack --workspace @weave-net/ws-tcp-gateway`,
then install the resulting `.tgz`.

## API

```js
import { bridgeWebSocketToDuplex } from "@weave-net/ws-tcp-gateway";

const bridge = bridgeWebSocketToDuplex(websocketEndpoint, duplex, {
  label: "upload-42",
  closeTimeoutMs: 2_000,
  onError(error, { label, side }) {
    console.error(label, side, error);
  },
});

// Later, if the owner wants to stop the bridge explicitly:
bridge.close(1001, "gateway shutting down");
```

`bridgeWebSocketToDuplex()` returns:

- `closed`: whether shutdown has begun;
- `close(code = 1000, reason = "bridge closed")`: closes both endpoints and
  returns `true` only for the call that initiated shutdown.

Construction gives the bridge ownership of both endpoint lifecycles. A close,
end, or error from either side closes the other side. Duplex shutdown is
graceful first (`end()`), then forced with `destroy()` after `closeTimeoutMs`.
A duplex-side error is destroyed immediately. The default timeout is 2000 ms;
zero requests immediate destruction. Timers are unreferenced when the runtime
supports it.

Cleanup is idempotent: the binary handler and every listener installed by the
bridge are removed when shutdown begins. Exceptions thrown by `onError` are
suppressed so diagnostics cannot interrupt cleanup.

## Normalized binary-WebSocket contract

Concrete WebSocket libraries use incompatible event and backpressure APIs.
Callers provide a small adapter with this shape:

```ts
interface BinaryWebSocketEndpoint {
  readonly closed: boolean;
  once(event: "close" | "error" | "drain", listener: Function): unknown;
  off(event: "close" | "error" | "drain", listener: Function): unknown;
  setBinaryHandler(handler: ((bytes: Uint8Array) => boolean | void) | null): void;
  resumeIncoming(): void;
  sendBinary(bytes: Uint8Array): boolean;
  close(code?: number, reason?: string): unknown;
}
```

The adapter must:

- invoke the installed handler only for binary data;
- pause further incoming binary delivery when the handler returns `false`;
- resume that delivery when `resumeIncoming()` is called;
- return `false` from `sendBinary()` when outgoing WebSocket data is
  backpressured;
- emit `drain` when `sendBinary()` can proceed again;
- make `close()` and the `closed` flag idempotent.

The duplex must provide the usual Node stream methods/events used by the
published `DuplexEndpoint` type: `data`, `drain`, `end`, `close`, `error`,
`write`, `pause`, `resume`, `end`, and `destroy`.

## Backpressure and byte semantics

WebSocket-to-duplex backpressure is propagated by returning the result of
`duplex.write()` from the binary handler. When the duplex emits `drain`, the
bridge calls `resumeIncoming()`.

Duplex-to-WebSocket backpressure pauses the duplex whenever `sendBinary()`
returns false. A WebSocket `drain` event resumes it.

Payloads are passed through without encoding, decoding, framing, or copying.
One incoming WebSocket message produces one duplex write, and one duplex data
chunk produces one outgoing binary message. Applications must treat the result
as a byte stream: neither TCP nor other Node duplex streams preserve those
chunk boundaries end to end.

`onError(error, { label, side })` identifies failures as originating from
`"websocket"` or `"duplex"`. Manual and ordinary close/end events are not
reported as errors.
