//! Warm-cache tests of the real Cargo build script and dependency watcher.
//!
//! The fixture replaces only the WAMR-specific compatibility transformation
//! and CMake project with a tiny native library. Real Cargo, Git, CMake, and the
//! host C compiler still run; an FFI executable proves native inputs actually
//! changed. These tests qualify build orchestration, not WAMR runtime behavior,
//! which is exercised by the separate native/conformance lanes.

use std::cell::Cell;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

static NEXT: AtomicUsize = AtomicUsize::new(0);
const PINNED: &str = include_str!("../WAMR_VERSION");
const HEADER: &str = "#define HEADER_MARKER 10\n";
const SOURCE: &str = "#include \"wasm_export.h\"\nint weave_fixture_marker(void) { return 1 + HEADER_MARKER + CMAKE_MARKER; }\n";
const EXTERNAL_CMAKE: &str = "set(FIXTURE_CMAKE_MARKER 100)\n";
const CMAKE: &str = r#"cmake_minimum_required(VERSION 3.14)
project(weave_build_tracking C)
include("${WAMR_ROOT_DIR}/build-scripts/fixture.cmake")
# Upstream WAMR generates a header under its source root while configuring.
# The real build script must give CMake a staging tree, not the verified input.
configure_file("${WAMR_ROOT_DIR}/core/config-template.h.in" "${WAMR_ROOT_DIR}/core/generated.h" @ONLY)
add_library(weave_wamr_vmlib STATIC "${WAMR_ROOT_DIR}/core/native/marker.c")
target_include_directories(weave_wamr_vmlib PRIVATE "${WAMR_ROOT_DIR}/core/iwasm/include")
target_compile_definitions(weave_wamr_vmlib PRIVATE CMAKE_MARKER=${FIXTURE_CMAKE_MARKER})
install(TARGETS weave_wamr_vmlib ARCHIVE DESTINATION lib)
"#;
const COMPAT: &str = r#"use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
pub fn prepare(_root: &Path, out: &Path) {
    fs::create_dir_all(out).unwrap();
    let mut counter = OpenOptions::new().create(true).append(true)
        .open(out.parent().unwrap().join("build-script-runs.log")).unwrap();
    writeln!(counter, "prepare").unwrap();
}
"#;

struct Fixture {
    base: PathBuf,
    source: PathBuf,
    consumer: PathBuf,
    target: PathBuf,
    sequence: Cell<usize>,
}

impl Fixture {
    fn new(linked: bool) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "weave-wamr-build-tracking-{}-{nonce}-{} paths with spaces",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let repository = base.join("git repository");
        let mut fixture = Self {
            source: repository.clone(),
            consumer: base.join("cargo consumer"),
            target: base.join("cargo target"),
            base,
            sequence: Cell::new(0),
        };
        fs::create_dir_all(&fixture.consumer).unwrap();
        fs::create_dir(&repository).unwrap();
        fs::write(fixture.base.join("empty git config"), "").unwrap();
        fixture.write_source("core/iwasm/include/wasm_export.h", HEADER);
        fixture.write_source("core/native/marker.c", SOURCE);
        fixture.write_source("build-scripts/fixture.cmake", EXTERNAL_CMAKE);
        fixture.write_source("core/config-template.h.in", "#define GENERATED_VALUE 0\n");
        fixture.write_source(
            "core/native/deep/tracked.txt",
            "keeps a deep directory present\n",
        );
        fixture.git(&["init", "--quiet", "--template="]);
        fixture.git(&["add", "."]);
        fixture.git(&["commit", "--quiet", "-m", "fixture inputs"]);
        // An identical-tree untagged parent allows HEAD-only invalidation tests.
        fixture.git(&["commit", "--quiet", "--allow-empty", "-m", "pinned fixture"]);
        fixture.git(&["tag", PINNED.trim()]);
        if linked {
            let worktree = fixture.base.join("linked source checkout");
            fixture.git(&[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                worktree.to_str().unwrap(),
                "HEAD",
            ]);
            fixture.source = worktree;
            assert!(fixture.source.join(".git").is_file());
        } else {
            assert!(fixture.source.join(".git").is_dir());
        }

        let real_manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        for name in ["build.rs", "build_inputs.rs", "WAMR_VERSION"] {
            fs::copy(real_manifest.join(name), fixture.consumer.join(name)).unwrap();
        }
        fs::write(fixture.consumer.join("compat.rs"), COMPAT).unwrap();
        fs::write(fixture.consumer.join("CMakeLists.txt"), CMAKE).unwrap();
        fs::write(fixture.consumer.join("Cargo.toml"),
            "[package]\nname = \"weave-build-tracking-probe\"\nversion = \"0.0.0\"\nedition = \"2021\"\nbuild = \"build.rs\"\n\n[workspace]\n").unwrap();
        fs::create_dir(fixture.consumer.join("src")).unwrap();
        fs::write(fixture.consumer.join("src/main.rs"),
            "extern \"C\" { fn weave_fixture_marker() -> i32; }\nfn main() { println!(\"{}\", unsafe { weave_fixture_marker() }); }\n").unwrap();
        eprintln!("build-tracking fixture: {}", fixture.base.display());
        fixture
    }

    fn command(&self, program: impl AsRef<OsStr>) -> Command {
        let mut command = Command::new(program);
        // No external Git config, signing hook, or inherited repository pointer
        // may influence this disposable local repository or Cargo's Git queries.
        for (name, _) in std::env::vars_os() {
            if name.to_string_lossy().starts_with("GIT_") {
                command.env_remove(name);
            }
        }
        command
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", self.base.join("empty git config"))
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env_remove("RUSTC_WRAPPER")
            .env_remove("RUSTC_WORKSPACE_WRAPPER")
            .env_remove("RUSTFLAGS")
            .env_remove("CARGO_ENCODED_RUSTFLAGS")
            .env_remove("CARGO_BUILD_TARGET");
        command
    }

    fn run(&self, command: &mut Command, label: &str) -> Output {
        let sequence = self.sequence.get();
        self.sequence.set(sequence + 1);
        let stem = self.base.join(format!("{sequence:03}-{label}"));
        fs::write(stem.with_extension("command"), format!("{command:?}\n")).unwrap();
        let stdout = stem.with_extension("stdout");
        let stderr = stem.with_extension("stderr");
        let mut child = command
            .stdout(Stdio::from(fs::File::create(&stdout).unwrap()))
            .stderr(Stdio::from(fs::File::create(&stderr).unwrap()))
            .spawn()
            .unwrap_or_else(|error| panic!("cannot start {label}: {error}"));
        let started = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if started.elapsed() > Duration::from_secs(90) {
                let _ = child.kill();
                let _ = child.wait();
                panic!(
                    "{label} exceeded 90 seconds; artifacts: {}",
                    self.base.display()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        Output {
            status,
            stdout: fs::read(stdout).unwrap(),
            stderr: fs::read(stderr).unwrap(),
        }
    }

    fn git(&self, args: &[&str]) -> String {
        let output = self.run(
            self.command("git")
                .arg("-C")
                .arg(&self.source)
                .args([
                    "-c",
                    "user.name=Weave build test",
                    "-c",
                    "user.email=weave-build@example.invalid",
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "tag.gpgsign=false",
                ])
                .args(args),
            "git",
        );
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    fn write_source(&self, relative: &str, value: &str) {
        let path = self.source.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, value).unwrap();
    }

    fn build(&self, allow_untested: bool) -> Output {
        let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
        let mut command = self.command(cargo);
        command
            .current_dir(&self.consumer)
            .args(["build", "--offline", "--quiet"])
            .env("CARGO_TARGET_DIR", &self.target)
            .env("CARGO_INCREMENTAL", "0")
            .env("WAMR_ROOT", &self.source)
            .env_remove("WEAVE_WAMR_ALLOW_UNTESTED");
        if allow_untested {
            command.env("WEAVE_WAMR_ALLOW_UNTESTED", "1");
        }
        self.run(&mut command, "cargo-build")
    }

    fn succeeds(&self, allow_untested: bool, expected: i32) {
        let core_modified = fs::metadata(self.source.join("core"))
            .unwrap()
            .modified()
            .unwrap();
        assert!(!self.source.join("core/generated.h").exists());
        let result = self.build(allow_untested);
        assert!(
            result.status.success(),
            "Cargo failed:\n{}",
            String::from_utf8_lossy(&result.stderr)
        );
        assert!(
            !self.source.join("core/generated.h").exists(),
            "CMake generated a header in the verified source tree"
        );
        assert_eq!(
            fs::metadata(self.source.join("core"))
                .unwrap()
                .modified()
                .unwrap(),
            core_modified,
            "CMake changed the verified source directory timestamp"
        );
        let binary = self.target.join("debug").join(format!(
            "weave-build-tracking-probe{}",
            std::env::consts::EXE_SUFFIX
        ));
        let result = self.run(&mut self.command(binary), "native-marker");
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap().trim(),
            expected.to_string(),
            "the executable must link freshly rebuilt native bytes"
        );
    }

    fn rejects(&self, diagnostic: &str) {
        let result = self.build(false);
        assert!(
            !result.status.success(),
            "warm Cargo build silently accepted changed WAMR inputs"
        );
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(diagnostic),
            "expected {diagnostic:?}: {}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    fn build_runs(&self) -> usize {
        fn count(root: &Path) -> usize {
            if !root.is_dir() {
                return 0;
            }
            fs::read_dir(root)
                .unwrap()
                .map(|entry| {
                    let path = entry.unwrap().path();
                    if path.is_dir() {
                        count(&path)
                    } else if path.file_name() == Some(OsStr::new("build-script-runs.log")) {
                        fs::read_to_string(path).unwrap().lines().count()
                    } else {
                        0
                    }
                })
                .sum()
        }
        count(&self.target)
    }

    fn unchanged(&self, allow_untested: bool, expected: i32) {
        let before = self.build_runs();
        assert!(before > 0);
        self.succeeds(allow_untested, expected);
        self.succeeds(allow_untested, expected);
        assert_eq!(
            self.build_runs(),
            before,
            "unchanged Cargo invocations reran the native build script"
        );
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if std::thread::panicking()
            || std::env::var_os("WEAVE_CI_KEEP_TEMP").as_deref() == Some(OsStr::new("1"))
        {
            eprintln!("retained build-tracking artifacts: {}", self.base.display());
        } else {
            fs::remove_dir_all(&self.base).unwrap();
        }
    }
}

fn source_tracking(linked: bool) {
    let f = Fixture::new(linked);
    f.succeeds(false, 111);
    f.unchanged(false, 111);
    for (path, original, edited, expected) in [
        (
            "core/native/marker.c",
            SOURCE,
            SOURCE.replace("return 1 +", "return 2 +"),
            112,
        ),
        (
            "core/iwasm/include/wasm_export.h",
            HEADER,
            HEADER.replace("10", "20"),
            121,
        ),
        (
            "build-scripts/fixture.cmake",
            EXTERNAL_CMAKE,
            EXTERNAL_CMAKE.replace("100", "200"),
            211,
        ),
    ] {
        f.write_source(path, &edited);
        f.rejects("WAMR_ROOT is dirty");
        f.succeeds(true, expected);
        f.unchanged(true, expected);
        f.rejects("WAMR_ROOT is dirty"); // Removing the override must revalidate.
        f.write_source(path, original);
        f.succeeds(false, 111);
    }
    for addition in [
        "untracked.txt",
        "core/native/deep/new directory/another level/untracked.c",
    ] {
        f.write_source(addition, "an untracked input\n");
        f.rejects("WAMR_ROOT is dirty");
        fs::remove_file(f.source.join(addition)).unwrap();
        f.succeeds(false, 111);
    }
    fs::remove_file(f.source.join("core/native/marker.c")).unwrap();
    f.rejects("WAMR_ROOT is dirty");
    f.write_source("core/native/marker.c", SOURCE);
    f.succeeds(false, 111);
    fs::remove_file(f.source.join("core/iwasm/include/wasm_export.h")).unwrap();
    f.rejects("does not contain core/iwasm/include/wasm_export.h");
    f.write_source("core/iwasm/include/wasm_export.h", HEADER);
    f.succeeds(false, 111);
    f.unchanged(false, 111);
}

fn metadata_tracking(linked: bool) {
    let f = Fixture::new(linked);
    metadata_checks(&f);
}

fn metadata_checks(f: &Fixture) {
    f.succeeds(false, 111);
    let pinned_commit = f.git(&["rev-parse", "HEAD"]);
    let parent = f.git(&["rev-parse", "HEAD^"]);
    f.git(&["checkout", "--quiet", "--detach", &parent]);
    f.rejects("could not verify WAMR_ROOT git tag");
    f.git(&["checkout", "--quiet", "--detach", &pinned_commit]);
    f.succeeds(false, 111);

    // Exercise shared common-dir metadata too: pack/delete/recreate the tag
    // without changing a single native source file or the WAMR_ROOT string.
    f.git(&["pack-refs", "--all", "--prune"]);
    f.succeeds(false, 111);
    f.unchanged(false, 111);
    f.git(&["tag", "-d", PINNED.trim()]);
    f.rejects("could not verify WAMR_ROOT git tag");
    f.git(&["tag", PINNED.trim()]);
    f.succeeds(false, 111);
    f.unchanged(false, 111);
}

#[test]
fn ordinary_checkout_native_inputs_invalidate_warm_cargo() {
    source_tracking(false);
}

#[test]
fn linked_worktree_native_inputs_invalidate_warm_cargo() {
    source_tracking(true);
}

#[test]
fn ordinary_checkout_git_metadata_invalidates_warm_cargo() {
    metadata_tracking(false);
}

#[test]
fn linked_worktree_git_metadata_invalidates_warm_cargo() {
    metadata_tracking(true);
}

#[test]
fn relative_separate_git_directory_invalidates_warm_cargo() {
    let f = Fixture::new(false);
    let metadata = f.base.join("separate git metadata");
    f.git(&[
        "init",
        "--quiet",
        "--separate-git-dir",
        metadata.to_str().unwrap(),
    ]);
    fs::write(f.source.join(".git"), "gitdir: ../separate git metadata\n").unwrap();
    assert!(f.source.join(".git").is_file());
    metadata_checks(&f);
}

#[test]
fn restored_external_git_metadata_revalidates_an_override_build() {
    let f = Fixture::new(false);
    let metadata = f.base.join("separate git metadata");
    f.git(&[
        "init",
        "--quiet",
        "--separate-git-dir",
        metadata.to_str().unwrap(),
    ]);
    fs::write(f.source.join(".git"), "gitdir: ../separate git metadata\n").unwrap();
    f.succeeds(false, 111);
    let saved = f.base.join("temporarily unavailable metadata");
    fs::rename(&metadata, &saved).unwrap();
    f.rejects("could not verify WAMR_ROOT git tag");
    f.succeeds(true, 111);
    let before = f.build_runs();
    fs::rename(&saved, &metadata).unwrap();
    f.succeeds(true, 111);
    assert!(
        f.build_runs() > before,
        "restoring the same external metadata path must rerun validation"
    );
    f.succeeds(false, 111);
    f.unchanged(false, 111);
}

#[cfg(unix)]
#[test]
fn retargeted_source_symlink_uses_a_preexisting_second_checkout() {
    use std::os::unix::fs::symlink;
    let mut f = Fixture::new(false);
    let first = f.source.clone();
    let second = f.base.join("second source checkout");
    let result = f.run(
        f.command("git")
            .args(["clone", "--quiet", "--no-hardlinks"])
            .arg(&first)
            .arg(&second),
        "git-clone",
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    f.source = second.clone();
    f.write_source(
        "core/native/marker.c",
        &SOURCE.replace("return 1 +", "return 3 +"),
    );
    f.git(&["add", "."]);
    f.git(&["commit", "--quiet", "-m", "second native marker"]);
    f.git(&["tag", "-f", PINNED.trim()]);
    // Finish creating BOTH trees before the initial Cargo build. Retargeting
    // must invalidate via the symlink, not incidentally new source timestamps.
    let alias = f.base.join("source alias");
    symlink(&first, &alias).unwrap();
    f.source = alias.clone();
    f.succeeds(false, 111);
    f.unchanged(false, 111);
    fs::remove_file(&alias).unwrap();
    symlink(&second, &alias).unwrap();
    f.succeeds(false, 113);
    f.unchanged(false, 113);
}
