//! Exercise hostile snapshots in a subprocess whose allocator exits before
//! making a large allocation. This also fails safely against the old decoder:
//! its infallible attacker-sized reserve never reaches the system allocator.

use std::alloc::{GlobalAlloc, Layout, System};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use weave_core::{Snapshot, WASM_PAGE_SIZE, WEAVE_VERSION};

const CASE_ENV: &str = "WEAVE_SNAPSHOT_ALLOCATION_TEST_CASE";
const ALLOCATION_REJECTED: i32 = 91;
const MAX_DECODE_ALLOCATION: usize = 1024 * 1024;
static GUARD_ENABLED: AtomicBool = AtomicBool::new(false);
static FAIL_ALLOCATION_SIZE: AtomicUsize = AtomicUsize::new(0);

struct GuardedAllocator;

fn reject_allocation(size: usize) -> bool {
    if !GUARD_ENABLED.load(Ordering::Relaxed) {
        return false;
    }
    if size > MAX_DECODE_ALLOCATION {
        // Do not print or panic inside an allocator: either could allocate.
        // The parent reports this dedicated exit code with the fixture name.
        std::process::exit(ALLOCATION_REJECTED);
    }
    // Fail just the selected data allocation, leaving the small allocations
    // needed to construct and report an ordinary error available.
    size != 0 && size == FAIL_ALLOCATION_SIZE.load(Ordering::Relaxed)
}

unsafe impl GlobalAlloc for GuardedAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if reject_allocation(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: forward the caller's allocation contract unchanged.
        unsafe { System.alloc(layout) }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if reject_allocation(layout.size()) {
            return std::ptr::null_mut();
        }
        // SAFETY: forward the caller's allocation contract unchanged.
        unsafe { System.alloc_zeroed(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: all accepted allocations come from System with this layout.
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if reject_allocation(size) {
            return std::ptr::null_mut();
        }
        // SAFETY: forward the caller's allocation contract unchanged.
        unsafe { System.realloc(ptr, layout, size) }
    }
}

#[global_allocator]
static ALLOCATOR: GuardedAllocator = GuardedAllocator;

fn put_u32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_le_bytes());
}

fn header() -> Vec<u8> {
    let mut bytes = b"WVSN".to_vec();
    bytes.extend_from_slice(&WEAVE_VERSION.to_le_bytes());
    bytes.extend_from_slice(&[0; 32]);
    bytes
}

fn count_bomb(collection: usize, full_tail: bool) -> Vec<u8> {
    let mut bytes = header();
    for index in 0..=collection {
        put_u32(&mut bytes, if index == collection { u32::MAX } else { 0 });
    }
    if full_tail {
        for _ in collection + 1..3 {
            put_u32(&mut bytes, 0);
        }
        bytes.extend_from_slice(&[0; 32]);
    }
    bytes
}

fn malformed_length(case: &str) -> Vec<u8> {
    let mut bytes = header();
    if case.starts_with("memory-") {
        put_u32(&mut bytes, 1);
        let length = match case {
            "memory-overflow" => u64::MAX,
            "memory-host-width" => u64::from(u32::MAX) + 1,
            "memory-truncated" => WASM_PAGE_SIZE as u64,
            _ => panic!("unknown fixture {case}"),
        };
        bytes.extend_from_slice(&length.to_le_bytes());
        put_u32(&mut bytes, 0);
        put_u32(&mut bytes, 0);
    } else if case.starts_with("global-") {
        put_u32(&mut bytes, 0);
        put_u32(&mut bytes, 1);
        let length = match case {
            "global-name-overflow" => u32::MAX,
            "global-name-truncated" => 4096,
            "global-name-invalid-utf8" => 1,
            _ => panic!("unknown fixture {case}"),
        };
        put_u32(&mut bytes, length);
        if case == "global-name-invalid-utf8" {
            bytes.push(0xff);
        }
        put_u32(&mut bytes, 0);
        put_u32(&mut bytes, 0);
    } else {
        put_u32(&mut bytes, 0);
        put_u32(&mut bytes, 0);
        put_u32(&mut bytes, 1);
        match case {
            "service-name-overflow" | "service-name-truncated" => {
                put_u32(
                    &mut bytes,
                    if case.ends_with("overflow") {
                        u32::MAX
                    } else {
                        4096
                    },
                );
                put_u32(&mut bytes, 0);
            }
            "service-blob-overflow" | "service-blob-truncated" => {
                put_u32(&mut bytes, 3);
                bytes.extend_from_slice(b"svc");
                put_u32(
                    &mut bytes,
                    if case.ends_with("overflow") {
                        u32::MAX
                    } else {
                        WASM_PAGE_SIZE as u32
                    },
                );
            }
            _ => panic!("unknown fixture {case}"),
        }
    }
    // Include mandatory trailers so length checks cannot be bypassed merely
    // because the decoder rejected a missing checksum or later count first.
    bytes.extend_from_slice(&[0; 32]);
    bytes
}

fn run_child(case: &str) {
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "allocation_guard_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(CASE_ENV, case)
        .output()
        .expect("launch allocation-guard subprocess");
    assert!(
        output.status.success(),
        "snapshot case {case} failed (exit {:?}; {ALLOCATION_REJECTED} means an allocation over {MAX_DECODE_ALLOCATION} bytes was prevented)\nstdout: {}\nstderr: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
}

#[test]
fn tiny_collection_counts_never_request_huge_allocations() {
    for case in [
        "memory-count-tiny",
        "memory-count-tail",
        "global-count-tiny",
        "global-count-tail",
        "service-count-tiny",
        "service-count-tail",
    ] {
        run_child(case);
    }
}

#[test]
fn malformed_lengths_never_request_huge_allocations() {
    for case in [
        "memory-overflow",
        "memory-host-width",
        "memory-truncated",
        "global-name-overflow",
        "global-name-truncated",
        "global-name-invalid-utf8",
        "service-name-overflow",
        "service-name-truncated",
        "service-blob-overflow",
        "service-blob-truncated",
    ] {
        run_child(case);
    }
}

#[test]
fn ordinary_snapshots_still_decode_under_the_guard() {
    run_child("valid-empty");
    run_child("valid-stateful");
}

#[test]
fn allocation_failure_returns_an_error_instead_of_aborting() {
    run_child("allocation-failure");
}

#[test]
#[ignore = "invoked only by the allocation-guard parent tests"]
fn allocation_guard_child() {
    let Ok(case) = std::env::var(CASE_ENV) else {
        return;
    };
    let expected = match case.as_str() {
        "valid-empty" => Some(Snapshot {
            module_hash: [7; 32],
            memories: vec![],
            globals: vec![],
            services: vec![],
        }),
        "valid-stateful" | "allocation-failure" => Some(Snapshot {
            module_hash: [9; 32],
            memories: vec![vec![0; WASM_PAGE_SIZE], vec![3; 2 * WASM_PAGE_SIZE]],
            globals: vec![("__weave_state".into(), 1), ("g_π".into(), -1)],
            services: vec![("application.ledger.v1".into(), vec![1, 2, 3, 4])],
        }),
        _ => None,
    };
    let bytes = if let Some(snapshot) = &expected {
        snapshot.encode()
    } else {
        match case.as_str() {
            "memory-count-tiny" => count_bomb(0, false),
            "memory-count-tail" => count_bomb(0, true),
            "global-count-tiny" => count_bomb(1, false),
            "global-count-tail" => count_bomb(1, true),
            "service-count-tiny" => count_bomb(2, false),
            "service-count-tail" => count_bomb(2, true),
            other => malformed_length(other),
        }
    };

    // Fixture setup and test-framework allocations are deliberately outside
    // the guard. Only this one isolated decode is restricted.
    if case == "allocation-failure" {
        FAIL_ALLOCATION_SIZE.store(2 * WASM_PAGE_SIZE, Ordering::Relaxed);
    }
    GUARD_ENABLED.store(true, Ordering::Relaxed);
    let decoded = Snapshot::decode(&bytes);
    GUARD_ENABLED.store(false, Ordering::Relaxed);
    FAIL_ALLOCATION_SIZE.store(0, Ordering::Relaxed);

    if case == "allocation-failure" {
        let error = decoded.expect_err("decoder must report failed memory allocation");
        assert!(
            format!("{error:#}").contains("allocation failed"),
            "{error:#}"
        );
    } else if let Some(expected) = expected {
        assert_eq!(decoded.unwrap(), expected);
    } else {
        assert!(decoded.is_err(), "malformed snapshot {case} was accepted");
    }
}
