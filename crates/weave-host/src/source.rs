//! Source side of a live migration.
//!
//! Lifecycle:
//!   1. `SourceMigration::connect` — dial the target peer-to-peer, exchange
//!      HELLOs, sync the module by content hash.
//!   2. `precopy_step` — called from inside `weave.poll` while the guest is
//!      briefly paused; streams a bounded budget of dirty pages per call so
//!      the guest keeps executing between steps (this is the amortization:
//!      the bulk of memory moves while the workload continues running).
//!      Returns `true` once the dirty set has converged (or the round limit
//!      is hit) — the caller then makes poll return 1, unwinding the guest.
//!   3. `finish` — after the unwind: final delta (which now includes the
//!      guest's self-spilled stack and saved globals), control globals,
//!      service blobs, and the end-to-end state hash; waits for PREPARED.
//!      Before PREPARED, any error is safe to roll back. After PREPARED the
//!      source sends COMMIT and irrevocably retires, even if confirmation is
//!      lost, so a broken connection cannot produce two active copies.
//!
//! Before PREPARED, an error (or explicit `abort`) leaves the source guest
//! fully intact: the embedder rewinds it locally (`__weave_resume`) and
//! execution continues. After PREPARED, ownership is irrevocably retired on
//! the source even if COMMIT confirmation is lost.

use crate::pages::{PageTracker, ScanCursor};
use crate::MemRead;
use anyhow::{anyhow, bail, Context, Result};
use std::io::{BufReader, BufWriter, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;
use weave_core::sha256::sha256;
use weave_core::snapshot::StateHasher;
use weave_core::wire::ROLE_TARGET;
use weave_core::wire::{Frame, MODULE_CHUNK, PROTO_VERSION, ROLE_SOURCE};
use weave_core::WPAGE_SIZE;

const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct SourceOptions {
    /// Max bytes of pages scanned/sent per precopy step (bounds guest pause).
    pub budget_bytes: usize,
    /// Stop iterating and go final when a full round re-sent at most this
    /// many pages.
    pub dirty_page_threshold: u64,
    /// Hard cap on pre-copy rounds.
    pub max_rounds: u32,
}

impl Default for SourceOptions {
    fn default() -> Self {
        SourceOptions {
            budget_bytes: 8 << 20,
            dirty_page_threshold: 64,
            max_rounds: 10,
        }
    }
}

pub struct SourceMigration {
    r: BufReader<TcpStream>,
    w: BufWriter<TcpStream>,
    tracker: PageTracker,
    cursor: ScanCursor,
    sent_layout: Vec<u64>,
    round_pages: u64,
    pub total_pages_sent: u64,
    pub rounds_completed: u32,
    opts: SourceOptions,
    converged: bool,
}

impl SourceMigration {
    /// Dial the target and sync the module. Fast: no memory moves yet.
    pub fn connect(
        target: &str,
        runtime: &str,
        module: &[u8],
        meta_bytes: &[u8],
        n_mems: usize,
        opts: SourceOptions,
    ) -> Result<SourceMigration> {
        let addresses: Vec<_> = target
            .to_socket_addrs()
            .with_context(|| format!("resolving migration target {target}"))?
            .collect();
        if addresses.is_empty() {
            bail!("migration target {target} resolved to no addresses");
        }
        let mut last_error = None;
        let mut connected = None;
        for address in addresses {
            match TcpStream::connect_timeout(&address, DEFAULT_CONNECT_TIMEOUT) {
                Ok(stream) => {
                    connected = Some(stream);
                    break;
                }
                Err(error) => last_error = Some(error),
            }
        }
        let stream = connected.ok_or_else(|| {
            let error = last_error
                .map(anyhow::Error::from)
                .unwrap_or_else(|| anyhow!("no usable target address"));
            error.context(format!("connecting to migration target {target}"))
        })?;
        stream.set_nodelay(true).ok();
        stream
            .set_read_timeout(Some(DEFAULT_IO_TIMEOUT))
            .context("setting migration read timeout")?;
        stream
            .set_write_timeout(Some(DEFAULT_IO_TIMEOUT))
            .context("setting migration write timeout")?;
        let mut w = BufWriter::new(stream.try_clone()?);
        let mut r = BufReader::new(stream);

        Frame::Hello {
            proto: PROTO_VERSION,
            role: ROLE_SOURCE,
            runtime: runtime.into(),
        }
        .write_to(&mut w)?;
        w.flush()?;
        match Frame::read_from(&mut r)? {
            Frame::Hello {
                proto,
                role: ROLE_TARGET,
                ..
            } if proto == PROTO_VERSION => {}
            Frame::Hello { proto, .. } if proto != PROTO_VERSION => {
                bail!("target speaks protocol {proto}, need {PROTO_VERSION}")
            }
            Frame::Hello { role, .. } => bail!("expected target role, got {role}"),
            other => bail!("expected HELLO, got {other:?}"),
        }

        let module_hash = sha256(module);
        Frame::ModuleMeta {
            module_hash,
            size: module.len() as u64,
            meta: meta_bytes.to_vec(),
        }
        .write_to(&mut w)?;
        w.flush()?;
        match Frame::read_from(&mut r)? {
            Frame::ModuleHave => {}
            Frame::ModuleNeed => {
                let mut off = 0usize;
                while off < module.len() {
                    let end = (off + MODULE_CHUNK).min(module.len());
                    Frame::ModuleData {
                        offset: off as u64,
                        bytes: module[off..end].to_vec(),
                    }
                    .write_to(&mut w)?;
                    off = end;
                }
                w.flush()?;
            }
            Frame::Abort { code, msg } => bail!("target aborted ({code}): {msg}"),
            other => bail!("expected MODULE_NEED/HAVE, got {other:?}"),
        }
        match Frame::read_from(&mut r)? {
            Frame::ModuleOk => {}
            Frame::Abort { code, msg } => bail!("target aborted ({code}): {msg}"),
            other => bail!("expected MODULE_OK, got {other:?}"),
        }

        Ok(SourceMigration {
            r,
            w,
            tracker: PageTracker::new(n_mems),
            cursor: ScanCursor::default(),
            sent_layout: vec![0; n_mems],
            round_pages: 0,
            total_pages_sent: 0,
            rounds_completed: 0,
            opts,
            converged: false,
        })
    }

    fn sync_layout(&mut self, mems: &dyn MemRead) -> Result<()> {
        let cur: Vec<u64> = (0..mems.n_mems())
            .map(|m| (mems.size(m) / weave_core::WASM_PAGE_SIZE) as u64)
            .collect();
        if cur != self.sent_layout {
            Frame::MemLayout { pages: cur.clone() }.write_to(&mut self.w)?;
            self.sent_layout = cur;
        }
        Ok(())
    }

    /// One bounded pre-copy step. Returns true when it's time to unwind.
    pub fn precopy_step(&mut self, mems: &dyn MemRead) -> Result<bool> {
        if self.converged {
            return Ok(true);
        }
        self.sync_layout(mems)?;
        let step = self
            .tracker
            .scan_step(mems, &mut self.cursor, self.opts.budget_bytes);
        for (mem, page_no, bytes) in step.pages {
            self.round_pages += 1;
            self.total_pages_sent += 1;
            Frame::Page {
                mem,
                page_no,
                bytes,
            }
            .write_to(&mut self.w)?;
        }
        self.w.flush()?;
        if step.round_complete {
            self.rounds_completed += 1;
            Frame::RoundEnd {
                round: self.rounds_completed,
                pages_sent: self.round_pages,
            }
            .write_to(&mut self.w)?;
            self.w.flush()?;
            match Frame::read_from(&mut self.r)? {
                Frame::RoundAck => {}
                Frame::Abort { code, msg } => bail!("target aborted ({code}): {msg}"),
                other => bail!("expected ROUND_ACK, got {other:?}"),
            }
            let done = self.round_pages <= self.opts.dirty_page_threshold
                || self.rounds_completed >= self.opts.max_rounds;
            self.round_pages = 0;
            if done {
                self.converged = true;
                return Ok(true);
            }
        }
        Ok(false)
    }

    /// Stop-and-copy: called after the guest has unwound (its live stack and
    /// saved globals are now part of memory). Blocks until the target has
    /// verified and staged the full state and acknowledged PREPARED. After
    /// that frame this function always returns `Ok`: ownership transfer is
    /// irreversible, and `commit_confirmed` says whether COMMIT_OK arrived.
    pub fn finish(
        mut self,
        mems: &dyn MemRead,
        globals: Vec<(String, i32)>,
        services: Vec<(String, Vec<u8>)>,
    ) -> Result<MigrationStats> {
        Frame::FinalBegin.write_to(&mut self.w)?;
        self.sync_layout(mems)?;
        let tracker = &mut self.tracker;
        let writer = &mut self.w;
        let total_pages_sent = &mut self.total_pages_sent;
        let n_final = tracker.scan_full_with(mems, |mem, page_no, bytes| {
            *total_pages_sent += 1;
            Frame::Page {
                mem,
                page_no,
                bytes,
            }
            .write_to(writer)
        })?;
        Frame::Globals {
            globals: globals.clone(),
        }
        .write_to(&mut self.w)?;
        Frame::Services {
            services: services.clone(),
        }
        .write_to(&mut self.w)?;

        // end-to-end verification hash over the complete migrated state
        let mut hasher = StateHasher::new(mems.n_mems() as u32);
        let mut buf = vec![0u8; WPAGE_SIZE * 16];
        for m in 0..mems.n_mems() {
            let size = mems.size(m);
            hasher.mem_begin(size as u64);
            let mut off = 0;
            while off < size {
                let take = (size - off).min(buf.len());
                mems.read(m, off, &mut buf[..take]);
                hasher.mem_chunk(&buf[..take]);
                off += take;
            }
        }
        hasher.globals(&globals);
        hasher.services(&services);
        Frame::FinalEnd {
            state_hash: hasher.finish(),
        }
        .write_to(&mut self.w)?;
        self.w.flush()?;

        match Frame::read_from(&mut self.r)? {
            Frame::Prepared => {}
            Frame::Abort { code, msg } => bail!("target aborted ({code}): {msg}"),
            other => bail!("expected PREPARED, got {other:?}"),
        }

        // PREPARED is the ownership-transfer point. From here onward the
        // source must never rewind: COMMIT may have reached the target even
        // when a subsequent write/read reports an error. Prefer at-most-one
        // execution over silently creating a split brain.
        let mut commit_confirmed = false;
        let mut commit_error = None;
        let send_result = Frame::Commit
            .write_to(&mut self.w)
            .and_then(|_| self.w.flush().map_err(Into::into));
        match send_result {
            Err(error) => commit_error = Some(format!("sending COMMIT failed: {error:#}")),
            Ok(()) => match Frame::read_from(&mut self.r) {
                Ok(Frame::CommitOk) => commit_confirmed = true,
                Ok(Frame::Abort { code, msg }) => {
                    commit_error = Some(format!("target aborted after PREPARED ({code}): {msg}"));
                }
                Ok(other) => {
                    commit_error = Some(format!("expected COMMIT_OK, got {other:?}"));
                }
                Err(error) => {
                    commit_error = Some(format!("waiting for COMMIT_OK failed: {error:#}"));
                }
            },
        }

        Ok(MigrationStats {
            rounds: self.rounds_completed,
            total_pages: self.total_pages_sent,
            final_pages: n_final,
            commit_confirmed,
            commit_error,
        })
    }

    pub fn abort(mut self, code: u32, msg: &str) {
        let _ = Frame::Abort {
            code,
            msg: msg.into(),
        }
        .write_to(&mut self.w);
        let _ = self.w.flush();
    }
}

#[derive(Debug, Clone)]
pub struct MigrationStats {
    pub rounds: u32,
    pub total_pages: u64,
    /// Pages that had to move during the stop-and-copy pause — the number to
    /// watch for seamlessness.
    pub final_pages: u64,
    /// True when the target acknowledged COMMIT. False is an irreversible,
    /// indeterminate handoff: callers must retire the source, never rewind it.
    pub commit_confirmed: bool,
    pub commit_error: Option<String>,
}
