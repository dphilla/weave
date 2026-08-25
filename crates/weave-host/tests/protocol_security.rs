//! Regression coverage for migration protocol validation and deadlines.

use anyhow::Result;
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};
use weave_core::snapshot::StateHasher;
use weave_core::wire::{Frame, PROTO_VERSION, ROLE_SOURCE, ROLE_TARGET};
use weave_core::{Meta, WEAVE_VERSION};
use weave_host::source::{SourceMigration, SourceOptions};
use weave_host::target::{run_target_session, TargetHost};
use weave_host::MemRead;

struct EmptyMems;

impl MemRead for EmptyMems {
    fn n_mems(&self) -> usize {
        0
    }
    fn size(&self, _: usize) -> usize {
        unreachable!()
    }
    fn read(&self, _: usize, _: usize, _: &mut [u8]) {
        unreachable!()
    }
}

struct MismatchHost {
    restored_wire_blobs: Vec<(String, Vec<u8>)>,
    known_service_was_restored: bool,
    resume_called: bool,
    mems: EmptyMems,
}

impl TargetHost for MismatchHost {
    fn has_module(&mut self, _: &[u8; 32]) -> bool {
        true
    }
    fn store_module(&mut self, _: &[u8; 32], _: Vec<u8>) -> Result<()> {
        unreachable!()
    }
    fn instantiate(&mut self, _: &[u8; 32], _: &Meta) -> Result<()> {
        Ok(())
    }
    fn set_mem_pages(&mut self, _: usize, _: u64) -> Result<()> {
        Ok(())
    }
    fn write_mem(&mut self, _: usize, _: usize, _: &[u8]) -> Result<()> {
        Ok(())
    }
    fn set_global(&mut self, _: &str, _: i32) -> Result<()> {
        Ok(())
    }
    fn restore_services(&mut self, services: &[(String, Vec<u8>)]) -> Result<()> {
        self.restored_wire_blobs = services.to_vec();
        self.known_service_was_restored = services.iter().any(|(name, _)| name == "known");
        Ok(())
    }
    fn with_mems(&mut self, visit: &mut dyn FnMut(&dyn MemRead) -> Result<()>) -> Result<()> {
        visit(&self.mems)
    }
}

fn empty_meta() -> Meta {
    Meta {
        version: WEAVE_VERSION,
        poll_period: 512,
        entries: vec![],
        memories: vec![],
        imports: vec![],
        control_globals: vec![],
        globals_area_size: 0,
        results_area_size: 0,
    }
}

fn empty_host() -> MismatchHost {
    MismatchHost {
        restored_wire_blobs: vec![],
        known_service_was_restored: false,
        resume_called: false,
        mems: EmptyMems,
    }
}

#[test]
fn protocol_v1_peer_is_rejected_before_module_transfer() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut host = empty_host();
        run_target_session(conn, &mut host)
    });

    let conn = TcpStream::connect(addr).unwrap();
    let mut r = BufReader::new(conn.try_clone().unwrap());
    let mut w = BufWriter::new(conn);
    Frame::Hello {
        proto: 1,
        role: ROLE_SOURCE,
        runtime: "old-peer".into(),
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert!(matches!(
        Frame::read_from(&mut r).unwrap(),
        Frame::Abort { .. }
    ));
    assert!(target.join().unwrap().is_err());
}

#[test]
fn target_rejects_unknown_service_blob_before_any_restore() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let target = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut host = empty_host();
        let received = run_target_session(conn, &mut host);
        (received, host)
    });

    let conn = TcpStream::connect(addr).unwrap();
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
        module_hash: [7; 32],
        size: 0,
        meta: empty_meta().encode(),
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();
    assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::ModuleHave);
    assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::ModuleOk);

    let wire_services = vec![("unknown".to_string(), vec![1, 2, 3])];
    Frame::FinalBegin.write_to(&mut w).unwrap();
    Frame::Globals { globals: vec![] }.write_to(&mut w).unwrap();
    Frame::Services {
        services: wire_services.clone(),
    }
    .write_to(&mut w)
    .unwrap();
    let mut h = StateHasher::new(0);
    h.globals(&[]);
    h.services(&wire_services);
    Frame::FinalEnd {
        state_hash: h.finish(),
    }
    .write_to(&mut w)
    .unwrap();
    w.flush().unwrap();

    assert!(matches!(
        Frame::read_from(&mut r).unwrap(),
        Frame::Abort { .. }
    ));
    let (received, host) = target.join().unwrap();
    assert!(received.is_err());
    assert!(host.restored_wire_blobs.is_empty());
    assert!(!host.known_service_was_restored);
    assert!(
        !host.resume_called,
        "target protocol has no resume/commit hook before ACK"
    );
}

#[test]
fn source_handshake_reports_a_peer_that_stalls_then_disconnects() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let peer = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut r = BufReader::new(conn);
        let _ = Frame::read_from(&mut r).unwrap();
        std::thread::sleep(Duration::from_millis(400));
    });

    let started = Instant::now();
    let result = SourceMigration::connect(
        &addr.to_string(),
        "audit",
        &[],
        &empty_meta().encode(),
        0,
        SourceOptions::default(),
    );
    let elapsed = started.elapsed();
    assert!(result.is_err());
    assert!(
        elapsed >= Duration::from_millis(350),
        "source returned before the test peer disconnected"
    );
    assert!(elapsed < Duration::from_secs(2));
    peer.join().unwrap();
}

#[test]
fn source_retires_after_prepared_when_commit_confirmation_is_lost() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let peer = std::thread::spawn(move || {
        let (conn, _) = listener.accept().unwrap();
        let mut r = BufReader::new(conn.try_clone().unwrap());
        let mut w = BufWriter::new(conn);

        assert!(matches!(
            Frame::read_from(&mut r).unwrap(),
            Frame::Hello {
                proto: PROTO_VERSION,
                role: ROLE_SOURCE,
                ..
            }
        ));
        Frame::Hello {
            proto: PROTO_VERSION,
            role: ROLE_TARGET,
            runtime: "drop-commit-ok".into(),
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

        assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::FinalBegin);
        assert!(matches!(
            Frame::read_from(&mut r).unwrap(),
            Frame::Globals { .. }
        ));
        assert!(matches!(
            Frame::read_from(&mut r).unwrap(),
            Frame::Services { .. }
        ));
        assert!(matches!(
            Frame::read_from(&mut r).unwrap(),
            Frame::FinalEnd { .. }
        ));
        Frame::Prepared.write_to(&mut w).unwrap();
        w.flush().unwrap();
        assert_eq!(Frame::read_from(&mut r).unwrap(), Frame::Commit);
        // Drop without COMMIT_OK. The source must report an irreversible,
        // unconfirmed commit instead of returning a rollback-safe error.
    });

    let migration = SourceMigration::connect(
        &addr.to_string(),
        "audit",
        &[],
        &empty_meta().encode(),
        0,
        SourceOptions::default(),
    )
    .unwrap();
    let stats = migration.finish(&EmptyMems, vec![], vec![]).unwrap();
    assert!(!stats.commit_confirmed);
    assert!(stats.commit_error.is_some());
    peer.join().unwrap();
}
