//! The portable snapshot container. A snapshot is the complete migratable
//! state of a running instance:
//!   - full contents of every linear memory (the guest's live shadow stack,
//!     saved application globals, and table shadows all live *inside* memory
//!     by construction, so they ride along for free)
//!   - the i32 control globals listed in the module meta
//!   - one opaque blob per registered host service
//!
//! The same bytes work as an on-disk checkpoint file and as the logical
//! payload of a live migration; `state_hash` is the end-to-end integrity
//! check a migration target must reproduce before resuming.

use crate::sha256::Sha256;
use crate::types::*;
use anyhow::{bail, Result};

const MAGIC: &[u8; 4] = b"WVSN";

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub module_hash: [u8; 32],
    /// Full contents of each linear memory, by index. Length is always a
    /// multiple of the wasm page size.
    pub memories: Vec<Vec<u8>>,
    /// (export name, value) for each control global, in meta order.
    pub globals: Vec<(String, i32)>,
    /// (service name, opaque state blob), sorted by name.
    pub services: Vec<(String, Vec<u8>)>,
}

/// Incremental builder for the end-to-end state verification hash. Both
/// migration peers must produce byte-identical input streams: call
/// `mem_begin`/`mem_chunk` for every memory in index order, then `globals`,
/// then `services`. Kept as the single definition used by snapshots and the
/// live protocol alike.
pub struct StateHasher {
    h: Sha256,
}

impl StateHasher {
    pub fn new(n_mems: u32) -> Self {
        let mut h = Sha256::new();
        h.update(b"WVSH");
        h.update(&n_mems.to_le_bytes());
        StateHasher { h }
    }

    pub fn mem_begin(&mut self, len: u64) {
        self.h.update(&len.to_le_bytes());
    }

    pub fn mem_chunk(&mut self, bytes: &[u8]) {
        self.h.update(bytes);
    }

    pub fn globals(&mut self, globals: &[(String, i32)]) {
        self.h.update(&(globals.len() as u32).to_le_bytes());
        for (name, v) in globals {
            self.h.update(&(name.len() as u32).to_le_bytes());
            self.h.update(name.as_bytes());
            self.h.update(&v.to_le_bytes());
        }
    }

    pub fn services(&mut self, services: &[(String, Vec<u8>)]) {
        let mut svcs: Vec<_> = services.iter().collect();
        svcs.sort_by(|a, b| a.0.cmp(&b.0));
        self.h.update(&(svcs.len() as u32).to_le_bytes());
        for (name, blob) in svcs {
            self.h.update(&(name.len() as u32).to_le_bytes());
            self.h.update(name.as_bytes());
            self.h.update(&(blob.len() as u64).to_le_bytes());
            self.h.update(blob);
        }
    }

    pub fn finish(self) -> [u8; 32] {
        self.h.finish()
    }
}

impl Snapshot {
    pub fn state_hash(&self) -> [u8; 32] {
        let mut h = StateHasher::new(self.memories.len() as u32);
        for m in &self.memories {
            h.mem_begin(m.len() as u64);
            h.mem_chunk(m);
        }
        h.globals(&self.globals);
        h.services(&self.services);
        h.finish()
    }

    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, crate::WEAVE_VERSION);
        out.extend_from_slice(&self.module_hash);
        put_u32(&mut out, self.memories.len() as u32);
        for m in &self.memories {
            put_u64(&mut out, m.len() as u64);
            out.extend_from_slice(m);
        }
        put_u32(&mut out, self.globals.len() as u32);
        for (name, v) in &self.globals {
            put_str(&mut out, name);
            put_u32(&mut out, *v as u32);
        }
        put_u32(&mut out, self.services.len() as u32);
        for (name, blob) in &self.services {
            put_str(&mut out, name);
            put_bytes(&mut out, blob);
        }
        out.extend_from_slice(&self.state_hash());
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Snapshot> {
        let mut pos = 0usize;
        if buf.len() < 6 || &buf[..4] != MAGIC {
            bail!("snapshot: bad magic");
        }
        pos += 4;
        let ver = get_u16(buf, &mut pos)?;
        if ver != crate::WEAVE_VERSION {
            bail!("snapshot: unsupported version {ver}");
        }
        if buf.len() < pos + 32 {
            bail!("snapshot: truncated module hash");
        }
        let mut module_hash = [0u8; 32];
        module_hash.copy_from_slice(&buf[pos..pos + 32]);
        pos += 32;
        let n_mems = get_u32(buf, &mut pos)? as usize;
        let mut memories = Vec::with_capacity(n_mems);
        for _ in 0..n_mems {
            let len = get_u64(buf, &mut pos)? as usize;
            if buf.len() < pos + len {
                bail!("snapshot: truncated memory");
            }
            memories.push(buf[pos..pos + len].to_vec());
            pos += len;
        }
        let n_globals = get_u32(buf, &mut pos)? as usize;
        let mut globals = Vec::with_capacity(n_globals);
        for _ in 0..n_globals {
            let name = get_str(buf, &mut pos)?;
            let v = get_u32(buf, &mut pos)? as i32;
            globals.push((name, v));
        }
        let n_svcs = get_u32(buf, &mut pos)? as usize;
        let mut services = Vec::with_capacity(n_svcs);
        for _ in 0..n_svcs {
            let name = get_str(buf, &mut pos)?;
            let blob = get_bytes(buf, &mut pos)?;
            services.push((name, blob));
        }
        if buf.len() < pos + 32 {
            bail!("snapshot: truncated state hash");
        }
        let mut expect = [0u8; 32];
        expect.copy_from_slice(&buf[pos..pos + 32]);
        let snap = Snapshot { module_hash, memories, globals, services };
        if snap.state_hash() != expect {
            bail!("snapshot: state hash mismatch (corrupt snapshot)");
        }
        Ok(snap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_integrity() {
        let snap = Snapshot {
            module_hash: [7u8; 32],
            memories: vec![vec![0u8; crate::WASM_PAGE_SIZE], vec![9u8; crate::WASM_PAGE_SIZE * 2]],
            globals: vec![("__weave_state".into(), 1), ("__weave_sp".into(), 65536)],
            services: vec![("env".into(), vec![1, 2, 3])],
        };
        let enc = snap.encode();
        assert_eq!(Snapshot::decode(&enc).unwrap(), snap);

        let mut corrupt = enc.clone();
        let mid = corrupt.len() / 2;
        corrupt[mid] ^= 0xff;
        assert!(Snapshot::decode(&corrupt).is_err());
    }
}
