//! Target side of a live migration: accept a workload streamed by a source
//! peer, verify it bit-for-bit, and hand back a ready-to-resume instance.
//!
//! The session instantiates the module as soon as it is synced, then applies
//! pre-copy pages directly into the fresh instance's memory *as they stream
//! in* — by the time the source pauses the guest, most state is already in
//! place and only the final delta rides through the pause window.

use crate::MemRead;
use anyhow::{bail, Context, Result};
use std::io::{BufReader, BufWriter, Write};
use std::net::TcpStream;
use weave_core::sha256::sha256;
use weave_core::snapshot::StateHasher;
use weave_core::wire::{Frame, PROTO_VERSION, ROLE_TARGET};
use weave_core::{Meta, WPAGE_SIZE};

/// Engine hooks the session drives. `instantiate` must NOT call
/// `__weave_init` — a restored instance gets its state from the wire.
pub trait TargetHost {
    fn has_module(&mut self, hash: &[u8; 32]) -> bool;
    fn store_module(&mut self, hash: &[u8; 32], bytes: Vec<u8>) -> Result<()>;
    /// Validate meta.imports against registered services and instantiate.
    fn instantiate(&mut self, hash: &[u8; 32], meta: &Meta) -> Result<()>;
    fn set_mem_pages(&mut self, mem: usize, pages: u64) -> Result<()>;
    fn write_mem(&mut self, mem: usize, off: usize, bytes: &[u8]) -> Result<()>;
    fn set_global(&mut self, name: &str, v: i32) -> Result<()>;
    fn restore_services(&mut self, services: &[(String, Vec<u8>)]) -> Result<()>;
    fn mems(&mut self) -> &dyn MemRead;
}

pub struct Received {
    pub module_hash: [u8; 32],
    pub meta: Meta,
    pub source_runtime: String,
}

/// Drive one incoming migration to the ready-to-resume point. On success the
/// host's instance holds the complete verified state and RESUME_OK has been
/// sent; the caller then invokes `__weave_resume` on its workload executor.
pub fn run_target_session(conn: TcpStream, host: &mut dyn TargetHost) -> Result<Received> {
    conn.set_nodelay(true).ok();
    let mut w = BufWriter::new(conn.try_clone()?);
    let mut r = BufReader::new(conn);

    let source_runtime = match Frame::read_from(&mut r)? {
        Frame::Hello { proto, runtime, .. } => {
            if proto != PROTO_VERSION {
                let f = Frame::Abort { code: 1, msg: format!("protocol {proto} unsupported") };
                f.write_to(&mut w)?;
                w.flush()?;
                bail!("source speaks protocol {proto}");
            }
            runtime
        }
        other => bail!("expected HELLO, got {other:?}"),
    };
    Frame::Hello { proto: PROTO_VERSION, role: ROLE_TARGET, runtime: "weave-host".into() }
        .write_to(&mut w)?;
    w.flush()?;

    let (module_hash, meta) = match Frame::read_from(&mut r)? {
        Frame::ModuleMeta { module_hash, size, meta } => {
            let meta = Meta::decode(&meta).context("decoding weave.meta")?;
            if host.has_module(&module_hash) {
                Frame::ModuleHave.write_to(&mut w)?;
            } else {
                Frame::ModuleNeed.write_to(&mut w)?;
                w.flush()?;
                let mut bytes = vec![0u8; size as usize];
                let mut got = 0u64;
                while got < size {
                    match Frame::read_from(&mut r)? {
                        Frame::ModuleData { offset, bytes: chunk } => {
                            let off = offset as usize;
                            if off + chunk.len() > bytes.len() {
                                bail!("module chunk out of bounds");
                            }
                            bytes[off..off + chunk.len()].copy_from_slice(&chunk);
                            got += chunk.len() as u64;
                        }
                        other => bail!("expected MODULE_DATA, got {other:?}"),
                    }
                }
                if sha256(&bytes) != module_hash {
                    let f = Frame::Abort { code: 2, msg: "module hash mismatch".into() };
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
        let f = Frame::Abort { code: 3, msg: format!("instantiation failed: {e:#}") };
        f.write_to(&mut w)?;
        w.flush()?;
        return Err(e.context("instantiating migrated module"));
    }
    Frame::ModuleOk.write_to(&mut w)?;
    w.flush()?;

    // Pre-copy + final streams.
    let mut in_final = false;
    let mut globals: Vec<(String, i32)> = Vec::new();
    let mut services: Vec<(String, Vec<u8>)> = Vec::new();
    loop {
        match Frame::read_from(&mut r)? {
            Frame::MemLayout { pages } => {
                for (m, p) in pages.iter().enumerate() {
                    host.set_mem_pages(m, *p)?;
                }
            }
            Frame::Page { mem, page_no, bytes } => {
                host.write_mem(mem as usize, page_no as usize * WPAGE_SIZE, &bytes)?;
            }
            Frame::RoundEnd { .. } => {
                Frame::RoundAck.write_to(&mut w)?;
                w.flush()?;
            }
            Frame::FinalBegin => {
                in_final = true;
            }
            Frame::Globals { globals: g } => {
                if !in_final {
                    bail!("GLOBALS before FINAL_BEGIN");
                }
                globals = g;
            }
            Frame::Services { services: s } => {
                services = s;
            }
            Frame::FinalEnd { state_hash } => {
                for (name, v) in &globals {
                    host.set_global(name, *v)?;
                }
                host.restore_services(&services)?;
                // verify end-to-end
                let mems = host.mems();
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
                let ours = hasher.finish();
                if ours != state_hash {
                    let f = Frame::Abort { code: 4, msg: "state hash mismatch".into() };
                    f.write_to(&mut w)?;
                    w.flush()?;
                    bail!("migrated state hash mismatch — refusing to resume");
                }
                Frame::ResumeOk.write_to(&mut w)?;
                w.flush()?;
                return Ok(Received { module_hash, meta, source_runtime });
            }
            Frame::Abort { code, msg } => bail!("source aborted ({code}): {msg}"),
            other => bail!("unexpected frame {other:?}"),
        }
    }
}
