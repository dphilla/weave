//! `WeaveInstance`: a running (or restorable) instance of a woven module on
//! wasmtime, with checkpoint/restore and the host-side of live migration.

use crate::poll::{install_poll, Poller};
use crate::WeaveModule;
use anyhow::{anyhow, bail, Context, Result};
use std::any::Any;
use std::collections::HashSet;
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
        self.service_any[idx]
            .downcast_mut::<T>()
            .expect("service type mismatch")
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

/// Migratable services and their associated application-owned state handles.
pub type ServiceSet = (Vec<Box<dyn HostService>>, Vec<Box<dyn Any + Send>>);

/// Construct a fresh service set for a new or incoming workload.
pub type ServiceFactory<'a> = Box<dyn FnMut() -> ServiceSet + 'a>;

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
        let mut inst = Self::instantiate(engine, module, services, service_any, &mut link)?;
        // PageTracker elides pages that are all-zero on their first scan. A
        // newly instantiated module may contain active data-segment bytes, so
        // a restore target must establish the zero baseline the tracker
        // assumes before any streamed pages are applied.
        for name in module.meta.memories.clone() {
            let memory = inst.memory(&name)?;
            memory.data_mut(&mut inst.store).fill(0);
        }
        Ok(inst)
    }

    fn instantiate(
        engine: &Engine,
        module: &WeaveModule,
        services: Vec<Box<dyn HostService>>,
        service_any: Vec<Box<dyn Any + Send>>,
        link: &mut LinkFn,
    ) -> Result<WeaveInstance> {
        let wmod = Module::new(engine, &module.wasm[..]).context("compiling woven module")?;
        validate_module_abi(&wmod, &module.wasm, &module.meta)
            .context("validating woven module ABI")?;
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
        Ok(WeaveInstance {
            module: module.clone(),
            store,
            instance,
            engine: engine.clone(),
        })
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
        f.call(&mut self.store, &[], &mut [])
            .context("running __weave_resume")?;
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
            let rbase = self.get_global_i32(names::G_RBASE)? as u32 as usize;
            let base = rbase
                .checked_add(self.module.meta.globals_area_size as usize)
                .ok_or_else(|| anyhow!("results-area base overflow"))?;
            let mem = self.primary_memory()?;
            let data = mem.data(&self.store);
            for (i, ty) in entry.results.iter().enumerate() {
                let off = i
                    .checked_mul(16)
                    .and_then(|offset| base.checked_add(offset))
                    .ok_or_else(|| anyhow!("result offset overflow"))?;
                let end = off
                    .checked_add(16)
                    .ok_or_else(|| anyhow!("result end overflow"))?;
                let bytes = data
                    .get(off..end)
                    .ok_or_else(|| anyhow!("result {i} lies outside primary memory"))?;
                results[i] = read_val(*ty, bytes);
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
        let name = self
            .module
            .meta
            .memories
            .first()
            .cloned()
            .ok_or_else(|| anyhow!("module has no exported migration memory"))?;
        self.memory(&name)
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
        g.set(&mut self.store, Val::I32(v))
            .with_context(|| format!("set global {name}"))
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
        Ok(Snapshot {
            module_hash: self.module.module_hash,
            memories,
            globals,
            services,
        })
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
        if snap.memories.len() != mem_names.len() {
            bail!(
                "snapshot memory count mismatch: expected {}, got {}",
                mem_names.len(),
                snap.memories.len()
            );
        }
        if snap
            .memories
            .iter()
            .any(|memory| memory.len() % weave_core::WASM_PAGE_SIZE != 0)
        {
            bail!("snapshot contains a partial WebAssembly memory page");
        }
        let global_names: Vec<&str> = snap.globals.iter().map(|(name, _)| name.as_str()).collect();
        let expected_globals: Vec<&str> = self
            .module
            .meta
            .control_globals
            .iter()
            .map(String::as_str)
            .collect();
        if expected_globals
            .iter()
            .enumerate()
            .any(|(i, name)| expected_globals[..i].contains(name))
        {
            bail!("module metadata contains duplicate control globals");
        }
        if global_names != expected_globals {
            bail!("snapshot control-global contract mismatch");
        }
        self.validate_service_blobs(&snap.services)?;

        for (i, n) in mem_names.iter().enumerate() {
            let m = self.memory(n)?;
            let want = snap.memories[i].len();
            let have = m.data_size(&self.store);
            if want > have {
                let pages = (want - have).div_ceil(weave_core::WASM_PAGE_SIZE);
                m.grow(&mut self.store, pages as u64)
                    .context("growing memory for restore")?;
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
        self.validate_service_blobs(blobs)?;
        for svc in self.store.data_mut().services.iter_mut() {
            let (_, blob) = blobs
                .iter()
                .find(|(name, _)| name == svc.name())
                .expect("validated service set must contain every service");
            svc.restore(blob)?;
        }
        Ok(())
    }

    fn validate_service_blobs(&self, blobs: &[(String, Vec<u8>)]) -> Result<()> {
        let actual: Vec<&str> = blobs.iter().map(|(name, _)| name.as_str()).collect();
        let expected = self.service_names();
        let expected: Vec<&str> = expected.iter().map(String::as_str).collect();
        if expected.windows(2).any(|pair| pair[0] == pair[1]) {
            bail!("duplicate registered host-service name");
        }
        if actual != expected {
            bail!("host-service contract mismatch");
        }
        Ok(())
    }

    /// Registered stateful-service names in canonical wire order.
    pub fn service_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .store
            .data()
            .services
            .iter()
            .map(|service| service.name().to_string())
            .collect();
        names.sort();
        names
    }

    pub fn snapshot_services(&self) -> Vec<(String, Vec<u8>)> {
        weave_host::snapshot_services_ref(&self.store.data().services)
    }

    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Ensure memory `mem` is at least `want` bytes (grows if short).
    pub fn ensure_mem_bytes(&mut self, mem: usize, want: usize) -> Result<()> {
        let name = self
            .module
            .meta
            .memories
            .get(mem)
            .cloned()
            .ok_or_else(|| anyhow!("memory index {mem} out of bounds"))?;
        let m = self.memory(&name)?;
        let have = m.data_size(&self.store);
        if want > have {
            let grow = (want - have).div_ceil(weave_core::WASM_PAGE_SIZE);
            m.grow(&mut self.store, grow as u64)
                .context("growing memory")?;
        }
        Ok(())
    }

    /// Write bytes into memory `mem` at `off`, growing if needed.
    pub fn write_mem(&mut self, mem: usize, off: usize, bytes: &[u8]) -> Result<()> {
        let end = off
            .checked_add(bytes.len())
            .ok_or_else(|| anyhow!("memory write range overflow"))?;
        self.ensure_mem_bytes(mem, end)?;
        let name = self
            .module
            .meta
            .memories
            .get(mem)
            .cloned()
            .ok_or_else(|| anyhow!("memory index {mem} out of bounds"))?;
        let m = self.memory(&name)?;
        m.data_mut(&mut self.store)[off..end].copy_from_slice(bytes);
        Ok(())
    }

    /// A zero-copy `MemRead` view over the instance's memories. The returned
    /// view borrows the store, so the type system keeps the guest paused and
    /// prevents mutation until the scan has finished.
    pub fn mem_view(&mut self) -> Result<BorrowedMems<'_>> {
        let mem_names = self.module.meta.memories.clone();
        let mut memories = Vec::with_capacity(mem_names.len());
        for n in &mem_names {
            memories.push(self.memory(n)?);
        }
        Ok(BorrowedMems {
            memories,
            store: &self.store,
        })
    }
}

fn core_value_type(value: wasmtime::ValType) -> Result<weave_core::ValType> {
    Ok(match value {
        wasmtime::ValType::I32 => weave_core::ValType::I32,
        wasmtime::ValType::I64 => weave_core::ValType::I64,
        wasmtime::ValType::F32 => weave_core::ValType::F32,
        wasmtime::ValType::F64 => weave_core::ValType::F64,
        wasmtime::ValType::V128 => weave_core::ValType::V128,
        wasmtime::ValType::Ref(reference)
            if matches!(
                reference.heap_type(),
                wasmtime::HeapType::Func
                    | wasmtime::HeapType::ConcreteFunc(_)
                    | wasmtime::HeapType::NoFunc
            ) =>
        {
            weave_core::ValType::FuncRef
        }
        other => bail!("unsupported value type in exported function signature: {other}"),
    })
}

fn validate_function_export(
    module: &Module,
    name: &str,
    expected_params: &[weave_core::ValType],
    expected_results: &[weave_core::ValType],
) -> Result<()> {
    let function = match module.get_export(name) {
        Some(wasmtime::ExternType::Func(function)) => function,
        Some(_) => bail!("module export {name} is not a function"),
        None => bail!("module has no exported function {name}"),
    };
    let actual_params = function
        .params()
        .map(core_value_type)
        .collect::<Result<Vec<_>>>()?;
    let actual_results = function
        .results()
        .map(core_value_type)
        .collect::<Result<Vec<_>>>()?;
    if actual_params != expected_params || actual_results != expected_results {
        bail!(
            "exported function {name} signature mismatch: weave.meta expects {expected_params:?} -> {expected_results:?}, module has {actual_params:?} -> {actual_results:?}"
        );
    }
    Ok(())
}

fn validate_memory_exports(wasm: &[u8], expected_names: &[String]) -> Result<()> {
    let mut memory_count = 0usize;
    let mut exports = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload? {
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports {
                    if matches!(import?.ty, wasmparser::TypeRef::Memory(_)) {
                        memory_count = memory_count
                            .checked_add(1)
                            .ok_or_else(|| anyhow!("module memory count overflow"))?;
                    }
                }
            }
            wasmparser::Payload::MemorySection(memories) => {
                for memory in memories {
                    memory?;
                    memory_count = memory_count
                        .checked_add(1)
                        .ok_or_else(|| anyhow!("module memory count overflow"))?;
                }
            }
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if export.kind == wasmparser::ExternalKind::Memory {
                        exports.push((export.name.to_owned(), export.index));
                    }
                }
            }
            wasmparser::Payload::StartSection { .. } => {
                bail!("woven migration module must not contain a start section");
            }
            _ => {}
        }
    }

    if expected_names.len() != memory_count {
        bail!(
            "weave.meta memory count mismatch: module has {memory_count} memories, metadata lists {}",
            expected_names.len()
        );
    }
    let mut unique_names = HashSet::with_capacity(expected_names.len());
    for name in expected_names {
        if !unique_names.insert(name.as_str()) {
            bail!("weave.meta contains duplicate memory export {name}");
        }
    }
    // The transformer preserves extra export aliases, while weave.meta records
    // one canonical name per memory index. Require every canonical mapping;
    // aliases do not weaken or alter that index contract.
    for (index, expected) in expected_names.iter().enumerate() {
        let actual_index = exports
            .iter()
            .find_map(|(name, actual_index)| (name == expected).then_some(*actual_index))
            .ok_or_else(|| {
                anyhow!("weave.meta memory {index} names {expected}, which is not a memory export")
            })?;
        let actual_index =
            usize::try_from(actual_index).context("memory export index does not fit this host")?;
        if actual_index != index {
            bail!(
                "weave.meta memory {index} names export {expected}, but that export refers to memory {actual_index}"
            );
        }
    }
    Ok(())
}

fn fixed_control_globals() -> [&'static str; 8] {
    [
        names::G_STATE,
        names::G_FLAG,
        names::G_ENTRY,
        names::G_CTR,
        names::G_SP,
        names::G_STACK_BASE,
        names::G_STACK_END,
        names::G_RBASE,
    ]
}

fn validate_control_global_names(module: &Module, meta: &weave_core::Meta) -> Result<()> {
    let mut unique = HashSet::with_capacity(meta.control_globals.len());
    for name in &meta.control_globals {
        if !unique.insert(name.as_str()) {
            bail!("weave.meta contains duplicate control global {name}");
        }
    }

    let fixed = fixed_control_globals();
    if meta.control_globals.len() < fixed.len()
        || !meta.control_globals[..fixed.len()]
            .iter()
            .map(String::as_str)
            .eq(fixed)
    {
        bail!("weave.meta control globals do not have the required fixed prefix/order");
    }

    let shadows = &meta.control_globals[fixed.len()..];
    if shadows.len() % 2 != 0 {
        bail!("weave.meta table-shadow control globals are incomplete");
    }
    let table_count = shadows.len() / 2;
    for table in 0..table_count {
        if shadows[table] != format!("__weave_tsh{table}")
            || shadows[table_count + table] != format!("__weave_tshcap{table}")
        {
            bail!("weave.meta table-shadow control globals are out of order");
        }
    }

    let actual: Vec<String> = module
        .exports()
        .filter_map(|export| {
            (export.name().starts_with("__weave")
                && matches!(export.ty(), wasmtime::ExternType::Global(_)))
            .then(|| export.name().to_owned())
        })
        .collect();
    if actual != meta.control_globals {
        bail!(
            "weave.meta control globals do not match the module's complete injected global-export set"
        );
    }
    Ok(())
}

fn validate_meta_layout(meta: &weave_core::Meta) -> Result<()> {
    let result_slots = meta
        .entries
        .iter()
        .map(|entry| entry.results.len())
        .max()
        .unwrap_or(0);
    let expected_results = result_slots
        .checked_mul(16)
        .and_then(|bytes| u32::try_from(bytes).ok())
        .ok_or_else(|| anyhow!("weave.meta results-area size overflows u32"))?;
    if meta.results_area_size != expected_results {
        bail!(
            "weave.meta results-area size mismatch: expected {expected_results}, got {}",
            meta.results_area_size
        );
    }
    if meta.globals_area_size % 16 != 0 {
        bail!("weave.meta globals-area size is not 16-byte aligned");
    }
    Ok(())
}

fn validate_module_abi(module: &Module, wasm: &[u8], meta: &weave_core::Meta) -> Result<()> {
    validate_meta_layout(meta)?;
    validate_function_export(module, names::F_INIT, &[], &[])?;
    validate_function_export(module, names::F_RESUME, &[], &[])?;

    let mut entry_names = HashSet::with_capacity(meta.entries.len());
    for entry in &meta.entries {
        if entry.name == names::F_INIT || entry.name == names::F_RESUME {
            bail!(
                "weave.meta entry {} collides with a runtime export",
                entry.name
            );
        }
        if !entry_names.insert(entry.name.as_str()) {
            bail!("weave.meta contains duplicate entry {}", entry.name);
        }
        validate_function_export(module, &entry.name, &entry.params, &entry.results)?;
    }

    validate_control_global_names(module, meta)?;
    for name in &meta.control_globals {
        let global = match module.get_export(name) {
            Some(wasmtime::ExternType::Global(global)) => global,
            Some(_) => bail!("control-global export {name} is not a global"),
            None => bail!("module has no exported control global {name}"),
        };
        if !global.content().is_i32() || !global.mutability().is_var() {
            bail!("exported control global {name} must be mutable i32");
        }
    }

    validate_memory_exports(wasm, &meta.memories)
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

/// A borrowed Wasmtime memory view. It stores only lightweight memory handles
/// and a store reference; guest bytes are copied solely into each caller's
/// bounded scan buffer.
pub struct BorrowedMems<'a> {
    memories: Vec<Memory>,
    store: &'a Store<Ctx>,
}

impl MemRead for BorrowedMems<'_> {
    fn n_mems(&self) -> usize {
        self.memories.len()
    }
    fn size(&self, mem: usize) -> usize {
        self.memories[mem].data_size(self.store)
    }
    fn read(&self, mem: usize, off: usize, buf: &mut [u8]) {
        buf.copy_from_slice(&self.memories[mem].data(self.store)[off..off + buf.len()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use weave_core::meta::EntryMeta;
    use weave_core::{Meta, ValType, WEAVE_VERSION};

    const VALID_ABI: &str = r#"
        (module
          (memory (export "memory") 1)
          (global (export "__weave_state") (mut i32) (i32.const 0))
          (global (export "__weave_flag") (mut i32) (i32.const 0))
          (global (export "__weave_entry") (mut i32) (i32.const 0))
          (global (export "__weave_ctr") (mut i32) (i32.const 0))
          (global (export "__weave_sp") (mut i32) (i32.const 0))
          (global (export "__weave_stack_base") (mut i32) (i32.const 0))
          (global (export "__weave_stack_end") (mut i32) (i32.const 0))
          (global (export "__weave_rbase") (mut i32) (i32.const 0))
          (func (export "__weave_init"))
          (func (export "__weave_resume"))
          (func (export "run") (param i32) (result i64)
            local.get 0
            i64.extend_i32_s))
    "#;

    fn contract_meta() -> Meta {
        Meta {
            version: WEAVE_VERSION,
            poll_period: 1,
            entries: vec![EntryMeta {
                name: "run".to_owned(),
                params: vec![ValType::I32],
                results: vec![ValType::I64],
            }],
            memories: vec!["memory".to_owned()],
            imports: vec![],
            control_globals: fixed_control_globals()
                .into_iter()
                .map(str::to_owned)
                .collect(),
            globals_area_size: 0,
            results_area_size: 16,
        }
    }

    fn validate_wat(wat: &str, meta: &Meta) -> Result<()> {
        let wasm = wat::parse_str(wat)?;
        let engine = crate::default_engine()?;
        let module = Module::new(&engine, &wasm)?;
        validate_module_abi(&module, &wasm, meta)
    }

    #[test]
    fn valid_module_abi_is_accepted() {
        validate_wat(VALID_ABI, &contract_meta()).unwrap();
    }

    #[test]
    fn start_section_is_rejected_before_guest_code_can_execute() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        let with_import = VALID_ABI.replacen(
            "(module",
            "(module (import \"audit\" \"effect\" (func $effect))",
            1,
        );
        let with_start = with_import.replacen(
            "(func (export \"__weave_init\"))",
            "(func $start call $effect) (start $start) (func (export \"__weave_init\"))",
            1,
        );
        let wasm = wat::parse_str(with_start).unwrap();
        let woven = WeaveModule::from_transformed(wasm, contract_meta());
        let engine = crate::default_engine().unwrap();
        let effects = Arc::new(AtomicUsize::new(0));
        let effects_for_link = effects.clone();
        let link: LinkFn = Box::new(move |linker| {
            let effects = effects_for_link.clone();
            linker.func_wrap("audit", "effect", move || {
                effects.fetch_add(1, Ordering::SeqCst);
            })?;
            Ok(())
        });

        let error = WeaveInstance::new_restored(&engine, &woven, vec![], vec![], link)
            .err()
            .expect("a migration target must reject a start section");
        assert!(format!("{error:#}").contains("must not contain a start section"));
        assert_eq!(effects.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn runtime_exports_require_exact_void_signatures() {
        let bad_init = r#"
            (module
              (memory (export "memory") 1)
              (global (export "__weave_state") (mut i32) (i32.const 0))
              (global (export "__weave_flag") (mut i32) (i32.const 0))
              (global (export "__weave_entry") (mut i32) (i32.const 0))
              (global (export "__weave_ctr") (mut i32) (i32.const 0))
              (global (export "__weave_sp") (mut i32) (i32.const 0))
              (global (export "__weave_stack_base") (mut i32) (i32.const 0))
              (global (export "__weave_stack_end") (mut i32) (i32.const 0))
              (global (export "__weave_rbase") (mut i32) (i32.const 0))
              (func (export "__weave_init") (result i32) (i32.const 0))
              (func (export "__weave_resume"))
              (func (export "run") (param i32) (result i64)
                local.get 0 i64.extend_i32_s))
        "#;
        let error = validate_wat(bad_init, &contract_meta()).unwrap_err();
        assert!(format!("{error:#}").contains("__weave_init signature mismatch"));

        let bad_resume = r#"
            (module
              (memory (export "memory") 1)
              (global (export "__weave_state") (mut i32) (i32.const 0))
              (global (export "__weave_flag") (mut i32) (i32.const 0))
              (global (export "__weave_entry") (mut i32) (i32.const 0))
              (global (export "__weave_ctr") (mut i32) (i32.const 0))
              (global (export "__weave_sp") (mut i32) (i32.const 0))
              (global (export "__weave_stack_base") (mut i32) (i32.const 0))
              (global (export "__weave_stack_end") (mut i32) (i32.const 0))
              (global (export "__weave_rbase") (mut i32) (i32.const 0))
              (func (export "__weave_init"))
              (func (export "__weave_resume") (param i32))
              (func (export "run") (param i32) (result i64)
                local.get 0 i64.extend_i32_s))
        "#;
        let wasm = wat::parse_str(bad_resume).unwrap();
        let woven = WeaveModule::from_transformed(wasm, contract_meta());
        let engine = crate::default_engine().unwrap();
        let link: LinkFn = Box::new(|_| Ok(()));
        let error = WeaveInstance::new_restored(&engine, &woven, vec![], vec![], link)
            .err()
            .expect("restored instantiation must reject a forged resume signature");
        assert!(format!("{error:#}").contains("__weave_resume signature mismatch"));
    }

    #[test]
    fn entry_export_must_match_forged_meta_params_and_results() {
        let mut bad_params = contract_meta();
        bad_params.entries[0].params = vec![ValType::I64];
        let error = validate_wat(VALID_ABI, &bad_params).unwrap_err();
        assert!(format!("{error:#}").contains("run signature mismatch"));

        let mut bad_results = contract_meta();
        bad_results.entries[0].results = vec![ValType::I32];
        let error = validate_wat(VALID_ABI, &bad_results).unwrap_err();
        assert!(format!("{error:#}").contains("run signature mismatch"));

        let mut bad_result_area = contract_meta();
        bad_result_area.results_area_size = 0;
        let error = validate_wat(VALID_ABI, &bad_result_area).unwrap_err();
        assert!(format!("{error:#}").contains("results-area size mismatch"));

        let mut unaligned_globals = contract_meta();
        unaligned_globals.globals_area_size = 1;
        let error = validate_wat(VALID_ABI, &unaligned_globals).unwrap_err();
        assert!(format!("{error:#}").contains("globals-area size is not 16-byte aligned"));
    }

    #[test]
    fn control_globals_must_be_unique_mutable_i32_exports() {
        let mut duplicate = contract_meta();
        duplicate.control_globals.push(names::G_STATE.to_owned());
        let error = validate_wat(VALID_ABI, &duplicate).unwrap_err();
        assert!(format!("{error:#}").contains("duplicate control global"));

        let immutable = VALID_ABI.replacen("(mut i32)", "i32", 1);
        let error = validate_wat(&immutable, &contract_meta()).unwrap_err();
        assert!(format!("{error:#}").contains("must be mutable i32"));

        let wrong_type =
            VALID_ABI.replacen("(mut i32) (i32.const 0)", "(mut i64) (i64.const 0)", 1);
        let error = validate_wat(&wrong_type, &contract_meta()).unwrap_err();
        assert!(format!("{error:#}").contains("must be mutable i32"));

        let mut omitted = contract_meta();
        omitted.control_globals.remove(3);
        let error = validate_wat(VALID_ABI, &omitted).unwrap_err();
        assert!(format!("{error:#}").contains("required fixed prefix/order"));

        let mut reversed = contract_meta();
        reversed.control_globals.swap(0, 1);
        let error = validate_wat(VALID_ABI, &reversed).unwrap_err();
        assert!(format!("{error:#}").contains("required fixed prefix/order"));
    }

    #[test]
    fn every_memory_requires_one_correctly_indexed_recorded_export() {
        let omitted = r#"
            (module
              (memory (export "first") 1)
              (memory 1)
              (global (export "__weave_state") (mut i32) (i32.const 0))
              (global (export "__weave_flag") (mut i32) (i32.const 0))
              (global (export "__weave_entry") (mut i32) (i32.const 0))
              (global (export "__weave_ctr") (mut i32) (i32.const 0))
              (global (export "__weave_sp") (mut i32) (i32.const 0))
              (global (export "__weave_stack_base") (mut i32) (i32.const 0))
              (global (export "__weave_stack_end") (mut i32) (i32.const 0))
              (global (export "__weave_rbase") (mut i32) (i32.const 0))
              (func (export "__weave_init"))
              (func (export "__weave_resume"))
              (func (export "run") (param i32) (result i64)
                local.get 0 i64.extend_i32_s))
        "#;
        let mut two_memories = contract_meta();
        two_memories.memories = vec!["first".to_owned(), "second".to_owned()];
        let error = validate_wat(omitted, &two_memories).unwrap_err();
        assert!(format!("{error:#}").contains("second, which is not a memory export"));

        let reversed = r#"
            (module
              (memory $first 1)
              (memory $second 1)
              (export "second" (memory $first))
              (export "first" (memory $second))
              (global (export "__weave_state") (mut i32) (i32.const 0))
              (global (export "__weave_flag") (mut i32) (i32.const 0))
              (global (export "__weave_entry") (mut i32) (i32.const 0))
              (global (export "__weave_ctr") (mut i32) (i32.const 0))
              (global (export "__weave_sp") (mut i32) (i32.const 0))
              (global (export "__weave_stack_base") (mut i32) (i32.const 0))
              (global (export "__weave_stack_end") (mut i32) (i32.const 0))
              (global (export "__weave_rbase") (mut i32) (i32.const 0))
              (func (export "__weave_init"))
              (func (export "__weave_resume"))
              (func (export "run") (param i32) (result i64)
                local.get 0 i64.extend_i32_s))
        "#;
        let error = validate_wat(reversed, &two_memories).unwrap_err();
        assert!(format!("{error:#}").contains("export first, but that export refers to memory 1"));

        let aliased = VALID_ABI.replace(
            "(memory (export \"memory\") 1)",
            "(memory (export \"memory\") (export \"alias\") 1)",
        );
        validate_wat(&aliased, &contract_meta()).unwrap();
    }
}
