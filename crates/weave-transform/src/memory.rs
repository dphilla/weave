//! Keep memory 0's guest address space separate from Weave's private suffix.
//!
//! Guest bytes retain their original addresses (including pointers passed to
//! host imports). The private region header records the logical page count.
//! Guest growth moves the entire suffix, including any relocated table/stack
//! allocations, then clears the newly exposed guest pages. Generated runtime
//! instructions use physical memory directly; only original guest accesses
//! pass through the logical bounds checks below.

use crate::emit::Plan;
use wasm_encoder::{BlockType, Function, Instruction as I, MemArg, ValType};
use wasmparser::Operator;

fn header() -> MemArg {
    MemArg {
        offset: 0,
        align: 2,
        memory_index: 0,
    }
}

pub fn emit_size(f: &mut Function, plan: &Plan, memory: u32) {
    if memory == 0 {
        f.instruction(&I::GlobalGet(plan.g_rbase));
        f.instruction(&I::I32Load(header()));
    } else {
        f.instruction(&I::MemorySize(memory));
    }
}

/// Return the full effective access width, not the size of the SIMD result.
fn access(op: &Operator<'_>) -> Option<(wasmparser::MemArg, u64)> {
    use Operator::*;
    let (arg, width) = match op {
        I32Load { memarg }
        | F32Load { memarg }
        | I32Store { memarg }
        | F32Store { memarg }
        | I64Load32S { memarg }
        | I64Load32U { memarg }
        | I64Store32 { memarg }
        | V128Load32Splat { memarg }
        | V128Load32Zero { memarg }
        | V128Load32Lane { memarg, .. }
        | V128Store32Lane { memarg, .. } => (*memarg, 4),
        I64Load { memarg }
        | F64Load { memarg }
        | I64Store { memarg }
        | F64Store { memarg }
        | V128Load8x8S { memarg }
        | V128Load8x8U { memarg }
        | V128Load16x4S { memarg }
        | V128Load16x4U { memarg }
        | V128Load32x2S { memarg }
        | V128Load32x2U { memarg }
        | V128Load64Splat { memarg }
        | V128Load64Zero { memarg }
        | V128Load64Lane { memarg, .. }
        | V128Store64Lane { memarg, .. } => (*memarg, 8),
        I32Load8S { memarg }
        | I32Load8U { memarg }
        | I64Load8S { memarg }
        | I64Load8U { memarg }
        | I32Store8 { memarg }
        | I64Store8 { memarg }
        | V128Load8Splat { memarg }
        | V128Load8Lane { memarg, .. }
        | V128Store8Lane { memarg, .. } => (*memarg, 1),
        I32Load16S { memarg }
        | I32Load16U { memarg }
        | I64Load16S { memarg }
        | I64Load16U { memarg }
        | I32Store16 { memarg }
        | I64Store16 { memarg }
        | V128Load16Splat { memarg }
        | V128Load16Lane { memarg, .. }
        | V128Store16Lane { memarg, .. } => (*memarg, 2),
        V128Load { memarg } | V128Store { memarg } => (*memarg, 16),
        _ => return None,
    };
    (arg.memory == 0).then_some((arg, width))
}

pub fn needs_rewrite(op: &Operator<'_>) -> bool {
    access(op).is_some()
        || matches!(
            op,
            Operator::MemorySize { mem: 0 }
                | Operator::MemoryGrow { mem: 0 }
                | Operator::MemoryFill { mem: 0 }
                | Operator::MemoryCopy { dst_mem: 0, .. }
                | Operator::MemoryCopy { src_mem: 0, .. }
                | Operator::MemoryInit { mem: 0, .. }
        )
}

fn finish_bounds_check(f: &mut Function, plan: &Plan) {
    emit_size(f, plan, 0);
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::I64Const(16));
    f.instruction(&I::I64Shl);
    f.instruction(&I::I64GtU);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::Unreachable);
    f.instruction(&I::End);
}

/// Check [address, address+length), including zero-length endpoint semantics.
pub fn emit_range_check(f: &mut Function, plan: &Plan, address: u32, length: u32) {
    f.instruction(&I::LocalGet(address));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::LocalGet(length));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::I64Add);
    finish_bounds_check(f, plan);
}

pub fn emit_checks(f: &mut Function, plan: &Plan, op: &Operator<'_>, inputs: &[u32]) {
    if let Some((arg, width)) = access(op) {
        // Address + static offset + access width must not wrap at 32 bits.
        f.instruction(&I::LocalGet(inputs[0]));
        f.instruction(&I::I64ExtendI32U);
        f.instruction(&I::I64Const((arg.offset + width) as i64));
        f.instruction(&I::I64Add);
        finish_bounds_check(f, plan);
    }
    match op {
        Operator::MemoryFill { mem: 0 } => emit_range_check(f, plan, inputs[0], inputs[2]),
        Operator::MemoryCopy { dst_mem, src_mem } => {
            if *dst_mem == 0 {
                emit_range_check(f, plan, inputs[0], inputs[2]);
            }
            if *src_mem == 0 {
                emit_range_check(f, plan, inputs[1], inputs[2]);
            }
        }
        _ => {}
    }
}

pub fn gen_grow(plan: &Plan) -> Function {
    // param delta; locals logical pages, physical pages, old guest end, delta bytes
    let (delta, logical, physical, guest_end, bytes) = (0, 1, 2, 3, 4);
    let mut f = Function::new([(4, ValType::I32)]);
    emit_size(&mut f, plan, 0);
    f.instruction(&I::LocalSet(logical));
    f.instruction(&I::LocalGet(delta));
    f.instruction(&I::I32Eqz);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::LocalGet(logical));
    f.instruction(&I::Return);
    f.instruction(&I::End);

    f.instruction(&I::LocalGet(logical));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::LocalGet(delta));
    f.instruction(&I::I64ExtendI32U);
    f.instruction(&I::I64Add);
    f.instruction(&I::I64Const(plan.memory_max as i64));
    f.instruction(&I::I64GtU);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::Return);
    f.instruction(&I::End);

    // Failed physical growth leaves all guest and private state untouched.
    f.instruction(&I::LocalGet(delta));
    f.instruction(&I::MemoryGrow(0));
    f.instruction(&I::LocalTee(physical));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::I32Eq);
    f.instruction(&I::If(BlockType::Empty));
    f.instruction(&I::I32Const(-1));
    f.instruction(&I::Return);
    f.instruction(&I::End);
    for (pages, byte_local) in [(logical, guest_end), (delta, bytes)] {
        f.instruction(&I::LocalGet(pages));
        f.instruction(&I::I32Const(16));
        f.instruction(&I::I32Shl);
        f.instruction(&I::LocalSet(byte_local));
    }

    // memory.copy is overlap-safe when growth is smaller than the suffix.
    f.instruction(&I::LocalGet(guest_end));
    f.instruction(&I::LocalGet(bytes));
    f.instruction(&I::I32Add);
    f.instruction(&I::LocalGet(guest_end));
    f.instruction(&I::LocalGet(physical));
    f.instruction(&I::LocalGet(logical));
    f.instruction(&I::I32Sub);
    f.instruction(&I::I32Const(16));
    f.instruction(&I::I32Shl);
    f.instruction(&I::MemoryCopy {
        src_mem: 0,
        dst_mem: 0,
    });

    let relocate = |f: &mut Function, global| {
        f.instruction(&I::GlobalGet(global));
        f.instruction(&I::LocalGet(bytes));
        f.instruction(&I::I32Add);
        f.instruction(&I::GlobalSet(global));
    };
    relocate(&mut f, plan.g_rbase);
    for &global in &plan.g_tshadow {
        relocate(&mut f, global);
    }
    // A lazy, not-yet-allocated shadow stack uses zero pointers.
    f.instruction(&I::GlobalGet(plan.g_stack_base));
    f.instruction(&I::If(BlockType::Empty));
    for global in [plan.g_sp, plan.g_stack_base, plan.g_stack_end] {
        relocate(&mut f, global);
    }
    f.instruction(&I::End);
    f.instruction(&I::LocalGet(guest_end));
    f.instruction(&I::I32Const(0));
    f.instruction(&I::LocalGet(bytes));
    f.instruction(&I::MemoryFill(0));
    f.instruction(&I::GlobalGet(plan.g_rbase));
    f.instruction(&I::LocalGet(logical));
    f.instruction(&I::LocalGet(delta));
    f.instruction(&I::I32Add);
    f.instruction(&I::I32Store(header()));
    f.instruction(&I::LocalGet(logical));
    f.instruction(&I::End);
    f
}
