//! A Weave *node*: one process that runs a workload, accepts control
//! commands, migrates its workload out on request, and receives workloads
//! migrated in — the symmetric peer-to-peer unit. A node that received a
//! workload can later migrate it onward (A → B → C chains).

use crate::instance::{LinkFn, ServiceFactory, WeaveInstance, WorkResult};
use crate::migrate::{accept_conn, TargetFactory};
use crate::poll::Poller;
use crate::WeaveModule;
use anyhow::{Context, Result};
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use wasmtime::{Engine, Val};
use weave_core::control::{Capabilities, Completion, ControlState, Lifecycle, Request, Response};
use weave_core::wire::Frame;
use weave_host::source::SourceOptions;

/// Cross-thread migration control, checked by `weave.poll` while running.
pub struct Shared {
    request: Option<MigrationRequest>,
    /// Human-readable status for CTL_STATUS / CTL_MIGRATE replies.
    pub last_result: Option<String>,
    active: bool,
    incoming_reserved: bool,
    control: ControlState,
    retirement: Option<Arc<AtomicBool>>,
}

struct MigrationRequest {
    target: String,
    result: Option<mpsc::Sender<LegacyResult>>,
}

struct LegacyResult {
    message: String,
    ok: bool,
}

impl Shared {
    #[cfg(test)]
    fn new(active: bool) -> Self {
        Self::with_capabilities(active, Capabilities::unknown("test")).unwrap()
    }

    fn with_capabilities(active: bool, capabilities: Capabilities) -> Result<Self> {
        Ok(Self {
            request: None,
            last_result: None,
            active,
            incoming_reserved: false,
            control: ControlState::new(
                capabilities,
                if active {
                    Lifecycle::Running
                } else {
                    Lifecycle::Idle
                },
            )?,
            retirement: None,
        })
    }

    pub(crate) fn requested_target(&self) -> Option<String> {
        self.request.as_ref().map(|request| request.target.clone())
    }

    pub(crate) fn complete_request(&mut self, completion: Completion, result: String) {
        self.refresh_ownership();
        self.control.complete(completion, &result);
        self.last_result = Some(result.clone());
        if let Some(request) = self.request.take() {
            if let Some(sender) = request.result {
                let _ = sender.send(LegacyResult {
                    message: result,
                    ok: matches!(
                        completion,
                        Completion::Migrated | Completion::WorkloadCompleted
                    ),
                });
            }
        }
    }

    fn refresh_ownership(&mut self) {
        if self
            .retirement
            .as_ref()
            .is_some_and(|retirement| retirement.load(Ordering::Acquire))
        {
            self.control.source_retired();
        }
    }

    fn structured_request(&mut self, request: Result<Request>) -> Response {
        self.refresh_ownership();
        let request = match request {
            Ok(request) => request,
            Err(error) => return self.control.invalid_request(format!("{error:#}")),
        };
        let (response, accepted) = self
            .control
            .handle(request, self.active && self.request.is_none());
        if let Some(accepted) = accepted {
            self.request = Some(MigrationRequest {
                target: accepted.target,
                result: None,
            });
            self.last_result = None;
        }
        response
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
    pub make_services: ServiceFactory<'a>,
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
    factories: NodeFactories<'_>,
    initial: Option<InitialWork>,
) -> Result<()> {
    // A custom factory is not invoked to answer inspection requests. Its
    // service/import set stays explicitly unknown unless advertised below.
    let mut capabilities = Capabilities::unknown(config.runtime_name.clone());
    capabilities.limits.memory_bytes = Some(weave_host::target::DEFAULT_MAX_MEMORY_BYTES);
    capabilities.limits.module_bytes = Some(weave_host::target::MAX_MODULE_SIZE);
    serve_with_capabilities(engine, config, factories, initial, capabilities)
}

/// Serve with the embedding's explicit capability advertisement. Values must
/// describe the actual factories/engine; inspection never calls those factories
/// or executes guest code to discover capabilities. `serve` preserves the
/// unknown custom service/import advertisement for existing library callers.
pub fn serve_with_capabilities(
    engine: &Engine,
    config: NodeConfig,
    mut factories: NodeFactories<'_>,
    initial: Option<InitialWork>,
    capabilities: Capabilities,
) -> Result<()> {
    let listener =
        TcpListener::bind(&config.listen).with_context(|| format!("binding {}", config.listen))?;
    let shared = Arc::new(Mutex::new(Shared::with_capabilities(
        initial.is_some(),
        capabilities,
    )?));
    let (tx, rx) = mpsc::channel::<NodeEvent>();

    // Initialization can trap or fail linking. Do it while the listener is
    // still owned locally so an error closes it and returns normally, without
    // leaving a detached control thread advertising a nonexistent workload.
    let mut current: Option<(WeaveInstance, RunPhase)> = match initial {
        Some(work) => {
            let (services, any) = (factories.make_services)();
            let link = (factories.make_link)();
            let instance = WeaveInstance::new_fresh(engine, &work.module, services, any, link)
                .context("instantiating initial workload")?;
            Some((
                instance,
                RunPhase::Start {
                    entry: work.entry,
                    args: work.args,
                },
            ))
        }
        None => None,
    };
    eprintln!("weave: listening on {}", listener.local_addr()?);

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
                                    sh.control.set_lifecycle(Lifecycle::Running);
                                }
                                eprintln!("weave: workload received, resuming");
                                current = Some((inst, RunPhase::Resume));
                            }
                            Err(e) => {
                                let mut sh = shared.lock().unwrap();
                                sh.incoming_reserved = false;
                                sh.control.set_lifecycle(Lifecycle::Idle);
                                eprintln!("weave: incoming migration failed: {e:#}");
                            }
                        }
                    }
                    Err(_) => return Ok(()),
                }
            }
            Some((mut inst, phase)) => {
                shared.lock().unwrap().retirement = Some(inst.ctx_mut().retired.clone());
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
                        sh.complete_request(Completion::WorkloadCompleted, msg);
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
                                        sh.complete_request(
                                            if stats.commit_confirmed {
                                                Completion::Migrated
                                            } else {
                                                Completion::CommitUncertain
                                            },
                                            msg,
                                        );
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
                                        sh.complete_request(
                                            Completion::FailedBeforeCommit,
                                            format!("migration failed: {e:#}"),
                                        );
                                        drop(sh);
                                        current = Some((inst, RunPhase::Resume));
                                    }
                                }
                            }
                            Poller::Errored(e) => {
                                eprintln!("weave: migration errored ({e}), resuming locally");
                                let mut sh = shared.lock().unwrap();
                                sh.complete_request(
                                    Completion::FailedBeforeCommit,
                                    format!("migration failed: {e}"),
                                );
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
                        sh.complete_request(Completion::WorkloadTrapped, format!("trap: {e:#}"));
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
    conn.set_write_timeout(Some(std::time::Duration::from_secs(30)))
        .context("setting control response timeout")?;
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
            sh.retirement = None;
            sh.control.set_lifecycle(Lifecycle::Accepting);
        }
        if tx.send(NodeEvent::Incoming(conn)).is_err() {
            let mut sh = shared.lock().unwrap();
            sh.incoming_reserved = false;
            sh.control.set_lifecycle(Lifecycle::Idle);
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
                    result: Some(result_tx),
                });
                sh.last_result = None;
                sh.control.set_lifecycle(Lifecycle::Migrating);
            }
            let res = match result_rx.recv_timeout(std::time::Duration::from_secs(120)) {
                Ok(result) => result,
                Err(_) => LegacyResult {
                    message: "timeout waiting for migration result".into(),
                    ok: false,
                },
            };
            let frame = if res.ok {
                Frame::CtlOk { msg: res.message }
            } else {
                Frame::CtlErr { msg: res.message }
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
        Frame::CtlRequest { json } => {
            let request = Request::from_json(&json);
            let response = shared.lock().unwrap().structured_request(request);
            let mut writer = BufWriter::new(conn);
            Frame::CtlResponse {
                json: response.to_json()?,
            }
            .write_to(&mut writer)?;
            writer.flush()?;
            Ok(())
        }
        other => anyhow::bail!("unexpected first frame {other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use weave_core::control::{Action, OperationState, Ownership, Retry};

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

    fn query(shared: &Arc<Mutex<Shared>>, bytes: Vec<u8>) -> Response {
        let (server, client) = tcp_pair();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let (tx, _rx) = mpsc::channel();
        let shared_for_server = shared.clone();
        let handler = std::thread::spawn(move || handle_conn(server, shared_for_server, tx));
        send_frame(&client, Frame::CtlRequest { json: bytes });
        let mut reader = BufReader::new(client);
        let response = match Frame::read_from(&mut reader).unwrap() {
            Frame::CtlResponse { json } => Response::from_json(&json).unwrap(),
            other => panic!("expected structured response, got {other:?}"),
        };
        handler.join().unwrap().unwrap();
        response
    }

    fn migrate_request(shared: &Arc<Mutex<Shared>>, id: &str) -> Request {
        Request {
            schema_version: 1,
            action: Action::Migrate,
            node_epoch: Some(shared.lock().unwrap().control.node_epoch().into()),
            operation_id: Some(id.into()),
            target: Some("127.0.0.1:9000".into()),
        }
    }

    #[test]
    fn trapped_initializer_returns_error_without_leaking_listener() {
        let reservation = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = reservation.local_addr().unwrap();
        drop(reservation);
        let engine = crate::default_engine().unwrap();
        let raw = wat::parse_str(
            r#"(module (func $start unreachable) (start $start) (func (export "run")))"#,
        )
        .unwrap();
        let module =
            WeaveModule::from_raw(&raw, &weave_transform::TransformOptions::default()).unwrap();
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            serve(
                &engine,
                NodeConfig {
                    listen: address.to_string(),
                    runtime_name: "test".into(),
                    source_opts: SourceOptions::default(),
                    exit_on_done: false,
                },
                NodeFactories {
                    make_services: Box::new(|| (vec![], vec![])),
                    make_link: Box::new(|| Box::new(|_| Ok(()))),
                },
                Some(InitialWork {
                    module,
                    entry: "run".into(),
                    args: vec![],
                }),
            )
        }));
        let error = result
            .expect("initialization errors must not panic")
            .unwrap_err();
        assert!(format!("{error:#}").contains("instantiating initial workload"));
        // An orphan control thread would retain this exact listener address.
        let rebound = TcpListener::bind(address).expect("failed startup must release its listener");
        drop(rebound);
    }

    #[test]
    fn structured_migration_is_immediate_idempotent_and_lookup_is_retained() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let request = migrate_request(&shared, "first");
        // No workload runner exists to complete this request: replying must
        // not wait for a migration/poll/legacy completion channel.
        let accepted = query(&shared, request.to_json().unwrap());
        assert_eq!(accepted.code, "ACCEPTED");
        assert_eq!(accepted.ownership, Ownership::Retained);
        assert_eq!(
            query(&shared, request.to_json().unwrap()).operation,
            accepted.operation
        );
        assert!(shared
            .lock()
            .unwrap()
            .request
            .as_ref()
            .unwrap()
            .result
            .is_none());
        let conflict = Request {
            target: Some("127.0.0.1:9001".into()),
            ..request.clone()
        };
        assert_eq!(
            query(&shared, conflict.to_json().unwrap()).code,
            "OPERATION_CONFLICT"
        );
        shared.lock().unwrap().complete_request(
            Completion::FailedBeforeCommit,
            "migrated: not a success".into(),
        );
        let replay = query(&shared, request.to_json().unwrap());
        assert_eq!(replay.code, "MIGRATION_FAILED");
        assert_eq!(replay.retry, Retry::NewOperation);
        assert!(shared.lock().unwrap().request.is_none());
        let lookup = Request {
            action: Action::Operation,
            target: None,
            ..request
        };
        assert_eq!(
            query(&shared, lookup.to_json().unwrap()).operation,
            replay.operation
        );
    }

    #[test]
    fn structured_status_observes_retirement_before_finish_returns() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let latch = Arc::new(AtomicBool::new(false));
        shared.lock().unwrap().retirement = Some(latch.clone());
        let request = migrate_request(&shared, "handoff");
        query(&shared, request.to_json().unwrap());
        latch.store(true, Ordering::Release);
        let status = query(&shared, Request::status().to_json().unwrap());
        assert_eq!(status.lifecycle, Lifecycle::Retired);
        assert_eq!(status.ownership, Ownership::Retired);
        let pending = status.operation.unwrap();
        assert_eq!(pending.code, "COMMIT_PENDING");
        assert_eq!(pending.state, OperationState::Accepted);
        assert_eq!(pending.ownership, Ownership::Retired);
        shared
            .lock()
            .unwrap()
            .complete_request(Completion::CommitUncertain, "confirmation lost".into());
        let lookup = Request {
            action: Action::Operation,
            target: None,
            ..request
        };
        let result = query(&shared, lookup.to_json().unwrap());
        assert!(!result.ok);
        assert_eq!(result.code, "COMMIT_UNCERTAIN");
        assert_eq!(result.ownership, Ownership::Retired);
        assert_eq!(result.operation.unwrap().ownership, Ownership::Retired);
    }

    #[test]
    fn malformed_structured_requests_do_not_mutate_running_node() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        for bytes in [
            b"null".as_slice(),
            b"[]",
            b"{",
            b"\xff",
            br#"{"schema_version":1,"action":"erase"}"#,
            br#"{"schema_version":1,"action":"status","unknown":true}"#,
            br#"{"schema_version":1,"action":"status","action":"status"}"#,
        ] {
            let response = query(&shared, bytes.to_vec());
            assert_eq!(response.code, "INVALID_REQUEST");
            assert!(!response.ok);
            assert_eq!(response.lifecycle, Lifecycle::Running);
            assert!(shared.lock().unwrap().request.is_none());
        }
        let status = query(&shared, Request::status().to_json().unwrap());
        assert!(status.ok);
        assert!(status.capabilities.unwrap().services.is_none());
    }

    #[test]
    fn restart_epoch_mismatch_and_unknown_operation_are_explicit() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let request = migrate_request(&shared, "first");
        let replacement = Arc::new(Mutex::new(Shared::new(true)));
        let response = query(&replacement, request.to_json().unwrap());
        assert_eq!(response.code, "NODE_EPOCH_MISMATCH");
        assert_eq!(response.retry, Retry::InspectOwnership);
        assert!(replacement.lock().unwrap().request.is_none());
        let lookup = Request {
            action: Action::Operation,
            target: None,
            ..request
        };
        assert_eq!(
            query(&shared, lookup.to_json().unwrap()).code,
            "OPERATION_NOT_FOUND"
        );
    }

    #[test]
    fn legacy_and_structured_migrations_share_one_reservation() {
        let shared = Arc::new(Mutex::new(Shared::new(true)));
        let (result, _receiver) = mpsc::channel();
        {
            let mut sh = shared.lock().unwrap();
            sh.request = Some(MigrationRequest {
                target: "legacy:9000".into(),
                result: Some(result),
            });
            sh.control.set_lifecycle(Lifecycle::Migrating);
        }
        let request = migrate_request(&shared, "structured");
        assert_eq!(query(&shared, request.to_json().unwrap()).code, "NODE_BUSY");
        shared
            .lock()
            .unwrap()
            .complete_request(Completion::FailedBeforeCommit, "failed".into());
        assert_eq!(query(&shared, request.to_json().unwrap()).code, "ACCEPTED");
        let (server, client) = tcp_pair();
        let (tx, _rx) = mpsc::channel();
        let shared_for_server = shared.clone();
        let handler = std::thread::spawn(move || handle_conn(server, shared_for_server, tx));
        send_frame(
            &client,
            Frame::CtlMigrate {
                target: "legacy:9000".into(),
            },
        );
        assert!(
            matches!(Frame::read_from(&mut BufReader::new(client)).unwrap(), Frame::CtlErr { msg } if msg.contains("already in progress"))
        );
        handler.join().unwrap().unwrap();
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
            .complete_request(Completion::Migrated, "migrated: first".into());
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
