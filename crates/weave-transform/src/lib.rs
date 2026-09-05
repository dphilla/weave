//! weave-transform: the instrumenting compiler at the heart of Weave.
//!
//! Rewrites a module in Weave's supported single-threaded core-Wasm subset so
//! that its *live execution state* — the operand stack, locals, call frames,
//! program counters, application globals, and funcref table contents — can be
//! captured into, and rebuilt from, plain linear memory using standard Wasm
//! semantics. This enables migration across supported adapters with an
//! overlapping Wasm feature set: the host needs no stack introspection or
//! runtime internals, only the ordinary embedding API (call an export,
//! read/write exported memories, and access a few exported i32 globals) plus
//! implementations for the workload's explicit host imports.
//!
//! ## How it works
//!
//! 1. Every function that can reach a checkpoint (transitively: contains a
//!    loop, makes an indirect call, or calls such a function) is *flattened*:
//!    its structured control flow is lowered to a `loop`+`br_table` dispatch
//!    over flat basic blocks, and the entire operand stack is registerized
//!    into locals keyed by `(stack depth, type)`. At that point a function's
//!    complete live state is exactly: its locals + a block index (`pc`).
//!
//! 2. `weave.poll` (the only injected import) is called at function entries
//!    and loop back-edges, gated by an in-guest countdown so host-call cost is
//!    amortized. When it returns nonzero the function *spills itself* — pc and
//!    all locals — into a shadow stack in linear memory and returns a dummy;
//!    every caller's call-site check does the same, unwinding the whole native
//!    stack into memory. The host then observes `__weave_flag == UNWOUND`.
//!
//! 3. Resuming is the mirror image: `__weave_resume` re-enters the entry;
//!    each function's prologue pops its frame, restores locals and `pc`, and
//!    the dispatch loop re-executes the exact call instruction that was live,
//!    rebuilding the native stack frame-by-frame. The innermost frame flips
//!    state back to RUN and execution continues on the instruction after the
//!    poll — bit-for-bit where it left off.
//!
//! Because the shadow stack, saved globals and table shadows all live *inside*
//! linear memory, a migration payload is simply: memory + a fixed set of i32
//! control globals + host-service blobs.

mod codegen;
mod emit;
mod flatten;
mod module;
mod memory;

use anyhow::{Context, Result};
use weave_core::Meta;

#[derive(Debug, Clone)]
pub struct TransformOptions {
    /// Poll countdown period (number of entry/back-edge events between
    /// `weave.poll` host calls). Smaller = lower checkpoint latency, higher
    /// overhead.
    pub poll_period: u32,
    /// Initial shadow-stack allocation in 64 KiB wasm pages.
    pub stack_pages: u32,
}

impl Default for TransformOptions {
    fn default() -> Self {
        TransformOptions { poll_period: 512, stack_pages: 16 }
    }
}

pub struct TransformOutput {
    pub wasm: Vec<u8>,
    pub meta: Meta,
}

/// Instrument `wasm` for live migration.
pub fn transform(wasm: &[u8], opts: &TransformOptions) -> Result<TransformOutput> {
    let parsed = module::parse(wasm).context("parsing input module")?;
    let plan = emit::Plan::build(&parsed, opts)?;
    let out = emit::emit(wasm, &parsed, &plan, opts).context("emitting transformed module")?;

    // The transformer's output must itself be a valid module; catching this
    // here turns any instrumentation bug into a hard error at transform time
    // rather than a runtime failure on some engine.
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(&out.wasm)
        .context("BUG: transformed module failed validation")?;
    Ok(out)
}
