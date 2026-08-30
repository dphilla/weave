# `@weave-net/node-transports`

Dependency-free, bounded TCP byte-stream primitives for Node.js 18 and newer.
The package is application-protocol neutral: it moves bytes and does not parse
or impose framing on them.

## Install

```sh
npm install @weave-net/node-transports
```

## Connect and exchange bytes

```js
import { connectTcp } from "@weave-net/node-transports";

const stream = await connectTcp("127.0.0.1", 9000, {
  connectTimeoutMs: 5_000,
  maxBufferedBytes: 8 * 1024 * 1024,
  pauseBytes: 6 * 1024 * 1024,
  resumeBytes: 3 * 1024 * 1024,
});

try {
  await stream.write(Uint8Array.of(0x01, 0x02));
  const fourByteHeader = await stream.readExact(4);
} finally {
  stream.close();
}
```

`readExact(size)` coalesces multiple TCP chunks or splits a larger chunk so it
always resolves with exactly `size` bytes. Applications remain responsible for
their own record or message framing.

Transport settings may also be grouped under `transportOptions`. If a setting
is present in both places, the nested value takes precedence.

## Accept an existing socket

```js
import net from "node:net";
import { TcpTransport } from "@weave-net/node-transports";

const server = net.createServer(async (socket) => {
  const stream = new TcpTransport(socket);
  const kind = await stream.readExact(1);
  // Dispatch or continue parsing the application protocol.
});

server.listen(9000, "127.0.0.1");
```

## Classify without consuming

`readFirstSocketByte(socket, timeoutMs)` waits for one byte, restores it to the
socket with `unshift()`, and returns its numeric value. This is useful when one
listener accepts several protocols and a later handler must still see the full
stream.

```js
import { readFirstSocketByte, TcpTransport } from "@weave-net/node-transports";

const discriminator = await readFirstSocketByte(socket, 2_000);
const stream = new TcpTransport(socket);
const sameByte = await stream.readExact(1);
```

## Bounds and lifecycle

The defaults are deliberately finite:

| Setting | Default |
| --- | ---: |
| Maximum unread input | 72 MiB |
| Pause threshold | 64 MiB |
| Resume threshold | 32 MiB |
| Connect timeout | 10 seconds |
| Read timeout | 120 seconds |
| Write timeout | 120 seconds |
| Classification timeout | 15 seconds |

The socket pauses at the high-water mark and resumes after buffered input falls
to the low-water mark. Crossing the hard cap or reaching an I/O timeout is a
terminal failure and destroys the socket. `close()` also destroys the socket;
it is intentionally not a graceful TCP half-close operation.

Choose limits for the largest record your protocol permits. A single
`readExact(size)` request cannot exceed `maxBufferedBytes`.

## API

- `new TcpTransport(socket, options)` wraps an accepted or connected
  `node:net` socket.
- `connectTcp(host, port, options)` dials with a deadline and returns a
  `TcpTransport`.
- `readFirstSocketByte(socket, timeoutMs)` peeks and restores a leading byte.
- Exported `DEFAULT_*` constants expose every default deadline and the hard
  receive-buffer limit.

TypeScript declarations are included. The package has no runtime dependencies
and is licensed under Apache-2.0.
