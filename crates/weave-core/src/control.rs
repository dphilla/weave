//! Versioned, bounded node control shared by runtime adapters.
//!
//! The operation ledger belongs to one random node epoch. Accepted IDs are
//! never evicted or re-executed in that epoch: when full it fails closed.
//! It is not durable storage, authorization, or proof of target ownership.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_OPERATIONS: usize = 256;
pub const MAX_OPERATION_ID: usize = 128;
pub const MAX_TARGET: usize = 4096;
pub const MAX_MESSAGE: usize = 2048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Status,
    Migrate,
    Operation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema_version: u32,
    pub action: Action,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_epoch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl Request {
    pub fn status() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            action: Action::Status,
            node_epoch: None,
            operation_id: None,
            target: None,
        }
    }

    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > crate::wire::MAX_CONTROL_FRAME {
            bail!("control request exceeds frame limit");
        }
        serde_json::from_slice(bytes).context("invalid structured control request")
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        bounded_json(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lifecycle {
    Idle,
    Accepting,
    Running,
    Migrating,
    Completed,
    Failed,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ownership {
    Retained,
    Retired,
    None,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Retry {
    Never,
    SameOperation,
    NewOperation,
    InspectOwnership,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationState {
    Accepted,
    Succeeded,
    Failed,
    Uncertain,
}

/// Runtime events, never inferred by parsing human-readable messages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Completion {
    Migrated,
    CommitUncertain,
    FailedBeforeCommit,
    WorkloadCompleted,
    WorkloadTrapped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    pub operation_id: String,
    pub target: String,
    pub state: OperationState,
    pub code: String,
    pub ownership: Ownership,
    pub retry: Retry,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportCapability {
    pub module: String,
    pub name: String,
    pub params: Vec<String>,
    pub results: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Limits {
    pub control_frame_bytes: usize,
    pub retained_operations: usize,
    pub operation_id_bytes: usize,
    /// Null means the embedding does not advertise a configured limit.
    pub memory_bytes: Option<u64>,
    pub module_bytes: Option<u64>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            control_frame_bytes: crate::wire::MAX_CONTROL_FRAME,
            retained_operations: MAX_OPERATIONS,
            operation_id_bytes: MAX_OPERATION_ID,
            memory_bytes: None,
            module_bytes: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capabilities {
    pub runtime: String,
    pub adapter_version: String,
    pub migration_protocol: u32,
    /// Null means unknown/custom; an empty array means explicitly none.
    pub services: Option<Vec<String>>,
    /// Actual workload imports supplied by this embedding, or unknown.
    pub imports: Option<Vec<ImportCapability>>,
    pub features: Vec<String>,
    pub limits: Limits,
}

impl Capabilities {
    pub fn unknown(runtime: impl Into<String>) -> Self {
        Self {
            runtime: runtime.into(),
            adapter_version: env!("CARGO_PKG_VERSION").into(),
            migration_protocol: u32::from(crate::wire::PROTO_VERSION),
            services: None,
            imports: None,
            features: Vec::new(),
            limits: Limits::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Response {
    pub schema_version: u32,
    pub ok: bool,
    pub code: String,
    pub message: String,
    pub node_epoch: String,
    pub lifecycle: Lifecycle,
    pub ownership: Ownership,
    pub retry: Retry,
    pub operation: Option<Operation>,
    pub capabilities: Option<Capabilities>,
}

impl Response {
    pub fn from_json(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > crate::wire::MAX_CONTROL_FRAME {
            bail!("control response exceeds frame limit");
        }
        let response: Self =
            serde_json::from_slice(bytes).context("invalid structured control response")?;
        if response.schema_version != SCHEMA_VERSION {
            bail!(
                "unsupported control response schema version {}",
                response.schema_version
            );
        }
        Ok(response)
    }

    pub fn to_json(&self) -> Result<Vec<u8>> {
        bounded_json(self)
    }
}

fn bounded_json(value: &impl Serialize) -> Result<Vec<u8>> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > crate::wire::MAX_CONTROL_FRAME {
        bail!("structured control JSON exceeds frame limit");
    }
    Ok(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptedMigration {
    pub operation_id: String,
    pub target: String,
}

pub struct ControlState {
    node_epoch: String,
    capabilities: Capabilities,
    lifecycle: Lifecycle,
    ownership: Ownership,
    operations: BTreeMap<String, Operation>,
    active_operation: Option<String>,
}

impl ControlState {
    pub fn new(capabilities: Capabilities, lifecycle: Lifecycle) -> Result<Self> {
        // Leave space for the largest bounded operation/message in status.
        if serde_json::to_vec(&capabilities)?.len() > crate::wire::MAX_CONTROL_FRAME / 2 {
            bail!("control capability advertisement exceeds 32 KiB limit");
        }
        let mut entropy = [0u8; 16];
        getrandom::fill(&mut entropy)
            .map_err(|error| anyhow::anyhow!("generating node epoch: {error}"))?;
        let epoch = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
        let state = Self::with_epoch(capabilities, lifecycle, epoch);
        // Reject oversized capability advertisements at startup, not on a query.
        state.status().to_json()?;
        Ok(state)
    }

    fn with_epoch(capabilities: Capabilities, lifecycle: Lifecycle, node_epoch: String) -> Self {
        Self {
            node_epoch,
            capabilities,
            lifecycle,
            ownership: ownership_for(lifecycle),
            operations: BTreeMap::new(),
            active_operation: None,
        }
    }

    pub fn node_epoch(&self) -> &str {
        &self.node_epoch
    }

    pub fn lifecycle(&self) -> Lifecycle {
        self.lifecycle
    }

    pub fn set_lifecycle(&mut self, lifecycle: Lifecycle) {
        self.lifecycle = lifecycle;
        self.ownership = ownership_for(lifecycle);
    }

    pub fn status(&self) -> Response {
        let mut response = self.response(true, "STATUS_OK", "node status", Retry::Never);
        response.capabilities = Some(self.capabilities.clone());
        response.operation = self
            .active_operation
            .as_ref()
            .and_then(|id| self.operations.get(id))
            .cloned();
        response
    }

    pub fn invalid_request(&self, message: impl Into<String>) -> Response {
        self.response(false, "INVALID_REQUEST", message, Retry::Never)
    }

    /// Returns a migration only for the first acceptance. The adapter must
    /// reserve it under the same lock before another request can run.
    pub fn handle(
        &mut self,
        request: Request,
        can_migrate: bool,
    ) -> (Response, Option<AcceptedMigration>) {
        let error = |this: &Self, code, message: &str, retry| {
            (this.response(false, code, message, retry), None)
        };
        if request.schema_version != SCHEMA_VERSION {
            return error(
                self,
                "UNSUPPORTED_SCHEMA",
                "unsupported control schema version",
                Retry::Never,
            );
        }
        if request.action == Action::Status {
            return if request.node_epoch.is_some()
                || request.operation_id.is_some()
                || request.target.is_some()
            {
                error(
                    self,
                    "INVALID_REQUEST",
                    "status does not accept operation fields",
                    Retry::Never,
                )
            } else {
                (self.status(), None)
            };
        }
        if request.node_epoch.as_deref() != Some(self.node_epoch.as_str()) {
            return error(self, "NODE_EPOCH_MISMATCH", "node epoch is missing or changed; inspect ownership before submitting a new operation", Retry::InspectOwnership);
        }
        let Some(id) = request
            .operation_id
            .as_deref()
            .filter(|id| valid_operation_id(id))
        else {
            return error(
                self,
                "INVALID_REQUEST",
                "operation_id must be 1..128 ASCII letters, digits, '.', '_' or '-'",
                Retry::Never,
            );
        };
        if request.action == Action::Operation {
            if request.target.is_some() {
                return error(
                    self,
                    "INVALID_REQUEST",
                    "operation lookup does not accept target",
                    Retry::Never,
                );
            }
            return match self.operations.get(id) {
                Some(operation) => (self.operation_response(operation), None),
                None => error(
                    self,
                    "OPERATION_NOT_FOUND",
                    "operation was not accepted in this node epoch",
                    Retry::SameOperation,
                ),
            };
        }
        let Some(target) = request
            .target
            .as_deref()
            .filter(|target| valid_target(target))
        else {
            return error(
                self,
                "INVALID_REQUEST",
                "target must be a nonempty host:port address with port 1..65535",
                Retry::Never,
            );
        };
        if let Some(operation) = self.operations.get(id) {
            return if operation.target == target {
                (self.operation_response(operation), None)
            } else {
                error(
                    self,
                    "OPERATION_CONFLICT",
                    "operation_id was already accepted with a different target",
                    Retry::Never,
                )
            };
        }
        if self.operations.len() >= MAX_OPERATIONS {
            return error(
                self,
                "OPERATION_CAPACITY",
                "node operation ledger is full; accepted IDs are never evicted",
                Retry::Never,
            );
        }
        if self.active_operation.is_some()
            || self.lifecycle == Lifecycle::Migrating
            || self.lifecycle == Lifecycle::Accepting
        {
            return error(
                self,
                "NODE_BUSY",
                "node already has an active migration",
                Retry::NewOperation,
            );
        }
        if !can_migrate || self.lifecycle != Lifecycle::Running {
            return error(
                self,
                "NO_ACTIVE_WORKLOAD",
                "node has no active workload",
                Retry::Never,
            );
        }
        let operation = Operation {
            operation_id: id.into(),
            target: target.into(),
            state: OperationState::Accepted,
            code: "ACCEPTED".into(),
            ownership: Ownership::Retained,
            retry: Retry::SameOperation,
            message: "migration accepted; query this operation ID for its outcome".into(),
        };
        let accepted = AcceptedMigration {
            operation_id: id.into(),
            target: target.into(),
        };
        self.active_operation = Some(id.into());
        self.operations.insert(id.into(), operation.clone());
        self.set_lifecycle(Lifecycle::Migrating);
        (self.operation_response(&operation), Some(accepted))
    }

    /// Reflect the irreversible source latch while COMMIT_OK is still pending.
    pub fn source_retired(&mut self) {
        self.lifecycle = Lifecycle::Retired;
        self.ownership = Ownership::Retired;
        if let Some(operation) = self
            .active_operation
            .as_ref()
            .and_then(|id| self.operations.get_mut(id))
        {
            operation.code = "COMMIT_PENDING".into();
            operation.ownership = Ownership::Retired;
            operation.retry = Retry::InspectOwnership;
            operation.message = "source retired; commit confirmation is pending".into();
        }
    }

    pub fn complete(&mut self, completion: Completion, message: impl Into<String>) {
        // Even a misordered adapter callback must not undo the source latch.
        let completion = if completion == Completion::FailedBeforeCommit
            && self
                .active_operation
                .as_ref()
                .and_then(|id| self.operations.get(id))
                .is_some_and(|operation| operation.ownership == Ownership::Retired)
        {
            Completion::CommitUncertain
        } else {
            completion
        };
        let (state, code, lifecycle, ownership, retry) = match completion {
            Completion::Migrated => (
                OperationState::Succeeded,
                "MIGRATED",
                Lifecycle::Retired,
                Ownership::Retired,
                Retry::Never,
            ),
            Completion::CommitUncertain => (
                OperationState::Uncertain,
                "COMMIT_UNCERTAIN",
                Lifecycle::Retired,
                Ownership::Retired,
                Retry::InspectOwnership,
            ),
            Completion::FailedBeforeCommit => (
                OperationState::Failed,
                "MIGRATION_FAILED",
                Lifecycle::Running,
                Ownership::Retained,
                Retry::NewOperation,
            ),
            Completion::WorkloadCompleted => (
                OperationState::Failed,
                "WORKLOAD_COMPLETED",
                Lifecycle::Completed,
                Ownership::None,
                Retry::Never,
            ),
            Completion::WorkloadTrapped => (
                OperationState::Failed,
                "WORKLOAD_TRAPPED",
                Lifecycle::Failed,
                Ownership::None,
                Retry::Never,
            ),
        };
        self.lifecycle = lifecycle;
        self.ownership = ownership;
        if let Some(operation) = self
            .active_operation
            .take()
            .and_then(|id| self.operations.get_mut(&id))
        {
            operation.state = state;
            operation.code = code.into();
            operation.ownership = ownership;
            operation.retry = retry;
            operation.message = bounded_message(message.into());
        }
    }

    fn operation_response(&self, operation: &Operation) -> Response {
        let ok = matches!(
            operation.state,
            OperationState::Accepted | OperationState::Succeeded
        );
        let mut response = self.response(ok, &operation.code, &operation.message, operation.retry);
        response.operation = Some(operation.clone());
        response
    }

    fn response(&self, ok: bool, code: &str, message: impl Into<String>, retry: Retry) -> Response {
        Response {
            schema_version: SCHEMA_VERSION,
            ok,
            code: code.into(),
            message: bounded_message(message.into()),
            node_epoch: self.node_epoch.clone(),
            lifecycle: self.lifecycle,
            ownership: self.ownership,
            retry,
            operation: None,
            capabilities: None,
        }
    }
}

fn ownership_for(lifecycle: Lifecycle) -> Ownership {
    match lifecycle {
        Lifecycle::Running | Lifecycle::Migrating => Ownership::Retained,
        Lifecycle::Retired => Ownership::Retired,
        _ => Ownership::None,
    }
}

pub fn valid_operation_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_OPERATION_ID
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

pub fn valid_target(target: &str) -> bool {
    if target.is_empty()
        || target.len() > MAX_TARGET
        || target
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return false;
    }
    let Some((host, port)) = target.rsplit_once(':') else {
        return false;
    };
    let valid_host = if host.starts_with('[') {
        host.strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .is_some_and(|host| host.parse::<std::net::Ipv6Addr>().is_ok())
    } else {
        !host.is_empty() && !host.contains([':', '[', ']'])
    };
    valid_host
        && !port.is_empty()
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0)
}

fn bounded_message(mut message: String) -> String {
    if message.len() > MAX_MESSAGE {
        let mut end = MAX_MESSAGE;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    message
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> ControlState {
        ControlState::with_epoch(
            Capabilities::unknown("test"),
            Lifecycle::Running,
            "epoch".into(),
        )
    }
    fn migrate(id: &str) -> Request {
        Request {
            schema_version: 1,
            action: Action::Migrate,
            node_epoch: Some("epoch".into()),
            operation_id: Some(id.into()),
            target: Some("localhost:9000".into()),
        }
    }
    fn lookup(id: &str) -> Request {
        let mut request = migrate(id);
        request.action = Action::Operation;
        request.target = None;
        request
    }

    #[test]
    fn repeated_ids_return_the_retained_operation_and_never_reexecute() {
        let mut state = state();
        assert!(state.handle(migrate("one"), true).1.is_some());
        assert!(state.handle(migrate("one"), true).1.is_none());
        state.complete(Completion::FailedBeforeCommit, "not reachable");
        let (result, dispatch) = state.handle(migrate("one"), true);
        assert!(dispatch.is_none());
        assert_eq!(result.code, "MIGRATION_FAILED");
        assert_eq!(result.retry, Retry::NewOperation);
        let mut conflict = migrate("one");
        conflict.target = Some("localhost:9001".into());
        assert_eq!(state.handle(conflict, true).0.code, "OPERATION_CONFLICT");
        assert!(state.handle(migrate("two"), true).1.is_some());
        assert_eq!(state.handle(lookup("one"), true).0.code, "MIGRATION_FAILED");
    }

    #[test]
    fn full_ledger_fails_closed_without_evicting_old_ids() {
        let mut state = state();
        for index in 0..MAX_OPERATIONS {
            assert!(state
                .handle(migrate(&format!("op-{index}")), true)
                .1
                .is_some());
            state.complete(Completion::FailedBeforeCommit, "failure");
        }
        assert_eq!(
            state.handle(migrate("overflow"), true).0.code,
            "OPERATION_CAPACITY"
        );
        assert_eq!(
            state.handle(migrate("op-0"), true).0.code,
            "MIGRATION_FAILED"
        );
        assert_eq!(state.operations.len(), MAX_OPERATIONS);
    }

    #[test]
    fn epoch_mismatch_unknown_id_and_validation_do_not_reserve() {
        let mut state = state();
        let mut request = migrate("one");
        request.node_epoch = Some("old-epoch".into());
        assert_eq!(state.handle(request, true).0.code, "NODE_EPOCH_MISMATCH");
        assert_eq!(
            state.handle(lookup("unknown"), true).0.code,
            "OPERATION_NOT_FOUND"
        );
        for id in ["", "space here", "../../", "☃"] {
            assert_eq!(state.handle(migrate(id), true).0.code, "INVALID_REQUEST");
        }
        assert!(state.operations.is_empty());
        for target in [
            "",
            "localhost",
            "localhost:0",
            "localhost:65536",
            " localhost:1",
            "host\n:1",
        ] {
            assert!(!valid_target(target));
        }
        assert!(valid_target("[::1]:9000"));
    }

    #[test]
    fn typed_events_preserve_uncertain_ownership_and_ignore_message_wording() {
        let mut state = state();
        state.handle(migrate("one"), true);
        state.source_retired();
        let pending = state.handle(lookup("one"), false).0;
        assert_eq!(pending.lifecycle, Lifecycle::Retired);
        assert_eq!(pending.ownership, Ownership::Retired);
        assert_eq!(pending.code, "COMMIT_PENDING");
        state.complete(
            Completion::CommitUncertain,
            "migrated: misleading human text",
        );
        let result = state.handle(lookup("one"), false).0;
        assert!(!result.ok);
        assert_eq!(result.code, "COMMIT_UNCERTAIN");
        assert_eq!(result.retry, Retry::InspectOwnership);
        assert_eq!(result.operation.unwrap().ownership, Ownership::Retired);
        state.set_lifecycle(Lifecycle::Running);
        assert_eq!(state.handle(lookup("one"), true).0.code, "COMMIT_UNCERTAIN");
    }

    #[test]
    fn every_completion_has_explicit_state_and_source_ownership() {
        for (completion, lifecycle, ownership, code) in [
            (
                Completion::Migrated,
                Lifecycle::Retired,
                Ownership::Retired,
                "MIGRATED",
            ),
            (
                Completion::FailedBeforeCommit,
                Lifecycle::Running,
                Ownership::Retained,
                "MIGRATION_FAILED",
            ),
            (
                Completion::WorkloadCompleted,
                Lifecycle::Completed,
                Ownership::None,
                "WORKLOAD_COMPLETED",
            ),
            (
                Completion::WorkloadTrapped,
                Lifecycle::Failed,
                Ownership::None,
                "WORKLOAD_TRAPPED",
            ),
        ] {
            let mut state = state();
            state.handle(migrate("one"), true);
            state.complete(completion, "anything");
            let result = state.handle(lookup("one"), true).0;
            assert_eq!(
                (result.lifecycle, result.ownership, result.code.as_str()),
                (lifecycle, ownership, code)
            );
        }
    }

    #[test]
    fn json_is_strict_bounded_and_versioned() {
        for bytes in [
            br#"{"schema_version":1,"action":"status","extra":true}"#.as_slice(),
            br#"{"schema_version":1,"schema_version":1,"action":"status"}"#,
            b"null",
            b"[]",
            b"{}",
            b"\xff",
        ] {
            assert!(Request::from_json(bytes).is_err());
        }
        let mut state = state();
        let mut request = Request::status();
        request.schema_version = 2;
        assert_eq!(state.handle(request, true).0.code, "UNSUPPORTED_SCHEMA");
        let response = state.status();
        assert_eq!(
            Response::from_json(&response.to_json().unwrap())
                .unwrap()
                .schema_version,
            1
        );
        assert!(response.capabilities.unwrap().services.is_none());
        state.handle(migrate("one"), true);
        state.complete(Completion::FailedBeforeCommit, "☃".repeat(MAX_MESSAGE));
        let response = state.handle(lookup("one"), true).0;
        assert!(response.message.len() <= MAX_MESSAGE);
        assert!(response.to_json().unwrap().len() < crate::wire::MAX_CONTROL_FRAME);
    }

    #[test]
    fn epochs_are_random_per_node_lifetime() {
        let first = ControlState::new(Capabilities::unknown("test"), Lifecycle::Idle).unwrap();
        let second = ControlState::new(Capabilities::unknown("test"), Lifecycle::Idle).unwrap();
        assert_eq!(first.node_epoch().len(), 32);
        assert_ne!(first.node_epoch(), second.node_epoch());
    }

    #[test]
    fn unsupported_or_misplaced_fields_and_busy_nodes_never_consume_ids() {
        let mut state = state();
        let mut request = Request::status();
        request.operation_id = Some("unused".into());
        assert_eq!(state.handle(request, true).0.code, "INVALID_REQUEST");
        let mut request = lookup("unused");
        request.target = Some("localhost:9000".into());
        assert_eq!(state.handle(request, true).0.code, "INVALID_REQUEST");
        let mut request = migrate("unused");
        request.target = None;
        assert_eq!(state.handle(request, true).0.code, "INVALID_REQUEST");
        state.set_lifecycle(Lifecycle::Accepting);
        assert_eq!(state.handle(migrate("unused"), true).0.code, "NODE_BUSY");
        state.set_lifecycle(Lifecycle::Idle);
        assert_eq!(
            state.handle(migrate("unused"), false).0.code,
            "NO_ACTIVE_WORKLOAD"
        );
        assert!(state.operations.is_empty());
        state.set_lifecycle(Lifecycle::Running);
        assert!(state.handle(migrate("unused"), true).1.is_some());
    }

    #[test]
    fn retirement_cannot_be_reversed_by_a_misordered_failure_event() {
        let mut state = state();
        state.handle(migrate("one"), true);
        state.source_retired();
        state.complete(Completion::FailedBeforeCommit, "stale failure");
        let response = state.handle(lookup("one"), false).0;
        assert_eq!(response.code, "COMMIT_UNCERTAIN");
        assert_eq!(response.ownership, Ownership::Retired);
        assert_eq!(response.operation.unwrap().ownership, Ownership::Retired);
    }

    #[test]
    fn capability_bounds_preserve_room_for_the_largest_active_record() {
        let mut capabilities = Capabilities::unknown("test");
        capabilities
            .features
            .push("x".repeat(crate::wire::MAX_CONTROL_FRAME / 2));
        assert!(ControlState::new(capabilities, Lifecycle::Running).is_err());
        let mut capabilities = Capabilities::unknown("test");
        capabilities.features.push("x".repeat(30 * 1024));
        let mut state = ControlState::new(capabilities, Lifecycle::Running).unwrap();
        let request = Request {
            node_epoch: Some(state.node_epoch().into()),
            target: Some(format!("{}:1", "\"".repeat(MAX_TARGET - 2))),
            operation_id: Some("x".repeat(MAX_OPERATION_ID)),
            ..migrate("unused")
        };
        assert!(state.handle(request, true).1.is_some());
        assert!(state.status().to_json().unwrap().len() <= crate::wire::MAX_CONTROL_FRAME);
    }

    #[test]
    fn address_and_operation_id_limits_are_exact() {
        assert!(valid_operation_id(&"x".repeat(MAX_OPERATION_ID)));
        assert!(!valid_operation_id(&"x".repeat(MAX_OPERATION_ID + 1)));
        assert!(valid_target(&format!("{}:1", "x".repeat(MAX_TARGET - 2))));
        assert!(!valid_target(&format!("{}:1", "x".repeat(MAX_TARGET - 1))));
        for target in [
            "host:+1",
            "host:-1",
            "host:1.0",
            "host:１",
            "host:",
            "::1:9000",
            "[bad]:9000",
            "[]:9000",
            "host]:9000",
            "[::1:9000",
        ] {
            assert!(!valid_target(target), "accepted invalid target {target}");
        }
        for target in [
            "localhost:1",
            "127.0.0.1:65535",
            "[::1]:9000",
            "[2001:db8::1]:1",
        ] {
            assert!(valid_target(target), "rejected valid target {target}");
        }
    }
}
