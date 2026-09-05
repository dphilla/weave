use crate::control::Shared;
use crate::ffi;
use crate::services::EmitServices;
use anyhow::{anyhow, bail, Context, Result};
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_void, CStr, CString};
use std::ptr;
use std::sync::Arc;
use weave_core::names;
use weave_core::sha256::sha256;
use weave_core::{Meta, Val, ValType, WPAGE_SIZE};
use weave_host::source::{SourceMigration, SourceOptions};
use weave_host::MemRead;

const ERROR_BUF_SIZE: usize = 512;
pub const DEFAULT_STACK_SIZE: u32 = 1024 * 1024;
#[cfg(test)]
pub(crate) static EXECUTION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

static WEAVE_MODULE: &[u8] = b"weave\0";
static ENV_MODULE: &[u8] = b"env\0";
static POLL_NAME: &[u8] = b"poll\0";
static POLL_SIG: &[u8] = b"()i\0";
static EMIT_NAME: &[u8] = b"emit\0";
static EMIT_SIG: &[u8] = b"(iI)\0";
static EMIT32_NAME: &[u8] = b"emit32\0";
static EMIT32_SIG: &[u8] = b"(i)\0";
static EMIT64_NAME: &[u8] = b"emit64\0";
static EMIT64_SIG: &[u8] = b"(I)\0";

pub struct RuntimeGuard;

impl RuntimeGuard {
    pub fn initialize() -> Result<Self> {
        // SAFETY: process-global WAMR initialization occurs exactly once in main.
        if !unsafe { ffi::wasm_runtime_init() } {
            bail!("WAMR runtime initialization failed");
        }

        if let Err(error) = register_natives() {
            // SAFETY: initialization succeeded and no module exists yet.
            unsafe { ffi::wasm_runtime_destroy() };
            return Err(error);
        }
        Ok(Self)
    }
}

impl Drop for RuntimeGuard {
    fn drop(&mut self) {
        // SAFETY: all instances are scoped below this guard in main.
        unsafe { ffi::wasm_runtime_destroy() };
    }
}

fn native(
    symbol: &'static [u8],
    function: *mut c_void,
    signature: &'static [u8],
) -> ffi::NativeSymbol {
    ffi::NativeSymbol {
        symbol: symbol.as_ptr().cast(),
        func_ptr: function,
        signature: signature.as_ptr().cast(),
        attachment: ptr::null_mut(),
    }
}

fn register_natives() -> Result<()> {
    // WAMR retains and may mutate NativeSymbol arrays, so intentionally leak
    // these two tiny process-lifetime allocations.
    let weave = Box::leak(Box::new([native(
        POLL_NAME,
        poll_native as *const () as *mut c_void,
        POLL_SIG,
    )]));
    let env = Box::leak(Box::new([
        native(EMIT_NAME, emit_native as *const () as *mut c_void, EMIT_SIG),
        native(
            EMIT32_NAME,
            emit32_native as *const () as *mut c_void,
            EMIT32_SIG,
        ),
        native(
            EMIT64_NAME,
            emit64_native as *const () as *mut c_void,
            EMIT64_SIG,
        ),
    ]));

    // SAFETY: module names and symbol strings are static NUL-terminated data;
    // the leaked writable arrays remain valid for WAMR's lifetime.
    if !unsafe {
        ffi::wasm_runtime_register_natives(
            WEAVE_MODULE.as_ptr().cast(),
            weave.as_mut_ptr(),
            weave.len() as u32,
        )
    } {
        bail!("registering native weave.poll with WAMR failed");
    }
    // SAFETY: same lifetime argument as above.
    if !unsafe {
        ffi::wasm_runtime_register_natives(
            ENV_MODULE.as_ptr().cast(),
            env.as_mut_ptr(),
            env.len() as u32,
        )
    } {
        bail!("registering native env.emit services with WAMR failed");
    }
    Ok(())
}

#[derive(Clone)]
pub struct ModuleImage {
    pub wasm: Arc<Vec<u8>>,
    pub meta: Meta,
    pub meta_bytes: Vec<u8>,
    pub hash: [u8; 32],
    pub initial_memory_bytes: u64,
}

impl ModuleImage {
    pub fn parse(bytes: Vec<u8>) -> Result<Self> {
        if bytes.len() > u32::MAX as usize {
            bail!("WAMR cannot load modules larger than 4 GiB");
        }
        let (meta, meta_bytes) = extract_meta(&bytes)?;
        validate_exported_function_signatures(&bytes, &meta)?;
        validate_module_state_abi(&bytes, &meta)?;
        validate_meta_layout(&meta)?;
        let initial_memory_bytes = declared_initial_memory_bytes(&bytes)?;
        check_imports(&meta)?;
        Ok(Self {
            hash: sha256(&bytes),
            wasm: Arc::new(bytes),
            meta,
            meta_bytes,
            initial_memory_bytes,
        })
    }
}

fn core_value_type(value: wasmparser::ValType) -> Result<ValType> {
    Ok(match value {
        wasmparser::ValType::I32 => ValType::I32,
        wasmparser::ValType::I64 => ValType::I64,
        wasmparser::ValType::F32 => ValType::F32,
        wasmparser::ValType::F64 => ValType::F64,
        wasmparser::ValType::V128 => ValType::V128,
        wasmparser::ValType::Ref(reference) if reference.is_func_ref() => ValType::FuncRef,
        other => bail!("unsupported value type in exported function signature: {other}"),
    })
}

fn validate_exported_function_signatures(wasm: &[u8], meta: &Meta) -> Result<()> {
    let mut types = Vec::new();
    let mut function_types = Vec::new();
    let mut exports = HashMap::new();

    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload? {
            wasmparser::Payload::TypeSection(section) => {
                for function_type in section.into_iter_err_on_gc_types() {
                    types.push(function_type?);
                }
            }
            wasmparser::Payload::ImportSection(section) => {
                for import in section {
                    if let wasmparser::TypeRef::Func(type_index) = import?.ty {
                        function_types.push(type_index);
                    }
                }
            }
            wasmparser::Payload::FunctionSection(section) => {
                for type_index in section {
                    function_types.push(type_index?);
                }
            }
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    if exports
                        .insert(export.name.to_owned(), (export.kind, export.index))
                        .is_some()
                    {
                        bail!("module contains duplicate export {}", export.name);
                    }
                }
            }
            _ => {}
        }
    }

    let check = |name: &str, expected_params: &[ValType], expected_results: &[ValType]| {
        let (kind, function_index) = exports
            .get(name)
            .copied()
            .ok_or_else(|| anyhow!("module has no exported function {name}"))?;
        if kind != wasmparser::ExternalKind::Func {
            bail!("module export {name} is not a function");
        }
        let type_index = function_types
            .get(function_index as usize)
            .copied()
            .ok_or_else(|| anyhow!("exported function {name} has an invalid function index"))?;
        let function_type = types
            .get(type_index as usize)
            .ok_or_else(|| anyhow!("exported function {name} has an invalid type index"))?;
        let actual_params = function_type
            .params()
            .iter()
            .copied()
            .map(core_value_type)
            .collect::<Result<Vec<_>>>()?;
        let actual_results = function_type
            .results()
            .iter()
            .copied()
            .map(core_value_type)
            .collect::<Result<Vec<_>>>()?;
        if actual_params != expected_params || actual_results != expected_results {
            bail!(
                "exported function {name} signature mismatch: weave.meta expects {expected_params:?} -> {expected_results:?}, module has {actual_params:?} -> {actual_results:?}"
            );
        }
        Ok(())
    };

    check(names::F_INIT, &[], &[])?;
    check(names::F_RESUME, &[], &[])?;
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
        check(&entry.name, &entry.params, &entry.results)?;
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

fn validate_control_global_names(actual: &[String], meta: &Meta) -> Result<()> {
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
    if actual != meta.control_globals {
        bail!(
            "weave.meta control globals do not match the module's complete injected global-export set"
        );
    }
    Ok(())
}

fn validate_module_state_abi(wasm: &[u8], meta: &Meta) -> Result<()> {
    let mut memory_count = 0usize;
    let mut globals = Vec::new();
    let mut memory_exports = Vec::new();
    let mut global_exports = Vec::new();

    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload? {
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports {
                    match import?.ty {
                        wasmparser::TypeRef::Memory(_) => {
                            memory_count = memory_count
                                .checked_add(1)
                                .ok_or_else(|| anyhow!("module memory count overflow"))?;
                        }
                        wasmparser::TypeRef::Global(global) => globals.push(global),
                        _ => {}
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
            wasmparser::Payload::GlobalSection(section) => {
                for global in section {
                    globals.push(global?.ty);
                }
            }
            wasmparser::Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    match export.kind {
                        wasmparser::ExternalKind::Memory => {
                            memory_exports.push((export.name.to_owned(), export.index));
                        }
                        wasmparser::ExternalKind::Global => {
                            global_exports.push((export.name.to_owned(), export.index));
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if meta.memories.len() != memory_count {
        bail!(
            "weave.meta memory count mismatch: module has {memory_count} memories, metadata lists {}",
            meta.memories.len()
        );
    }
    let mut memory_names = HashSet::with_capacity(meta.memories.len());
    for name in &meta.memories {
        if !memory_names.insert(name.as_str()) {
            bail!("weave.meta contains duplicate memory export {name}");
        }
    }
    for (index, expected) in meta.memories.iter().enumerate() {
        let actual_index = memory_exports
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

    let actual_controls: Vec<String> = global_exports
        .iter()
        .filter_map(|(name, _)| name.starts_with("__weave").then_some(name.clone()))
        .collect();
    validate_control_global_names(&actual_controls, meta)?;
    for name in &meta.control_globals {
        let global_index = global_exports
            .iter()
            .find_map(|(actual, index)| (actual == name).then_some(*index))
            .ok_or_else(|| anyhow!("module has no exported control global {name}"))?;
        let global = globals
            .get(global_index as usize)
            .ok_or_else(|| anyhow!("control global {name} has an invalid global index"))?;
        if global.content_type != wasmparser::ValType::I32 || !global.mutable || global.shared {
            bail!("exported control global {name} must be unshared mutable i32");
        }
    }
    Ok(())
}

fn validate_meta_layout(meta: &Meta) -> Result<()> {
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

fn declared_initial_memory_bytes(wasm: &[u8]) -> Result<u64> {
    fn add_memory(total: &mut u64, memory: wasmparser::MemoryType) -> Result<()> {
        let page_size_log2 = memory.page_size_log2.unwrap_or(16);
        let page_size = 1u64.checked_shl(page_size_log2).ok_or_else(|| {
            anyhow!("declared memory page size 2^{page_size_log2} does not fit u64")
        })?;
        let bytes = memory.initial.checked_mul(page_size).ok_or_else(|| {
            anyhow!(
                "declared initial memory of {} pages at {page_size} bytes per page overflows u64",
                memory.initial
            )
        })?;
        *total = total
            .checked_add(bytes)
            .ok_or_else(|| anyhow!("aggregate declared initial memory size overflows u64"))?;
        Ok(())
    }

    let mut total = 0u64;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload? {
            wasmparser::Payload::ImportSection(imports) => {
                for import in imports {
                    if let wasmparser::TypeRef::Memory(memory) = import?.ty {
                        add_memory(&mut total, memory)?;
                    }
                }
            }
            wasmparser::Payload::MemorySection(memories) => {
                for memory in memories {
                    add_memory(&mut total, memory?)?;
                }
            }
            _ => {}
        }
    }
    Ok(total)
}

fn extract_meta(wasm: &[u8]) -> Result<(Meta, Vec<u8>)> {
    let mut found = None;
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        match payload? {
            wasmparser::Payload::StartSection { .. } => {
                bail!("Wasm start sections are forbidden because they execute before migration commit");
            }
            wasmparser::Payload::CustomSection(section) => {
                if section.name() == names::META_SECTION {
                    if found.is_some() {
                        bail!(
                            "module contains more than one {} section",
                            names::META_SECTION
                        );
                    }
                    let raw = section.data().to_vec();
                    found = Some((Meta::decode(&raw)?, raw));
                }
            }
            _ => {}
        }
    }
    found.ok_or_else(|| {
        anyhow!(
            "module has no {} section; transform it with `weave transform` first",
            names::META_SECTION
        )
    })
}

pub fn check_imports(meta: &Meta) -> Result<()> {
    for import in &meta.imports {
        let expected: Option<&[ValType]> = match (import.module.as_str(), import.name.as_str()) {
            ("env", "emit") => Some(&[ValType::I32, ValType::I64]),
            ("env", "emit32") => Some(&[ValType::I32]),
            ("env", "emit64") => Some(&[ValType::I64]),
            _ => None,
        };
        let Some(expected) = expected else {
            bail!(
                "module imports {}.{}, but weave-wamr only provides env.emit, env.emit32, and env.emit64",
                import.module,
                import.name
            );
        };
        if import.params != expected || !import.results.is_empty() {
            bail!(
                "host import {}.{} has an incompatible signature",
                import.module,
                import.name
            );
        }
    }
    Ok(())
}

enum PollState {
    Run,
    Migrating(Box<SourceMigration>),
    Errored(String),
}

struct HostState {
    wasm: Arc<Vec<u8>>,
    meta_bytes: Vec<u8>,
    n_mems: usize,
    services: EmitServices,
    poll: PollState,
    shared: Option<Shared>,
    source_options: SourceOptions,
    #[cfg(test)]
    polls_until_checkpoint: Option<usize>,
}

pub enum TakenPoll {
    Run,
    Migrating(SourceMigration),
    Errored(String),
}

#[derive(Debug)]
pub enum WorkResult {
    Done(Vec<Val>),
    Unwound,
}

pub struct WamrInstance {
    pub image: ModuleImage,
    module: ffi::WasmModule,
    module_inst: ffi::WasmModuleInst,
    exec_env: ffi::WasmExecEnv,
    // WAMR may modify and references this buffer until module unload.
    _load_buffer: Box<[u8]>,
    // WAMR custom_data points into this stable allocation.
    host: Box<HostState>,
}

impl WamrInstance {
    pub fn instantiate(
        image: ModuleImage,
        stack_size: u32,
        shared: Option<Shared>,
        source_options: SourceOptions,
    ) -> Result<Self> {
        check_imports(&image.meta)?;
        let mut load_buffer = image.wasm.as_slice().to_vec().into_boxed_slice();
        let mut error = [0 as c_char; ERROR_BUF_SIZE];

        // SAFETY: load_buffer is writable, has u32-bounded length, and is held
        // until wasm_runtime_unload in Drop.
        let module = unsafe {
            ffi::wasm_runtime_load(
                load_buffer.as_mut_ptr(),
                load_buffer.len() as u32,
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        if module.is_null() {
            bail!("loading module in WAMR failed: {}", error_text(&error));
        }

        error.fill(0);
        // SAFETY: module is a live WAMR module. A zero host-managed heap does
        // not change the guest's declared linear memories.
        let module_inst = unsafe {
            ffi::wasm_runtime_instantiate(
                module,
                stack_size,
                0,
                error.as_mut_ptr(),
                error.len() as u32,
            )
        };
        if module_inst.is_null() {
            // SAFETY: module was successfully loaded above.
            unsafe { ffi::wasm_runtime_unload(module) };
            bail!(
                "instantiating module in WAMR failed: {}",
                error_text(&error)
            );
        }

        let mut host = Box::new(HostState {
            wasm: image.wasm.clone(),
            meta_bytes: image.meta_bytes.clone(),
            n_mems: image.meta.memories.len(),
            services: EmitServices::default(),
            poll: PollState::Run,
            shared,
            source_options,
            #[cfg(test)]
            polls_until_checkpoint: None,
        });
        // SAFETY: host is boxed (stable address) and outlives module_inst.
        unsafe {
            ffi::wasm_runtime_set_custom_data(
                module_inst,
                (&mut *host as *mut HostState).cast::<c_void>(),
            )
        };

        // SAFETY: module_inst is live and stack_size is nonzero (validated by WAMR).
        let exec_env = unsafe { ffi::wasm_runtime_create_exec_env(module_inst, stack_size) };
        if exec_env.is_null() {
            // SAFETY: tear down in reverse construction order.
            unsafe {
                ffi::wasm_runtime_set_custom_data(module_inst, ptr::null_mut());
                ffi::wasm_runtime_deinstantiate(module_inst);
                ffi::wasm_runtime_unload(module);
            }
            bail!("creating WAMR execution environment failed");
        }

        let instance = Self {
            image,
            module,
            module_inst,
            exec_env,
            _load_buffer: load_buffer,
            host,
        };
        instance.validate_exports()?;
        Ok(instance)
    }

    fn validate_exports(&self) -> Result<()> {
        for name in [&names::F_INIT, &names::F_RESUME] {
            self.lookup_function(name)?;
        }
        for name in &self.image.meta.memories {
            // Validate both the recorded export's C-string representability and
            // the indexed memory WAMR API used by migration.
            CString::new(name.as_str())
                .with_context(|| format!("memory export {name:?} contains NUL"))?;
        }
        for index in 0..self.image.meta.memories.len() {
            self.memory(index)?;
        }
        for name in &self.image.meta.control_globals {
            self.global(name, false)?;
        }
        Ok(())
    }

    pub fn initialize_fresh(&mut self) -> Result<()> {
        self.call_no_args(names::F_INIT)
            .context("running __weave_init")
    }

    /// Establish the protocol's all-zero target baseline. WAMR applies active
    /// data segments during instantiation; leaving those bytes in place would
    /// make PageTracker's first-round zero-page elision preserve stale data.
    pub fn prepare_restore(&mut self) -> Result<()> {
        for index in 0..self.image.meta.memories.len() {
            let memory = self.memory(index)?;
            let size = memory_size(memory)?;
            let base = memory_base(memory, size)?;
            if size != 0 {
                // SAFETY: the full live memory range is writable and no guest
                // execution has begun on a restored instance.
                unsafe { ptr::write_bytes(base, 0, size) };
            }
        }
        Ok(())
    }

    pub fn call_entry(&mut self, entry: &str, args: &[Val]) -> Result<WorkResult> {
        let entry_meta = self
            .image
            .meta
            .entries
            .iter()
            .find(|candidate| candidate.name == entry)
            .ok_or_else(|| anyhow!("module has no entry {entry}"))?
            .clone();
        if args.len() != entry_meta.params.len() {
            bail!(
                "entry {entry} takes {} args, got {}",
                entry_meta.params.len(),
                args.len()
            );
        }
        for (index, (value, expected)) in args.iter().zip(&entry_meta.params).enumerate() {
            if value.ty != *expected {
                bail!(
                    "entry {entry} argument {index} is {:?}, expected {expected:?}",
                    value.ty
                );
            }
        }

        let argc: usize = entry_meta.params.iter().map(|ty| cell_count(*ty)).sum();
        let result_cells: usize = entry_meta.results.iter().map(|ty| cell_count(*ty)).sum();
        let mut cells = vec![0u32; argc.max(result_cells).max(1)];
        let mut position = 0;
        for value in args {
            let count = cell_count(value.ty);
            for chunk in value.bits[..count * 4].chunks_exact(4) {
                cells[position] = u32::from_le_bytes(chunk.try_into().unwrap());
                position += 1;
            }
        }
        self.call_cells(entry, argc as u32, cells.as_mut_ptr())?;
        self.classify()
    }

    pub fn resume(&mut self) -> Result<WorkResult> {
        self.call_no_args(names::F_RESUME)
            .context("running __weave_resume")?;
        self.classify()
    }

    fn classify(&self) -> Result<WorkResult> {
        match self.get_global_i32(names::G_FLAG)? {
            names::FLAG_DONE => Ok(WorkResult::Done(self.read_results()?)),
            names::FLAG_UNWOUND => Ok(WorkResult::Unwound),
            other => bail!("invalid {} value {other}", names::G_FLAG),
        }
    }

    fn read_results(&self) -> Result<Vec<Val>> {
        let entry_index = self.get_global_i32(names::G_ENTRY)?;
        let entry = usize::try_from(entry_index)
            .ok()
            .and_then(|index| self.image.meta.entries.get(index))
            .ok_or_else(|| anyhow!("invalid migrated entry index {entry_index}"))?;
        let rbase = usize::try_from(self.get_global_i32(names::G_RBASE)?)
            .map_err(|_| anyhow!("negative {}", names::G_RBASE))?;
        let base = rbase
            .checked_add(self.image.meta.globals_area_size as usize)
            .ok_or_else(|| anyhow!("results-area offset overflow"))?;
        let memory = self.memory(0)?;
        let memory_size = memory_size(memory)?;
        let total = entry
            .results
            .len()
            .checked_mul(16)
            .and_then(|n| base.checked_add(n))
            .ok_or_else(|| anyhow!("results-area length overflow"))?;
        if total > memory_size {
            bail!("results area lies outside memory 0");
        }
        let memory_base = memory_base(memory, memory_size)?;
        let mut results = Vec::with_capacity(entry.results.len());
        for (index, ty) in entry.results.iter().enumerate() {
            let offset = base + index * 16;
            let mut bits = [0u8; 16];
            // SAFETY: bounds were checked above and memory is paused.
            unsafe {
                ptr::copy_nonoverlapping(memory_base.add(offset), bits.as_mut_ptr(), bits.len())
            };
            results.push(Val::new(*ty, bits));
        }
        Ok(results)
    }

    fn call_no_args(&self, name: &str) -> Result<()> {
        self.call_cells(name, 0, ptr::null_mut())
    }

    fn call_cells(&self, name: &str, argc: u32, argv: *mut u32) -> Result<()> {
        let function = self.lookup_function(name)?;
        // SAFETY: function belongs to module_inst/exec_env; argv contains at
        // least max(parameter, result) cells for entry calls.
        if !unsafe { ffi::wasm_runtime_call_wasm(self.exec_env, function, argc, argv) } {
            bail!("WAMR call {name} failed: {}", self.exception());
        }
        Ok(())
    }

    fn lookup_function(&self, name: &str) -> Result<ffi::WasmFunctionInst> {
        let cname =
            CString::new(name).with_context(|| format!("function name {name:?} contains NUL"))?;
        // SAFETY: module_inst is live and cname is valid for the duration of the call.
        let function =
            unsafe { ffi::wasm_runtime_lookup_function(self.module_inst, cname.as_ptr()) };
        if function.is_null() {
            bail!("module has no exported function {name}");
        }
        Ok(function)
    }

    fn exception(&self) -> String {
        // SAFETY: module_inst is live; WAMR owns the returned NUL-terminated string.
        let exception = unsafe { ffi::wasm_runtime_get_exception(self.module_inst) };
        if exception.is_null() {
            "unknown exception".to_owned()
        } else {
            // SAFETY: documented WAMR exception pointer is a C string.
            unsafe { CStr::from_ptr(exception) }
                .to_string_lossy()
                .into_owned()
        }
    }

    pub fn attach_shared(&mut self, shared: Shared, options: SourceOptions) {
        self.host.shared = Some(shared);
        self.host.source_options = options;
    }

    pub fn take_poll(&mut self) -> TakenPoll {
        match std::mem::replace(&mut self.host.poll, PollState::Run) {
            PollState::Run => TakenPoll::Run,
            PollState::Migrating(migration) => TakenPoll::Migrating(*migration),
            PollState::Errored(error) => TakenPoll::Errored(error),
        }
    }

    pub fn capture_globals(&self) -> Result<Vec<(String, i32)>> {
        self.image
            .meta
            .control_globals
            .iter()
            .map(|name| Ok((name.clone(), self.get_global_i32(name)?)))
            .collect()
    }

    pub fn snapshot_services(&self) -> Vec<(String, Vec<u8>)> {
        self.host.services.snapshot()
    }

    pub fn restore_services(&mut self, blobs: &[(String, Vec<u8>)]) -> Result<()> {
        self.host.services.restore(blobs)
    }

    pub fn mem_view(&self) -> WamrMems {
        WamrMems {
            module_inst: self.module_inst,
            n_mems: self.image.meta.memories.len(),
        }
    }

    pub fn set_mem_pages(&mut self, memory_index: usize, pages: u64) -> Result<()> {
        let memory = self.memory(memory_index)?;
        // SAFETY: memory is a live instance memory.
        let current = unsafe { ffi::wasm_memory_get_cur_page_count(memory) };
        if pages < current {
            bail!("cannot shrink memory {memory_index} from {current} to {pages} pages");
        }
        if pages > current {
            // SAFETY: guest is paused and memory is live.
            if !unsafe { ffi::wasm_memory_enlarge(memory, pages - current) } {
                bail!("growing memory {memory_index} from {current} to {pages} pages failed");
            }
        }
        Ok(())
    }

    pub fn write_mem(&mut self, memory_index: usize, offset: usize, bytes: &[u8]) -> Result<()> {
        if bytes.len() != WPAGE_SIZE {
            bail!(
                "PAGE payload must be exactly {WPAGE_SIZE} bytes, got {}",
                bytes.len()
            );
        }
        if offset % WPAGE_SIZE != 0 {
            bail!("PAGE offset {offset} is not {WPAGE_SIZE}-byte aligned");
        }
        let memory = self.memory(memory_index)?;
        let size = memory_size(memory)?;
        let end = offset
            .checked_add(bytes.len())
            .ok_or_else(|| anyhow!("memory write offset overflow"))?;
        if end > size {
            bail!("PAGE write [{offset}, {end}) exceeds memory {memory_index} size {size}");
        }
        let base = memory_base(memory, size)?;
        // SAFETY: range is bounds-checked and guest execution is paused.
        unsafe { ptr::copy_nonoverlapping(bytes.as_ptr(), base.add(offset), bytes.len()) };
        Ok(())
    }

    pub fn get_global_i32(&self, name: &str) -> Result<i32> {
        let global = self.global(name, false)?;
        // SAFETY: global() validated non-null i32 storage.
        Ok(unsafe { ptr::read_unaligned(global.global_data.cast::<i32>()) })
    }

    pub fn set_global_i32(&mut self, name: &str, value: i32) -> Result<()> {
        let global = self.global(name, true)?;
        // SAFETY: global() validated mutable non-null i32 storage and guest is paused.
        unsafe { ptr::write_unaligned(global.global_data.cast::<i32>(), value) };
        Ok(())
    }

    fn global(&self, name: &str, require_mutable: bool) -> Result<ffi::WasmGlobalInst> {
        let cname =
            CString::new(name).with_context(|| format!("global name {name:?} contains NUL"))?;
        let mut global = ffi::WasmGlobalInst {
            kind: u8::MAX,
            is_mutable: false,
            global_data: ptr::null_mut(),
        };
        // SAFETY: module_inst is live and output points to initialized storage.
        if !unsafe {
            ffi::wasm_runtime_get_export_global_inst(self.module_inst, cname.as_ptr(), &mut global)
        } {
            bail!("module has no exported global {name}");
        }
        if global.kind != ffi::WASM_I32 {
            bail!("exported control global {name} is not i32");
        }
        if require_mutable && !global.is_mutable {
            bail!("exported control global {name} is immutable");
        }
        if global.global_data.is_null() {
            bail!("WAMR returned null storage for global {name}");
        }
        Ok(global)
    }

    fn memory(&self, index: usize) -> Result<ffi::WasmMemoryInst> {
        if index >= self.image.meta.memories.len() {
            bail!("memory index {index} is outside module metadata");
        }
        let index = u32::try_from(index).map_err(|_| anyhow!("memory index overflow"))?;
        // SAFETY: module_inst is live.
        let memory = unsafe { ffi::wasm_runtime_get_memory(self.module_inst, index) };
        if memory.is_null() {
            bail!("WAMR did not expose memory index {index}");
        }
        Ok(memory)
    }
}

impl Drop for WamrInstance {
    fn drop(&mut self) {
        // SAFETY: fields are live WAMR handles and are destroyed once, in the
        // reverse order in which they were constructed.
        unsafe {
            ffi::wasm_runtime_set_custom_data(self.module_inst, ptr::null_mut());
            ffi::wasm_runtime_destroy_exec_env(self.exec_env);
            ffi::wasm_runtime_deinstantiate(self.module_inst);
            ffi::wasm_runtime_unload(self.module);
        }
    }
}

pub struct WamrMems {
    module_inst: ffi::WasmModuleInst,
    n_mems: usize,
}

impl MemRead for WamrMems {
    fn n_mems(&self) -> usize {
        self.n_mems
    }

    fn size(&self, memory: usize) -> usize {
        self.memory(memory)
            .and_then(memory_size)
            .expect("validated WAMR memory disappeared")
    }

    fn read(&self, memory: usize, offset: usize, output: &mut [u8]) {
        let memory = self
            .memory(memory)
            .expect("validated WAMR memory disappeared");
        let size = memory_size(memory).expect("WAMR memory size overflow");
        let end = offset
            .checked_add(output.len())
            .expect("memory read offset overflow");
        assert!(end <= size, "memory read exceeds WAMR memory");
        let base = memory_base(memory, size).expect("WAMR returned null memory base");
        // SAFETY: range is bounds-checked; MemRead is used only while paused.
        unsafe { ptr::copy_nonoverlapping(base.add(offset), output.as_mut_ptr(), output.len()) };
    }
}

impl WamrMems {
    fn memory(&self, index: usize) -> Result<ffi::WasmMemoryInst> {
        if index >= self.n_mems {
            bail!("memory index {index} out of bounds");
        }
        // SAFETY: this view never outlives its WamrInstance.
        let memory = unsafe { ffi::wasm_runtime_get_memory(self.module_inst, index as u32) };
        if memory.is_null() {
            bail!("WAMR memory {index} is missing");
        }
        Ok(memory)
    }
}

fn memory_size(memory: ffi::WasmMemoryInst) -> Result<usize> {
    // SAFETY: caller supplies a live memory handle.
    let pages = unsafe { ffi::wasm_memory_get_cur_page_count(memory) };
    // SAFETY: caller supplies a live memory handle.
    let bytes_per_page = unsafe { ffi::wasm_memory_get_bytes_per_page(memory) };
    let bytes = pages
        .checked_mul(bytes_per_page)
        .ok_or_else(|| anyhow!("WAMR memory size overflow"))?;
    usize::try_from(bytes).map_err(|_| anyhow!("WAMR memory does not fit host address space"))
}

fn memory_base(memory: ffi::WasmMemoryInst, size: usize) -> Result<*mut u8> {
    // SAFETY: caller supplies a live memory handle.
    let base = unsafe { ffi::wasm_memory_get_base_address(memory) }.cast::<u8>();
    if base.is_null() && size != 0 {
        bail!("WAMR returned a null base for non-empty memory");
    }
    Ok(base)
}

fn cell_count(ty: ValType) -> usize {
    match ty {
        ValType::I32 | ValType::F32 | ValType::FuncRef => 1,
        ValType::I64 | ValType::F64 => 2,
        ValType::V128 => 4,
    }
}

fn error_text(buffer: &[c_char]) -> String {
    let bytes: Vec<u8> = buffer
        .iter()
        .take_while(|byte| **byte != 0)
        .map(|byte| *byte as u8)
        .collect();
    String::from_utf8_lossy(&bytes).into_owned()
}

unsafe fn host_state(exec_env: ffi::WasmExecEnv) -> Option<&'static mut HostState> {
    // SAFETY: called only by WAMR native callbacks for a live module instance.
    let module_inst = unsafe { ffi::wasm_runtime_get_module_inst(exec_env) };
    if module_inst.is_null() {
        return None;
    }
    // SAFETY: WamrInstance installed a HostState pointer during construction.
    let custom = unsafe { ffi::wasm_runtime_get_custom_data(module_inst) };
    if custom.is_null() {
        None
    } else {
        // SAFETY: custom_data points to the live boxed HostState and callbacks
        // are serialized with guest execution by Weave's single-thread contract.
        Some(unsafe { &mut *custom.cast::<HostState>() })
    }
}

unsafe extern "C" fn poll_native(exec_env: ffi::WasmExecEnv) -> i32 {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        poll_impl(exec_env).unwrap_or_else(|error| {
            // SAFETY: this is still the same live native callback.
            if let Some(host) = unsafe { host_state(exec_env) } {
                host.poll = PollState::Errored(format!("{error:#}"));
            }
            1
        })
    }));
    match outcome {
        Ok(decision) => decision,
        Err(_) => {
            // Never unwind across the C ABI.
            // SAFETY: this is still the same live native callback.
            if let Some(host) = unsafe { host_state(exec_env) } {
                host.poll = PollState::Errored("panic in weave.poll host callback".to_owned());
            }
            1
        }
    }
}

fn poll_impl(exec_env: ffi::WasmExecEnv) -> Result<i32> {
    // SAFETY: poll_impl is entered only from poll_native with a live exec env.
    let module_inst = unsafe { ffi::wasm_runtime_get_module_inst(exec_env) };
    if module_inst.is_null() {
        bail!("WAMR poll callback has no module instance");
    }
    // SAFETY: same callback lifetime; see host_state.
    let host = unsafe { host_state(exec_env) }.ok_or_else(|| anyhow!("missing WAMR host state"))?;

    #[cfg(test)]
    if let Some(remaining) = host.polls_until_checkpoint.as_mut() {
        if *remaining == 0 {
            host.polls_until_checkpoint = None;
            return Ok(1);
        }
        *remaining -= 1;
    }

    if matches!(host.poll, PollState::Run) {
        let target = host
            .shared
            .as_ref()
            .and_then(|shared| shared.requested_target());
        if let Some(target) = target {
            match SourceMigration::connect(
                &target,
                "wamr",
                host.wasm.as_slice(),
                &host.meta_bytes,
                host.n_mems,
                host.source_options.clone(),
            ) {
                Ok(migration) => host.poll = PollState::Migrating(Box::new(migration)),
                Err(error) => {
                    if let Some(shared) = &host.shared {
                        shared.attempt_failed(format!("migration failed to start: {error:#}"));
                    }
                    return Ok(0);
                }
            }
        }
    }

    match &mut host.poll {
        PollState::Run => Ok(0),
        PollState::Errored(_) => Ok(1),
        PollState::Migrating(migration) => {
            let memories = WamrMems {
                module_inst,
                n_mems: host.n_mems,
            };
            match migration.precopy_step(&memories) {
                Ok(true) => Ok(1),
                Ok(false) => Ok(0),
                Err(error) => {
                    host.poll = PollState::Errored(format!("{error:#}"));
                    Ok(1)
                }
            }
        }
    }
}

unsafe extern "C" fn emit_native(exec_env: ffi::WasmExecEnv, i: i32, h: i64) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: WAMR invokes this only for a live instance.
        if let Some(host) = unsafe { host_state(exec_env) } {
            host.services.emit(i, h);
        }
    }));
}

unsafe extern "C" fn emit32_native(exec_env: ffi::WasmExecEnv, value: i32) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: WAMR invokes this only for a live instance.
        if let Some(host) = unsafe { host_state(exec_env) } {
            host.services.emit32(value);
        }
    }));
}

unsafe extern "C" fn emit64_native(exec_env: ffi::WasmExecEnv, value: i64) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // SAFETY: WAMR invokes this only for a live instance.
        if let Some(host) = unsafe { host_state(exec_env) } {
            host.services.emit64(value);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    fn woven(wat: &str) -> ModuleImage {
        let options = weave_transform::TransformOptions {
            poll_period: 1,
            ..Default::default()
        };
        ModuleImage::parse(
            weave_transform::transform(&wat::parse_str(wat).unwrap(), &options)
                .unwrap()
                .wasm,
        )
        .unwrap()
    }

    fn instance(image: ModuleImage) -> WamrInstance {
        WamrInstance::instantiate(image, DEFAULT_STACK_SIZE, None, SourceOptions::default())
            .unwrap()
    }

    #[test]
    fn implicit_constructor_exports_do_not_execute_when_fresh_or_staged() {
        let _serial = EXECUTION_LOCK.lock().unwrap();
        crate::with_wamr(|| {
            for constructor in ["__post_instantiate", "__wasm_call_ctors"] {
                let image = woven(&format!(r#"(module
                  (global $g (mut i32) (i32.const 0))
                  (func (export "run") (result i32) (global.get $g))
                  (func (export "{constructor}") (global.set $g (i32.const 7))))"#));
                let mut fresh = instance(image.clone());
                fresh.initialize_fresh()?;
                assert!(matches!(fresh.call_entry("run", &[])?, WorkResult::Done(values) if values[0].as_i32() == 0));
                // Constructor exports remain callable when intentionally selected.
                fresh.call_entry(constructor, &[])?;
                assert!(matches!(fresh.call_entry("run", &[])?, WorkResult::Done(values) if values[0].as_i32() == 7));
                drop(fresh);

                // A constructor trap must not run while staging an incoming
                // module, before the target has received even its first page.
                let trapped = woven(&format!(r#"(module
                  (func (export "run"))
                  (func (export "{constructor}") unreachable))"#));
                let mut staged = instance(trapped);
                staged.prepare_restore()?;
                drop(staged);
            }
            Ok(())
        }).unwrap();
    }

    #[test]
    fn simd_and_indexed_memories_survive_checkpoint_restore() {
        let _serial = EXECUTION_LOCK.lock().unwrap();
        crate::with_wamr(|| {
            let image = woven(include_str!("../tests/fixtures/simd-multi-memory.wat"));
            let mut source = instance(image.clone());
            source.initialize_fresh()?;
            source.host.polls_until_checkpoint = Some(3);
            assert!(matches!(
                source.call_entry("run", &[Val::i32(7)])?,
                WorkResult::Unwound
            ));
            let globals = source.capture_globals()?;
            let services = source.snapshot_services();
            let view = source.mem_view();
            let memories: Vec<Vec<u8>> = (0..view.n_mems())
                .map(|index| {
                    let mut bytes = vec![0; view.size(index)];
                    view.read(index, 0, &mut bytes);
                    bytes
                })
                .collect();
            drop(source);
            let mut target = instance(image);
            target.prepare_restore()?;
            for (index, memory) in memories.iter().enumerate() {
                target.set_mem_pages(index, (memory.len() / 65536) as u64)?;
                for (page, bytes) in memory.chunks_exact(WPAGE_SIZE).enumerate() {
                    target.write_mem(index, page * WPAGE_SIZE, bytes)?;
                }
            }
            for (name, value) in globals {
                target.set_global_i32(&name, value)?;
            }
            target.restore_services(&services)?;
            assert!(
                matches!(target.resume()?, WorkResult::Done(values) if values[0].as_i32() == 205)
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn indexed_simd_and_bulk_accesses_keep_bounds_checks() {
        let _serial = EXECUTION_LOCK.lock().unwrap();
        crate::with_wamr(|| {
            let image = woven(include_str!("../tests/fixtures/simd-multi-memory.wat"));
            for entry in ["simd_oob", "copy_oob", "fill_oob"] {
                let mut fresh = instance(image.clone());
                fresh.initialize_fresh()?;
                let error = fresh.call_entry(entry, &[]).unwrap_err();
                assert!(
                    format!("{error:#}").contains("out of bounds"),
                    "{entry}: {error:#}"
                );
            }
            Ok(())
        })
        .unwrap();
    }
    use wasm_encoder::{
        CodeSection, ConstExpr, CustomSection, ExportKind, ExportSection, Function,
        FunctionSection, GlobalSection, GlobalType, Instruction, MemorySection, MemoryType, Module,
        StartSection, TypeSection, ValType as WasmValType,
    };

    fn signature_test_meta(params: Vec<ValType>, results: Vec<ValType>) -> Meta {
        let results_area_size = (results.len() * 16) as u32;
        Meta {
            version: weave_core::WEAVE_VERSION,
            poll_period: 1,
            entries: vec![weave_core::meta::EntryMeta {
                name: "run".to_owned(),
                params,
                results,
            }],
            memories: vec!["memory".to_owned()],
            imports: vec![],
            control_globals: fixed_control_globals()
                .into_iter()
                .map(str::to_owned)
                .collect(),
            globals_area_size: 0,
            results_area_size,
        }
    }

    fn test_function(results: &[WasmValType]) -> Function {
        let mut function = Function::new(Vec::<(u32, WasmValType)>::new());
        for result in results {
            match result {
                WasmValType::I32 => {
                    function.instruction(&Instruction::I32Const(0));
                }
                other => panic!("test helper has no default value for {other:?}"),
            }
        }
        function.instruction(&Instruction::End);
        function
    }

    fn signature_test_module(
        resume_results: &[WasmValType],
        entry_params: &[WasmValType],
        entry_results: &[WasmValType],
        meta: &Meta,
    ) -> Vec<u8> {
        signature_test_module_with_memories(
            resume_results,
            entry_params,
            entry_results,
            meta,
            &["memory"],
        )
    }

    fn signature_test_module_with_memories(
        resume_results: &[WasmValType],
        entry_params: &[WasmValType],
        entry_results: &[WasmValType],
        meta: &Meta,
        memory_names: &[&str],
    ) -> Vec<u8> {
        signature_test_module_options(
            resume_results,
            entry_params,
            entry_results,
            meta,
            memory_names,
            None,
        )
    }

    fn signature_test_module_options(
        resume_results: &[WasmValType],
        entry_params: &[WasmValType],
        entry_results: &[WasmValType],
        meta: &Meta,
        memory_names: &[&str],
        start: Option<u32>,
    ) -> Vec<u8> {
        let mut module = Module::new();
        let mut types = TypeSection::new();
        types.ty().function([], []);
        types.ty().function([], resume_results.iter().copied());
        types
            .ty()
            .function(entry_params.iter().copied(), entry_results.iter().copied());
        module.section(&types);

        let mut functions = FunctionSection::new();
        functions.function(0).function(1).function(2);
        module.section(&functions);

        let mut memories = MemorySection::new();
        for _ in memory_names {
            memories.memory(MemoryType {
                minimum: 1,
                maximum: None,
                memory64: false,
                shared: false,
                page_size_log2: None,
            });
        }
        module.section(&memories);

        let mut globals = GlobalSection::new();
        let global_type = GlobalType {
            val_type: WasmValType::I32,
            mutable: true,
            shared: false,
        };
        for _ in fixed_control_globals() {
            globals.global(global_type, &ConstExpr::i32_const(0));
        }
        module.section(&globals);

        let mut exports = ExportSection::new();
        exports
            .export(names::F_INIT, ExportKind::Func, 0)
            .export(names::F_RESUME, ExportKind::Func, 1)
            .export("run", ExportKind::Func, 2);
        for (index, name) in memory_names.iter().enumerate() {
            exports.export(name, ExportKind::Memory, index as u32);
        }
        if !memory_names.is_empty() {
            exports.export("memory_alias", ExportKind::Memory, 0);
        }
        for (index, name) in fixed_control_globals().into_iter().enumerate() {
            exports.export(name, ExportKind::Global, index as u32);
        }
        module.section(&exports);

        if let Some(function_index) = start {
            module.section(&StartSection { function_index });
        }

        let mut code = CodeSection::new();
        code.function(&test_function(&[]));
        code.function(&test_function(resume_results));
        code.function(&test_function(entry_results));
        module.section(&code);

        let meta_bytes = meta.encode();
        module.section(&CustomSection {
            name: Cow::Borrowed(names::META_SECTION),
            data: Cow::Borrowed(&meta_bytes),
        });
        module.finish()
    }

    #[test]
    fn wasm_start_section_is_rejected_before_instantiation() {
        let meta = signature_test_meta(vec![], vec![]);
        let wasm = signature_test_module_options(&[], &[], &[], &meta, &["memory"], Some(0));
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("an otherwise ABI-valid module with a start function must be rejected");
        assert!(format!("{error:#}").contains("start sections are forbidden"));
    }

    #[test]
    fn resume_export_must_not_return_a_value() {
        let meta = signature_test_meta(vec![], vec![]);
        let wasm = signature_test_module(&[WasmValType::I32], &[], &[], &meta);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("forged resume signature must be rejected");
        assert!(format!("{error:#}").contains("__weave_resume signature mismatch"));
    }

    #[test]
    fn entry_export_params_and_results_must_match_meta() {
        let bad_params = signature_test_meta(vec![ValType::I64], vec![]);
        let wasm = signature_test_module(&[], &[WasmValType::I32], &[], &bad_params);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("forged entry parameter signature must be rejected");
        assert!(format!("{error:#}").contains("run signature mismatch"));

        let bad_results = signature_test_meta(vec![], vec![ValType::I64]);
        let wasm = signature_test_module(&[], &[], &[WasmValType::I32], &bad_results);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("forged entry result signature must be rejected");
        assert!(format!("{error:#}").contains("run signature mismatch"));

        let mut bad_result_area = signature_test_meta(vec![], vec![ValType::I32]);
        bad_result_area.results_area_size = 0;
        let wasm = signature_test_module(&[], &[], &[WasmValType::I32], &bad_result_area);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("forged results-area size must be rejected");
        assert!(format!("{error:#}").contains("results-area size mismatch"));
    }

    #[test]
    fn control_and_memory_metadata_must_cover_actual_state() {
        let valid = signature_test_meta(vec![], vec![]);
        let wasm = signature_test_module(&[], &[], &[], &valid);
        ModuleImage::parse(wasm).expect("extra memory export aliases must be allowed");

        let mut omitted_control = signature_test_meta(vec![], vec![]);
        omitted_control.control_globals.remove(3);
        let wasm = signature_test_module(&[], &[], &[], &omitted_control);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("omitted control global must be rejected");
        assert!(format!("{error:#}").contains("required fixed prefix/order"));

        let mut reversed_control = signature_test_meta(vec![], vec![]);
        reversed_control.control_globals.swap(0, 1);
        let wasm = signature_test_module(&[], &[], &[], &reversed_control);
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("reversed control globals must be rejected");
        assert!(format!("{error:#}").contains("required fixed prefix/order"));

        let mut omitted_memory = signature_test_meta(vec![], vec![]);
        omitted_memory.memories = vec!["first".to_owned()];
        let wasm = signature_test_module_with_memories(
            &[],
            &[],
            &[],
            &omitted_memory,
            &["first", "second"],
        );
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("omitted memory must be rejected");
        assert!(format!("{error:#}").contains("memory count mismatch"));

        let mut reversed_memory = signature_test_meta(vec![], vec![]);
        reversed_memory.memories = vec!["second".to_owned(), "first".to_owned()];
        let wasm = signature_test_module_with_memories(
            &[],
            &[],
            &[],
            &reversed_memory,
            &["first", "second"],
        );
        let error = ModuleImage::parse(wasm)
            .err()
            .expect("reversed memories must be rejected");
        assert!(format!("{error:#}").contains("export second, but that export refers to memory 1"));
    }

    #[test]
    fn declared_initial_memory_counts_imports_and_definitions() {
        // One imported two-page memory followed by defined three- and
        // four-page memories. Parser iteration preserves the two sections'
        // contribution without relying on exports or weave.meta.
        let wasm = [
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // header
            0x02, 0x0f, 0x01, 0x03, b'e', b'n', b'v', 0x06, b'm', b'e', b'm', b'o', b'r', b'y',
            0x02, 0x00, 0x02, // import: (memory 2)
            0x05, 0x05, 0x02, 0x00, 0x03, 0x00, 0x04, // memories: 3 and 4 pages
        ];
        assert_eq!(
            declared_initial_memory_bytes(&wasm).unwrap(),
            9 * weave_core::WASM_PAGE_SIZE as u64
        );
    }

    #[test]
    fn value_cell_counts_match_wasm_abi() {
        assert_eq!(cell_count(ValType::I32), 1);
        assert_eq!(cell_count(ValType::I64), 2);
        assert_eq!(cell_count(ValType::V128), 4);
    }

    #[test]
    fn known_import_signatures_are_checked() {
        let mut meta = Meta {
            version: weave_core::WEAVE_VERSION,
            poll_period: 1,
            entries: vec![],
            memories: vec!["memory".into()],
            imports: vec![weave_core::meta::ImportMeta {
                module: "env".into(),
                name: "emit32".into(),
                params: vec![ValType::I32],
                results: vec![],
            }],
            control_globals: vec![],
            globals_area_size: 0,
            results_area_size: 0,
        };
        check_imports(&meta).unwrap();
        meta.imports[0].results.push(ValType::I32);
        assert!(check_imports(&meta).is_err());
    }
}
