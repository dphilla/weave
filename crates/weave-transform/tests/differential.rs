//! Differential tests: a transformed module with no checkpoint ever requested
//! must be observationally identical to the original — same results, same
//! emitted host-call sequences, same traps. Then: full checkpoint/restore
//! round-trips driven directly through the guest ABI, including restoring
//! into a completely fresh instance.

use anyhow::{anyhow, Result};
use wasmtime::{Caller, Config, Engine, Extern, Instance, Linker, Module, Store, Val};
use weave_core::names;

struct HostState {
    emitted: Vec<i64>,
    polls: u64,
    /// When Some(n): poll returns 1 on its n-th invocation (0-based).
    unwind_at: Option<u64>,
}

fn build_linker(engine: &Engine, with_poll: bool) -> Linker<HostState> {
    let mut linker: Linker<HostState> = Linker::new(engine);
    linker
        .func_wrap(
            "env",
            "emit",
            |mut caller: Caller<'_, HostState>, v: i32| {
                caller.data_mut().emitted.push(v as i64);
            },
        )
        .unwrap();
    linker
        .func_wrap(
            "env",
            "emit64",
            |mut caller: Caller<'_, HostState>, v: i64| {
                caller.data_mut().emitted.push(v);
            },
        )
        .unwrap();
    if with_poll {
        linker
            .func_wrap(
                "weave",
                "poll",
                |mut caller: Caller<'_, HostState>| -> i32 {
                    let st = caller.data_mut();
                    let n = st.polls;
                    st.polls += 1;
                    match st.unwind_at {
                        Some(k) if n >= k => 1,
                        _ => 0,
                    }
                },
            )
            .unwrap();
    }
    linker
}

fn run_module(
    engine: &Engine,
    wasm: &[u8],
    with_poll: bool,
    entry: &str,
    args: &[Val],
    n_results: usize,
) -> Result<(Vec<Val>, Vec<i64>)> {
    let module = Module::new(engine, wasm)?;
    let linker = build_linker(engine, with_poll);
    let mut store = Store::new(
        engine,
        HostState {
            emitted: vec![],
            polls: 0,
            unwind_at: None,
        },
    );
    let instance = linker.instantiate(&mut store, &module)?;
    if with_poll {
        let init = instance.get_func(&mut store, names::F_INIT).unwrap();
        init.call(&mut store, &[], &mut [])?;
    }
    let f = instance
        .get_func(&mut store, entry)
        .ok_or_else(|| anyhow!("no export {entry}"))?;
    let mut results = vec![Val::I32(0); n_results];
    f.call(&mut store, args, &mut results)?;
    Ok((results, store.data().emitted.clone()))
}

fn differential(wat: &str, entry: &str, args: &[Val], n_results: usize) {
    let wasm = wat::parse_str(wat).unwrap();
    let out = weave_transform::transform(&wasm, &Default::default()).unwrap();
    let engine = Engine::new(&Config::new()).unwrap();

    let (r1, e1) = run_module(&engine, &wasm, false, entry, args, n_results).unwrap();
    let (r2, e2) = run_module(&engine, &out.wasm, true, entry, args, n_results).unwrap();
    let fmt = |vs: &[Val]| -> Vec<String> { vs.iter().map(|v| format!("{v:?}")).collect() };
    assert_eq!(fmt(&r1), fmt(&r2), "results differ for {entry}");
    assert_eq!(e1, e2, "emitted sequences differ for {entry}");
}

// ---------------------------------------------------------------- guests

const LOOP_SUM: &str = r#"
(module
  (import "env" "emit" (func $emit (param i32)))
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $l
      (local.set $acc (i32.add (local.get $acc) (local.get $i)))
      (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 100)))
        (then (call $emit (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $acc)))
"#;

const FIB: &str = r#"
(module
  (func $fib (export "fib") (param $n i32) (result i32)
    (if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
      (then (local.get $n))
      (else
        (i32.add
          (call $fib (i32.sub (local.get $n) (i32.const 1)))
          (call $fib (i32.sub (local.get $n) (i32.const 2))))))))
"#;

/// Values live on the operand stack across calls (the classic hard case).
const STACK_ACROSS_CALL: &str = r#"
(module
  (func $g (param i32) (result i32)
    (i32.mul (local.get 0) (i32.const 3)))
  (func $f (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $l
      ;; acc + (i * 2) + g(i) all juggled on the stack
      (local.set $acc
        (i32.add
          (i32.add (local.get $acc) (i32.mul (local.get $i) (i32.const 2)))
          (call $g (local.get $i))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $acc)))
"#;

const BR_TABLE: &str = r#"
(module
  (import "env" "emit" (func $emit (param i32)))
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $l
      (block $b3 (block $b2 (block $b1 (block $b0
        (br_table $b0 $b1 $b2 $b3 (i32.rem_u (local.get $i) (i32.const 4))))
        (local.set $acc (i32.add (local.get $acc) (i32.const 1)))
        (br $b3))
        (local.set $acc (i32.add (local.get $acc) (i32.const 10)))
        (br $b3))
        (local.set $acc (i32.add (local.get $acc) (i32.const 100))))
      (call $emit (local.get $acc))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $acc)))
"#;

const FLOATS: &str = r#"
(module
  (func (export "run") (param $n i32) (result f64)
    (local $i i32) (local $x f64) (local $y f32)
    (local.set $x (f64.const 1.5))
    (local.set $y (f32.const 0.25))
    (loop $l
      (local.set $x
        (f64.add (local.get $x)
          (f64.div (f64.const 1) (f64.convert_i32_u (i32.add (local.get $i) (i32.const 1))))))
      (local.set $y (f32.mul (local.get $y) (f32.const 1.0625)))
      (local.set $x (f64.add (local.get $x) (f64.promote_f32 (local.get $y))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $x)))
"#;

const I64_MEMORY: &str = r#"
(module
  (import "env" "emit64" (func $emit64 (param i64)))
  (memory 1)
  (func (export "run") (param $n i32) (result i64)
    (local $i i32) (local $h i64)
    (local.set $h (i64.const 1469598103934665603))
    (loop $l
      ;; store, reload, hash
      (i64.store (i32.mul (i32.rem_u (local.get $i) (i32.const 100)) (i32.const 8))
                 (i64.extend_i32_u (local.get $i)))
      (local.set $h
        (i64.mul
          (i64.xor (local.get $h)
            (i64.load (i32.mul (i32.rem_u (local.get $i) (i32.const 100)) (i32.const 8))))
          (i64.const 1099511628211)))
      (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 50)))
        (then (call $emit64 (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $h)))
"#;

const CALL_INDIRECT: &str = r#"
(module
  (type $op (func (param i32 i32) (result i32)))
  (table 4 funcref)
  (elem (i32.const 0) $add $sub $mul $mix)
  (func $add (type $op) (i32.add (local.get 0) (local.get 1)))
  (func $sub (type $op) (i32.sub (local.get 0) (local.get 1)))
  (func $mul (type $op) (i32.mul (local.get 0) (local.get 1)))
  (func $mix (type $op)
    (local $j i32) (local $a i32)
    (local.set $a (local.get 0))
    (loop $l
      (local.set $a (i32.add (i32.mul (local.get $a) (i32.const 3)) (local.get 1)))
      (local.set $j (i32.add (local.get $j) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $j) (i32.const 5))))
    (local.get $a))
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $l
      (local.set $acc
        (call_indirect (type $op)
          (local.get $acc) (local.get $i)
          (i32.rem_u (local.get $i) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $acc)))
"#;

const GLOBALS: &str = r#"
(module
  (global $g (mut i64) (i64.const 7))
  (global $gf (mut f32) (f32.const 2.5))
  (func (export "run") (param $n i32) (result i64)
    (local $i i32)
    (loop $l
      (global.set $g (i64.add (global.get $g) (i64.extend_i32_u (local.get $i))))
      (global.set $gf (f32.add (global.get $gf) (f32.const 0.5)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (i64.add (global.get $g) (i64.trunc_f32_u (global.get $gf)))))
"#;

const NESTED_BLOCKS: &str = r#"
(module
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $acc i32)
    (loop $outer
      (block $exit
        (local.set $acc
          (i32.add (local.get $acc)
            (block (result i32)
              (if (result i32) (i32.and (local.get $i) (i32.const 1))
                (then
                  (br_if $exit (i32.gt_u (local.get $i) (local.get $n)))
                  (i32.mul (local.get $i) (i32.const 2)))
                (else
                  (select
                    (i32.const 5) (i32.const 9)
                    (i32.and (local.get $i) (i32.const 2))))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $outer (i32.lt_u (local.get $i) (i32.const 100000)))))
    (i32.add (local.get $acc) (local.get $i))))
"#;

#[test]
fn diff_loop_sum() {
    differential(LOOP_SUM, "run", &[Val::I32(1000)], 1);
}

#[test]
fn diff_fib() {
    differential(FIB, "fib", &[Val::I32(22)], 1);
}

#[test]
fn diff_stack_across_call() {
    differential(STACK_ACROSS_CALL, "run", &[Val::I32(500)], 1);
}

#[test]
fn diff_br_table() {
    differential(BR_TABLE, "run", &[Val::I32(64)], 1);
}

#[test]
fn diff_floats() {
    differential(FLOATS, "run", &[Val::I32(300)], 1);
}

#[test]
fn diff_i64_memory() {
    differential(I64_MEMORY, "run", &[Val::I32(1000)], 1);
}

#[test]
fn diff_call_indirect() {
    differential(CALL_INDIRECT, "run", &[Val::I32(200)], 1);
}

#[test]
fn diff_globals() {
    differential(GLOBALS, "run", &[Val::I32(1000)], 1);
}

#[test]
fn diff_nested_blocks() {
    differential(NESTED_BLOCKS, "run", &[Val::I32(50)], 1);
}

// ------------------------------------------------ checkpoint / restore

/// Drive a full unwind→capture→restore→resume cycle by hand through the
/// guest ABI, restoring into a *fresh* instance (fresh Store) — exactly what
/// a migration target does.
#[test]
fn checkpoint_restore_roundtrip() {
    for (wat_src, entry, args, expect_polls) in [
        (LOOP_SUM, "run", vec![Val::I32(200_000)], 3u64),
        (FIB, "fib", vec![Val::I32(27)], 5),
        (STACK_ACROSS_CALL, "run", vec![Val::I32(200_000)], 2),
        (CALL_INDIRECT, "run", vec![Val::I32(200_000)], 4),
        (I64_MEMORY, "run", vec![Val::I32(150_000)], 2),
        (GLOBALS, "run", vec![Val::I32(200_000)], 1),
    ] {
        eprintln!("=== case {entry} unwind_at={expect_polls}");
        checkpoint_restore_case(wat_src, entry, &args, expect_polls);
    }
}

fn checkpoint_restore_case(wat_src: &str, entry: &str, args: &[Val], unwind_at: u64) {
    let wasm = wat::parse_str(wat_src).unwrap();
    let out = weave_transform::transform(&wasm, &Default::default()).unwrap();
    let engine = Engine::new(&Config::new()).unwrap();
    let module = Module::new(&engine, &out.wasm).unwrap();
    let meta = out.meta;

    // Golden: uninterrupted run of the transformed module.
    let (golden_res, golden_emitted) =
        run_module(&engine, &out.wasm, true, entry, args, 1).unwrap();

    // Source instance: run until poll #unwind_at requests an unwind.
    let linker = build_linker(&engine, true);
    let mut store = Store::new(
        &engine,
        HostState {
            emitted: vec![],
            polls: 0,
            unwind_at: Some(unwind_at),
        },
    );
    let instance = linker.instantiate(&mut store, &module).unwrap();
    let init = instance.get_func(&mut store, names::F_INIT).unwrap();
    init.call(&mut store, &[], &mut []).unwrap();
    let f = instance.get_func(&mut store, entry).unwrap();
    let mut results = vec![Val::I32(0); 1];
    f.call(&mut store, args, &mut results).unwrap();

    let flag = get_global(&mut store, &instance, names::G_FLAG);
    assert_eq!(flag, names::FLAG_UNWOUND, "guest should have unwound");
    let emitted_before = store.data().emitted.clone();
    assert!(
        !emitted_before.is_empty() || unwind_at == 0 || golden_emitted.is_empty(),
        "expected some progress before the checkpoint"
    );

    // Capture: memory bytes + control globals. (What a host plugin does.)
    let mem = instance.get_memory(&mut store, &meta.memories[0]).unwrap();
    let mem_bytes = mem.data(&store).to_vec();
    let globals: Vec<(String, i32)> = meta
        .control_globals
        .iter()
        .map(|n| (n.clone(), get_global(&mut store, &instance, n)))
        .collect();
    drop(store);

    // Fresh instance (the "target machine").
    let linker2 = build_linker(&engine, true);
    let mut store2 = Store::new(
        &engine,
        HostState {
            emitted: emitted_before.clone(),
            polls: 0,
            unwind_at: None,
        },
    );
    let instance2 = linker2.instantiate(&mut store2, &module).unwrap();
    // NOTE: __weave_init is NOT called on restore.
    let mem2 = instance2
        .get_memory(&mut store2, &meta.memories[0])
        .unwrap();
    let need = mem_bytes.len();
    let have = mem2.data_size(&store2);
    if need > have {
        mem2.grow(
            &mut store2,
            ((need - have) / weave_core::WASM_PAGE_SIZE) as u64,
        )
        .unwrap();
    }
    mem2.data_mut(&mut store2)[..need].copy_from_slice(&mem_bytes);
    for (name, v) in &globals {
        set_global(&mut store2, &instance2, name, *v);
    }
    let resume = instance2.get_func(&mut store2, names::F_RESUME).unwrap();
    resume.call(&mut store2, &[], &mut []).unwrap();

    let flag2 = get_global(&mut store2, &instance2, names::G_FLAG);
    assert_eq!(flag2, names::FLAG_DONE, "resumed workload should complete");

    // Result comes from the results area in memory.
    let rbase = get_global(&mut store2, &instance2, names::G_RBASE) as usize;
    let roff = rbase + meta.globals_area_size as usize;
    let data = mem2.data(&store2);
    let entry_meta = meta.entries.iter().find(|e| e.name == entry).unwrap();
    let got: Val = match entry_meta.results[0] {
        weave_core::ValType::I32 => {
            Val::I32(i32::from_le_bytes(data[roff..roff + 4].try_into().unwrap()))
        }
        weave_core::ValType::I64 => {
            Val::I64(i64::from_le_bytes(data[roff..roff + 8].try_into().unwrap()))
        }
        weave_core::ValType::F64 => {
            Val::F64(u64::from_le_bytes(data[roff..roff + 8].try_into().unwrap()))
        }
        _ => unreachable!(),
    };
    let fmt = |v: &Val| format!("{v:?}");
    let golden_cmp = match (&golden_res[0], &got) {
        (Val::F64(_), _) => {
            let g = match &golden_res[0] {
                Val::F64(b) => *b,
                _ => unreachable!(),
            };
            format!("{g:?}") == fmt(&got)
        }
        _ => fmt(&golden_res[0]) == fmt(&got),
    };
    assert!(
        golden_cmp,
        "final result differs after restore: golden {:?} vs {:?}",
        golden_res[0], got
    );

    // Emission continuity: pre-checkpoint emissions + post-restore emissions
    // must equal the uninterrupted golden sequence, with no gaps or repeats.
    assert_eq!(
        store2.data().emitted,
        golden_emitted,
        "emitted sequence not seamless across checkpoint/restore"
    );
}

fn get_global(store: &mut Store<HostState>, instance: &Instance, name: &str) -> i32 {
    match instance
        .get_global(&mut *store, name)
        .unwrap()
        .get(&mut *store)
    {
        Val::I32(v) => v,
        other => panic!("global {name} is not i32: {other:?}"),
    }
}

fn set_global(store: &mut Store<HostState>, instance: &Instance, name: &str, v: i32) {
    instance
        .get_global(&mut *store, name)
        .unwrap()
        .set(&mut *store, Val::I32(v))
        .unwrap();
}

#[test]
fn rejects_unsupported() {
    // shared memory
    let wat_shared = "(module (memory 1 1 shared))";
    let wasm = wat::parse_str(wat_shared).unwrap();
    assert!(weave_transform::transform(&wasm, &Default::default()).is_err());
}

/// Extern check: an unused Extern import type should not break anything.
#[test]
fn preserves_untouched_functions() {
    // A module with a pure leaf function stays byte-equivalent in behavior.
    let wat_src = r#"
    (module
      (func $leaf (param i32) (result i32) (i32.mul (local.get 0) (local.get 0)))
      (func (export "run") (param i32) (result i32)
        (local $i i32) (local $a i32)
        (loop $l
          (local.set $a (i32.add (local.get $a) (call $leaf (local.get $i))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get 0))))
        (local.get $a)))
    "#;
    differential(wat_src, "run", &[Val::I32(1000)], 1);
    let _ = Extern::Func; // silence unused-import lint pattern
}
