//! Unsupported proposals must fail at the input boundary, not produce invalid
//! transformed modules or get mistaken for malformed supported instructions.

use weave_transform::{transform, TransformOptions};

fn diagnostic(wasm: &[u8]) -> String {
    let error = transform(wasm, &TransformOptions::default())
        .err()
        .expect("fixture must be rejected");
    format!("{error:#}")
}

fn reject(wat: &str, feature: &str, validate: bool) {
    let wasm = wat::parse_str(wat).unwrap();
    if validate {
        wasmparser::Validator::new()
            .validate_all(&wasm)
            .expect("fixture must be a valid input module");
    }
    let error = diagnostic(&wasm);
    assert!(
        error.contains(&format!("parsing input module: unsupported: {feature}")),
        "wrong rejection for {wat}: {error}"
    );
    assert!(!error.contains("BUG:"), "reached code generation: {error}");
    assert!(
        !error.contains("input module failed validation"),
        "feature was obscured by generic validation: {error}"
    );
}

#[test]
fn table64_declarations_are_rejected_even_without_table_instructions() {
    for table in [
        "(table i64 1 funcref)",
        r#"(import "env" "table" (table i64 1 2 funcref))"#,
    ] {
        reject(&format!("(module {table})"), "table64", true);
    }
}

#[test]
fn table64_copy_init_and_mixed_index_widths_are_rejected() {
    for wat in [
        r#"(module
            (table i64 4 funcref)
            (func (export "run")
                (table.copy (i64.const 0) (i64.const 1) (i64.const 2))))"#,
        r#"(module
            (table $t32 4 funcref)
            (table $t64 i64 4 funcref)
            (func (export "run")
                (table.copy $t32 $t64 (i32.const 0) (i64.const 1) (i32.const 2))
                (table.copy $t64 $t32 (i64.const 0) (i32.const 1) (i32.const 2))))"#,
        r#"(module
            (table i64 4 funcref)
            (elem $items func $f)
            (func $f)
            (func (export "run")
                (table.init $items (i64.const 0) (i32.const 0) (i32.const 1))))"#,
        r#"(module
            (import "env" "table" (table $t64 i64 4 funcref))
            (table $t32 4 funcref)
            (func (export "run")
                (table.copy $t64 $t32 (i64.const 0) (i32.const 1) (i32.const 2))))"#,
    ] {
        reject(wat, "table64", true);
    }
}

#[test]
fn defined_and_imported_exception_tags_are_never_silently_discarded() {
    for wat in [
        "(module (tag))",
        r#"(module (tag (export "event") (param i32)))"#,
        r#"(module (import "env" "event" (tag (param i32))))"#,
        r#"(module
            (tag $event)
            (func (export "run") (throw $event)))"#,
        r#"(module
            (tag $event)
            (func (export "run")
                (block $catch
                    (try_table (catch $event $catch) (throw $event)))))"#,
    ] {
        reject(wat, "exception tags", true);
    }
}

#[test]
fn exception_instructions_without_tags_are_rejected() {
    for wat in [
        r#"(module (func (export "run") (try_table (nop))))"#,
        r#"(module (func (export "run") (throw_ref (ref.null exn))))"#,
    ] {
        reject(wat, "exception instructions", true);
    }
}

#[test]
fn legacy_exception_instructions_are_rejected_explicitly() {
    let wat = r#"(module
        (func (export "run") try nop catch_all nop end))"#;
    let wasm = wat::parse_str(wat).unwrap();
    let mut features = wasmparser::WasmFeatures::default();
    features.set(wasmparser::WasmFeatures::LEGACY_EXCEPTIONS, true);
    wasmparser::Validator::new_with_features(features)
        .validate_all(&wasm)
        .expect("legacy fixture must be valid when its proposal is enabled");
    reject(wat, "exception instructions", false);
}

#[test]
fn gc_conversion_const_expressions_are_rejected_before_generic_validation() {
    for wat in [
        "(module (global externref (extern.convert_any (ref.null any))))",
        "(module (global anyref (any.convert_extern (ref.null extern))))",
    ] {
        let wasm = wat::parse_str(wat).unwrap();
        // These newer constant expressions are decoded, but are not yet
        // accepted by our pinned validator. The transformer must identify the
        // unsupported proposal instead of exposing that version mismatch.
        assert!(wasmparser::Validator::new().validate_all(&wasm).is_err());
        reject(wat, "GC instructions", false);
    }
}

#[test]
fn gc_instructions_are_checked_in_table_and_element_initializers_and_bodies() {
    for wat in [
        "(module (table 1 externref (extern.convert_any (ref.null any))))",
        "(module (elem externref (extern.convert_any (ref.null any))))",
    ] {
        reject(wat, "GC instructions", false);
    }
    reject(
        r#"(module (func (export "run")
            (drop (extern.convert_any (ref.null any)))))"#,
        "GC instructions",
        true,
    );
}

#[test]
fn supported_table32_funcref_and_constant_expressions_still_transform() {
    for wat in [
        r#"(module
            (import "env" "table" (table $imported 4 funcref))
            (table $defined 4 funcref)
            (elem $items func $f)
            (func $f)
            (func (export "run")
                (table.copy $defined $imported (i32.const 0) (i32.const 1) (i32.const 2))
                (table.init $defined $items (i32.const 0) (i32.const 0) (i32.const 1))))"#,
        r#"(module
            (memory 1)
            (global $base i32 (i32.const 2))
            (global funcref (ref.func $f))
            (table 2 funcref)
            (data (i32.const 3) "hello")
            (elem (i32.const 0) funcref (ref.func $f) (ref.null func))
            (func $f (export "run") (result i32)
                (i32.load8_u (i32.const 3))))"#,
    ] {
        let wasm = wat::parse_str(wat).unwrap();
        wasmparser::Validator::new().validate_all(&wasm).unwrap();
        let woven = transform(&wasm, &TransformOptions::default()).unwrap();
        wasmparser::Validator::new()
            .validate_all(&woven.wasm)
            .expect("supported controls must still produce valid output");
    }
}

#[test]
fn invalid_supported_modules_still_fail_full_input_validation() {
    for wat in [
        r#"(module (func (export "run") (result i32) (i64.const 0)))"#,
        r#"(module (func (export "run") (call 9)))"#,
        "(module (global i32 (i64.const 0)))",
        "(module (memory 1) (global i32 (i32.load (i32.const 0))))",
    ] {
        let wasm = wat::parse_str(wat).unwrap();
        let error = diagnostic(&wasm);
        assert!(error.contains("input module failed validation"), "{error}");
        assert!(!error.contains("unsupported:"), "{error}");
        assert!(!error.contains("BUG:"), "{error}");
    }
}

#[test]
fn malformed_encodings_are_not_misclassified_as_unsupported_features() {
    let valid = wat::parse_str(r#"(module (func (export "run") (nop)))"#).unwrap();
    let mut invalid_opcode = valid.clone();
    let opcode = invalid_opcode.len() - 2;
    assert_eq!(invalid_opcode[opcode], 0x01, "expected nop opcode");
    invalid_opcode[opcode] = 0xff;
    for wasm in [&[][..], &valid[..valid.len() - 1], &invalid_opcode] {
        let error = diagnostic(wasm);
        assert!(error.contains("input module failed validation"), "{error}");
        assert!(!error.contains("unsupported:"), "{error}");
    }

    // Recognizing an unsupported declaration must not hide a later truncated
    // function body. The preflight finishes decoding instead of returning at
    // the first recognized proposal.
    let mut truncated = wat::parse_str("(module (table i64 1 funcref) (func nop))").unwrap();
    truncated.pop();
    let error = diagnostic(&truncated);
    assert!(error.contains("input module failed validation"), "{error}");
    assert!(!error.contains("unsupported:"), "{error}");
}
