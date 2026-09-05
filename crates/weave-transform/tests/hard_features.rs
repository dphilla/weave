//! Checkpoint/restore coverage for the hard corners of the spec surface:
//! funcref table mutation (shadowing + rehydration through the canonical
//! table), passive segments with drop-gating, SIMD (v128) live state, and
//! multi-value functions.

use anyhow::{anyhow, Result};
use wasmtime::{Caller, Config, Engine, Instance, Linker, Module, Store, Val};
use weave_core::names;

struct HostState {
    emitted: Vec<i64>,
    polls: u64,
    unwind_at: Option<u64>,
}

fn linker(engine: &Engine) -> Linker<HostState> {
    let mut l: Linker<HostState> = Linker::new(engine);
    l.func_wrap("env", "emit", |mut c: Caller<'_, HostState>, v: i32| {
        c.data_mut().emitted.push(v as i64);
    })
    .unwrap();
    l.func_wrap("weave", "poll", |mut c: Caller<'_, HostState>| -> i32 {
        let st = c.data_mut();
        let n = st.polls;
        st.polls += 1;
        match st.unwind_at {
            Some(k) if n >= k => 1,
            _ => 0,
        }
    })
    .unwrap();
    l
}

/// Run transformed module uninterrupted → (results, emitted).
fn golden(
    engine: &Engine,
    wasm: &[u8],
    entry: &str,
    args: &[Val],
    nres: usize,
) -> (Vec<String>, Vec<i64>) {
    let module = Module::new(engine, wasm).unwrap();
    let mut store = Store::new(
        engine,
        HostState {
            emitted: vec![],
            polls: 0,
            unwind_at: None,
        },
    );
    let inst = linker(engine).instantiate(&mut store, &module).unwrap();
    inst.get_func(&mut store, names::F_INIT)
        .unwrap()
        .call(&mut store, &[], &mut [])
        .unwrap();
    let f = inst.get_func(&mut store, entry).unwrap();
    let mut res = vec![Val::I32(0); nres];
    f.call(&mut store, args, &mut res).unwrap();
    (
        res.iter().map(|v| format!("{v:?}")).collect(),
        store.data().emitted.clone(),
    )
}

/// Checkpoint at poll #k, restore into a fresh instance, run to completion.
fn checkpointed(
    engine: &Engine,
    wasm: &[u8],
    meta: &weave_core::Meta,
    entry: &str,
    args: &[Val],
    unwind_at: u64,
) -> Result<(Vec<String>, Vec<i64>)> {
    let module = Module::new(engine, wasm)?;
    let mut store = Store::new(
        engine,
        HostState {
            emitted: vec![],
            polls: 0,
            unwind_at: Some(unwind_at),
        },
    );
    let inst = linker(engine).instantiate(&mut store, &module)?;
    inst.get_func(&mut store, names::F_INIT)
        .unwrap()
        .call(&mut store, &[], &mut [])?;
    let f = inst
        .get_func(&mut store, entry)
        .ok_or_else(|| anyhow!("no export"))?;
    let nres = meta
        .entries
        .iter()
        .find(|e| e.name == entry)
        .unwrap()
        .results
        .len();
    let mut res = vec![Val::I32(0); nres];
    f.call(&mut store, args, &mut res)?;
    assert_eq!(
        get_g(&mut store, &inst, names::G_FLAG),
        names::FLAG_UNWOUND,
        "did not unwind"
    );

    // capture
    let mem = inst.get_memory(&mut store, &meta.memories[0]).unwrap();
    let mem_bytes = mem.data(&store).to_vec();
    let globals: Vec<(String, i32)> = meta
        .control_globals
        .iter()
        .map(|n| (n.clone(), get_g(&mut store, &inst, n)))
        .collect();
    let emitted_pre = store.data().emitted.clone();
    drop(store);

    // restore into fresh instance
    let mut store2 = Store::new(
        engine,
        HostState {
            emitted: emitted_pre,
            polls: 0,
            unwind_at: None,
        },
    );
    let inst2 = linker(engine).instantiate(&mut store2, &module)?;
    let mem2 = inst2.get_memory(&mut store2, &meta.memories[0]).unwrap();
    let have = mem2.data_size(&store2);
    if mem_bytes.len() > have {
        mem2.grow(
            &mut store2,
            ((mem_bytes.len() - have) / weave_core::WASM_PAGE_SIZE) as u64,
        )?;
    }
    mem2.data_mut(&mut store2)[..mem_bytes.len()].copy_from_slice(&mem_bytes);
    for (n, v) in &globals {
        inst2
            .get_global(&mut store2, n)
            .unwrap()
            .set(&mut store2, Val::I32(*v))?;
    }
    inst2
        .get_func(&mut store2, names::F_RESUME)
        .unwrap()
        .call(&mut store2, &[], &mut [])?;
    assert_eq!(get_g(&mut store2, &inst2, names::G_FLAG), names::FLAG_DONE);

    // read results from the results area
    let rbase = get_g(&mut store2, &inst2, names::G_RBASE) as usize;
    let roff = rbase + meta.globals_area_size as usize;
    let data = mem2.data(&store2);
    let entry_meta = meta.entries.iter().find(|e| e.name == entry).unwrap();
    let results: Vec<String> = entry_meta
        .results
        .iter()
        .enumerate()
        .map(|(i, ty)| {
            let off = roff + i * 16;
            match ty {
                weave_core::ValType::I32 => {
                    format!(
                        "{:?}",
                        Val::I32(i32::from_le_bytes(data[off..off + 4].try_into().unwrap()))
                    )
                }
                weave_core::ValType::I64 => {
                    format!(
                        "{:?}",
                        Val::I64(i64::from_le_bytes(data[off..off + 8].try_into().unwrap()))
                    )
                }
                weave_core::ValType::F64 => {
                    format!(
                        "{:?}",
                        Val::F64(u64::from_le_bytes(data[off..off + 8].try_into().unwrap()))
                    )
                }
                weave_core::ValType::F32 => {
                    format!(
                        "{:?}",
                        Val::F32(u32::from_le_bytes(data[off..off + 4].try_into().unwrap()))
                    )
                }
                other => panic!("unexpected {other:?}"),
            }
        })
        .collect();
    Ok((results, store2.data().emitted.clone()))
}

fn get_g(store: &mut Store<HostState>, inst: &Instance, name: &str) -> i32 {
    match inst.get_global(&mut *store, name).unwrap().get(&mut *store) {
        Val::I32(v) => v,
        _ => panic!(),
    }
}

fn case(wat_src: &str, entry: &str, args: &[Val], unwind_at: u64) {
    let wasm = wat::parse_str(wat_src).unwrap();
    let out = weave_transform::transform(&wasm, &Default::default()).unwrap();
    let engine = Engine::new(&Config::new()).unwrap();
    let nres = out
        .meta
        .entries
        .iter()
        .find(|e| e.name == entry)
        .unwrap()
        .results
        .len();
    let (gr, ge) = golden(&engine, &out.wasm, entry, args, nres);
    let (cr, ce) = checkpointed(&engine, &out.wasm, &out.meta, entry, args, unwind_at).unwrap();
    assert_eq!(gr, cr, "results differ for {entry}");
    assert_eq!(ge, ce, "emitted sequence differs for {entry}");
}

/// Mutates its function table at runtime (rotates operations), keeps a
/// funcref in a local across checkpoints, and grows the table mid-run. The
/// restore path must rebuild the mutated table from shadows.
#[test]
fn funcref_table_mutation() {
    const WAT: &str = r#"
    (module
      (import "env" "emit" (func $emit (param i32)))
      (type $op (func (param i32) (result i32)))
      (table $t 4 20 funcref)
      (elem (i32.const 0) $inc $dbl $sqr $neg)
      (func $inc (type $op) (i32.add (local.get 0) (i32.const 1)))
      (func $dbl (type $op) (i32.mul (local.get 0) (i32.const 2)))
      (func $sqr (type $op) (i32.mul (local.get 0) (local.get 0)))
      (func $neg (type $op) (i32.sub (i32.const 0) (local.get 0)))
      (func (export "run") (param $n i32) (result i32)
        (local $i i32) (local $acc i32) (local $tmp funcref)
        ;; grow the table by one, seeded with $inc
        (drop (table.grow $t (ref.func $inc) (i32.const 1)))
        (loop $l
          ;; rotate: t[0..3] <- t[1..3],t[0]  (via a funcref local!)
          (local.set $tmp (table.get $t (i32.const 0)))
          (table.copy $t $t (i32.const 0) (i32.const 1) (i32.const 3))
          (table.set $t (i32.const 3) (local.get $tmp))
          ;; apply t[i % 5]
          (local.set $acc
            (i32.and
              (i32.add (local.get $acc)
                (call_indirect $t (type $op)
                  (i32.add (local.get $acc) (local.get $i))
                  (i32.rem_u (local.get $i) (i32.const 5))))
              (i32.const 0xFFFFF)))
          (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 1000)))
            (then (call $emit (local.get $acc))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        (local.get $acc)))
    "#;
    case(WAT, "run", &[Val::I32(50_000)], 3);
}

/// Passive data segments: memory.init + data.drop with spec trap semantics
/// preserved across a checkpoint (init-after-drop must still trap; the
/// dropped-flag state must migrate).
#[test]
fn passive_segments_gating() {
    const WAT: &str = r#"
    (module
      (import "env" "emit" (func $emit (param i32)))
      (memory 1)
      (data $seed "\01\02\03\04\05\06\07\08")
      (func (export "run") (param $n i32) (result i32)
        (local $i i32) (local $acc i32)
        (loop $l
          (if (i32.eq (local.get $i) (i32.const 0))
            (then (memory.init $seed (i32.const 100) (i32.const 0) (i32.const 8))))
          ;; after 60% of the run, drop the segment
          (if (i32.eq (local.get $i) (i32.mul (i32.div_u (local.get $n) (i32.const 10)) (i32.const 6)))
            (then (data.drop $seed)))
          (local.set $acc
            (i32.add (local.get $acc)
              (i32.load8_u (i32.add (i32.const 100) (i32.rem_u (local.get $i) (i32.const 8))))))
          (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 5000)))
            (then (call $emit (local.get $acc))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        (local.get $acc)))
    "#;
    case(WAT, "run", &[Val::I32(100_000)], 4);

    // and: init-after-drop still traps post-restore
    const WAT_TRAP: &str = r#"
    (module
      (memory 1)
      (data $seed "\01\02\03\04")
      (func (export "run") (param $n i32) (result i32)
        (local $i i32)
        (data.drop $seed)
        (loop $l
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        ;; this must trap: the segment was dropped (even across a checkpoint)
        (memory.init $seed (i32.const 0) (i32.const 0) (i32.const 4))
        (local.get $i)))
    "#;
    let wasm = wat::parse_str(WAT_TRAP).unwrap();
    let out = weave_transform::transform(&wasm, &Default::default()).unwrap();
    let engine = Engine::new(&Config::new()).unwrap();
    let res = checkpointed(
        &engine,
        &out.wasm,
        &out.meta,
        "run",
        &[Val::I32(100_000)],
        2,
    );
    let err = res.expect_err("memory.init after data.drop must trap after restore");
    assert!(
        format!("{err:#}").contains("unreachable"),
        "wrong trap: {err:#}"
    );
}

/// v128 state live across a checkpoint (SIMD lane arithmetic mid-loop).
#[test]
fn simd_v128_state() {
    const WAT: &str = r#"
    (module
      (import "env" "emit" (func $emit (param i32)))
      (memory 1)
      (func (export "run") (param $n i32) (result i32)
        (local $i i32) (local $v v128) (local $acc v128)
        (local.set $v (v128.const i32x4 1 2 3 4))
        (loop $l
          (local.set $acc (i32x4.add (local.get $acc) (local.get $v)))
          (local.set $v
            (i32x4.add (local.get $v) (v128.const i32x4 1 1 1 1)))
          (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 2000)))
            (then (call $emit (i32x4.extract_lane 2 (local.get $acc)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        (i32.add
          (i32x4.extract_lane 0 (local.get $acc))
          (i32x4.extract_lane 3 (local.get $acc)))))
    "#;
    case(WAT, "run", &[Val::I32(60_000)], 3);
}

/// Multi-value function results survive the wrapper/results-area path.
#[test]
fn multivalue_entry() {
    const WAT: &str = r#"
    (module
      (func (export "run") (param $n i32) (result i32 i64)
        (local $i i32) (local $a i32) (local $b i64)
        (loop $l
          (local.set $a (i32.add (local.get $a) (local.get $i)))
          (local.set $b (i64.add (local.get $b) (i64.extend_i32_u (local.get $a))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        (local.get $a) (local.get $b)))
    "#;
    case(WAT, "run", &[Val::I32(200_000)], 2);
}

/// Deep mutual recursion (call-graph cycle across two functions).
#[test]
fn mutual_recursion() {
    const WAT: &str = r#"
    (module
      (func $even (param $n i32) (result i32)
        (if (result i32) (i32.eqz (local.get $n))
          (then (i32.const 1))
          (else (call $odd (i32.sub (local.get $n) (i32.const 1))))))
      (func $odd (param $n i32) (result i32)
        (if (result i32) (i32.eqz (local.get $n))
          (then (i32.const 0))
          (else (call $even (i32.sub (local.get $n) (i32.const 1))))))
      (func (export "run") (param $n i32) (result i32)
        (local $i i32) (local $acc i32)
        (loop $l
          (local.set $acc
            (i32.add (local.get $acc) (call $even (i32.add (local.get $i) (i32.const 3000)))))
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
        (local.get $acc)))
    "#;
    case(WAT, "run", &[Val::I32(3_000)], 3);
}
