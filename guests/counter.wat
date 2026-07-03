(module
  (import "env" "emit" (func $emit (param i32 i64)))
  (memory (export "memory") 16)
  (func (export "run") (param $n i32) (result i64)
    (local $i i32) (local $h i64) (local $addr i32)
    (local.set $h (i64.const 1469598103934665603))
    (loop $l
      (local.set $addr
        (i32.and (i32.mul (local.get $i) (i32.const 2654435761)) (i32.const 0xFFFF8)))
      (i64.store (local.get $addr)
        (i64.xor (i64.load (local.get $addr)) (i64.extend_i32_u (local.get $i))))
      (local.set $h
        (i64.mul (i64.xor (local.get $h) (i64.load (local.get $addr)))
                 (i64.const 1099511628211)))
      (if (i32.eqz (i32.rem_u (local.get $i) (i32.const 50000)))
        (then (call $emit (local.get $i) (local.get $h))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (local.get $n))))
    (local.get $h)))
