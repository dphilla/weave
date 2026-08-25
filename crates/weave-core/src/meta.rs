//! The `weave.meta` custom section: everything a host plugin needs to know
//! about a transformed module in order to run, checkpoint, transfer and
//! resume it. Emitted by `weave-transform`, parsed by every host plugin.

use crate::types::*;
use anyhow::{bail, Result};

const MAGIC: &[u8; 4] = b"WVMT";

#[derive(Debug, Clone, PartialEq)]
pub struct EntryMeta {
    /// Export name (the wrapper replaces the original export in place).
    pub name: String,
    pub params: Vec<ValType>,
    pub results: Vec<ValType>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImportMeta {
    pub module: String,
    pub name: String,
    pub params: Vec<ValType>,
    pub results: Vec<ValType>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Meta {
    pub version: u16,
    /// Poll countdown period the module was instrumented with.
    pub poll_period: u32,
    /// Callable entry points; `__weave_entry` indexes into this list.
    pub entries: Vec<EntryMeta>,
    /// Export name of each memory, by memory index.
    pub memories: Vec<String>,
    /// Host functions the module imports (excluding `weave.poll`). A receiving
    /// node must be able to satisfy all of these before accepting a migration.
    pub imports: Vec<ImportMeta>,
    /// Exported mutable i32 globals that constitute the module's non-memory
    /// state. Transferred verbatim (name -> i32) during migration.
    pub control_globals: Vec<String>,
    /// Size in bytes of the saved-application-globals area at the start of the
    /// weave region (whose base address lives in the `__weave_rbase` control
    /// global). Entry results are written immediately after this area.
    pub globals_area_size: u32,
    /// Size in bytes of the entry-results area.
    pub results_area_size: u32,
}

fn put_types(out: &mut Vec<u8>, tys: &[ValType]) {
    put_u16(out, tys.len() as u16);
    for t in tys {
        out.push(t.code());
    }
}

fn get_types(buf: &[u8], pos: &mut usize) -> Result<Vec<ValType>> {
    let n = get_u16(buf, pos)? as usize;
    let mut v = Vec::with_capacity(n);
    for _ in 0..n {
        v.push(ValType::from_code(get_u8(buf, pos)?)?);
    }
    Ok(v)
}

impl Meta {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(MAGIC);
        put_u16(&mut out, self.version);
        put_u32(&mut out, self.poll_period);
        put_u16(&mut out, self.entries.len() as u16);
        for e in &self.entries {
            put_str(&mut out, &e.name);
            put_types(&mut out, &e.params);
            put_types(&mut out, &e.results);
        }
        put_u16(&mut out, self.memories.len() as u16);
        for m in &self.memories {
            put_str(&mut out, m);
        }
        put_u16(&mut out, self.imports.len() as u16);
        for i in &self.imports {
            put_str(&mut out, &i.module);
            put_str(&mut out, &i.name);
            put_types(&mut out, &i.params);
            put_types(&mut out, &i.results);
        }
        put_u16(&mut out, self.control_globals.len() as u16);
        for g in &self.control_globals {
            put_str(&mut out, g);
        }
        put_u32(&mut out, self.globals_area_size);
        put_u32(&mut out, self.results_area_size);
        out
    }

    pub fn decode(buf: &[u8]) -> Result<Meta> {
        let mut pos = 0usize;
        if buf.len() < 4 || &buf[..4] != MAGIC {
            bail!("weave.meta: bad magic");
        }
        pos += 4;
        let version = get_u16(buf, &mut pos)?;
        if version != crate::WEAVE_VERSION {
            bail!("weave.meta: unsupported version {version}");
        }
        let poll_period = get_u32(buf, &mut pos)?;
        let n_entries = get_u16(buf, &mut pos)? as usize;
        let mut entries = Vec::with_capacity(n_entries);
        for _ in 0..n_entries {
            entries.push(EntryMeta {
                name: get_str(buf, &mut pos)?,
                params: get_types(buf, &mut pos)?,
                results: get_types(buf, &mut pos)?,
            });
        }
        let n_mems = get_u16(buf, &mut pos)? as usize;
        let mut memories = Vec::with_capacity(n_mems);
        for _ in 0..n_mems {
            memories.push(get_str(buf, &mut pos)?);
        }
        let n_imports = get_u16(buf, &mut pos)? as usize;
        let mut imports = Vec::with_capacity(n_imports);
        for _ in 0..n_imports {
            imports.push(ImportMeta {
                module: get_str(buf, &mut pos)?,
                name: get_str(buf, &mut pos)?,
                params: get_types(buf, &mut pos)?,
                results: get_types(buf, &mut pos)?,
            });
        }
        let n_cg = get_u16(buf, &mut pos)? as usize;
        let mut control_globals = Vec::with_capacity(n_cg);
        for _ in 0..n_cg {
            control_globals.push(get_str(buf, &mut pos)?);
        }
        let globals_area_size = get_u32(buf, &mut pos)?;
        let results_area_size = get_u32(buf, &mut pos)?;
        if pos != buf.len() {
            bail!("weave.meta: trailing bytes");
        }
        Ok(Meta {
            version,
            poll_period,
            entries,
            memories,
            imports,
            control_globals,
            globals_area_size,
            results_area_size,
        })
    }

    pub fn entry_index(&self, name: &str) -> Option<usize> {
        self.entries.iter().position(|e| e.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let m = Meta {
            version: crate::WEAVE_VERSION,
            poll_period: 512,
            entries: vec![EntryMeta {
                name: "run".into(),
                params: vec![ValType::I32, ValType::I64],
                results: vec![ValType::F64],
            }],
            memories: vec!["memory".into(), "__weave_mem1".into()],
            imports: vec![ImportMeta {
                module: "env".into(),
                name: "emit".into(),
                params: vec![ValType::I32],
                results: vec![],
            }],
            control_globals: vec!["__weave_state".into(), "__weave_sp".into()],
            globals_area_size: 40,
            results_area_size: 16,
        };
        let enc = m.encode();
        assert_eq!(Meta::decode(&enc).unwrap(), m);
    }
}
