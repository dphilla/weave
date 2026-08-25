//! The `weave.poll` host function and its control state.
//!
//! `poll` is the single hook the transformer injects. Its return value decides
//! whether the guest keeps running (0) or unwinds its whole stack into linear
//! memory (nonzero). All of Weave's control — plain checkpoints and the
//! iterative pre-copy phase of a live migration — is expressed through what
//! this function decides on each call, using the guest's *own* paused memory.

use crate::instance::Ctx;
use wasmtime::{Caller, Linker, Memory};
use weave_host::source::SourceMigration;
use weave_host::MemRead;

/// What the next `poll` should do.
pub enum Poller {
    /// Keep running; never request an unwind.
    Run,
    /// Request an unwind on the next poll (plain checkpoint).
    UnwindNext,
    /// Let this many polls pass, then unwind (checkpoint "mid-flight").
    UnwindAfter(u64),
    /// Active live migration: each poll advances pre-copy and unwinds once the
    /// dirty set has converged.
    Migrating {
        mig: Box<SourceMigration>,
        mem_names: Vec<String>,
    },
    /// A migration step failed; unwind so the caller can rewind locally.
    Errored(String),
}

impl Default for Poller {
    fn default() -> Self {
        Poller::Run
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PollDecision {
    Continue,
    Unwind,
}

/// Adapter exposing borrowed memory slices as `MemRead`.
struct SliceMem<'a> {
    slices: Vec<&'a [u8]>,
}

impl MemRead for SliceMem<'_> {
    fn n_mems(&self) -> usize {
        self.slices.len()
    }
    fn size(&self, mem: usize) -> usize {
        self.slices[mem].len()
    }
    fn read(&self, mem: usize, off: usize, buf: &mut [u8]) {
        let src = &self.slices[mem][off..off + buf.len()];
        buf.copy_from_slice(src);
    }
}

/// Install `weave.poll` into a linker.
pub fn install_poll(linker: &mut Linker<Ctx>) -> anyhow::Result<()> {
    linker.func_wrap("weave", "poll", |mut caller: Caller<'_, Ctx>| -> i32 {
        // Move the control state out so we can also borrow memory immutably.
        let mut poller = std::mem::take(&mut caller.data_mut().poller);
        let mut counters_hit = false;

        // A control thread may have requested a migration of this running
        // workload: transition Run → Migrating by dialing the target here
        // (the guest is paused inside this host call anyway).
        if matches!(poller, Poller::Run) {
            let request = caller
                .data()
                .shared
                .as_ref()
                .and_then(|s| s.lock().unwrap().requested_target());
            if let Some(target) = request {
                let d = caller.data();
                let (wasm, meta_bytes, mem_names, opts, runtime) = (
                    d.module_wasm.clone(),
                    d.meta_bytes.clone(),
                    d.mem_names.clone(),
                    d.source_opts.clone(),
                    d.runtime_name.clone(),
                );
                match SourceMigration::connect(
                    &target,
                    &runtime,
                    &wasm,
                    &meta_bytes,
                    mem_names.len(),
                    opts,
                ) {
                    Ok(mig) => {
                        poller = Poller::Migrating {
                            mig: Box::new(mig),
                            mem_names,
                        };
                    }
                    Err(e) => {
                        // Can't reach the target: keep running, report, clear.
                        if let Some(sh) = &caller.data().shared {
                            let mut sh = sh.lock().unwrap();
                            sh.complete_request(format!("migration failed to start: {e:#}"));
                        }
                    }
                }
            }
        }

        let decision = match &mut poller {
            Poller::Run => 0,
            Poller::UnwindNext => 1,
            Poller::UnwindAfter(n) => {
                if *n == 0 {
                    1
                } else {
                    *n -= 1;
                    0
                }
            }
            Poller::Errored(_) => 1,
            Poller::Migrating { mig, mem_names } => {
                // Gather memory export slices (all immutable borrows of caller).
                let mems: Vec<Memory> = mem_names
                    .iter()
                    .filter_map(|n| caller.get_export(n).and_then(|e| e.into_memory()))
                    .collect();
                if mems.len() != mem_names.len() {
                    poller = Poller::Errored("missing exported memory during migration".into());
                    counters_hit = true;
                    1
                } else {
                    let slices: Vec<&[u8]> = mems.iter().map(|m| m.data(&caller)).collect();
                    let sm = SliceMem { slices };
                    match mig.precopy_step(&sm) {
                        Ok(true) => 1,
                        Ok(false) => 0,
                        Err(e) => {
                            counters_hit = true;
                            poller = Poller::Errored(format!("{e:#}"));
                            1
                        }
                    }
                }
            }
        };
        let _ = counters_hit;
        caller.data_mut().poller = poller;
        decision
    })?;
    Ok(())
}
