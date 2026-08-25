use anyhow::Result;
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use wasmtime::{Linker, Val};
use weave_core::wire::{Frame, PROTO_VERSION, ROLE_SOURCE};
use weave_host::source::SourceOptions;
use weave_host::HostService;
use weave_transform::TransformOptions;
use weave_wasmtime::migrate::{accept_conn, migrate_running, MigrateOutcome, TargetFactory};
use weave_wasmtime::{default_engine, WeaveInstance, WeaveModule, WorkResult};

struct SourceOnlyService;

struct RestoreProbe(Arc<AtomicBool>);

impl HostService for SourceOnlyService {
    fn name(&self) -> &str {
        "source.only"
    }
    fn snapshot(&self) -> Vec<u8> {
        vec![4, 2]
    }
    fn restore(&mut self, _: &[u8]) -> Result<()> {
        Ok(())
    }
}

impl HostService for RestoreProbe {
    fn name(&self) -> &str {
        "restore.probe"
    }
    fn snapshot(&self) -> Vec<u8> {
        vec![]
    }
    fn restore(&mut self, _: &[u8]) -> Result<()> {
        self.0.store(true, Ordering::SeqCst);
        Ok(())
    }
}

fn cached_handshake(
    conn: TcpStream,
    module: &WeaveModule,
) -> (BufReader<TcpStream>, BufWriter<TcpStream>) {
    let mut r = BufReader::new(conn.try_clone().unwrap());
    let mut w = BufWriter::new(conn);
    Frame::Hello {
        proto: PROTO_VERSION,
        role: ROLE_SOURCE,
        runtime: "audit".into(),
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert!(matches!(
        Frame::read_from(&mut r).unwrap(),
        Frame::Hello { .. }
    ));
    Frame::ModuleMeta {
        module_hash: module.module_hash,
        size: module.wasm.len() as u64,
        meta: module.meta.encode(),
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::ModuleHave);
    assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::ModuleOk);
    (r, w)
}

#[test]
fn full_migration_rejects_different_service_sets_and_rolls_back() {
    let raw = wat::parse_str(
        r#"
        (module
          (memory 1)
          (func (export "run") (param $n i32) (result i32)
            (local $i i32)
            (loop $again
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $again (i32.lt_u (local.get $i) (local.get $n))))
            (local.get $i)))
    "#,
    )
    .unwrap();
    let module = WeaveModule::from_raw(
        &raw,
        &TransformOptions {
            poll_period: 1,
            stack_pages: 1,
        },
    )
    .unwrap();
    let source_engine = default_engine().unwrap();
    let target_engine = default_engine().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut factory = TargetFactory {
            engine: target_engine,
            modules: Default::default(),
            make_services: Box::new(|| (vec![], vec![])),
            make_link: Box::new(|| Box::new(|_: &mut Linker<_>| Ok(()))),
        };
        match accept_conn(conn, &mut factory) {
            Ok(_) => panic!("target accepted a mismatched service set"),
            Err(error) => format!("{error:#}"),
        }
    });

    let mut source = WeaveInstance::new_fresh(
        &source_engine,
        &module,
        vec![Box::new(SourceOnlyService)],
        vec![],
        Box::new(|_: &mut Linker<_>| Ok(())),
    )
    .unwrap();
    let outcome = migrate_running(
        &mut source,
        "run",
        &[Val::I32(10_000)],
        &addr.to_string(),
        "audit",
        SourceOptions {
            budget_bytes: 1 << 20,
            dirty_page_threshold: u64::MAX,
            max_rounds: 1,
        },
    )
    .unwrap();
    match outcome {
        MigrateOutcome::FailedUnwound { error } => {
            assert!(error.contains("host-service contract mismatch"), "{error}");
        }
        _ => panic!("service mismatch must reject migration after unwind"),
    }
    assert!(target
        .join()
        .unwrap()
        .contains("host-service contract mismatch"));
    match source.resume().unwrap() {
        WorkResult::Done(v) => match v[0] {
            Val::I32(x) => assert_eq!(x, 10_000),
            _ => unreachable!(),
        },
        WorkResult::Unwound => panic!("rollback unexpectedly unwound again"),
    }
}

#[test]
fn target_rejects_wrong_control_global_list() {
    let raw = wat::parse_str("(module (memory 1) (func (export \"run\")))").unwrap();
    let module = WeaveModule::from_raw(
        &raw,
        &TransformOptions {
            poll_period: 1,
            stack_pages: 1,
        },
    )
    .unwrap();
    let target_module = module.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut modules = std::collections::HashMap::new();
        modules.insert(target_module.module_hash, target_module);
        let mut factory = TargetFactory {
            engine: default_engine().unwrap(),
            modules,
            make_services: Box::new(|| (vec![], vec![])),
            make_link: Box::new(|| Box::new(|_: &mut Linker<_>| Ok(()))),
        };
        accept_conn(conn, &mut factory).map(|_| ())
    });

    let conn = TcpStream::connect(addr).unwrap();
    let (mut r, mut w) = cached_handshake(conn, &module);
    Frame::FinalBegin.write_to(&mut w).unwrap();
    Frame::Globals {
        globals: vec![("__weave_not_a_control_global".into(), 0)],
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert!(matches!(
        Frame::read_from(&mut r).unwrap(),
        Frame::Abort { code: 5, .. }
    ));
    assert!(target.join().unwrap().is_err());
}

#[test]
fn target_does_not_restore_services_before_hash_verification() {
    let raw = wat::parse_str("(module (memory 1) (func (export \"run\")))").unwrap();
    let module = WeaveModule::from_raw(
        &raw,
        &TransformOptions {
            poll_period: 1,
            stack_pages: 1,
        },
    )
    .unwrap();
    let target_module = module.clone();
    let restored = Arc::new(AtomicBool::new(false));
    let target_restored = restored.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut modules = std::collections::HashMap::new();
        modules.insert(target_module.module_hash, target_module);
        let mut factory = TargetFactory {
            engine: default_engine().unwrap(),
            modules,
            make_services: Box::new(move || {
                (
                    vec![Box::new(RestoreProbe(target_restored.clone()))],
                    vec![],
                )
            }),
            make_link: Box::new(|| Box::new(|_: &mut Linker<_>| Ok(()))),
        };
        accept_conn(conn, &mut factory).map(|_| ())
    });

    let conn = TcpStream::connect(addr).unwrap();
    let (mut r, mut w) = cached_handshake(conn, &module);
    let globals = module
        .meta
        .control_globals
        .iter()
        .map(|name| (name.clone(), 0))
        .collect();
    Frame::FinalBegin.write_to(&mut w).unwrap();
    Frame::Globals { globals }.write_to(&mut w).unwrap();
    Frame::Services {
        services: vec![("restore.probe".into(), vec![1, 2, 3])],
    }
    .write_to(&mut w)
    .unwrap();
    Frame::FinalEnd {
        state_hash: [0xff; 32],
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert!(matches!(
        Frame::read_from(&mut r).unwrap(),
        Frame::Abort { code: 4, .. }
    ));
    assert!(target.join().unwrap().is_err());
    assert!(!restored.load(Ordering::SeqCst));
}
