//! weave-host: engine-agnostic host-plugin core.
//!
//! Everything a runtime embedding needs to run, checkpoint, migrate and
//! receive Weave workloads, expressed against tiny traits so any engine
//! (wasmtime here; the JS and Go plugins implement the same logic against the
//! same wire protocol) can drive it:
//!
//!  - [`HostService`]: stateful host functions whose state must move with the
//!    workload (the "external-but-interfaced" state). Each service serializes
//!    itself into an opaque blob that rides in the snapshot.
//!  - [`pages::PageTracker`]: iterative pre-copy dirty-page tracking (the
//!    vMotion-style amortization: memory streams to the target while the
//!    guest keeps executing; each round only re-sends what changed).
//!  - [`source::SourceMigration`] / [`target::TargetSession`]: the two ends
//!    of the peer-to-peer migration protocol.

pub mod pages;
pub mod source;
pub mod target;

use anyhow::Result;

/// A stateful host service. Implementations also register concrete host
/// functions with their engine (that part is engine-specific); Weave moves
/// the *state* between hosts at migration time.
pub trait HostService: Send {
    /// Stable service name; both peers must register the same set.
    fn name(&self) -> &str;
    /// Serialize the complete current state.
    fn snapshot(&self) -> Vec<u8>;
    /// Replace state from a snapshot produced by `snapshot()` on the peer.
    fn restore(&mut self, blob: &[u8]) -> Result<()>;
}

/// Read access to a paused guest's linear memories (only ever used while the
/// guest is stopped inside a host call or after an unwind).
pub trait MemRead {
    fn n_mems(&self) -> usize;
    /// Current size in bytes.
    fn size(&self, mem: usize) -> usize;
    fn read(&self, mem: usize, off: usize, buf: &mut [u8]);
}

/// Snapshot every registered service, sorted by name (deterministic order is
/// required for the state hash to agree across peers).
pub fn snapshot_services_ref(services: &[Box<dyn HostService>]) -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = services
        .iter()
        .map(|s| (s.name().to_string(), s.snapshot()))
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v
}
