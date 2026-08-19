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
#[derive(Default)]
pub struct Shared {
    /// Set by the control listener: "migrate to this address".
    pub request: Option<String>,
    /// Human-readable status for CTL_STATUS / CTL_MIGRATE replies.
    pub last_result: Option<String>,
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
    let listener = TcpListener::bind(&config.listen)
        .with_context(|| format!("binding {}", config.listen))?;
    eprintln!("weave: listening on {}", listener.local_addr()?);
    let shared = Arc::new(Mutex::new(Shared::default()));
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
        (inst, RunPhase::Start { entry: w.entry, args: w.args })
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
                                eprintln!("weave: workload received, resuming");
                                current = Some((inst, RunPhase::Resume));
                            }
                            Err(e) => eprintln!("weave: incoming migration failed: {e:#}"),
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
                        shared.lock().unwrap().last_result = Some(msg);
                        if config.exit_on_done {
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
                                        let msg = format!(
                                            "migrated: {} rounds, {} pages total, {} in pause window",
                                            stats.rounds, stats.total_pages, stats.final_pages
                                        );
                                        eprintln!("weave: {msg}");
                                        println!("WEAVE_MIGRATED");
                                        let mut sh = shared.lock().unwrap();
                                        sh.last_result = Some(msg);
                                        sh.request = None;
                                        drop(sh);
                                        // instance retired
                                        if config.exit_on_done {
                                            // give the ctl reply loop a beat
                                            std::thread::sleep(
                                                std::time::Duration::from_millis(100),
                                            );
                                            return Ok(());
                                        }
                                    }
                                    Err(e) => {
                                        eprintln!("weave: final copy failed ({e:#}), resuming locally");
                                        let mut sh = shared.lock().unwrap();
                                        sh.last_result = Some(format!("migration failed: {e:#}"));
                                        sh.request = None;
                                        drop(sh);
                                        current = Some((inst, RunPhase::Resume));
                                    }
                                }
                            }
                            Poller::Errored(e) => {
                                eprintln!("weave: migration errored ({e}), resuming locally");
                                let mut sh = shared.lock().unwrap();
                                sh.last_result = Some(format!("migration failed: {e}"));
                                sh.request = None;
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
                        shared.lock().unwrap().last_result = Some(format!("trap: {e:#}"));
                        if config.exit_on_done {
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
    let mut first_byte = [0u8; 1];
    if conn.peek(&mut first_byte)? == 0 {
        return Ok(());
    }
    if first_byte[0] == 1 {
        // HELLO: a migration source. Hand the pristine connection over.
        tx.send(NodeEvent::Incoming(conn)).ok();
        return Ok(());
    }
    let mut r = BufReader::new(conn.try_clone()?);
    let first = Frame::read_from(&mut r)?;
    match first {
        Frame::CtlMigrate { target } => {
            let mut w = BufWriter::new(conn);
            {
                let mut sh = shared.lock().unwrap();
                sh.request = Some(target.clone());
                sh.last_result = None;
            }
            // Wait for the migration to conclude (poll-driven).
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
            loop {
                std::thread::sleep(std::time::Duration::from_millis(25));
                let sh = shared.lock().unwrap();
                if let Some(res) = &sh.last_result {
                    let f = if res.starts_with("migrated") || res.starts_with("done") {
                        Frame::CtlOk { msg: res.clone() }
                    } else {
                        Frame::CtlErr { msg: res.clone() }
                    };
                    drop(sh);
                    f.write_to(&mut w)?;
                    w.flush()?;
                    return Ok(());
                }
                drop(sh);
                if std::time::Instant::now() > deadline {
                    Frame::CtlErr { msg: "timeout".into() }.write_to(&mut w)?;
                    w.flush()?;
                    return Ok(());
                }
            }
        }
        Frame::CtlStatus => {
            let mut w = BufWriter::new(conn);
            let msg = shared
                .lock()
                .unwrap()
                .last_result
                .clone()
                .unwrap_or_else(|| "running".into());
            Frame::CtlOk { msg }.write_to(&mut w)?;
            w.flush()?;
            Ok(())
        }
        other => anyhow::bail!("unexpected first frame {other:?}"),
    }
}
