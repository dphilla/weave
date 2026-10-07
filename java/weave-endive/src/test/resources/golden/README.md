# Golden files

Produced by the Rust `weave` CLI (commit 052be32), so the Java tests check byte compatibility
against the reference implementation rather than against themselves. Regenerate from the
repository root after a transformer change:

```sh
G=java/weave-endive/src/test/resources/golden
W=target/debug/weave
$W transform guests/counter.wat -o $G/counter.woven.wasm
$W run $G/counter.woven.wasm --pre-woven --invoke run --arg 2000000 > $G/counter-2000000.events
$W checkpoint $G/counter.woven.wasm --pre-woven --invoke run --arg 2000000 --after-polls 7 -o $G/counter-7.snap
gzip -n -9 -f $G/counter-7.snap
$W transform wamr/tests/fixtures/simd-multi-memory.wat -o $G/simd-multi-memory.woven.wasm
$W transform wamr/tests/fixtures/multi-memory.wat -o $G/multi-memory.woven.wasm
```

| file | sha256 |
|---|---|
| counter.woven.wasm | e3cc6a9aa6e25d8de7c72ba9df879e2679296fdd10d093f1ef62d960993a9e3f |
| counter-7.snap.gz | 8edb32527de010a832b3379cb93c046f1ae04b46ad1b4c2ce911ebc107cded45 |
| simd-multi-memory.woven.wasm | d0133b83131b20d047530e465cb6b7f63b102efbb0837f5dab0af7c553f2b203 |
| multi-memory.woven.wasm | faa04c0a7bf1eb9f290b5c2edcdc7d47480d4999786718eedaab4fcb542327c3 |
