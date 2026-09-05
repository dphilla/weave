package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"
)

// An ABI-valid module with distinct observable effects in __weave_init and
// _start. It has no Wasm start section: only an explicit host call may run it.
func testExplicitStartupWasm() []byte {
	wasm := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	wasm = append(wasm, testSection(1, []byte{
		2, 0x60, 0, 0, 0x60, 1, 0x7f, 0, // () -> (); (i32) -> ()
	})...)
	imports := append([]byte{1}, testName("env")...)
	imports = append(imports, testName("emit32")...)
	imports = append(imports, 0, 1) // function import, type 1
	wasm = append(wasm, testSection(2, imports)...)
	wasm = append(wasm, testSection(3, []byte{3, 0, 0, 0})...)
	wasm = append(wasm, testSection(5, []byte{1, 0, 1})...)
	controls := testABIMeta().ControlGlobals
	globals := []byte{byte(len(controls))}
	for range controls {
		globals = append(globals, 0x7f, 1, 0x41, 0, 0x0b)
	}
	wasm = append(wasm, testSection(6, globals)...)
	exports := []byte{byte(4 + len(controls))}
	for _, export := range []struct {
		name        string
		kind, index byte
	}{
		{"__weave_init", 0, 1},
		{"__weave_resume", 0, 2},
		{"_start", 0, 3},
		{"memory", 2, 0},
	} {
		exports = append(exports, testName(export.name)...)
		exports = append(exports, export.kind, export.index)
	}
	for index, name := range controls {
		exports = append(exports, testName(name)...)
		exports = append(exports, 3, byte(index))
	}
	wasm = append(wasm, testSection(7, exports)...)
	wasm = append(wasm, testSection(10, []byte{
		3,
		6, 0, 0x41, 10, 0x10, 0, 0x0b, // init: emit32(10)
		2, 0, 0x0b, // resume: no-op
		6, 0, 0x41, 20, 0x10, 0, 0x0b, // _start: emit32(20)
	})...)
	var meta wbuf
	meta.WriteString("WVMT")
	meta.u16(1)
	meta.u32(1)
	meta.u16(1)
	meta.str("_start")
	meta.u16(0)
	meta.u16(0)
	meta.u16(1)
	meta.str("memory")
	meta.u16(1)
	meta.str("env")
	meta.str("emit32")
	meta.u16(1)
	meta.u8(0) // i32
	meta.u16(0)
	meta.u16(uint16(len(controls)))
	for _, name := range controls {
		meta.str(name)
	}
	meta.u32(0)
	meta.u32(0)
	custom := append(testName("weave.meta"), meta.Bytes()...)
	return append(wasm, testSection(0, custom)...)
}

func TestStartupRunsOnlyThroughExplicitHostCalls(t *testing.T) {
	ctx := context.Background()
	var effects []string
	instance, err := NewInstance(ctx, testExplicitStartupWasm(), makeServices(), func(line string) {
		effects = append(effects, line)
	})
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close(ctx)
	if len(effects) != 0 {
		t.Fatalf("instantiation executed guest code: %v", effects)
	}
	if err := instance.Init(ctx); err != nil {
		t.Fatal(err)
	}
	if want := []string{"EMIT32 10"}; !reflect.DeepEqual(effects, want) {
		t.Fatalf("Init effects = %v, want %v", effects, want)
	}
	if unwound, err := instance.CallEntry(ctx, "_start", nil); err != nil || unwound {
		t.Fatalf("explicit _start returned unwound=%v, error=%v", unwound, err)
	}
	if want := []string{"EMIT32 10", "EMIT32 20"}; !reflect.DeepEqual(effects, want) {
		t.Fatalf("startup effects = %v, want %v", effects, want)
	}
}

func TestAbortedMigrationDoesNotExecuteExportedStart(t *testing.T) {
	for _, cached := range []bool{false, true} {
		name := "received module"
		if cached {
			name = "cached module"
		}
		t.Run(name, func(t *testing.T) {
			ctx := context.Background()
			wasm := testExplicitStartupWasm()
			_, meta, err := extractMeta(wasm)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(wasm)
			cache := make(map[[32]byte][]byte)
			if cached {
				cache[hash] = wasm
			}
			server, client := net.Pipe()
			defer server.Close()
			defer client.Close()
			_ = client.SetDeadline(time.Now().Add(3 * time.Second))
			var effects []string
			instantiations := 0
			done := make(chan error, 1)
			go func() {
				_, _, err := acceptMigration(ctx, server, func(bytes []byte) (*Instance, error) {
					instantiations++
					return NewInstance(ctx, bytes, makeServices(), func(line string) {
						effects = append(effects, line)
					})
				}, cache)
				done <- err
			}()
			reader, writer := bufio.NewReader(client), bufio.NewWriter(client)
			send := func(kind byte, payload []byte) {
				t.Helper()
				if err := writeFrame(writer, kind, payload); err != nil {
					t.Fatal(err)
				}
				if err := writer.Flush(); err != nil {
					t.Fatal(err)
				}
			}
			expect := func(kind byte) {
				t.Helper()
				got, err := readFrameR(reader)
				if err != nil || got.typ != kind {
					t.Fatalf("expected frame %d, got %#v, error=%v", kind, got, err)
				}
			}
			var hello wbuf
			hello.u8(ProtoVersion)
			hello.u8(1)
			hello.str("test")
			send(FtHello, hello.Bytes())
			expect(FtHello)
			var offer wbuf
			offer.Write(hash[:])
			offer.u64(uint64(len(wasm)))
			offer.blob(meta)
			send(FtModuleMeta, offer.Bytes())
			if cached {
				expect(FtModuleHave)
			} else {
				expect(FtModuleNeed)
				var data wbuf
				data.u64(0)
				data.Write(wasm)
				send(FtModuleData, data.Bytes())
			}
			expect(FtModuleOk)
			var abort wbuf
			abort.u32(10)
			abort.str("test abort before COMMIT")
			send(FtAbort, abort.Bytes())
			select {
			case err := <-done:
				if err == nil || !strings.Contains(err.Error(), "test abort before COMMIT") {
					t.Fatalf("migration abort error = %v", err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("migration did not terminate after ABORT")
			}
			if instantiations != 1 {
				t.Fatalf("target instantiations = %d, want 1", instantiations)
			}
			if len(effects) != 0 {
				t.Fatalf("aborted target executed guest code before COMMIT: %v", effects)
			}
		})
	}
}
