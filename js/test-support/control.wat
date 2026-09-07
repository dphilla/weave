;; Real transformed guest for native control process tests: no host imports.
;; Regenerate: weave transform js/test-support/control.wat --period 1 --stack-pages 2 -o /tmp/control.wasm
(module
  (memory (export "memory") 1)
  (func (export "forever")
    (loop $again (br $again)))
  (func (export "run") (result i32) (i32.const 42))
  (func (export "fail") unreachable))
