//! Driving a live migration from the wasmtime host side.
//!
//! Source: kick off pre-copy (memory streams while the guest runs), let the
//! guest converge and unwind, send the final delta + globals + services, and
//! on RESUME_OK retire the local instance. On *any* failure the local guest is
//! rewound and keeps running — migration is always safe to abandon.
//!
//! Target: accept the stream into a fresh instance and resume it.

use crate::instance::{WeaveInstance, WorkResult};
use crate::poll::Poller;
use crate::WeaveModule;
use anyhow::{anyhow, bail, Context, Result};
use std::any::Any;
use std::net::{TcpListener, TcpStream};
use wasmtime::{Engine, Val};
use weave_core::snapshot::Snapshot;
use weave_core::Meta;
use weave_host::source::{MigrationStats, SourceMigration, SourceOptions};
use weave_host::target::{run_target_session, TargetHost};
use weave_host::{HostService, MemRead};

/// Result of a source-side migration attempt. Failure is always safe: the
/// variants say exactly what state the local workload is in.
pub enum MigrateOutcome {
    /// The workload moved successfully; this instance is retired.
    Migrated(MigrationStats),
    /// The workload had already finished before it could be checkpointed;
    /// these are its results (nothing was migrated).
    CompletedLocally(Vec<Val>),
    /// Migration failed after the workload had checkpointed: it sits unwound
    /// in this instance — call `resume()` and it continues seamlessly.
    FailedUnwound { error: String },
    /// Migration failed before the workload ever started (e.g. the target was
    /// unreachable): call `call_entry` to run it locally as usual.
    FailedNotStarted { error: String },
}

/// Migrate a *currently executing* workload to `target`. `entry`/`args` name
/// the in-flight call. On return the instance has either migrated away or
/// finished locally; on error the instance is rewound and still runnable.
pub fn migrate_running(
    inst: &mut WeaveInstance,
    entry: &str,
    args: &[Val],
    target: &str,
    runtime_name: &str,
    opts: SourceOptions,
) -> Result<MigrateOutcome> {
    let module = inst.module.clone();
    let mem_names = module.meta.memories.clone();

    let mig = match SourceMigration::connect(
        target,
        runtime_name,
        &module.wasm,
        &module.meta.encode(),
        mem_names.len(),
        opts,
    ) {
        Ok(m) => m,
        Err(e) => {
            return Ok(MigrateOutcome::FailedNotStarted { error: format!("{e:#}") });
        }
    };

    inst.set_poller(Poller::Migrating { mig: Box::new(mig), mem_names: mem_names.clone() });

    // Run the in-flight workload; pre-copy advances inside each poll.
    let outcome = inst.call_entry(entry, args)?;

    match outcome {
        WorkResult::Done(results) => {
            // Finished before we could checkpoint. Tell the target to abort.
            if let Poller::Migrating { mig, .. } = inst.take_poller() {
                mig.abort(10, "workload completed before checkpoint");
            }
            Ok(MigrateOutcome::CompletedLocally(results))
        }
        WorkResult::Unwound => {
            let poller = inst.take_poller();
            let mig = match poller {
                Poller::Migrating { mig, .. } => *mig,
                Poller::Errored(e) => {
                    // Pre-copy failed mid-flight. The guest is checkpointed in
                    // its own memory; the caller resumes it locally.
                    return Ok(MigrateOutcome::FailedUnwound { error: e });
                }
                _ => bail!("unexpected poller state after unwind"),
            };
            // The guest has unwound: stack + saved globals are now in memory.
            let globals = inst.capture_globals()?;
            let services = inst.snapshot_services();
            let mems = inst.mem_view()?;
            match mig.finish(&mems, globals, services) {
                Ok(stats) => Ok(MigrateOutcome::Migrated(stats)),
                Err(e) => Ok(MigrateOutcome::FailedUnwound { error: format!("{e:#}") }),
            }
        }
    }
}

/// Everything needed to (re)build instances on the target: module cache +
/// service/linker factories.
pub struct TargetFactory<'a> {
    pub engine: Engine,
    /// Look up / cache transformed modules by hash.
    pub modules: std::collections::HashMap<[u8; 32], WeaveModule>,
    /// Build the host services for a new instance.
    pub make_services:
        Box<dyn FnMut() -> (Vec<Box<dyn HostService>>, Vec<Box<dyn Any + Send>>) + 'a>,
    /// Install the workload's non-weave imports.
    pub make_link: Box<dyn FnMut() -> crate::instance::LinkFn + 'a>,
}

struct TargetDriver<'a, 'b> {
    factory: &'a mut TargetFactory<'b>,
    inst: Option<WeaveInstance>,
    hash: [u8; 32],
    owned: Option<crate::instance::OwnedMems>,
}

impl TargetHost for TargetDriver<'_, '_> {
    fn has_module(&mut self, hash: &[u8; 32]) -> bool {
        self.factory.modules.contains_key(hash)
    }

    fn store_module(&mut self, hash: &[u8; 32], bytes: Vec<u8>) -> Result<()> {
        // The received bytes are already transformed; parse meta from section.
        let meta = extract_meta(&bytes)?;
        self.factory.modules.insert(*hash, WeaveModule::from_transformed(bytes, meta));
        Ok(())
    }

    fn instantiate(&mut self, hash: &[u8; 32], _meta: &Meta) -> Result<()> {
        let module = self
            .factory
            .modules
            .get(hash)
            .ok_or_else(|| anyhow!("module not present for instantiation"))?
            .clone();
        let (services, service_any) = (self.factory.make_services)();
        let link = (self.factory.make_link)();
        let inst = WeaveInstance::new_restored(
            &self.factory.engine,
            &module,
            services,
            service_any,
            link,
        )?;
        self.hash = *hash;
        self.inst = Some(inst);
        Ok(())
    }

    fn set_mem_pages(&mut self, mem: usize, pages: u64) -> Result<()> {
        let want = pages as usize * weave_core::WASM_PAGE_SIZE;
        self.inst.as_mut().unwrap().ensure_mem_bytes(mem, want)
    }

    fn write_mem(&mut self, mem: usize, off: usize, bytes: &[u8]) -> Result<()> {
        self.inst.as_mut().unwrap().write_mem(mem, off, bytes)
    }

    fn set_global(&mut self, name: &str, v: i32) -> Result<()> {
        self.inst.as_mut().unwrap().set_global_i32(name, v)
    }

    fn restore_services(&mut self, services: &[(String, Vec<u8>)]) -> Result<()> {
        self.inst.as_mut().unwrap().restore_services(services)
    }

    fn mems(&mut self) -> &dyn MemRead {
        // Materialize an owned view; lifetime-simplest and only done once.
        let inst = self.inst.as_mut().unwrap();
        self.owned = Some(inst.mem_view().expect("mem view"));
        self.owned.as_ref().unwrap()
    }
}

/// Accept one migration on `listener` and return the ready-to-resume instance.
pub fn accept_one(
    listener: &TcpListener,
    factory: &mut TargetFactory<'_>,
) -> Result<WeaveInstance> {
    let (conn, _peer) = listener.accept().context("accepting migration connection")?;
    accept_conn(conn, factory)
}

pub fn accept_conn(conn: TcpStream, factory: &mut TargetFactory<'_>) -> Result<WeaveInstance> {
    let mut driver =
        TargetDriver { factory, inst: None, hash: [0u8; 32], owned: None };
    run_target_session(conn, &mut driver).context("running target session")?;
    driver.inst.ok_or_else(|| anyhow!("target session produced no instance"))
}

fn extract_meta(wasm: &[u8]) -> Result<Meta> {
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        if let wasmparser::Payload::CustomSection(c) = payload? {
            if c.name() == weave_core::names::META_SECTION {
                return Meta::decode(c.data());
            }
        }
    }
    bail!("received module has no {} section", weave_core::names::META_SECTION)
}

/// Restore an instance from an on-disk snapshot file's bytes.
pub fn restore_from_snapshot(
    engine: &Engine,
    module: &WeaveModule,
    snap: &Snapshot,
    services: Vec<Box<dyn HostService>>,
    service_any: Vec<Box<dyn Any + Send>>,
    link: crate::instance::LinkFn,
) -> Result<WeaveInstance> {
    let mut inst = WeaveInstance::new_restored(engine, module, services, service_any, link)?;
    inst.restore(snap)?;
    Ok(inst)
}
