# Weave demos

- [`server-chain`](server-chain/) runs a verified Wasmtime → Node/V8 → wazero
  three-server chain over TCP and compares the complete event trace with an
  uninterrupted golden run.
- [`browser-webrtc`](browser-webrtc/) moves a running workload browser A →
  browser B → browser A over direct WebRTC DataChannels; its Node service is
  signaling-only and never carries migration bytes.
- [`browser-wamr`](browser-wamr/) runs a woven workload in Chrome, moves it
  to a WAMR server, accepts a WAMR workload back into the tab, and supports a
  Chrome → WAMR → Chrome → WAMR round trip through protocol v2.

Each demo documents its prerequisites and generated artifacts locally. Build
outputs such as `*.woven.wasm` are intentionally not committed.
