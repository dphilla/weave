# WebRTC TCP sidecar

`weave-rtc` is a standalone, application-neutral bridge between local
loopback TCP byte streams and reliable, ordered WebRTC DataChannels. A
supervisor controls one WebRTC peer connection over strict NDJSON on standard
input and standard output; application bytes never share that control stream.

```text
local process <-- loopback TCP --> weave-rtc === WebRTC === weave-rtc <-- loopback TCP --> local process
                                      ^                         ^
                                      +-- external signaling ---+
```

The module has no dependency on a Weave runtime or wire format. It can be
built, embedded, and versioned independently as
`github.com/dphilla/weave/sidecars/webrtc`.

## Requirements, build, and test

- Go 1.24 or newer
- [Pion WebRTC v4](https://github.com/pion/webrtc), pinned by `go.mod`

From this directory:

```sh
go test ./...
go test -race ./...
go build -o weave-rtc ./cmd/weave-rtc
```

The binary accepts no flags. It reads protocol records from stdin, writes only
protocol records to stdout, and reserves stderr for `weave-rtc: <code>` or the
generic `weave-rtc: internal sidecar failure` when the control stream itself
fails. `SIGINT` and `SIGTERM` cancel the session. A normal close exits zero; a
terminal protocol, signaling, WebRTC, or bridge failure exits nonzero.

## Process and data model

Version 1 deliberately has a small, fixed shape:

- One process owns one `RTCPeerConnection`.
- A successful `start` declares 1 through 8 fixed channel mappings.
- The offerer creates all DataChannels in-band. Each is ordered and fully
  reliable. The answerer accepts only the configured labels and protocols.
- Each mapping bridges one DataChannel to one local TCP connection.
- A mapping either listens on a literal loopback address or dials one.
- Mappings have independent lifecycles. Closing one does not close the others.
  The process ends when every mapping is terminal, the peer connection fails,
  or the supervisor closes or cancels the session.
- Mapping names are local control-plane identifiers. The DataChannel `label`
  and `protocol` are the values that must agree between peers.

The supervisor is responsible for carrying `signal` events from each sidecar
to `signal` commands on the other. This package does not choose or operate a
signaling transport.

## Control protocol

The protocol name is `webrtc-sidecar.control.v1`; every request has `"v":1`.
Each record is one JSON object followed by LF. CRLF is also accepted. Examples
below may be formatted for readability, but each object is a single line on
the wire.

The decoder is intentionally strict:

- A record is at most 1 MiB, excluding LF and one optional CR.
- Input must be valid UTF-8 and newline-terminated. Blank records are invalid.
- Duplicate object members, trailing JSON, and unknown command fields are
  rejected, including unknown nested configuration fields.
- JSON `null` is rejected instead of being coerced to a scalar default, except
  for `signal.message.candidate` as the end marker and the browser-defined
  nullable candidate members `sdpMid`, `sdpMLineIndex`, and
  `usernameFragment`.
- Request IDs match `[A-Za-z0-9._:-]{1,64}`, are unique for the lifetime of the
  process, and are capped at 4096 total IDs. An ID is consumed even when its
  otherwise parseable request is rejected.
- Protocol-version errors, malformed JSON, invalid UTF-8, invalid IDs, blank
  records, unterminated records, and hard resource-limit violations are fatal.
  Ordinary state/configuration errors are returned to the caller without
  necessarily ending the process.
- A signaling message that is invalid or cannot be applied ends an active
  session, but its error response is written before terminal events.

Output is also NDJSON and is serialized. An output write that remains blocked
for 30 seconds fails the process; if the writer implements `io.Closer`, the
sidecar closes it to unblock the write.

### Startup event

The first output record is always:

```json
{"v":1,"event":"ready","protocol":"webrtc-sidecar.control.v1","capabilities":["trickle-ice","tcp-listen","tcp-dial","selected-path"],"limits":{"maxChannels":8,"maxControlBytes":1048576}}
```

`ready` is the only event without `seq`. All later events have a process-wide,
strictly increasing sequence number beginning at 1.

### Requests and responses

Every request has this envelope plus command-specific fields:

```json
{"v":1,"id":"request-1","command":"status"}
```

A successful response is:

```json
{"v":1,"id":"request-1","ok":true,"result":{}}
```

An error response is:

```json
{"v":1,"id":"request-1","ok":false,"error":{"code":"invalid-state","message":"start must succeed before status"}}
```

Fatal response errors add `"fatal":true`. Some fatal framing errors cannot be
correlated with a valid ID, so they produce only a terminal `closed` event.
Error causes, SDP, candidates, TURN credentials, and network addresses are not
copied into process diagnostics.

Events after `ready` use this envelope:

```json
{"v":1,"seq":1,"event":"session.state","state":"starting"}
```

For `start`, `signal`, `channel.close`, and `close`, the response is fully
written before events induced by that command. In particular, an answerer's
generated answer cannot overtake the response to the offer it received.

## Commands

### `start`

`start` validates the complete configuration and creates local listeners
before acknowledging success. Only one `start` can succeed per process. A
validation or initialization failure leaves the process available for another
`start` with a new ID.

```json
{
  "v": 1,
  "id": "start-1",
  "command": "start",
  "role": "offerer",
  "connectTimeoutMs": 30000,
  "rtcConfiguration": {
    "iceTransportPolicy": "all",
    "iceServers": [
      {
        "urls": ["stun:stun.example.net:3478", "turns:turn.example.net:5349"],
        "username": "example-user",
        "credential": "example-password",
        "credentialType": "password"
      }
    ]
  },
  "channels": [
    {
      "mapping": "bytes",
      "label": "example-bytes",
      "protocol": "example.binary.v1",
      "local": {
        "mode": "listen",
        "host": "127.0.0.1",
        "port": 0
      }
    }
  ]
}
```

Top-level fields:

| Field | Rules |
| --- | --- |
| `role` | Required: `offerer` or `answerer`. |
| `connectTimeoutMs` | Optional integer milliseconds, default 30000; 0 disables the peer-connection deadline; maximum 24 hours. It measures time to `RTCPeerConnection` connected, not local TCP readiness. |
| `rtcConfiguration` | Optional/empty is allowed. It contains the ICE settings described below. |
| `channels` | Required array with 1 through 8 mappings. |

`rtcConfiguration` is the JavaScript-compatible subset used by this sidecar:

| Field | Rules |
| --- | --- |
| `iceTransportPolicy` | `all` (default) or `relay`. |
| `iceServers` | At most 16 entries. |
| `iceServers[].urls` | One through 8 `stun:`, `stuns:`, `turn:`, or `turns:` URLs; either one string or an array of strings; each at most 2048 bytes. |
| `iceServers[].username` | Optional, at most 512 bytes. |
| `iceServers[].credential` | Optional string, at most 2048 bytes. |
| `iceServers[].credentialType` | Omitted or `password`; OAuth credentials are not supported in v1. |

Channel fields:

| Field | Rules |
| --- | --- |
| `mapping` | Unique local ID matching `[A-Za-z0-9._:-]{1,64}`. |
| `label` | Unique, nonempty UTF-8 DataChannel label, at most 256 bytes. |
| `protocol` | UTF-8 DataChannel subprotocol, possibly empty, at most 256 bytes. |
| `local` | A `listen` or `dial` configuration. |

Only literal loopback IP addresses are accepted for `local.host`; hostnames,
including `localhost`, and non-loopback addresses are rejected. The default is
`127.0.0.1`. IPv6 loopback can be written as `::1`.

A listener accepts one local connection:

```json
{"mode":"listen","host":"127.0.0.1","port":0}
```

Listen ports are integers from 0 through 65535. Port 0 asks the OS to allocate
a port. `connectOn` and `connectTimeoutMs` are invalid for a listener.

A dial mapping targets one existing local TCP service:

```json
{"mode":"dial","host":"127.0.0.1","port":9000,"connectOn":"first-data","connectTimeoutMs":10000}
```

Dial ports are integers from 1 through 65535. `connectTimeoutMs` is integer
milliseconds, defaults to 10000, must be positive, and has a 24-hour maximum.
`connectOn` chooses the trigger:

- `open` is the default and dials as soon as the DataChannel opens.
- `first-data` waits for the first nonempty binary DataChannel message, then
  dials and forwards that message before starting the normal pumps. This is
  useful when the local service should be created lazily. Empty binary messages
  are ignored while waiting and text messages fail the mapping without dialing.
  At most one 64 KiB first message is held in memory.

A listener's successful result contains its actual bound address:

```json
{"v":1,"id":"start-1","ok":true,"result":{"role":"offerer","channels":[{"mapping":"bytes","label":"example-bytes","protocol":"example.binary.v1","local":{"mode":"listen","address":"127.0.0.1:54321"}}]}}
```

A dial result uses the target address and includes the resolved trigger:

```json
{"mapping":"bytes","label":"example-bytes","protocol":"example.binary.v1","local":{"mode":"dial","address":"127.0.0.1:9000","connectOn":"first-data"}}
```

After the success response, an offerer publishes its offer and trickled ICE
candidates. An answerer waits for an offer.

### `signal`

Forward a `signal` event's `message` unchanged to the remote sidecar:

```json
{"v":1,"id":"sig-1","command":"signal","message":{"type":"description","description":{"type":"offer","sdp":"..."}}}
```

The expected remote description is `offer` for an answerer and `answer` for an
offerer. Exactly one remote description is accepted, and SDP must be nonempty
and at most 256 KiB.

Trickle candidates use the browser `RTCIceCandidateInit` shape:

```json
{"v":1,"id":"sig-2","command":"signal","message":{"type":"candidate","candidate":{"candidate":"candidate:...","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"..."}}}
```

End-of-candidates is represented by JSON `null`, not an object with an empty
candidate string:

```json
{"v":1,"id":"sig-3","command":"signal","message":{"type":"candidate","candidate":null}}
```

Up to 256 remote candidates may arrive before the remote description; they are
queued and applied in order after it. The same 256-entry bound applies to
local candidates waiting for local-description publication. A candidate
payload is at most 16 KiB. Local output ordering is always description first,
followed by candidates in callback order, including the final `null` marker.
The end marker is final for v1; another candidate or a second end marker is
rejected.
The response to an answerer applying an offer is emitted before its answer
`signal` event. At most 1024 callback events may be held by that response-order
barrier; overflow fails the session instead of growing memory without bound.

There is no glare, renegotiation, ICE restart, or second-description handling
in v1. An invalid or unappliable signal is terminal after its response.

### `status`

`status` is available after a successful `start`:

```json
{"v":1,"id":"status-1","command":"status"}
```

An illustrative result is:

```json
{
  "v": 1,
  "id": "status-1",
  "ok": true,
  "result": {
    "role": "answerer",
    "state": "connected",
    "terminal": false,
    "channels": [
      {
        "mapping": "bytes",
        "label": "example-bytes",
        "protocol": "example.binary.v1",
        "state": "waiting",
        "localReady": false,
        "rtcReady": true,
        "local": {
          "mode": "dial",
          "address": "127.0.0.1:9000",
          "connectOn": "first-data"
        }
      }
    ],
    "path": {
      "relayed": false,
      "protocol": "udp",
      "localCandidateType": "host",
      "remoteCandidateType": "host"
    }
  }
}
```

`path` is omitted until a selected ICE pair is available. For a
`first-data` mapping, `rtcReady:true` together with `localReady:false` is the
expected lazy state before the first nonempty binary message. The `local`
descriptor has the same shape as the corresponding entry in the `start`
result, making the chosen trigger introspectable.

### `channel.close`

Close one mapping without closing its siblings:

```json
{"v":1,"id":"close-bytes","command":"channel.close","mapping":"bytes"}
```

The response precedes the mapping's terminal `channel.state` event. Re-closing
a known mapping succeeds and is otherwise a no-op. An unknown mapping returns
`invalid-message`.

### `close`

`close` is valid before or after `start`:

```json
{"v":1,"id":"close-1","command":"close"}
```

Its response precedes shutdown events. The final event is `closed`, and a
supervisor-requested close is a normal zero-exit condition.

## Events and lifecycle

### `signal`

```json
{"v":1,"seq":2,"event":"signal","message":{"type":"candidate","candidate":null}}
```

Carry `message`, not the surrounding event envelope, to the remote peer's
`signal` command.

### `session.state`

```json
{"v":1,"seq":3,"event":"session.state","state":"connected"}
```

States exposed in v1 are `starting`, `connecting`, `connected`,
`disconnected`, `failed`, and `closed`. Duplicate state notifications are
suppressed.

### `channel.state`

```json
{"v":1,"seq":4,"event":"channel.state","mapping":"bytes","label":"example-bytes","protocol":"example.binary.v1","state":"bridging","localReady":true,"rtcReady":true,"local":{"mode":"dial","address":"127.0.0.1:9000","connectOn":"open"}}
```

Channel states are `waiting`, `bridging`, `closed`, and `failed`.
`localReady` means a local TCP connection has been accepted or established;
binding a listener alone does not set it. `rtcReady` means the DataChannel is
open and detached for byte I/O. Terminal events add `reason`, and failures add
a sanitized `error` object with `code` and `message`.

An ordinary EOF or close on either side closes that mapping; there is no
half-close propagation. A failed mapping does not immediately tear down healthy
siblings. Once all mappings are terminal, the session exits normally if none
failed and exits with the first bridge failure otherwise.

### `path`

```json
{"v":1,"seq":5,"event":"path","path":{"relayed":true,"protocol":"udp","localCandidateType":"relay","remoteCandidateType":"srflx"}}
```

This is a privacy-safe summary of the selected ICE pair. It contains no IP
address, port, raw candidate, SDP, server URL, username, or credential.

### `closed`

`closed` is the final output record:

```json
{"v":1,"seq":6,"event":"closed","reason":"all-channels-closed"}
```

Failures add a sanitized error:

```json
{"v":1,"seq":6,"event":"closed","reason":"failed","error":{"code":"webrtc-failed","message":"WebRTC session failed"}}
```

Normal reasons include `closed`, `control-eof`, `cancelled`, and
`all-channels-closed`. Error codes include `invalid-message`,
`protocol-version`, `limit-exceeded`, `signal-invalid`,
`signal-apply-failed`, `webrtc-timeout`, `webrtc-failed`,
`unexpected-channel`, `local-connect-failed`, `bridge-timeout`, and
`internal`. Consumers should treat unknown future codes as terminal when they
appear in the final event.

## Byte transport, bounds, and backpressure

The bridge is a byte-stream adapter. It does not preserve local TCP write
boundaries or expose WebRTC message boundaries:

- TCP-to-WebRTC reads are sent as binary DataChannel messages of at most
  16 KiB. A read may naturally produce a smaller message.
- WebRTC-to-TCP accepts only binary messages, each at most 64 KiB. Text messages
  fail the mapping.
- The SCTP receive buffer is capped at 4 MiB, and the maximum SCTP message size
  is 64 KiB.
- Pion's blocking DataChannel writes are enabled, so a slow remote peer applies
  backpressure instead of permitting an unbounded send queue.
- TCP and DataChannel writes have 120-second deadlines. A deadline failure is
  reported as `bridge-timeout`.
- Peer connection establishment defaults to a 30-second deadline. Per-mapping
  TCP dialing defaults to 10 seconds. Control output has a 30-second deadline.
- Listener accept, lazy first-data wait, and steady-state reads remain open by
  design but are cancellable. Use `channel.close`, `close`, control EOF,
  process signals, or an embedding context deadline to bound them.

These limits are implementation constants for protocol v1. The 1 MiB record
limit applies to the complete request envelope, while the SDP and candidate
limits apply to their nested payloads.

## Security and privacy invariants

- Local TCP endpoints are restricted to literal loopback IPs. Listen mappings
  also verify that the accepted peer has a loopback source address.
- Loopback is a host boundary, not an authentication boundary. Any process on
  the same host that can reach an ephemeral listener may connect first, and any
  process able to listen on a configured dial port may impersonate the target.
  Run the sidecar and its local services under an appropriate OS account and
  supervision policy.
- WebRTC encrypts the data plane with DTLS, but this sidecar does not
  authenticate peer identity or signaling. The external signaling channel must
  provide the identity, authorization, integrity, and replay policy appropriate
  for the application.
- SDP, ICE candidates, and TURN credentials necessarily traverse the control
  protocol. Treat stdin/stdout as sensitive. Do not merge logs into stdout or
  record signaling without an explicit retention policy.
- Stderr and terminal errors use stable, sanitized codes. The selected-path
  event exposes only relay status, transport protocol, and candidate types.
- Supplying STUN/TURN service configuration is the supervisor's responsibility.
  The module neither discovers nor provisions those services.

## Embedding

The package exports the same single-session engine used by the CLI:

```go
package main

import (
    "context"
    "errors"
    "io"

    rtcsidecar "github.com/dphilla/weave/sidecars/webrtc"
)

func run(ctx context.Context, controlIn io.Reader, controlOut io.Writer) error {
    err := rtcsidecar.Run(ctx, controlIn, controlOut)
    var exitErr *rtcsidecar.ExitError
    if errors.As(err, &exitErr) {
        // exitErr.Code is safe to expose as an operational status.
    }
    return err
}
```

`Run` is single-use. It emits `ready` immediately, and returns `nil` after a
normal terminal event. `ExitError` indicates a terminal failure that was
already represented on the control stream. Other errors indicate that the
control stream itself could not be served.

The caller manages input and output lifetimes. For long-lived embeddings, use
a cancellation-aware or closeable input so a blocked read can be released, and
use an `io.Closer` output if it may block so the 30-second output guard can
interrupt it.

## Manual smoke check

The repository's end-to-end test is the quickest repeatable smoke check. It
runs two real Pion sidecars, forwards trickle signaling in both directions,
opens loopback TCP endpoints, verifies arbitrary binary bytes in both
directions, and exercises both dial triggers:

```sh
go test -run 'TestPionSidecarsBridgeBinaryBytes' -v
```

To inspect the CLI by hand:

1. Build it and launch `./weave-rtc` in two terminals. Each prints `ready`.
2. Send an `offerer` `start` record with a `listen` mapping to one process.
   Send a matching-label/protocol `answerer` record with a `dial` mapping to
   the other. Run a local TCP echo service at the dial address.
3. For every `signal` event, copy its `message` into a new, uniquely identified
   `signal` command on the other process. Forward the description and every
   candidate, including `null`.
4. After both sides report `connected`, connect a TCP client to the listener
   address returned by the offerer's `start`. Bytes should reach the answerer's
   local service and return unchanged. With `first-data`, the answerer's local
   TCP connection should appear only after the first nonempty payload.
5. Send `status`, `channel.close`, and `close` commands and verify response/event
   ordering and the final `closed` record.

## Version 0.1 non-goals

This release intentionally does not provide:

- rendezvous, signaling transport, peer discovery, DNS records, or
  STUN/TURN provisioning;
- application identity, authorization, signaling authentication, or a PKI;
- a Weave protocol, RPC framing, stream multiplexing, or application message
  semantics;
- browser or headless-browser lifecycle management;
- dynamic DataChannels, renegotiation, glare handling, ICE restarts, session
  resume, or automatic reconnect;
- unordered, partially reliable, negotiated-out-of-band, or text channels;
- UDP, Unix-domain sockets, non-loopback local networking, multiple TCP clients
  per mapping, or half-close semantics; or
- preservation of TCP write boundaries or DataChannel message boundaries.

Those concerns can be layered around the stable stdin/stdout control protocol
and loopback byte interface without coupling them to this module.

## Protocol references

- [WebRTC 1.0](https://www.w3.org/TR/webrtc/)
- [WebRTC Data Channels (RFC 8831)](https://www.rfc-editor.org/rfc/rfc8831)
- [Interactive Connectivity Establishment (RFC 8445)](https://www.rfc-editor.org/rfc/rfc8445)
- [Trickle ICE (RFC 8838)](https://www.rfc-editor.org/rfc/rfc8838)
- [Pion WebRTC](https://github.com/pion/webrtc)

## License

Apache-2.0. See [LICENSE](LICENSE).
