use crate::control::{Shared, SharedControl};
use crate::runtime::{ModuleImage, TakenPoll, WamrInstance, WorkResult};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;
use weave_core::wire::Frame;
use weave_core::{Meta, Val};
use weave_host::source::{MigrationStats, SourceOptions};
use weave_host::target::{run_target_session, TargetHost};
use weave_host::MemRead;

const INITIAL_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const EXIT_ACK_GRACE: Duration = Duration::from_millis(100);

pub struct NodeConfig {
    pub listen: String,
    pub source_options: SourceOptions,
    pub stack_size: u32,
    pub max_memory_bytes: u64,
    pub exit_on_done: bool,
}

pub struct InitialWork {
    pub image: ModuleImage,
    pub entry: String,
    pub args: Vec<Val>,
}

enum Event {
    Incoming(TcpStream),
}

enum RunPhase {
    Start { entry: String, args: Vec<Val> },
    Resume,
}

pub fn serve(config: NodeConfig, initial: Option<InitialWork>) -> Result<()> {
    let listener =
        TcpListener::bind(&config.listen).with_context(|| format!("binding {}", config.listen))?;
    eprintln!("weave-wamr: listening on {}", listener.local_addr()?);

    let shared = SharedControl::new(initial.is_some());
    let (sender, receiver) = mpsc::channel();
    spawn_listener(listener, shared.clone(), sender);

    let mut module_cache = HashMap::new();
    let mut current = if let Some(work) = initial {
        module_cache.insert(work.image.hash, work.image.clone());
        let mut instance = WamrInstance::instantiate(
            work.image,
            config.stack_size,
            Some(shared.clone()),
            config.source_options.clone(),
        )?;
        instance.initialize_fresh()?;
        Some((
            instance,
            RunPhase::Start {
                entry: work.entry,
                args: work.args,
            },
        ))
    } else {
        None
    };

    loop {
        match current.take() {
            None => {
                eprintln!("weave-wamr: idle, waiting for a workload");
                let Event::Incoming(connection) = receiver
                    .recv()
                    .map_err(|_| anyhow!("ingress listener stopped"))?;
                let mut driver = TargetDriver {
                    module_cache: &mut module_cache,
                    instance: None,
                    shared: shared.clone(),
                    stack_size: config.stack_size,
                    source_options: config.source_options.clone(),
                    max_memory_bytes: config.max_memory_bytes,
                };
                match run_target_session(connection, &mut driver) {
                    Ok(received) => {
                        eprintln!(
                            "weave-wamr: workload received from {}, resuming",
                            received.source_runtime
                        );
                        let instance = driver
                            .instance
                            .take()
                            .ok_or_else(|| anyhow!("target session produced no WAMR instance"))?;
                        current = Some((instance, RunPhase::Resume));
                    }
                    Err(error) => {
                        eprintln!("weave-wamr: incoming migration failed: {error:#}");
                        shared.workload_finished(format!("incoming migration failed: {error:#}"));
                    }
                }
            }
            Some((mut instance, phase)) => {
                instance.attach_shared(shared.clone(), config.source_options.clone());
                let outcome = match &phase {
                    RunPhase::Start { entry, args } => instance.call_entry(entry, args),
                    RunPhase::Resume => instance.resume(),
                };
                match outcome {
                    Ok(WorkResult::Done(values)) => {
                        let rendered = render_values(&values);
                        let message = format!("done: [{}]", rendered.join(", "));
                        println!("WEAVE_DONE [{}]", rendered.join(", "));
                        shared.workload_finished(message);
                        if config.exit_on_done {
                            wait_for_resumed_exit_ack(&phase);
                            return Ok(());
                        }
                    }
                    Ok(WorkResult::Unwound) => match instance.take_poll() {
                        TakenPoll::Migrating(migration) => {
                            let globals = instance.capture_globals()?;
                            let services = instance.snapshot_services();
                            let memories = instance.mem_view();
                            match migration.finish(&memories, globals, services) {
                                Ok(stats) => {
                                    let message = migration_outcome_message(&stats);
                                    if !stats.commit_confirmed {
                                        if let Some(error) = &stats.commit_error {
                                            eprintln!("weave-wamr: {error}");
                                        }
                                    }
                                    eprintln!("weave-wamr: {message}");
                                    println!("{}", migration_marker(&stats));
                                    shared.workload_finished(message);
                                    if config.exit_on_done {
                                        // Let the control connection observe the completed
                                        // request and flush CTL_OK/CTL_ERR before main exits
                                        // and tears down its detached connection thread.
                                        std::thread::sleep(EXIT_ACK_GRACE);
                                        return Ok(());
                                    }
                                }
                                Err(error) => {
                                    let message = format!("migration failed: {error:#}");
                                    eprintln!("weave-wamr: {message}; resuming locally");
                                    shared.attempt_failed(message);
                                    current = Some((instance, RunPhase::Resume));
                                }
                            }
                        }
                        TakenPoll::Errored(error) => {
                            let message = format!("migration failed: {error}");
                            eprintln!("weave-wamr: {message}; resuming locally");
                            shared.attempt_failed(message);
                            current = Some((instance, RunPhase::Resume));
                        }
                        TakenPoll::Run => bail!("workload unwound without a migration in flight"),
                    },
                    Err(error) => {
                        eprintln!("weave-wamr: workload trapped: {error:#}");
                        println!("WEAVE_TRAP {error:#}");
                        shared.workload_finished(format!("trap: {error:#}"));
                        if config.exit_on_done {
                            wait_for_resumed_exit_ack(&phase);
                            return Err(error);
                        }
                    }
                }
            }
        }
    }
}

fn resumed_exit_grace(phase: &RunPhase) -> Option<Duration> {
    matches!(phase, RunPhase::Resume).then_some(EXIT_ACK_GRACE)
}

fn wait_for_resumed_exit_ack(phase: &RunPhase) {
    if let Some(grace) = resumed_exit_grace(phase) {
        // Incoming COMMIT_OK is written by a detached target-session thread.
        // Let that ownership acknowledgement flush before main exits.
        std::thread::sleep(grace);
    }
}

fn spawn_listener(listener: TcpListener, shared: Shared, sender: mpsc::Sender<Event>) {
    std::thread::spawn(move || {
        for connection in listener.incoming() {
            let Ok(connection) = connection else {
                continue;
            };
            let shared = shared.clone();
            let sender = sender.clone();
            std::thread::spawn(move || {
                if let Err(error) = handle_connection(connection, &shared, &sender) {
                    eprintln!("weave-wamr: connection failed: {error:#}");
                }
            });
        }
    });
}

fn handle_connection(
    connection: TcpStream,
    shared: &Shared,
    sender: &mpsc::Sender<Event>,
) -> Result<()> {
    connection.set_nodelay(true).ok();
    set_initial_read_timeout(&connection)?;
    let mut first = [0u8; 1];
    if connection.peek(&mut first)? == 0 {
        return Ok(());
    }
    if first[0] == 1 {
        if shared.try_reserve_incoming() {
            if sender.send(Event::Incoming(connection)).is_err() {
                shared.workload_finished("ingress listener stopped".to_owned());
            }
        } else {
            reject_busy(connection)?;
        }
        return Ok(());
    }

    let mut reader = BufReader::new(connection.try_clone()?);
    match Frame::read_from(&mut reader)? {
        Frame::CtlMigrate { target } => {
            let mut writer = BufWriter::new(connection);
            if let Err(error) = shared.request_migration(target) {
                Frame::CtlErr {
                    msg: format!("{error:#}"),
                }
                .write_to(&mut writer)?;
                writer.flush()?;
                return Ok(());
            }
            match shared.wait_for_request(Duration::from_secs(120)) {
                Ok(message) if control_result_succeeded(&message) => {
                    Frame::CtlOk { msg: message }.write_to(&mut writer)?;
                }
                Ok(message) => Frame::CtlErr { msg: message }.write_to(&mut writer)?,
                Err(error) => Frame::CtlErr {
                    msg: format!("{error:#}"),
                }
                .write_to(&mut writer)?,
            }
            writer.flush()?;
            Ok(())
        }
        Frame::CtlStatus => {
            let mut writer = BufWriter::new(connection);
            Frame::CtlOk {
                msg: shared.status(),
            }
            .write_to(&mut writer)?;
            writer.flush()?;
            Ok(())
        }
        other => bail!("unexpected first frame {other:?}"),
    }
}

fn set_initial_read_timeout(connection: &TcpStream) -> Result<()> {
    // Bound admission before `peek` classifies migration versus control
    // traffic. A migration handed to run_target_session gets that protocol's
    // own read/write deadlines immediately afterward.
    connection
        .set_read_timeout(Some(INITIAL_FRAME_TIMEOUT))
        .context("setting initial connection read timeout")
}

fn migration_outcome_message(stats: &MigrationStats) -> String {
    let detail = format!(
        "{} rounds, {} pages total, {} in pause window",
        stats.rounds, stats.total_pages, stats.final_pages
    );
    if stats.commit_confirmed {
        format!("migrated: {detail}")
    } else {
        format!("commit uncertain: {detail}; COMMIT_OK unconfirmed (source retired)")
    }
}

fn control_result_succeeded(message: &str) -> bool {
    message.starts_with("migrated:") || message.starts_with("done:")
}

fn migration_marker(stats: &MigrationStats) -> &'static str {
    if stats.commit_confirmed {
        "WEAVE_MIGRATED"
    } else {
        "WEAVE_MIGRATED_UNCONFIRMED"
    }
}

fn reject_busy(connection: TcpStream) -> Result<()> {
    let mut reader = BufReader::new(connection.try_clone()?);
    let mut writer = BufWriter::new(connection);
    match Frame::read_from(&mut reader)? {
        Frame::Hello { .. } => {
            Frame::Abort {
                code: 9,
                msg: "target node is busy".to_owned(),
            }
            .write_to(&mut writer)?;
            writer.flush()?;
            Ok(())
        }
        other => bail!("expected HELLO on migration connection, got {other:?}"),
    }
}

struct TargetDriver<'a> {
    module_cache: &'a mut HashMap<[u8; 32], ModuleImage>,
    instance: Option<WamrInstance>,
    shared: Shared,
    stack_size: u32,
    source_options: SourceOptions,
    max_memory_bytes: u64,
}

impl TargetHost for TargetDriver<'_> {
    fn runtime_name(&self) -> &str {
        "wamr"
    }

    fn max_memory_bytes(&self) -> u64 {
        self.max_memory_bytes
    }

    fn has_module(&mut self, hash: &[u8; 32]) -> bool {
        self.module_cache.contains_key(hash)
    }

    fn store_module(&mut self, hash: &[u8; 32], bytes: Vec<u8>) -> Result<()> {
        let image = ModuleImage::parse(bytes)?;
        if &image.hash != hash {
            bail!("received module hash changed during WAMR parsing");
        }
        self.module_cache.insert(*hash, image);
        Ok(())
    }

    fn instantiate(&mut self, hash: &[u8; 32], offered_meta: &Meta) -> Result<()> {
        let image = self
            .module_cache
            .get(hash)
            .ok_or_else(|| anyhow!("module is absent from WAMR cache"))?
            .clone();
        if &image.meta != offered_meta {
            bail!("offered weave.meta does not match the module's embedded metadata");
        }
        if image.initial_memory_bytes > self.max_memory_bytes {
            bail!(
                "module declares {} initial memory bytes, exceeding target limit {}",
                image.initial_memory_bytes,
                self.max_memory_bytes
            );
        }
        let mut instance = WamrInstance::instantiate(
            image,
            self.stack_size,
            Some(self.shared.clone()),
            self.source_options.clone(),
        )?;
        instance.prepare_restore()?;
        self.instance = Some(instance);
        Ok(())
    }

    fn set_mem_pages(&mut self, memory: usize, pages: u64) -> Result<()> {
        self.instance_mut()?.set_mem_pages(memory, pages)
    }

    fn write_mem(&mut self, memory: usize, offset: usize, bytes: &[u8]) -> Result<()> {
        self.instance_mut()?.write_mem(memory, offset, bytes)
    }

    fn set_global(&mut self, name: &str, value: i32) -> Result<()> {
        self.instance_mut()?.set_global_i32(name, value)
    }

    fn service_names(&mut self) -> Vec<String> {
        vec![
            "env.emit".to_owned(),
            "env.emit32".to_owned(),
            "env.emit64".to_owned(),
        ]
    }

    fn restore_services(&mut self, services: &[(String, Vec<u8>)]) -> Result<()> {
        self.instance_mut()?.restore_services(services)
    }

    fn with_mems(&mut self, visit: &mut dyn FnMut(&dyn MemRead) -> Result<()>) -> Result<()> {
        let instance = self
            .instance
            .as_ref()
            .ok_or_else(|| anyhow!("target session requested memories before instantiation"))?;
        let memories = instance.mem_view();
        visit(&memories)
    }
}

impl TargetDriver<'_> {
    fn instance_mut(&mut self) -> Result<&mut WamrInstance> {
        self.instance
            .as_mut()
            .ok_or_else(|| anyhow!("target session has no WAMR instance"))
    }
}

pub fn render_values(values: &[Val]) -> Vec<String> {
    values
        .iter()
        .map(|value| match value.ty {
            weave_core::ValType::I32 => value.as_i32().to_string(),
            weave_core::ValType::I64 => value.as_i64().to_string(),
            weave_core::ValType::F32 => f32::from_bits(value.as_f32_bits()).to_string(),
            weave_core::ValType::F64 => f64::from_bits(value.as_f64_bits()).to_string(),
            weave_core::ValType::V128 => {
                let mut text = String::from("0x");
                for byte in value.bits.iter().rev() {
                    use std::fmt::Write as _;
                    let _ = write!(text, "{byte:02x}");
                }
                text
            }
            weave_core::ValType::FuncRef => value.as_i32().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abort_before_commit_keeps_constructor_exports_dormant() {
        let _serial = crate::runtime::EXECUTION_LOCK.lock().unwrap();
        crate::with_wamr(|| {
            for constructor in ["__post_instantiate", "__wasm_call_ctors"] {
                let wasm = wat::parse_str(format!(
                    r#"(module
                  (import "env" "emit32" (func $emit32 (param i32)))
                  (func (export "run"))
                  (func (export "{constructor}") (call $emit32 (i32.const 7)) unreachable))"#
                ))?;
                let image = ModuleImage::parse(
                    weave_transform::transform(&wasm, &Default::default())?.wasm,
                )?;
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let address = listener.local_addr()?.to_string();
                let source = std::thread::spawn(move || -> Result<()> {
                    // connect returns only after MODULE_OK: the target must
                    // instantiate successfully despite its trapping export.
                    let migration = weave_host::source::SourceMigration::connect(
                        &address,
                        "test-source",
                        &image.wasm,
                        &image.meta_bytes,
                        image.meta.memories.len(),
                        SourceOptions::default(),
                    )?;
                    migration.abort(73, "deliberate pre-commit cancellation");
                    Ok(())
                });
                let (connection, _) = listener.accept()?;
                let mut cache = HashMap::new();
                let mut target = TargetDriver {
                    module_cache: &mut cache,
                    instance: None,
                    shared: SharedControl::new(true),
                    stack_size: crate::runtime::DEFAULT_STACK_SIZE,
                    source_options: SourceOptions::default(),
                    max_memory_bytes: weave_host::target::DEFAULT_MAX_MEMORY_BYTES,
                };
                let error = match run_target_session(connection, &mut target) {
                    Ok(_) => bail!("target accepted a cancelled migration"),
                    Err(error) => error,
                };
                source.join().expect("source control thread panicked")?;
                assert!(
                    format!("{error:#}").contains("source aborted (73)"),
                    "{error:#}"
                );
                let staged = target
                    .instance
                    .as_ref()
                    .expect("target must have staged an instance");
                for (_, service) in staged.snapshot_services() {
                    assert_eq!(service, vec![0; 16]);
                }
                // Dropping the uncommitted instance never invokes its entry.
            }
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn accepted_connections_receive_an_admission_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (server, _) = listener.accept().unwrap();

        set_initial_read_timeout(&server).unwrap();
        assert_eq!(server.read_timeout().unwrap(), Some(INITIAL_FRAME_TIMEOUT));
        drop(client);
    }

    #[test]
    fn ack_exit_grace_applies_only_to_resumed_incoming_workloads() {
        let start = RunPhase::Start {
            entry: "run".to_owned(),
            args: vec![],
        };
        assert_eq!(resumed_exit_grace(&start), None);
        assert_eq!(resumed_exit_grace(&RunPhase::Resume), Some(EXIT_ACK_GRACE));
    }

    #[test]
    fn unconfirmed_commit_is_an_uncertain_control_failure() {
        let stats = MigrationStats {
            rounds: 2,
            total_pages: 17,
            final_pages: 1,
            commit_confirmed: false,
            commit_error: Some("waiting for COMMIT_OK failed".to_owned()),
        };

        let message = migration_outcome_message(&stats);
        assert!(message.starts_with("commit uncertain:"));
        assert!(message.contains("source retired"));
        assert!(!control_result_succeeded(&message));
        assert_eq!(migration_marker(&stats), "WEAVE_MIGRATED_UNCONFIRMED");
    }
}
