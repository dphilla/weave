package main

// Regression coverage for malformed migration protocol input.

import (
	"bufio"
	"bytes"
	"context"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

func testLEB(value uint32) []byte {
	var out []byte
	for {
		b := byte(value & 0x7f)
		value >>= 7
		if value != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if value == 0 {
			return out
		}
	}
}

func testName(name string) []byte {
	return append(testLEB(uint32(len(name))), []byte(name)...)
}

func testSection(id byte, payload []byte) []byte {
	out := []byte{id}
	out = append(out, testLEB(uint32(len(payload)))...)
	return append(out, payload...)
}

func testABIWasm(resumeReturnsI32 bool, immutableControl int, withStart bool) []byte {
	wasm := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	types := []byte{1, 0x60, 0, 0}
	resumeType := byte(0)
	if resumeReturnsI32 {
		types = []byte{2, 0x60, 0, 0, 0x60, 0, 1, 0x7f}
		resumeType = 1
	}
	wasm = append(wasm, testSection(1, types)...)
	wasm = append(wasm, testSection(3, []byte{2, 0, resumeType})...)
	wasm = append(wasm, testSection(5, []byte{1, 0, 1})...)
	globals := []byte{8}
	for i := 0; i < 8; i++ {
		mutable := byte(1)
		if i == immutableControl {
			mutable = 0
		}
		globals = append(globals, 0x7f, mutable, 0x41, 0, 0x0b)
	}
	wasm = append(wasm, testSection(6, globals)...)
	controls := []string{GState, GFlag, GEntry, GCtr, GSp, GSBase, GSEnd, GRbase}
	exports := []byte{12}
	for _, export := range []struct {
		name  string
		kind  byte
		index uint32
	}{
		{"__weave_init", 0, 0},
		{"__weave_resume", 0, 1},
		{"run", 0, 0},
		{"memory", 2, 0},
	} {
		exports = append(exports, testName(export.name)...)
		exports = append(exports, export.kind)
		exports = append(exports, testLEB(export.index)...)
	}
	for i, name := range controls {
		exports = append(exports, testName(name)...)
		exports = append(exports, api.ExternTypeGlobal)
		exports = append(exports, testLEB(uint32(i))...)
	}
	wasm = append(wasm, testSection(7, exports)...)
	if withStart {
		wasm = append(wasm, testSection(8, []byte{0})...) // function 0 (__weave_init)
	}
	initBody := []byte{2, 0, 0x0b}
	resumeBody := []byte{2, 0, 0x0b}
	if resumeReturnsI32 {
		resumeBody = []byte{4, 0, 0x41, 0, 0x0b}
	}
	code := append([]byte{2}, initBody...)
	code = append(code, resumeBody...)
	return append(wasm, testSection(10, code)...)
}

func testABIMeta() *Meta {
	return &Meta{
		Memories:       []string{"memory"},
		ControlGlobals: []string{GState, GFlag, GEntry, GCtr, GSp, GSBase, GSEnd, GRbase},
	}
}

func compileTestModule(t *testing.T, wasm []byte) (context.Context, wazero.Runtime, wazero.CompiledModule) {
	t.Helper()
	ctx := context.Background()
	runtime := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigInterpreter())
	compiled, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		_ = runtime.Close(ctx)
		t.Fatal(err)
	}
	return ctx, runtime, compiled
}

func TestMalformedRemoteHelloIsRejectedWithoutPanic(t *testing.T) {
	server, client := net.Pipe()
	go func() {
		w := bufio.NewWriter(client)
		_ = writeFrame(w, FtHello, nil)
		_ = w.Flush()
		_ = client.Close()
	}()

	defer server.Close()
	_, _, err := acceptMigration(
		context.Background(),
		server,
		func([]byte) (*Instance, error) { return nil, nil },
		map[[32]byte][]byte{},
	)
	if err == nil {
		t.Fatal("malformed remote HELLO was accepted")
	}
}

func TestWireStringsRequireValidUTF8(t *testing.T) {
	c := &cursor{b: []byte{1, 0, 0, 0, 0xff}}
	if got := c.str(); got != "" {
		t.Fatalf("decoded invalid UTF-8 as %q", got)
	}
	if err := c.done(); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("invalid UTF-8 error = %v", err)
	}
}

type namedTestService string

func (service namedTestService) Name() string { return string(service) }
func (namedTestService) Snapshot() []byte     { return nil }
func (namedTestService) Restore([]byte) error { return nil }

func TestHostServiceNamesAreUniqueValidUTF8(t *testing.T) {
	if err := validateServices([]Service{namedTestService("x"), namedTestService("x")}); err == nil {
		t.Fatal("duplicate host-service names were accepted")
	}
	invalid := namedTestService(string([]byte{0xff}))
	if err := validateServices([]Service{invalid}); err == nil || !strings.Contains(err.Error(), "UTF-8") {
		t.Fatalf("invalid service-name error = %v", err)
	}
}

func TestCommitConfirmationLossIsNotRollbackSafe(t *testing.T) {
	server, client := net.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer client.Close()
		r := bufio.NewReader(client)
		f, err := readFrameR(r)
		if err != nil || f.typ != FtCommit || len(f.payload) != 0 {
			t.Errorf("expected empty COMMIT, got %#v, %v", f, err)
		}
		// Close without COMMIT_OK: the source must retire as uncertain.
	}()

	source := &sourceMigration{
		r:    bufio.NewReader(server),
		w:    bufio.NewWriter(server),
		conn: server,
	}
	stats := source.commitPrepared(migrationStats{rounds: 1})
	if stats.commitConfirmed {
		t.Fatal("lost COMMIT_OK was reported as confirmed")
	}
	if !strings.Contains(stats.commitError, "COMMIT_OK") {
		t.Fatalf("unexpected uncertainty: %q", stats.commitError)
	}
	_ = server.Close()
	<-done
}

func TestDeclaredInitialMemoryIsCheckedBeforeInstantiation(t *testing.T) {
	ctx := context.Background()
	wasm := []byte{
		0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
		0x05, 0x03, 0x01, 0x00, 0x02, // memory min=2
		0x07, 0x0a, 0x01, 0x06, 'm', 'e', 'm', 'o', 'r', 'y', 0x02, 0x00,
	}
	runtime := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfigInterpreter())
	defer runtime.Close(ctx)
	compiled, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		t.Fatal(err)
	}
	defer compiled.Close(ctx)
	got, err := validateMemoryContract(compiled, wasm, &Meta{Memories: []string{"memory"}})
	if err != nil {
		t.Fatal(err)
	}
	if want := uint64(2 * WasmPage); got != want {
		t.Fatalf("initial memory = %d, want %d", got, want)
	}
}

func TestCompiledABIRejectsForgedFunctionAndLayoutMetadata(t *testing.T) {
	for _, tc := range []struct {
		name string
		wasm []byte
		meta func() *Meta
		want string
	}{
		{
			name: "resume result",
			wasm: testABIWasm(true, -1, false),
			meta: testABIMeta,
			want: "__weave_resume results",
		},
		{
			name: "entry parameters",
			wasm: testABIWasm(false, -1, false),
			meta: func() *Meta {
				meta := testABIMeta()
				meta.Entries = []FuncSig{{Name: "run", Params: []byte{0}}}
				meta.ResultsAreaSize = 0
				return meta
			},
			want: "function run parameters",
		},
		{
			name: "omitted memory",
			wasm: testABIWasm(false, -1, false),
			meta: func() *Meta {
				meta := testABIMeta()
				meta.Memories = nil
				return meta
			},
			want: "metadata names 0 memories",
		},
		{
			name: "omitted control",
			wasm: testABIWasm(false, -1, false),
			meta: func() *Meta {
				meta := testABIMeta()
				meta.ControlGlobals = meta.ControlGlobals[:7]
				return meta
			},
			want: "metadata names 7 control globals",
		},
		{
			name: "results area",
			wasm: testABIWasm(false, -1, false),
			meta: func() *Meta {
				meta := testABIMeta()
				meta.ResultsAreaSize = 16
				return meta
			},
			want: "results area size",
		},
		{
			name: "start section",
			wasm: testABIWasm(false, -1, true),
			meta: testABIMeta,
			want: "must not contain a start section",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, runtime, compiled := compileTestModule(t, tc.wasm)
			defer runtime.Close(ctx)
			defer compiled.Close(ctx)
			_, err := validateCompiledABI(compiled, tc.wasm, tc.meta())
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want substring %q", err, tc.want)
			}
		})
	}
}

func TestRuntimeABIRejectsImmutableControlGlobal(t *testing.T) {
	wasm := testABIWasm(false, 3, false)
	ctx, runtime, compiled := compileTestModule(t, wasm)
	defer runtime.Close(ctx)
	defer compiled.Close(ctx)
	module, err := runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig())
	if err != nil {
		t.Fatal(err)
	}
	inst := &Instance{runtime: runtime, module: module, meta: testABIMeta()}
	if err := inst.validateRuntimeABI(); err == nil || !strings.Contains(err.Error(), "not mutable") {
		t.Fatalf("unexpected validation result: %v", err)
	}
}

func TestBusyNodeRejectsHelloWithoutQueuing(t *testing.T) {
	server, client := net.Pipe()
	defer client.Close()
	sh := &shared{active: true}
	incoming := make(chan net.Conn, 1)
	go classifyConn(server, sh, incoming)
	w := bufio.NewWriter(client)
	var hello wbuf
	hello.u8(ProtoVersion)
	hello.u8(1)
	hello.str("test")
	if err := writeFrame(w, FtHello, hello.Bytes()); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	f, err := readFrameR(bufio.NewReader(client))
	if err != nil {
		t.Fatal(err)
	}
	if f.typ != FtAbort {
		t.Fatalf("frame type = %d, want ABORT", f.typ)
	}
	select {
	case <-incoming:
		t.Fatal("busy HELLO was queued")
	default:
	}
}

func TestConcurrentControlRequestsHaveIndependentResults(t *testing.T) {
	sh := &shared{active: true}
	incoming := make(chan net.Conn, 1)
	startControl := func(target string) net.Conn {
		server, client := net.Pipe()
		go classifyConn(server, sh, incoming)
		var payload wbuf
		payload.str(target)
		w := bufio.NewWriter(client)
		if err := writeFrame(w, FtCtlMigrate, payload.Bytes()); err != nil {
			t.Fatal(err)
		}
		if err := w.Flush(); err != nil {
			t.Fatal(err)
		}
		return client
	}

	first := startControl("one")
	defer first.Close()
	deadline := time.Now().Add(time.Second)
	for {
		sh.mu.Lock()
		reserved := sh.request != nil
		sh.mu.Unlock()
		if reserved {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("first control request was not reserved")
		}
		time.Sleep(time.Millisecond)
	}

	second := startControl("two")
	defer second.Close()
	secondFrame, err := readFrameR(bufio.NewReader(second))
	if err != nil {
		t.Fatal(err)
	}
	if secondFrame.typ != FtCtlErr || !bytes.Contains(secondFrame.payload, []byte("already in progress")) {
		t.Fatalf("second control response = %#v", secondFrame)
	}

	sh.mu.Lock()
	sh.completeRequestLocked("migrated: first")
	sh.mu.Unlock()
	firstFrame, err := readFrameR(bufio.NewReader(first))
	if err != nil {
		t.Fatal(err)
	}
	if firstFrame.typ != FtCtlOk || !bytes.Contains(firstFrame.payload, []byte("migrated: first")) {
		t.Fatalf("first control response = %#v", firstFrame)
	}
}

func TestEmptyControlTargetDoesNotReserveTheNode(t *testing.T) {
	sh := &shared{active: true}
	incoming := make(chan net.Conn, 1)
	for _, target := range []string{"", " \t\n"} {
		server, client := net.Pipe()
		go classifyConn(server, sh, incoming)
		var payload wbuf
		payload.str(target)
		w := bufio.NewWriter(client)
		if err := writeFrame(w, FtCtlMigrate, payload.Bytes()); err != nil {
			t.Fatal(err)
		}
		if err := w.Flush(); err != nil {
			t.Fatal(err)
		}
		f, err := readFrameR(bufio.NewReader(client))
		if err != nil {
			t.Fatal(err)
		}
		_ = client.Close()
		if f.typ != FtCtlErr || !bytes.Contains(f.payload, []byte("must not be empty")) {
			t.Fatalf("response = %#v", f)
		}
		sh.mu.Lock()
		if sh.request != nil {
			sh.mu.Unlock()
			t.Fatal("empty target reserved migration state")
		}
		sh.mu.Unlock()
	}
}

func TestDeadlineConnBoundsStalledReads(t *testing.T) {
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	timed := &deadlineConn{Conn: server, timeout: 20 * time.Millisecond}
	started := time.Now()
	_, err := timed.Read(make([]byte, 1))
	if err == nil {
		t.Fatal("stalled read unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("stalled read was not bounded: %s", elapsed)
	}
}

func TestFinalScanStreamsHighDirtyMemoryInBoundedBatches(t *testing.T) {
	wasm := testABIWasm(false, -1, false)
	ctx, runtime, compiled := compileTestModule(t, wasm)
	defer runtime.Close(ctx)
	defer compiled.Close(ctx)
	module, err := runtime.InstantiateModule(ctx, compiled, wazero.NewModuleConfig())
	if err != nil {
		t.Fatal(err)
	}
	inst := &Instance{module: module, meta: testABIMeta()}
	memory := inst.mem(0)
	const pages = 256
	if _, ok := memory.Grow(pages - 1); !ok {
		t.Fatal("growing test memory failed")
	}
	for page := 0; page < pages; page++ {
		if !memory.Write(uint32(page*WPage), []byte{1}) {
			t.Fatalf("dirtying page %d failed", page)
		}
	}
	tracker := newTracker(1)
	emitted := 0
	count, err := tracker.scanFull(inst, func(page dirtyPage) error {
		if page.mem != 0 || page.pageNo != uint64(emitted) || len(page.bytes) != WPage {
			t.Fatalf("unexpected streamed page %#v", page)
		}
		emitted++
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if count != pages || emitted != pages {
		t.Fatalf("streamed %d/%d pages, want %d", count, emitted, pages)
	}
}
