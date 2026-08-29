(module
  (import "env" "emit32" (func $emit32 (param i32)))
  (memory $scratch 1)
  (memory $secondary 1)
  (export "scratch" (memory $scratch))
  (export "secondary" (memory $secondary))

  ;; The source clears an active data-segment byte. Its page is then all zero
  ;; and may be elided in pre-copy, exercising the target's explicit zeroing.
  (data (memory $secondary) (i32.const 0) "\7f")

  (func (export "run") (param $n i32) (result i32)
    (local $i i32)
    (i32.store8 $secondary (i32.const 0) (i32.const 0))
    ;; Synchronization event: CI migrates only after observing that the
    ;; active-segment byte has been cleared on the source.
    (call $emit32 (i32.load8_u $secondary (i32.const 0)))
    (loop $work
      (i32.store $scratch
        (i32.and (i32.mul (local.get $i) (i32.const 4)) (i32.const 65532))
        (local.get $i))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $work (i32.lt_u (local.get $i) (local.get $n))))
    (call $emit32 (local.get $i))
    (i32.add (local.get $i) (i32.load8_u $secondary (i32.const 0)))))
