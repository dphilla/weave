;; Genuine guest for public-library lifecycle tests. Compile with:
;; cargo run --release -p weave-cli -- transform js/test-support/lifecycle.wat \
;;   --period 1 --stack-pages 2 -o /tmp/lifecycle.woven.wasm
;; lifecycle-fixture.mjs records these bytes so JS-only tests need no Rust toolchain.
(module
  (import "host" "initialized" (func $initialized))
  (import "host" "tick" (func $tick (param i32)))
  (memory (export "memory") 1)
  (func $initialize (call $initialized))
  (start $initialize)
  (func (export "run") (param $n i32) (result i32)
    (local $i i32) (local $sum i32)
    (block $done
      (loop $next
        (br_if $done (i32.ge_u (local.get $i) (local.get $n)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (call $tick (local.get $i))
        (local.set $sum (i32.add (local.get $sum) (local.get $i)))
        (br $next)))
    (local.get $sum))
  (func (export "forever")
    (local $i i32)
    (loop $next
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (call $tick (local.get $i))
      (br $next)))
  (func (export "typed") (param i32 i64 f32 f64) (result i64)
    (local.get 1))
  (func (export "fail") unreachable))
