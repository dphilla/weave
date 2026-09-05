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
use anyhow::{bail, Context, Result};

const MAGIC: &[u8; 4] = b"WVSN";

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub module_hash: [u8; 32],
    /// Full contents of each linear memory, by index. Length is always a
    /// multiple of the wasm page size.
    pub memories: Vec<Vec<u8>>,
    /// (export name, value) for each control global, in meta order.
    pub globals: Vec<(String, i32)>,
    /// (service name, opaque state blob), sorted by UTF-8 name bytes.
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
        self.services_in_order(
            svcs.into_iter()
                .map(|(name, blob)| (name.as_str(), blob.as_slice())),
        );
    }

    fn services_in_order<'a>(
        &mut self,
        services: impl ExactSizeIterator<Item = (&'a str, &'a [u8])>,
    ) {
        self.h.update(&(services.len() as u32).to_le_bytes());
        for (name, blob) in services {
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

    /// Decode an input-sized snapshot. Collection counts are bounded by their
    /// minimum encoded sizes before reservation, and decoder allocations are
    /// fallible. Callers should still bound the file/input size to their own
    /// resource budget before reading it into memory.
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
        // The checksum is never available to satisfy a declared count or
        // length. Three collection counts must remain after the header.
        let payload_end = buf
            .len()
            .checked_sub(32)
            .filter(|end| end.saturating_sub(pos) >= 12)
            .ok_or_else(|| anyhow::anyhow!("snapshot: truncated counts or state hash"))?;
        let payload = &buf[..payload_end];
        let n_mems = snapshot_count(payload, &mut pos, 8, "memories")?;
        let mut memories = snapshot_vec(n_mems)?;
        for _ in 0..n_mems {
            let len = usize::try_from(get_u64(payload, &mut pos)?)
                .map_err(|_| anyhow::anyhow!("snapshot: memory length does not fit host"))?;
            memories.push(snapshot_copy(snapshot_slice(payload, &mut pos, len)?)?);
        }
        let n_globals = snapshot_count(payload, &mut pos, 4, "globals")?;
        let mut globals = snapshot_vec(n_globals)?;
        for _ in 0..n_globals {
            let name = snapshot_name(payload, &mut pos)?;
            let v = get_u32(payload, &mut pos)? as i32;
            globals.push((name, v));
        }
        let n_svcs = snapshot_count(payload, &mut pos, 0, "services")?;
        let mut services = snapshot_vec(n_svcs)?;
        for _ in 0..n_svcs {
            let name = snapshot_name(payload, &mut pos)?;
            let len = get_u32(payload, &mut pos)? as usize;
            let blob = snapshot_copy(snapshot_slice(payload, &mut pos, len)?)?;
            services.push((name, blob));
        }
        if pos != payload_end {
            bail!("snapshot: trailing bytes");
        }

        // Hashing service state normally sorts a temporary list. Reserve that
        // list fallibly too, and use an allocation-free sort. The index tie
        // breaker preserves the stable ordering of duplicate names used by
        // StateHasher::services without mutating the decoded snapshot.
        let mut order = snapshot_vec(n_svcs)?;
        order.extend(services.iter().enumerate());
        order.sort_unstable_by(|(a_index, a), (b_index, b)| {
            a.0.cmp(&b.0).then(a_index.cmp(b_index))
        });
        let mut hash = StateHasher::new(n_mems as u32);
        for memory in &memories {
            hash.mem_begin(memory.len() as u64);
            hash.mem_chunk(memory);
        }
        hash.globals(&globals);
        hash.services_in_order(
            order
                .into_iter()
                .map(|(_, (name, blob))| (name.as_str(), blob.as_slice())),
        );
        if hash.finish() != buf[payload_end..] {
            bail!("snapshot: state hash mismatch (corrupt snapshot)");
        }
        let snap = Snapshot {
            module_hash,
            memories,
            globals,
            services,
        };
        Ok(snap)
    }
}

/// Every collection item needs at least eight encoded bytes: a memory's u64
/// length, a global's name length plus value, or a service's two lengths.
/// Reserve the remaining collection headers as well as bounding by the input.
fn snapshot_count(buf: &[u8], pos: &mut usize, tail: usize, kind: &str) -> Result<usize> {
    let count = get_u32(buf, pos)? as usize;
    let available = buf.len().saturating_sub(*pos);
    if available < tail || count > (available - tail) / 8 {
        bail!("snapshot: {kind} count exceeds remaining input");
    }
    Ok(count)
}

fn snapshot_vec<T>(capacity: usize) -> Result<Vec<T>> {
    let mut out = Vec::new();
    out.try_reserve_exact(capacity)
        .context("snapshot: allocation failed")?;
    Ok(out)
}

fn snapshot_slice<'a>(buf: &'a [u8], pos: &mut usize, len: usize) -> Result<&'a [u8]> {
    let end = pos
        .checked_add(len)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("snapshot: truncated field"))?;
    let bytes = &buf[*pos..end];
    *pos = end;
    Ok(bytes)
}

fn snapshot_copy(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut out = snapshot_vec(bytes.len())?;
    out.extend_from_slice(bytes);
    Ok(out)
}

fn snapshot_name(buf: &[u8], pos: &mut usize) -> Result<String> {
    let len = get_u32(buf, pos)? as usize;
    let name = std::str::from_utf8(snapshot_slice(buf, pos, len)?)?;
    let mut out = String::new();
    out.try_reserve_exact(name.len())
        .context("snapshot: allocating name failed")?;
    out.push_str(name);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_integrity() {
        let snap = Snapshot {
            module_hash: [7u8; 32],
            memories: vec![
                vec![0u8; crate::WASM_PAGE_SIZE],
                vec![9u8; crate::WASM_PAGE_SIZE * 2],
            ],
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

    #[test]
    fn empty_and_unsorted_services_keep_the_snapshot_format() {
        let mut snap = Snapshot {
            module_hash: [0; 32],
            memories: vec![],
            globals: vec![],
            services: vec![],
        };
        assert_eq!(Snapshot::decode(&snap.encode()).unwrap(), snap);
        snap.memories = vec![vec![], vec![]];
        snap.globals = vec![("".into(), -1), ("日本語".into(), i32::MIN)];
        // Preserve input order, including equal names, while hashing in stable
        // UTF-8 name order exactly as the existing format specifies.
        snap.services = vec![
            ("z".into(), vec![1]),
            ("".into(), vec![]),
            ("é".into(), vec![2, 3]),
            ("z".into(), vec![4]),
        ];
        assert_eq!(Snapshot::decode(&snap.encode()).unwrap(), snap);
    }

    #[test]
    fn truncation_trailing_data_and_invalid_utf8_reject() {
        let snap = Snapshot {
            module_hash: [3; 32],
            memories: vec![vec![4; 17]],
            globals: vec![("g".into(), 7)],
            services: vec![("s".into(), vec![8; 11])],
        };
        let bytes = snap.encode();
        for end in 0..bytes.len() {
            assert!(Snapshot::decode(&bytes[..end]).is_err(), "prefix {end}");
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(Snapshot::decode(&trailing).is_err());
        let mut invalid_name = bytes;
        invalid_name[38 + 4 + 8 + 17 + 4 + 4] = 0xff;
        assert!(Snapshot::decode(&invalid_name).is_err());
    }

    #[test]
    fn fallible_reservation_reports_capacity_overflow() {
        assert!(snapshot_vec::<u64>(usize::MAX).is_err());
    }
}
