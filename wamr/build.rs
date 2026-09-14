use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

mod build_inputs;
mod compat;

const PINNED_WAMR: &str = include_str!("WAMR_VERSION");

fn run(command: &mut Command, what: &str) {
    let status = command
        .status()
        .unwrap_or_else(|e| panic!("failed to start {what}: {e}"));
    assert!(status.success(), "{what} failed with {status}");
}

fn main() {
    println!("cargo:rerun-if-env-changed=WAMR_ROOT");
    println!("cargo:rerun-if-env-changed=WEAVE_WAMR_ALLOW_UNTESTED");
    println!("cargo:rerun-if-changed=CMakeLists.txt");
    println!("cargo:rerun-if-changed=WAMR_VERSION");
    println!("cargo:rerun-if-changed=compat.rs");
    println!("cargo:rerun-if-changed=build_inputs.rs");

    let root = PathBuf::from(env::var_os("WAMR_ROOT").unwrap_or_else(|| {
        panic!(
            "WAMR_ROOT is required; point it at wasm-micro-runtime tag {}",
            PINNED_WAMR.trim()
        )
    }));
    // CMake and Cargo must resolve relative roots against the same directory.
    // Do not canonicalize away a source symlink: changing its target is an input.
    let root = env::current_dir().unwrap().join(root);
    build_inputs::watch(&root);
    let header = root.join("core/iwasm/include/wasm_export.h");
    assert!(
        header.is_file(),
        "WAMR_ROOT={} does not contain core/iwasm/include/wasm_export.h",
        root.display()
    );

    check_version(&root);

    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let build = out.join("wamr-build");
    let install = out.join("wamr-install");
    let patched = out.join("weave-wamr-compat");
    let native_source = out.join("wamr-source");
    build_inputs::prepare_source(&root, &native_source);
    compat::prepare(&root, &patched);

    run(
        Command::new("cmake")
            .arg("-S")
            .arg(&manifest)
            .arg("-B")
            .arg(&build)
            .arg(format!("-DWAMR_ROOT_DIR={}", native_source.display()))
            .arg(format!("-DWEAVE_WAMR_COMPAT_DIR={}", patched.display()))
            .arg(format!("-DCMAKE_INSTALL_PREFIX={}", install.display()))
            .arg("-DCMAKE_BUILD_TYPE=Release"),
        "WAMR CMake configure",
    );
    // CMake install can skip a changed same-size archive rebuilt within the
    // same timestamp second. Never leave that stale copy available for linking.
    let archive = install.join("lib/libweave_wamr_vmlib.a");
    match std::fs::remove_file(&archive) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => panic!(
            "remove previous WAMR install {}: {error}",
            archive.display()
        ),
    }
    run(
        Command::new("cmake")
            .arg("--build")
            .arg(&build)
            // Make generators can miss same-second edits even after Cargo
            // detected them. Rebuild native objects on actual invalidation;
            // unchanged Cargo builds never reach this command.
            .arg("--clean-first")
            .arg("--target")
            .arg("install")
            .arg("--config")
            .arg("Release")
            .arg("--parallel"),
        "WAMR static-library build",
    );

    println!(
        "cargo:rustc-link-search=native={}",
        install.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=weave_wamr_vmlib");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=pthread");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-lib=dl");
        println!("cargo:rustc-link-lib=rt");
    }
}

fn check_version(root: &Path) {
    let pinned = PINNED_WAMR.trim();
    let allow_untested =
        env::var_os("WEAVE_WAMR_ALLOW_UNTESTED").as_deref() == Some(std::ffi::OsStr::new("1"));
    let output = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(root)
        .args(["describe", "--tags", "--exact-match"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
            if actual != pinned {
                assert!(
                    allow_untested,
                    "weave-wamr requires {pinned}, but WAMR_ROOT is {actual}; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
                );
                println!("cargo:warning=building against untested WAMR tag {actual}");
            }
        } else {
            assert!(
                allow_untested,
                "could not verify WAMR_ROOT git tag; expected {pinned}; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
            );
            println!("cargo:warning=building against a WAMR tree whose tag could not be verified");
        }
    } else {
        assert!(
            allow_untested,
            "could not execute git to verify WAMR_ROOT; expected {pinned}; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
        );
        println!("cargo:warning=building against an unverified WAMR tree");
    }

    let output = Command::new("git")
        // Validation must not refresh the watched index and invalidate itself.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain", "--untracked-files=normal"])
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let dirty = !output.stdout.is_empty();
            assert!(
                !dirty || allow_untested,
                "WAMR_ROOT is dirty; expected a clean {pinned} checkout; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
            );
            if dirty {
                println!("cargo:warning=building against a dirty WAMR tree");
            }
        } else {
            assert!(
                allow_untested,
                "could not verify that WAMR_ROOT is clean; expected a clean {pinned} checkout; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
            );
            println!("cargo:warning=building against a WAMR tree whose cleanliness could not be verified");
        }
    } else {
        assert!(
            allow_untested,
            "could not execute git to verify that WAMR_ROOT is clean; expected a clean {pinned} checkout; set WEAVE_WAMR_ALLOW_UNTESTED=1 to accept ABI risk explicitly"
        );
        println!(
            "cargo:warning=building against a WAMR tree whose cleanliness could not be verified"
        );
    }
}
