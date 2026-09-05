//! Parsed model of the input module: everything the instrumenter needs to
//! reason about, with borrowed views into the original binary for the parts
//! we re-encode verbatim.

use anyhow::{bail, Context, Result};
use wasmparser::{
    CompositeInnerType, Data, DataKind, Element, ElementItems, ElementKind, ExternalKind,
    FunctionBody, Global, OperatorsReader, Parser, Payload, RecGroup, Table, TableInit, TypeRef,
    ValType,
};

#[derive(Debug, Clone, PartialEq)]
pub struct FuncSig {
    pub params: Vec<ValType>,
    pub results: Vec<ValType>,
}

#[derive(Debug, Clone)]
pub struct ImportedFunc {
    pub module: String,
    pub name: String,
    pub type_idx: u32,
}

#[derive(Debug, Clone)]
pub struct ExportItem {
    pub name: String,
    pub kind: ExternalKind,
    pub index: u32,
}

pub struct ParsedModule<'a> {
    pub types: Vec<FuncSig>,
    /// Raw rec groups for re-encoding the type section faithfully.
    pub raw_types: Vec<RecGroup>,
    pub imported_funcs: Vec<ImportedFunc>,
    pub num_imported_tables: u32,
    pub num_imported_memories: u32,
    pub num_imported_globals: u32,
    /// Raw import entries for re-encoding.
    pub raw_imports: Vec<wasmparser::Import<'a>>,
    /// Type index of each defined function.
    pub func_types: Vec<u32>,
    /// All tables (imported first), as (element wasparser RefType, initial, maximum).
    pub tables: Vec<wasmparser::TableType>,
    pub defined_tables: Vec<Table<'a>>,
    /// All memories (imported first).
    pub memories: Vec<wasmparser::MemoryType>,
    /// All global types (imported first).
    pub global_types: Vec<wasmparser::GlobalType>,
    pub defined_globals: Vec<Global<'a>>,
    pub exports: Vec<ExportItem>,
    pub start: Option<u32>,
    pub elements: Vec<Element<'a>>,
    pub datas: Vec<Data<'a>>,
    pub code: Vec<FunctionBody<'a>>,
}

impl ParsedModule<'_> {
    /// Signature of a function by (old) function index, imports included.
    pub fn func_sig(&self, func: u32) -> &FuncSig {
        let ti = if (func as usize) < self.imported_funcs.len() {
            self.imported_funcs[func as usize].type_idx
        } else {
            self.func_types[func as usize - self.imported_funcs.len()]
        };
        &self.types[ti as usize]
    }

    pub fn num_imported_funcs(&self) -> u32 {
        self.imported_funcs.len() as u32
    }
}

pub fn parse(wasm: &[u8]) -> Result<ParsedModule<'_>> {
    let mut m = ParsedModule {
        types: Vec::new(),
        raw_types: Vec::new(),
        imported_funcs: Vec::new(),
        num_imported_tables: 0,
        num_imported_memories: 0,
        num_imported_globals: 0,
        raw_imports: Vec::new(),
        func_types: Vec::new(),
        tables: Vec::new(),
        defined_tables: Vec::new(),
        memories: Vec::new(),
        global_types: Vec::new(),
        defined_globals: Vec::new(),
        exports: Vec::new(),
        start: None,
        elements: Vec::new(),
        datas: Vec::new(),
        code: Vec::new(),
    };

    // Recognize unsupported proposals before validation: our parser can decode
    // newer GC constant expressions which its validator does not yet accept.
    // This is a rejection-only preflight, never a replacement for validation.
    if let Some(feature) = unsupported_feature(wasm).context("input module failed validation")? {
        bail!("unsupported: {feature}");
    }

    // Validate up front so the instrumenter can assume a well-typed module.
    wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
        .validate_all(wasm)
        .context("input module failed validation")?;

    for payload in Parser::new(0).parse_all(wasm) {
        match payload? {
            Payload::TypeSection(r) => {
                for group in r {
                    let group = group?;
                    for sub in group.types() {
                        match &sub.composite_type.inner {
                            CompositeInnerType::Func(f) => {
                                m.types.push(FuncSig {
                                    params: f.params().to_vec(),
                                    results: f.results().to_vec(),
                                });
                            }
                            other => bail!("unsupported (GC) type in type section: {other:?}"),
                        }
                    }
                    m.raw_types.push(group);
                }
            }
            Payload::ImportSection(r) => {
                for imp in r {
                    let imp = imp?;
                    match imp.ty {
                        TypeRef::Func(ti) => m.imported_funcs.push(ImportedFunc {
                            module: imp.module.to_string(),
                            name: imp.name.to_string(),
                            type_idx: ti,
                        }),
                        TypeRef::Table(t) => {
                            m.num_imported_tables += 1;
                            m.tables.push(t);
                        }
                        TypeRef::Memory(mt) => {
                            m.num_imported_memories += 1;
                            m.memories.push(mt);
                        }
                        TypeRef::Global(g) => {
                            m.num_imported_globals += 1;
                            m.global_types.push(g);
                        }
                        TypeRef::Tag(_) => bail!("unsupported: exception tags"),
                    }
                    m.raw_imports.push(imp);
                }
            }
            Payload::FunctionSection(r) => {
                for ti in r {
                    m.func_types.push(ti?);
                }
            }
            Payload::TableSection(r) => {
                for t in r {
                    let t = t?;
                    m.tables.push(t.ty);
                    m.defined_tables.push(t);
                }
            }
            Payload::MemorySection(r) => {
                for mem in r {
                    m.memories.push(mem?);
                }
            }
            // Also reject here so a future preflight refactor cannot silently
            // discard a tag section while retaining instructions that use it.
            Payload::TagSection(r) if r.count() != 0 => {
                bail!("unsupported: exception tags");
            }
            Payload::GlobalSection(r) => {
                for g in r {
                    let g = g?;
                    m.global_types.push(g.ty);
                    m.defined_globals.push(g);
                }
            }
            Payload::ExportSection(r) => {
                for e in r {
                    let e = e?;
                    m.exports.push(ExportItem {
                        name: e.name.to_string(),
                        kind: e.kind,
                        index: e.index,
                    });
                }
            }
            Payload::StartSection { func, .. } => m.start = Some(func),
            Payload::ElementSection(r) => {
                for e in r {
                    m.elements.push(e?);
                }
            }
            Payload::DataSection(r) => {
                for d in r {
                    m.datas.push(d?);
                }
            }
            Payload::CodeSectionEntry(body) => m.code.push(body),
            _ => {}
        }
    }

    // ---- support-matrix checks (see docs/DESIGN.md for rationale) ----
    for mem in &m.memories {
        if mem.memory64 {
            bail!("unsupported: memory64");
        }
        if mem.shared {
            bail!(
                "unsupported: shared (threaded) memories — concurrent mutation cannot be \
                   consistently checkpointed without stop-the-world across threads"
            );
        }
    }
    if m.num_imported_memories > 0 && m.memories[0].maximum.is_some() {
        bail!("unsupported: imported memory 0 with a finite maximum cannot provide private checkpoint storage; define the memory in the module or supply an unbounded memory import");
    }
    // Atomic accesses can also occur on unshared memories. They are outside
    // the supported single-threaded instruction set and must not bypass the
    // guest bounds enforced around ordinary memory operations.
    for body in &m.code {
        let mut operators = body.get_operators_reader()?;
        while !operators.eof() {
            if is_atomic(&operators.read()?) {
                bail!("unsupported: atomic instructions");
            }
        }
    }
    for t in &m.tables {
        if t.table64 {
            bail!("unsupported: table64 (64-bit table indices)");
        }
        let rt = t.element_type;
        if !rt.is_func_ref() {
            bail!(
                "unsupported: non-funcref table ({rt}) — externref values are opaque host \
                 references and cannot be portably serialized; use i32 handles plus a weave \
                 host service instead"
            );
        }
    }
    for g in &m.global_types {
        if let ValType::Ref(rt) = g.content_type {
            if !rt.is_func_ref() {
                bail!("unsupported: non-funcref reference global ({rt})");
            }
        }
    }
    for sig in &m.types {
        for vt in sig.params.iter().chain(sig.results.iter()) {
            if let ValType::Ref(rt) = vt {
                if !rt.is_func_ref() {
                    bail!("unsupported: non-funcref reference in function signature ({rt})");
                }
                bail!(
                    "unsupported: funcref in a function signature — pass an i32 table index \
                     instead (LLVM/Rust/Go toolchains already do this)"
                );
            }
        }
    }
    if m.memories.is_empty() {
        // The shadow stack, saved globals and table shadows live in memory 0.
        // A module with no memory at all gets one added by the transformer.
    }
    Ok(m)
}

/// Inspect declarations and instructions without assuming a well-typed input.
/// Keep reading after finding an unsupported feature so truncated encodings in
/// these sections still report decoding errors, not an unsupported-feature
/// diagnostic. Every input which passes this check is fully validated above.
fn unsupported_feature(wasm: &[u8]) -> wasmparser::Result<Option<&'static str>> {
    let mut feature = None;
    for payload in Parser::new(0).parse_all(wasm) {
        match payload? {
            Payload::ImportSection(imports) => {
                for import in imports {
                    match import?.ty {
                        TypeRef::Table(table) if table.table64 => {
                            feature.get_or_insert("table64 (64-bit table indices)");
                        }
                        TypeRef::Tag(_) => {
                            feature.get_or_insert("exception tags");
                        }
                        _ => {}
                    }
                }
            }
            Payload::TableSection(tables) => {
                for table in tables {
                    let table = table?;
                    if table.ty.table64 {
                        feature.get_or_insert("table64 (64-bit table indices)");
                    }
                    if let TableInit::Expr(expr) = table.init {
                        scan_unsupported_operators(expr.get_operators_reader(), &mut feature)?;
                    }
                }
            }
            Payload::TagSection(tags) => {
                for tag in tags {
                    tag?;
                    feature.get_or_insert("exception tags");
                }
            }
            Payload::GlobalSection(globals) => {
                for global in globals {
                    scan_unsupported_operators(
                        global?.init_expr.get_operators_reader(),
                        &mut feature,
                    )?;
                }
            }
            Payload::ElementSection(elements) => {
                for element in elements {
                    let element = element?;
                    if let ElementKind::Active { offset_expr, .. } = element.kind {
                        scan_unsupported_operators(
                            offset_expr.get_operators_reader(),
                            &mut feature,
                        )?;
                    }
                    if let ElementItems::Expressions(_, expressions) = element.items {
                        for expr in expressions {
                            scan_unsupported_operators(expr?.get_operators_reader(), &mut feature)?;
                        }
                    }
                }
            }
            Payload::DataSection(segments) => {
                for segment in segments {
                    if let DataKind::Active { offset_expr, .. } = segment?.kind {
                        scan_unsupported_operators(
                            offset_expr.get_operators_reader(),
                            &mut feature,
                        )?;
                    }
                }
            }
            Payload::CodeSectionEntry(body) => {
                scan_unsupported_operators(body.get_operators_reader()?, &mut feature)?;
            }
            _ => {}
        }
    }
    Ok(feature)
}

fn scan_unsupported_operators(
    mut operators: OperatorsReader<'_>,
    feature: &mut Option<&'static str>,
) -> wasmparser::Result<()> {
    while !operators.eof() {
        let op = operators.read()?;
        if let Some(found) = unsupported_operator(&op) {
            feature.get_or_insert(found);
        }
    }
    Ok(())
}

fn unsupported_operator(op: &wasmparser::Operator<'_>) -> Option<&'static str> {
    macro_rules! classify {
        ($( @$proposal:ident $operator:ident $({ $($arg:ident: $ty:ty),* })?
            => $visit:ident ($($annotation:tt)*))*) => {
            match op {
                $(wasmparser::Operator::$operator $({ $($arg: _),* })? =>
                    match stringify!($proposal) {
                        "exceptions" | "legacy_exceptions" => Some("exception instructions"),
                        "gc" => Some("GC instructions"),
                        _ => None,
                    },)*
                _ => None,
            }
        };
    }
    wasmparser::for_each_operator!(classify)
}

fn is_atomic(op: &wasmparser::Operator<'_>) -> bool {
    macro_rules! classify {
        ($( @$proposal:ident $operator:ident $({ $($arg:ident: $ty:ty),* })?
            => $visit:ident ($($annotation:tt)*))*) => {
            match op {
                $(wasmparser::Operator::$operator $({ $($arg: _),* })? =>
                    stringify!($proposal) == "threads",)*
                _ => false,
            }
        };
    }
    wasmparser::for_each_operator!(classify)
}
