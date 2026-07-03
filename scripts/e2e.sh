#!/usr/bin/env bash
# Weave end-to-end matrix. Run from the repo root:
#   ./scripts/e2e.sh
#
# Exercises, over real TCP between real processes:
#   1. transform + uninterrupted run (wasmtime, Node/V8)
#   2. checkpoint-to-file → restore-in-fresh-process seamlessness
#   3. live migration wasmtime → wasmtime
#   4. live migration wasmtime → Node(V8)   (cross-runtime)
#   5. live migration Node(V8) → wasmtime   (cross-runtime, reverse)
#   6. chain: wasmtime → Node → wasmtime    (workload crosses 3 processes)
#   7. Rust/LLVM-compiled guest migrated mid-render
# Every case is verified for *seamlessness*: the concatenated host-service
# output of all hops must be byte-identical to an uninterrupted golden run.

set -u
cd "$(dirname "$0")/.."
ROOT="$PWD"
T="$(mktemp -d)"
W="$ROOT/target/debug/weave"
NODE_W="node $ROOT/js/weave-node.mjs"
GO_W="$ROOT/go/weave-wazero/weave-wazero"
PASS=0
FAIL=0
declare -a FAILED_CASES=()

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { PASS=$((PASS+1)); printf '\033[32mPASS\033[0m %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); FAILED_CASES+=("$*"); printf '\033[31mFAIL\033[0m %s\n' "$*"; }
cleanup() { pkill -f "target/debug/weave serve" 2>/dev/null; pkill -f weave-node.mjs 2>/dev/null; pkill -f "weave-wazero serve" 2>/dev/null; }
trap cleanup EXIT

emits() { grep -E '^EMIT|^WEAVE_DONE' "$@" ; }

say "building"
cargo build -p weave-cli 2>&1 | tail -1
(cd guests/mandel && cargo build --release --target wasm32-unknown-unknown 2>&1 | tail -1)
(cd go/weave-wazero && go build -o weave-wazero .)

say "1. transform + golden runs"
"$W" transform guests/counter.wat -o "$T/counter.wasm" || { bad transform; exit 1; }
"$W" transform guests/mandel/target/wasm32-unknown-unknown/release/mandel.wasm -o "$T/mandel.wasm" || { bad transform-mandel; exit 1; }
N=2000000000
FR=80
"$W" run "$T/counter.wasm" --pre-woven --invoke run --arg $N > "$T/golden.raw" &
GOLD1=$!
"$W" run "$T/mandel.wasm" --pre-woven --invoke render --arg $FR > "$T/mandel_golden.raw" &
GOLD2=$!
# quick correctness cross-check on a small run: wasmtime vs node output identical
"$W" run "$T/counter.wasm" --pre-woven --invoke run --arg 300000 | emits /dev/stdin > "$T/small_wt.txt"
$NODE_W run --module "$T/counter.wasm" --invoke run --arg 300000 | emits /dev/stdin > "$T/small_js.txt"
diff -q "$T/small_wt.txt" "$T/small_js.txt" >/dev/null && ok "wasmtime and Node produce identical output" || bad "cross-runtime determinism"

say "2. checkpoint-to-file -> restore-in-fresh-process"
"$W" checkpoint "$T/counter.wasm" --pre-woven --invoke run --arg 300000 --after-polls 2 -o "$T/snap.bin" > "$T/pre.txt" 2>/dev/null
"$W" restore "$T/counter.wasm" "$T/snap.bin" --pre-woven > "$T/post.txt"
cat "$T/pre.txt" "$T/post.txt" | emits /dev/stdin > "$T/cr.txt"
diff -q "$T/small_wt.txt" "$T/cr.txt" >/dev/null && ok "checkpoint/restore seamless" || bad "checkpoint/restore"

wait $GOLD1; wait $GOLD2
emits "$T/golden.raw" > "$T/golden.txt"
emits "$T/mandel_golden.raw" > "$T/mandel_golden.txt"

# migrate_case NAME src_kind dst_kind module entry arg golden migrate_delay
migrate_case() {
  local name=$1 src=$2 dst=$3 module=$4 entry=$5 arg=$6 golden=$7 delay=$8
  local pa pb
  pa=$(( (RANDOM % 1000) + 21000 ))
  pb=$((pa + 1))
  local a_out="$T/${name}_A.out" b_out="$T/${name}_B.out"
  case $dst in
    wt)   "$W" serve --listen 127.0.0.1:$pb --exit-on-done > "$b_out" 2>/dev/null & ;;
    node) $NODE_W serve --listen 127.0.0.1:$pb --exit-on-done > "$b_out" 2>/dev/null & ;;
    go)   "$GO_W" serve --listen 127.0.0.1:$pb --exit-on-done > "$b_out" 2>/dev/null & ;;
  esac
  local B_PID=$!
  sleep 0.4
  case $src in
    wt)   "$W" serve --listen 127.0.0.1:$pa --module "$module" --pre-woven --invoke "$entry" --arg "$arg" --exit-on-done > "$a_out" 2>/dev/null & ;;
    node) $NODE_W serve --listen 127.0.0.1:$pa --module "$module" --invoke "$entry" --arg "$arg" --exit-on-done > "$a_out" 2>/dev/null & ;;
    go)   "$GO_W" serve --listen 127.0.0.1:$pa --module "$module" --invoke "$entry" --arg "$arg" --exit-on-done > "$a_out" 2>/dev/null & ;;
  esac
  local A_PID=$!
  sleep "$delay"
  "$W" migrate --node 127.0.0.1:$pa --to 127.0.0.1:$pb > "$T/${name}_ctl.txt" 2>&1
  wait $A_PID 2>/dev/null
  wait $B_PID 2>/dev/null
  if ! grep -q "^ok: migrated" "$T/${name}_ctl.txt"; then
    bad "$name (migration did not complete: $(cat "$T/${name}_ctl.txt"))"
    return
  fi
  cat "$a_out" "$b_out" | emits /dev/stdin > "$T/${name}_combined.txt"
  if diff -q "$golden" "$T/${name}_combined.txt" >/dev/null; then
    ok "$name seamless ($(grep -c '^EMIT' "$a_out") + $(grep -c '^EMIT' "$b_out") emissions, $(sed 's/ok: migrated: //' "$T/${name}_ctl.txt"))"
  else
    bad "$name (output diverged)"
  fi
}

say "3. live migration wasmtime -> wasmtime"
migrate_case wt_wt wt wt "$T/counter.wasm" run $N "$T/golden.txt" 1.5

say "4. live migration wasmtime -> Node(V8)"
migrate_case wt_js wt node "$T/counter.wasm" run $N "$T/golden.txt" 1.5

say "5. live migration Node(V8) -> wasmtime"
migrate_case js_wt node wt "$T/counter.wasm" run $N "$T/golden.txt" 2

say "6. chain wasmtime -> Node -> wasmtime"
PC=22500
"$W" serve --listen 127.0.0.1:$((PC+2)) --exit-on-done > "$T/chain_C.out" 2>/dev/null &
C_PID=$!
$NODE_W serve --listen 127.0.0.1:$((PC+1)) --exit-on-done > "$T/chain_B.out" 2>/dev/null &
B_PID=$!
sleep 0.4
"$W" serve --listen 127.0.0.1:$PC --module "$T/counter.wasm" --pre-woven --invoke run --arg $N --exit-on-done > "$T/chain_A.out" 2>/dev/null &
A_PID=$!
sleep 1.5
"$W" migrate --node 127.0.0.1:$PC --to 127.0.0.1:$((PC+1)) > "$T/chain1.txt" 2>&1
sleep 3
$NODE_W migrate --node 127.0.0.1:$((PC+1)) --to 127.0.0.1:$((PC+2)) > "$T/chain2.txt" 2>&1
wait $A_PID 2>/dev/null; wait $B_PID 2>/dev/null; wait $C_PID 2>/dev/null
cat "$T/chain_A.out" "$T/chain_B.out" "$T/chain_C.out" | emits /dev/stdin > "$T/chain.txt"
if grep -q "^ok" "$T/chain1.txt" && grep -q "^ok" "$T/chain2.txt" \
   && diff -q "$T/golden.txt" "$T/chain.txt" >/dev/null; then
  ok "chain A(wt)->B(node)->C(wt) seamless ($(grep -c '^EMIT' "$T/chain_A.out")+$(grep -c '^EMIT' "$T/chain_B.out")+$(grep -c '^EMIT' "$T/chain_C.out") emissions)"
else
  bad "chain migration"
fi

say "7. Rust/LLVM guest migrated mid-render (wasmtime -> Node)"
migrate_case mandel wt node "$T/mandel.wasm" render $FR "$T/mandel_golden.txt" 1.5

say "8. live migration wasmtime -> wazero(Go)"
migrate_case wt_go wt go "$T/counter.wasm" run $N "$T/golden.txt" 1.5

say "9. live migration wazero(Go) -> wasmtime"
migrate_case go_wt go wt "$T/counter.wasm" run $N "$T/golden.txt" 2

say "10. triple chain wasmtime -> wazero(Go) -> Node(V8)"
PT=22600
$NODE_W serve --listen 127.0.0.1:$((PT+2)) --exit-on-done > "$T/tri_C.out" 2>/dev/null &
TC_PID=$!
"$GO_W" serve --listen 127.0.0.1:$((PT+1)) --exit-on-done > "$T/tri_B.out" 2>/dev/null &
TB_PID=$!
sleep 0.4
"$W" serve --listen 127.0.0.1:$PT --module "$T/counter.wasm" --pre-woven --invoke run --arg $N --exit-on-done > "$T/tri_A.out" 2>/dev/null &
TA_PID=$!
sleep 1.5
"$W" migrate --node 127.0.0.1:$PT --to 127.0.0.1:$((PT+1)) > "$T/tri1.txt" 2>&1
sleep 3
"$GO_W" migrate --node 127.0.0.1:$((PT+1)) --to 127.0.0.1:$((PT+2)) > "$T/tri2.txt" 2>&1
wait $TA_PID 2>/dev/null; wait $TB_PID 2>/dev/null; wait $TC_PID 2>/dev/null
cat "$T/tri_A.out" "$T/tri_B.out" "$T/tri_C.out" | emits /dev/stdin > "$T/tri.txt"
if grep -q "^ok" "$T/tri1.txt" && grep -q "^ok" "$T/tri2.txt" \
   && diff -q "$T/golden.txt" "$T/tri.txt" >/dev/null; then
  ok "triple chain wt->go->node seamless ($(grep -c '^EMIT' "$T/tri_A.out")+$(grep -c '^EMIT' "$T/tri_B.out")+$(grep -c '^EMIT' "$T/tri_C.out") emissions)"
else
  bad "triple chain migration"
fi

say "results"
echo "PASS=$PASS FAIL=$FAIL"
if [ $FAIL -gt 0 ]; then
  printf 'failed: %s\n' "${FAILED_CASES[@]}"
  exit 1
fi
echo "ALL E2E CASES PASS"
