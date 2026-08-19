use anyhow::Result;
use std::net::TcpListener;
use weave_host::source::SourceOptions;
use weave_host::HostService;
use weave_transform::TransformOptions;
use weave_wasmtime::migrate::{accept_conn, migrate_running, MigrateOutcome, TargetFactory};
use weave_wasmtime::{default_engine, WeaveInstance, WeaveModule, WorkResult};
use wasmtime::{Linker, Val};

struct SourceOnlyService;

impl HostService for SourceOnlyService {
    fn name(&self) -> &str { "source.only" }
    fn snapshot(&self) -> Vec<u8> { vec![4, 2] }
    fn restore(&mut self, _: &[u8]) -> Result<()> { Ok(()) }
}

#[test]
fn full_migration_accepts_different_service_sets() {
    let raw = wat::parse_str(r#"
        (module
          (memory 1)
          (func (export "run") (param $n i32) (result i32)
            (local $i i32)
            (loop $again
              (local.set $i (i32.add (local.get $i) (i32.const 1)))
              (br_if $again (i32.lt_u (local.get $i) (local.get $n))))
            (local.get $i)))
    "#).unwrap();
    let module = WeaveModule::from_raw(
        &raw,
        &TransformOptions { poll_period: 1, stack_pages: 1 },
    ).unwrap();
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
        let mut inst = accept_conn(conn, &mut factory).unwrap();
        match inst.resume().unwrap() {
            WorkResult::Done(v) => match v[0] { Val::I32(x) => x, _ => unreachable!() },
            WorkResult::Unwound => panic!("unexpected second unwind"),
        }
    });

    let mut source = WeaveInstance::new_fresh(
        &source_engine,
        &module,
        vec![Box::new(SourceOnlyService)],
        vec![],
        Box::new(|_: &mut Linker<_>| Ok(())),
    ).unwrap();
    let outcome = migrate_running(
        &mut source,
        "run",
        &[Val::I32(10_000)],
        &addr.to_string(),
        "audit",
        SourceOptions { budget_bytes: 1 << 20, dirty_page_threshold: u64::MAX, max_rounds: 1 },
    ).unwrap();
    assert!(matches!(outcome, MigrateOutcome::Migrated(_)));
    assert_eq!(target.join().unwrap(), 10_000);
}
