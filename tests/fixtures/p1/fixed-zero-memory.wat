;; A declared maximum of zero must not prevent private runtime allocation.
;; Guest-visible size and grow(0) stay zero, and grow(1) must still fail.
;; Golden events: EMIT32 0, 0, -1, 0. Result: 7.
(module
  (import "env" "emit32" (func $emit (param i32)))
  (memory (export "memory") 0 0)
  (func $answer (result i32) (i32.const 7))
  (func $tail (result i32) (return_call $answer))
  (func (export "run") (param i32) (result i32)
    (call $emit (memory.size))
    (call $emit (memory.grow (i32.const 0)))
    (call $emit (memory.grow (i32.const 1)))
    (call $emit (memory.size))
    (call $tail))
)
