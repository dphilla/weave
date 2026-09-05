;; _start is an ordinary exported entry, not an instantiation hook.
;; Golden events when invoking run: EMIT32 100, 200. Result: 7.
;; A migration target aborted before COMMIT must emit neither event.
(module
  (import "env" "emit32" (func $emit (param i32)))
  (memory (export "memory") 1 1)
  (global $initialized (mut i32) (i32.const 0))
  (func $initialize
    (global.set $initialized (i32.const 7))
    (call $emit (i32.const 100)))
  (start $initialize)
  (func $entry (export "_start")
    (if (i32.ne (global.get $initialized) (i32.const 7))
      (then unreachable))
    (call $emit (i32.const 200)))
  (func (export "run") (param i32) (result i32)
    (call $entry)
    (global.get $initialized))
)
