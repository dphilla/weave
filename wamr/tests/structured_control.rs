//! Agent-style requests against real child-process WAMR nodes and a genuine
//! transformed guest. These are bounded local tests, not public network access.

use anyhow::{anyhow, bail, Context, Result};
use std::io::{BufRead, BufReader};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use weave_core::control::{Action, Lifecycle, OperationState, Ownership, Request, Response};
use weave_core::wire::Frame;

struct Node {
    child: Child,
    address: String,
    stderr: Option<JoinHandle<()>>,
    fixture: Option<PathBuf>,
}

impl Drop for Node {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(stderr) = self.stderr.take() {
            let _ = stderr.join();
        }
        if let Some(path) = &self.fixture {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Node {
    fn start(workload: bool) -> Result<Self> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_weave-wamr"));
        command.args(["serve", "--listen", "127.0.0.1:0"]);
        let fixture = if workload {
            let raw = wat::parse_str("(module (func (export \"run\") (loop $again br $again)))")?;
            let woven = weave_transform::transform(
                &raw,
                &weave_transform::TransformOptions {
                    poll_period: 1,
                    stack_pages: 1,
                },
            )?;
            let nonce = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "weave-wamr-control-{}-{nonce}.wasm",
                std::process::id()
            ));
            std::fs::write(&path, woven.wasm)?;
            command.arg("--module").arg(&path).args(["--invoke", "run"]);
            Some(path)
        } else {
            None
        };
        let mut child = command
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()?;
        let stderr = child.stderr.take().context("missing child stderr")?;
        let (ready_tx, ready_rx) = mpsc::channel();
        let stderr = std::thread::spawn(move || {
            for line in BufReader::new(stderr)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if let Some(address) = line.strip_prefix("weave-wamr: listening on ") {
                    let _ = ready_tx.send(address.to_owned());
                }
                eprintln!("child: {line}");
            }
        });
        let mut node = Self {
            child,
            address: String::new(),
            stderr: Some(stderr),
            fixture,
        };
        node.address = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .context("WAMR did not listen")?;
        Ok(node)
    }

    fn request(&self, request: Request) -> Result<Response> {
        let mut connection = TcpStream::connect(&self.address)?;
        deadlines(&connection)?;
        Frame::CtlRequest {
            json: request.to_json()?,
        }
        .write_to(&mut connection)?;
        match Frame::read_from(&mut connection)? {
            Frame::CtlResponse { json } => Response::from_json(&json),
            frame => bail!("unexpected control response {frame:?}"),
        }
    }

    fn migration(&self, id: &str, target: &str) -> Result<Request> {
        Ok(Request {
            schema_version: 1,
            action: Action::Migrate,
            node_epoch: Some(self.request(Request::status())?.node_epoch),
            operation_id: Some(id.into()),
            target: Some(target.into()),
        })
    }

    fn outcome(&self, migration: &Request) -> Result<Response> {
        let mut lookup = migration.clone();
        lookup.action = Action::Operation;
        lookup.target = None;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let response = self.request(lookup.clone())?;
            if response
                .operation
                .as_ref()
                .is_some_and(|operation| operation.state != OperationState::Accepted)
            {
                return Ok(response);
            }
            if Instant::now() >= deadline {
                bail!("operation did not finish: {response:?}");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn deadlines(connection: &TcpStream) -> Result<()> {
    connection.set_read_timeout(Some(Duration::from_secs(5)))?;
    connection.set_write_timeout(Some(Duration::from_secs(5)))?;
    Ok(())
}

#[test]
fn actual_node_rejected_migration_is_retained_and_idempotent() -> Result<()> {
    let source = Node::start(true)?;
    let unused = TcpListener::bind("127.0.0.1:0")?;
    let target = unused.local_addr()?.to_string();
    drop(unused);
    let migration = source.migration("connection-refused", &target)?;
    assert_eq!(source.request(migration.clone())?.code, "ACCEPTED");
    let failure = source.outcome(&migration)?;
    assert_eq!(failure.code, "MIGRATION_FAILED");
    assert_eq!(failure.lifecycle, Lifecycle::Running);
    assert_eq!(failure.ownership, Ownership::Retained);
    assert_eq!(source.request(migration)?.operation, failure.operation);
    assert_eq!(
        source.request(Request::status())?.lifecycle,
        Lifecycle::Running
    );
    Ok(())
}

#[test]
fn actual_migration_succeeds_and_retires_only_source_authority() -> Result<()> {
    let target = Node::start(false)?;
    let source = Node::start(true)?;
    let migration = source.migration("confirmed", &target.address)?;
    assert_eq!(source.request(migration.clone())?.code, "ACCEPTED");
    let result = source.outcome(&migration)?;
    assert_eq!(result.code, "MIGRATED");
    assert_eq!(result.lifecycle, Lifecycle::Retired);
    assert_eq!(result.ownership, Ownership::Retired);
    assert_eq!(source.request(migration)?.operation, result.operation);
    assert_eq!(
        target.request(Request::status())?.lifecycle,
        Lifecycle::Running
    );
    assert_eq!(
        target.request(Request::status())?.ownership,
        Ownership::Retained
    );
    Ok(())
}

#[test]
fn actual_commit_pending_and_lost_ack_remain_retired() -> Result<()> {
    let target = Node::start(false)?;
    let source = Node::start(true)?;
    let proxy_listener = TcpListener::bind("127.0.0.1:0")?;
    proxy_listener.set_nonblocking(true)?;
    let proxy_address = proxy_listener.local_addr()?.to_string();
    let target_address = target.address.clone();
    let (commit_tx, commit_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let proxy = std::thread::spawn(move || -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        let (source, _) = loop {
            match proxy_listener.accept() {
                Ok(connection) => break connection,
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock
                        && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(1))
                }
                Err(error) => return Err(error.into()),
            }
        };
        let target = TcpStream::connect(target_address)?;
        // Darwin may inherit the listener's nonblocking flag on accepted sockets.
        source.set_nonblocking(false)?;
        deadlines(&source)?;
        deadlines(&target)?;
        let mut from_source = source.try_clone()?;
        let mut to_target = target.try_clone()?;
        let outbound = std::thread::spawn(move || -> Result<()> {
            while let Ok(frame) = Frame::read_from(&mut from_source) {
                if matches!(frame, Frame::Commit) {
                    commit_tx.send(())?;
                    release_rx.recv_timeout(Duration::from_secs(5))?;
                }
                frame.write_to(&mut to_target)?;
            }
            Ok(())
        });
        let mut from_target = target.try_clone()?;
        let mut to_source = source.try_clone()?;
        let received_ack = loop {
            match Frame::read_from(&mut from_target) {
                Ok(Frame::CommitOk) => break true, // Deliberately lose confirmation.
                Ok(frame) => frame.write_to(&mut to_source)?,
                Err(_) => break false,
            }
        };
        let _ = source.shutdown(Shutdown::Both);
        let _ = target.shutdown(Shutdown::Both);
        outbound
            .join()
            .map_err(|_| anyhow!("proxy forwarding thread panicked"))??;
        anyhow::ensure!(received_ack, "target never sent COMMIT_OK");
        Ok(())
    });
    let migration = source.migration("lost-ack", &proxy_address)?;
    assert_eq!(source.request(migration.clone())?.code, "ACCEPTED");
    commit_rx
        .recv_timeout(Duration::from_secs(5))
        .context("source never attempted COMMIT")?;
    let pending = source.request(Request::status())?;
    assert_eq!(pending.lifecycle, Lifecycle::Retired);
    assert_eq!(pending.ownership, Ownership::Retired);
    assert_eq!(
        pending.operation.context("pending operation missing")?.code,
        "COMMIT_PENDING"
    );
    release_tx.send(())?;
    let result = source.outcome(&migration)?;
    assert_eq!(result.code, "COMMIT_UNCERTAIN");
    assert_eq!(result.lifecycle, Lifecycle::Retired);
    assert_eq!(result.ownership, Ownership::Retired);
    assert_eq!(
        target.request(Request::status())?.lifecycle,
        Lifecycle::Running
    );
    proxy
        .join()
        .map_err(|_| anyhow!("proxy thread panicked"))??;
    Ok(())
}

#[test]
fn process_epoch_changes_and_stale_authorization_is_rejected() -> Result<()> {
    let first = Node::start(false)?;
    let first_epoch = first.request(Request::status())?.node_epoch;
    drop(first);
    let second = Node::start(false)?;
    assert_ne!(second.request(Request::status())?.node_epoch, first_epoch);
    let stale = Request {
        schema_version: 1,
        action: Action::Operation,
        node_epoch: Some(first_epoch),
        operation_id: Some("old-operation".into()),
        target: None,
    };
    assert_eq!(second.request(stale)?.code, "NODE_EPOCH_MISMATCH");
    Ok(())
}
