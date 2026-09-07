//! Exercise the installed-style binary, not internal command functions.
use std::process::{Command, Output};
use std::sync::atomic::{AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Temp(std::path::PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "weave-cli-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str, text: &str) -> String {
        let path = self.0.join(name);
        std::fs::write(&path, text).unwrap();
        path.to_str().unwrap().to_owned()
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn cli(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_weave"))
        .args(args)
        .output()
        .unwrap()
}
fn json(output: &Output) -> serde_json::Value {
    assert!(
        output.stderr.is_empty(),
        "unexpected stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn inspect_does_not_execute_start_or_constructor_or_guest() {
    let tmp = Temp::new();
    let module = tmp.file("trap.wat", "(module (import \"env\" \"emit32\" (func $emit (param i32))) (func $start i32.const 17 call $emit unreachable) (start $start) (func (export \"__wasm_call_ctors\") unreachable) (func (export \"run\") unreachable))");
    let out = cli(&["inspect", &module, "--invoke", "run", "--json"]);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stdout)
    );
    assert_eq!(json(&out)["code"], "PREFLIGHT_OK");
    let run = cli(&["run", &module, "--invoke", "run"]);
    assert!(!run.status.success());
    assert!(String::from_utf8_lossy(&run.stdout).contains("EMIT32 17"));
}
#[test]
fn bad_flags_never_write_outputs_and_bad_numbers_never_panic() {
    let tmp = Temp::new();
    let source = tmp.file("simple.wat", "(module (func (export \"run\")))");
    let out = tmp.0.join("output.wasm");
    let output = out.to_str().unwrap();
    for extra in [
        &["--peroid", "1"][..],
        &["--period", "NaN"],
        &["--stack-pages", "-1"],
        &["--period", "0"],
        &["--period", "4294967296"],
        &["--out", "other"],
    ] {
        let mut args = vec!["transform", &source, "-o", output];
        args.extend(extra);
        let result = cli(&args);
        assert_eq!(result.status.code(), Some(2));
        assert!(!out.exists());
        assert!(!String::from_utf8_lossy(&result.stderr).contains("panicked"));
    }
}
#[test]
fn json_errors_and_every_subcommand_help_are_usable() {
    let result = cli(&["status", "--nide", "localhost:1", "--json"]);
    assert_eq!(result.status.code(), Some(2));
    assert_eq!(json(&result)["code"], "USAGE_ERROR");
    for cmd in [
        "run",
        "checkpoint",
        "restore",
        "serve",
        "transform",
        "inspect",
        "migrate",
        "operation",
        "status",
    ] {
        let help = cli(&[cmd, "--help"]);
        assert!(help.status.success());
        assert!(String::from_utf8_lossy(&help.stdout).starts_with(&format!("weave {cmd}")));
    }
}
#[test]
fn inspect_reports_invalid_invocation_and_exact_import_signature() {
    let tmp = Temp::new();
    let module = tmp.file("wrong-import.wat", "(module (import \"env\" \"emit32\" (func (param i64))) (func (export \"run\") (param i32)))");
    let output = cli(&["inspect", &module, "--invoke", "typo", "--json"]);
    assert_eq!(output.status.code(), Some(3));
    let report = json(&output);
    let findings = report["findings"].as_array().unwrap();
    assert!(findings.iter().any(|f| f["code"] == "UNSUPPORTED_IMPORT"));
    assert!(findings.iter().any(|f| f["code"] == "INVALID_INVOCATION"));
    let output = cli(&["run", &module, "--invoke", "run", "--arg", "1"]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("signature"));
}
#[test]
fn negative_arguments_and_pre_woven_preflight_work() {
    let tmp = Temp::new();
    let module = tmp.file(
        "identity.wat",
        "(module (func (export \"run\") (param i32) (result i32) local.get 0))",
    );
    let out = cli(&["run", &module, "--invoke", "run", "--arg", "-17"]);
    assert!(out.status.success());
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "WEAVE_DONE [-17]"
    );
    let woven = tmp.0.join("woven.wasm");
    assert!(cli(&["transform", &module, "-o", woven.to_str().unwrap()])
        .status
        .success());
    let out = cli(&["inspect", woven.to_str().unwrap(), "--pre-woven", "--json"]);
    assert!(out.status.success());
    assert_eq!(json(&out)["pre_woven"], true);
}

#[test]
fn imported_memory_is_reported_and_not_silently_treated_as_local() {
    let tmp = Temp::new();
    let module = tmp.file(
        "memory.wat",
        "(module (import \"env\" \"memory\" (memory 1)) (func (export \"run\")))",
    );
    let out = cli(&["inspect", &module, "--json"]);
    assert_eq!(out.status.code(), Some(3));
    let report = json(&out);
    assert_eq!(report["code"], "PREFLIGHT_BLOCKED");
    assert_eq!(report["non_function_imports"][0]["name"], "memory");
    assert_eq!(report["resources"]["memories"][0]["imported"], true);
    assert!(
        report["resources"]["initial_memory_bytes"]
            .as_u64()
            .unwrap()
            >= 65536
    );
}

#[test]
fn transform_rejection_preserves_corpus_exit_and_diagnostic_contract() {
    let tmp = Temp::new();
    let module = tmp.file(
        "unsupported.wat",
        "(module (import \"env\" \"g\" (global funcref)) (func (export \"run\")))",
    );
    let target = tmp.0.join("unsupported.wasm");
    let out = cli(&["transform", &module, "-o", target.to_str().unwrap()]);
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).starts_with("weave: error:"));
    assert!(!target.exists());
}
