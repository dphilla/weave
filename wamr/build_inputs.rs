//! Cargo must invalidate the native build when the external checkout changes,
//! before version validation, compatibility generation, or CMake can run.
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn prepare_source(root: &Path, out: &Path) {
    // Upstream config_common.cmake generates core/version.h in WAMR_ROOT_DIR.
    // Even an identical configure_file output creates a temporary sibling and
    // changes the source directory mtime. Build from an owned mirror so source
    // watching neither loops nor permits CMake to modify the verified checkout.
    let source = root.canonicalize().expect("resolve WAMR source directory");
    let output_parent = out
        .parent()
        .unwrap()
        .canonicalize()
        .expect("resolve Cargo output directory");
    let output = if out.exists() {
        out.canonicalize().expect("resolve WAMR source mirror")
    } else {
        output_parent.join(out.file_name().unwrap())
    };
    assert!(
        !output.starts_with(&source) && !source.starts_with(&output),
        "Cargo build output must be outside and disjoint from WAMR_ROOT to avoid modifying watched source"
    );
    if out.exists() {
        fs::remove_dir_all(out).expect("remove previous build-local WAMR source mirror");
    }
    // The configured interpreter/SIMD build consumes these two upstream trees.
    // Replacing the mirror on invalidation also removes deleted source files;
    // unchanged Cargo builds do not enter the build script at all.
    for directory in ["core", "build-scripts"] {
        copy_tree(&root.join(directory), &out.join(directory));
    }
}

fn copy_tree(source: &Path, destination: &Path) {
    assert!(
        !source.is_symlink(),
        "WAMR build input {} is a symlink; use regular files in core and build-scripts",
        source.display()
    );
    fs::create_dir_all(destination).expect("create build-local WAMR source directory");
    for entry in fs::read_dir(source).expect("read WAMR build inputs") {
        let entry = entry.expect("read WAMR build input");
        let kind = entry.file_type().expect("inspect WAMR build input");
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            // Do not create links through which CMake could write into the
            // original checkout, or follow recursive/escaping directory links.
            assert!(
                kind.is_file(),
                "WAMR build input {} is not a regular file",
                entry.path().display()
            );
            fs::copy(entry.path(), target).expect("copy WAMR build input");
        }
    }
}

pub fn watch(root: &Path) {
    // Watch the directory, not just today's tracked C files: headers, CMake
    // includes, deletions, and newly untracked files all affect the build or
    // its clean-checkout validation. Build outputs must live outside this tree.
    println!("cargo:rerun-if-changed={}", root.display());

    // A linked worktree (or --separate-git-dir checkout) has a .git *file*.
    // Its HEAD/index and shared tags/config live outside the source directory.
    // Watch whole metadata directories so creating/deleting optional files
    // such as packed-refs also invalidates, without declaring missing files
    // that would make every unchanged Cargo build dirty.
    let mut metadata = Vec::new();
    // Keep known external pointers even if Git cannot open the repository.
    // Under ALLOW_UNTESTED a missing target deliberately stays dirty until
    // repaired; dropping it would miss a later repair outside the source tree.
    if let Ok(pointer) = fs::read_to_string(root.join(".git")) {
        if let Some(path) = pointer
            .trim_end_matches(['\r', '\n'])
            .strip_prefix("gitdir: ")
        {
            let git_dir = root.join(path);
            if let Ok(common) = fs::read_to_string(git_dir.join("commondir")) {
                metadata.push(git_dir.join(common.trim_end_matches(['\r', '\n'])));
            }
            metadata.push(git_dir);
        }
    }
    metadata.extend(
        ["--git-common-dir", "--git-dir"]
            .into_iter()
            .filter_map(|option| git_path(root, option)),
    );
    // Do not use a lexical starts_with(root) containment check here:
    // a relative gitdir can resolve through `..` outside the checkout.
    metadata.sort();
    metadata.dedup();
    for path in metadata {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}

fn git_path(root: &Path, option: &str) -> Option<PathBuf> {
    let output = Command::new("git")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", option])
        .output()
        .ok()?;
    if !output.status.success() {
        // check_version supplies the existing diagnostic/explicit ABI override
        // for unverified trees. The source directory remains watched either way.
        return None;
    }
    let path = String::from_utf8(output.stdout).ok()?;
    let path = path.trim_end_matches(['\r', '\n']);
    if path.is_empty() {
        return None;
    }
    Some(root.join(path))
}
