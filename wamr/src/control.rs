use anyhow::{bail, Result};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    active: bool,
    request: Option<String>,
    last_result: Option<String>,
}

pub struct SharedControl {
    state: Mutex<State>,
    changed: Condvar,
}

pub type Shared = Arc<SharedControl>;

impl SharedControl {
    pub fn new(active: bool) -> Shared {
        Arc::new(Self {
            state: Mutex::new(State {
                active,
                ..State::default()
            }),
            changed: Condvar::new(),
        })
    }

    /// Reserve an idle node for one inbound migration.
    pub fn try_reserve_incoming(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        if state.active {
            return false;
        }
        state.active = true;
        state.last_result = None;
        true
    }

    pub fn requested_target(&self) -> Option<String> {
        self.state.lock().unwrap().request.clone()
    }

    pub fn request_migration(&self, target: String) -> Result<()> {
        if target.trim().is_empty() {
            bail!("migration target must not be empty");
        }
        let mut state = self.state.lock().unwrap();
        if !state.active {
            bail!("node is idle; there is no workload to migrate");
        }
        if state.request.is_some() {
            bail!("another migration is already requested");
        }
        state.request = Some(target);
        state.last_result = None;
        self.changed.notify_all();
        Ok(())
    }

    /// Complete a control-requested attempt while retaining the local guest.
    pub fn attempt_failed(&self, message: String) {
        let mut state = self.state.lock().unwrap();
        state.request = None;
        state.last_result = Some(message);
        self.changed.notify_all();
    }

    /// Retire (or finish) the current workload and make the node idle.
    pub fn workload_finished(&self, message: String) {
        let mut state = self.state.lock().unwrap();
        state.active = false;
        state.request = None;
        state.last_result = Some(message);
        self.changed.notify_all();
    }

    pub fn status(&self) -> String {
        let state = self.state.lock().unwrap();
        match (&state.active, &state.request, &state.last_result) {
            (true, Some(target), _) => format!("migrating to {target}"),
            (true, None, Some(last)) => format!("running (last: {last})"),
            (true, None, None) => "running".to_owned(),
            (false, _, Some(last)) => format!("idle (last: {last})"),
            (false, _, None) => "idle".to_owned(),
        }
    }

    pub fn wait_for_request(&self, timeout: Duration) -> Result<String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap();
        while state.request.is_some() {
            let now = Instant::now();
            if now >= deadline {
                bail!("migration control request timed out");
            }
            let (next, wait) = self.changed.wait_timeout(state, deadline - now).unwrap();
            state = next;
            if wait.timed_out() && state.request.is_some() {
                bail!("migration control request timed out");
            }
        }
        Ok(state
            .last_result
            .clone()
            .unwrap_or_else(|| "migration request ended without a result".to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
