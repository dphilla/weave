;; A genuine, long-running computation: all arithmetic lives in WebAssembly.
;; Build with: weave transform pi.wat -o pi.wasm --period 64 --stack-pages 2
;;
;; Pair adjacent Leibniz terms to avoid subtraction of nearly equal numbers:
;;   pi = sum(k = 0..infinity) 8 / ((4*k + 1) * (4*k + 3)).
;; Kahan summation carries rounding compensation between iterations. The
;; truncation error is approximately 1 / reported_terms, so convergence is
;; intentionally visible rather than pretending to discover digits instantly.
;; Eventually f64 precision limits visible improvement. This is a migration
;; demonstration, not a record-setting or arbitrary-precision pi algorithm.
;;
;; The counter, sum, and compensation remain live in a nested Wasm frame. No
;; JavaScript callback can reconstruct that frame from the progress arguments.
;; Guest memory and stack do not grow as the computation continues. The finite
;; limit of 2^52 original series terms keeps every denominator integer exact
;; before conversion to f64; it is far beyond a normal multi-day demonstration.
(module
  (import "demo" "progress" (func $progress (param i64 f64)))
  (memory (export "memory") 1)

  (func $calculate
    (local $pairs i64)
    (local $sum f64)
    (local $compensation f64)
    (local $denominator f64)
    (local $term f64)
    (local $adjusted f64)
    (local $next f64)

    (loop $again
      ;; d = 4*k + 1; a paired contribution is 8 / (d * (d + 2)).
      (local.set $denominator
        (f64.convert_i64_u
          (i64.add (i64.mul (local.get $pairs) (i64.const 4)) (i64.const 1))))
      (local.set $term
        (f64.div (f64.const 8)
          (f64.mul (local.get $denominator)
            (f64.add (local.get $denominator) (f64.const 2)))))

      ;; Kahan's correction is part of the continuation, not host-side state.
      (local.set $adjusted (f64.sub (local.get $term) (local.get $compensation)))
      (local.set $next (f64.add (local.get $sum) (local.get $adjusted)))
      (local.set $compensation
        (f64.sub (f64.sub (local.get $next) (local.get $sum)) (local.get $adjusted)))
      (local.set $sum (local.get $next))
      (local.set $pairs (i64.add (local.get $pairs) (i64.const 1)))

      ;; 16,384 pairs = 32,768 terms; reporting is deliberately low overhead.
      (if (i64.eqz (i64.and (local.get $pairs) (i64.const 16383)))
        (then
          (call $progress
            (i64.mul (local.get $pairs) (i64.const 2))
            (local.get $sum))))

      (br_if $again (i64.lt_u (local.get $pairs) (i64.const 2251799813685248)))
    )
  )

  (func (export "run")
    (call $calculate)
  )
)
