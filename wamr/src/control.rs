use anyhow::{bail, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use weave_core::control::{Capabilities, Completion, ControlState, Lifecycle, Request, Response};

struct State {
    active: bool,
    request: Option<String>,
    last_result: Option<String>,
    legacy_reply: Option<mpsc::Sender<(Completion, String)>>,
    structured: ControlState,
    retired: Arc<AtomicBool>,
}

pub struct SharedControl {
    state: Mutex<State>,
}

pub type Shared = Arc<SharedControl>;

impl SharedControl {
    #[cfg(test)]
    pub fn new(active: bool) -> Shared {
        Self::with_capabilities(active, Capabilities::unknown("wamr")).unwrap()
    }

    pub fn with_capabilities(active: bool, capabilities: Capabilities) -> Result<Shared> {
        Ok(Arc::new(Self {
            state: Mutex::new(State {
                active,
                request: None,
                last_result: None,
                legacy_reply: None,
                structured: ControlState::new(
                    capabilities,
                    if active {
                        Lifecycle::Running
                    } else {
                        Lifecycle::Idle
                    },
                )?,
                retired: Arc::new(AtomicBool::new(false)),
            }),
        }))
    }

    fn reflect_retirement(state: &mut State) {
        if state.retired.load(Ordering::Acquire) {
            state.structured.source_retired();
        }
    }

    pub fn retirement_flag(&self) -> Arc<AtomicBool> {
        self.state.lock().unwrap().retired.clone()
    }

    /// Parsing, ledger acceptance, and scheduling share one critical section.
    /// Duplicate operation IDs never schedule the native migration a second time.
    pub fn structured_request(&self, json: &[u8]) -> Response {
        let mut state = self.state.lock().unwrap();
        Self::reflect_retirement(&mut state);
        let request = match Request::from_json(json) {
            Ok(request) => request,
            Err(error) => return state.structured.invalid_request(format!("{error:#}")),
        };
        let can_migrate = state.active && state.request.is_none();
        let (response, accepted) = state.structured.handle(request, can_migrate);
        if let Some(accepted) = accepted {
            state.request = Some(accepted.target);
            state.last_result = None;
        }
        response
    }

    /// Reserve an idle node for one inbound migration.
    pub fn try_reserve_incoming(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.active {
            return false;
        }
        state.active = true;
        state.last_result = None;
        state.retired = Arc::new(AtomicBool::new(false));
        state.structured.set_lifecycle(Lifecycle::Accepting);
        true
    }

    pub fn incoming_committed(&self) {
        self.state
            .lock()
            .unwrap()
            .structured
            .set_lifecycle(Lifecycle::Running);
    }

    pub fn incoming_failed(&self, message: String) {
        let mut state = self.state.lock().unwrap();
        state.active = false;
        state.last_result = Some(message);
        state.structured.set_lifecycle(Lifecycle::Idle);
    }

    pub fn requested_target(&self) -> Option<String> {
        self.state.lock().unwrap().request.clone()
    }

    pub fn request_migration(
        &self,
        target: String,
    ) -> Result<mpsc::Receiver<(Completion, String)>> {
        if target.trim().is_empty() {
            bail!("migration target must not be empty");
        }
        let mut state = self.state.lock().unwrap();
        Self::reflect_retirement(&mut state);
        if !state.active {
            bail!("node is idle; there is no workload to migrate");
        }
        if state.request.is_some() {
            bail!("another migration is already requested");
        }
        if state.structured.lifecycle() != Lifecycle::Running {
            bail!("node is not ready to migrate a workload");
        }
        let (sender, receiver) = mpsc::channel();
        state.request = Some(target);
        state.last_result = None;
        state.legacy_reply = Some(sender);
        state.structured.set_lifecycle(Lifecycle::Migrating);
        Ok(receiver)
    }

    /// Complete a control-requested attempt while retaining the local guest.
    pub fn attempt_failed(&self, message: String) {
        self.workload_finished(Completion::FailedBeforeCommit, message);
    }

    /// Apply a typed runtime result. Only a pre-commit failure retains execution.
    pub fn workload_finished(&self, completion: Completion, message: String) {
        let mut state = self.state.lock().unwrap();
        Self::reflect_retirement(&mut state);
        let completion = if state.retired.load(Ordering::Acquire)
            && completion == Completion::FailedBeforeCommit
        {
            Completion::CommitUncertain
        } else {
            completion
        };
        state.active = completion == Completion::FailedBeforeCommit;
        state.request = None;
        state.last_result = Some(message.clone());
        state.structured.complete(completion, message.clone());
        if let Some(reply) = state.legacy_reply.take() {
            let _ = reply.send((completion, message));
        }
    }

    pub fn status(&self) -> String {
        let state = self.state.lock().unwrap();
        if state.structured.lifecycle() == Lifecycle::Accepting {
            return "accepting".to_owned();
        }
        match (&state.active, &state.request, &state.last_result) {
            (true, Some(target), _) => format!("migrating to {target}"),
            (true, None, Some(last)) => format!("running (last: {last})"),
            (true, None, None) => "running".to_owned(),
            (false, _, Some(last)) => format!("idle (last: {last})"),
            (false, _, None) => "idle".to_owned(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::time::Duration;
    use weave_core::control::{Action, OperationState, Ownership, Retry, SCHEMA_VERSION};

    fn status(shared: &Shared) -> Response {
        shared.structured_request(&Request::status().to_json().unwrap())
    }

    fn request(shared: &Shared, id: &str, target: Option<&str>) -> Request {
        Request {
            schema_version: SCHEMA_VERSION,
            action: if target.is_some() {
                Action::Migrate
            } else {
                Action::Operation
            },
            node_epoch: Some(status(shared).node_epoch),
            operation_id: Some(id.to_owned()),
            target: target.map(str::to_owned),
        }
    }

    fn submit(shared: &Shared, request: Request) -> Response {
        shared.structured_request(&request.to_json().unwrap())
    }

    #[test]
    fn empty_target_is_rejected_without_reserving_control_state() {
        let shared = SharedControl::new(true);

        for target in ["", " \t\n"] {
            let error = shared.request_migration(target.to_owned()).unwrap_err();
            assert!(format!("{error:#}").contains("must not be empty"));
            assert_eq!(shared.requested_target(), None);
            assert_eq!(shared.status(), "running");
        }

        shared
            .request_migration("127.0.0.1:9102".to_owned())
            .expect("a rejected empty target must not wedge the next request");
        assert_eq!(shared.requested_target().as_deref(), Some("127.0.0.1:9102"));
    }

    #[test]
    fn structured_acceptance_is_immediate_and_duplicate_ids_do_not_reexecute() {
        let shared = SharedControl::new(true);
        let migration = request(&shared, "first", Some("127.0.0.1:9102"));
        let first = submit(&shared, migration.clone());
        assert_eq!(first.code, "ACCEPTED");
        assert_eq!(first.lifecycle, Lifecycle::Migrating);
        assert_eq!(first.ownership, Ownership::Retained);
        assert_eq!(
            submit(&shared, migration.clone()).operation,
            first.operation
        );
        shared.attempt_failed("deliberate connection refusal".into());
        let repeat = submit(&shared, migration);
        assert_eq!(repeat.code, "MIGRATION_FAILED");
        assert_eq!(repeat.operation.unwrap().state, OperationState::Failed);
        assert_eq!(shared.requested_target(), None);
        assert_eq!(status(&shared).lifecycle, Lifecycle::Running);
    }

    #[test]
    fn concurrent_duplicate_requests_share_one_ledger_entry() {
        let shared = SharedControl::new(true);
        let migration = request(&shared, "concurrent", Some("127.0.0.1:9102"));
        let barrier = Arc::new(Barrier::new(16));
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let shared = shared.clone();
                let migration = migration.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    submit(&shared, migration)
                })
            })
            .collect();
        let responses: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert!(responses.iter().all(|response| response.code == "ACCEPTED"));
        assert!(responses
            .iter()
            .all(|response| response.operation == responses[0].operation));
        shared.attempt_failed("finished only attempt".into());
        assert_eq!(submit(&shared, migration).code, "MIGRATION_FAILED");
        assert_eq!(shared.requested_target(), None);
    }

    #[test]
    fn concurrent_different_ids_reserve_only_one_attempt() {
        let shared = SharedControl::new(true);
        let barrier = Arc::new(Barrier::new(16));
        let threads: Vec<_> = (0..16)
            .map(|i| {
                let migration = request(&shared, &format!("attempt-{i}"), Some("127.0.0.1:9102"));
                let shared = shared.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    submit(&shared, migration)
                })
            })
            .collect();
        let responses: Vec<_> = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        assert_eq!(
            responses
                .iter()
                .filter(|response| response.code == "ACCEPTED")
                .count(),
            1
        );
        assert_eq!(
            responses
                .iter()
                .filter(|response| response.code == "NODE_BUSY")
                .count(),
            15
        );
    }

    #[test]
    fn unknown_epoch_and_conflicting_target_never_change_reservation() {
        let shared = SharedControl::new(true);
        let migration = request(&shared, "once", Some("127.0.0.1:9102"));
        for epoch in [None, Some("old-process-epoch".to_owned())] {
            let mut stale = migration.clone();
            stale.node_epoch = epoch;
            let response = submit(&shared, stale);
            assert_eq!(response.code, "NODE_EPOCH_MISMATCH");
            assert_eq!(response.retry, Retry::InspectOwnership);
            assert_eq!(shared.requested_target(), None);
        }
        assert_eq!(submit(&shared, migration).code, "ACCEPTED");
        let conflict = request(&shared, "once", Some("127.0.0.1:9103"));
        assert_eq!(submit(&shared, conflict).code, "OPERATION_CONFLICT");
        assert_eq!(shared.requested_target().as_deref(), Some("127.0.0.1:9102"));
        let mut stale_lookup = request(&shared, "once", None);
        stale_lookup.node_epoch = None;
        assert_eq!(submit(&shared, stale_lookup).code, "NODE_EPOCH_MISMATCH");
    }

    #[test]
    fn malformed_fields_and_bounds_leave_running_node_unchanged() {
        let shared = SharedControl::new(true);
        for bytes in [
            b"{".as_slice(),
            b"null",
            b"[]",
            b"\xff",
            br#"{"schema_version":1,"action":"status","surprise":true}"#,
        ] {
            assert_eq!(shared.structured_request(bytes).code, "INVALID_REQUEST");
        }
        assert_eq!(
            shared
                .structured_request(&vec![b' '; weave_core::wire::MAX_CONTROL_FRAME + 1])
                .code,
            "INVALID_REQUEST"
        );
        for id in [
            "".to_owned(),
            "x".repeat(129),
            "bad/id".into(),
            "café".into(),
        ] {
            assert_eq!(
                submit(&shared, request(&shared, &id, Some("localhost:9102"))).code,
                "INVALID_REQUEST"
            );
        }
        for target in [
            "",
            "localhost:0",
            "localhost:65536",
            "host:+12",
            "host:12\n",
            "::1:9102",
            "[bogus]:9102",
        ] {
            assert_eq!(
                submit(&shared, request(&shared, "valid", Some(target))).code,
                "INVALID_REQUEST"
            );
        }
        let mut unsupported = Request::status();
        unsupported.schema_version = 9;
        assert_eq!(submit(&shared, unsupported).code, "UNSUPPORTED_SCHEMA");
        assert_eq!(shared.requested_target(), None);
        assert_eq!(status(&shared).lifecycle, Lifecycle::Running);
        assert_eq!(
            submit(
                &shared,
                request(&shared, &"x".repeat(128), Some("[::1]:9102"))
            )
            .code,
            "ACCEPTED"
        );
    }

    #[test]
    fn typed_events_cannot_be_confused_by_human_error_text() {
        for (completion, code, lifecycle, ownership) in [
            (
                Completion::FailedBeforeCommit,
                "MIGRATION_FAILED",
                Lifecycle::Running,
                Ownership::Retained,
            ),
            (
                Completion::Migrated,
                "MIGRATED",
                Lifecycle::Retired,
                Ownership::Retired,
            ),
            (
                Completion::CommitUncertain,
                "COMMIT_UNCERTAIN",
                Lifecycle::Retired,
                Ownership::Retired,
            ),
            (
                Completion::WorkloadCompleted,
                "WORKLOAD_COMPLETED",
                Lifecycle::Completed,
                Ownership::None,
            ),
            (
                Completion::WorkloadTrapped,
                "WORKLOAD_TRAPPED",
                Lifecycle::Failed,
                Ownership::None,
            ),
        ] {
            let shared = SharedControl::new(true);
            submit(&shared, request(&shared, "typed", Some("localhost:9102")));
            shared.workload_finished(
                completion,
                "migrated: done: deliberately misleading text".into(),
            );
            let result = submit(&shared, request(&shared, "typed", None));
            assert_eq!(result.code, code);
            assert_eq!(result.lifecycle, lifecycle);
            assert_eq!(result.ownership, ownership);
            assert_eq!(result.operation.unwrap().ownership, ownership);
        }
    }

    #[test]
    fn retirement_is_visible_before_commit_confirmation() {
        let shared = SharedControl::new(true);
        submit(&shared, request(&shared, "commit", Some("localhost:9102")));
        shared.retirement_flag().store(true, Ordering::Release);
        let pending = status(&shared);
        assert_eq!(pending.lifecycle, Lifecycle::Retired);
        assert_eq!(pending.ownership, Ownership::Retired);
        assert_eq!(pending.operation.unwrap().code, "COMMIT_PENDING");
        assert!(!submit(&shared, request(&shared, "second", Some("localhost:9103"))).ok);
        assert!(shared.request_migration("localhost:9103".into()).is_err());
        shared.workload_finished(Completion::CommitUncertain, "peer vanished".into());
        let result = submit(&shared, request(&shared, "commit", None));
        assert_eq!(result.code, "COMMIT_UNCERTAIN");
        assert_eq!(result.ownership, Ownership::Retired);
        assert_eq!(result.retry, Retry::InspectOwnership);
    }

    #[test]
    fn incoming_reservation_blocks_control_until_commit_and_failure_releases_it() {
        let shared = SharedControl::new(false);
        assert!(shared.try_reserve_incoming());
        assert!(!shared.try_reserve_incoming());
        assert_eq!(status(&shared).lifecycle, Lifecycle::Accepting);
        assert_eq!(status(&shared).ownership, Ownership::None);
        assert_eq!(
            submit(
                &shared,
                request(&shared, "incoming", Some("localhost:9102"))
            )
            .code,
            "NODE_BUSY"
        );
        assert!(shared.request_migration("localhost:9102".into()).is_err());
        shared.incoming_failed("target validation rejected module".into());
        assert_eq!(status(&shared).lifecycle, Lifecycle::Idle);
        assert!(shared.try_reserve_incoming());
        shared.incoming_committed();
        assert_eq!(
            submit(
                &shared,
                request(&shared, "incoming", Some("localhost:9102"))
            )
            .code,
            "ACCEPTED"
        );
    }

    #[test]
    fn operation_ledger_survives_next_incoming_workload_without_old_latch_leaking() {
        let shared = SharedControl::new(true);
        let old = request(&shared, "old", Some("localhost:9102"));
        let epoch = status(&shared).node_epoch;
        submit(&shared, old.clone());
        let old_latch = shared.retirement_flag();
        old_latch.store(true, Ordering::Release);
        shared.workload_finished(Completion::Migrated, "first workload departed".into());
        assert!(shared.try_reserve_incoming());
        shared.incoming_committed();
        assert!(!shared.retirement_flag().load(Ordering::Acquire));
        assert_eq!(status(&shared).node_epoch, epoch);
        assert_eq!(status(&shared).ownership, Ownership::Retained);
        assert_eq!(submit(&shared, old).code, "MIGRATED");
        assert_eq!(shared.requested_target(), None);
        assert_eq!(
            submit(&shared, request(&shared, "new", Some("localhost:9103"))).code,
            "ACCEPTED"
        );
    }

    #[test]
    fn full_ledger_fails_closed_without_evicting_accepted_ids() {
        let shared = SharedControl::new(true);
        for index in 0..weave_core::control::MAX_OPERATIONS {
            let migration = request(&shared, &format!("attempt-{index}"), Some("localhost:9102"));
            assert_eq!(submit(&shared, migration).code, "ACCEPTED");
            shared.attempt_failed(format!("failure {index}"));
        }
        assert_eq!(
            submit(
                &shared,
                request(&shared, "one-too-many", Some("localhost:9102"))
            )
            .code,
            "OPERATION_CAPACITY"
        );
        let oldest = submit(
            &shared,
            request(&shared, "attempt-0", Some("localhost:9102")),
        );
        assert_eq!(oldest.code, "MIGRATION_FAILED");
        assert_eq!(oldest.operation.unwrap().message, "failure 0");
        assert_eq!(shared.requested_target(), None);
    }

    #[test]
    fn legacy_reply_is_bound_to_its_attempt_and_structured_control_cannot_overlap() {
        let shared = SharedControl::new(true);
        let first = shared.request_migration("localhost:9102".into()).unwrap();
        assert_eq!(
            submit(&shared, request(&shared, "overlap", Some("localhost:9103"))).code,
            "NODE_BUSY"
        );
        shared.attempt_failed("first failed".into());
        let second = shared.request_migration("localhost:9103".into()).unwrap();
        shared.workload_finished(Completion::Migrated, "second succeeded".into());
        assert_eq!(
            first.recv_timeout(Duration::from_secs(1)).unwrap(),
            (Completion::FailedBeforeCommit, "first failed".into())
        );
        assert_eq!(
            second.recv_timeout(Duration::from_secs(1)).unwrap(),
            (Completion::Migrated, "second succeeded".into())
        );
    }
}
