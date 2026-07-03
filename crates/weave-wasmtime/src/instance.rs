//! `WeaveInstance`: a running (or restorable) instance of a woven module on
//! wasmtime, with checkpoint/restore and the host-side of live migration.

use crate::poll::{install_poll, Poller};
use crate::WeaveModule;
use anyhow::{anyhow, bail, Context, Result};
use std::any::Any;
use wasmtime::{Engine, Extern, Instance, Linker, Memory, Module, Store, Val};
use weave_core::names;
use weave_core::snapshot::Snapshot;
use weave_host::{HostService, MemRead};

/// Store context: the host services plus the poll control.
pub struct Ctx {
    pub poller: Poller,
    pub services: Vec<Box<dyn HostService>>,
    pub service_any: Vec<Box<dyn Any + Send>>,
    /// Node-level control (set via `attach_shared`): lets a control thread
    /// request migration of a *running* workload; `weave.poll` picks it up.
    pub shared: Option<std::sync::Arc<std::sync::Mutex<crate::serve::Shared>>>,
    pub source_opts: weave_host::source::SourceOptions,
    pub runtime_name: String,
    /// Module identity needed to *initiate* a migration from inside poll.
    pub module_wasm: std::sync::Arc<Vec<u8>>,
    pub meta_bytes: Vec<u8>,
    pub mem_names: Vec<String>,
}

impl Ctx {
    pub fn service_state<T: 'static>(&mut self, idx: usize) -> &mut T {
        self.service_any[idx].downcast_mut::<T>().expect("service type mismatch")
    }
}

/// Outcome of running or resuming a workload.
#[derive(Debug, Clone)]
pub enum WorkResult {
    /// Ran to completion with these results.
    Done(Vec<Val>),
    /// The guest unwound its stack (checkpoint/migration requested).
    Unwound,
}

/// A callback that installs the workload's non-weave host imports.
pub type LinkFn = Box<dyn FnMut(&mut Linker<Ctx>) -> Result<()>>;

pub struct WeaveInstance {
    pub module: WeaveModule,
    store: Store<Ctx>,
    instance: Instance,
    engine: Engine,
}

impl WeaveInstance {
    /// Instantiate for a *fresh* run: registers imports + `weave.poll`, then
    /// runs `__weave_init` (which folds in the original `start`).
    pub fn new_fresh(
        engine: &Engine,
        module: &WeaveModule,
        services: Vec<Box<dyn HostService>>,
        service_any: Vec<Box<dyn Any + Send>>,
        mut link: LinkFn,
    ) -> Result<WeaveInstance> {
        let mut inst = Self::instantiate(engine, module, services, service_any, &mut link)?;
        let init = inst
            .instance
            .get_func(&mut inst.store, names::F_INIT)
            .ok_or_else(|| anyhow!("module missing {}", names::F_INIT))?;
        init.call(&mut inst.store, &[], &mut [])
            .context("running __weave_init")?;
        Ok(inst)
    }

    /// Instantiate for a *restore*: identical wiring but `__weave_init` is NOT
    /// run — state arrives from a snapshot or the wire.
    pub fn new_restored(
        engine: &Engine,
        module: &WeaveModule,
        services: Vec<Box<dyn HostService>>,
        service_any: Vec<Box<dyn Any + Send>>,
        mut link: LinkFn,
    ) -> Result<WeaveInstance> {
        Self::instantiate(engine, module, services, service_any, &mut link)
    }

    fn instantiate(
        engine: &Engine,
        module: &WeaveModule,
        services: Vec<Box<dyn HostService>>,
        service_any: Vec<Box<dyn Any + Send>>,
        link: &mut LinkFn,
    ) -> Result<WeaveInstance> {
        let wmod = Module::new(engine, &module.wasm[..]).context("compiling woven module")?;
        let mut linker: Linker<Ctx> = Linker::new(engine);
        install_poll(&mut linker)?;
        link(&mut linker)?;
        let ctx = Ctx {
            poller: Poller::Run,
            services,
            service_any,
            shared: None,
            source_opts: Default::default(),
            runtime_name: "wasmtime".into(),
            module_wasm: module.wasm.clone(),
            meta_bytes: module.meta.encode(),
            mem_names: module.meta.memories.clone(),
        };
        let mut store = Store::new(engine, ctx);
        let instance = linker
            .instantiate(&mut store, &wmod)
            .context("instantiating woven module")?;
        Ok(WeaveInstance { module: module.clone(), store, instance, engine: engine.clone() })
    }

    /// Attach node-level control state: after this, a control thread can set
    /// `shared.request` and the next polls will carry out the migration.
    pub fn attach_shared(
        &mut self,
        shared: std::sync::Arc<std::sync::Mutex<crate::serve::Shared>>,
        opts: weave_host::source::SourceOptions,
    ) {
        let d = self.store.data_mut();
        d.shared = Some(shared);
        d.source_opts = opts;
    }

    pub fn ctx_mut(&mut self) -> &mut Ctx {
        self.store.data_mut()
    }

    pub fn set_poller(&mut self, p: Poller) {
        self.store.data_mut().poller = p;
    }

    pub fn take_poller(&mut self) -> Poller {
        std::mem::take(&mut self.store.data_mut().poller)
    }

    fn n_results(&self, entry: &str) -> Result<usize> {
        let e = self
            .module
            .meta
            .entries
            .iter()
            .find(|e| e.name == entry)
            .ok_or_else(|| anyhow!("no weave entry {entry}"))?;
        Ok(e.results.len())
    }

    /// Call an exported entry. On unwind returns `Unwound` (its result, if the
    /// run had completed, is in the results area; on unwind there is none yet).
    pub fn call_entry(&mut self, entry: &str, args: &[Val]) -> Result<WorkResult> {
        let f = self
            .instance
            .get_func(&mut self.store, entry)
            .ok_or_else(|| anyhow!("no export {entry}"))?;
        let n = self.n_results(entry)?;
        let mut results = vec![Val::I32(0); n];
        f.call(&mut self.store, args, &mut results)
            .with_context(|| format!("calling entry {entry}"))?;
        self.classify(results)
    }

    /// Re-enter and continue a previously-unwound workload.
    pub fn resume(&mut self) -> Result<WorkResult> {
        let f = self
            .instance
            .get_func(&mut self.store, names::F_RESUME)
            .ok_or_else(|| anyhow!("module missing {}", names::F_RESUME))?;
        f.call(&mut self.store, &[], &mut []).context("running __weave_resume")?;
        // On completion, results live in the results area; recover them.
        let entry_idx = self.get_global_i32(names::G_ENTRY)? as usize;
        let entry = self
            .module
            .meta
            .entries
            .get(entry_idx)
            .ok_or_else(|| anyhow!("bad entry index {entry_idx}"))?
            .clone();
        let n = entry.results.len();
        let mut results = vec![Val::I32(0); n];
        if self.get_global_i32(names::G_FLAG)? == names::FLAG_DONE {
            let rbase = self.get_global_i32(names::G_RBASE)? as usize;
            let base = rbase + self.module.meta.globals_area_size as usize;
            let mem = self.primary_memory()?;
            let data = mem.data(&self.store);
            for (i, ty) in entry.results.iter().enumerate() {
                let off = base + i * 16;
                results[i] = read_val(*ty, &data[off..off + 16]);
            }
        }
        self.classify(results)
    }

    fn classify(&mut self, results: Vec<Val>) -> Result<WorkResult> {
        let flag = self.get_global_i32(names::G_FLAG)?;
        if flag == names::FLAG_UNWOUND {
            Ok(WorkResult::Unwound)
        } else {
            Ok(WorkResult::Done(results))
        }
    }

    // ---- state access ----

    pub fn primary_memory(&mut self) -> Result<Memory> {
        self.memory(&self.module.meta.memories[0].clone())
    }

    pub fn memory(&mut self, name: &str) -> Result<Memory> {
        match self.instance.get_export(&mut self.store, name) {
            Some(Extern::Memory(m)) => Ok(m),
            _ => bail!("no exported memory {name}"),
        }
    }

    pub fn get_global_i32(&mut self, name: &str) -> Result<i32> {
        let g = self
            .instance
            .get_global(&mut self.store, name)
            .ok_or_else(|| anyhow!("no global {name}"))?;
        match g.get(&mut self.store) {
            Val::I32(v) => Ok(v),
            other => bail!("global {name} not i32: {other:?}"),
        }
    }

    pub fn set_global_i32(&mut self, name: &str, v: i32) -> Result<()> {
        let g = self
            .instance
            .get_global(&mut self.store, name)
            .ok_or_else(|| anyhow!("no global {name}"))?;
        g.set(&mut self.store, Val::I32(v)).with_context(|| format!("set global {name}"))
    }

    /// Capture a complete portable snapshot of the current (paused) state.
    pub fn checkpoint(&mut self) -> Result<Snapshot> {
        let mem_names = self.module.meta.memories.clone();
        let mut memories = Vec::new();
        for n in &mem_names {
            let m = self.memory(n)?;
            memories.push(m.data(&self.store).to_vec());
        }
        let globals = self.capture_globals()?;
        let services = weave_host::snapshot_services_ref(&self.store.data().services);
        Ok(Snapshot { module_hash: self.module.module_hash, memories, globals, services })
    }

    pub fn capture_globals(&mut self) -> Result<Vec<(String, i32)>> {
        let names = self.module.meta.control_globals.clone();
        let mut out = Vec::with_capacity(names.len());
        for n in &names {
            out.push((n.clone(), self.get_global_i32(n)?));
        }
        Ok(out)
    }

    /// Restore a snapshot into this (freshly-instantiated, un-init'd) instance.
    pub fn restore(&mut self, snap: &Snapshot) -> Result<()> {
        if snap.module_hash != self.module.module_hash {
            bail!("snapshot module hash does not match this module");
        }
        let mem_names = self.module.meta.memories.clone();
        for (i, n) in mem_names.iter().enumerate() {
            let m = self.memory(n)?;
            let want = snap.memories[i].len();
            let have = m.data_size(&self.store);
            if want > have {
                let pages = (want - have).div_ceil(weave_core::WASM_PAGE_SIZE);
                m.grow(&mut self.store, pages as u64).context("growing memory for restore")?;
            }
            m.data_mut(&mut self.store)[..want].copy_from_slice(&snap.memories[i]);
        }
        for (n, v) in &snap.globals {
            self.set_global_i32(n, *v)?;
        }
        // restore services
        let blobs: Vec<(String, Vec<u8>)> = snap.services.clone();
        self.restore_services(&blobs)?;
        Ok(())
    }

    pub fn restore_services(&mut self, blobs: &[(String, Vec<u8>)]) -> Result<()> {
        for svc in self.store.data_mut().services.iter_mut() {
            if let Some((_, blob)) = blobs.iter().find(|(n, _)| n == svc.name()) {
                svc.restore(blob)?;
            }
        }
        Ok(())
    }

    pub fn snapshot_services(&self) -> Vec<(String, Vec<u8>)> {
        weave_host::snapshot_services_ref(&self.store.data().services)
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Ensure memory `mem` is at least `want` bytes (grows if short).
    pub fn ensure_mem_bytes(&mut self, mem: usize, want: usize) -> Result<()> {
        let name = self.module.meta.memories[mem].clone();
        let m = self.memory(&name)?;
        let have = m.data_size(&self.store);
        if want > have {
            let grow = (want - have).div_ceil(weave_core::WASM_PAGE_SIZE);
            m.grow(&mut self.store, grow as u64).context("growing memory")?;
        }
        Ok(())
    }

    /// Write bytes into memory `mem` at `off`, growing if needed.
    pub fn write_mem(&mut self, mem: usize, off: usize, bytes: &[u8]) -> Result<()> {
        self.ensure_mem_bytes(mem, off + bytes.len())?;
        let name = self.module.meta.memories[mem].clone();
        let m = self.memory(&name)?;
        m.data_mut(&mut self.store)[off..off + bytes.len()].copy_from_slice(bytes);
        Ok(())
    }

    /// A `MemRead` view over the instance's memories (guest must be paused).
    pub fn mem_view(&mut self) -> Result<OwnedMems> {
        let mem_names = self.module.meta.memories.clone();
        let mut data = Vec::new();
        for n in &mem_names {
            let m = self.memory(n)?;
            data.push(m.data(&self.store).to_vec());
        }
        Ok(OwnedMems { data })
    }
}

fn read_val(ty: weave_core::ValType, bytes: &[u8]) -> Val {
    use weave_core::ValType as T;
    match ty {
        T::I32 => Val::I32(i32::from_le_bytes(bytes[..4].try_into().unwrap())),
        T::I64 => Val::I64(i64::from_le_bytes(bytes[..8].try_into().unwrap())),
        T::F32 => Val::F32(u32::from_le_bytes(bytes[..4].try_into().unwrap())),
        T::F64 => Val::F64(u64::from_le_bytes(bytes[..8].try_into().unwrap())),
        T::V128 => Val::V128(u128::from_le_bytes(bytes[..16].try_into().unwrap()).into()),
        T::FuncRef => Val::I32(i32::from_le_bytes(bytes[..4].try_into().unwrap())),
    }
}

/// A detached copy of every memory, implementing `MemRead`.
pub struct OwnedMems {
    pub data: Vec<Vec<u8>>,
}

impl MemRead for OwnedMems {
    fn n_mems(&self) -> usize {
        self.data.len()
    }
    fn size(&self, mem: usize) -> usize {
        self.data[mem].len()
    }
    fn read(&self, mem: usize, off: usize, buf: &mut [u8]) {
        buf.copy_from_slice(&self.data[mem][off..off + buf.len()]);
    }
}
