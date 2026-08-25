//! A Weave *node*: one process that runs a workload, accepts control
//! commands, migrates its workload out on request, and receives workloads
//! migrated in — the symmetric peer-to-peer unit. A node that received a
//! workload can later migrate it onward (A → B → C chains).

use crate::instance::{LinkFn, WeaveInstance, WorkResult};
use crate::migrate::{accept_conn, TargetFactory};
use crate::poll::Poller;
use crate::WeaveModule;
use anyhow::{Context, Result};
use std::any::Any;
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use wasmtime::{Engine, Val};
use weave_core::wire::Frame;
use weave_host::source::SourceOptions;
use weave_host::HostService;

/// Cross-thread migration control, checked by `weave.poll` while running.
pub struct Shared {
    request: Option<MigrationRequest>,
    /// Human-readable status for CTL_STATUS / CTL_MIGRATE replies.
    pub last_result: Option<String>,
    active: bool,
    incoming_reserved: bool,
}

struct MigrationRequest {
    target: String,
    result: mpsc::Sender<String>,
}

impl Shared {
    fn new(active: bool) -> Self {
        Self {
            request: None,
            last_result: None,
            active,
            incoming_reserved: false,
        }
    }

    pub(crate) fn requested_target(&self) -> Option<String> {
        self.request.as_ref().map(|request| request.target.clone())
    }

    pub(crate) fn complete_request(&mut self, result: String) {
        self.last_result = Some(result.clone());
        if let Some(request) = self.request.take() {
            let _ = request.result.send(result);
        }
    }

    fn status(&self) -> String {
        self.last_result.clone().unwrap_or_else(|| {
            if self.active {
                "running".into()
            } else if self.incoming_reserved {
                "accepting".into()
            } else {
                "idle".into()
            }
        })
    }
}

pub struct NodeConfig {
    pub listen: String,
    pub runtime_name: String,
    pub source_opts: SourceOptions,
    /// Exit the serve loop when a workload completes.
    pub exit_on_done: bool,
}

/// Factories the node uses to build service sets for fresh or received
/// instances (both peers must register the same service names).
pub struct NodeFactories<'a> {
    pub make_services:
        Box<dyn FnMut() -> (Vec<Box<dyn HostService>>, Vec<Box<dyn Any + Send>>) + 'a>,
    pub make_link: Box<dyn FnMut() -> LinkFn + 'a>,
}

enum NodeEvent {
    Incoming(TcpStream),
}

pub struct InitialWork {
    pub module: WeaveModule,
    pub entry: String,
    pub args: Vec<Val>,
}

pub fn serve(
    engine: &Engine,
    config: NodeConfig,
    mut factories: NodeFactories<'_>,
    initial: Option<InitialWork>,
) -> Result<()> {
    let listener =
        TcpListener::bind(&config.listen).with_context(|| format!("binding {}", config.listen))?;
    eprintln!("weave: listening on {}", listener.local_addr()?);
    let shared = Arc::new(Mutex::new(Shared::new(initial.is_some())));
    let (tx, rx) = mpsc::channel::<NodeEvent>();

    // Control / ingress listener thread. CTL frames are handled here; data
    // (migration) connections are handed to the main loop.
    {
        let shared = shared.clone();
        let tx = tx.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let shared = shared.clone();
                let tx = tx.clone();
                std::thread::spawn(move || {
                    let _ = handle_conn(conn, shared, tx);
                });
            }
        });
    }

    // Main loop: run the current workload; when idle, wait for a migration.
    let mut current: Option<(WeaveInstance, RunPhase)> = initial.map(|w| {
        let (services, any) = (factories.make_services)();
        let link = (factories.make_link)();
        let inst = WeaveInstance::new_fresh(engine, &w.module, services, any, link)
            .expect("instantiating initial workload");
        (
            inst,
            RunPhase::Start {
                entry: w.entry,
                args: w.args,
            },
        )
    });

    loop {
        match current.take() {
            None => {
                eprintln!("weave: idle, waiting for workload");
                match rx.recv() {
                    Ok(NodeEvent::Incoming(conn)) => {
                        let mut factory = TargetFactory {
                            engine: engine.clone(),
                            modules: Default::default(),
                            make_services: Box::new(&mut *factories.make_services),
                            make_link: Box::new(&mut *factories.make_link),
                        };
                        match accept_conn(conn, &mut factory) {
                            Ok(inst) => {
                                {
                                    let mut sh = shared.lock().unwrap();
                                    sh.incoming_reserved = false;
                                    sh.active = true;
                                    sh.last_result = None;
                                }
                                eprintln!("weave: workload received, resuming");
                                current = Some((inst, RunPhase::Resume));
                            }
                            Err(e) => {
                                let mut sh = shared.lock().unwrap();
                                sh.incoming_reserved = false;
                                eprintln!("weave: incoming migration failed: {e:#}");
                            }
                        }
                    }
                    Err(_) => return Ok(()),
                }
            }
            Some((mut inst, phase)) => {
                inst.attach_shared(shared.clone(), config.source_opts.clone());
                let outcome = match &phase {
                    RunPhase::Start { entry, args } => {
                        eprintln!("weave: starting workload");
                        inst.call_entry(entry, args)
                    }
                    RunPhase::Resume => inst.resume(),
                };
                match outcome {
                    Ok(WorkResult::Done(vals)) => {
                        if let Poller::Migrating { mig, .. } = inst.take_poller() {
                            mig.abort(10, "workload completed before checkpoint");
                        }
                        let rendered: Vec<String> = vals
                            .iter()
                            .map(|v| match v {
                                Val::I32(x) => x.to_string(),
                                Val::I64(x) => x.to_string(),
                                Val::F32(b) => f32::from_bits(*b).to_string(),
                                Val::F64(b) => f64::from_bits(*b).to_string(),
                                other => format!("{other:?}"),
                            })
                            .collect();
                        let msg = format!("done: [{}]", rendered.join(", "));
                        println!("WEAVE_DONE [{}]", rendered.join(", "));
                        let mut sh = shared.lock().unwrap();
                        sh.active = false;
                        sh.complete_request(msg);
                        drop(sh);
                        if config.exit_on_done {
                            // A just-received workload may complete before the
                            // detached COMMIT_OK writer is scheduled.
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            return Ok(());
                        }
                    }
                    Ok(WorkResult::Unwound) => {
                        // A migration (or an error during one) unwound us.
                        match inst.take_poller() {
                            Poller::Migrating { mig, .. } => {
                                let globals = inst.capture_globals()?;
                                let services = inst.snapshot_services();
                                let mems = inst.mem_view()?;
                                match mig.finish(&mems, globals, services) {
                                    Ok(stats) => {
                                        let summary = format!(
                                            "{} rounds, {} pages total, {} in pause window",
                                            stats.rounds, stats.total_pages, stats.final_pages
                                        );
                                        let msg = if stats.commit_confirmed {
                                            format!("migrated: {summary}")
                                        } else {
                                            if let Some(error) = &stats.commit_error {
                                                eprintln!("weave: {error}");
                                            }
                                            format!(
                                                "commit uncertain: {summary}; COMMIT_OK unconfirmed (source retired)"
                                            )
                                        };
                                        eprintln!("weave: {msg}");
                                        println!(
                                            "{}",
                                            if stats.commit_confirmed {
                                                "WEAVE_MIGRATED"
                                            } else {
                                                "WEAVE_MIGRATED_UNCONFIRMED"
                                            }
                                        );
                                        let mut sh = shared.lock().unwrap();
                                        sh.active = false;
                                        sh.complete_request(msg);
                                        drop(sh);
                                        // instance retired
                                        if config.exit_on_done {
                                            // give the ctl reply loop a beat
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                100,
                                            ));
                                            return Ok(());
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!(
                                            "weave: final copy failed ({e:#}), resuming locally"
                                        );
                                        let mut sh = shared.lock().unwrap();
                                        sh.complete_request(format!("migration failed: {e:#}"));
                                        drop(sh);
                                        current = Some((inst, RunPhase::Resume));
                                    }
                                }
                            }
                            Poller::Errored(e) => {
                                eprintln!("weave: migration errored ({e}), resuming locally");
                                let mut sh = shared.lock().unwrap();
                                sh.complete_request(format!("migration failed: {e}"));
                                drop(sh);
                                current = Some((inst, RunPhase::Resume));
                            }
                            _ => {
                                anyhow::bail!("workload unwound outside a migration");
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("weave: workload trapped: {e:#}");
                        println!("WEAVE_TRAP {e:#}");
                        let mut sh = shared.lock().unwrap();
                        sh.active = false;
                        sh.complete_request(format!("trap: {e:#}"));
                        drop(sh);
                        if config.exit_on_done {
                            std::thread::sleep(std::time::Duration::from_millis(100));
                            return Err(e);
                        }
                    }
                }
            }
        }
    }
}

enum RunPhase {
    Start { entry: String, args: Vec<Val> },
    Resume,
}

/// Classify and handle one inbound connection. The first byte of the first
/// frame (peeked, not consumed) distinguishes a migration source (HELLO) from
/// a control client (CTL_*).
fn handle_conn(
    conn: TcpStream,
    shared: Arc<Mutex<Shared>>,
    tx: mpsc::Sender<NodeEvent>,
) -> Result<()> {
    conn.set_nodelay(true).ok();
    conn.set_read_timeout(Some(std::time::Duration::from_secs(30)))
        .context("setting connection classification timeout")?;
    let mut first_byte = [0u8; 1];
    if conn.peek(&mut first_byte)? == 0 {
        return Ok(());
    }
    if first_byte[0] == 1 {
        // HELLO: reserve the idle node before handing the pristine connection
        // over. This keeps ingress bounded to one session and lets a busy
        // source fail immediately instead of hanging in its poll callback.
        {
            let mut sh = shared.lock().unwrap();
            if sh.active || sh.incoming_reserved {
                drop(sh);
                let mut w = BufWriter::new(conn);
                Frame::Abort {
                    code: 9,
                    msg: "node busy".into(),
                }
                .write_to(&mut w)?;
                w.flush()?;
                return Ok(());
            }
            sh.incoming_reserved = true;
            sh.last_result = None;
        }
        if tx.send(NodeEvent::Incoming(conn)).is_err() {
            shared.lock().unwrap().incoming_reserved = false;
        }
        return Ok(());
    }
    let mut r = BufReader::new(conn.try_clone()?);
    let first = Frame::read_from(&mut r)?;
    match first {
        Frame::CtlMigrate { target } => {
            let mut w = BufWriter::new(conn);
            if target.trim().is_empty() {
                Frame::CtlErr {
                    msg: "migration target must not be empty".into(),
                }
                .write_to(&mut w)?;
                w.flush()?;
                return Ok(());
            }
            let (result_tx, result_rx) = mpsc::channel();
            {
                let mut sh = shared.lock().unwrap();
                let rejection = if !sh.active {
                    Some("node has no active workload")
                } else if sh.request.is_some() {
                    Some("migration already in progress")
                } else {
                    None
                };
                if let Some(msg) = rejection {
                    drop(sh);
                    Frame::CtlErr { msg: msg.into() }.write_to(&mut w)?;
                    w.flush()?;
                    return Ok(());
                }
                sh.request = Some(MigrationRequest {
                    target,
                    result: result_tx,
                });
                sh.last_result = None;
            }
            let res = match result_rx.recv_timeout(std::time::Duration::from_secs(120)) {
                Ok(result) => result,
                Err(_) => "timeout waiting for migration result".into(),
            };
            let frame = if res.starts_with("migrated") || res.starts_with("done") {
                Frame::CtlOk { msg: res }
            } else {
                Frame::CtlErr { msg: res }
            };
            frame.write_to(&mut w)?;
            w.flush()?;
            Ok(())
        }
        Frame::CtlStatus => {
            let mut w = BufWriter::new(conn);
            let msg = shared.lock().unwrap().status();
            Frame::CtlOk { msg }.write_to(&mut w)?;
            w.flush()?;
            Ok(())
        }
        other => anyhow::bail!("unexpected first frame {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn tcp_pair() -> (TcpStream, TcpStream) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();
        (server, client)
    }

    fn send_frame(stream: &TcpStream, frame: Frame) {
        let mut writer = BufWriter::new(stream.try_clone().unwrap());
        frame.write_to(&mut writer).unwrap();
        writer.flush().unwrap();
    }

    #[test]
    fn busy_node_rejects_hello_without_queuing_it() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let (tx, rx) = mpsc::channel();
        let (server, client) = tcp_pair();
        let shared_for_server = shared.clone();
        let server = std::thread::spawn(move || handle_conn(server, shared_for_server, tx));

        send_frame(
            &client,
            Frame::Hello {
                proto: weave_core::wire::PROTO_VERSION,
                role: weave_core::wire::ROLE_SOURCE,
                runtime: "test".into(),
            },
        );
        let mut reader = BufReader::new(client);
        assert!(matches!(
            Frame::read_from(&mut reader).unwrap(),
            Frame::Abort { code: 9, .. }
        ));
        server.join().unwrap().unwrap();
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn one_incoming_session_reserves_the_idle_node() {
        let shared = Arc::new(Mutex::new(Shared::new(false)));
        let (tx, rx) = mpsc::channel();

        let (server1, client1) = tcp_pair();
        let shared1 = shared.clone();
        let tx1 = tx.clone();
        let first = std::thread::spawn(move || handle_conn(server1, shared1, tx1));
        send_frame(
            &client1,
            Frame::Hello {
                proto: weave_core::wire::PROTO_VERSION,
                role: weave_core::wire::ROLE_SOURCE,
                runtime: "first".into(),
            },
        );
        first.join().unwrap().unwrap();
        let reserved = rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let (server2, client2) = tcp_pair();
        let shared2 = shared.clone();
        let second = std::thread::spawn(move || handle_conn(server2, shared2, tx));
        send_frame(
            &client2,
            Frame::Hello {
                proto: weave_core::wire::PROTO_VERSION,
                role: weave_core::wire::ROLE_SOURCE,
                runtime: "second".into(),
            },
        );
        let mut reader = BufReader::new(client2);
        assert!(matches!(
            Frame::read_from(&mut reader).unwrap(),
            Frame::Abort { code: 9, .. }
        ));
        second.join().unwrap().unwrap();
        drop(reserved);
    }

    #[test]
    fn concurrent_control_requests_get_independent_results() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let (tx, _rx) = mpsc::channel();

        let (server1, client1) = tcp_pair();
        let shared1 = shared.clone();
        let tx1 = tx.clone();
        let first = std::thread::spawn(move || handle_conn(server1, shared1, tx1));
        send_frame(
            &client1,
            Frame::CtlMigrate {
                target: "first".into(),
            },
        );

        let deadline = Instant::now() + Duration::from_secs(1);
        while shared.lock().unwrap().request.is_none() {
            assert!(Instant::now() < deadline, "first request was not reserved");
            std::thread::yield_now();
        }

        let (server2, client2) = tcp_pair();
        let shared2 = shared.clone();
        let second = std::thread::spawn(move || handle_conn(server2, shared2, tx));
        send_frame(
            &client2,
            Frame::CtlMigrate {
                target: "second".into(),
            },
        );
        let mut second_reader = BufReader::new(client2);
        assert!(matches!(
            Frame::read_from(&mut second_reader).unwrap(),
            Frame::CtlErr { msg } if msg.contains("already in progress")
        ));
        second.join().unwrap().unwrap();

        shared
            .lock()
            .unwrap()
            .complete_request("migrated: first".into());
        let mut first_reader = BufReader::new(client1);
        assert!(matches!(
            Frame::read_from(&mut first_reader).unwrap(),
            Frame::CtlOk { msg } if msg == "migrated: first"
        ));
        first.join().unwrap().unwrap();
    }

    #[test]
    fn empty_control_target_is_rejected_without_reservation() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let (tx, _rx) = mpsc::channel();
        for target in ["", " \t\n"] {
            let (server, client) = tcp_pair();
            let shared_for_server = shared.clone();
            let tx_for_server = tx.clone();
            let server =
                std::thread::spawn(move || handle_conn(server, shared_for_server, tx_for_server));
            send_frame(
                &client,
                Frame::CtlMigrate {
                    target: target.into(),
                },
            );
            let mut reader = BufReader::new(client);
            assert!(matches!(
                Frame::read_from(&mut reader).unwrap(),
                Frame::CtlErr { msg } if msg.contains("must not be empty")
            ));
            server.join().unwrap().unwrap();
            assert!(shared.lock().unwrap().request.is_none());
        }
    }

    #[test]
    fn control_status_distinguishes_idle_and_accepting_nodes() {
        let shared = Arc::new(Mutex::new(Shared::new(false)));
        let (tx, _rx) = mpsc::channel();

        let query = |shared: Arc<Mutex<Shared>>, tx: mpsc::Sender<NodeEvent>| {
            let (server, client) = tcp_pair();
            let handler = std::thread::spawn(move || handle_conn(server, shared, tx));
            send_frame(&client, Frame::CtlStatus);
            let mut reader = BufReader::new(client);
            let status = match Frame::read_from(&mut reader).unwrap() {
                Frame::CtlOk { msg } => msg,
                other => panic!("expected CTL_OK, got {other:?}"),
            };
            handler.join().unwrap().unwrap();
            status
        };

        assert_eq!(query(shared.clone(), tx.clone()), "idle");
        shared.lock().unwrap().incoming_reserved = true;
        assert_eq!(query(shared, tx), "accepting");
    }
}
