# `@weave-net/browser-transports`

Dependency-free browser adapters that expose WebSocket and reliable,
ordered RTCDataChannel connections as continuous byte streams.

The package is application-neutral. It does not select a WebSocket
subprotocol, establish a WebRTC peer connection, perform signaling, or impose
an application framing protocol.

## Install

```sh
npm install @weave-net/browser-transports
```

The source is ESM and relies only on browser APIs. Node 18 or newer is the
supported floor for running its tests and compatible injected transports.

## Byte-stream contract

Both adapters provide:

```ts
interface ExactByteStream {
  opened: Promise<this>;
  closed: Promise<CloseInfo>;
  readExact(size: number): Promise<Uint8Array>;
  write(bytes: ArrayBuffer | ArrayBufferView): Promise<void>;
}
```

Inbound message boundaries are erased. A read can span several messages or
consume only part of one message. Concurrent writes are serialized, and each
write copies its input before returning so later caller mutation is harmless.

Applications must add their own framing if records or messages need to be
recovered from the byte stream.

## WebSocket

```js
import { connectWebSocket } from "@weave-net/browser-transports";

// No WebSocket subprotocol is requested by default.
const stream = await connectWebSocket("wss://example.test/stream");

await stream.write(new Uint8Array([0, 0, 0, 3, 1, 2, 3]));
const header = await stream.readExact(4);
```

Pass a subprotocol explicitly when the application requires one:

```js
const stream = await connectWebSocket(url, {
  protocols: ["example.stream.v1"],
});
```

`protocols` omitted, `null`, `""`, or `[]` all mean “construct the WebSocket
without a subprotocol argument.” `WebSocketByteStream` can also wrap an
existing open or connecting WebSocket.

Only binary messages are accepted. Receiving text fails the stream and closes
the WebSocket with status 1003.

## RTCDataChannel

```js
import { RTCDataChannelByteStream } from "@weave-net/browser-transports";

const channel = peerConnection.createDataChannel("application-data", {
  ordered: true,
});

const stream = new RTCDataChannelByteStream(channel, {
  requiredProtocol: "example.stream.v1",
});

await stream.opened;
await stream.write(payload);
```

The adapter accepts only ordered, fully reliable DataChannels. It rejects
channels configured with `ordered: false`, `maxRetransmits`, or
`maxPacketLifeTime`, because those settings cannot provide exact byte-stream
semantics.

Protocol validation is opt-in. Omitting `requiredProtocol`, or setting it to
`null`, accepts any `channel.protocol`. Supplying a string requires an exact
match.

Logical writes are fragmented into 16 KiB messages by default. Set
`maxMessageSize` from `RTCSctpTransport.maxMessageSize` when it is available;
the adapter clamps its chunks to that negotiated ceiling. This package handles
application data only—it is not an RTP/media-track abstraction.

## Resource and lifecycle policy

| Option | Default | Meaning |
| --- | ---: | --- |
| `maxBufferedBytes` | 72 MiB | Maximum unread inbound bytes |
| `maxWriteBytes` | 64 MiB | Maximum one logical write |
| `highWaterMark` | 1 MiB | Pause output above `bufferedAmount` |
| `drainTimeoutMs` | 120 s | Maximum output backpressure wait; `0` disables |
| WebSocket `connectTimeoutMs` | 15 s | Maximum handshake wait; `0` disables |
| DataChannel `connectTimeoutMs` | 30 s | Maximum channel-open wait; `0` disables |
| DataChannel `closeTimeoutMs` | 5 s | Maximum asynchronous close wait; `0` disables |
| DataChannel `maxChunkBytes` | 16 KiB | Maximum outbound SCTP message |

The receive limit is checked before new data is made available to readers.
`readExact(size)` rejects immediately when `size` exceeds
`maxBufferedBytes`, because such a read can never be satisfied without
violating the configured bound.

`AbortSignal` can govern the lifetime of either adapter. Aborting fails pending
operations with `AbortError` and closes the underlying transport.

`opened` resolves when the transport opens and rejects if it fails first.
`closed` always resolves as a lifecycle notification; the close information
contains the terminal error. Reads and writes surface that error directly.

## Development

```sh
node --test
```

The package has no runtime dependencies and is licensed under Apache-2.0.
