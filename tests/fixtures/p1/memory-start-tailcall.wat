;; Golden host events for any positive iteration count:
;; EMIT32 100, 1, 1, 42, 77, 43, 400, 401, 1, 1, 2, 0, 77, 43,
;;        -1, 2, 600, 601, 999
;; Result: 42. Use a large iteration count to migrate before the midpoint.
;; Growth after a checkpoint must relocate the private runtime suffix without
;; exposing its bytes, corrupting suspended frames, or changing guest pointers.
(module
  (type $answerType (func (result i32)))
  (import "env" "emit32" (func $emit (param i32)))
  (memory (export "memory") 1 2)
  (table 1 funcref)
  (elem (i32.const 0) $answer)
  (elem declare func $changed)
  (data $passive "\ab")
  (global $initialized (mut i32) (i32.const 0))

  (func $initialize (local $i i32)
    (loop $again
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $again (i32.lt_u (local.get $i) (i32.const 2048))))
    (global.set $initialized (i32.const 41))
    (i32.store (i32.const 0) (i32.const 77))
    (call $emit (i32.const 100)))
  (start $initialize)

  ;; This pure tail-call path must be lowered even when it needs no polls.
  (func $answer (result i32)
    (i32.add (global.get $initialized) (i32.const 1)))
  (func $tail (result i32)
    (return_call $answer))
  (func $changed (result i32)
    (i32.add (global.get $initialized) (i32.const 2)))

  (func (export "run") (param $iterations i32) (result i32)
    (local $i i32)
    (local $midpoint i32)
    (call $emit (memory.size))
    (call $emit (memory.grow (i32.const 0)))
    (call $emit (call $tail))
    (call $emit (i32.load (i32.const 0)))
    (table.set (i32.const 0) (ref.func $changed))
    (call $emit (call_indirect (type $answerType) (i32.const 0)))
    (memory.init $passive (i32.const 4) (i32.const 0) (i32.const 1))
    (data.drop $passive)
    (local.set $midpoint (i32.div_u (local.get $iterations) (i32.const 2)))
    (loop $work
      ;; Paired quarter markers let a multi-hop test migrate at three stages.
      (if (i32.eq (local.get $i) (i32.div_u (local.get $iterations) (i32.const 4)))
        (then
          (call $emit (i32.const 400))
          (call $emit (i32.const 401))))
      (if (i32.eq (local.get $i) (local.get $midpoint))
        (then
          (call $emit (memory.size))
          (call $emit (memory.grow (i32.const 1)))
          (call $emit (memory.size))
          (call $emit (i32.load (i32.const 65536)))
          (call $emit (i32.load (i32.const 0)))
          (call $emit (call_indirect (type $answerType) (i32.const 0)))
          ;; A dropped segment still permits an empty copy at the guest end.
          (memory.init $passive (i32.const 131072) (i32.const 0) (i32.const 0))
          (call $emit (memory.grow (i32.const 1)))
          (call $emit (memory.size))))
      (if (i32.eq (local.get $i)
                 (i32.add (local.get $midpoint)
                          (i32.div_u (local.get $iterations) (i32.const 4))))
        (then
          (call $emit (i32.const 600))
          (call $emit (i32.const 601))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $work (i32.lt_u (local.get $i) (local.get $iterations))))
    (call $emit (i32.const 999))
    (call $tail))
)
