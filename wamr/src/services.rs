use anyhow::{bail, Result};
use std::collections::HashSet;

const EMIT: &str = "env.emit";
const EMIT32: &str = "env.emit32";
const EMIT64: &str = "env.emit64";

#[derive(Default, Clone, Copy)]
struct EmitState {
    count: u64,
    sum: i64,
}

impl EmitState {
    fn snapshot(self) -> Vec<u8> {
        let mut out = Vec::with_capacity(16);
        out.extend_from_slice(&self.count.to_le_bytes());
        out.extend_from_slice(&self.sum.to_le_bytes());
        out
    }

    fn restore(&mut self, blob: &[u8]) -> Result<()> {
        if blob.len() != 16 {
            bail!(
                "bad emit service snapshot: expected 16 bytes, got {}",
                blob.len()
            );
        }
        self.count = u64::from_le_bytes(blob[..8].try_into().unwrap());
        self.sum = i64::from_le_bytes(blob[8..].try_into().unwrap());
        Ok(())
    }
}

#[derive(Default)]
pub struct EmitServices {
    emit: EmitState,
    emit32: EmitState,
    emit64: EmitState,
}

impl EmitServices {
    pub fn emit(&mut self, i: i32, h: i64) {
        self.emit.count = self.emit.count.wrapping_add(1);
        self.emit.sum = self.emit.sum.wrapping_add(h).wrapping_add(i as i64);
        println!("EMIT {i} {h}");
    }

    pub fn emit32(&mut self, value: i32) {
        self.emit32.count = self.emit32.count.wrapping_add(1);
        self.emit32.sum = self.emit32.sum.wrapping_add(value as i64);
        println!("EMIT32 {value}");
    }

    pub fn emit64(&mut self, value: i64) {
        self.emit64.count = self.emit64.count.wrapping_add(1);
        self.emit64.sum = self.emit64.sum.wrapping_add(value);
        println!("EMIT64 {value}");
    }

    pub fn snapshot(&self) -> Vec<(String, Vec<u8>)> {
        // This is already lexicographic, as required by StateHasher.
        vec![
            (EMIT.to_owned(), self.emit.snapshot()),
            (EMIT32.to_owned(), self.emit32.snapshot()),
            (EMIT64.to_owned(), self.emit64.snapshot()),
        ]
    }

    pub fn restore(&mut self, blobs: &[(String, Vec<u8>)]) -> Result<()> {
        let mut seen = HashSet::new();
        for (name, blob) in blobs {
            if !seen.insert(name.as_str()) {
                bail!("duplicate service snapshot {name}");
            }
            match name.as_str() {
                EMIT => self.emit.restore(blob)?,
                EMIT32 => self.emit32.restore(blob)?,
                EMIT64 => self.emit64.restore(blob)?,
                _ => bail!("unsupported migrated host service {name}"),
            }
        }
        for required in [EMIT, EMIT32, EMIT64] {
            if !seen.contains(required) {
                bail!("migration omitted required host service {required}");
            }
        }
        Ok(())
    }
}
