//! Static preflight only: no linker, instantiation, initialization, or guest call.
use super::{
    check_imports, cli_error, control, default_engine, load_module, parse_entry_args, Args,
    Reported,
};
use anyhow::{Context, Result};
use serde_json::{json, Value};
use wasmparser::{Payload, Validator, WasmFeatures};
use weave_core::control::{Capabilities, ImportCapability, Limits};
use weave_core::ValType;

pub(crate) fn types(types: &[ValType]) -> Vec<String> {
    types
        .iter()
        .map(|ty| format!("{ty:?}").to_lowercase())
        .collect()
}
pub(crate) fn builtin_imports() -> Vec<ImportCapability> {
    [
        ("emit", vec!["i32", "i64"]),
        ("emit32", vec!["i32"]),
        ("emit64", vec!["i64"]),
    ]
    .into_iter()
    .map(|(name, params)| ImportCapability {
        module: "env".into(),
        name: name.into(),
        params: params.into_iter().map(String::from).collect(),
        results: vec![],
    })
    .collect()
}
pub(crate) fn builtin_capabilities() -> Capabilities {
    Capabilities {
        runtime: "wasmtime".into(),
        adapter_version: env!("CARGO_PKG_VERSION").into(),
        migration_protocol: 2,
        services: Some(vec![
            "env.emit".into(),
            "env.emit32".into(),
            "env.emit64".into(),
        ]),
        imports: Some(builtin_imports()),
        // Wasmtime31 default engine enables Wasm2 plus these proposals. Do not
        // equate runtime support with the transformer's supported guest subset.
        features: [
            "multi_memory",
            "simd",
            "reference_types",
            "bulk_memory",
            "multi_value",
            "sign_extension",
            "saturating_float_to_int",
            "extended_const",
            "tail_call",
            "memory64",
            "relaxed_simd",
        ]
        .into_iter()
        .map(String::from)
        .collect(),
        limits: Limits {
            module_bytes: Some(weave_host::target::MAX_MODULE_SIZE),
            memory_bytes: Some(weave_host::target::DEFAULT_MAX_MEMORY_BYTES),
            ..Limits::default()
        },
    }
}
fn feature_flags() -> Vec<(&'static str, WasmFeatures)> {
    vec![
        ("multi_memory", WasmFeatures::MULTI_MEMORY),
        ("simd", WasmFeatures::SIMD),
        ("reference_types", WasmFeatures::REFERENCE_TYPES),
        ("bulk_memory", WasmFeatures::BULK_MEMORY),
        ("multi_value", WasmFeatures::MULTI_VALUE),
        ("sign_extension", WasmFeatures::SIGN_EXTENSION),
        (
            "saturating_float_to_int",
            WasmFeatures::SATURATING_FLOAT_TO_INT,
        ),
        ("extended_const", WasmFeatures::EXTENDED_CONST),
        ("tail_call", WasmFeatures::TAIL_CALL),
        ("memory64", WasmFeatures::MEMORY64),
        ("threads", WasmFeatures::THREADS),
        ("exceptions", WasmFeatures::EXCEPTIONS),
        ("gc", WasmFeatures::GC),
        ("relaxed_simd", WasmFeatures::RELAXED_SIMD),
        ("function_references", WasmFeatures::FUNCTION_REFERENCES),
    ]
}
fn required_features(wasm: &[u8]) -> Result<Vec<String>> {
    Validator::new_with_features(WasmFeatures::default()).validate_all(wasm)?;
    Ok(feature_flags()
        .into_iter()
        .filter_map(|(name, feature)| {
            let mut enabled = WasmFeatures::default();
            enabled.remove(feature);
            Validator::new_with_features(enabled)
                .validate_all(wasm)
                .is_err()
                .then(|| name.to_owned())
        })
        .collect())
}
fn finding(code: &str, message: impl Into<String>) -> Value {
    json!({"code":code,"message":message.into()})
}
fn compare(
    caps: &Capabilities,
    imports: &[ImportCapability],
    features: &[String],
    memory_bytes: u64,
    module_bytes: u64,
) -> Vec<Value> {
    let mut failures = vec![];
    if caps.migration_protocol != 2 {
        failures.push(finding(
            "PROTOCOL_MISMATCH",
            "target does not advertise migration protocol 2",
        ));
    }
    match &caps.imports {
        Some(provided) => {
            for import in imports {
                if !provided.contains(import) {
                    failures.push(finding(
                        "UNSUPPORTED_IMPORT",
                        format!(
                            "target does not provide {}.{}({}) -> ({})",
                            import.module,
                            import.name,
                            import.params.join(","),
                            import.results.join(",")
                        ),
                    ));
                }
            }
        }
        None if !imports.is_empty() => failures.push(finding(
            "CAPABILITIES_UNKNOWN",
            "target host import signatures are unknown",
        )),
        None => {}
    }
    // This preflight profile matches the central CLI's source factory, which
    // snapshots all three built-ins, including services unused by this guest.
    match &caps.services {
        Some(services) => {
            for name in ["env.emit", "env.emit32", "env.emit64"] {
                if !services.iter().any(|s| s == name) {
                    failures.push(finding(
                        "MISSING_SERVICE",
                        format!("target lacks CLI snapshot service {name}"),
                    ));
                }
            }
        }
        None => failures.push(finding(
            "CAPABILITIES_UNKNOWN",
            "target snapshot services are unknown",
        )),
    }
    for feature in features {
        if !caps.features.contains(feature) {
            failures.push(finding(
                "FEATURE_NOT_ADVERTISED",
                format!("target does not advertise {feature}"),
            ));
        }
    }
    for (kind, required, limit) in [
        ("memory", memory_bytes, caps.limits.memory_bytes),
        ("module", module_bytes, caps.limits.module_bytes),
    ] {
        match limit {
            Some(limit) if required > limit => failures.push(finding(
                "RESOURCE_LIMIT",
                format!("initial {kind} requires {required} bytes, target limit is {limit}"),
            )),
            None => failures.push(finding(
                "CAPABILITIES_UNKNOWN",
                format!("target {kind} limit is unknown"),
            )),
            _ => {}
        }
    }
    failures
}

pub(crate) fn run(args: &Args) -> Result<()> {
    let path = &args.positional[0];
    let module =
        load_module(path, args).map_err(|e| cli_error("MODULE_INVALID", 3, format!("{e:#}")))?;
    let engine = default_engine()?;
    module
        .validate(&engine)
        .map_err(|e| cli_error("MODULE_INVALID", 3, format!("{e:#}")))?;
    let imports: Vec<ImportCapability> = module
        .meta
        .imports
        .iter()
        .map(|i| ImportCapability {
            module: i.module.clone(),
            name: i.name.clone(),
            params: types(&i.params),
            results: types(&i.results),
        })
        .collect();
    let features = required_features(&module.wasm)?;
    let mut memories = vec![];
    let mut exports = vec![];
    let mut initial_memory_bytes = 0u64;
    for payload in wasmparser::Parser::new(0).parse_all(&module.wasm) {
        match payload? {
            Payload::MemorySection(section) => {
                for memory in section {
                    let memory = memory?;
                    let page_bytes = 1u64
                        .checked_shl(memory.page_size_log2.unwrap_or(16))
                        .context("memory page size overflow")?;
                    let bytes = memory
                        .initial
                        .checked_mul(page_bytes)
                        .context("memory size overflow")?;
                    initial_memory_bytes = initial_memory_bytes
                        .checked_add(bytes)
                        .context("total memory size overflow")?;
                    memories.push(json!({"index":memories.len(),"initial_pages":memory.initial,"initial_bytes":bytes,"maximum_pages":memory.maximum,"page_bytes":page_bytes,"shared":memory.shared,"memory64":memory.memory64}));
                }
            }
            Payload::ExportSection(section) => {
                for export in section {
                    let export = export?;
                    exports.push(json!({"name":export.name,"kind":format!("{:?}",export.kind).to_lowercase(),"index":export.index}));
                }
            }
            _ => {}
        }
    }
    let mut failures = vec![];
    if let Err(e) = check_imports(&module.meta) {
        failures.push(finding("UNSUPPORTED_IMPORT", e.to_string()));
    }
    if let Some(entry) = args.flag("invoke") {
        if let Err(e) = parse_entry_args(&module.meta, entry, &args.multi("arg")) {
            failures.push(finding("INVALID_INVOCATION", e.to_string()));
        }
    }
    let local_caps = builtin_capabilities();
    failures.extend(compare(
        &local_caps,
        &imports,
        &features,
        initial_memory_bytes,
        module.wasm.len() as u64,
    ));
    let target = if let Some(node) = args.flag("node") {
        match control::status(node, control::deadline(args, 5_000)) {
            Ok(response) => {
                if !response.ok {
                    failures.push(finding("TARGET_UNAVAILABLE", response.message.clone()));
                }
                match &response.capabilities {
                    Some(caps) => failures.extend(compare(
                        caps,
                        &imports,
                        &features,
                        initial_memory_bytes,
                        module.wasm.len() as u64,
                    )),
                    None => failures.push(finding(
                        "CAPABILITIES_UNKNOWN",
                        "target did not return capabilities",
                    )),
                }
                json!({"node":node,"status":response})
            }
            Err(e) => {
                failures.push(finding("CONTROL_UNAVAILABLE", format!("{e:#}")));
                json!({"node":node,"status":null})
            }
        }
    } else {
        Value::Null
    };
    let ok = failures.is_empty();
    let report = json!({
        "schema_version":1,"ok":ok,"code":if ok {"PREFLIGHT_OK"} else {"PREFLIGHT_BLOCKED"},
        "message":if ok {"static checks passed; no guest code executed"} else {"static checks found blockers; no guest code executed"},
        "profile":"weave_cli_builtins","path":path,"pre_woven":args.has("pre-woven"),
        "module_sha256":module.module_hash.iter().map(|b|format!("{b:02x}")).collect::<String>(),
        "module_bytes":module.wasm.len(),"metadata_version":module.meta.version,"poll_period":module.meta.poll_period,
        "entries":module.meta.entries.iter().map(|e| json!({"name":e.name,"params":types(&e.params),"results":types(&e.results)})).collect::<Vec<_>>(),
        "imports":imports,"exports":exports,"required_features":features,
        "resources":{"initial_memory_bytes":initial_memory_bytes,"memories":memories,"services":["env.emit","env.emit32","env.emit64"],"growth":"not bounded by preflight; later growth and snapshots may exceed target limits"},
        "target":target,"findings":failures,"retry":"never",
        "limitations":["No guest code or constructors were executed; runtime behavior and termination are not proven.","Target capabilities are unauthenticated advertisements, not a reservation or execution guarantee.","This profile checks the central CLI built-ins; custom library hosts must validate their own import and service contracts.","Initial memory checks do not reserve memory or bound future guest growth."]
    });
    if args.has("json") {
        println!("{report}");
    } else {
        println!(
            "{}: {}",
            report["code"].as_str().unwrap(),
            report["message"].as_str().unwrap()
        );
        println!("module: {path}\nsha256: {}\ntransformed bytes: {}\ninitial memory: {initial_memory_bytes} bytes", report["module_sha256"].as_str().unwrap(), module.wasm.len());
        for entry in &module.meta.entries {
            println!(
                "entry: {}({}) -> ({})",
                entry.name,
                types(&entry.params).join(", "),
                types(&entry.results).join(", ")
            );
        }
        for import in &imports {
            println!(
                "import: {}.{}({}) -> ({})",
                import.module,
                import.name,
                import.params.join(", "),
                import.results.join(", ")
            );
        }
        println!("features: {}", features.join(", "));
        for failure in report["findings"].as_array().unwrap() {
            println!(
                "{}: {}",
                failure["code"].as_str().unwrap(),
                failure["message"].as_str().unwrap()
            );
        }
        println!("Scope: CLI built-ins; static compatibility only, no guest execution or memory reservation.");
    }
    if ok {
        Ok(())
    } else {
        Err(Reported(3).into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_signatures_and_unknown_capabilities_fail_closed() {
        let mut caps = builtin_capabilities();
        let mut imports = builtin_imports();
        imports[0].params = vec!["i64".into()];
        assert!(compare(&caps, &imports, &[], 0, 0)
            .iter()
            .any(|f| f["code"] == "UNSUPPORTED_IMPORT"));
        caps.imports = None;
        caps.services = None;
        caps.limits.memory_bytes = None;
        assert!(
            compare(&caps, &imports, &[], 0, 0)
                .iter()
                .filter(|f| f["code"] == "CAPABILITIES_UNKNOWN")
                .count()
                >= 3
        );
    }
    #[test]
    fn resource_limits_and_features_are_checked() {
        let mut caps = builtin_capabilities();
        caps.limits.memory_bytes = Some(1);
        caps.limits.module_bytes = Some(1);
        let findings = compare(&caps, &[], &["unadvertised".into()], 2, 2);
        assert_eq!(findings.len(), 3);
    }
    #[test]
    fn feature_detection_distinguishes_multimemory_and_simd() {
        let simple = wat::parse_str("(module (memory 1))").unwrap();
        assert!(required_features(&simple).unwrap().is_empty());
        let multi = wat::parse_str("(module (memory 1) (memory 1))").unwrap();
        assert!(required_features(&multi)
            .unwrap()
            .contains(&"multi_memory".into()));
        let simd =
            wat::parse_str("(module (func (result v128) v128.const i32x4 0 0 0 0))").unwrap();
        assert!(required_features(&simd).unwrap().contains(&"simd".into()));
    }
}
