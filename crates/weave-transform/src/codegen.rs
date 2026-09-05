//! Emission of a flattened function into the `loop`+`br_table` dispatch
//! structure, including the rewind prologue and the spill (unwind) sequences.

use crate::emit::Plan;
use crate::flatten::{Flattened, HelperArg, Ins, Site, SlotKey, Term};
use anyhow::Result;
use std::borrow::Cow;
use wasm_encoder::{
    AbstractHeapType, BlockType, Function, HeapType, Instruction as I, MemArg, RefType, ValType,
};
use weave_core::names;

pub fn funcref_null() -> I<'static> {
    I::RefNull(HeapType::Abstract {
        shared: false,
        ty: AbstractHeapType::Func,
    })
}

fn memarg(offset: u32, align: u32) -> MemArg {
    MemArg {
        offset: offset as u64,
        align,
        memory_index: 0,
    }
}

/// One spilled local: `local` is stored/loaded at `off` with width `key`
/// (funcref locals are never spilled directly — their i32 shadows are plain
/// locals and spill on their own; `rebuilds` reconstructs the refs).
struct SpillEntry {
    local: u32,
    key: SlotKey,
    off: u32,
}

pub struct FrameLayout {
    entries: Vec<SpillEntry>,
    /// (funcref local, its i32 shadow local): rebuilt from shadows on rewind.
    rebuilds: Vec<(u32, u32)>,
    pub size: u32,
}

impl FrameLayout {
    pub fn build(fl: &Flattened<'_>) -> FrameLayout {
        let mut entries = Vec::new();
        let mut rebuilds = Vec::new();
        // Header: [func_id: u32][pc: u32]
        let mut off = 8u32;
        let all: Vec<(u32, SlotKey)> = fl
            .locals
            .orig_types
            .iter()
            .copied()
            .chain(fl.locals.extra.iter().copied())
            .enumerate()
            .map(|(i, k)| (i as u32, k))
            .collect();
        for (idx, key) in all {
            if idx == fl.locals.pc {
                continue; // pc lives in the frame header
            }
            if key == SlotKey::FuncRef {
                // Rebuilt from its shadow (which is itself an i32 local in
                // this list and spills normally). Shadowless funcref locals
                // can only ever hold null — the fresh local default.
                if let Some(&sh) = fl
                    .locals
                    .orig_shadow
                    .get(&idx)
                    .or_else(|| fl.locals.slot_shadow.get(&idx))
                {
                    rebuilds.push((idx, sh));
                }
                continue;
            }
            let sz = key.byte_size();
            off = (off + sz - 1) & !(sz - 1);
            entries.push(SpillEntry {
                local: idx,
                key,
                off,
            });
            off += sz;
        }
        let size = (off + 15) & !15;
        FrameLayout {
            entries,
            rebuilds,
            size,
        }
    }
}

fn store_ins(key: SlotKey, off: u32) -> I<'static> {
    match key {
        SlotKey::I32 => I::I32Store(memarg(off, 2)),
        SlotKey::I64 => I::I64Store(memarg(off, 3)),
        SlotKey::F32 => I::F32Store(memarg(off, 2)),
        SlotKey::F64 => I::F64Store(memarg(off, 3)),
        SlotKey::V128 => I::V128Store(memarg(off, 4)),
        SlotKey::FuncRef => unreachable!("funcrefs are never spilled directly"),
    }
}

fn load_ins(key: SlotKey, off: u32) -> I<'static> {
    match key {
        SlotKey::I32 => I::I32Load(memarg(off, 2)),
        SlotKey::I64 => I::I64Load(memarg(off, 3)),
        SlotKey::F32 => I::F32Load(memarg(off, 2)),
        SlotKey::F64 => I::F64Load(memarg(off, 3)),
        SlotKey::V128 => I::V128Load(memarg(off, 4)),
        SlotKey::FuncRef => unreachable!(),
    }
}

pub fn zero_of(key: SlotKey) -> I<'static> {
    match key {
        SlotKey::I32 => I::I32Const(0),
        SlotKey::I64 => I::I64Const(0),
        SlotKey::F32 => I::F32Const(0.0),
        SlotKey::F64 => I::F64Const(0.0),
        SlotKey::V128 => I::V128Const(0),
        SlotKey::FuncRef => funcref_null(),
    }
}

/// Force allocation of every slot local (and funcref shadow) mentioned
/// anywhere in the IR, so the spill/restore frame layout is complete before
/// any code is emitted.
fn preallocate_slots(fl: &mut Flattened<'_>) {
    let mut slots: Vec<crate::flatten::Slot> = Vec::new();
    for b in &fl.blocks {
        if let Some(site) = &b.site {
            match site {
                Site::Poll => {}
                Site::Call { ins, outs, .. } => {
                    slots.extend(ins.iter().copied());
                    slots.extend(outs.iter().copied());
                }
            }
        }
        for ins in &b.insts {
            match ins {
                Ins::Op { ins, outs, .. } => {
                    slots.extend(ins.iter().copied());
                    slots.extend(outs.iter().copied());
                }
                Ins::Copy { from, to } => slots.extend([*from, *to]),
                Ins::ShadowConst { slot, .. }
                | Ins::ShadowFromLocal { slot, .. }
                | Ins::ShadowToLocal { slot, .. }
                | Ins::ShadowFromGlobal { slot, .. }
                | Ins::ShadowToGlobal { slot, .. } => slots.push(*slot),
                Ins::ShadowSelect {
                    cond,
                    on_true,
                    on_false,
                    out,
                } => slots.extend([*cond, *on_true, *on_false, *out]),
                Ins::ShadowTableGet { idx, out, .. } => slots.extend([*idx, *out]),
                Ins::ShadowTableSet { idx, val, .. } => slots.extend([*idx, *val]),
                Ins::SegDropFlag { .. } => {}
                Ins::GatedMemInit { dst, src, len, .. } => slots.extend([*dst, *src, *len]),
                Ins::HelperCall { args, out, .. } => {
                    for a in args {
                        match a {
                            HelperArg::Ref(s) | HelperArg::Shadow(s) | HelperArg::Val(s) => {
                                slots.push(*s)
                            }
                        }
                    }
                    if let Some(o) = out {
                        slots.push(*o);
                    }
                }
            }
        }
        match &b.term {
            Term::Goto(_) | Term::Trap => {}
            Term::CondGoto { cond, .. } => slots.push(*cond),
            Term::TableGoto { index, .. } => slots.push(*index),
            Term::Return { vals } => slots.extend(vals.iter().copied()),
        }
    }
    for s in slots {
        // slot_local also allocates the i32 shadow for funcref slots
        fl.locals.slot_local(s);
    }
}

pub struct Codegen<'p> {
    pub plan: &'p Plan,
    pub func_id: u32,
    pub results: Vec<SlotKey>,
}

impl Codegen<'_> {
    /// Emit a complete function body for `fl`.
    pub fn emit(&self, fl: &mut Flattened<'_>, remap: &mut crate::emit::Remap) -> Result<Function> {
        // All slot locals must exist before the frame layout is computed, so
        // that the layout used by the rewind prologue is identical to the one
        // used by every spill site.
        preallocate_slots(fl);
        let pc = {
            let idx = fl.locals.n_orig + fl.locals.extra.len() as u32;
            fl.locals.extra.push(SlotKey::I32);
            fl.locals.pc = idx;
            idx
        };
        let layout = FrameLayout::build(fl);
        let n = fl.blocks.len();

        let n_params = fl.params.len();
        let mut locals: Vec<(u32, ValType)> = Vec::new();
        for k in fl.locals.orig_types.iter().skip(n_params) {
            locals.push((1, k.encoder_ty()));
        }
        for k in fl.locals.extra.iter() {
            locals.push((1, k.encoder_ty()));
        }
        let mut f = Function::new(locals);

        // ---- rewind prologue ----
        if fl.instrumented {
            f.instruction(&I::GlobalGet(self.plan.g_state));
            f.instruction(&I::I32Const(names::STATE_REWIND));
            f.instruction(&I::I32Eq);
            f.instruction(&I::If(BlockType::Empty));
            {
                // pop our frame
                f.instruction(&I::GlobalGet(self.plan.g_sp));
                f.instruction(&I::I32Const(layout.size as i32));
                f.instruction(&I::I32Sub);
                f.instruction(&I::GlobalSet(self.plan.g_sp));
                // frame id sanity check
                f.instruction(&I::GlobalGet(self.plan.g_sp));
                f.instruction(&I::I32Load(memarg(0, 2)));
                f.instruction(&I::I32Const(self.func_id as i32));
                f.instruction(&I::I32Ne);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::Unreachable);
                f.instruction(&I::End);
                // pc
                f.instruction(&I::GlobalGet(self.plan.g_sp));
                f.instruction(&I::I32Load(memarg(4, 2)));
                f.instruction(&I::LocalSet(pc));
                // locals
                for e in &layout.entries {
                    f.instruction(&I::GlobalGet(self.plan.g_sp));
                    f.instruction(&load_ins(e.key, e.off));
                    f.instruction(&I::LocalSet(e.local));
                }
                // rebuild funcrefs from shadows via the canonical table
                for (ref_l, sh_l) in &layout.rebuilds {
                    f.instruction(&I::LocalGet(*sh_l));
                    f.instruction(&I::I32Const(-1));
                    f.instruction(&I::I32Eq);
                    f.instruction(&I::If(BlockType::Result(ValType::Ref(RefType::FUNCREF))));
                    f.instruction(&funcref_null());
                    f.instruction(&I::Else);
                    f.instruction(&I::LocalGet(*sh_l));
                    f.instruction(&I::TableGet(self.plan.canon_table));
                    f.instruction(&I::End);
                    f.instruction(&I::LocalSet(*ref_l));
                }
                // innermost frame flips back to RUN
                f.instruction(&I::GlobalGet(self.plan.g_sp));
                f.instruction(&I::GlobalGet(self.plan.g_stack_base));
                f.instruction(&I::I32Eq);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::I32Const(names::STATE_RUN));
                f.instruction(&I::GlobalSet(self.plan.g_state));
                f.instruction(&I::End);
            }
            f.instruction(&I::End);
        }

        // ---- dispatch structure ----
        // block $bad { loop $disp { block xN-1 { .. block x0 {
        //   br_table pc [x0..xN-1] default $bad } } .. } } unreachable
        f.instruction(&I::Block(BlockType::Empty)); // $bad
        f.instruction(&I::Loop(BlockType::Empty)); // $disp
        for _ in 0..n {
            f.instruction(&I::Block(BlockType::Empty));
        }
        f.instruction(&I::LocalGet(pc));
        let targets: Vec<u32> = (0..n as u32).collect();
        f.instruction(&I::BrTable(Cow::from(targets), n as u32 + 1));

        for k in 0..n {
            f.instruction(&I::End); // close wrapper x_k: block k's code follows
            self.emit_block(&mut f, fl, &layout, remap, k, pc)?;
        }
        f.instruction(&I::End); // loop
        f.instruction(&I::End); // $bad
        f.instruction(&I::Unreachable);
        f.instruction(&I::End); // function
        Ok(f)
    }

    /// Relative depth of the dispatch loop from the top level of block `k`
    /// (with `extra` additional nesting).
    fn disp(&self, k: usize, n: usize, extra: u32) -> u32 {
        (n - 1 - k) as u32 + extra
    }

    fn emit_goto(&self, f: &mut Function, pc: u32, target: usize, rel: u32) {
        f.instruction(&I::I32Const(target as i32));
        f.instruction(&I::LocalSet(pc));
        f.instruction(&I::Br(rel));
    }

    fn emit_block(
        &self,
        f: &mut Function,
        fl: &mut Flattened<'_>,
        layout: &FrameLayout,
        remap: &mut crate::emit::Remap,
        k: usize,
        pc: u32,
    ) -> Result<()> {
        let n = fl.blocks.len();
        // Sites first (the block's pc re-enters exactly here on rewind).
        match &fl.blocks[k].site {
            Some(Site::Poll) => {
                let resume = match fl.blocks[k].term {
                    Term::Goto(t) => t,
                    _ => unreachable!("poll blocks always fall through"),
                };
                // countdown gate
                f.instruction(&I::GlobalGet(self.plan.g_ctr));
                f.instruction(&I::I32Const(1));
                f.instruction(&I::I32Sub);
                f.instruction(&I::GlobalSet(self.plan.g_ctr));
                f.instruction(&I::GlobalGet(self.plan.g_ctr));
                f.instruction(&I::I32Const(0));
                f.instruction(&I::I32LeS);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::I32Const(self.plan.poll_period as i32));
                f.instruction(&I::GlobalSet(self.plan.g_ctr));
                f.instruction(&I::Call(self.plan.poll_func));
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::I32Const(names::STATE_UNWIND));
                f.instruction(&I::GlobalSet(self.plan.g_state));
                self.emit_spill(f, layout, resume as u32);
                f.instruction(&I::End);
                f.instruction(&I::End);
            }
            Some(Site::Call { op, ins, outs }) => {
                let (ins_c, outs_c) = (ins.clone(), outs.clone());
                for s in &ins_c {
                    f.instruction(&I::LocalGet(fl.locals.slot_local(*s)));
                }
                let inst = wasm_encoder::reencode::utils::instruction(remap, op.clone())
                    .map_err(|e| anyhow::anyhow!("reencode call: {e:?}"))?;
                f.instruction(&inst);
                f.instruction(&I::GlobalGet(self.plan.g_state));
                f.instruction(&I::I32Const(names::STATE_UNWIND));
                f.instruction(&I::I32Eq);
                f.instruction(&I::If(BlockType::Empty));
                self.emit_spill(f, layout, k as u32);
                f.instruction(&I::End);
                for s in outs_c.iter().rev() {
                    f.instruction(&I::LocalSet(fl.locals.slot_local(*s)));
                }
            }
            None => {}
        }

        // Straight-line instructions.
        // (indices to satisfy the borrow checker: fl is mutated for slot allocs)
        for i in 0..fl.blocks[k].insts.len() {
            self.emit_ins(f, fl, remap, k, i)?;
        }

        // Terminator.
        match fl.blocks[k].term {
            Term::Goto(t) => {
                self.emit_goto(f, pc, t, self.disp(k, n, 0));
            }
            Term::CondGoto { cond, t, f: fals } => {
                let l = fl.locals.slot_local(cond);
                f.instruction(&I::LocalGet(l));
                f.instruction(&I::If(BlockType::Empty));
                self.emit_goto(f, pc, t, self.disp(k, n, 1));
                f.instruction(&I::Else);
                self.emit_goto(f, pc, fals, self.disp(k, n, 1));
                f.instruction(&I::End);
                f.instruction(&I::Unreachable);
            }
            Term::TableGoto {
                index,
                ref targets,
                default,
            } => {
                let targets = targets.clone();
                let m = targets.len() as u32;
                for _ in 0..=m {
                    f.instruction(&I::Block(BlockType::Empty));
                }
                let l = fl.locals.slot_local(index);
                f.instruction(&I::LocalGet(l));
                let rels: Vec<u32> = (0..m).collect();
                f.instruction(&I::BrTable(Cow::from(rels), m));
                for (i, t) in targets.iter().enumerate() {
                    f.instruction(&I::End);
                    self.emit_goto(f, pc, *t, self.disp(k, n, m - i as u32));
                }
                f.instruction(&I::End);
                self.emit_goto(f, pc, default, self.disp(k, n, 0));
            }
            Term::Return { ref vals } => {
                let vals = vals.clone();
                for v in &vals {
                    f.instruction(&I::LocalGet(fl.locals.slot_local(*v)));
                }
                f.instruction(&I::Return);
            }
            Term::Trap => {
                f.instruction(&I::Unreachable);
            }
        }
        Ok(())
    }

    fn emit_ins(
        &self,
        f: &mut Function,
        fl: &mut Flattened<'_>,
        remap: &mut crate::emit::Remap,
        k: usize,
        i: usize,
    ) -> Result<()> {
        // Pre-resolve locals (mutable borrows of fl.locals) per instruction.
        match &fl.blocks[k].insts[i] {
            Ins::Op { op, ins, outs } => {
                let op = op.clone();
                let (ins_c, outs_c) = (ins.clone(), outs.clone());
                let inputs: Vec<u32> = ins_c.iter().map(|s| fl.locals.slot_local(*s)).collect();
                crate::memory::emit_checks(f, self.plan, &op, &inputs);
                for &local in &inputs {
                    f.instruction(&I::LocalGet(local));
                }
                match op {
                    wasmparser::Operator::MemorySize { mem: 0 } => {
                        crate::memory::emit_size(f, self.plan, 0);
                    }
                    wasmparser::Operator::MemoryGrow { mem: 0 } => {
                        f.instruction(&I::Call(self.plan.memory_grow));
                    }
                    _ => {
                        let inst = wasm_encoder::reencode::utils::instruction(remap, op)
                            .map_err(|e| anyhow::anyhow!("reencode: {e:?}"))?;
                        f.instruction(&inst);
                    }
                }
                for s in outs_c.iter().rev() {
                    f.instruction(&I::LocalSet(fl.locals.slot_local(*s)));
                }
            }
            Ins::Copy { from, to } => {
                let (from, to) = (*from, *to);
                let lf = fl.locals.slot_local(from);
                let lt = fl.locals.slot_local(to);
                f.instruction(&I::LocalGet(lf));
                f.instruction(&I::LocalSet(lt));
                if from.key == SlotKey::FuncRef {
                    let sf = fl.locals.slot_shadow_local(from);
                    let st = fl.locals.slot_shadow_local(to);
                    f.instruction(&I::LocalGet(sf));
                    f.instruction(&I::LocalSet(st));
                }
            }
            Ins::ShadowConst { slot, val } => {
                let (slot, val) = (*slot, *val);
                let sh = fl.locals.slot_shadow_local(slot);
                f.instruction(&I::I32Const(val));
                f.instruction(&I::LocalSet(sh));
            }
            Ins::ShadowFromLocal { orig_local, slot } => {
                let (sh_local, slot) = (*orig_local, *slot);
                let sh = fl.locals.slot_shadow_local(slot);
                f.instruction(&I::LocalGet(sh_local));
                f.instruction(&I::LocalSet(sh));
            }
            Ins::ShadowToLocal { slot, orig_local } => {
                let (slot, sh_local) = (*slot, *orig_local);
                let sh = fl.locals.slot_shadow_local(slot);
                f.instruction(&I::LocalGet(sh));
                f.instruction(&I::LocalSet(sh_local));
            }
            Ins::ShadowFromGlobal {
                shadow_global,
                slot,
            } => {
                let (g, slot) = (*shadow_global, *slot);
                let sh = fl.locals.slot_shadow_local(slot);
                f.instruction(&I::GlobalGet(g));
                f.instruction(&I::LocalSet(sh));
            }
            Ins::ShadowToGlobal {
                slot,
                shadow_global,
            } => {
                let (slot, g) = (*slot, *shadow_global);
                let sh = fl.locals.slot_shadow_local(slot);
                f.instruction(&I::LocalGet(sh));
                f.instruction(&I::GlobalSet(g));
            }
            Ins::ShadowSelect {
                cond,
                on_true,
                on_false,
                out,
            } => {
                let (cond, a, b, out) = (*cond, *on_true, *on_false, *out);
                let (sa, sb) = (
                    fl.locals.slot_shadow_local(a),
                    fl.locals.slot_shadow_local(b),
                );
                let scond = fl.locals.slot_local(cond);
                let sout = fl.locals.slot_shadow_local(out);
                f.instruction(&I::LocalGet(sa));
                f.instruction(&I::LocalGet(sb));
                f.instruction(&I::LocalGet(scond));
                f.instruction(&I::Select);
                f.instruction(&I::LocalSet(sout));
            }
            Ins::ShadowTableGet { table, idx, out } => {
                let (table, idx, out) = (*table, *idx, *out);
                let li = fl.locals.slot_local(idx);
                let so = fl.locals.slot_shadow_local(out);
                f.instruction(&I::LocalGet(li));
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::GlobalGet(self.plan.g_tshadow[table as usize]));
                f.instruction(&I::I32Add);
                f.instruction(&I::I32Load(memarg(0, 2)));
                f.instruction(&I::LocalSet(so));
            }
            Ins::ShadowTableSet { table, idx, val } => {
                let (table, idx, val) = (*table, *idx, *val);
                let li = fl.locals.slot_local(idx);
                let sv = fl.locals.slot_shadow_local(val);
                f.instruction(&I::LocalGet(li));
                f.instruction(&I::I32Const(2));
                f.instruction(&I::I32Shl);
                f.instruction(&I::GlobalGet(self.plan.g_tshadow[table as usize]));
                f.instruction(&I::I32Add);
                f.instruction(&I::LocalGet(sv));
                f.instruction(&I::I32Store(memarg(0, 2)));
            }
            Ins::SegDropFlag { flag_off } => {
                let off = *flag_off;
                f.instruction(&I::GlobalGet(self.plan.g_rbase));
                f.instruction(&I::I32Const(1));
                f.instruction(&I::I32Store8(memarg(off, 0)));
            }
            Ins::GatedMemInit {
                data,
                flag_off,
                dst,
                src,
                len,
                mem,
            } => {
                let (data, off, dst, src, len, mem) = (*data, *flag_off, *dst, *src, *len, *mem);
                let (ld, ls, ll) = (
                    fl.locals.slot_local(dst),
                    fl.locals.slot_local(src),
                    fl.locals.slot_local(len),
                );
                if mem == 0 {
                    crate::memory::emit_range_check(f, self.plan, ld, ll);
                }
                f.instruction(&I::GlobalGet(self.plan.g_rbase));
                f.instruction(&I::I32Load8U(memarg(off, 0)));
                f.instruction(&I::If(BlockType::Empty));
                // dropped: trap unless src == 0 && len == 0 && dst <= mem size
                f.instruction(&I::LocalGet(ls));
                f.instruction(&I::LocalGet(ll));
                f.instruction(&I::I32Or);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::Unreachable);
                f.instruction(&I::End);
                f.instruction(&I::LocalGet(ld));
                f.instruction(&I::I64ExtendI32U);
                crate::memory::emit_size(f, self.plan, mem);
                f.instruction(&I::I64ExtendI32U);
                f.instruction(&I::I64Const(16));
                f.instruction(&I::I64Shl);
                f.instruction(&I::I64GtU);
                f.instruction(&I::If(BlockType::Empty));
                f.instruction(&I::Unreachable);
                f.instruction(&I::End);
                f.instruction(&I::Else);
                f.instruction(&I::LocalGet(ld));
                f.instruction(&I::LocalGet(ls));
                f.instruction(&I::LocalGet(ll));
                f.instruction(&I::MemoryInit {
                    mem,
                    data_index: data,
                });
                f.instruction(&I::End);
            }
            Ins::HelperCall { helper, args, out } => {
                let helper = *helper;
                let out = *out;
                let args: Vec<(u8, crate::flatten::Slot)> = args
                    .iter()
                    .map(|a| match a {
                        HelperArg::Ref(s) => (0u8, *s),
                        HelperArg::Shadow(s) => (1u8, *s),
                        HelperArg::Val(s) => (2u8, *s),
                    })
                    .collect();
                for (kind, s) in &args {
                    let l = match kind {
                        1 => fl.locals.slot_shadow_local(*s),
                        _ => fl.locals.slot_local(*s),
                    };
                    f.instruction(&I::LocalGet(l));
                }
                f.instruction(&I::Call(helper));
                if let Some(o) = out {
                    let lo = fl.locals.slot_local(o);
                    f.instruction(&I::LocalSet(lo));
                }
            }
        }
        Ok(())
    }

    /// Spill the frame and return dummies. Ends with `return`.
    fn emit_spill(&self, f: &mut Function, layout: &FrameLayout, resume_pc: u32) {
        // ensure the shadow stack exists
        f.instruction(&I::GlobalGet(self.plan.g_stack_base));
        f.instruction(&I::I32Eqz);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&I::Call(self.plan.stack_init));
        f.instruction(&I::End);
        // ensure capacity
        f.instruction(&I::GlobalGet(self.plan.g_sp));
        f.instruction(&I::I32Const(layout.size as i32));
        f.instruction(&I::I32Add);
        f.instruction(&I::GlobalGet(self.plan.g_stack_end));
        f.instruction(&I::I32GtU);
        f.instruction(&I::If(BlockType::Empty));
        f.instruction(&I::I32Const(layout.size as i32));
        f.instruction(&I::Call(self.plan.stack_grow));
        f.instruction(&I::End);
        // header
        f.instruction(&I::GlobalGet(self.plan.g_sp));
        f.instruction(&I::I32Const(self.func_id as i32));
        f.instruction(&I::I32Store(memarg(0, 2)));
        f.instruction(&I::GlobalGet(self.plan.g_sp));
        f.instruction(&I::I32Const(resume_pc as i32));
        f.instruction(&I::I32Store(memarg(4, 2)));
        // locals
        for e in &layout.entries {
            f.instruction(&I::GlobalGet(self.plan.g_sp));
            f.instruction(&I::LocalGet(e.local));
            f.instruction(&store_ins(e.key, e.off));
        }
        // bump
        f.instruction(&I::GlobalGet(self.plan.g_sp));
        f.instruction(&I::I32Const(layout.size as i32));
        f.instruction(&I::I32Add);
        f.instruction(&I::GlobalSet(self.plan.g_sp));
        // dummies + return
        for r in &self.results {
            f.instruction(&zero_of(*r));
        }
        f.instruction(&I::Return);
    }
}
