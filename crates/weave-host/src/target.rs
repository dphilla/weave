//! Target side of a live migration: accept a workload streamed by a source
//! peer, verify it bit-for-bit, and hand back a ready-to-resume instance.
//!
//! The session instantiates the module as soon as it is synced, then applies
//! pre-copy pages directly into the fresh instance's memory *as they stream
//! in* — by the time the source pauses the guest, most state is already in
//! place and only the final delta rides through the pause window.

use crate::MemRead;
use anyhow::{bail, Context, Result};
use std::collections::HashSet;
use std::io::{BufReader, BufWriter, Write};
use std::net::TcpStream;
use std::time::Duration;
use weave_core::sha256::sha256;
use weave_core::snapshot::StateHasher;
use weave_core::wire::{Frame, MODULE_CHUNK, PROTO_VERSION, ROLE_SOURCE, ROLE_TARGET};
use weave_core::{Meta, WASM_PAGE_SIZE, WPAGE_SIZE};

const DEFAULT_IO_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MODULE_SIZE: u64 = 512 * 1024 * 1024;
pub const DEFAULT_MAX_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;

/// Engine hooks the session drives. `instantiate` must NOT call
/// `__weave_init` — a restored instance gets its state from the wire.
pub trait TargetHost {
    /// Runtime identifier returned in the target HELLO.
    fn runtime_name(&self) -> &str {
        "weave-host"
    }
    fn has_module(&mut self, hash: &[u8; 32]) -> bool;
    fn store_module(&mut self, hash: &[u8; 32], bytes: Vec<u8>) -> Result<()>;
    /// Validate meta/imports and instantiate. Implementations must reject a
    /// module whose declared initial memories exceed `max_memory_bytes()`
    /// before asking the engine to allocate those memories.
    fn instantiate(&mut self, hash: &[u8; 32], meta: &Meta) -> Result<()>;
    fn set_mem_pages(&mut self, mem: usize, pages: u64) -> Result<()>;
    fn write_mem(&mut self, mem: usize, off: usize, bytes: &[u8]) -> Result<()>;
    fn set_global(&mut self, name: &str, v: i32) -> Result<()>;
    /// Names of the stateful services installed in the new instance. The
    /// target accepts a migration only when this is exactly the service set
    /// sent by the source. The conservative default supports hosts with no
    /// stateful services.
    fn service_names(&mut self) -> Vec<String> {
        Vec::new()
    }
    /// Maximum aggregate byte length accepted across all guest memories.
    fn max_memory_bytes(&self) -> u64 {
        DEFAULT_MAX_MEMORY_BYTES
    }
    fn restore_services(&mut self, services: &[(String, Vec<u8>)]) -> Result<()>;
    /// Borrow the staged instance's memories for verification without
    /// materializing a second, memory-sized copy. The view is valid only for
    /// the duration of `visit` while the guest remains stopped.
    fn with_mems(&mut self, visit: &mut dyn FnMut(&dyn MemRead) -> Result<()>) -> Result<()>;
}

pub struct Received {
    pub module_hash: [u8; 32],
    pub meta: Meta,
    pub source_runtime: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ReceivePhase {
    Precopy,
    FinalPages,
    FinalGlobals,
    FinalServices,
}

fn reject<T>(w: &mut BufWriter<TcpStream>, code: u32, msg: impl Into<String>) -> Result<T> {
    let msg = msg.into();
    let _ = Frame::Abort {
        code,
        msg: msg.clone(),
    }
    .write_to(w);
    let _ = w.flush();
    bail!(msg)
}

fn duplicate_name(names: &[String]) -> Option<&str> {
    let mut seen = HashSet::with_capacity(names.len());
    names.iter().find_map(|name| {
        if seen.insert(name.as_str()) {
            None
        } else {
            Some(name.as_str())
        }
    })
}

/// Drive one incoming migration to the ready-to-resume point. On success the
/// host's instance holds the complete verified state. PREPARED is sent while
/// the instance remains stopped; only after COMMIT arrives does this return
/// and permit the caller to invoke `__weave_resume`.
pub fn run_target_session(conn: TcpStream, host: &mut dyn TargetHost) -> Result<Received> {
    conn.set_nodelay(true).ok();
    conn.set_read_timeout(Some(DEFAULT_IO_TIMEOUT))
        .context("setting migration read timeout")?;
    conn.set_write_timeout(Some(DEFAULT_IO_TIMEOUT))
        .context("setting migration write timeout")?;
    let mut w = BufWriter::new(conn.try_clone()?);
    let mut r = BufReader::new(conn);

    let source_runtime = match Frame::read_from(&mut r)? {
        Frame::Hello {
            proto,
            role,
            runtime,
        } => {
            if proto != PROTO_VERSION {
                return reject(
                    &mut w,
                    1,
                    format!("source speaks unsupported protocol {proto}"),
                );
            }
            if role != ROLE_SOURCE {
                return reject(&mut w, 1, format!("expected source role, got {role}"));
            }
            runtime
        }
        other => bail!("expected HELLO, got {other:?}"),
    };
    Frame::Hello {
        proto: PROTO_VERSION,
        role: ROLE_TARGET,
        runtime: host.runtime_name().into(),
    }
    .write_to(&mut w)?;
    w.flush()?;

    let (module_hash, meta) = match Frame::read_from(&mut r)? {
        Frame::ModuleMeta {
            module_hash,
            size,
            meta,
        } => {
            if size > MAX_MODULE_SIZE {
                return reject(
                    &mut w,
                    2,
                    format!("module exceeds {} byte receive limit", MAX_MODULE_SIZE),
                );
            }
            let meta = Meta::decode(&meta).context("decoding weave.meta")?;
            if meta.memories.len() > u8::MAX as usize {
                return reject(
                    &mut w,
                    3,
                    "module has too many memories for migration wire format",
                );
            }
            if let Some(name) = duplicate_name(&meta.memories) {
                return reject(
                    &mut w,
                    3,
                    format!("duplicate memory export in meta: {name}"),
                );
            }
            if let Some(name) = duplicate_name(&meta.control_globals) {
                return reject(
                    &mut w,
                    3,
                    format!("duplicate control global in meta: {name}"),
                );
            }
            if host.has_module(&module_hash) {
                Frame::ModuleHave.write_to(&mut w)?;
            } else {
                Frame::ModuleNeed.write_to(&mut w)?;
                w.flush()?;
                let size = usize::try_from(size).context("module size does not fit this host")?;
                let mut bytes = Vec::new();
                bytes
                    .try_reserve_exact(size)
                    .context("reserving received module")?;
                bytes.resize(size, 0);
                let mut got = 0usize;
                while got < size {
                    match Frame::read_from(&mut r)? {
                        Frame::ModuleData {
                            offset,
                            bytes: chunk,
                        } => {
                            let off = usize::try_from(offset)
                                .context("module chunk offset does not fit this host")?;
                            if off != got {
                                return reject(
                                    &mut w,
                                    2,
                                    format!("module chunk out of order: expected {got}, got {off}"),
                                );
                            }
                            if chunk.is_empty() || chunk.len() > MODULE_CHUNK {
                                return reject(&mut w, 2, "invalid module chunk size");
                            }
                            let end = off
                                .checked_add(chunk.len())
                                .filter(|end| *end <= bytes.len())
                                .ok_or_else(|| anyhow::anyhow!("module chunk out of bounds"))?;
                            bytes[off..end].copy_from_slice(&chunk);
                            got = end;
                        }
                        other => bail!("expected MODULE_DATA, got {other:?}"),
                    }
                }
                if sha256(&bytes) != module_hash {
                    let f = Frame::Abort {
                        code: 2,
                        msg: "module hash mismatch".into(),
                    };
                    f.write_to(&mut w)?;
                    w.flush()?;
                    bail!("module hash mismatch");
                }
                host.store_module(&module_hash, bytes)?;
            }
            (module_hash, meta)
        }
        other => bail!("expected MODULE_META, got {other:?}"),
    };

    // Instantiate immediately so streamed pages land directly in place.
    if let Err(e) = host.instantiate(&module_hash, &meta) {
        let f = Frame::Abort {
            code: 3,
            msg: format!("instantiation failed: {e:#}"),
        };
        f.write_to(&mut w)?;
        w.flush()?;
        return Err(e.context("instantiating migrated module"));
    }
    let mut expected_services = host.service_names();
    expected_services.sort();
    if let Some(name) = duplicate_name(&expected_services) {
        return reject(&mut w, 3, format!("duplicate target service name: {name}"));
    }
    Frame::ModuleOk.write_to(&mut w)?;
    w.flush()?;

    // Pre-copy + final streams.
    let mut phase = ReceivePhase::Precopy;
    let mut layout: Option<Vec<u64>> = None;
    let mut expected_round = 1u32;
    let mut round_pages = 0u64;
    let mut pages_seen = HashSet::new();
    let mut globals: Vec<(String, i32)> = Vec::new();
    let mut services: Vec<(String, Vec<u8>)> = Vec::new();
    loop {
        match Frame::read_from(&mut r)? {
            Frame::MemLayout { pages } => {
                if !matches!(phase, ReceivePhase::Precopy | ReceivePhase::FinalPages) {
                    return reject(&mut w, 5, "MEM_LAYOUT after final globals");
                }
                if pages.len() != meta.memories.len() {
                    return reject(
                        &mut w,
                        5,
                        format!(
                            "memory layout count mismatch: expected {}, got {}",
                            meta.memories.len(),
                            pages.len()
                        ),
                    );
                }
                if let Some(previous) = &layout {
                    if pages.iter().zip(previous).any(|(new, old)| new < old) {
                        return reject(&mut w, 5, "memory layout cannot shrink during migration");
                    }
                }
                let total_bytes = pages.iter().try_fold(0u64, |total, page_count| {
                    page_count
                        .checked_mul(WASM_PAGE_SIZE as u64)
                        .and_then(|bytes| total.checked_add(bytes))
                });
                let Some(total_bytes) = total_bytes else {
                    return reject(&mut w, 5, "announced memory layout overflows byte count");
                };
                let max_memory_bytes = host.max_memory_bytes();
                if total_bytes > max_memory_bytes {
                    return reject(
                        &mut w,
                        5,
                        format!(
                            "announced memory layout is {total_bytes} bytes, exceeding target limit {max_memory_bytes}"
                        ),
                    );
                }
                for (m, p) in pages.iter().enumerate() {
                    host.set_mem_pages(m, *p)?;
                }
                layout = Some(pages);
            }
            Frame::Page {
                mem,
                page_no,
                bytes,
            } => {
                if !matches!(phase, ReceivePhase::Precopy | ReceivePhase::FinalPages) {
                    return reject(&mut w, 5, "PAGE after final globals");
                }
                if bytes.len() != WPAGE_SIZE {
                    return reject(
                        &mut w,
                        5,
                        format!("invalid page payload size: {}", bytes.len()),
                    );
                }
                let mem = mem as usize;
                let announced = layout
                    .as_ref()
                    .and_then(|pages| pages.get(mem))
                    .copied()
                    .ok_or_else(|| anyhow::anyhow!("PAGE before a matching MEM_LAYOUT"))?;
                let off_u64 = page_no
                    .checked_mul(WPAGE_SIZE as u64)
                    .ok_or_else(|| anyhow::anyhow!("page offset overflow"))?;
                let end_u64 = off_u64
                    .checked_add(bytes.len() as u64)
                    .ok_or_else(|| anyhow::anyhow!("page end overflow"))?;
                let announced_bytes = announced
                    .checked_mul(WASM_PAGE_SIZE as u64)
                    .ok_or_else(|| anyhow::anyhow!("announced memory size overflow"))?;
                if end_u64 > announced_bytes {
                    return reject(&mut w, 5, "PAGE exceeds announced memory layout");
                }
                if !pages_seen.insert((mem, page_no)) {
                    return reject(&mut w, 5, "duplicate PAGE in migration round");
                }
                let off = usize::try_from(off_u64).context("page offset does not fit this host")?;
                host.write_mem(mem, off, &bytes)?;
                round_pages = round_pages
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("round page count overflow"))?;
            }
            Frame::RoundEnd { round, pages_sent } => {
                if phase != ReceivePhase::Precopy {
                    return reject(&mut w, 5, "ROUND_END during final transfer");
                }
                if round != expected_round || pages_sent != round_pages {
                    return reject(
                        &mut w,
                        5,
                        format!(
                            "invalid round terminator: expected round {expected_round} with {round_pages} pages, got round {round} with {pages_sent}"
                        ),
                    );
                }
                Frame::RoundAck.write_to(&mut w)?;
                w.flush()?;
                expected_round = expected_round
                    .checked_add(1)
                    .ok_or_else(|| anyhow::anyhow!("round number overflow"))?;
                round_pages = 0;
                pages_seen.clear();
            }
            Frame::FinalBegin => {
                if phase != ReceivePhase::Precopy || round_pages != 0 {
                    return reject(&mut w, 5, "FINAL_BEGIN inside an incomplete round");
                }
                phase = ReceivePhase::FinalPages;
                pages_seen.clear();
            }
            Frame::Globals { globals: g } => {
                if phase != ReceivePhase::FinalPages {
                    return reject(&mut w, 5, "GLOBALS out of order");
                }
                let names: Vec<&str> = g.iter().map(|(name, _)| name.as_str()).collect();
                let expected: Vec<&str> = meta.control_globals.iter().map(String::as_str).collect();
                if names != expected {
                    return reject(&mut w, 5, "control-global contract mismatch");
                }
                globals = g;
                phase = ReceivePhase::FinalGlobals;
            }
            Frame::Services { services: s } => {
                if phase != ReceivePhase::FinalGlobals {
                    return reject(&mut w, 5, "SERVICES out of order");
                }
                let names: Vec<&str> = s.iter().map(|(name, _)| name.as_str()).collect();
                let expected: Vec<&str> = expected_services.iter().map(String::as_str).collect();
                if names != expected {
                    return reject(&mut w, 5, "host-service contract mismatch");
                }
                services = s;
                phase = ReceivePhase::FinalServices;
            }
            Frame::FinalEnd { state_hash } => {
                if phase != ReceivePhase::FinalServices {
                    return reject(&mut w, 5, "FINAL_END before complete final state");
                }
                // verify end-to-end
                let mut ours = None;
                host.with_mems(&mut |mems| {
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
                    ours = Some(hasher.finish());
                    Ok(())
                })?;
                let ours = ours.expect("memory visitor must run synchronously");
                if ours != state_hash {
                    return reject(
                        &mut w,
                        4,
                        "migrated state hash mismatch — refusing to resume",
                    );
                }

                // Only verified, contract-complete state reaches engine or
                // service restore hooks. Hooks stage isolated target state;
                // externally visible ownership must wait for COMMIT.
                for (name, v) in &globals {
                    if let Err(e) = host.set_global(name, *v) {
                        let msg = format!("restoring control global {name} failed: {e:#}");
                        return reject(&mut w, 5, msg);
                    }
                }
                if let Err(e) = host.restore_services(&services) {
                    let msg = format!("restoring host services failed: {e:#}");
                    return reject(&mut w, 5, msg);
                }
                Frame::Prepared.write_to(&mut w)?;
                w.flush()?;
                match Frame::read_from(&mut r)? {
                    Frame::Commit => {
                        // COMMIT is irrevocable. Even if its acknowledgement
                        // cannot be delivered, the target owns the workload
                        // and must return it to the executor rather than drop
                        // or delay the only active copy. Detach the best-effort
                        // acknowledgement so socket backpressure cannot gate
                        // resume after ownership has transferred.
                        std::thread::spawn(move || {
                            let _ = Frame::CommitOk.write_to(&mut w);
                            let _ = w.flush();
                        });
                        return Ok(Received {
                            module_hash,
                            meta,
                            source_runtime,
                        });
                    }
                    Frame::Abort { code, msg } => {
                        bail!("source aborted before COMMIT ({code}): {msg}")
                    }
                    other => return reject(&mut w, 5, format!("expected COMMIT, got {other:?}")),
                }
            }
            Frame::Abort { code, msg } => bail!("source aborted ({code}): {msg}"),
            other => bail!("unexpected frame {other:?}"),
        }
    }
}
