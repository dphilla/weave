use crate::control::{Shared, SharedControl};
use crate::runtime::{ModuleImage, TakenPoll, WamrInstance, WorkResult};
use anyhow::{anyhow, bail, Context, Result};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;
use std::time::Duration;
use weave_core::control::{Capabilities, Completion, ImportCapability};
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

    let shared = SharedControl::with_capabilities(
        initial.is_some(),
        control_capabilities(config.max_memory_bytes),
    )?;
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
                        shared.incoming_committed();
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
                        shared.incoming_failed(format!("incoming migration failed: {error:#}"));
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
                        shared.workload_finished(Completion::WorkloadCompleted, message);
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
                                    shared.workload_finished(migration_completion(&stats), message);
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
                        shared.workload_finished(
                            Completion::WorkloadTrapped,
                            format!("trap: {error:#}"),
                        );
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
                shared.incoming_failed("ingress listener stopped".to_owned());
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
            let response = match shared.request_migration(target) {
                Ok(response) => response,
                Err(error) => {
                    Frame::CtlErr {
                        msg: format!("{error:#}"),
                    }
                    .write_to(&mut writer)?;
                    writer.flush()?;
                    return Ok(());
                }
            };
            match response.recv_timeout(Duration::from_secs(120)) {
                Ok((completion, message)) if control_result_succeeded(completion) => {
                    Frame::CtlOk { msg: message }.write_to(&mut writer)?;
                }
                Ok((_, message)) => Frame::CtlErr { msg: message }.write_to(&mut writer)?,
                Err(error) => Frame::CtlErr {
                    msg: format!("{error:#}"),
                }
                .write_to(&mut writer)?,
            }
            writer.flush()?;
            Ok(())
        }
        Frame::CtlRequest { json } => {
            let response = shared.structured_request(&json);
            let mut writer = BufWriter::new(connection);
            Frame::CtlResponse {
                json: response.to_json()?,
            }
            .write_to(&mut writer)?;
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
        .context("setting initial connection read timeout")?;
    connection
        .set_write_timeout(Some(INITIAL_FRAME_TIMEOUT))
        .context("setting initial connection write timeout")
}

fn control_capabilities(max_memory_bytes: u64) -> Capabilities {
    let mut capabilities = Capabilities::unknown("wamr");
    capabilities.adapter_version = env!("CARGO_PKG_VERSION").to_owned();
    capabilities.services = Some(
        ["env.emit", "env.emit32", "env.emit64"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
    );
    capabilities.imports = Some(
        [
            ("emit", vec!["i32", "i64"]),
            ("emit32", vec!["i32"]),
            ("emit64", vec!["i64"]),
        ]
        .into_iter()
        .map(|(name, params)| ImportCapability {
            module: "env".to_owned(),
            name: name.to_owned(),
            params: params.into_iter().map(str::to_owned).collect(),
            results: vec![],
        })
        .collect(),
    );
    capabilities.features = ["bulk-memory", "reference-types", "simd", "multi-memory"]
        .into_iter()
        .map(str::to_owned)
        .collect();
    capabilities.limits.memory_bytes = Some(max_memory_bytes);
    capabilities.limits.module_bytes = Some(weave_host::target::MAX_MODULE_SIZE);
    capabilities
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

fn migration_completion(stats: &MigrationStats) -> Completion {
    if stats.commit_confirmed {
        Completion::Migrated
    } else {
        Completion::CommitUncertain
    }
}

fn control_result_succeeded(completion: Completion) -> bool {
    matches!(
        completion,
        Completion::Migrated | Completion::WorkloadCompleted
    )
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
    use std::io::Read;
    use weave_core::control::{Action, Lifecycle, Ownership, Request, Response, SCHEMA_VERSION};

    fn connection_pair(shared: Shared) -> (TcpStream, std::thread::JoinHandle<Result<()>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let client = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client
            .set_write_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let worker = std::thread::spawn(move || {
            let (connection, _) = listener.accept()?;
            let (sender, _receiver) = mpsc::channel();
            handle_connection(connection, &shared, &sender)
        });
        (client, worker)
    }

    fn structured_exchange(shared: Shared, json: Vec<u8>) -> Response {
        let (mut client, worker) = connection_pair(shared);
        Frame::CtlRequest { json }.write_to(&mut client).unwrap();
        let frame = Frame::read_from(&mut client).unwrap();
        worker.join().unwrap().unwrap();
        match frame {
            Frame::CtlResponse { json } => Response::from_json(&json).unwrap(),
            other => panic!("expected structured response, got {other:?}"),
        }
    }

    #[test]
    fn structured_status_advertises_exact_builtins_and_receive_limits() {
        let shared = SharedControl::with_capabilities(false, control_capabilities(123456)).unwrap();
        let response = structured_exchange(shared, Request::status().to_json().unwrap());
        assert_eq!(response.code, "STATUS_OK");
        assert_eq!(response.lifecycle, Lifecycle::Idle);
        assert_eq!(response.ownership, Ownership::None);
        assert_eq!(response.node_epoch.len(), 32);
        let capabilities = response.capabilities.unwrap();
        assert_eq!(capabilities.runtime, "wamr");
        assert_eq!(capabilities.adapter_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(capabilities.migration_protocol, 2);
        assert_eq!(
            capabilities.services.unwrap(),
            ["env.emit", "env.emit32", "env.emit64"]
        );
        let imports = capabilities.imports.unwrap();
        assert_eq!(imports.len(), 3);
        assert_eq!(imports[0].module, "env");
        assert_eq!(imports[0].name, "emit");
        assert_eq!(imports[0].params, ["i32", "i64"]);
        assert!(imports.iter().all(|import| import.results.is_empty()));
        assert_eq!(capabilities.limits.control_frame_bytes, 65536);
        assert_eq!(capabilities.limits.retained_operations, 256);
        assert_eq!(capabilities.limits.operation_id_bytes, 128);
        assert_eq!(capabilities.limits.memory_bytes, Some(123456));
        assert_eq!(
            capabilities.limits.module_bytes,
            Some(weave_host::target::MAX_MODULE_SIZE)
        );
        assert!(capabilities.features.contains(&"multi-memory".to_owned()));
        assert!(!capabilities.features.contains(&"threads".to_owned()));
    }

    #[test]
    fn structured_malformed_json_is_rejected_without_stopping_later_queries() {
        let shared = SharedControl::new(true);
        for json in [
            b"{".to_vec(),
            vec![0xff],
            b"null".to_vec(),
            vec![b' '; 65536],
        ] {
            let response = structured_exchange(shared.clone(), json);
            assert!(!response.ok);
            assert_eq!(response.code, "INVALID_REQUEST");
            assert_eq!(response.lifecycle, Lifecycle::Running);
        }
        assert_eq!(
            structured_exchange(shared, Request::status().to_json().unwrap()).code,
            "STATUS_OK"
        );
    }

    #[test]
    fn structured_accept_returns_before_work_and_operation_remains_queryable() {
        let shared = SharedControl::new(true);
        let epoch =
            structured_exchange(shared.clone(), Request::status().to_json().unwrap()).node_epoch;
        let mut request = Request {
            schema_version: SCHEMA_VERSION,
            action: Action::Migrate,
            node_epoch: Some(epoch),
            operation_id: Some("socket-operation".into()),
            target: Some("localhost:9102".into()),
        };
        let accepted = structured_exchange(shared.clone(), request.to_json().unwrap());
        assert_eq!(accepted.code, "ACCEPTED");
        // No VM worker is present, so a legacy-style wait would time out.
        assert_eq!(shared.requested_target().as_deref(), Some("localhost:9102"));
        assert_eq!(
            structured_exchange(shared.clone(), request.to_json().unwrap()).operation,
            accepted.operation
        );
        shared.workload_finished(
            Completion::CommitUncertain,
            "acknowledgement not received".into(),
        );
        request.action = Action::Operation;
        request.target = None;
        let result = structured_exchange(shared, request.to_json().unwrap());
        assert_eq!(result.code, "COMMIT_UNCERTAIN");
        assert_eq!(result.ownership, Ownership::Retired);
    }

    #[test]
    fn oversized_control_frame_is_rejected_before_receiving_payload() {
        for frame_type in [23, 24] {
            let shared = SharedControl::new(true);
            let (mut client, worker) = connection_pair(shared.clone());
            let mut header = vec![frame_type];
            header.extend_from_slice(
                &((weave_core::wire::MAX_CONTROL_FRAME + 1) as u32).to_le_bytes(),
            );
            client.write_all(&header).unwrap();
            let mut byte = [0];
            assert_eq!(client.read(&mut byte).unwrap(), 0);
            let error = worker.join().unwrap().unwrap_err();
            assert!(format!("{error:#}").contains("control"), "{error:#}");
            assert_eq!(shared.requested_target(), None);
        }
    }

    #[test]
    fn fragmented_control_frame_is_reassembled() {
        let shared = SharedControl::new(false);
        let (mut client, worker) = connection_pair(shared);
        let mut bytes = vec![];
        Frame::CtlRequest {
            json: Request::status().to_json().unwrap(),
        }
        .write_to(&mut bytes)
        .unwrap();
        for part in bytes.chunks(2) {
            client.write_all(part).unwrap();
        }
        let Frame::CtlResponse { json } = Frame::read_from(&mut client).unwrap() else {
            panic!("structured response missing");
        };
        assert_eq!(Response::from_json(&json).unwrap().code, "STATUS_OK");
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn legacy_status_frame_remains_supported() {
        let (mut client, worker) = connection_pair(SharedControl::new(true));
        Frame::CtlStatus.write_to(&mut client).unwrap();
        assert!(
            matches!(Frame::read_from(&mut client).unwrap(), Frame::CtlOk { msg } if msg == "running")
        );
        worker.join().unwrap().unwrap();
    }

    #[test]
    fn legacy_migration_result_uses_event_not_misleading_message_prefix() {
        let shared = SharedControl::new(true);
        let (mut client, worker) = connection_pair(shared.clone());
        Frame::CtlMigrate {
            target: "localhost:9102".into(),
        }
        .write_to(&mut client)
        .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while shared.requested_target().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        assert!(shared.requested_target().is_some());
        shared.workload_finished(
            Completion::CommitUncertain,
            "migrated: deliberately misleading".into(),
        );
        assert!(matches!(
            Frame::read_from(&mut client).unwrap(),
            Frame::CtlErr { .. }
        ));
        worker.join().unwrap().unwrap();
    }

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
        assert_eq!(server.write_timeout().unwrap(), Some(INITIAL_FRAME_TIMEOUT));
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
        assert!(!control_result_succeeded(migration_completion(&stats)));
        assert_eq!(migration_marker(&stats), "WEAVE_MIGRATED_UNCONFIRMED");
    }
}
