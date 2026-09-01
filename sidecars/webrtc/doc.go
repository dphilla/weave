// Package rtcsidecar bridges fixed, reliable WebRTC DataChannels to local
// loopback TCP byte streams under a strict NDJSON control protocol.
//
// Run serves exactly one PeerConnection. It is application-neutral: signaling,
// peer identity, rendezvous, and application framing remain the caller's
// responsibility.
package rtcsidecar
