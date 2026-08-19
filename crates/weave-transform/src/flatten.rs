//! Per-function flattening + instrumentation.
//!
//! A function is lowered into "flat blocks" — straight-line instruction runs
//! with explicit terminators — dispatched by a `loop { br_table(pc) }`. Every
//! operand-stack value is registerized into a local keyed by `(depth, type)`,
//! so at any checkpoint site the complete live state of the function is
//! exactly its locals plus the current flat-block index. Typing is driven by
//! wasmparser's own validator (operand types + operator arity), never by a
//! hand-maintained table.

use crate::emit::Plan;
use crate::module::ParsedModule;
use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use wasmparser::{
    BlockType, FuncValidator, FunctionBody, Operator, ValType, ValidatorResources,
};

/// Normalized slot type. All reference types are funcref (enforced upstream).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum SlotKey {
    I32,
    I64,
    F32,
    F64,
    V128,
    FuncRef,
}

impl SlotKey {
    pub fn of(vt: ValType) -> SlotKey {
        match vt {
            ValType::I32 => SlotKey::I32,
            ValType::I64 => SlotKey::I64,
            ValType::F32 => SlotKey::F32,
            ValType::F64 => SlotKey::F64,
            ValType::V128 => SlotKey::V128,
            ValType::Ref(_) => SlotKey::FuncRef,
        }
    }

    pub fn byte_size(self) -> u32 {
        match self {
            SlotKey::I32 | SlotKey::F32 | SlotKey::FuncRef => 4,
            SlotKey::I64 | SlotKey::F64 => 8,
            SlotKey::V128 => 16,
        }
    }

    pub fn encoder_ty(self) -> wasm_encoder::ValType {
        match self {
            SlotKey::I32 => wasm_encoder::ValType::I32,
            SlotKey::I64 => wasm_encoder::ValType::I64,
            SlotKey::F32 => wasm_encoder::ValType::F32,
            SlotKey::F64 => wasm_encoder::ValType::F64,
            SlotKey::V128 => wasm_encoder::ValType::V128,
            SlotKey::FuncRef => wasm_encoder::ValType::Ref(wasm_encoder::RefType::FUNCREF),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Slot {
    pub depth: u32,
    pub key: SlotKey,
}

#[derive(Debug)]
pub enum Ins<'a> {
    /// Pass-through operator: read `ins` from slot locals, run op, write `outs`.
    Op { op: Operator<'a>, ins: Vec<Slot>, outs: Vec<Slot> },
    /// Slot-to-slot move (branch argument shuffling).
    Copy { from: Slot, to: Slot },
    /// Set the i32 shadow companion of a funcref slot.
    ShadowConst { slot: Slot, val: i32 },
    ShadowFromLocal { orig_local: u32, slot: Slot },
    ShadowToLocal { slot: Slot, orig_local: u32 },
    ShadowFromGlobal { shadow_global: u32, slot: Slot },
    ShadowToGlobal { slot: Slot, shadow_global: u32 },
    ShadowSelect { cond: Slot, on_true: Slot, on_false: Slot, out: Slot },
    /// Read `tshadow[t][idx]` into `out`'s shadow (after the real table.get).
    ShadowTableGet { table: u32, idx: Slot, out: Slot },
    /// Write `val`'s shadow into `tshadow[t][idx]` (after the real table.set).
    ShadowTableSet { table: u32, idx: Slot, val: Slot },
    /// Mark a passive segment dropped (weave keeps the real segment alive so a
    /// restored instance on a fresh instantiation still has it; init ops are
    /// gated on this flag instead).
    SegDropFlag { flag_off: u32 },
    /// `memory.init` with dropped-segment gating that reproduces trap semantics.
    GatedMemInit { data: u32, flag_off: u32, dst: Slot, src: Slot, len: Slot, mem: u32 },
    /// Call to a generated table helper.
    HelperCall { helper: u32, args: Vec<HelperArg>, out: Option<Slot> },
}

#[derive(Debug)]
pub enum HelperArg {
    /// Push the funcref value of a slot.
    Ref(Slot),
    /// Push the i32 shadow of a funcref slot.
    Shadow(Slot),
    /// Push the plain value of a slot.
    Val(Slot),
}

#[derive(Debug)]
pub enum Site<'a> {
    /// Counter-gated `weave.poll` + potential self-spill. Resume lands on the
    /// block's terminator target.
    Poll,
    /// Call that can transitively unwind; followed by an unwind check + spill.
    /// Resume re-executes this call (args are re-read from their slots).
    Call { op: Operator<'a>, ins: Vec<Slot>, outs: Vec<Slot> },
}

#[derive(Debug)]
pub enum Term {
    Goto(usize),
    CondGoto { cond: Slot, t: usize, f: usize },
    TableGoto { index: Slot, targets: Vec<usize>, default: usize },
    Return { vals: Vec<Slot> },
    Trap,
}

#[derive(Debug)]
pub struct FlatBlock<'a> {
    pub site: Option<Site<'a>>,
    pub insts: Vec<Ins<'a>>,
    pub term: Term,
}

impl<'a> FlatBlock<'a> {
    fn new() -> Self {
        FlatBlock { site: None, insts: Vec::new(), term: Term::Trap }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum MyKind {
    Func,
    Block,
    Loop,
    If,
    Else,
}

struct MyFrame {
    kind: MyKind,
    /// Operand height at frame entry with params popped: label values land at
    /// depths [base, base+n).
    base: u32,
    params: Vec<SlotKey>,
    results: Vec<SlotKey>,
    end_label: usize,
    head_label: Option<usize>,
    else_label: Option<usize>,
}

/// Locals bookkeeping: original locals keep their indices; slot locals,
/// shadow locals and `pc` are appended.
pub struct LocalMap {
    pub n_orig: u32,
    pub orig_types: Vec<SlotKey>,
    pub extra: Vec<SlotKey>,
    slot_map: HashMap<(u32, SlotKey), u32>,
    pub orig_shadow: HashMap<u32, u32>,
    pub slot_shadow: HashMap<u32, u32>,
    pub pc: u32,
}

impl LocalMap {
    fn new(orig_types: Vec<SlotKey>) -> Self {
        LocalMap {
            n_orig: orig_types.len() as u32,
            orig_types,
            extra: Vec::new(),
            slot_map: HashMap::new(),
            orig_shadow: HashMap::new(),
            slot_shadow: HashMap::new(),
            pc: 0,
        }
    }

    fn alloc(&mut self, key: SlotKey) -> u32 {
        let idx = self.n_orig + self.extra.len() as u32;
        self.extra.push(key);
        idx
    }

    pub fn slot_local(&mut self, s: Slot) -> u32 {
        if let Some(&l) = self.slot_map.get(&(s.depth, s.key)) {
            return l;
        }
        let l = self.alloc(s.key);
        self.slot_map.insert((s.depth, s.key), l);
        if s.key == SlotKey::FuncRef {
            let sh = self.alloc(SlotKey::I32);
            self.slot_shadow.insert(l, sh);
        }
        l
    }

    pub fn slot_shadow_local(&mut self, s: Slot) -> u32 {
        debug_assert_eq!(s.key, SlotKey::FuncRef);
        let l = self.slot_local(s);
        self.slot_shadow[&l]
    }

    pub fn orig_shadow_local(&mut self, orig: u32) -> u32 {
        if let Some(&sh) = self.orig_shadow.get(&orig) {
            return sh;
        }
        let sh = self.alloc(SlotKey::I32);
        self.orig_shadow.insert(orig, sh);
        sh
    }
}

/// A fully flattened function, ready for emission.
pub struct Flattened<'a> {
    pub blocks: Vec<FlatBlock<'a>>,
    pub locals: LocalMap,
    pub params: Vec<SlotKey>,
    pub results: Vec<SlotKey>,
    pub instrumented: bool,
}

pub struct Flattener<'a, 'p> {
    pm: &'p ParsedModule<'a>,
    plan: &'p Plan,
    fv: FuncValidator<ValidatorResources>,
    instrumented: bool,
    blocks: Vec<FlatBlock<'a>>,
    cur: Option<usize>,
    frames: Vec<MyFrame>,
    locals: LocalMap,
    params: Vec<SlotKey>,
    results: Vec<SlotKey>,
}

impl<'a, 'p> Flattener<'a, 'p> {
    pub fn run(
        pm: &'p ParsedModule<'a>,
        plan: &'p Plan,
        defined_idx: u32,
        body: &FunctionBody<'a>,
        mut fv: FuncValidator<ValidatorResources>,
    ) -> Result<Flattened<'a>> {
        let sig = pm.func_sig(pm.num_imported_funcs() + defined_idx);
        let params: Vec<SlotKey> = sig.params.iter().map(|t| SlotKey::of(*t)).collect();
        let results: Vec<SlotKey> = sig.results.iter().map(|t| SlotKey::of(*t)).collect();

        // Collect original local types (params + declared).
        let mut orig_types = params.clone();
        for l in body.get_locals_reader()? {
            let (count, ty) = l?;
            for _ in 0..count {
                orig_types.push(SlotKey::of(ty));
            }
        }

        let mut br = body.get_binary_reader();
        fv.read_locals(&mut br)?;

        let instrumented = plan.instrumented[defined_idx as usize];
        let mut fl = Flattener {
            pm,
            plan,
            fv,
            instrumented,
            blocks: Vec::new(),
            cur: None,
            frames: Vec::new(),
            locals: LocalMap::new(orig_types),
            params,
            results: results.clone(),
        };

        // Block 0: entry. `pc` is a fresh local and defaults to 0, so block 0
        // MUST be the entry. Instrumented functions poll here (this is what
        // makes pure recursion checkpointable).
        let b0 = fl.reserve();
        debug_assert_eq!(b0, 0);
        // Function-level implicit frame.
        let func_end = fl.reserve();
        fl.frames.push(MyFrame {
            kind: MyKind::Func,
            base: 0,
            params: Vec::new(),
            results,
            end_label: func_end,
            head_label: None,
            else_label: None,
        });
        fl.open(b0);
        if instrumented {
            let body_start = fl.reserve();
            fl.blocks[b0].site = Some(Site::Poll);
            fl.blocks[b0].term = Term::Goto(body_start);
            fl.open(body_start);
        }

        let mut ops = body.get_operators_reader()?;
        while !ops.eof() {
            let pos = ops.original_position();
            let op = ops.clone().read()?;
            fl.step(&mut ops, pos, op)?;
        }
        fl.fv.finish(ops.original_position())?;

        if !fl.frames.is_empty() {
            bail!("BUG: control frames remain after function end");
        }

        Ok(Flattened {
            blocks: fl.blocks,
            locals: fl.locals,
            params: fl.params,
            results: fl.results,
            instrumented: fl.instrumented,
        })
    }

    // ---- block plumbing ----

    fn reserve(&mut self) -> usize {
        self.blocks.push(FlatBlock::new());
        self.blocks.len() - 1
    }

    fn open(&mut self, label: usize) {
        self.cur = Some(label);
    }

    fn push_ins(&mut self, ins: Ins<'a>) {
        if let Some(c) = self.cur {
            self.blocks[c].insts.push(ins);
        }
    }

    fn set_term(&mut self, term: Term) {
        if let Some(c) = self.cur {
            self.blocks[c].term = term;
        }
        self.cur = None;
    }

    /// Split point: close the current block with a Goto and open a fresh one.
    fn split(&mut self) -> usize {
        let next = self.reserve();
        self.set_term(Term::Goto(next));
        self.open(next);
        next
    }

    // ---- validator helpers ----

    fn height(&self) -> u32 {
        self.fv.operand_stack_height()
    }

    fn live(&self) -> bool {
        match self.fv.get_control_frame(0) {
            Some(f) => !f.unreachable,
            None => false,
        }
    }

    fn operand_key(&self, depth_from_top: usize) -> Result<SlotKey> {
        let t = self
            .fv
            .get_operand_type(depth_from_top)
            .ok_or_else(|| anyhow!("BUG: operand depth {depth_from_top} out of range"))?
            .ok_or_else(|| anyhow!("BUG: polymorphic operand in reachable code"))?;
        Ok(SlotKey::of(t))
    }

    /// Slots for the top `n` operands (deepest first), queried pre-op.
    fn top_slots(&self, n: usize) -> Result<Vec<Slot>> {
        let h = self.height();
        let mut v = Vec::with_capacity(n);
        for i in 0..n {
            let key = self.operand_key(n - 1 - i)?;
            v.push(Slot { depth: h - n as u32 + i as u32, key });
        }
        Ok(v)
    }

    fn resolve_blockty(&self, bt: BlockType) -> (Vec<SlotKey>, Vec<SlotKey>) {
        match bt {
            BlockType::Empty => (vec![], vec![]),
            BlockType::Type(t) => (vec![], vec![SlotKey::of(t)]),
            BlockType::FuncType(i) => {
                let sig = &self.pm.types[i as usize];
                (
                    sig.params.iter().map(|t| SlotKey::of(*t)).collect(),
                    sig.results.iter().map(|t| SlotKey::of(*t)).collect(),
                )
            }
        }
    }

    fn validate(&mut self, ops: &mut wasmparser::OperatorsReader<'a>, pos: usize) -> Result<()> {
        ops.visit_operator(&mut self.fv.simd_visitor(pos))?
            .with_context(|| format!("validating operator at {pos}"))?;
        Ok(())
    }

    /// Apply the post-op liveness rule.
    fn apply_liveness(&mut self) {
        if !self.frames.is_empty() && !self.live() {
            self.cur = None;
        }
    }

    // ---- branch helpers ----

    /// (label, arg types, target base) for a `br` of relative depth `d`.
    fn br_target(&self, d: u32) -> (usize, Vec<SlotKey>, u32) {
        let f = &self.frames[self.frames.len() - 1 - d as usize];
        if f.kind == MyKind::Loop {
            (f.head_label.unwrap(), f.params.clone(), f.base)
        } else {
            (f.end_label, f.results.clone(), f.base)
        }
    }

    /// Copies to shuffle the top `tys.len()` values (ending at `from_top`)
    /// down to the target label's expected depths.
    fn branch_copies(&self, tys: &[SlotKey], from_top: u32, target_base: u32) -> Vec<(Slot, Slot)> {
        let n = tys.len() as u32;
        let mut copies = Vec::new();
        for (i, ty) in tys.iter().enumerate() {
            let src = Slot { depth: from_top - n + i as u32, key: *ty };
            let dst = Slot { depth: target_base + i as u32, key: *ty };
            if src.depth != dst.depth {
                copies.push((src, dst));
            }
        }
        copies
    }

    /// Route a branch through a trampoline block when argument shuffling is
    /// needed (so the fall-through path's live slots are never clobbered).
    fn branch_label(&mut self, d: u32, from_top: u32) -> usize {
        let (label, tys, base) = self.br_target(d);
        let copies = self.branch_copies(&tys, from_top, base);
        if copies.is_empty() {
            return label;
        }
        let tramp = self.reserve();
        for (from, to) in copies {
            self.blocks[tramp].insts.push(Ins::Copy { from, to });
        }
        self.blocks[tramp].term = Term::Goto(label);
        tramp
    }

    // ---- the per-operator step ----

    fn step(
        &mut self,
        ops: &mut wasmparser::OperatorsReader<'a>,
        pos: usize,
        op: Operator<'a>,
    ) -> Result<()> {
        let live = self.live();
        match op {
            Operator::Block { blockty } | Operator::Loop { blockty } | Operator::If { blockty } => {
                let (params, results) = self.resolve_blockty(blockty);
                let is_if = matches!(op, Operator::If { .. });
                let is_loop = matches!(op, Operator::Loop { .. });
                let h = self.height();
                // `if` pops its condition before the params land.
                let base = if live {
                    h - params.len() as u32 - if is_if { 1 } else { 0 }
                } else {
                    0
                };
                let end_label = self.reserve();
                let mut frame = MyFrame {
                    kind: if is_if {
                        MyKind::If
                    } else if is_loop {
                        MyKind::Loop
                    } else {
                        MyKind::Block
                    },
                    base,
                    params,
                    results,
                    end_label,
                    head_label: None,
                    else_label: None,
                };
                if is_if {
                    let then_l = self.reserve();
                    let else_l = self.reserve();
                    frame.else_label = Some(else_l);
                    if live {
                        let cond = Slot { depth: h - 1, key: SlotKey::I32 };
                        self.set_term(Term::CondGoto { cond, t: then_l, f: else_l });
                        self.open(then_l);
                    }
                    // Default: an if with no else is a pass-through.
                    self.blocks[else_l].term = Term::Goto(end_label);
                } else if is_loop {
                    let head = self.reserve();
                    frame.head_label = Some(head);
                    if live {
                        self.set_term(Term::Goto(head));
                        self.open(head);
                        if self.instrumented {
                            // Poll at the back-edge target: every loop
                            // iteration passes through here.
                            let body = self.reserve();
                            self.blocks[head].site = Some(Site::Poll);
                            self.blocks[head].term = Term::Goto(body);
                            self.open(body);
                        }
                    }
                }
                self.frames.push(frame);
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::Else => {
                let f = self.frames.last().unwrap();
                let (end_label, else_label) = (f.end_label, f.else_label.unwrap());
                if live {
                    self.set_term(Term::Goto(end_label));
                }
                self.validate(ops, pos)?;
                // Re-purpose the pass-through default: this really is an else.
                self.blocks[else_label].term = Term::Trap;
                self.frames.last_mut().unwrap().kind = MyKind::Else;
                self.open(else_label);
                self.apply_liveness();
            }
            Operator::End => {
                let f = self.frames.pop().unwrap();
                if live {
                    self.set_term(Term::Goto(f.end_label));
                }
                self.validate(ops, pos)?;
                if self.frames.is_empty() {
                    // Function end: the end label returns the results.
                    let n = f.results.len() as u32;
                    let vals = f
                        .results
                        .iter()
                        .enumerate()
                        .map(|(i, ty)| Slot { depth: f.base + i as u32, key: *ty })
                        .collect();
                    debug_assert_eq!(f.base, 0);
                    let _ = n;
                    self.open(f.end_label);
                    self.set_term(Term::Return { vals });
                } else {
                    self.open(f.end_label);
                    self.apply_liveness();
                }
            }
            Operator::Br { relative_depth } => {
                if live {
                    let h = self.height();
                    let label = self.branch_label(relative_depth, h);
                    self.set_term(Term::Goto(label));
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::BrIf { relative_depth } => {
                if live {
                    let h = self.height();
                    let cond = Slot { depth: h - 1, key: SlotKey::I32 };
                    // Branch args sit under the condition.
                    let label = self.branch_label(relative_depth, h - 1);
                    let fall = self.reserve();
                    self.set_term(Term::CondGoto { cond, t: label, f: fall });
                    self.open(fall);
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::BrTable { ref targets } => {
                if live {
                    let h = self.height();
                    let index = Slot { depth: h - 1, key: SlotKey::I32 };
                    let mut labels = Vec::new();
                    for t in targets.targets() {
                        labels.push(self.branch_label(t?, h - 1));
                    }
                    let default = self.branch_label(targets.default(), h - 1);
                    self.set_term(Term::TableGoto { index, targets: labels, default });
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::Return => {
                if live {
                    let n = self.results.len();
                    let vals = self.top_slots(n)?;
                    self.set_term(Term::Return { vals });
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::Unreachable => {
                if live {
                    self.set_term(Term::Trap);
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::Call { function_index }
            | Operator::ReturnCall { function_index } => {
                let tail = matches!(op, Operator::ReturnCall { .. });
                if live {
                    let sig = self.pm.func_sig(function_index);
                    let n = sig.params.len();
                    let ins = self.top_slots(n)?;
                    let h = self.height();
                    let outs: Vec<Slot> = sig
                        .results
                        .iter()
                        .enumerate()
                        .map(|(i, t)| Slot { depth: h - n as u32 + i as u32, key: SlotKey::of(*t) })
                        .collect();
                    self.lower_call(
                        Operator::Call { function_index },
                        function_index,
                        false,
                        ins,
                        outs,
                        tail,
                    );
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            Operator::CallIndirect { type_index, table_index }
            | Operator::ReturnCallIndirect { type_index, table_index } => {
                let tail = matches!(op, Operator::ReturnCallIndirect { .. });
                if live {
                    let sig = &self.pm.types[type_index as usize];
                    let n = sig.params.len();
                    // params then the table index on top
                    let ins = self.top_slots(n + 1)?;
                    debug_assert_eq!(ins.last().unwrap().key, SlotKey::I32);
                    let h = self.height();
                    let outs: Vec<Slot> = sig
                        .results
                        .iter()
                        .enumerate()
                        .map(|(i, t)| Slot {
                            depth: h - (n as u32 + 1) + i as u32,
                            key: SlotKey::of(*t),
                        })
                        .collect();
                    self.lower_call(
                        Operator::CallIndirect { type_index, table_index },
                        u32::MAX,
                        true,
                        ins,
                        outs,
                        tail,
                    );
                }
                self.validate(ops, pos)?;
                self.apply_liveness();
            }
            // ---- reference/table/segment ops with shadow or gating semantics ----
            Operator::RefNull { .. } => {
                if live {
                    self.validate(ops, pos)?;
                    let h = self.height();
                    let out = Slot { depth: h - 1, key: SlotKey::FuncRef };
                    self.push_ins(Ins::Op { op, ins: vec![], outs: vec![out] });
                    self.push_ins(Ins::ShadowConst { slot: out, val: -1 });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::RefFunc { function_index } => {
                if live {
                    self.validate(ops, pos)?;
                    let h = self.height();
                    let out = Slot { depth: h - 1, key: SlotKey::FuncRef };
                    let new_idx = self.plan.map_func(function_index) as i32;
                    self.push_ins(Ins::Op { op, ins: vec![], outs: vec![out] });
                    self.push_ins(Ins::ShadowConst { slot: out, val: new_idx });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableGet { table } => {
                if live {
                    let ins = self.top_slots(1)?;
                    let idx = ins[0];
                    self.validate(ops, pos)?;
                    let out = Slot { depth: idx.depth, key: SlotKey::FuncRef };
                    self.push_ins(Ins::Op { op, ins: vec![idx], outs: vec![out] });
                    self.push_ins(Ins::ShadowTableGet { table, idx, out });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableSet { table } => {
                if live {
                    let ins = self.top_slots(2)?;
                    let (idx, val) = (ins[0], ins[1]);
                    self.validate(ops, pos)?;
                    self.push_ins(Ins::Op { op, ins: vec![idx, val], outs: vec![] });
                    self.push_ins(Ins::ShadowTableSet { table, idx, val });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableGrow { table } => {
                if live {
                    let ins = self.top_slots(2)?;
                    let (val, n) = (ins[0], ins[1]);
                    self.validate(ops, pos)?;
                    let h = self.height();
                    let out = Slot { depth: h - 1, key: SlotKey::I32 };
                    let helper = self.plan.tgrow[&table];
                    self.push_ins(Ins::HelperCall {
                        helper,
                        args: vec![HelperArg::Ref(val), HelperArg::Shadow(val), HelperArg::Val(n)],
                        out: Some(out),
                    });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableFill { table } => {
                if live {
                    let ins = self.top_slots(3)?;
                    let (i, val, n) = (ins[0], ins[1], ins[2]);
                    self.validate(ops, pos)?;
                    let helper = self.plan.tfill[&table];
                    self.push_ins(Ins::HelperCall {
                        helper,
                        args: vec![
                            HelperArg::Val(i),
                            HelperArg::Ref(val),
                            HelperArg::Shadow(val),
                            HelperArg::Val(n),
                        ],
                        out: None,
                    });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableCopy { dst_table, src_table } => {
                if live {
                    let ins = self.top_slots(3)?;
                    self.validate(ops, pos)?;
                    let helper = self.plan.tcopy[&(dst_table, src_table)];
                    self.push_ins(Ins::HelperCall {
                        helper,
                        args: ins.into_iter().map(HelperArg::Val).collect(),
                        out: None,
                    });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::TableInit { elem_index, table } => {
                if live {
                    let ins = self.top_slots(3)?;
                    self.validate(ops, pos)?;
                    let helper = self.plan.tinit[&(table, elem_index)];
                    self.push_ins(Ins::HelperCall {
                        helper,
                        args: ins.into_iter().map(HelperArg::Val).collect(),
                        out: None,
                    });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::ElemDrop { elem_index } => {
                if live {
                    self.validate(ops, pos)?;
                    let flag_off = self.plan.elem_flag_off[&elem_index];
                    self.push_ins(Ins::SegDropFlag { flag_off });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::DataDrop { data_index } => {
                if live {
                    self.validate(ops, pos)?;
                    let flag_off = self.plan.data_flag_off[&data_index];
                    self.push_ins(Ins::SegDropFlag { flag_off });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::MemoryInit { data_index, mem } => {
                if live {
                    let ins = self.top_slots(3)?;
                    let (dst, src, len) = (ins[0], ins[1], ins[2]);
                    self.validate(ops, pos)?;
                    let flag_off = self.plan.data_flag_off[&data_index];
                    self.push_ins(Ins::GatedMemInit {
                        data: data_index,
                        flag_off,
                        dst,
                        src,
                        len,
                        mem,
                    });
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            Operator::LocalGet { local_index } => {
                self.generic(ops, pos, op, live)?;
                if live && self.locals.orig_types[local_index as usize] == SlotKey::FuncRef {
                    let h = self.height();
                    let out = Slot { depth: h - 1, key: SlotKey::FuncRef };
                    let sh = self.locals.orig_shadow_local(local_index);
                    self.push_ins(Ins::ShadowFromLocal { orig_local: sh, slot: out });
                }
                self.apply_liveness();
                return Ok(());
            }
            Operator::LocalSet { local_index } | Operator::LocalTee { local_index } => {
                let is_ref = self.locals.orig_types[local_index as usize] == SlotKey::FuncRef;
                let (src, sh) = if live && is_ref {
                    let s = self.top_slots(1)?[0];
                    (Some(s), Some(self.locals.orig_shadow_local(local_index)))
                } else {
                    (None, None)
                };
                self.generic(ops, pos, op, live)?;
                if let (Some(s), Some(sh)) = (src, sh) {
                    self.push_ins(Ins::ShadowToLocal { slot: s, orig_local: sh });
                }
                self.apply_liveness();
                return Ok(());
            }
            Operator::GlobalGet { global_index } => {
                self.generic(ops, pos, op, live)?;
                if live {
                    if let Some(&shg) = self.plan.shadow_globals.get(&global_index) {
                        let h = self.height();
                        let out = Slot { depth: h - 1, key: SlotKey::FuncRef };
                        self.push_ins(Ins::ShadowFromGlobal { shadow_global: shg, slot: out });
                    }
                }
                self.apply_liveness();
                return Ok(());
            }
            Operator::GlobalSet { global_index } => {
                let pre = if live {
                    self.plan
                        .shadow_globals
                        .get(&global_index)
                        .copied()
                        .map(|shg| (self.top_slots(1).unwrap()[0], shg))
                } else {
                    None
                };
                self.generic(ops, pos, op, live)?;
                if let Some((s, shg)) = pre {
                    self.push_ins(Ins::ShadowToGlobal { slot: s, shadow_global: shg });
                }
                self.apply_liveness();
                return Ok(());
            }
            Operator::Select | Operator::TypedSelect { .. } => {
                if live {
                    let ins = self.top_slots(3)?;
                    let (a, b, cond) = (ins[0], ins[1], ins[2]);
                    self.validate(ops, pos)?;
                    let out = Slot { depth: a.depth, key: a.key };
                    self.push_ins(Ins::Op { op, ins: vec![a, b, cond], outs: vec![out] });
                    if a.key == SlotKey::FuncRef {
                        self.push_ins(Ins::ShadowSelect { cond, on_true: a, on_false: b, out });
                    }
                } else {
                    self.validate(ops, pos)?;
                }
                self.apply_liveness();
            }
            // ---- everything else: generic arity-driven registerization ----
            _ => {
                self.generic(ops, pos, op, live)?;
                self.apply_liveness();
            }
        }
        Ok(())
    }

    /// Generic path: (pops, pushes) from operator arity, types from the
    /// validator's operand stack.
    fn generic(
        &mut self,
        ops: &mut wasmparser::OperatorsReader<'a>,
        pos: usize,
        op: Operator<'a>,
        live: bool,
    ) -> Result<()> {
        if !live {
            return self.validate(ops, pos);
        }
        let (pops, pushes) = {
            let v = self.fv.visitor(pos);
            op.operator_arity(&v)
                .ok_or_else(|| anyhow!("could not compute arity for {op:?}"))?
        };
        let ins = self.top_slots(pops as usize)?;
        let base = self.height() - pops;
        self.validate(ops, pos)?;
        let mut outs = Vec::with_capacity(pushes as usize);
        for i in 0..pushes {
            let key = self.operand_key((pushes - 1 - i) as usize)?;
            outs.push(Slot { depth: base + i, key });
        }
        self.push_ins(Ins::Op { op, ins, outs });
        Ok(())
    }

    /// Lower a (possibly tail) call. Calls that can transitively unwind get
    /// their own flat block (a spill site whose pc re-executes the call).
    fn lower_call(
        &mut self,
        op: Operator<'a>,
        callee: u32,
        indirect: bool,
        ins: Vec<Slot>,
        outs: Vec<Slot>,
        tail: bool,
    ) {
        let can_unwind = if indirect {
            true
        } else {
            let n_imp = self.pm.num_imported_funcs();
            callee >= n_imp && self.plan.instrumented[(callee - n_imp) as usize]
        };
        if can_unwind && self.instrumented {
            let site_block = self.split();
            self.blocks[site_block].site = Some(Site::Call { op, ins, outs: outs.clone() });
        } else {
            self.push_ins(Ins::Op { op, ins, outs: outs.clone() });
        }
        if tail {
            // `return_call` is lowered to call+return: identical semantics,
            // trading tail-call stack behavior for checkpointability.
            self.set_term(Term::Return { vals: outs });
        }
    }
}
