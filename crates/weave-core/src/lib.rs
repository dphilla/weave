//! weave-core: shared data model for Weave live migration.
//!
//! Everything in this crate is engine-agnostic and dependency-light. It defines:
//!  - the value/type model shared by the transformer, hosts, and wire protocol
//!  - SHA-256 (module identity, page dirty-tracking, end-to-end state verification)
//!  - the `weave.meta` custom-section codec emitted by the transformer and
//!    consumed by every host plugin (Rust, JS, Go, C)
//!  - the peer-to-peer migration wire protocol frames
//!  - the portable snapshot container (checkpoint-to-file / restore-from-file)

pub mod meta;
pub mod names;
pub mod sha256;
pub mod snapshot;
pub mod types;
pub mod wire;

pub use meta::Meta;
pub use snapshot::Snapshot;
pub use types::{Val, ValType};

/// Weave transfer page granularity (bytes). Distinct from the 64 KiB wasm page.
pub const WPAGE_SIZE: usize = 4096;
/// Wasm linear-memory page size.
pub const WASM_PAGE_SIZE: usize = 65536;
/// Wire/format version. Bump on any incompatible change.
pub const WEAVE_VERSION: u16 = 1;
