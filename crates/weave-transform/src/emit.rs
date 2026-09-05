//! Whole-module planning and assembly: index-space layout, the weave region
//! layout, generated runtime functions (shadow-stack management, globals
//! save/load, table rehydration, init/resume, entry wrappers, table helpers),
//! and final section emission.

use crate::codegen::{funcref_null, zero_of, Codegen};
use crate::flatten::{Flattener, SlotKey};
use crate::module::ParsedModule;
use crate::{TransformOptions, TransformOutput};
use anyhow::{anyhow, bail, Context, Result};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use wasm_encoder::reencode::Reencode;
use wasm_encoder::{
    BlockType, ConstExpr, ElementSection, Elements, EntityType, ExportKind, Function, GlobalType,
    Instruction as I, MemArg, Module, RefType, TableType, ValType,
};
use wasmparser::{ElementItems, ElementKind, ExternalKind, Operator};
use weave_core::meta::{EntryMeta, ImportMeta, Meta};
use weave_core::names;

fn memarg(offset: u32, align: u32) -> MemArg {
    MemArg {
        offset: offset as u64,
        align,
        memory_index: 0,
    }
}

/// Index remapper: the `weave.poll` import lands at index `n_imp`, shifting
/// every originally-defined function up by one. All other index spaces are
/// append-only and unchanged.
pub struct Remap {
    pub n_imp: u32,
}

impl Reencode for Remap {
    type Error = std::convert::Infallible;

    fn function_index(&mut self, func: u32) -> u32 {
        if func < self.n_imp {
            func
        } else {
            func + 1
        }
    }
}

fn core_ty(vt: wasmparser::ValType) -> weave_core::ValType {
    match vt {
        wasmparser::ValType::I32 => weave_core::ValType::I32,
        wasmparser::ValType::I64 => weave_core::ValType::I64,
        wasmparser::ValType::F32 => weave_core::ValType::F32,
        wasmparser::ValType::F64 => weave_core::ValType::F64,
        wasmparser::ValType::V128 => weave_core::ValType::V128,
        wasmparser::ValType::Ref(_) => weave_core::ValType::FuncRef,
    }
}

#[derive(Debug, Clone)]
pub struct SavedGlobal {
    pub global: u32,
    pub key: SlotKey,
    pub off: u32,
    /// For funcref globals: the i32 shadow global that is actually saved.
    pub shadow: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct EntryPlan {
    pub name: String,
    pub old_func: u32,
    pub wrapper: u32,
    pub params: Vec<SlotKey>,
    pub results: Vec<SlotKey>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum HelperKind {
    Grow(u32),
    Fill(u32),
    Copy(u32, u32),
    Init(u32, u32),
}

pub struct Plan {
    pub poll_period: u32,
    pub stack_pages: u32,
    pub n_imp: u32,
    pub poll_func: u32,
    pub stack_init: u32,
    pub stack_grow: u32,
    pub globals_save: u32,
    pub globals_load: u32,
    pub rehydrate: u32,
    pub init_func: u32,
    pub resume_func: u32,
    pub memory_grow: u32,
    pub memory_max: u64,
    pub entries: Vec<EntryPlan>,
    pub helpers: Vec<(HelperKind, u32)>,
    pub tgrow: HashMap<u32, u32>,
    pub tfill: HashMap<u32, u32>,
    pub tcopy: HashMap<(u32, u32), u32>,
    pub tinit: HashMap<(u32, u32), u32>,
    pub canon_table: u32,
    pub n_total_funcs: u32,
    pub g_state: u32,
    pub g_flag: u32,
    pub g_entry: u32,
    pub g_ctr: u32,
    pub g_sp: u32,
    pub g_stack_base: u32,
    pub g_stack_end: u32,
    pub g_rbase: u32,
    /// Indexed by table index (meaningful only when `shadows_enabled`).
    pub g_tshadow: Vec<u32>,
    pub g_tshadow_cap: Vec<u32>,
    pub shadow_globals: HashMap<u32, u32>,
    pub instrumented: Vec<bool>,
    pub flattened: Vec<bool>,
    pub shadows_enabled: bool,
    pub data_flag_off: HashMap<u32, u32>,
    pub elem_flag_off: HashMap<u32, u32>,
    pub saved_globals: Vec<SavedGlobal>,
    pub table_size_off: Vec<u32>,
    pub tshadow_init_off: Vec<u32>,
    pub tshadow_init_cap: Vec<u32>,
    pub globals_area: u32,
    pub results_area: u32,
    pub region_size: u32,
    pub t_poll: u32,
    pub t_void: u32,
    pub t_i32: u32,
    pub t_tgrow: u32,
    pub t_tfill: u32,
    pub t_3i: u32,
    pub t_memory_grow: u32,
    pub n_data_orig: u32,
    pub control_globals: Vec<(String, u32)>,
}

impl Plan {
    pub fn map_func(&self, old: u32) -> u32 {
        if old < self.n_imp {
            old
        } else {
            old + 1
        }
    }
}

struct Prescan {
    has_loop: bool,
    callees: HashSet<u32>,
    has_indirect: bool,
    special: bool,
    tgrow: HashSet<u32>,
    tfill: HashSet<u32>,
    tcopy: HashSet<(u32, u32)>,
    tinit: HashSet<(u32, u32)>,
    any_table_shadow_op: bool,
}

fn prescan(pm: &ParsedModule<'_>) -> Result<Vec<Prescan>> {
    let funcref_globals: HashSet<u32> = pm
        .global_types
        .iter()
        .enumerate()
        .filter(|(_, g)| matches!(g.content_type, wasmparser::ValType::Ref(_)))
        .map(|(i, _)| i as u32)
        .collect();

    let mut out = Vec::with_capacity(pm.code.len());
    for body in &pm.code {
        let mut p = Prescan {
            has_loop: false,
            callees: HashSet::new(),
            has_indirect: false,
            special: false,
            tgrow: HashSet::new(),
            tfill: HashSet::new(),
            tcopy: HashSet::new(),
            tinit: HashSet::new(),
            any_table_shadow_op: false,
        };
        let mut r = body.get_operators_reader()?;
        while !r.eof() {
            match r.read()? {
                Operator::Loop { .. } => p.has_loop = true,
                Operator::Call { function_index } => {
                    p.callees.insert(function_index);
                }
                Operator::ReturnCall { function_index } => {
                    p.callees.insert(function_index);
                    p.special = true;
                }
                Operator::CallIndirect { .. } | Operator::ReturnCallIndirect { .. } => {
                    p.has_indirect = true;
                }
                Operator::TableGet { .. } | Operator::TableSet { .. } => {
                    p.special = true;
                    p.any_table_shadow_op = true;
                }
                Operator::TableGrow { table } => {
                    p.special = true;
                    p.any_table_shadow_op = true;
                    p.tgrow.insert(table);
                }
                Operator::TableFill { table } => {
                    p.special = true;
                    p.any_table_shadow_op = true;
                    p.tfill.insert(table);
                }
                Operator::TableCopy {
                    dst_table,
                    src_table,
                } => {
                    p.special = true;
                    p.any_table_shadow_op = true;
                    p.tcopy.insert((dst_table, src_table));
                }
                Operator::TableInit { elem_index, table } => {
                    p.special = true;
                    p.any_table_shadow_op = true;
                    p.tinit.insert((table, elem_index));
                }
                Operator::ElemDrop { .. }
                | Operator::DataDrop { .. }
                | Operator::MemoryInit { .. } => {
                    p.special = true;
                }
                Operator::GlobalGet { global_index } | Operator::GlobalSet { global_index } => {
                    if funcref_globals.contains(&global_index) {
                        p.special = true;
                    }
                }
                Operator::RefFunc { .. }
                | Operator::RefNull { .. }
                | Operator::TypedSelect { .. } => {
                    // Only matters if the value can persist; persistence paths
                    // (locals across spills, table/global writes) all imply
                    // flattening through other rules. A leaf that briefly
                    // touches a funcref but is flattened anyway costs nothing.
                    p.special = true;
                }
                ref op if crate::memory::needs_rewrite(op) => p.special = true,
                _ => {}
            }
        }
        out.push(p);
    }
    Ok(out)
}

/// Mark defined functions that sit on a call-graph cycle (including direct
/// self-recursion) via iterative Tarjan SCC.
fn find_recursive(scans: &[Prescan], n_imp: u32) -> Vec<bool> {
    let n = scans.len();
    let adj: Vec<Vec<usize>> = scans
        .iter()
        .map(|s| {
            s.callees
                .iter()
                .filter(|c| **c >= n_imp)
                .map(|c| (*c - n_imp) as usize)
                .collect()
        })
        .collect();
    let mut index = vec![usize::MAX; n];
    let mut low = vec![0usize; n];
    let mut on_stack = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    let mut next_index = 0usize;
    let mut recursive = vec![false; n];

    for start in 0..n {
        if index[start] != usize::MAX {
            continue;
        }
        // Iterative Tarjan: (node, child cursor)
        let mut call: Vec<(usize, usize)> = vec![(start, 0)];
        index[start] = next_index;
        low[start] = next_index;
        next_index += 1;
        stack.push(start);
        on_stack[start] = true;
        while let Some(&mut (v, ref mut ci)) = call.last_mut() {
            if *ci < adj[v].len() {
                let w = adj[v][*ci];
                *ci += 1;
                if index[w] == usize::MAX {
                    index[w] = next_index;
                    low[w] = next_index;
                    next_index += 1;
                    stack.push(w);
                    on_stack[w] = true;
                    call.push((w, 0));
                } else if on_stack[w] {
                    low[v] = low[v].min(index[w]);
                }
            } else {
                call.pop();
                if let Some(&mut (p, _)) = call.last_mut() {
                    low[p] = low[p].min(low[v]);
                }
                if low[v] == index[v] {
                    // v roots an SCC
                    let mut members = Vec::new();
                    loop {
                        let w = stack.pop().unwrap();
                        on_stack[w] = false;
                        members.push(w);
                        if w == v {
                            break;
                        }
                    }
                    let cyclic = members.len() > 1 || adj[members[0]].contains(&members[0]);
                    if cyclic {
                        for m in members {
                            recursive[m] = true;
                        }
                    }
                }
            }
        }
    }
    recursive
}

impl Plan {
    pub fn build(pm: &ParsedModule<'_>, opts: &TransformOptions) -> Result<Plan> {
        let n_imp = pm.num_imported_funcs();
        let n_defined = pm.code.len() as u32;
        let scans = prescan(pm)?;

        // Reserved-name collision check.
        for e in &pm.exports {
            if e.name.starts_with("__weave") {
                bail!("module already exports reserved name {}", e.name);
            }
        }
        // Imported funcref globals cannot be shadowed statically.
        for (i, g) in pm.global_types.iter().enumerate() {
            if (i as u32) < pm.num_imported_globals
                && matches!(g.content_type, wasmparser::ValType::Ref(_))
            {
                bail!("unsupported: imported funcref global");
            }
        }
        for t in &pm.defined_tables {
            if !matches!(t.init, wasmparser::TableInit::RefNull) {
                bail!("unsupported: table with explicit init expression");
            }
        }

        // ---- instrumentation fixpoint ----
        // Seeds: functions that can stay live on the native stack unboundedly
        // long — loops, indirect calls (unknown callee), and recursion (any
        // function on a call-graph cycle, so pure recursion is checkpointable
        // through function-entry polls).
        let recursive = find_recursive(&scans, n_imp);
        let mut instrumented: Vec<bool> = scans
            .iter()
            .enumerate()
            .map(|(i, s)| s.has_loop || s.has_indirect || recursive[i])
            .collect();
        loop {
            let mut changed = false;
            for (i, s) in scans.iter().enumerate() {
                if instrumented[i] {
                    continue;
                }
                for c in &s.callees {
                    if *c >= n_imp && instrumented[(*c - n_imp) as usize] {
                        instrumented[i] = true;
                        changed = true;
                        break;
                    }
                }
            }
            if !changed {
                break;
            }
        }
        let flattened: Vec<bool> = scans
            .iter()
            .enumerate()
            .map(|(i, s)| instrumented[i] || s.special)
            .collect();

        let shadows_enabled = scans.iter().any(|s| s.any_table_shadow_op);

        // ---- function index space ----
        let poll_func = n_imp;
        let base = n_imp + 1 + n_defined;
        let stack_init = base;
        let stack_grow = base + 1;
        let globals_save = base + 2;
        let globals_load = base + 3;
        let rehydrate = base + 4;
        let init_func = base + 5;
        let resume_func = base + 6;
        let memory_grow = base + 7;
        let mut next = base + 8;

        let mut entries = Vec::new();
        for e in &pm.exports {
            if e.kind == ExternalKind::Func {
                let sig = pm.func_sig(e.index);
                entries.push(EntryPlan {
                    name: e.name.clone(),
                    old_func: e.index,
                    wrapper: next,
                    params: sig.params.iter().map(|t| SlotKey::of(*t)).collect(),
                    results: sig.results.iter().map(|t| SlotKey::of(*t)).collect(),
                });
                next += 1;
            }
        }

        // table helpers
        let mut helpers = Vec::new();
        let mut tgrow = HashMap::new();
        let mut tfill = HashMap::new();
        let mut tcopy = HashMap::new();
        let mut tinit = HashMap::new();
        let mut grows: Vec<u32> = scans.iter().flat_map(|s| s.tgrow.iter().copied()).collect();
        let mut fills: Vec<u32> = scans.iter().flat_map(|s| s.tfill.iter().copied()).collect();
        let mut copies: Vec<(u32, u32)> =
            scans.iter().flat_map(|s| s.tcopy.iter().copied()).collect();
        let mut inits: Vec<(u32, u32)> =
            scans.iter().flat_map(|s| s.tinit.iter().copied()).collect();
        grows.sort_unstable();
        grows.dedup();
        fills.sort_unstable();
        fills.dedup();
        copies.sort_unstable();
        copies.dedup();
        inits.sort_unstable();
        inits.dedup();
        for t in grows {
            helpers.push((HelperKind::Grow(t), next));
            tgrow.insert(t, next);
            next += 1;
        }
        for t in fills {
            helpers.push((HelperKind::Fill(t), next));
            tfill.insert(t, next);
            next += 1;
        }
        for (d, s) in copies {
            helpers.push((HelperKind::Copy(d, s), next));
            tcopy.insert((d, s), next);
            next += 1;
        }
        for (t, e) in inits {
            helpers.push((HelperKind::Init(t, e), next));
            tinit.insert((t, e), next);
            next += 1;
        }
        let n_total_funcs = next;

        // ---- global index space ----
        let n_globals_orig = pm.global_types.len() as u32;
        let g_state = n_globals_orig;
        let g_flag = n_globals_orig + 1;
        let g_entry = n_globals_orig + 2;
        let g_ctr = n_globals_orig + 3;
        let g_sp = n_globals_orig + 4;
        let g_stack_base = n_globals_orig + 5;
        let g_stack_end = n_globals_orig + 6;
        let g_rbase = n_globals_orig + 7;
        let mut next_g = n_globals_orig + 8;
        let n_tables = pm.tables.len();
        let mut g_tshadow = Vec::new();
        let mut g_tshadow_cap = Vec::new();
        let mut control_globals: Vec<(String, u32)> = vec![
            (names::G_STATE.into(), g_state),
            (names::G_FLAG.into(), g_flag),
            (names::G_ENTRY.into(), g_entry),
            (names::G_CTR.into(), g_ctr),
            (names::G_SP.into(), g_sp),
            (names::G_STACK_BASE.into(), g_stack_base),
            (names::G_STACK_END.into(), g_stack_end),
            (names::G_RBASE.into(), g_rbase),
        ];
        if shadows_enabled {
            for t in 0..n_tables {
                g_tshadow.push(next_g);
                control_globals.push((format!("__weave_tsh{t}"), next_g));
                next_g += 1;
            }
            for t in 0..n_tables {
                g_tshadow_cap.push(next_g);
                control_globals.push((format!("__weave_tshcap{t}"), next_g));
                next_g += 1;
            }
        }
        // shadow globals for funcref globals
        let mut shadow_globals = HashMap::new();
        for (i, g) in pm.global_types.iter().enumerate() {
            if matches!(g.content_type, wasmparser::ValType::Ref(_)) {
                shadow_globals.insert(i as u32, next_g);
                next_g += 1;
            }
        }

        // ---- weave region layout ----
        let n_data = pm.datas.len() as u32;
        let n_elem = pm.elements.len() as u32;
        let mut data_flag_off = HashMap::new();
        let mut elem_flag_off = HashMap::new();
        for i in 0..n_data {
            data_flag_off.insert(i, 16 + i);
        }
        for i in 0..n_elem {
            elem_flag_off.insert(i, 16 + n_data + i);
        }
        // The private header holds the guest-visible memory-0 page count.
        // It moves with the region and is automatically included in snapshots.
        let mut off = (16 + n_data + n_elem + 15) & !15;
        // saved mutable globals
        let mut saved_globals = Vec::new();
        for (i, g) in pm.global_types.iter().enumerate() {
            if !g.mutable {
                continue;
            }
            let is_ref = matches!(g.content_type, wasmparser::ValType::Ref(_));
            let key = if is_ref {
                SlotKey::I32
            } else {
                SlotKey::of(g.content_type)
            };
            let sz = key.byte_size();
            off = (off + sz - 1) & !(sz - 1);
            saved_globals.push(SavedGlobal {
                global: i as u32,
                key,
                off,
                shadow: if is_ref {
                    Some(shadow_globals[&(i as u32)])
                } else {
                    None
                },
            });
            off += sz;
        }
        // saved table sizes
        let mut table_size_off = Vec::new();
        if shadows_enabled {
            for _ in 0..n_tables {
                off = (off + 3) & !3;
                table_size_off.push(off);
                off += 4;
            }
        }
        let globals_area = (off + 15) & !15;
        let max_results = entries.iter().map(|e| e.results.len()).max().unwrap_or(0) as u32;
        let results_area = max_results * 16;
        let mut off = globals_area + results_area;
        // initial table shadow areas
        let mut tshadow_init_off = Vec::new();
        let mut tshadow_init_cap = Vec::new();
        if shadows_enabled {
            for t in &pm.tables {
                let cap = u32::try_from(t.initial)
                    .map_err(|_| anyhow!("table initial size too large"))?;
                off = (off + 3) & !3;
                tshadow_init_off.push(off);
                tshadow_init_cap.push(cap.max(1));
                off += cap.max(1) * 4;
            }
        }
        let region_size = off.max(16);

        Ok(Plan {
            poll_period: opts.poll_period,
            stack_pages: opts.stack_pages.max(1),
            n_imp,
            poll_func,
            stack_init,
            stack_grow,
            globals_save,
            globals_load,
            rehydrate,
            init_func,
            resume_func,
            memory_grow,
            memory_max: pm.memories.first().and_then(|m| m.maximum).unwrap_or(65536),
            entries,
            helpers,
            tgrow,
            tfill,
            tcopy,
            tinit,
            canon_table: pm.tables.len() as u32,
            n_total_funcs,
            g_state,
            g_flag,
            g_entry,
            g_ctr,
            g_sp,
            g_stack_base,
            g_stack_end,
            g_rbase,
            g_tshadow,
            g_tshadow_cap,
            shadow_globals,
            instrumented,
            flattened,
            shadows_enabled,
            data_flag_off,
            elem_flag_off,
            saved_globals,
            table_size_off,
            tshadow_init_off,
            tshadow_init_cap,
            globals_area,
            results_area,
            region_size,
            t_poll: pm.types.len() as u32,
            t_void: pm.types.len() as u32 + 1,
            t_i32: pm.types.len() as u32 + 2,
            t_tgrow: pm.types.len() as u32 + 3,
            t_tfill: pm.types.len() as u32 + 4,
            t_3i: pm.types.len() as u32 + 5,
            t_memory_grow: pm.types.len() as u32 + 6,
            n_data_orig: n_data,
            control_globals,
        })
    }
}

pub fn emit(
    wasm: &[u8],
    pm: &ParsedModule<'_>,
    plan: &Plan,
    opts: &TransformOptions,
) -> Result<TransformOutput> {
    let _ = opts;
    let mut plan_shadow_data: HashMap<u32, u32> = HashMap::new();

    // Re-validate to obtain per-function validators for the flattener.
    let mut validator =
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default());
    let mut funcs_to_validate = Vec::new();
    for payload in wasmparser::Parser::new(0).parse_all(wasm) {
        if let wasmparser::ValidPayload::Func(ftv, body) = validator.payload(&payload?)? {
            funcs_to_validate.push((ftv, body));
        }
    }

    let mut remap = Remap { n_imp: plan.n_imp };
    let mut module = Module::new();

    // ---- types ----
    let mut types = wasm_encoder::TypeSection::new();
    for group in &pm.raw_types {
        remap
            .parse_recursive_type_group(types.ty(), group.clone())
            .map_err(|e| anyhow!("type reencode: {e:?}"))?;
    }
    types.ty().function([], [ValType::I32]); // t_poll
    types.ty().function([], []); // t_void
    types.ty().function([ValType::I32], []); // t_i32
    types.ty().function(
        [ValType::Ref(RefType::FUNCREF), ValType::I32, ValType::I32],
        [ValType::I32],
    ); // t_tgrow
    types.ty().function(
        [
            ValType::I32,
            ValType::Ref(RefType::FUNCREF),
            ValType::I32,
            ValType::I32,
        ],
        [],
    ); // t_tfill
    types
        .ty()
        .function([ValType::I32, ValType::I32, ValType::I32], []); // t_3i
    types.ty().function([ValType::I32], [ValType::I32]); // t_memory_grow
    module.section(&types);

    // ---- imports ----
    let mut imports = wasm_encoder::ImportSection::new();
    for imp in &pm.raw_imports {
        remap
            .parse_import(&mut imports, *imp)
            .map_err(|e| anyhow!("import reencode: {e:?}"))?;
    }
    imports.import(
        names::IMPORT_MODULE,
        names::IMPORT_POLL,
        EntityType::Function(plan.t_poll),
    );
    module.section(&imports);

    // ---- functions ----
    let mut funcs = wasm_encoder::FunctionSection::new();
    for ti in &pm.func_types {
        funcs.function(*ti);
    }
    funcs.function(plan.t_void); // stack_init
    funcs.function(plan.t_i32); // stack_grow
    funcs.function(plan.t_void); // globals_save
    funcs.function(plan.t_void); // globals_load
    funcs.function(plan.t_void); // rehydrate
    funcs.function(plan.t_void); // init
    funcs.function(plan.t_void); // resume
    funcs.function(plan.t_memory_grow); // guest memory.grow 0
    for e in &plan.entries {
        let ti = if e.old_func < plan.n_imp {
            pm.imported_funcs[e.old_func as usize].type_idx
        } else {
            pm.func_types[(e.old_func - plan.n_imp) as usize]
        };
        funcs.function(ti);
    }
    for (kind, _) in &plan.helpers {
        let ti = match kind {
            HelperKind::Grow(_) => plan.t_tgrow,
            HelperKind::Fill(_) => plan.t_tfill,
            HelperKind::Copy(..) | HelperKind::Init(..) => plan.t_3i,
        };
        funcs.function(ti);
    }
    module.section(&funcs);

    // ---- tables ----
    let mut tables = wasm_encoder::TableSection::new();
    for t in &pm.defined_tables {
        remap
            .parse_table(&mut tables, t.clone())
            .map_err(|e| anyhow!("table reencode: {e:?}"))?;
    }
    tables.table(TableType {
        element_type: RefType::FUNCREF,
        minimum: plan.n_total_funcs as u64,
        maximum: Some(plan.n_total_funcs as u64),
        table64: false,
        shared: false,
    });
    module.section(&tables);

    // ---- memories ----
    let mut memories = wasm_encoder::MemorySection::new();
    let n_imported_mems = pm.num_imported_memories as usize;
    for (i, m) in pm.memories.iter().enumerate().skip(n_imported_mems) {
        let mut physical = remap.memory_type(*m);
        // The original maximum applies to guest pages, not the private suffix.
        // Guest memory.grow enforces it independently before physical growth.
        if i == 0 {
            physical.maximum = None;
        }
        memories.memory(physical);
    }
    if pm.memories.is_empty() {
        memories.memory(wasm_encoder::MemoryType {
            minimum: 0,
            maximum: None,
            memory64: false,
            shared: false,
            page_size_log2: None,
        });
    }
    module.section(&memories);

    // ---- globals ----
    let mut globals = wasm_encoder::GlobalSection::new();
    for g in &pm.defined_globals {
        remap
            .parse_global(&mut globals, g.clone())
            .map_err(|e| anyhow!("global reencode: {e:?}"))?;
    }
    let i32_mut = GlobalType {
        val_type: ValType::I32,
        mutable: true,
        shared: false,
    };
    // state, flag, entry, ctr, sp, stack_base, stack_end, rbase
    globals.global(i32_mut, &ConstExpr::i32_const(names::STATE_RUN));
    globals.global(i32_mut, &ConstExpr::i32_const(names::FLAG_DONE));
    globals.global(i32_mut, &ConstExpr::i32_const(0));
    globals.global(i32_mut, &ConstExpr::i32_const(plan.poll_period as i32));
    globals.global(i32_mut, &ConstExpr::i32_const(0));
    globals.global(i32_mut, &ConstExpr::i32_const(0));
    globals.global(i32_mut, &ConstExpr::i32_const(0));
    globals.global(i32_mut, &ConstExpr::i32_const(-1)); // rbase: not initialized
    if plan.shadows_enabled {
        for _ in 0..pm.tables.len() * 2 {
            globals.global(i32_mut, &ConstExpr::i32_const(0));
        }
    }
    // shadow globals for funcref globals, in index order
    let mut shadow_list: Vec<(u32, u32)> =
        plan.shadow_globals.iter().map(|(k, v)| (*v, *k)).collect();
    shadow_list.sort_unstable();
    for (_, orig) in &shadow_list {
        let defined_idx = *orig - pm.num_imported_globals;
        let g = &pm.defined_globals[defined_idx as usize];
        let mut init = -1i32;
        let mut r = g.init_expr.get_operators_reader();
        while !r.eof() {
            match r.read()? {
                Operator::RefNull { .. } => init = -1,
                Operator::RefFunc { function_index } => init = plan.map_func(function_index) as i32,
                Operator::End => {}
                other => bail!("unsupported funcref global init: {other:?}"),
            }
        }
        globals.global(i32_mut, &ConstExpr::i32_const(init));
    }
    module.section(&globals);

    // ---- exports ----
    let mut exports = wasm_encoder::ExportSection::new();
    for e in &pm.exports {
        match e.kind {
            ExternalKind::Func => {
                let wrapper = plan
                    .entries
                    .iter()
                    .find(|en| en.name == e.name)
                    .map(|en| en.wrapper)
                    .unwrap();
                exports.export(&e.name, ExportKind::Func, wrapper);
            }
            ExternalKind::Table => {
                exports.export(&e.name, ExportKind::Table, e.index);
            }
            ExternalKind::Memory => {
                exports.export(&e.name, ExportKind::Memory, e.index);
            }
            ExternalKind::Global => {
                exports.export(&e.name, ExportKind::Global, e.index);
            }
            ExternalKind::Tag => bail!("unsupported: tag export"),
        }
    }
    // memory export names for the meta
    let n_mems = pm.memories.len().max(1);
    let mut mem_export_names = Vec::with_capacity(n_mems);
    for i in 0..n_mems {
        let existing = pm
            .exports
            .iter()
            .find(|e| e.kind == ExternalKind::Memory && e.index == i as u32);
        match existing {
            Some(e) => mem_export_names.push(e.name.clone()),
            None => {
                let name = names::memory_export_name(i as u32);
                exports.export(&name, ExportKind::Memory, i as u32);
                mem_export_names.push(name);
            }
        }
    }
    for (name, idx) in &plan.control_globals {
        exports.export(name, ExportKind::Global, *idx);
    }
    exports.export(names::F_INIT, ExportKind::Func, plan.init_func);
    exports.export(names::F_RESUME, ExportKind::Func, plan.resume_func);
    module.section(&exports);

    // no start section: it is folded into __weave_init.

    // ---- elements ----
    let mut elements = ElementSection::new();
    for e in &pm.elements {
        remap
            .parse_element(&mut elements, e.clone())
            .map_err(|e| anyhow!("element reencode: {e:?}"))?;
    }
    let all_funcs: Vec<u32> = (0..plan.n_total_funcs).collect();
    elements.active(
        Some(plan.canon_table),
        &ConstExpr::i32_const(0),
        Elements::Functions(Cow::from(all_funcs)),
    );
    module.section(&elements);

    // ---- shadow data segments for passive element segments ----
    // (assign indices now; the data section itself is emitted after code)
    let mut shadow_data: Vec<Vec<u8>> = Vec::new();
    for (i, e) in pm.elements.iter().enumerate() {
        let used = plan.tinit.keys().any(|(_, ei)| *ei == i as u32);
        if !used {
            continue;
        }
        let mut bytes = Vec::new();
        match &e.items {
            ElementItems::Functions(r) => {
                for f in r.clone() {
                    bytes.extend_from_slice(&(plan.map_func(f?) as i32).to_le_bytes());
                }
            }
            ElementItems::Expressions(_, r) => {
                for expr in r.clone() {
                    let expr = expr?;
                    let mut val = -1i32;
                    let mut rr = expr.get_operators_reader();
                    while !rr.eof() {
                        match rr.read()? {
                            Operator::RefNull { .. } => val = -1,
                            Operator::RefFunc { function_index } => {
                                val = plan.map_func(function_index) as i32
                            }
                            Operator::End => {}
                            other => bail!("unsupported element expression: {other:?}"),
                        }
                    }
                    bytes.extend_from_slice(&val.to_le_bytes());
                }
            }
        }
        plan_shadow_data.insert(i as u32, plan.n_data_orig + shadow_data.len() as u32);
        shadow_data.push(bytes);
    }

    // ---- data count (must precede code when bulk-memory data ops exist) ----
    if plan.n_data_orig + shadow_data.len() as u32 > 0 {
        module.section(&wasm_encoder::DataCountSection {
            count: plan.n_data_orig + shadow_data.len() as u32,
        });
    }

    // ---- code ----
    let mut code = wasm_encoder::CodeSection::new();
    for (i, (ftv, body)) in funcs_to_validate.into_iter().enumerate() {
        if plan.flattened[i] {
            let fv = ftv.into_validator(Default::default());
            let mut fl = Flattener::run(pm, plan, i as u32, &body, fv)
                .with_context(|| format!("flattening function {i}"))?;
            let cg = Codegen {
                plan,
                func_id: plan.map_func(plan.n_imp + i as u32),
                results: fl.results.clone(),
            };
            let f = cg
                .emit(&mut fl, &mut remap)
                .with_context(|| format!("emitting function {i}"))?;
            code.function(&f);
        } else {
            let mut f = remap
                .new_function_with_parsed_locals(&body)
                .map_err(|e| anyhow!("locals reencode: {e:?}"))?;
            let mut r = body.get_operators_reader()?;
            while !r.eof() {
                let inst = remap
                    .parse_instruction(&mut r)
                    .map_err(|e| anyhow!("instruction reencode: {e:?}"))?;
                f.instruction(&inst);
            }
            code.function(&f);
        }
    }
    // generated functions, in index order
    code.function(&gen_stack_init(plan));
    code.function(&gen_stack_grow(plan));
    code.function(&gen_globals_save(plan, pm));
    code.function(&gen_globals_load(plan));
    code.function(&gen_rehydrate(plan, pm));
    code.function(&gen_init(plan, pm, &mut remap)?);
    code.function(&gen_resume(plan)?);
    code.function(&crate::memory::gen_grow(plan));
    for (e_idx, e) in plan.entries.iter().enumerate() {
        code.function(&gen_wrapper(plan, e, e_idx as u32));
    }
    for (kind, _) in &plan.helpers {
        code.function(&gen_helper(plan, pm, *kind, &plan_shadow_data)?);
    }
    module.section(&code);

    // ---- data ----
    let mut data = wasm_encoder::DataSection::new();
    for d in &pm.datas {
        remap
            .parse_data(&mut data, d.clone())
            .map_err(|e| anyhow!("data reencode: {e:?}"))?;
    }
    for bytes in &shadow_data {
        data.passive(bytes.iter().copied());
    }
    if plan.n_data_orig + shadow_data.len() as u32 > 0 {
        module.section(&data);
    }

    // ---- meta ----
    let meta = Meta {
        version: weave_core::WEAVE_VERSION,
        poll_period: plan.poll_period,
        entries: plan
            .entries
            .iter()
            .map(|e| {
                let sig = pm.func_sig(e.old_func);
                EntryMeta {
                    name: e.name.clone(),
                    params: sig.params.iter().map(|t| core_ty(*t)).collect(),
                    results: sig.results.iter().map(|t| core_ty(*t)).collect(),
                }
            })
            .collect(),
        memories: mem_export_names,
        imports: pm
            .imported_funcs
            .iter()
            .map(|f| {
                let sig = &pm.types[f.type_idx as usize];
                ImportMeta {
                    module: f.module.clone(),
                    name: f.name.clone(),
                    params: sig.params.iter().map(|t| core_ty(*t)).collect(),
                    results: sig.results.iter().map(|t| core_ty(*t)).collect(),
                }
            })
            .collect(),
        control_globals: plan
            .control_globals
            .iter()
            .map(|(n, _)| n.clone())
            .collect(),
        globals_area_size: plan.globals_area,
        results_area_size: plan.results_area,
    };
    module.section(&wasm_encoder::CustomSection {
        name: Cow::from(names::META_SECTION),
        data: Cow::from(meta.encode()),
    });

    Ok(TransformOutput {
        wasm: module.finish(),
        meta,
    })
}

// ---------------- generated runtime functions ----------------

fn gen_stack_init(plan: &Plan) -> Function {
    let mut f = Function::new([(1, ValType::I32)]);
    let old = 0;
    f.instruction(&I::I32Const(plan.stack_pages as i32));
    f.instruction(&I::MemoryGrow(0));
    f.instruction(&I::LocalTee(old));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(old));
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32Shl);
    f.instruction(&I::GlobalSet(plan.g_stack_base));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::GlobalSet(plan.g_sp));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::I32Const((plan.stack_pages as i32) << 16));
    f.instruction(&I::I32Add);
    f.instruction(&I::GlobalSet(plan.g_stack_end));
    f.instruction(&I::End);
    f
}

fn gen_stack_grow(plan: &Plan) -> Function {
    // param 0: need. locals: 1 cur, 2 new_size, 3 old, 4 new_base
    let mut f = Function::new([(4, ValType::I32)]);
    let (need, cur, new_size, old, new_base) = (0, 1, 2, 3, 4);
    // cur = end - base
    f.instruction(&I::GlobalGet(plan.g_stack_end));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::I32Sub);
    f.instruction(&I::LocalSet(cur));
    // new_size = cur * 2; if new_size < cur + need { new_size = cur + need }
    f.instruction(&I::LocalGet(cur));
    f.instruction(&I::I32Const(1));
    f.instruction(&I::I32Shl);
    f.instruction(&I::LocalSet(new_size));
    f.instruction(&I::LocalGet(new_size));
    f.instruction(&I::LocalGet(cur));
    f.instruction(&I::LocalGet(need));
    f.instruction(&I::I32Add);
    f.instruction(&I::I32LtU);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::LocalGet(cur));
    f.instruction(&I::LocalGet(need));
    f.instruction(&I::I32Add);
    f.instruction(&I::LocalSet(new_size));
    f.instruction(&I::End);
    // round up to pages, grow
    f.instruction(&I::LocalGet(new_size));
    f.instruction(&I::I32Const(0xFFFF));
    f.instruction(&I::I32Add);
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32ShrU);
    f.instruction(&I::LocalTee(old)); // reuse as page count briefly
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32Shl);
    f.instruction(&I::LocalSet(new_size));
    f.instruction(&I::LocalGet(old));
    f.instruction(&I::MemoryGrow(0));
    f.instruction(&I::LocalTee(old));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(old));
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32Shl);
    f.instruction(&I::LocalSet(new_base));
    // copy live frames
    f.instruction(&I::LocalGet(new_base));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::GlobalGet(plan.g_sp));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::I32Sub);
    f.instruction(&I::MemoryCopy {
        dst_mem: 0,
        src_mem: 0,
    });
    // rebase sp/base/end
    f.instruction(&I::LocalGet(new_base));
    f.instruction(&I::GlobalGet(plan.g_sp));
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::I32Sub);
    f.instruction(&I::I32Add);
    f.instruction(&I::GlobalSet(plan.g_sp));
    f.instruction(&I::LocalGet(new_base));
    f.instruction(&I::GlobalSet(plan.g_stack_base));
    f.instruction(&I::LocalGet(new_base));
    f.instruction(&I::LocalGet(new_size));
    f.instruction(&I::I32Add);
    f.instruction(&I::GlobalSet(plan.g_stack_end));
    f.instruction(&I::End);
    f
}

fn store_of(key: SlotKey, off: u32) -> I<'static> {
    match key {
        SlotKey::I32 => I::I32Store(memarg(off, 2)),
        SlotKey::I64 => I::I64Store(memarg(off, 3)),
        SlotKey::F32 => I::F32Store(memarg(off, 2)),
        SlotKey::F64 => I::F64Store(memarg(off, 3)),
        SlotKey::V128 => I::V128Store(memarg(off, 4)),
        SlotKey::FuncRef => unreachable!(),
    }
}

fn load_of(key: SlotKey, off: u32) -> I<'static> {
    match key {
        SlotKey::I32 => I::I32Load(memarg(off, 2)),
        SlotKey::I64 => I::I64Load(memarg(off, 3)),
        SlotKey::F32 => I::F32Load(memarg(off, 2)),
        SlotKey::F64 => I::F64Load(memarg(off, 3)),
        SlotKey::V128 => I::V128Load(memarg(off, 4)),
        SlotKey::FuncRef => unreachable!(),
    }
}

fn gen_globals_save(plan: &Plan, pm: &ParsedModule<'_>) -> Function {
    let mut f = Function::new([]);
    for sg in &plan.saved_globals {
        f.instruction(&I::GlobalGet(plan.g_rbase));
        f.instruction(&I::GlobalGet(sg.shadow.unwrap_or(sg.global)));
        f.instruction(&store_of(sg.key, sg.off));
    }
    if plan.shadows_enabled {
        for t in 0..pm.tables.len() {
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::TableSize(t as u32));
            f.instruction(&I::I32Store(memarg(plan.table_size_off[t], 2)));
        }
    }
    f.instruction(&I::End);
    f
}

fn gen_globals_load(plan: &Plan) -> Function {
    let mut f = Function::new([]);
    for sg in &plan.saved_globals {
        match sg.shadow {
            None => {
                f.instruction(&I::GlobalGet(plan.g_rbase));
                f.instruction(&load_of(sg.key, sg.off));
                f.instruction(&I::GlobalSet(sg.global));
            }
            Some(sh) => {
                f.instruction(&I::GlobalGet(plan.g_rbase));
                f.instruction(&I::I32Load(memarg(sg.off, 2)));
                f.instruction(&I::GlobalSet(sh));
                f.instruction(&I::GlobalGet(sh));
                f.instruction(&I::I32Const(-1));
                f.instruction(&I::I32Eq);
                f.instruction(&I::If(BlockType::Result(ValType::Ref(RefType::FUNCREF))));
                f.instruction(&funcref_null());
                f.instruction(&I::Else);
                f.instruction(&I::GlobalGet(sh));
                f.instruction(&I::TableGet(plan.canon_table));
                f.instruction(&I::End);
                f.instruction(&I::GlobalSet(sg.global));
            }
        }
    }
    f.instruction(&I::End);
    f
}

fn gen_rehydrate(plan: &Plan, pm: &ParsedModule<'_>) -> Function {
    if !plan.shadows_enabled {
        let mut f = Function::new([]);
        f.instruction(&I::End);
        return f;
    }
    // locals: 0 i, 1 saved, 2 sh
    let mut f = Function::new([(3, ValType::I32)]);
    let (i, saved, sh) = (0, 1, 2);
    for t in 0..pm.tables.len() as u32 {
        // saved = load size
        f.instruction(&I::GlobalGet(plan.g_rbase));
        f.instruction(&I::I32Load(memarg(plan.table_size_off[t as usize], 2)));
        f.instruction(&I::LocalSet(saved));
        // grow to saved size if needed
        f.instruction(&I::LocalGet(saved));
        f.instruction(&I::TableSize(t));
        f.instruction(&I::I32GtU);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&funcref_null());
        f.instruction(&I::LocalGet(saved));
        f.instruction(&I::TableSize(t));
        f.instruction(&I::I32Sub);
        f.instruction(&I::TableGrow(t));
        f.instruction(&I::I32Const(-1));
        f.instruction(&I::I32Eq);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&I::Unreachable);
        f.instruction(&I::End);
        f.instruction(&I::End);
        // rebuild entries
        f.instruction(&I::I32Const(0));
        f.instruction(&I::LocalSet(i));
        f.instruction(&I::Block(BlockType::Empty));
        f.instruction(&I::Loop(BlockType::Empty));
        f.instruction(&I::LocalGet(i));
        f.instruction(&I::LocalGet(saved));
        f.instruction(&I::I32GeU);
        f.instruction(&I::BrIf(1));
        // sh = shadow[i]
        f.instruction(&I::LocalGet(i));
        f.instruction(&I::I32Const(2));
        f.instruction(&I::I32Shl);
        f.instruction(&I::GlobalGet(plan.g_tshadow[t as usize]));
        f.instruction(&I::I32Add);
        f.instruction(&I::I32Load(memarg(0, 2)));
        f.instruction(&I::LocalSet(sh));
        // table.set(t, i, sh == -1 ? null : canon[sh])
        f.instruction(&I::LocalGet(i));
        f.instruction(&I::LocalGet(sh));
        f.instruction(&I::I32Const(-1));
        f.instruction(&I::I32Eq);
        f.instruction(&I::If(BlockType::Result(ValType::Ref(RefType::FUNCREF))));
        f.instruction(&funcref_null());
        f.instruction(&I::Else);
        f.instruction(&I::LocalGet(sh));
        f.instruction(&I::TableGet(plan.canon_table));
        f.instruction(&I::End);
        f.instruction(&I::TableSet(t));
        // i++
        f.instruction(&I::LocalGet(i));
        f.instruction(&I::I32Const(1));
        f.instruction(&I::I32Add);
        f.instruction(&I::LocalSet(i));
        f.instruction(&I::Br(0));
        f.instruction(&I::End); // loop
        f.instruction(&I::End); // block
    }
    f.instruction(&I::End);
    f
}

fn gen_init(plan: &Plan, pm: &ParsedModule<'_>, remap: &mut Remap) -> Result<Function> {
    // locals: 0 old, 1 base_idx
    let mut f = Function::new([(2, ValType::I32)]);
    let (old, base_idx) = (0, 1);
    // idempotence
    f.instruction(&I::GlobalGet(plan.g_rbase));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::I32Ne);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Return);
    f.instruction(&I::End);
    // allocate the region
    let pages = plan
        .region_size
        .div_ceil(weave_core::WASM_PAGE_SIZE as u32)
        .max(1);
    f.instruction(&I::I32Const(pages as i32));
    f.instruction(&I::MemoryGrow(0));
    f.instruction(&I::LocalTee(old));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(old));
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32Shl);
    f.instruction(&I::GlobalSet(plan.g_rbase));
    f.instruction(&I::GlobalGet(plan.g_rbase));
    f.instruction(&I::LocalGet(old));
    f.instruction(&I::I32Store(memarg(0, 2)));
    // segment flags: active data + active/declared elem segments are
    // "already dropped" per spec semantics.
    for (i, d) in pm.datas.iter().enumerate() {
        if matches!(d.kind, wasmparser::DataKind::Active { .. }) {
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::I32Const(1));
            f.instruction(&I::I32Store8(memarg(plan.data_flag_off[&(i as u32)], 0)));
        }
    }
    for (i, e) in pm.elements.iter().enumerate() {
        if !matches!(e.kind, ElementKind::Passive) {
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::I32Const(1));
            f.instruction(&I::I32Store8(memarg(plan.elem_flag_off[&(i as u32)], 0)));
        }
    }
    // table shadows
    if plan.shadows_enabled {
        for t in 0..pm.tables.len() {
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::I32Const(plan.tshadow_init_off[t] as i32));
            f.instruction(&I::I32Add);
            f.instruction(&I::GlobalSet(plan.g_tshadow[t]));
            f.instruction(&I::I32Const(plan.tshadow_init_cap[t] as i32));
            f.instruction(&I::GlobalSet(plan.g_tshadow_cap[t]));
            // fill with -1 (0xFF bytes)
            f.instruction(&I::GlobalGet(plan.g_tshadow[t]));
            f.instruction(&I::I32Const(0xFF));
            f.instruction(&I::I32Const((plan.tshadow_init_cap[t] * 4) as i32));
            f.instruction(&I::MemoryFill(0));
        }
        // seed shadows from active element segments
        for e in pm.elements.iter() {
            let ElementKind::Active {
                table_index,
                offset_expr,
            } = &e.kind
            else {
                continue;
            };
            let t = table_index.unwrap_or(0) as usize;
            // base_idx = offset expr
            let mut r = offset_expr.get_operators_reader();
            while !r.eof() {
                let op = r.read()?;
                if matches!(op, Operator::End) {
                    break;
                }
                let inst = wasm_encoder::reencode::utils::instruction(remap, op)
                    .map_err(|e| anyhow!("offset reencode: {e:?}"))?;
                f.instruction(&inst);
            }
            f.instruction(&I::LocalSet(base_idx));
            let mut items: Vec<i32> = Vec::new();
            match &e.items {
                ElementItems::Functions(r) => {
                    for func in r.clone() {
                        items.push(plan.map_func(func?) as i32);
                    }
                }
                ElementItems::Expressions(_, r) => {
                    for expr in r.clone() {
                        let expr = expr?;
                        let mut val = -1i32;
                        let mut rr = expr.get_operators_reader();
                        while !rr.eof() {
                            match rr.read()? {
                                Operator::RefNull { .. } => val = -1,
                                Operator::RefFunc { function_index } => {
                                    val = plan.map_func(function_index) as i32
                                }
                                Operator::End => {}
                                other => bail!("unsupported element expression: {other:?}"),
                            }
                        }
                        items.push(val);
                    }
                }
            }
            for (k, v) in items.iter().enumerate() {
                f.instruction(&I::GlobalGet(plan.g_tshadow[t]));
                f.instruction(&I::LocalGet(base_idx));
                f.instruction(&I::I32Const(k as i32));
                f.instruction(&I::I32Add);
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::I32Add);
                f.instruction(&I::I32Const(*v));
                f.instruction(&I::I32Store(memarg(0, 2)));
            }
        }
    }
    // the module's original start function runs on fresh runs only
    if let Some(s) = pm.start {
        f.instruction(&I::Call(plan.map_func(s)));
    }
    f.instruction(&I::End);
    Ok(f)
}

fn gen_resume(plan: &Plan) -> Result<Function> {
    // scratch locals: per entry, per result
    let mut locals: Vec<(u32, ValType)> = Vec::new();
    let mut entry_scratch: Vec<Vec<u32>> = Vec::new();
    let mut next_local = 0u32;
    for e in &plan.entries {
        let mut sc = Vec::new();
        for r in &e.results {
            locals.push((1, r.encoder_ty()));
            sc.push(next_local);
            next_local += 1;
        }
        entry_scratch.push(sc);
    }
    let mut f = Function::new(locals);
    f.instruction(&I::Call(plan.globals_load));
    f.instruction(&I::Call(plan.rehydrate));
    f.instruction(&I::I32Const(names::STATE_REWIND));
    f.instruction(&I::GlobalSet(plan.g_state));
    let k = plan.entries.len() as u32;
    // block $bad { block b_{k-1} .. b_0 { br_table(entry) } case0 .. } trap
    f.instruction(&I::Block(BlockType::Empty));
    for _ in 0..k {
        f.instruction(&I::Block(BlockType::Empty));
    }
    f.instruction(&I::GlobalGet(plan.g_entry));
    let targets: Vec<u32> = (0..k).collect();
    f.instruction(&I::BrTable(Cow::from(targets), k));
    for (e_idx, e) in plan.entries.iter().enumerate() {
        f.instruction(&I::End);
        for p in &e.params {
            f.instruction(&zero_of(*p));
        }
        f.instruction(&I::Call(plan.map_func(e.old_func)));
        let sc = &entry_scratch[e_idx];
        for r in sc.iter().rev() {
            f.instruction(&I::LocalSet(*r));
        }
        // A reentrant host callback may have invoked a different entry wrapper.
        f.instruction(&I::I32Const(e_idx as i32));
        f.instruction(&I::GlobalSet(plan.g_entry));
        f.instruction(&I::GlobalGet(plan.g_state));
        f.instruction(&I::I32Const(names::STATE_UNWIND));
        f.instruction(&I::I32Eq);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&I::Call(plan.globals_save));
        f.instruction(&I::I32Const(names::FLAG_UNWOUND));
        f.instruction(&I::GlobalSet(plan.g_flag));
        f.instruction(&I::Else);
        f.instruction(&I::I32Const(names::FLAG_DONE));
        f.instruction(&I::GlobalSet(plan.g_flag));
        for (i, r) in sc.iter().enumerate() {
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::LocalGet(*r));
            f.instruction(&store_of(e.results[i], plan.globals_area + i as u32 * 16));
        }
        f.instruction(&I::End);
        f.instruction(&I::Return);
    }
    f.instruction(&I::End); // $bad
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
    Ok(f)
}

fn gen_wrapper(plan: &Plan, e: &EntryPlan, entry_idx: u32) -> Function {
    let mut locals: Vec<(u32, ValType)> = Vec::new();
    let scratch_base = e.params.len() as u32;
    for r in &e.results {
        locals.push((1, r.encoder_ty()));
    }
    let mut f = Function::new(locals);
    f.instruction(&I::I32Const(names::STATE_RUN));
    f.instruction(&I::GlobalSet(plan.g_state));
    for i in 0..e.params.len() as u32 {
        f.instruction(&I::LocalGet(i));
    }
    f.instruction(&I::Call(plan.map_func(e.old_func)));
    for i in (0..e.results.len() as u32).rev() {
        f.instruction(&I::LocalSet(scratch_base + i));
    }
    // Hosts also use this index to decode completed results. Set it after the
    // call, since a reentrant host callback may invoke another entry wrapper.
    f.instruction(&I::I32Const(entry_idx as i32));
    f.instruction(&I::GlobalSet(plan.g_entry));
    f.instruction(&I::GlobalGet(plan.g_state));
    f.instruction(&I::I32Const(names::STATE_UNWIND));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Call(plan.globals_save));
    f.instruction(&I::I32Const(names::FLAG_UNWOUND));
    f.instruction(&I::GlobalSet(plan.g_flag));
    f.instruction(&I::Else);
    f.instruction(&I::I32Const(names::FLAG_DONE));
    f.instruction(&I::GlobalSet(plan.g_flag));
    for (i, r) in e.results.iter().enumerate() {
        f.instruction(&I::GlobalGet(plan.g_rbase));
        f.instruction(&I::LocalGet(scratch_base + i as u32));
        f.instruction(&store_of(*r, plan.globals_area + i as u32 * 16));
    }
    f.instruction(&I::End);
    for i in 0..e.results.len() as u32 {
        f.instruction(&I::LocalGet(scratch_base + i));
    }
    f.instruction(&I::End);
    f
}

fn gen_helper(
    plan: &Plan,
    pm: &ParsedModule<'_>,
    kind: HelperKind,
    shadow_data: &HashMap<u32, u32>,
) -> Result<Function> {
    let _ = pm;
    Ok(match kind {
        HelperKind::Grow(t) => {
            // params: 0 v(funcref), 1 vsh, 2 n. locals: 3 old, 4 newcap, 5 newptr, 6 k
            let mut f = Function::new([(4, ValType::I32)]);
            let (v, vsh, n, old, newcap, newptr, k) = (0, 1, 2, 3, 4, 5, 6);
            f.instruction(&I::LocalGet(v));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::TableGrow(t));
            f.instruction(&I::LocalTee(old));
            f.instruction(&I::I32Const(-1));
            f.instruction(&I::I32Eq);
            f.instruction(&I::If(BlockType::Empty));
            f.instruction(&I::I32Const(-1));
            f.instruction(&I::Return);
            f.instruction(&I::End);
            // capacity check: old + n > cap ?
            f.instruction(&I::LocalGet(old));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32Add);
            f.instruction(&I::GlobalGet(plan.g_tshadow_cap[t as usize]));
            f.instruction(&I::I32GtU);
            f.instruction(&I::If(BlockType::Empty));
            {
                // newcap = max(cap*2, old+n)
                f.instruction(&I::GlobalGet(plan.g_tshadow_cap[t as usize]));
                f.instruction(&I::I32Const(1));
                f.instruction(&I::I32Shl);
                f.instruction(&I::LocalSet(newcap));
                f.instruction(&I::LocalGet(newcap));
                f.instruction(&I::LocalGet(old));
                f.instruction(&I::LocalGet(n));
                f.instruction(&I::I32Add);
                f.instruction(&I::I32LtU);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::LocalGet(old));
                f.instruction(&I::LocalGet(n));
                f.instruction(&I::I32Add);
                f.instruction(&I::LocalSet(newcap));
                f.instruction(&I::End);
                // newptr = grow(pages(newcap*4)) << 16
                f.instruction(&I::LocalGet(newcap));
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::I32Const(0xFFFF));
                f.instruction(&I::I32Add);
                f.instruction(&I::I32Const(16));
                f.instruction(&I::I32ShrU);
                f.instruction(&I::MemoryGrow(0));
                f.instruction(&I::LocalTee(newptr));
                f.instruction(&I::I32Const(-1));
                f.instruction(&I::I32Eq);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::Unreachable);
                f.instruction(&I::End);
                f.instruction(&I::LocalGet(newptr));
                f.instruction(&I::I32Const(16));
                f.instruction(&I::I32Shl);
                f.instruction(&I::LocalSet(newptr));
                // fill new with 0xFF, copy old entries over
                f.instruction(&I::LocalGet(newptr));
                f.instruction(&I::I32Const(0xFF));
                f.instruction(&I::LocalGet(newcap));
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::MemoryFill(0));
                f.instruction(&I::LocalGet(newptr));
                f.instruction(&I::GlobalGet(plan.g_tshadow[t as usize]));
                f.instruction(&I::LocalGet(old));
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::MemoryCopy {
                    dst_mem: 0,
                    src_mem: 0,
                });
                f.instruction(&I::LocalGet(newptr));
                f.instruction(&I::GlobalSet(plan.g_tshadow[t as usize]));
                f.instruction(&I::LocalGet(newcap));
                f.instruction(&I::GlobalSet(plan.g_tshadow_cap[t as usize]));
            }
            f.instruction(&I::End);
            // write vsh into entries [old, old+n)
            f.instruction(&I::I32Const(0));
            f.instruction(&I::LocalSet(k));
            f.instruction(&I::Block(BlockType::Empty));
            f.instruction(&I::Loop(BlockType::Empty));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32GeU);
            f.instruction(&I::BrIf(1));
            f.instruction(&I::LocalGet(old));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::I32Add);
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::GlobalGet(plan.g_tshadow[t as usize]));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(vsh));
            f.instruction(&I::I32Store(memarg(0, 2)));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::I32Const(1));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalSet(k));
            f.instruction(&I::Br(0));
            f.instruction(&I::End);
            f.instruction(&I::End);
            f.instruction(&I::LocalGet(old));
            f.instruction(&I::End);
            f
        }
        HelperKind::Fill(t) => {
            // params: 0 i, 1 v(funcref), 2 vsh, 3 n. locals: 4 k
            let mut f = Function::new([(1, ValType::I32)]);
            let (i, v, vsh, n, k) = (0, 1, 2, 3, 4);
            f.instruction(&I::LocalGet(i));
            f.instruction(&I::LocalGet(v));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::TableFill(t));
            f.instruction(&I::I32Const(0));
            f.instruction(&I::LocalSet(k));
            f.instruction(&I::Block(BlockType::Empty));
            f.instruction(&I::Loop(BlockType::Empty));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32GeU);
            f.instruction(&I::BrIf(1));
            f.instruction(&I::LocalGet(i));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::I32Add);
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::GlobalGet(plan.g_tshadow[t as usize]));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(vsh));
            f.instruction(&I::I32Store(memarg(0, 2)));
            f.instruction(&I::LocalGet(k));
            f.instruction(&I::I32Const(1));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalSet(k));
            f.instruction(&I::Br(0));
            f.instruction(&I::End);
            f.instruction(&I::End);
            f.instruction(&I::End);
            f
        }
        HelperKind::Copy(dt, st) => {
            // params: 0 d, 1 s, 2 n
            let mut f = Function::new([]);
            let (d, s, n) = (0, 1, 2);
            f.instruction(&I::LocalGet(d));
            f.instruction(&I::LocalGet(s));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::TableCopy {
                dst_table: dt,
                src_table: st,
            });
            // shadow copy (memory.copy handles overlap identically)
            f.instruction(&I::LocalGet(d));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::GlobalGet(plan.g_tshadow[dt as usize]));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(s));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::GlobalGet(plan.g_tshadow[st as usize]));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::MemoryCopy {
                dst_mem: 0,
                src_mem: 0,
            });
            f.instruction(&I::End);
            f
        }
        HelperKind::Init(t, e) => {
            // params: 0 d, 1 s, 2 n
            let mut f = Function::new([]);
            let (d, s, n) = (0, 1, 2);
            let flag_off = plan.elem_flag_off[&e];
            let shadow_seg = *shadow_data
                .get(&e)
                .ok_or_else(|| anyhow!("BUG: missing shadow data segment for elem {e}"))?;
            f.instruction(&I::GlobalGet(plan.g_rbase));
            f.instruction(&I::I32Load8U(memarg(flag_off, 0)));
            f.instruction(&I::If(BlockType::Empty));
            // dropped: trap unless s == 0 && n == 0 && d <= table.size
            f.instruction(&I::LocalGet(s));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32Or);
            f.instruction(&I::If(BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
            f.instruction(&I::LocalGet(d));
            f.instruction(&I::TableSize(t));
            f.instruction(&I::I32GtU);
            f.instruction(&I::If(BlockType::Empty));
            f.instruction(&I::Unreachable);
            f.instruction(&I::End);
            f.instruction(&I::Else);
            f.instruction(&I::LocalGet(d));
            f.instruction(&I::LocalGet(s));
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::TableInit {
                elem_index: e,
                table: t,
            });
            // shadow: memory.init(dst = tshadow + d*4, src = s*4, len = n*4)
            f.instruction(&I::LocalGet(d));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::GlobalGet(plan.g_tshadow[t as usize]));
            f.instruction(&I::I32Add);
            f.instruction(&I::LocalGet(s));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::LocalGet(n));
            f.instruction(&I::I32Const(2));
            f.instruction(&I::I32Shl);
            f.instruction(&I::MemoryInit {
                mem: 0,
                data_index: shadow_seg,
            });
            f.instruction(&I::End);
            f.instruction(&I::End);
            f
        }
    })
}
