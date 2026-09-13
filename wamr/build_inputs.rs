//! Cargo must invalidate the native build when the external checkout changes,
//! before version validation, compatibility generation, or CMake can run.
use std::path::{Path, PathBuf};
use std::process::Command;

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
    let mut watched = vec![root.to_path_buf()];
    for option in ["--git-common-dir", "--git-dir"] {
        if let Some(path) = git_path(root, option) {
            if !watched.iter().any(|parent| path.starts_with(parent)) {
                println!("cargo:rerun-if-changed={}", path.display());
                watched.push(path);
            }
        }
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
