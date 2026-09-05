//! Guest-visible memory behavior must survive instrumentation and checkpoints.
//! These tests compare host observations and traps with the original module;
//! snapshots deliberately use every metadata-listed memory and control global.

use anyhow::{anyhow, Result};
use wasmtime::{Caller, Engine, Instance, Linker, Module, Store};
use weave_core::{names, Meta, WASM_PAGE_SIZE};
use weave_transform::TransformOptions;

#[derive(Default)]
struct HostState {
    observations: Vec<i32>,
    polls: u64,
    unwind_at: Option<u64>,
}

#[derive(Debug, PartialEq)]
struct Outcome {
    observations: Vec<i32>,
    trapped: bool,
}

fn linker(engine: &Engine) -> Linker<HostState> {
    let mut linker = Linker::new(engine);
    linker
        .func_wrap(
            "env",
            "observe",
            |mut caller: Caller<'_, HostState>, value: i32| {
                caller.data_mut().observations.push(value);
            },
        )
        .unwrap();
    linker
        .func_wrap(
            "env",
            "read_guest",
            |mut caller: Caller<'_, HostState>, address: i32| -> Result<i32> {
                let memory = caller
                    .get_export("memory")
                    .and_then(|export| export.into_memory())
                    .ok_or_else(|| anyhow!("guest memory export missing"))?;
                let mut bytes = [0; 4];
                memory.read(&caller, address as u32 as usize, &mut bytes)?;
                Ok(i32::from_le_bytes(bytes))
            },
        )
        .unwrap();
    linker
        .func_wrap(
            "weave",
            "poll",
            |mut caller: Caller<'_, HostState>| -> i32 {
                let state = caller.data_mut();
                let poll = state.polls;
                state.polls += 1;
                i32::from(state.unwind_at.is_some_and(|at| poll >= at))
            },
        )
        .unwrap();
    linker
        .func_wrap(
            "env",
            "reenter",
            |mut caller: Caller<'_, HostState>| -> Result<()> {
                let inner = caller
                    .get_export("inner")
                    .and_then(|export| export.into_func())
                    .ok_or_else(|| anyhow!("reentrant entry missing"))?
                    .typed::<(), ()>(&caller)?;
                inner.call(&mut caller, ())?;
                Ok(())
            },
        )
        .unwrap();
    linker
}

fn global(store: &mut Store<HostState>, instance: &Instance, name: &str) -> i32 {
    instance
        .get_global(&mut *store, name)
        .unwrap()
        .get(&mut *store)
        .i32()
        .unwrap()
}

fn execute(
    engine: &Engine,
    wasm: &[u8],
    meta: Option<&Meta>,
    unwind_at: Option<u64>,
) -> Result<Outcome> {
    let module = Module::new(engine, wasm)?;
    let linker = linker(engine);
    let mut store = Store::new(engine, HostState::default());
    let instance = linker.instantiate(&mut store, &module)?;
    if meta.is_some() {
        instance
            .get_typed_func::<(), ()>(&mut store, names::F_INIT)?
            .call(&mut store, ())?;
    }
    store.data_mut().unwind_at = unwind_at;
    store.data_mut().polls = 0;
    let call = instance
        .get_typed_func::<(), ()>(&mut store, "run")?
        .call(&mut store, ());
    if call.is_err() {
        return Ok(Outcome {
            observations: store.data().observations.clone(),
            trapped: true,
        });
    }
    let Some(meta) = meta else {
        return Ok(Outcome {
            observations: store.data().observations.clone(),
            trapped: false,
        });
    };
    if unwind_at.is_none() {
        assert_eq!(
            global(&mut store, &instance, names::G_FLAG),
            names::FLAG_DONE
        );
        return Ok(Outcome {
            observations: store.data().observations.clone(),
            trapped: false,
        });
    }
    assert_eq!(
        global(&mut store, &instance, names::G_FLAG),
        names::FLAG_UNWOUND,
        "fixture must reach the requested checkpoint"
    );
    let memories: Vec<_> = meta
        .memories
        .iter()
        .map(|name| {
            let memory = instance.get_memory(&mut store, name).unwrap();
            memory.data(&store).to_vec()
        })
        .collect();
    let globals: Vec<_> = meta
        .control_globals
        .iter()
        .map(|name| (name.clone(), global(&mut store, &instance, name)))
        .collect();
    let observations = store.data().observations.clone();
    drop(store);

    let mut restored = Store::new(
        engine,
        HostState {
            observations,
            ..HostState::default()
        },
    );
    let instance = linker.instantiate(&mut restored, &module)?;
    for (name, bytes) in meta.memories.iter().zip(memories) {
        let memory = instance.get_memory(&mut restored, name).unwrap();
        memory.data_mut(&mut restored).fill(0);
        let current = memory.data_size(&restored);
        if bytes.len() > current {
            memory.grow(
                &mut restored,
                ((bytes.len() - current) / WASM_PAGE_SIZE) as u64,
            )?;
        }
        memory.write(&mut restored, 0, &bytes)?;
    }
    for (name, value) in globals {
        instance
            .get_global(&mut restored, &name)
            .unwrap()
            .set(&mut restored, wasmtime::Val::I32(value))?;
    }
    let resume = instance
        .get_typed_func::<(), ()>(&mut restored, names::F_RESUME)?
        .call(&mut restored, ());
    if resume.is_ok() {
        assert_eq!(
            global(&mut restored, &instance, names::G_FLAG),
            names::FLAG_DONE
        );
    }
    Ok(Outcome {
        observations: restored.data().observations.clone(),
        trapped: resume.is_err(),
    })
}

fn compare(wat: &str, expected: &[i32], trapped: bool, checkpoints: &[u64]) {
    let raw = wat::parse_str(wat).unwrap();
    let woven = weave_transform::transform(
        &raw,
        &TransformOptions {
            poll_period: 1,
            ..TransformOptions::default()
        },
    )
    .unwrap();
    let engine = Engine::default();
    let original = execute(&engine, &raw, None, None).unwrap();
    assert_eq!(
        original.observations, expected,
        "original fixture observations"
    );
    assert_eq!(original.trapped, trapped, "original fixture trap outcome");
    assert_eq!(
        execute(&engine, &woven.wasm, Some(&woven.meta), None).unwrap(),
        original,
        "instrumentation changed guest behavior"
    );
    for &at in checkpoints {
        assert_eq!(
            execute(&engine, &woven.wasm, Some(&woven.meta), Some(at)).unwrap(),
            original,
            "checkpoint at poll {at} changed guest behavior"
        );
    }
}

#[test]
fn memory_size_and_grow_preserve_declared_maximum() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 1 2)
            (func (export "run")
                (call $observe (memory.size))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (memory.size))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (memory.grow (i32.const -1)))
                (call $observe (memory.grow (i32.const 0)))
                (call $observe (memory.size))))"#,
        &[1, 1, 2, -1, -1, 2, 2],
        false,
        &[],
    );
}

#[test]
fn fixed_memory_supports_fresh_execution_and_checkpoint() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 1 1)
            (data (i32.const 0) "\09\00\00\00")
            (func (export "run") (local $i i32)
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 100))))
                (call $observe (i32.load (i32.const 0)))
                (call $observe (memory.size))))"#,
        &[9, 1],
        false,
        &[0, 1, 10, 90],
    );
}

#[test]
fn zero_page_memory_can_grow_after_checkpoint() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 0 1)
            (func (export "run") (local $i i32)
                (call $observe (memory.size))
                (call $observe (memory.grow (i32.const 0)))
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (memory.size))
                (call $observe (i32.load (i32.const 0)))))"#,
        &[0, 0, 0, 1, 0],
        false,
        &[0, 5, 15],
    );
}

#[test]
fn memory_growth_after_restore_preserves_data_and_zeroes_new_pages() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory (export "memory") 1 3)
            (data (i32.const 65532) "ABCD")
            (func (export "run") (local $i i32)
                (call $observe (i32.load (i32.const 65532)))
                (loop $before
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $before (i32.lt_u (local.get $i) (i32.const 64))))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (memory.size))
                (call $observe (i32.load (i32.const 65536)))
                (call $observe (i32.load (i32.const 131068)))
                (i32.store (i32.const 131068) (i32.const 1234))
                (loop $after
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $after (i32.lt_u (local.get $i) (i32.const 128))))
                (call $observe (i32.load (i32.const 131068)))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (i32.load (i32.const 131072)))
                (call $observe (memory.size))
                (call $observe (memory.grow (i32.const 1)))))"#,
        &[0x44434241, 1, 2, 0, 0, 1234, 2, 0, 3, -1],
        false,
        &[0, 7, 63, 70, 120],
    );
}

#[test]
fn host_imports_keep_guest_pointer_addresses() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (import "env" "read_guest" (func $read (param i32) (result i32)))
            (memory (export "memory") 1)
            (data (i32.const 32) "\2a\00\00\00")
            (func (export "run") (local $i i32)
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (call $observe (call $read (i32.const 32)))
                (drop (memory.grow (i32.const 1)))
                (i32.store (i32.const 65536) (i32.const 99))
                (call $observe (call $read (i32.const 65536)))))"#,
        &[42, 99],
        false,
        &[0, 5, 15],
    );
}

#[test]
fn out_of_bounds_scalar_simd_and_bulk_accesses_still_trap() {
    for instruction in [
        "(drop (i32.load (i32.const 65536)))",
        "(i32.store (i32.const 65536) (i32.const 7))",
        "(drop (i64.load (i32.const 65532)))",
        "(drop (i32.load offset=4 (i32.const -1)))",
        "(drop (v128.load (i32.const 65521)))",
        "(v128.store (i32.const 65521) (v128.const i32x4 0 0 0 0))",
        "(drop (v128.load8_lane 0 (i32.const 65536) (v128.const i32x4 0 0 0 0)))",
        "(memory.fill (i32.const 65535) (i32.const 0) (i32.const 2))",
        "(memory.copy (i32.const 65535) (i32.const 0) (i32.const 2))",
        "(memory.copy (i32.const 0) (i32.const 65535) (i32.const 2))",
        "(memory.fill (i32.const 65537) (i32.const 0) (i32.const 0))",
        "(memory.copy (i32.const 0) (i32.const 65537) (i32.const 0))",
        "(memory.init $passive (i32.const 65536) (i32.const 0) (i32.const 1))",
    ] {
        let wat = format!(
            r#"(module
                (import "env" "observe" (func $observe (param i32)))
                (memory 1)
                (data $passive "x")
                (func (export "run") (local $i i32)
                    (loop $loop
                        (local.set $i (i32.add (local.get $i) (i32.const 1)))
                        (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                    (call $observe (i32.const 7))
                    {instruction}
                    (call $observe (i32.const 99))))"#
        );
        eprintln!("checking logical bounds for {instruction}");
        compare(&wat, &[7], true, &[0, 5]);
    }
}

#[test]
fn out_of_bounds_accesses_in_leaf_functions_still_trap() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 1)
            (func $leaf (result i32) (i32.load (i32.const 65536)))
            (func (export "run") (local $i i32)
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (call $observe (i32.const 7))
                (call $observe (call $leaf))))"#,
        &[7],
        true,
        &[0, 5],
    );
}

#[test]
fn scalar_and_narrow_simd_accesses_at_the_last_valid_byte_succeed() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 1)
            (data (i32.const 65520) "\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10")
            (func (export "run") (local $i i32)
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (call $observe (i32.load8_u (i32.const 65535)))
                (call $observe (i8x16.extract_lane_u 0
                    (v128.load8_lane 0 (i32.const 65535) (v128.const i32x4 0 0 0 0))))
                (call $observe (i16x8.extract_lane_u 0
                    (v128.load16_splat (i32.const 65534))))
                (call $observe (i32x4.extract_lane 0
                    (v128.load32_zero (i32.const 65532))))
                (drop (v128.load8x8_u (i32.const 65528)))
                (drop (v128.load16x4_u (i32.const 65528)))
                (drop (v128.load32x2_u (i32.const 65528)))
                (drop (v128.load (i32.const 65520)))
                (v128.store8_lane 0 (i32.const 65535) (v128.const i32x4 171 0 0 0))
                (call $observe (i32.load8_u (i32.const 65535)))))"#,
        &[16, 16, 0x100f, 0x100f0e0d, 171],
        false,
        &[0, 5],
    );
}

#[test]
fn exact_end_zero_length_operations_remain_valid() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory 1)
            (data $passive "x")
            (func (export "run") (local $i i32)
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (memory.fill (i32.const 65536) (i32.const 7) (i32.const 0))
                (memory.copy (i32.const 65536) (i32.const 65536) (i32.const 0))
                (memory.init $passive (i32.const 65536) (i32.const 1) (i32.const 0))
                (data.drop $passive)
                (memory.init $passive (i32.const 65536) (i32.const 0) (i32.const 0))
                (call $observe (memory.size))))"#,
        &[1],
        false,
        &[0, 5],
    );
}

#[test]
fn guest_growth_preserves_table_shadows_and_dropped_segments() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (type $answer (func (result i32)))
            (memory 1 3)
            (table 1 funcref)
            (elem declare func $first $second)
            (data $passive "x")
            (func $first (result i32) (i32.const 42))
            (func $second (result i32) (i32.const 21))
            (func (export "run") (local $i i32)
                (table.set (i32.const 0) (ref.func $first))
                (data.drop $passive)
                (loop $before
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $before (i32.lt_u (local.get $i) (i32.const 40))))
                (call $observe (memory.grow (i32.const 1)))
                (call $observe (call_indirect (type $answer) (i32.const 0)))
                (loop $after
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $after (i32.lt_u (local.get $i) (i32.const 80))))
                (call $observe (memory.grow (i32.const 1)))
                (table.set (i32.const 0) (ref.func $second))
                (call $observe (call_indirect (type $answer) (i32.const 0)))
                (call $observe (memory.size))
                (memory.init $passive (i32.const 0) (i32.const 0) (i32.const 1))))"#,
        &[1, 42, 2, 21, 3],
        true,
        &[0, 10, 50, 75],
    );
}

#[test]
fn growth_and_restore_leave_other_memories_independent() {
    compare(
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (memory $primary 1 2)
            (memory $other 1 1)
            (data (memory $other) (i32.const 0) "\09\00\00\00")
            (func (export "run") (local $i i32)
                (call $observe (memory.grow $primary (i32.const 1)))
                (loop $loop
                    (local.set $i (i32.add (local.get $i) (i32.const 1)))
                    (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                (call $observe (memory.size $primary))
                (call $observe (memory.size $other))
                (call $observe (memory.grow $other (i32.const 1)))
                (call $observe (i32.load $other (i32.const 0)))))"#,
        &[1, 2, 1, -1, 9],
        false,
        &[0, 5, 15],
    );
}

#[test]
fn active_segment_instantiation_preserves_original_bounds() {
    let engine = Engine::default();
    let linker = linker(&engine);
    for (offset, should_trap) in [(65535, false), (65536, true)] {
        let raw = wat::parse_str(format!(
            "(module (memory 1) (data (i32.const {offset}) \"x\") (func (export \"run\")))"
        ))
        .unwrap();
        let woven = weave_transform::transform(&raw, &TransformOptions::default()).unwrap();
        for (kind, bytes) in [("original", &raw), ("woven", &woven.wasm)] {
            let module = Module::new(&engine, bytes).unwrap();
            let mut store = Store::new(&engine, HostState::default());
            assert_eq!(
                linker.instantiate(&mut store, &module).is_err(),
                should_trap,
                "{kind} active segment at {offset} changed instantiation bounds"
            );
        }
    }
}

#[test]
fn finite_imported_primary_memory_has_a_precise_transform_diagnostic() {
    let raw = wat::parse_str(
        r#"(module
            (import "env" "memory" (memory 1 1))
            (func (export "run")))"#,
    )
    .unwrap();
    let result = weave_transform::transform(&raw, &TransformOptions::default());
    let error = result
        .err()
        .expect("finite imported memory must be rejected");
    assert!(
        format!("{error:#}").contains("unsupported: imported memory 0 with a finite maximum"),
        "unexpected diagnostic: {error:#}"
    );
}

#[test]
fn atomic_instructions_on_unshared_memory_are_explicitly_rejected() {
    for instruction in [
        "(drop (i32.atomic.load (i32.const 0)))",
        "(i64.atomic.store (i32.const 0) (i64.const 1))",
        "(drop (i32.atomic.rmw.add (i32.const 0) (i32.const 1)))",
        "(atomic.fence)",
    ] {
        let raw = wat::parse_str(format!(
            "(module (memory 1) (func (export \"run\") {instruction}))"
        ))
        .unwrap();
        wasmparser::Validator::new()
            .validate_all(&raw)
            .expect("fixture must be a valid unshared-memory atomic module");
        let error = weave_transform::transform(&raw, &TransformOptions::default())
            .err()
            .expect("atomic instruction must not bypass logical memory bounds");
        assert!(
            format!("{error:#}").contains("unsupported: atomic instructions"),
            "unexpected diagnostic for {instruction}: {error:#}"
        );
    }
}

#[test]
fn initialization_is_idempotent_with_zero_page_or_injected_memory() {
    let engine = Engine::default();
    let linker = linker(&engine);
    for memory in ["", "(memory 0)", "(memory 1)"] {
        let raw = wat::parse_str(format!(
            r#"(module
                (import "env" "observe" (func $observe (param i32)))
                {memory}
                (func $start (call $observe (i32.const 123)))
                (start $start)
                (func (export "run")))"#
        ))
        .unwrap();
        let woven = weave_transform::transform(&raw, &TransformOptions::default()).unwrap();
        let module = Module::new(&engine, &woven.wasm).unwrap();
        let mut store = Store::new(&engine, HostState::default());
        let instance = linker.instantiate(&mut store, &module).unwrap();
        let init = instance
            .get_typed_func::<(), ()>(&mut store, names::F_INIT)
            .unwrap();
        init.call(&mut store, ()).unwrap();
        let memory = instance
            .get_memory(&mut store, &woven.meta.memories[0])
            .unwrap();
        let size = memory.data_size(&store);
        init.call(&mut store, ()).unwrap();
        init.call(&mut store, ()).unwrap();
        assert_eq!(store.data().observations, [123], "start ran more than once");
        assert_eq!(
            memory.data_size(&store),
            size,
            "repeated init allocated memory"
        );
    }
}

#[test]
fn completed_entry_records_its_result_contract_even_after_reentrant_calls() {
    let engine = Engine::default();
    let linker = linker(&engine);
    for (body, checkpoint) in [
        ("", false),
        ("(call $reenter)", false),
        ("", true),
        ("(call $reenter)", true),
    ] {
        let raw = wat::parse_str(format!(
            r#"(module
                (import "env" "reenter" (func $reenter))
                (func (export "inner"))
                (func (export "run") (result i32) (local $i i32)
                    (loop $loop
                        (local.set $i (i32.add (local.get $i) (i32.const 1)))
                        (br_if $loop (i32.lt_u (local.get $i) (i32.const 20))))
                    {body} (i32.const 7)))"#
        ))
        .unwrap();
        let woven = weave_transform::transform(
            &raw,
            &TransformOptions {
                poll_period: 1,
                ..TransformOptions::default()
            },
        )
        .unwrap();
        let module = Module::new(&engine, &woven.wasm).unwrap();
        let mut store = Store::new(&engine, HostState::default());
        let instance = linker.instantiate(&mut store, &module).unwrap();
        instance
            .get_typed_func::<(), ()>(&mut store, names::F_INIT)
            .unwrap()
            .call(&mut store, ())
            .unwrap();
        store.data_mut().unwind_at = checkpoint.then_some(0);
        let value = instance
            .get_typed_func::<(), i32>(&mut store, "run")
            .unwrap()
            .call(&mut store, ())
            .unwrap();
        if checkpoint {
            assert_eq!(
                global(&mut store, &instance, names::G_FLAG),
                names::FLAG_UNWOUND
            );
            store.data_mut().unwind_at = None;
            instance
                .get_typed_func::<(), ()>(&mut store, names::F_RESUME)
                .unwrap()
                .call(&mut store, ())
                .unwrap();
        } else {
            assert_eq!(value, 7);
        }
        assert_eq!(
            global(&mut store, &instance, names::G_FLAG),
            names::FLAG_DONE
        );
        assert_eq!(
            global(&mut store, &instance, names::G_ENTRY) as usize,
            woven.meta.entry_index("run").unwrap(),
            "result readers must use the completed outer entry's signature"
        );
        let base = global(&mut store, &instance, names::G_RBASE) as u32 as usize
            + woven.meta.globals_area_size as usize;
        let memory = instance
            .get_memory(&mut store, &woven.meta.memories[0])
            .unwrap();
        let mut result_bytes = [0; 4];
        memory.read(&store, base, &mut result_bytes).unwrap();
        assert_eq!(i32::from_le_bytes(result_bytes), 7);
    }
}

#[test]
fn tail_calls_are_lowered_even_in_untouched_leaf_callers() {
    for wat in [
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (func $leaf (result i32) (i32.const 42))
            (func $tail (result i32) (return_call $leaf))
            (func (export "run") (call $observe (call $tail))))"#,
        r#"(module
            (import "env" "observe" (func $observe (param i32)))
            (type $answer (func (result i32)))
            (table 1 funcref)
            (elem (i32.const 0) $leaf)
            (func $leaf (type $answer) (i32.const 42))
            (func $tail (result i32) (return_call_indirect (type $answer) (i32.const 0)))
            (func (export "run") (call $observe (call $tail))))"#,
    ] {
        let raw = wat::parse_str(wat).unwrap();
        let woven = weave_transform::transform(&raw, &TransformOptions::default()).unwrap();
        for payload in wasmparser::Parser::new(0).parse_all(&woven.wasm) {
            if let wasmparser::Payload::CodeSectionEntry(body) = payload.unwrap() {
                for operation in body.get_operators_reader().unwrap() {
                    let operation = operation.unwrap();
                    assert!(
                        !matches!(
                            operation,
                            wasmparser::Operator::ReturnCall { .. }
                                | wasmparser::Operator::ReturnCallIndirect { .. }
                        ),
                        "transformed module retains {operation:?}"
                    );
                }
            }
        }
        compare(wat, &[42], false, &[]);
    }
}
