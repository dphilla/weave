//! Export-name conventions shared between the transformer and every host
//! plugin. The entire host-side ABI is expressed through *standard wasm
//! exports* — functions, mutable **i32** globals, and memories — so that any
//! spec-compliant runtime can drive checkpoint/restore with nothing beyond its
//! ordinary embedding API. (Notably: application globals, funcref tables, and
//! v128 state are never read by the host; the transformer generates guest code
//! that saves/restores them through linear memory, which JS/Go/C embedders can
//! all access uniformly.)

/// Import module name for the single host function the transformer injects.
pub const IMPORT_MODULE: &str = "weave";
/// `weave.poll: [] -> [i32]`. Called from instrumented code at function
/// entries and loop back-edges (gated by an in-guest countdown so the host
/// call is amortized). Returns nonzero to request a full stack unwind.
pub const IMPORT_POLL: &str = "poll";

/// Execution mode: 0 = run, 1 = unwinding, 2 = rewinding. (mutable i32 global)
pub const G_STATE: &str = "__weave_state";
/// Outcome of the last entry/resume call: 0 = ran to completion, 1 = unwound.
pub const G_FLAG: &str = "__weave_flag";
/// Which exported entry was live when the stack unwound (index into meta.entries).
pub const G_ENTRY: &str = "__weave_entry";
/// Poll countdown counter.
pub const G_CTR: &str = "__weave_ctr";
/// Shadow-stack pointer / region bounds (byte addresses in memory 0).
pub const G_SP: &str = "__weave_sp";
pub const G_STACK_BASE: &str = "__weave_stack_base";
pub const G_STACK_END: &str = "__weave_stack_end";
/// Base address of the weave region (saved globals + results + table shadows).
pub const G_RBASE: &str = "__weave_rbase";

pub const STATE_RUN: i32 = 0;
pub const STATE_UNWIND: i32 = 1;
pub const STATE_REWIND: i32 = 2;

pub const FLAG_DONE: i32 = 0;
pub const FLAG_UNWOUND: i32 = 1;

/// `__weave_resume: [] -> []`. Reloads saved application globals, re-winds the
/// shadow stack and continues execution exactly where it stopped. Sets G_FLAG
/// (and the results area) on return.
pub const F_RESUME: &str = "__weave_resume";
/// `__weave_init: [] -> []`. One-time initialization on a *fresh* run (weave
/// region allocation, table shadow setup, plus the module's original `start`,
/// which the transformer strips). Must NOT be called when restoring a snapshot.
pub const F_INIT: &str = "__weave_init";

/// Custom section carrying the transformer-emitted metadata.
pub const META_SECTION: &str = "weave.meta";

/// Naming for memories the transformer force-exports when the module did not
/// already export them (the actual name per index is recorded in the meta).
pub fn memory_export_name(index: u32) -> String {
    format!("__weave_mem{index}")
}
