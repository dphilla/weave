//! Public-API misuse and recovery with real transformed guests, not mocked VM calls.

use anyhow::{bail, Result};
use std::io::{BufReader, BufWriter, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;
use wasmtime::{Caller, Engine, Val};
use weave_core::{names, snapshot::Snapshot};
use weave_host::source::{SourceMigration, SourceOptions};
use weave_host::HostService;
use weave_wasmtime::instance::LinkFn;
use weave_wasmtime::migrate::{accept_conn, migrate_running, MigrateOutcome, TargetFactory};
use weave_wasmtime::{
    default_engine, InstanceState, Poller, WeaveInstance, WeaveModule, WorkResult,
};

const GUEST: &str = r#"(module
    (import "env" "tick" (func $tick))
    (memory 1)
    (func (export "run") (param $n i32) (result i32)
      (local $i i32)
      (loop $again
        (call $tick)
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br_if $again (i32.lt_u (local.get $i) (local.get $n))))
      (local.get $i))
    (func (export "trap") (call $tick) unreachable))"#;

fn module(wat: &str) -> WeaveModule {
    WeaveModule::from_raw(
        &wat::parse_str(wat).unwrap(),
        &weave_transform::TransformOptions {
            poll_period: 1,
            stack_pages: 1,
        },
    )
    .unwrap()
}

fn link(ticks: Arc<AtomicUsize>) -> LinkFn {
    Box::new(move |linker| {
        let ticks = ticks.clone();
        linker.func_wrap("env", "tick", move || {
            ticks.fetch_add(1, Ordering::SeqCst);
        })?;
        Ok(())
    })
}

fn instance(
    engine: &Engine,
    module: &WeaveModule,
    ticks: &Arc<AtomicUsize>,
    fresh: bool,
) -> WeaveInstance {
    let constructor = if fresh {
        WeaveInstance::new_fresh
    } else {
        WeaveInstance::new_restored
    };
    constructor(engine, module, vec![], vec![], link(ticks.clone())).unwrap()
}

fn done(result: WorkResult, expected: i32) {
    match result {
        WorkResult::Done(values) => {
            assert!(matches!(values.as_slice(), [Val::I32(n)] if *n == expected))
        }
        WorkResult::Unwound => panic!("expected completed entry"),
    }
}

fn paused(engine: &Engine, module: &WeaveModule, ticks: &Arc<AtomicUsize>) -> WeaveInstance {
    let mut inst = instance(engine, module, ticks, true);
    inst.set_poller(Poller::UnwindAfter(3));
    assert!(matches!(
        inst.call_entry("run", &[Val::I32(100)]).unwrap(),
        WorkResult::Unwound
    ));
    assert_eq!(inst.state(), InstanceState::Paused);
    inst
}

#[test]
fn fresh_and_completed_require_new_entry_not_resume_or_checkpoint() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    assert_eq!(inst.state(), InstanceState::Ready);
    assert!(inst.resume().unwrap_err().to_string().contains("Ready"));
    assert!(inst.checkpoint().is_err());
    assert_eq!(ticks.load(Ordering::SeqCst), 0);
    done(inst.call_entry("run", &[Val::I32(3)]).unwrap(), 3);
    assert_eq!(inst.state(), InstanceState::Completed);
    assert!(inst.resume().is_err());
    assert!(inst.checkpoint().is_err());
    done(inst.call_entry("run", &[Val::I32(7)]).unwrap(), 7);
    assert_eq!(ticks.load(Ordering::SeqCst), 10);
}

#[test]
fn invalid_entry_and_arguments_are_nonmutating_and_retryable() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    for (entry, args) in [
        ("missing", vec![]),
        (names::F_INIT, vec![]),
        (names::F_RESUME, vec![]),
        ("run", vec![]),
        ("run", vec![Val::I64(1)]),
        ("run", vec![Val::I32(1), Val::I32(2)]),
    ] {
        assert!(inst.call_entry(entry, &args).is_err());
        assert_eq!(inst.state(), InstanceState::Ready);
        assert_eq!(ticks.load(Ordering::SeqCst), 0);
    }
    done(inst.call_entry("run", &[Val::I32(4)]).unwrap(), 4);
}

#[test]
fn paused_entry_cannot_be_overwritten_and_rejections_preserve_snapshot() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = paused(&engine, &module, &ticks);
    let snapshot = inst.checkpoint().unwrap();
    let before = ticks.load(Ordering::SeqCst);
    assert!(inst.call_entry("run", &[Val::I32(2)]).is_err());
    assert!(inst.call_entry("trap", &[]).is_err());
    assert!(inst.restore(&snapshot).is_err());
    assert_eq!(inst.checkpoint().unwrap(), snapshot);
    assert_eq!(ticks.load(Ordering::SeqCst), before);
    inst.set_poller(Poller::Run);
    done(inst.resume().unwrap(), 100);
    assert_eq!(ticks.load(Ordering::SeqCst), 100);
}

#[test]
fn guest_control_flags_cannot_forge_a_paused_host_lifecycle() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    inst.set_global_i32(names::G_FLAG, names::FLAG_UNWOUND)
        .unwrap();
    inst.set_global_i32(names::G_STATE, names::STATE_UNWIND)
        .unwrap();
    assert!(inst.resume().is_err());
    assert!(inst.checkpoint().is_err());
    assert_eq!(ticks.load(Ordering::SeqCst), 0);
}

#[test]
fn restored_target_is_not_runnable_until_successfully_restored() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut source = paused(&engine, &module, &ticks);
    let snapshot = source.checkpoint().unwrap();
    let mut target = instance(&engine, &module, &ticks, false);
    assert_eq!(target.state(), InstanceState::RestoreTarget);
    assert!(target.call_entry("run", &[Val::I32(5)]).is_err());
    assert!(target.resume().is_err());
    assert!(target.checkpoint().is_err());
    target.restore(&snapshot).unwrap();
    assert_eq!(target.state(), InstanceState::Paused);
    assert_eq!(target.checkpoint().unwrap(), snapshot);
    assert!(target.restore(&snapshot).is_err());
    done(target.resume().unwrap(), 100);
    assert_eq!(ticks.load(Ordering::SeqCst), 100);
    assert!(target.restore(&snapshot).is_err());
    let mut fresh = instance(&engine, &module, &ticks, true);
    assert!(fresh.restore(&snapshot).is_err());
    assert_eq!(fresh.state(), InstanceState::Ready);
}

#[test]
fn malformed_snapshot_preflight_leaves_clean_target_retryable() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let snapshot = paused(&engine, &module, &ticks).checkpoint().unwrap();
    let mut bad = Vec::<Snapshot>::new();
    let mut s = snapshot.clone();
    s.module_hash[0] ^= 1;
    bad.push(s);
    let mut s = snapshot.clone();
    s.memories.clear();
    bad.push(s);
    let mut s = snapshot.clone();
    s.memories[0].pop();
    bad.push(s);
    let mut s = snapshot.clone();
    s.memories[0].clear();
    bad.push(s);
    let mut s = snapshot.clone();
    s.globals.reverse();
    bad.push(s);
    let mut s = snapshot.clone();
    s.services.push(("extra".into(), vec![]));
    bad.push(s);
    for (name, value) in [
        (names::G_FLAG, names::FLAG_DONE),
        (names::G_STATE, names::STATE_RUN),
        (names::G_ENTRY, -1),
        (names::G_ENTRY, i32::MAX),
    ] {
        let mut s = snapshot.clone();
        s.globals.iter_mut().find(|(n, _)| n == name).unwrap().1 = value;
        bad.push(s);
    }
    let mut target = instance(&engine, &module, &ticks, false);
    let clean_globals = target.capture_globals().unwrap();
    for s in bad {
        assert!(target.restore(&s).is_err());
        assert_eq!(target.state(), InstanceState::RestoreTarget);
        assert_eq!(target.capture_globals().unwrap(), clean_globals);
    }
    target.restore(&snapshot).unwrap();
    done(target.resume().unwrap(), 100);
}

#[test]
fn staged_low_level_writes_cannot_execute_or_restart_full_restore() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let snapshot = paused(&engine, &module, &ticks).checkpoint().unwrap();
    let mut target = instance(&engine, &module, &ticks, false);
    target.write_mem(0, 0, &[1, 2, 3]).unwrap();
    assert_eq!(target.state(), InstanceState::Restoring);
    assert!(target.restore(&snapshot).is_err());
    assert!(target.resume().is_err());
    assert!(target.call_entry("run", &[Val::I32(2)]).is_err());
    assert!(target.checkpoint().is_err());
}

struct Service {
    name: &'static str,
    restores: Arc<AtomicUsize>,
    fail: bool,
}
impl HostService for Service {
    fn name(&self) -> &str {
        self.name
    }
    fn snapshot(&self) -> Vec<u8> {
        vec![42]
    }
    fn restore(&mut self, _: &[u8]) -> Result<()> {
        self.restores.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            bail!("deliberate partial service restore")
        }
        Ok(())
    }
}

#[test]
fn partially_restored_services_poison_the_destination_permanently() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut snapshot = paused(&engine, &module, &ticks).checkpoint().unwrap();
    snapshot.services = vec![("a".into(), vec![42]), ("b".into(), vec![42])];
    let restores = Arc::new(AtomicUsize::new(0));
    let services = vec![
        Box::new(Service {
            name: "a",
            restores: restores.clone(),
            fail: false,
        }) as Box<dyn HostService>,
        Box::new(Service {
            name: "b",
            restores: restores.clone(),
            fail: true,
        }),
    ];
    let mut target =
        WeaveInstance::new_restored(&engine, &module, services, vec![], link(ticks)).unwrap();
    assert!(format!("{:#}", target.restore(&snapshot).unwrap_err()).contains("deliberate partial"));
    assert_eq!(restores.load(Ordering::SeqCst), 2);
    assert_eq!(target.state(), InstanceState::Failed);
    assert!(target.resume().is_err());
    assert!(target.call_entry("run", &[Val::I32(1)]).is_err());
    assert!(target.checkpoint().is_err());
    assert!(target.restore(&snapshot).is_err());
    assert!(target.restore_services(&snapshot.services).is_err());
    assert!(target.write_mem(0, 0, &[0]).is_err());
    assert_eq!(restores.load(Ordering::SeqCst), 2);
}

#[test]
fn caught_service_panic_still_poisoned_the_destination() {
    struct PanicService;
    impl HostService for PanicService {
        fn name(&self) -> &str {
            "panic"
        }
        fn snapshot(&self) -> Vec<u8> {
            vec![]
        }
        fn restore(&mut self, _: &[u8]) -> Result<()> {
            panic!("deliberate service panic")
        }
    }
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut snapshot = paused(&engine, &module, &ticks).checkpoint().unwrap();
    snapshot.services = vec![("panic".into(), vec![])];
    let mut target = WeaveInstance::new_restored(
        &engine,
        &module,
        vec![Box::new(PanicService)],
        vec![],
        link(ticks),
    )
    .unwrap();
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| target.restore(&snapshot)))
            .is_err()
    );
    assert_eq!(target.state(), InstanceState::Failed);
    assert!(target.restore(&snapshot).is_err());
    assert!(target.restore_services(&snapshot.services).is_err());
    assert!(target.resume().is_err());
}

#[test]
fn empty_or_duplicate_services_are_rejected_before_link_or_initialization() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    for names in [vec![""], vec!["duplicate", "duplicate"]] {
        let services: Vec<Box<dyn HostService>> = names
            .into_iter()
            .map(|name| {
                Box::new(Service {
                    name,
                    restores: Arc::new(AtomicUsize::new(0)),
                    fail: false,
                }) as Box<dyn HostService>
            })
            .collect();
        let linked = Arc::new(AtomicUsize::new(0));
        let probe = linked.clone();
        let result = WeaveInstance::new_fresh(
            &engine,
            &module,
            services,
            vec![],
            Box::new(move |_| {
                probe.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }),
        );
        assert!(result.is_err());
        assert_eq!(linked.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn trapped_guest_is_not_reusable_as_an_entry_or_restore_target() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    assert!(inst.call_entry("trap", &[]).is_err());
    assert_eq!(inst.state(), InstanceState::Failed);
    assert!(inst.resume().is_err());
    assert!(inst.call_entry("run", &[Val::I32(1)]).is_err());
    assert!(inst.checkpoint().is_err());
    assert_eq!(ticks.load(Ordering::SeqCst), 1);
}

#[test]
fn cross_thread_cancellation_pauses_and_consumes_request_without_losing_progress() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    let cancellation = inst.cancellation_handle();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let outcome = inst.call_entry("run", &[Val::I32(i32::MAX)]);
        tx.send((inst, outcome)).unwrap();
    });
    // No timing assumption about how much the guest executes before cancellation.
    cancellation.cancel();
    let (mut inst, result) = rx
        .recv_timeout(Duration::from_secs(5))
        .expect("cancelled guest did not yield");
    worker.join().unwrap();
    assert!(matches!(result.unwrap(), WorkResult::Unwound));
    assert_eq!(inst.state(), InstanceState::Paused);
    assert!(inst.checkpoint().is_ok());
    // Continue for a bounded poll count, proving the old cancellation was consumed.
    let before = ticks.load(Ordering::SeqCst);
    inst.set_poller(Poller::UnwindAfter(5));
    assert!(matches!(inst.resume().unwrap(), WorkResult::Unwound));
    assert!(ticks.load(Ordering::SeqCst) > before);
}

#[test]
fn repeated_cancellation_preserves_a_finite_workloads_exact_completion() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    let handle = inst.cancellation_handle();
    handle.cancel();
    assert!(matches!(
        inst.call_entry("run", &[Val::I32(100)]).unwrap(),
        WorkResult::Unwound
    ));
    inst.set_poller(Poller::UnwindAfter(5));
    assert!(matches!(inst.resume().unwrap(), WorkResult::Unwound));
    handle.cancel();
    inst.set_poller(Poller::Run);
    assert!(matches!(inst.resume().unwrap(), WorkResult::Unwound));
    done(inst.resume().unwrap(), 100);
    assert_eq!(ticks.load(Ordering::SeqCst), 100);
}

#[test]
fn cancelling_precopy_discards_target_and_preserves_source_resume() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let target_ticks = Arc::new(AtomicUsize::new(0));
    let target_probe = target_ticks.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut factory = TargetFactory {
            engine: default_engine().unwrap(),
            modules: Default::default(),
            make_services: Box::new(|| (vec![], vec![])),
            make_link: Box::new(move || link(target_probe.clone())),
        };
        assert!(accept_conn(conn, &mut factory).is_err());
    });
    let mut inst = instance(&engine, &module, &ticks, true);
    inst.cancellation_handle().cancel();
    let outcome = migrate_running(
        &mut inst,
        "run",
        &[Val::I32(100)],
        &address.to_string(),
        "cancel-probe",
        SourceOptions::default(),
    )
    .unwrap();
    assert!(
        matches!(outcome, MigrateOutcome::FailedUnwound { ref error } if error.contains("cancelled"))
    );
    target.join().unwrap();
    assert_eq!(target_ticks.load(Ordering::SeqCst), 0);
    assert_eq!(inst.state(), InstanceState::Paused);
    done(inst.resume().unwrap(), 100);
    assert_eq!(ticks.load(Ordering::SeqCst), 100);
}

#[test]
fn a_guest_trap_closes_its_staged_migration_without_dropping_the_instance() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (tx, rx) = mpsc::channel();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut factory = TargetFactory {
            engine: default_engine().unwrap(),
            modules: Default::default(),
            make_services: Box::new(|| (vec![], vec![])),
            make_link: Box::new(|| link(Arc::new(AtomicUsize::new(0)))),
        };
        tx.send(accept_conn(conn, &mut factory).is_err()).unwrap();
    });
    let mut inst = instance(&engine, &module, &ticks, true);
    assert!(migrate_running(
        &mut inst,
        "trap",
        &[],
        &address.to_string(),
        "trap-probe",
        SourceOptions::default()
    )
    .is_err());
    assert_eq!(inst.state(), InstanceState::Failed);
    assert!(rx
        .recv_timeout(Duration::from_secs(5))
        .expect("trapped source retained the staged target connection"));
    target.join().unwrap();
    assert!(matches!(inst.take_poller(), Poller::Run));
}

#[test]
fn malformed_but_checksum_verified_wire_state_is_rejected_before_prepared() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let target_ticks = Arc::new(AtomicUsize::new(0));
    let target_probe = target_ticks.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut factory = TargetFactory {
            engine: default_engine().unwrap(),
            modules: Default::default(),
            make_services: Box::new(|| (vec![], vec![])),
            make_link: Box::new(move || link(target_probe.clone())),
        };
        match accept_conn(conn, &mut factory) {
            Ok(_) => panic!("invalid suspended control state reached COMMIT"),
            Err(error) => assert!(format!("{error:#}").contains("suspended checkpoint")),
        }
    });
    let mut inst = paused(&engine, &module, &ticks);
    let mig = SourceMigration::connect(
        &address.to_string(),
        "invalid-state",
        &module.wasm,
        &module.meta.encode(),
        module.meta.memories.len(),
        SourceOptions::default(),
    )
    .unwrap();
    inst.set_poller(Poller::Migrating {
        mig: Box::new(mig),
        mem_names: module.meta.memories.clone(),
    });
    let Poller::Migrating { mig, .. } = inst.take_poller() else {
        unreachable!()
    };
    let mut globals = inst.capture_globals().unwrap();
    globals
        .iter_mut()
        .find(|(name, _)| name == names::G_FLAG)
        .unwrap()
        .1 = names::FLAG_DONE;
    let error = mig
        .finish(&inst.mem_view().unwrap(), globals, vec![])
        .unwrap_err();
    assert!(format!("{error:#}").contains("suspended checkpoint"));
    target.join().unwrap();
    assert_eq!(target_ticks.load(Ordering::SeqCst), 0);
    assert_eq!(inst.state(), InstanceState::Paused);
    done(inst.resume().unwrap(), 100);
}

#[test]
fn initialization_cannot_be_unwound_by_a_start_host_import() {
    let engine = default_engine().unwrap();
    let module = module(
        r#"(module
      (import "env" "arm" (func $arm))
      (import "env" "tick" (func $tick))
      (memory 1)
      (func $start (local $i i32)
        call $arm
        (loop $l call $tick
          (local.set $i (i32.add (local.get $i) (i32.const 1)))
          (br_if $l (i32.lt_u (local.get $i) (i32.const 5)))))
      (start $start)
      (func (export "run") (result i32) i32.const 7))"#,
    );
    let ticks = Arc::new(AtomicUsize::new(0));
    let probe = ticks.clone();
    let mut inst = WeaveInstance::new_fresh(
        &engine,
        &module,
        vec![],
        vec![],
        Box::new(move |linker| {
            linker.func_wrap(
                "env",
                "arm",
                |mut caller: Caller<'_, weave_wasmtime::Ctx>| {
                    caller.data_mut().poller = Poller::UnwindNext;
                },
            )?;
            let probe = probe.clone();
            linker.func_wrap("env", "tick", move || {
                probe.fetch_add(1, Ordering::SeqCst);
            })?;
            Ok(())
        }),
    )
    .unwrap();
    assert_eq!(ticks.load(Ordering::SeqCst), 5);
    assert_eq!(inst.state(), InstanceState::Ready);
    assert!(matches!(inst.take_poller(), Poller::UnwindNext));
    done(inst.call_entry("run", &[]).unwrap(), 7);
}

#[test]
fn confirmed_and_uncertain_handoffs_retire_high_and_low_level_sources() {
    use weave_core::wire::{Frame, PROTO_VERSION, ROLE_TARGET};
    for direct in [false, true] {
        for confirmed in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = listener.local_addr().unwrap();
            let target = std::thread::spawn(move || {
                let (conn, _) = listener.accept().unwrap();
                conn.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut r = BufReader::new(conn.try_clone().unwrap());
                let mut w = BufWriter::new(conn);
                assert!(matches!(
                    Frame::read_from(&mut r).unwrap(),
                    Frame::Hello { .. }
                ));
                Frame::Hello {
                    proto: PROTO_VERSION,
                    role: ROLE_TARGET,
                    runtime: "lifecycle-probe".into(),
                }
                .write_to(&mut w)
                .unwrap();
                w.flush().unwrap();
                assert!(matches!(
                    Frame::read_from(&mut r).unwrap(),
                    Frame::ModuleMeta { .. }
                ));
                Frame::ModuleHave.write_to(&mut w).unwrap();
                Frame::ModuleOk.write_to(&mut w).unwrap();
                w.flush().unwrap();
                loop {
                    match Frame::read_from(&mut r).unwrap() {
                        Frame::RoundEnd { .. } => {
                            Frame::RoundAck.write_to(&mut w).unwrap();
                            w.flush().unwrap();
                        }
                        Frame::FinalEnd { .. } => break,
                        _ => {}
                    }
                }
                Frame::Prepared.write_to(&mut w).unwrap();
                w.flush().unwrap();
                assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::Commit);
                if confirmed {
                    Frame::CommitOk.write_to(&mut w).unwrap();
                    w.flush().unwrap();
                }
            });
            let engine = default_engine().unwrap();
            let module = module(GUEST);
            let ticks = Arc::new(AtomicUsize::new(0));
            let mut inst = instance(&engine, &module, &ticks, true);
            let options = SourceOptions {
                max_rounds: 1,
                dirty_page_threshold: u64::MAX,
                ..Default::default()
            };
            let stats = if direct {
                let mig = SourceMigration::connect(
                    &addr.to_string(),
                    "probe",
                    &module.wasm,
                    &module.meta.encode(),
                    module.meta.memories.len(),
                    options,
                )
                .unwrap();
                inst.set_poller(Poller::Migrating {
                    mig: Box::new(mig),
                    mem_names: module.meta.memories.clone(),
                });
                assert!(matches!(
                    inst.call_entry("run", &[Val::I32(100)]).unwrap(),
                    WorkResult::Unwound
                ));
                let Poller::Migrating { mig, .. } = inst.take_poller() else {
                    panic!("missing migration")
                };
                let globals = inst.capture_globals().unwrap();
                let services = inst.snapshot_services();
                mig.finish(&inst.mem_view().unwrap(), globals, services)
                    .unwrap()
            } else {
                let MigrateOutcome::Migrated(stats) = migrate_running(
                    &mut inst,
                    "run",
                    &[Val::I32(100)],
                    &addr.to_string(),
                    "probe",
                    options,
                )
                .unwrap() else {
                    panic!("expected migration")
                };
                stats
            };
            target.join().unwrap();
            assert_eq!(stats.commit_confirmed, confirmed);
            assert_eq!(inst.state(), InstanceState::Retired);
            let before = ticks.load(Ordering::SeqCst);
            inst.set_poller(Poller::Run);
            assert!(inst.resume().is_err());
            assert!(inst.call_entry("run", &[Val::I32(2)]).is_err());
            assert!(inst.checkpoint().is_err());
            assert!(inst.write_mem(0, 0, &[0]).is_err());
            assert_eq!(ticks.load(Ordering::SeqCst), before);
        }
    }
}

#[test]
fn migration_rejects_invalid_lifecycle_and_arguments_before_network_connect() {
    let engine = default_engine().unwrap();
    let module = module(GUEST);
    let ticks = Arc::new(AtomicUsize::new(0));
    let mut inst = instance(&engine, &module, &ticks, true);
    assert!(migrate_running(
        &mut inst,
        "run",
        &[],
        "not a socket address",
        "probe",
        SourceOptions::default()
    )
    .is_err());
    let mut inst = paused(&engine, &module, &ticks);
    assert!(migrate_running(
        &mut inst,
        "run",
        &[Val::I32(1)],
        "not a socket address",
        "probe",
        SourceOptions::default()
    )
    .is_err());
    inst.set_poller(Poller::Run);
    done(inst.resume().unwrap(), 100);
}
