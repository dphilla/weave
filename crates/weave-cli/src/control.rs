//! One deadline covers DNS, connecting, all bytes, and optional polling.
use super::{cli_error, Args, Reported};
use anyhow::{bail, Context, Result};
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use weave_core::control::{Action, OperationState, Request, Response, Retry, SCHEMA_VERSION};
use weave_core::wire::{Frame, MAX_CONTROL_FRAME};

pub(crate) fn deadline(args: &Args, default_ms: u64) -> Instant {
    Instant::now()
        + Duration::from_millis(
            args.flag("timeout-ms")
                .and_then(|s| s.parse().ok())
                .unwrap_or(default_ms),
        )
}
fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "control deadline exceeded"))
}
struct Connection {
    stream: TcpStream,
    deadline: Instant,
}
impl Read for Connection {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.stream
            .set_read_timeout(Some(remaining(self.deadline)?))?;
        self.stream.read(buf)
    }
}
impl Write for Connection {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.stream
            .set_write_timeout(Some(remaining(self.deadline)?))?;
        self.stream.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}
fn connect(node: &str, deadline: Instant) -> Result<Connection> {
    if !weave_core::control::valid_target(node) {
        return Err(cli_error(
            "USAGE_ERROR",
            2,
            "--node must be a host:port address (port 1..65535)",
        ));
    }
    // System resolvers may block independently of socket timeouts. This worker
    // only resolves names: after a timeout it can never send a control request.
    let node = node.to_owned();
    let (tx, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let _ = tx.send(node.to_socket_addrs().map(|iter| iter.collect::<Vec<_>>()));
    });
    let addresses = rx
        .recv_timeout(remaining(deadline)?)
        .context("resolving node within control deadline")??;
    let mut error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, remaining(deadline)?) {
            Ok(stream) => {
                stream.set_nodelay(true)?;
                return Ok(Connection { stream, deadline });
            }
            Err(e) => error = Some(e),
        }
    }
    Err(error
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "node resolved to no addresses"))
        .into())
}
fn read_reply(conn: &mut Connection) -> Result<Frame> {
    let mut header = [0u8; 5];
    conn.read_exact(&mut header)?;
    let len = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
    if len > MAX_CONTROL_FRAME {
        bail!("control reply exceeds 65536-byte limit");
    }
    if !matches!(header[0], 19 | 20 | 24) {
        bail!("unexpected control reply type {}", header[0]);
    }
    let mut packet = header.to_vec();
    packet.resize(5 + len, 0);
    conn.read_exact(&mut packet[5..])?;
    Frame::read_from(&mut &packet[..])
}
pub(crate) fn exchange(node: &str, request: &Request, deadline: Instant) -> Result<Response> {
    let mut conn = connect(node, deadline).context("connecting to control node")?;
    Frame::CtlRequest {
        json: request.to_json()?,
    }
    .write_to(&mut conn)?;
    match read_reply(&mut conn)? {
        Frame::CtlResponse { json } => {
            let response = Response::from_json(&json)?;
            validate_response(request, &response)?;
            Ok(response)
        },
        _ => bail!("node does not support structured control; no legacy mutation was attempted (use --legacy explicitly if required)"),
    }
}

fn validate_response(request: &Request, response: &Response) -> Result<()> {
    if response.node_epoch.len() != 32
        || !response
            .node_epoch
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("invalid node epoch in control response");
    }
    if request.action == Action::Status {
        if response.ok && (response.code != "STATUS_OK" || response.capabilities.is_none()) {
            bail!("invalid status response");
        }
        return Ok(());
    }
    if Some(response.node_epoch.as_str()) != request.node_epoch.as_deref()
        && response.code != "NODE_EPOCH_MISMATCH"
    {
        bail!("control response node epoch does not match request");
    }
    if response.code == "NODE_EPOCH_MISMATCH" && (response.ok || response.operation.is_some()) {
        bail!("invalid epoch mismatch response");
    }
    if let Some(operation) = &response.operation {
        if Some(operation.operation_id.as_str()) != request.operation_id.as_deref() {
            bail!("control response operation ID does not match request");
        }
        if request
            .target
            .as_ref()
            .is_some_and(|target| target != &operation.target)
        {
            bail!("control response target does not match request");
        }
        if response.code != operation.code
            || response.ok
                != matches!(
                    operation.state,
                    OperationState::Accepted | OperationState::Succeeded
                )
        {
            bail!("inconsistent control operation result");
        }
        let valid = match operation.state {
            OperationState::Accepted => {
                matches!(operation.code.as_str(), "ACCEPTED" | "COMMIT_PENDING")
            }
            OperationState::Succeeded => operation.code == "MIGRATED",
            OperationState::Failed => matches!(
                operation.code.as_str(),
                "MIGRATION_FAILED" | "WORKLOAD_COMPLETED" | "WORKLOAD_TRAPPED"
            ),
            OperationState::Uncertain => operation.code == "COMMIT_UNCERTAIN",
        };
        if !valid {
            bail!("unrecognized operation state/code combination");
        }
        if matches!(
            operation.code.as_str(),
            "COMMIT_PENDING" | "MIGRATED" | "COMMIT_UNCERTAIN"
        ) && operation.ownership != weave_core::control::Ownership::Retired
        {
            bail!("handoff response does not retire source authority");
        }
        use weave_core::control::Ownership;
        let expected = match operation.code.as_str() {
            "ACCEPTED" => (Ownership::Retained, Retry::SameOperation),
            "COMMIT_PENDING" | "COMMIT_UNCERTAIN" => (Ownership::Retired, Retry::InspectOwnership),
            "MIGRATED" => (Ownership::Retired, Retry::Never),
            "MIGRATION_FAILED" => (Ownership::Retained, Retry::NewOperation),
            "WORKLOAD_COMPLETED" | "WORKLOAD_TRAPPED" => (Ownership::None, Retry::Never),
            _ => unreachable!("validated operation code above"),
        };
        if (operation.ownership, operation.retry) != expected || response.retry != operation.retry {
            bail!("control response gives inconsistent ownership or retry guidance");
        }
    } else if response.ok {
        bail!("successful operation response omitted operation record");
    }
    Ok(())
}
pub(crate) fn status(node: &str, deadline: Instant) -> Result<Response> {
    exchange(node, &Request::status(), deadline)
}

fn render(response: &Response, json: bool) -> Result<()> {
    if json {
        println!("{}", serde_json::to_string(response)?);
    } else {
        println!(
            "{}: {} [{}]",
            if response.ok { "ok" } else { "error" },
            response.message,
            response.code
        );
        println!(
            "epoch: {}  lifecycle: {}  source ownership: {}  retry: {}",
            response.node_epoch,
            serde_json::to_value(response.lifecycle)?.as_str().unwrap(),
            serde_json::to_value(response.ownership)?.as_str().unwrap(),
            serde_json::to_value(response.retry)?.as_str().unwrap()
        );
        if let Some(op) = &response.operation {
            println!(
                "operation: {}  target: {}  state: {:?}",
                op.operation_id, op.target, op.state
            );
        }
        if let Some(caps) = &response.capabilities {
            println!(
                "runtime: {}  adapter: {}  protocol: {}",
                caps.runtime, caps.adapter_version, caps.migration_protocol
            );
        }
    }
    Ok(())
}
fn response_exit(response: &Response) -> i32 {
    if response.code == "WAIT_TIMEOUT" {
        6
    } else if response.code == "OBSERVATION_UNCERTAIN"
        || response.code == "COMMIT_UNCERTAIN"
        || response.code == "DELIVERY_UNCERTAIN"
        || response.code == "NODE_EPOCH_MISMATCH"
    {
        5
    } else if response.ok {
        0
    } else {
        4
    }
}
fn output(response: &Response, json: bool) -> Result<()> {
    render(response, json)?;
    let exit = response_exit(response);
    if exit != 0 {
        Err(Reported(exit).into())
    } else {
        Ok(())
    }
}

pub(crate) fn run(cmd: &str, args: &Args) -> Result<()> {
    let node = args.flag("node").unwrap();
    let deadline = deadline(args, if cmd == "migrate" { 120_000 } else { 5_000 });
    if args.has("legacy") {
        let mut conn = connect(node, deadline)?;
        let request = if cmd == "migrate" {
            Frame::CtlMigrate {
                target: args.flag("to").unwrap().into(),
            }
        } else {
            Frame::CtlStatus
        };
        request.write_to(&mut conn)?;
        return match read_reply(&mut conn)? {
            Frame::CtlOk { msg } => {
                println!("ok: {msg}");
                Ok(())
            }
            Frame::CtlErr { msg } => bail!("node error: {msg}"),
            _ => bail!("unexpected legacy response"),
        };
    }
    if cmd == "status" {
        let response = status(node, deadline).map_err(|e| {
            cli_error(
                "CONTROL_UNAVAILABLE",
                4,
                format!("{e:#}; structured control unavailable; no mutation attempted"),
            )
        })?;
        return output(&response, args.has("json"));
    }
    let mut request = Request {
        schema_version: SCHEMA_VERSION,
        action: if cmd == "migrate" {
            Action::Migrate
        } else {
            Action::Operation
        },
        node_epoch: args.flag("node-epoch").map(String::from),
        operation_id: args.flag("operation-id").map(String::from),
        target: args.flag("to").map(String::from),
    };
    if let Some(id) = &request.operation_id {
        if !weave_core::control::valid_operation_id(id) {
            return Err(cli_error(
                "USAGE_ERROR",
                2,
                "invalid --operation-id: use 1..128 ASCII letters, digits, '.', '_' or '-'",
            ));
        }
    }
    if let Some(target) = &request.target {
        if !weave_core::control::valid_target(target) {
            return Err(cli_error(
                "USAGE_ERROR",
                2,
                "--to must be host:port with port 1..65535",
            ));
        }
    }
    // Discovery must succeed before any mutation. Never silently fall back.
    let mut last = status(node, deadline).map_err(|e| {
        cli_error(
            "CONTROL_UNAVAILABLE",
            4,
            format!("{e:#}; discovery failed; no migration submitted"),
        )
    })?;
    if !last.ok {
        return output(&last, args.has("json"));
    }
    if request.node_epoch.is_none() {
        request.node_epoch = Some(last.node_epoch.clone());
    }
    if request.operation_id.is_none() {
        // Fresh random epoch generator also supplies collision-resistant IDs.
        let state = weave_core::control::ControlState::new(
            weave_core::control::Capabilities::unknown("cli"),
            weave_core::control::Lifecycle::Idle,
        )?;
        request.operation_id = Some(format!("cli-{}", state.node_epoch()));
    }
    if !args.has("json") {
        eprintln!(
            "operation: {}  node epoch: {}",
            request.operation_id.as_deref().unwrap(),
            request.node_epoch.as_deref().unwrap()
        );
    }
    let waiting = (cmd == "migrate" && !args.has("no-wait")) || args.has("wait");
    let mut observed = false;
    loop {
        let reply = exchange(node, &request, deadline).and_then(|response| {
            if response
                .operation
                .as_ref()
                .is_some_and(|op| args.flag("to").is_some_and(|target| target != op.target))
            {
                bail!("operation observation target does not match original migration target");
            }
            Ok(response)
        });
        match reply {
            Ok(response) => last = response,
            Err(error) => {
                if observed {
                    last.ok = false;
                    last.code = if Instant::now() >= deadline {
                        "WAIT_TIMEOUT"
                    } else {
                        "OBSERVATION_UNCERTAIN"
                    }
                    .into();
                    last.message = format!("{error:#}; last observed operation is retained below, not a current status; query the same ID and epoch, never assume failure");
                    last.retry = if last.ownership == weave_core::control::Ownership::Retired {
                        Retry::InspectOwnership
                    } else {
                        Retry::SameOperation
                    };
                    return output(&last, args.has("json"));
                }
                // A write may have reached the source. Report identity even if
                // the acknowledgement was lost; do not submit a fresh ID.
                let value = serde_json::json!({"schema_version":1,"ok":false,"code":if cmd == "migrate" {"DELIVERY_UNCERTAIN"} else {"CONTROL_UNAVAILABLE"},"message":format!("{error:#}; query this operation ID and epoch; do not assume failure or restart the source"),"node_epoch":request.node_epoch,"operation_id":request.operation_id,"target":args.flag("to"),"ownership":"unknown","retry":"same_operation"});
                if args.has("json") {
                    println!("{value}");
                } else {
                    eprintln!("{}: {}", value["code"], value["message"]);
                }
                return Err(Reported(if cmd == "migrate" { 5 } else { 4 }).into());
            }
        }
        let pending = last
            .operation
            .as_ref()
            .is_some_and(|op| op.state == OperationState::Accepted);
        observed = last.operation.is_some();
        if !waiting || !last.ok || !pending {
            return output(&last, args.has("json"));
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left <= Duration::from_millis(100) {
            last.ok = false;
            last.code = "WAIT_TIMEOUT".into();
            last.message = "wait deadline reached; operation may still be running; query the same ID and epoch".into();
            last.retry = if last.ownership == weave_core::control::Ownership::Retired {
                Retry::InspectOwnership
            } else {
                Retry::SameOperation
            };
            return output(&last, args.has("json"));
        }
        std::thread::sleep(Duration::from_millis(100));
        request.action = Action::Operation;
        request.target = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expired_deadline_fails_without_socket_work() {
        assert!(remaining(Instant::now() - Duration::from_millis(1)).is_err());
    }
    #[test]
    fn invalid_node_rejected_before_dns() {
        assert!(connect("garbage", Instant::now() + Duration::from_secs(1)).is_err());
    }
}
