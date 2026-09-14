//! Safety checks for the owned native-source mirror, without invoking CMake.

#[allow(dead_code)]
#[path = "../build_inputs.rs"]
mod build_inputs;

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture {
    base: PathBuf,
    source: PathBuf,
    mirror: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let base = std::env::temp_dir().join(format!(
            "weave-wamr-source-mirror-{}-{nonce}-{} paths with spaces",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        // create_dir (not create_dir_all) ensures cleanup owns a newly created
        // root and can never accidentally adopt an existing directory.
        fs::create_dir(&base).unwrap();
        let fixture = Self {
            source: base.join("external checkout"),
            mirror: base.join("cargo output/wamr-source"),
            base,
        };
        fs::create_dir_all(fixture.mirror.parent().unwrap()).unwrap();
        fixture.write("core/iwasm/include/wasm_export.h", b"header input\n");
        fixture.write("core/interpreter/nested/runtime.c", b"runtime input\n");
        fixture.write("core/version.h.in", b"version template\n");
        fixture.write("build-scripts/version.cmake", b"version configuration\n");
        fixture.write(".git/HEAD", b"fixture metadata is not a native input\n");
        fixture.write("samples/not-needed.txt", b"not part of the native mirror\n");
        fixture
    }

    fn write(&self, relative: &str, contents: &[u8]) {
        let file = self.source.join(relative);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, contents).unwrap();
    }

    fn prepare(&self) {
        build_inputs::prepare_source(&self.source, &self.mirror);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // base was created exclusively by this fixture. remove_dir_all does
        // not follow symlinks planted by the rejection tests.
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Directory(SystemTime),
    File(SystemTime, Vec<u8>),
    Symlink(SystemTime, PathBuf),
}

fn snapshot(root: &Path) -> BTreeMap<PathBuf, Entry> {
    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        let metadata = fs::symlink_metadata(path).unwrap();
        let modified = metadata.modified().unwrap();
        let relative = path.strip_prefix(root).unwrap().to_path_buf();
        if metadata.is_symlink() {
            entries.insert(
                relative,
                Entry::Symlink(modified, fs::read_link(path).unwrap()),
            );
        } else if metadata.is_dir() {
            entries.insert(relative, Entry::Directory(modified));
            for child in fs::read_dir(path).unwrap() {
                visit(root, &child.unwrap().path(), entries);
            }
        } else {
            entries.insert(relative, Entry::File(modified, fs::read(path).unwrap()));
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

fn assert_rejected(source: &Path, output: &Path, expected_message: &str) {
    let panic = std::panic::catch_unwind(|| build_inputs::prepare_source(source, output))
        .expect_err("unsafe source mirror was accepted");
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .expect("panic did not contain a diagnostic");
    assert!(
        message.contains(expected_message),
        "unexpected mirror rejection: {message}"
    );
}

#[test]
fn copies_only_native_inputs_without_modifying_external_source() {
    let fixture = Fixture::new();
    let before = snapshot(&fixture.source);
    fixture.prepare();
    assert_eq!(snapshot(&fixture.source), before);
    for relative in [
        "core/iwasm/include/wasm_export.h",
        "core/interpreter/nested/runtime.c",
        "core/version.h.in",
        "build-scripts/version.cmake",
    ] {
        assert_eq!(
            fs::read(fixture.mirror.join(relative)).unwrap(),
            fs::read(fixture.source.join(relative)).unwrap()
        );
    }
    assert!(!fixture.mirror.join(".git").exists());
    assert!(!fixture.mirror.join("samples").exists());

    // Simulate CMake's generated header and a writable copied source. Neither
    // operation may write through a symlink or hard link into the checkout.
    fs::write(fixture.mirror.join("core/version.h"), b"generated header\n").unwrap();
    fs::write(
        fixture.mirror.join("core/iwasm/include/wasm_export.h"),
        b"build-local edit\n",
    )
    .unwrap();
    assert_eq!(snapshot(&fixture.source), before);
}

#[test]
fn refresh_removes_stale_deleted_and_generated_files() {
    let fixture = Fixture::new();
    fixture.prepare();
    fs::write(fixture.mirror.join("core/generated.h"), b"stale output\n").unwrap();
    fs::remove_dir_all(fixture.source.join("core/interpreter")).unwrap();
    fixture.write("core/newly-added.h", b"new source input\n");
    fixture.write("build-scripts/version.cmake", b"updated configuration\n");
    let before = snapshot(&fixture.source);

    fixture.prepare();

    assert_eq!(snapshot(&fixture.source), before);
    assert!(!fixture.mirror.join("core/interpreter").exists());
    assert!(!fixture.mirror.join("core/generated.h").exists());
    assert_eq!(
        fs::read(fixture.mirror.join("core/newly-added.h")).unwrap(),
        b"new source input\n"
    );
    assert_eq!(
        fs::read(fixture.mirror.join("build-scripts/version.cmake")).unwrap(),
        b"updated configuration\n"
    );
}

#[test]
fn rejects_nested_cargo_output_before_removing_existing_files() {
    let fixture = Fixture::new();
    let nested = fixture.source.join("core/cargo output/wamr-source");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("must-survive.txt"), b"existing output\n").unwrap();
    let before = snapshot(&fixture.source);
    assert_rejected(&fixture.source, &nested, "outside and disjoint");
    assert_eq!(snapshot(&fixture.source), before);
}

#[test]
fn rejects_not_yet_created_nested_mirror() {
    let fixture = Fixture::new();
    let nested = fixture.source.join("core/not-yet-created");
    let before = snapshot(&fixture.source);
    assert_rejected(&fixture.source, &nested, "outside and disjoint");
    assert_eq!(snapshot(&fixture.source), before);
    assert!(!nested.exists());
}

#[test]
fn rejects_mirror_equal_to_source_before_any_deletion() {
    let fixture = Fixture::new();
    let before = snapshot(&fixture.source);
    assert_rejected(&fixture.source, &fixture.source, "outside and disjoint");
    assert_eq!(snapshot(&fixture.source), before);
}

#[test]
fn rejects_mirror_ancestor_of_source_before_any_deletion() {
    let fixture = Fixture::new();
    fs::write(fixture.base.join("must-survive.txt"), b"owned sibling\n").unwrap();
    let before = snapshot(&fixture.base);
    assert_rejected(&fixture.source, &fixture.base, "outside and disjoint");
    assert_eq!(snapshot(&fixture.base), before);
}

#[cfg(unix)]
#[test]
fn rejects_nested_output_hidden_by_symlink() {
    let fixture = Fixture::new();
    let alias = fixture.base.join("source alias");
    std::os::unix::fs::symlink(&fixture.source, &alias).unwrap();
    let before = snapshot(&fixture.source);
    assert_rejected(
        &fixture.source,
        &alias.join("mirror"),
        "outside and disjoint",
    );
    assert_eq!(snapshot(&fixture.source), before);
}

#[cfg(unix)]
#[test]
fn rejects_nested_output_even_when_existing_mirror_links_outside_source() {
    let fixture = Fixture::new();
    // Keep this bounded even against a broken implementation: this output is
    // below the source root, but outside either recursively copied input tree.
    let nested = fixture.source.join("cargo output/wamr-source");
    fs::create_dir_all(nested.parent().unwrap()).unwrap();
    let external = fixture.base.join("old mirror target");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("must-survive.txt"), b"outside data\n").unwrap();
    std::os::unix::fs::symlink(&external, &nested).unwrap();
    let source_before = snapshot(&fixture.source);
    let target_before = snapshot(&external);
    assert_rejected(&fixture.source, &nested, "outside and disjoint");
    assert_eq!(snapshot(&fixture.source), source_before);
    assert_eq!(snapshot(&external), target_before);
}

#[cfg(unix)]
#[test]
fn permits_source_root_symlink_without_writing_through_it() {
    let fixture = Fixture::new();
    let alias = fixture.base.join("source alias");
    std::os::unix::fs::symlink(&fixture.source, &alias).unwrap();
    let before = snapshot(&fixture.source);
    build_inputs::prepare_source(&alias, &fixture.mirror);
    assert!(fixture
        .mirror
        .join("core/iwasm/include/wasm_export.h")
        .is_file());
    fs::write(fixture.mirror.join("core/version.h"), b"generated\n").unwrap();
    assert_eq!(snapshot(&fixture.source), before);
    assert!(alias.is_symlink());
}

#[cfg(unix)]
#[test]
fn rejects_top_level_source_directory_symlink() {
    let fixture = Fixture::new();
    let moved = fixture.base.join("real core");
    fs::rename(fixture.source.join("core"), &moved).unwrap();
    std::os::unix::fs::symlink(&moved, fixture.source.join("core")).unwrap();
    let source_before = snapshot(&fixture.source);
    let target_before = snapshot(&moved);
    assert_rejected(&fixture.source, &fixture.mirror, "is a symlink");
    assert_eq!(snapshot(&fixture.source), source_before);
    assert_eq!(snapshot(&moved), target_before);
}

#[cfg(unix)]
#[test]
fn rejects_nested_source_symlinks_without_touching_targets() {
    for directory in [false, true] {
        let fixture = Fixture::new();
        let target = fixture.base.join("outside target");
        if directory {
            fs::create_dir(&target).unwrap();
            fs::write(target.join("sentinel.h"), b"outside directory\n").unwrap();
        } else {
            fs::write(&target, b"outside file\n").unwrap();
        }
        std::os::unix::fs::symlink(&target, fixture.source.join("core/escaping-link")).unwrap();
        let source_before = snapshot(&fixture.source);
        let target_before = snapshot(&target);
        assert_rejected(&fixture.source, &fixture.mirror, "not a regular file");
        assert_eq!(snapshot(&fixture.source), source_before);
        assert_eq!(snapshot(&target), target_before);
    }
}
