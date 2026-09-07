//! weave-wasmtime: the Weave host plugin for the wasmtime engine.
//!
//! This is a concrete implementation of the engine-agnostic pieces in
//! `weave-host`: it wires `weave.poll` as a host function, exposes the guest's
//! exported memory and control globals to the checkpoint/migration machinery,
//! and implements both ends of a live migration. The same design (poll host
//! fn + read/write exported memory & globals + drive `__weave_resume`) is what
//! the JS and Go plugins reimplement against their runtimes.
//!
//! [`WeaveInstance`] enforces its host-side [`InstanceState`]: call a fresh
//! entry, checkpoint/resume only after unwind, and restore only into an unused
//! uninitialized target. Retired migration sources and failed instances cannot
//! execute again. Methods are synchronous; run them on an application worker
//! thread when a UI/event loop must stay responsive. A [`CancellationHandle`]
//! can request a resumable unwind from another thread at the next guest poll.

pub mod instance;
pub mod migrate;
pub mod poll;
pub mod serve;

pub use instance::{CancellationHandle, Ctx, InstanceState, LinkFn, WeaveInstance, WorkResult};
pub use poll::Poller;

use anyhow::{Context, Result};
use std::sync::Arc;
use wasmtime::{Config, Engine};
use weave_core::Meta;
use weave_transform::{transform, TransformOptions};

/// A transformed module plus its meta, ready to instantiate.
#[derive(Clone)]
pub struct WeaveModule {
    pub wasm: Arc<Vec<u8>>,
    pub meta: Arc<Meta>,
    pub module_hash: [u8; 32],
}

impl WeaveModule {
    /// Transform a raw module and prepare it for weaving.
    pub fn from_raw(raw: &[u8], opts: &TransformOptions) -> Result<WeaveModule> {
        let out = transform(raw, opts).context("transforming module")?;
        let module_hash = weave_core::sha256::sha256(&out.wasm);
        Ok(WeaveModule {
            wasm: Arc::new(out.wasm),
            meta: Arc::new(out.meta),
            module_hash,
        })
    }

    /// Wrap an already-transformed module (e.g. received over the wire).
    pub fn from_transformed(wasm: Vec<u8>, meta: Meta) -> WeaveModule {
        let module_hash = weave_core::sha256::sha256(&wasm);
        WeaveModule {
            wasm: Arc::new(wasm),
            meta: Arc::new(meta),
            module_hash,
        }
    }

    /// Compile and validate the complete woven ABI without instantiating the
    /// guest, invoking imports, or running its original start function.
    /// This checks engine compatibility and metadata/export agreement, not
    /// application host-service compatibility or the workload's behavior.
    pub fn validate(&self, engine: &Engine) -> Result<()> {
        let module = wasmtime::Module::from_binary(engine, &self.wasm)
            .context("compiling woven module for inspection")?;
        instance::validate_module_abi(&module, &self.wasm, &self.meta)
            .context("validating woven module ABI")
    }
}

/// Build an engine configured the way Weave needs (reference types + bulk
/// memory for funcref shadowing and table ops; SIMD for v128 state).
pub fn default_engine() -> Result<Engine> {
    let mut config = Config::new();
    config.wasm_reference_types(true);
    config.wasm_bulk_memory(true);
    config.wasm_simd(true);
    Engine::new(&config).context("creating wasmtime engine")
}

#[cfg(test)]
mod inspection_tests {
    use super::*;

    #[test]
    fn validation_does_not_execute_original_start_or_imports() {
        let raw = wat::parse_str(
            r#"(module
            (import "missing" "effect" (func $effect))
            (func $start call $effect unreachable)
            (start $start)
            (func (export "run") (result i32) i32.const 7))"#,
        )
        .unwrap();
        let module = WeaveModule::from_raw(&raw, &TransformOptions::default()).unwrap();
        let engine = default_engine().unwrap();
        // No linker/services exist; executing init would fail immediately.
        module.validate(&engine).unwrap();
        let mut wrong_meta = (*module.meta).clone();
        wrong_meta.memories[0] = "missing-memory".into();
        let wrong = WeaveModule::from_transformed((*module.wasm).clone(), wrong_meta);
        assert!(wrong.validate(&engine).is_err());
    }
}
