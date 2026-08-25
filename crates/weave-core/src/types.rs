//! Core value model. Weave moves *bit-exact* state, so values are carried as
//! raw little-endian bit patterns, never as host-native floats (this preserves
//! NaN payloads and signalling bits across runtimes).

use anyhow::{bail, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ValType {
    I32,
    I64,
    F32,
    F64,
    V128,
    /// Function references are migratable because the transformer shadows every
    /// funcref with its function *index* and rehydrates through a canonical
    /// all-functions table on the far side.
    FuncRef,
}

impl ValType {
    pub fn code(self) -> u8 {
        match self {
            ValType::I32 => 0,
            ValType::I64 => 1,
            ValType::F32 => 2,
            ValType::F64 => 3,
            ValType::V128 => 4,
            ValType::FuncRef => 5,
        }
    }

    pub fn from_code(c: u8) -> Result<Self> {
        Ok(match c {
            0 => ValType::I32,
            1 => ValType::I64,
            2 => ValType::F32,
            3 => ValType::F64,
            4 => ValType::V128,
            5 => ValType::FuncRef,
            _ => bail!("unknown ValType code {c}"),
        })
    }

    /// Size in bytes when spilled to linear memory.
    pub fn byte_size(self) -> u32 {
        match self {
            ValType::I32 | ValType::F32 => 4,
            ValType::I64 | ValType::F64 => 8,
            ValType::V128 => 16,
            // funcrefs spill as their i32 shadow index
            ValType::FuncRef => 4,
        }
    }
}

/// A value as raw bits. `bits` is little-endian, zero-extended to 16 bytes.
/// For FuncRef, bits\[0..4\] is the i32 function index (u32::MAX = null).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Val {
    pub ty: ValType,
    pub bits: [u8; 16],
}

impl Val {
    pub fn new(ty: ValType, bits: [u8; 16]) -> Self {
        Val { ty, bits }
    }

    pub fn i32(v: i32) -> Self {
        let mut b = [0u8; 16];
        b[..4].copy_from_slice(&v.to_le_bytes());
        Val {
            ty: ValType::I32,
            bits: b,
        }
    }

    pub fn i64(v: i64) -> Self {
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&v.to_le_bytes());
        Val {
            ty: ValType::I64,
            bits: b,
        }
    }

    pub fn f32_bits(v: u32) -> Self {
        let mut b = [0u8; 16];
        b[..4].copy_from_slice(&v.to_le_bytes());
        Val {
            ty: ValType::F32,
            bits: b,
        }
    }

    pub fn f64_bits(v: u64) -> Self {
        let mut b = [0u8; 16];
        b[..8].copy_from_slice(&v.to_le_bytes());
        Val {
            ty: ValType::F64,
            bits: b,
        }
    }

    pub fn as_i32(&self) -> i32 {
        i32::from_le_bytes(self.bits[..4].try_into().unwrap())
    }

    pub fn as_i64(&self) -> i64 {
        i64::from_le_bytes(self.bits[..8].try_into().unwrap())
    }

    pub fn as_f32_bits(&self) -> u32 {
        u32::from_le_bytes(self.bits[..4].try_into().unwrap())
    }

    pub fn as_f64_bits(&self) -> u64 {
        u64::from_le_bytes(self.bits[..8].try_into().unwrap())
    }

    pub fn write_to(&self, out: &mut Vec<u8>) {
        out.push(self.ty.code());
        out.extend_from_slice(&self.bits);
    }

    pub fn read_from(buf: &[u8], pos: &mut usize) -> Result<Self> {
        let end = (*pos)
            .checked_add(17)
            .filter(|end| *end <= buf.len())
            .ok_or_else(|| anyhow::anyhow!("truncated Val"))?;
        let ty = ValType::from_code(buf[*pos])?;
        let mut bits = [0u8; 16];
        bits.copy_from_slice(&buf[*pos + 1..end]);
        *pos = end;
        Ok(Val { ty, bits })
    }
}

// ---- small binary-codec helpers shared by meta/wire/snapshot ----

pub fn put_str(out: &mut Vec<u8>, s: &str) {
    put_u32(out, s.len() as u32);
    out.extend_from_slice(s.as_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, b: &[u8]) {
    put_u32(out, b.len() as u32);
    out.extend_from_slice(b);
}

pub fn put_u16(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub fn get_u8(buf: &[u8], pos: &mut usize) -> Result<u8> {
    let end = (*pos)
        .checked_add(1)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated u8"))?;
    let v = buf[*pos];
    *pos = end;
    Ok(v)
}

pub fn get_u16(buf: &[u8], pos: &mut usize) -> Result<u16> {
    let end = (*pos)
        .checked_add(2)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated u16"))?;
    let v = u16::from_le_bytes(buf[*pos..end].try_into().unwrap());
    *pos = end;
    Ok(v)
}

pub fn get_u32(buf: &[u8], pos: &mut usize) -> Result<u32> {
    let end = (*pos)
        .checked_add(4)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated u32"))?;
    let v = u32::from_le_bytes(buf[*pos..end].try_into().unwrap());
    *pos = end;
    Ok(v)
}

pub fn get_u64(buf: &[u8], pos: &mut usize) -> Result<u64> {
    let end = (*pos)
        .checked_add(8)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated u64"))?;
    let v = u64::from_le_bytes(buf[*pos..end].try_into().unwrap());
    *pos = end;
    Ok(v)
}

pub fn get_str(buf: &[u8], pos: &mut usize) -> Result<String> {
    let n = get_u32(buf, pos)? as usize;
    let end = (*pos)
        .checked_add(n)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated string"))?;
    let s = std::str::from_utf8(&buf[*pos..end])?.to_string();
    *pos = end;
    Ok(s)
}

pub fn get_bytes(buf: &[u8], pos: &mut usize) -> Result<Vec<u8>> {
    let n = get_u32(buf, pos)? as usize;
    let end = (*pos)
        .checked_add(n)
        .filter(|end| *end <= buf.len())
        .ok_or_else(|| anyhow::anyhow!("truncated bytes"))?;
    let b = buf[*pos..end].to_vec();
    *pos = end;
    Ok(b)
}
