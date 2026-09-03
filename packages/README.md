# Reusable networking packages

This directory contains installable networking components whose public APIs do
not depend on the Weave migration protocol:

- `@weave-net/browser-transports` adapts browser WebSocket and reliable,
  ordered RTCDataChannel objects to bounded byte streams.
- `@weave-net/webrtc-session` owns one headless offer/answer negotiation,
  trickled ICE, raw DataChannel creation, and PeerConnection lifecycle while
  leaving signaling transport and application policy injectable.
- `@weave-net/authenticated-rendezvous` binds self-certifying Ed25519 NodeIDs,
  issuer-signed connection capabilities, and peer-signed signaling records to
  a canonical-byte, replaceable rendezvous transport without importing WebRTC
  or Weave.
- `@weave-net/node-transports` adapts Node TCP sockets to the same exact-read,
  ordered-write contract.
- `@weave-net/ws-tcp-gateway` bridges a normalized binary WebSocket endpoint
  to a Node duplex stream without inspecting the carried bytes.

The repository root is the only JavaScript workspace and lockfile boundary.
Packages contain only their runtime source, public type declarations, tests,
and package documentation. CI orchestration and package-install smoke tests
remain centralized under `.github/ci/`.

The legacy files under `js/` remain supported Weave integration entry points.
They add Weave protocol defaults and re-export these packages, so existing
demos and consumers do not need an immediate import migration.
