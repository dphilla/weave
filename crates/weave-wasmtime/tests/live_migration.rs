//! End-to-end live migration between two wasmtime instances over real TCP:
//! source runs a workload, pre-copy streams memory while it executes, the
//! guest unwinds, the final delta moves, and the target resumes seamlessly.
//! Host-service state (a stateful accumulator) migrates too. Also exercises
//! the rollback path: if the target dies mid-migration the source rewinds
//! locally and finishes as if nothing happened.

use anyhow::Result;
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use wasmtime::{Caller, Linker, Val};
use weave_host::source::SourceOptions;
use weave_host::{HostService, MemRead};
use weave_wasmtime::instance::{LinkFn, ServiceSet};
use weave_wasmtime::migrate::{accept_conn, migrate_running, MigrateOutcome, TargetFactory};
use weave_wasmtime::{default_engine, WeaveInstance, WeaveModule, WorkResult};

/// A guest that does real work over a chunk of memory and reports progress:
/// emits (i, running_checksum) through a stateful host service every K steps.
const GUEST: &str = r#"
(module
  (import "env" "emit" (func $emit (param i32 i64)))
  (memory (export "memory") 32)   ;; 2 MiB working set
  (func (export "run") (param $n i32) (result i64)
    (local $i i32) (local $h i64) (local $addr i32)
    (local.set $h (i64.const 1469598103934665603))
    (loop $l
      ;; touch memory pseudo-randomly (dirties pages during pre-copy)
      (local.set $addr
        (i32.and
          (i32.mul (local.get $i) (i32.const 2654435761))
          (i32.const 0x1FFFF8)))
      (i64.store (local.get $addr)
        (i64.xor (i64.load (local.get $addr)) (i64.extend_i32_u (local.get $i))))
      ;; fold into checksum
      (local.set $h
        (i64.mul
          (i64.xor (local.get $h) (i64.load (local.get $addr)))
          (i64.const 1099511628211)))
      (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 10000)))
        (then (call $emit (local.get $i) (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $h)))
"#;

/// Stateful host service: accumulates everything emitted plus a running sum —
/// state that must survive the migration bit-for-bit.
#[derive(Clone, Default)]
struct EmitLog {
    entries: Vec<(i32, i64)>,
    sum: i64,
}

struct EmitService {
    log: Arc<Mutex<EmitLog>>,
}

impl HostService for EmitService {
    fn name(&self) -> &str {
        "env.emit"
    }
    fn snapshot(&self) -> Vec<u8> {
        let log = self.log.lock().unwrap();
        let mut out = Vec::new();
        out.extend_from_slice(&(log.entries.len() as u32).to_le_bytes());
        for (i, h) in &log.entries {
            out.extend_from_slice(&i.to_le_bytes());
            out.extend_from_slice(&h.to_le_bytes());
        }
        out.extend_from_slice(&log.sum.to_le_bytes());
        out
    }
    fn restore(&mut self, blob: &[u8]) -> Result<()> {
        let n = u32::from_le_bytes(blob[..4].try_into()?) as usize;
        let mut entries = Vec::with_capacity(n);
        let mut pos = 4;
        for _ in 0..n {
            let i = i32::from_le_bytes(blob[pos..pos + 4].try_into()?);
            let h = i64::from_le_bytes(blob[pos + 4..pos + 12].try_into()?);
            entries.push((i, h));
            pos += 12;
        }
        let sum = i64::from_le_bytes(blob[pos..pos + 8].try_into()?);
        *self.log.lock().unwrap() = EmitLog { entries, sum };
        Ok(())
    }
}

fn make_instance_parts(log: Arc<Mutex<EmitLog>>) -> (ServiceSet, LinkFn) {
    let services: Vec<Box<dyn HostService>> = vec![Box::new(EmitService { log: log.clone() })];
    let link_log = log;
    let link: weave_wasmtime::instance::LinkFn = Box::new(move |linker: &mut Linker<_>| {
        let log = link_log.clone();
        linker.func_wrap(
            "env",
            "emit",
            move |_caller: Caller<'_, weave_wasmtime::instance::Ctx>, i: i32, h: i64| {
                let mut l = log.lock().unwrap();
                l.entries.push((i, h));
                l.sum = l.sum.wrapping_add(h).wrapping_add(i as i64);
            },
        )?;
        Ok(())
    });
    ((services, vec![]), link)
}

fn woven() -> WeaveModule {
    let raw = wat::parse_str(GUEST).unwrap();
    WeaveModule::from_raw(&raw, &Default::default()).unwrap()
}

const N: i32 = 2_000_000;

/// Golden: run to completion in one place.
fn golden() -> (i64, EmitLog) {
    let engine = default_engine().unwrap();
    let module = woven();
    let log = Arc::new(Mutex::new(EmitLog::default()));
    let ((services, any), link) = make_instance_parts(log.clone());
    let mut inst = WeaveInstance::new_fresh(&engine, &module, services, any, link).unwrap();
    let out = inst.call_entry("run", &[Val::I32(N)]).unwrap();
    match out {
        WorkResult::Done(vals) => {
            let h = match vals[0] {
                Val::I64(h) => h,
                _ => panic!("bad result"),
            };
            let l = log.lock().unwrap().clone();
            (h, l)
        }
        WorkResult::Unwound => panic!("golden run should not unwind"),
    }
}

#[test]
fn live_migration_wasmtime_to_wasmtime() {
    let (golden_h, golden_log) = golden();

    let module = woven();
    let engine_src = default_engine().unwrap();
    let engine_dst = default_engine().unwrap();

    // Target listener thread.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let dst_log = Arc::new(Mutex::new(EmitLog::default()));
    let dst_log2 = dst_log.clone();
    let target = std::thread::spawn(move || -> Result<(i64, EmitLog)> {
        let mut factory = TargetFactory {
            engine: engine_dst,
            modules: Default::default(),
            make_services: Box::new(move || {
                let log = dst_log2.clone();
                (
                    vec![Box::new(EmitService { log }) as Box<dyn HostService>],
                    vec![],
                )
            }),
            make_link: Box::new({
                let dst_log3 = dst_log.clone();
                move || {
                    let (_, link) = make_instance_parts(dst_log3.clone());
                    link
                }
            }),
        };
        let (conn, _) = listener.accept()?;
        let mut inst = accept_conn(conn, &mut factory)?;
        // resume the received workload to completion
        match inst.resume()? {
            WorkResult::Done(vals) => {
                let h = match vals[0] {
                    Val::I64(h) => h,
                    _ => panic!("bad result"),
                };
                Ok((h, dst_log.lock().unwrap().clone()))
            }
            WorkResult::Unwound => panic!("target resume unwound unexpectedly"),
        }
    });

    // Source: start running, then migrate mid-flight.
    let src_log = Arc::new(Mutex::new(EmitLog::default()));
    let ((services, any), link) = make_instance_parts(src_log.clone());
    let mut inst = WeaveInstance::new_fresh(&engine_src, &module, services, any, link).unwrap();
    let opts = SourceOptions {
        budget_bytes: 1 << 20,
        dirty_page_threshold: 32,
        max_rounds: 6,
    };
    let outcome = migrate_running(
        &mut inst,
        "run",
        &[Val::I32(N)],
        &addr.to_string(),
        "wasmtime",
        opts,
    )
    .unwrap();
    let stats = match outcome {
        MigrateOutcome::Migrated(stats) => stats,
        MigrateOutcome::CompletedLocally(_) => panic!("should have migrated mid-run"),
        MigrateOutcome::FailedUnwound { error } | MigrateOutcome::FailedNotStarted { error } => {
            panic!("migration failed: {error}")
        }
    };
    println!(
        "migrated after {} rounds, {} total pages, {} pages in the pause window",
        stats.rounds, stats.total_pages, stats.final_pages
    );

    let (dst_h, dst_final_log) = target.join().unwrap().unwrap();

    // Seamlessness: final result identical, and the target's service state
    // continued exactly where the source's left off — the combined emit log
    // equals the golden log.
    assert_eq!(dst_h, golden_h, "final checksum differs after migration");
    assert_eq!(
        dst_final_log.entries, golden_log.entries,
        "emit log not seamless"
    );
    assert_eq!(
        dst_final_log.sum, golden_log.sum,
        "service state not migrated"
    );
    // the source made real progress before migrating
    assert!(
        !src_log.lock().unwrap().entries.is_empty(),
        "no pre-migration progress"
    );
    // and the target only saw post-migration emissions, yet its log is
    // complete — i.e. service state (not just memory) moved.
    assert!(dst_final_log.entries.len() > src_log.lock().unwrap().entries.len());
}

#[test]
fn migration_failure_rolls_back_and_continues() {
    let (golden_h, golden_log) = golden();

    let module = woven();
    let engine = default_engine().unwrap();

    // A "target" that speaks the protocol through MODULE_OK, accepts a few
    // pre-copy pages, then dies mid-stream.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let saboteur = std::thread::spawn(move || {
        use weave_core::wire::{Frame, PROTO_VERSION, ROLE_TARGET};
        let (conn, _) = listener.accept().unwrap();
        let mut r = std::io::BufReader::new(conn.try_clone().unwrap());
        let mut w = std::io::BufWriter::new(conn);
        // HELLO exchange
        let _ = Frame::read_from(&mut r).unwrap();
        Frame::Hello {
            proto: PROTO_VERSION,
            role: ROLE_TARGET,
            runtime: "saboteur".into(),
        }
        .write_to(&mut w)
        .unwrap();
        std::io::Write::flush(&mut w).unwrap();
        // module sync
        let size = match Frame::read_from(&mut r).unwrap() {
            Frame::ModuleMeta { size, .. } => size,
            other => panic!("expected MODULE_META, got {other:?}"),
        };
        Frame::ModuleNeed.write_to(&mut w).unwrap();
        std::io::Write::flush(&mut w).unwrap();
        let mut got = 0u64;
        while got < size {
            match Frame::read_from(&mut r).unwrap() {
                Frame::ModuleData { bytes, .. } => got += bytes.len() as u64,
                other => panic!("expected MODULE_DATA, got {other:?}"),
            }
        }
        Frame::ModuleOk.write_to(&mut w).unwrap();
        std::io::Write::flush(&mut w).unwrap();
        // swallow a handful of pre-copy frames, then die mid-migration
        for _ in 0..20 {
            let _ = Frame::read_from(&mut r);
        }
        // connection drops here
    });

    let log = Arc::new(Mutex::new(EmitLog::default()));
    let ((services, any), link) = make_instance_parts(log.clone());
    let mut inst = WeaveInstance::new_fresh(&engine, &module, services, any, link).unwrap();
    let res = migrate_running(
        &mut inst,
        "run",
        &[Val::I32(N)],
        &addr.to_string(),
        "wasmtime",
        SourceOptions {
            budget_bytes: 64 << 10,
            ..Default::default()
        },
    )
    .unwrap();
    saboteur.join().unwrap();

    match res {
        MigrateOutcome::FailedUnwound { error } => {
            println!("migration failed as intended: {error}");
            // Rollback: rewind locally and continue to completion.
            let out = inst.resume().unwrap();
            match out {
                WorkResult::Done(vals) => {
                    let h = match vals[0] {
                        Val::I64(h) => h,
                        _ => panic!("bad result"),
                    };
                    assert_eq!(h, golden_h, "post-rollback result differs");
                    assert_eq!(
                        log.lock().unwrap().entries,
                        golden_log.entries,
                        "post-rollback emit log not seamless"
                    );
                }
                WorkResult::Unwound => panic!("rollback resume unwound"),
            }
        }
        MigrateOutcome::FailedNotStarted { error } => {
            panic!("failure should have hit mid-flight, not at connect: {error}")
        }
        MigrateOutcome::CompletedLocally(_) => {
            panic!("workload should not have finished before the failure")
        }
        MigrateOutcome::Migrated(_) => panic!("migration should have failed"),
    }
}

#[test]
fn restore_target_starts_from_an_all_zero_memory_baseline() {
    let raw = wat::parse_str(
        r#"
        (module
          (memory (export "memory") 1)
          (data (i32.const 16) "active data must not survive restore setup")
          (func (export "run") (result i32) (i32.const 0)))
        "#,
    )
    .unwrap();
    let module = WeaveModule::from_raw(&raw, &Default::default()).unwrap();
    let engine = default_engine().unwrap();
    let link: weave_wasmtime::instance::LinkFn = Box::new(|_| Ok(()));

    let mut instance = WeaveInstance::new_restored(&engine, &module, vec![], vec![], link).unwrap();
    let memories = instance.mem_view().unwrap();

    let mut page = vec![1u8; weave_core::WASM_PAGE_SIZE];
    memories.read(0, 0, &mut page);
    assert!(
        page.iter().all(|byte| *byte == 0),
        "restore targets must erase active data segments before applying sparse pages"
    );
}
