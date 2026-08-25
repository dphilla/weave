//! Peer-to-peer migration wire protocol.
//!
//! A migration is a single TCP connection dialed by the *source* directly to
//! the *target* (no broker). Framing is `[u8 type][u32 le length][payload]`.
//!
//! Phases:
//!   1. HELLO exchange (version/role/runtime-name sanity).
//!   2. Module sync: MODULE_META offers hash+size+meta; target answers
//!      MODULE_NEED or MODULE_HAVE (content-addressed cache); source streams
//!      MODULE_DATA chunks; target instantiates and answers MODULE_OK.
//!   3. Iterative pre-copy: any number of PAGE frames (4 KiB granularity,
//!      dirty-tracked by truncated SHA-256) interleaved with the guest still
//!      executing on the source; ROUND_END/ROUND_ACK delimit rounds.
//!   4. Stop-and-copy: FINAL_BEGIN, the last dirty PAGEs + MEM_LAYOUT,
//!      GLOBALS, SERVICES, then FINAL_END carrying the full state hash.
//!   5. Target verifies and restores the isolated instance, then answers
//!      PREPARED (but does not execute). The source sends COMMIT and
//!      irrevocably retires its instance; only then may the target resume and
//!      answer COMMIT_OK. Errors before PREPARED safely rewind the source.
//!
//! The same framing carries the tiny control API (CTL_*) used by `weave
//! migrate` to ask a serving node to move its workload.

use crate::types::*;
use anyhow::{bail, Context, Result};
use std::io::{Read, Write};

pub const PROTO_VERSION: u8 = 2;
/// Hard cap on a single frame payload (module chunks are far smaller).
pub const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Module transfer chunk size.
pub const MODULE_CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum Frame {
    Hello {
        proto: u8,
        role: u8,
        runtime: String,
    },
    ModuleMeta {
        module_hash: [u8; 32],
        size: u64,
        meta: Vec<u8>,
    },
    ModuleNeed,
    ModuleHave,
    ModuleData {
        offset: u64,
        bytes: Vec<u8>,
    },
    ModuleOk,
    /// Current size in wasm pages of every memory, by index.
    MemLayout {
        pages: Vec<u64>,
    },
    /// One 4 KiB page of one memory.
    Page {
        mem: u8,
        page_no: u64,
        bytes: Vec<u8>,
    },
    RoundEnd {
        round: u32,
        pages_sent: u64,
    },
    RoundAck,
    FinalBegin,
    Globals {
        globals: Vec<(String, i32)>,
    },
    Services {
        services: Vec<(String, Vec<u8>)>,
    },
    FinalEnd {
        state_hash: [u8; 32],
    },
    /// Target is fully prepared but MUST NOT execute until `Commit` arrives.
    Prepared,
    Abort {
        code: u32,
        msg: String,
    },
    CtlMigrate {
        target: String,
    },
    CtlStatus,
    CtlOk {
        msg: String,
    },
    CtlErr {
        msg: String,
    },
    /// Irreversible source ownership transfer after `Prepared`.
    Commit,
    /// Target observed `Commit` and now owns the workload.
    CommitOk,
}

pub const ROLE_SOURCE: u8 = 1;
pub const ROLE_TARGET: u8 = 2;
pub const ROLE_CTL: u8 = 3;

impl Frame {
    fn type_byte(&self) -> u8 {
        match self {
            Frame::Hello { .. } => 1,
            Frame::ModuleMeta { .. } => 2,
            Frame::ModuleNeed => 3,
            Frame::ModuleHave => 4,
            Frame::ModuleData { .. } => 5,
            Frame::ModuleOk => 6,
            Frame::MemLayout { .. } => 7,
            Frame::Page { .. } => 8,
            Frame::RoundEnd { .. } => 9,
            Frame::RoundAck => 10,
            Frame::FinalBegin => 11,
            Frame::Globals { .. } => 12,
            Frame::Services { .. } => 13,
            Frame::FinalEnd { .. } => 14,
            Frame::Prepared => 15,
            Frame::Abort { .. } => 16,
            Frame::CtlMigrate { .. } => 17,
            Frame::CtlStatus => 18,
            Frame::CtlOk { .. } => 19,
            Frame::CtlErr { .. } => 20,
            Frame::Commit => 21,
            Frame::CommitOk => 22,
        }
    }

    pub fn payload(&self) -> Result<Vec<u8>> {
        match self {
            Frame::MemLayout { pages } if pages.len() > u8::MAX as usize => {
                bail!("too many memories for MEM_LAYOUT")
            }
            Frame::Globals { globals } if globals.len() > u16::MAX as usize => {
                bail!("too many control globals for GLOBALS")
            }
            Frame::Services { services } if services.len() > u16::MAX as usize => {
                bail!("too many host services for SERVICES")
            }
            _ => {}
        }
        let mut p = Vec::new();
        match self {
            Frame::Hello {
                proto,
                role,
                runtime,
            } => {
                p.push(*proto);
                p.push(*role);
                put_str(&mut p, runtime);
            }
            Frame::ModuleMeta {
                module_hash,
                size,
                meta,
            } => {
                p.extend_from_slice(module_hash);
                put_u64(&mut p, *size);
                put_bytes(&mut p, meta);
            }
            Frame::ModuleData { offset, bytes } => {
                put_u64(&mut p, *offset);
                p.extend_from_slice(bytes);
            }
            Frame::MemLayout { pages } => {
                p.push(pages.len() as u8);
                for pg in pages {
                    put_u64(&mut p, *pg);
                }
            }
            Frame::Page {
                mem,
                page_no,
                bytes,
            } => {
                p.push(*mem);
                put_u64(&mut p, *page_no);
                p.extend_from_slice(bytes);
            }
            Frame::RoundEnd { round, pages_sent } => {
                put_u32(&mut p, *round);
                put_u64(&mut p, *pages_sent);
            }
            Frame::Globals { globals } => {
                put_u16(&mut p, globals.len() as u16);
                for (n, v) in globals {
                    put_str(&mut p, n);
                    put_u32(&mut p, *v as u32);
                }
            }
            Frame::Services { services } => {
                put_u16(&mut p, services.len() as u16);
                for (n, b) in services {
                    put_str(&mut p, n);
                    put_bytes(&mut p, b);
                }
            }
            Frame::FinalEnd { state_hash } => {
                p.extend_from_slice(state_hash);
            }
            Frame::Abort { code, msg } => {
                put_u32(&mut p, *code);
                put_str(&mut p, msg);
            }
            Frame::CtlMigrate { target } => put_str(&mut p, target),
            Frame::CtlOk { msg } | Frame::CtlErr { msg } => put_str(&mut p, msg),
            Frame::ModuleNeed
            | Frame::ModuleHave
            | Frame::ModuleOk
            | Frame::RoundAck
            | Frame::FinalBegin
            | Frame::Prepared
            | Frame::CtlStatus
            | Frame::Commit
            | Frame::CommitOk => {}
        }
        if p.len() > MAX_FRAME {
            bail!("frame payload too large: {}", p.len());
        }
        Ok(p)
    }

    pub fn write_to(&self, w: &mut impl Write) -> Result<()> {
        let payload = self.payload()?;
        let mut hdr = [0u8; 5];
        hdr[0] = self.type_byte();
        let len = u32::try_from(payload.len()).context("frame payload length exceeds u32")?;
        hdr[1..5].copy_from_slice(&len.to_le_bytes());
        w.write_all(&hdr)?;
        w.write_all(&payload)?;
        Ok(())
    }

    pub fn read_from(r: &mut impl Read) -> Result<Frame> {
        let mut hdr = [0u8; 5];
        r.read_exact(&mut hdr).context("reading frame header")?;
        let ty = hdr[0];
        let len = u32::from_le_bytes(hdr[1..5].try_into().unwrap()) as usize;
        if len > MAX_FRAME {
            bail!("frame too large: {len}");
        }
        let mut buf = vec![0u8; len];
        r.read_exact(&mut buf).context("reading frame payload")?;
        Self::decode(ty, buf)
    }

    fn decode(ty: u8, buf: Vec<u8>) -> Result<Frame> {
        let mut pos = 0usize;
        let f = match ty {
            1 => Frame::Hello {
                proto: get_u8(&buf, &mut pos)?,
                role: get_u8(&buf, &mut pos)?,
                runtime: get_str(&buf, &mut pos)?,
            },
            2 => {
                if buf.len() < 32 {
                    bail!("short MODULE_META");
                }
                let mut h = [0u8; 32];
                h.copy_from_slice(&buf[..32]);
                pos = 32;
                Frame::ModuleMeta {
                    module_hash: h,
                    size: get_u64(&buf, &mut pos)?,
                    meta: get_bytes(&buf, &mut pos)?,
                }
            }
            3 => Frame::ModuleNeed,
            4 => Frame::ModuleHave,
            5 => {
                let offset = get_u64(&buf, &mut pos)?;
                let bytes = buf[pos..].to_vec();
                pos = buf.len();
                Frame::ModuleData { offset, bytes }
            }
            6 => Frame::ModuleOk,
            7 => {
                let n = get_u8(&buf, &mut pos)? as usize;
                let mut pages = Vec::with_capacity(n);
                for _ in 0..n {
                    pages.push(get_u64(&buf, &mut pos)?);
                }
                Frame::MemLayout { pages }
            }
            8 => {
                let mem = get_u8(&buf, &mut pos)?;
                let page_no = get_u64(&buf, &mut pos)?;
                let bytes = buf[pos..].to_vec();
                pos = buf.len();
                Frame::Page {
                    mem,
                    page_no,
                    bytes,
                }
            }
            9 => Frame::RoundEnd {
                round: get_u32(&buf, &mut pos)?,
                pages_sent: get_u64(&buf, &mut pos)?,
            },
            10 => Frame::RoundAck,
            11 => Frame::FinalBegin,
            12 => {
                let n = get_u16(&buf, &mut pos)? as usize;
                let mut globals = Vec::with_capacity(n);
                for _ in 0..n {
                    let name = get_str(&buf, &mut pos)?;
                    let v = get_u32(&buf, &mut pos)? as i32;
                    globals.push((name, v));
                }
                Frame::Globals { globals }
            }
            13 => {
                let n = get_u16(&buf, &mut pos)? as usize;
                let mut services = Vec::with_capacity(n);
                for _ in 0..n {
                    let name = get_str(&buf, &mut pos)?;
                    let blob = get_bytes(&buf, &mut pos)?;
                    services.push((name, blob));
                }
                Frame::Services { services }
            }
            14 => {
                if buf.len() != 32 {
                    bail!("bad FINAL_END");
                }
                let mut h = [0u8; 32];
                h.copy_from_slice(&buf);
                pos = buf.len();
                Frame::FinalEnd { state_hash: h }
            }
            15 => Frame::Prepared,
            16 => Frame::Abort {
                code: get_u32(&buf, &mut pos)?,
                msg: get_str(&buf, &mut pos)?,
            },
            17 => Frame::CtlMigrate {
                target: get_str(&buf, &mut pos)?,
            },
            18 => Frame::CtlStatus,
            19 => Frame::CtlOk {
                msg: get_str(&buf, &mut pos)?,
            },
            20 => Frame::CtlErr {
                msg: get_str(&buf, &mut pos)?,
            },
            21 => Frame::Commit,
            22 => Frame::CommitOk,
            _ => bail!("unknown frame type {ty}"),
        };
        if pos != buf.len() {
            bail!("trailing bytes in frame type {ty}");
        }
        Ok(f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_all() {
        let frames = vec![
            Frame::Hello {
                proto: PROTO_VERSION,
                role: ROLE_SOURCE,
                runtime: "wasmtime".into(),
            },
            Frame::ModuleMeta {
                module_hash: [3; 32],
                size: 12345,
                meta: vec![1, 2, 3],
            },
            Frame::ModuleNeed,
            Frame::ModuleHave,
            Frame::ModuleData {
                offset: 77,
                bytes: vec![9; 100],
            },
            Frame::ModuleOk,
            Frame::MemLayout { pages: vec![16, 2] },
            Frame::Page {
                mem: 0,
                page_no: 42,
                bytes: vec![5; 4096],
            },
            Frame::RoundEnd {
                round: 3,
                pages_sent: 999,
            },
            Frame::RoundAck,
            Frame::FinalBegin,
            Frame::Globals {
                globals: vec![("__weave_state".into(), 1), ("x".into(), -5)],
            },
            Frame::Services {
                services: vec![("env".into(), vec![0xde, 0xad])],
            },
            Frame::FinalEnd {
                state_hash: [8; 32],
            },
            Frame::Prepared,
            Frame::Abort {
                code: 2,
                msg: "nope".into(),
            },
            Frame::CtlMigrate {
                target: "127.0.0.1:9000".into(),
            },
            Frame::CtlStatus,
            Frame::CtlOk { msg: "ok".into() },
            Frame::CtlErr { msg: "err".into() },
            Frame::Commit,
            Frame::CommitOk,
        ];
        let mut buf = Vec::new();
        for f in &frames {
            f.write_to(&mut buf).unwrap();
        }
        let mut cur = std::io::Cursor::new(buf);
        for f in &frames {
            assert_eq!(&Frame::read_from(&mut cur).unwrap(), f);
        }
    }

    #[test]
    fn rejects_payload_on_empty_frame() {
        let bytes = [3u8, 1, 0, 0, 0, 99];
        assert!(Frame::read_from(&mut &bytes[..]).is_err());
    }

    #[test]
    fn rejects_counts_that_do_not_fit_the_wire() {
        let frame = Frame::MemLayout {
            pages: vec![0; u8::MAX as usize + 1],
        };
        assert!(frame.payload().is_err());
    }
}
