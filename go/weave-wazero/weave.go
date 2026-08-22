// Package main: the Weave host plugin for wazero (pure-Go WebAssembly
// runtime). Implements the same host ABI and wire protocol as the wasmtime
// and JS plugins: a workload can live-migrate wasmtime → wazero → Node and
// back, seamlessly.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

const (
	ProtoVersion = 2
	WPage        = 4096
	WasmPage     = 65536

	StateRun    = 0
	StateUnwind = 1
	StateRewind = 2
	FlagDone    = 0
	FlagUnwound = 1

	GState = "__weave_state"
	GFlag  = "__weave_flag"
	GEntry = "__weave_entry"
	GCtr   = "__weave_ctr"
	GSp    = "__weave_sp"
	GSBase = "__weave_stack_base"
	GSEnd  = "__weave_stack_end"
	GRbase = "__weave_rbase"
)

// ------------------------------------------------------------------ meta

type FuncSig struct {
	Module, Name    string
	Params, Results []byte
}

type Meta struct {
	PollPeriod      uint32
	Entries         []FuncSig
	Memories        []string
	Imports         []FuncSig
	ControlGlobals  []string
	GlobalsAreaSize uint32
	ResultsAreaSize uint32
}

type cursor struct {
	b   []byte
	pos int
	err error
}

func (c *cursor) take(n int) []byte {
	if c.err != nil {
		return nil
	}
	if n < 0 || c.pos < 0 || n > len(c.b)-c.pos {
		c.err = io.ErrUnexpectedEOF
		return nil
	}
	v := c.b[c.pos : c.pos+n]
	c.pos += n
	return v
}

func (c *cursor) u8() byte {
	b := c.take(1)
	if b == nil {
		return 0
	}
	return b[0]
}

func (c *cursor) u16() uint16 {
	b := c.take(2)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint16(b)
}

func (c *cursor) u32() uint32 {
	b := c.take(4)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint32(b)
}

func (c *cursor) u64() uint64 {
	b := c.take(8)
	if b == nil {
		return 0
	}
	return binary.LittleEndian.Uint64(b)
}

func (c *cursor) str() string {
	n := uint64(c.u32())
	if c.err != nil || n > uint64(len(c.b)-c.pos) {
		c.err = io.ErrUnexpectedEOF
		return ""
	}
	b := c.take(int(n))
	if !utf8.Valid(b) {
		c.err = fmt.Errorf("string is not valid UTF-8")
		return ""
	}
	return string(b)
}

func (c *cursor) blob() []byte {
	n := uint64(c.u32())
	if c.err != nil || n > uint64(len(c.b)-c.pos) {
		c.err = io.ErrUnexpectedEOF
		return nil
	}
	b := c.take(int(n))
	return append([]byte(nil), b...)
}

func (c *cursor) types() []byte {
	n := int(c.u16())
	b := c.take(n)
	if b == nil {
		return nil
	}
	out := append([]byte(nil), b...)
	for _, ty := range out {
		if ty > 5 {
			c.err = fmt.Errorf("unknown value type %d", ty)
			return nil
		}
	}
	return out
}

func (c *cursor) done() error {
	if c.err != nil {
		return c.err
	}
	if c.pos != len(c.b) {
		return fmt.Errorf("%d trailing payload bytes", len(c.b)-c.pos)
	}
	return nil
}

func decodeMeta(payload []byte) (*Meta, error) {
	if len(payload) < 6 || string(payload[:4]) != "WVMT" {
		return nil, fmt.Errorf("bad weave.meta magic")
	}
	c := &cursor{b: payload, pos: 4}
	if v := c.u16(); v != 1 {
		return nil, fmt.Errorf("unsupported weave.meta version %d", v)
	}
	m := &Meta{PollPeriod: c.u32()}
	for i, n := 0, int(c.u16()); i < n; i++ {
		e := FuncSig{Name: c.str()}
		e.Params = c.types()
		e.Results = c.types()
		m.Entries = append(m.Entries, e)
	}
	for i, n := 0, int(c.u16()); i < n; i++ {
		m.Memories = append(m.Memories, c.str())
	}
	for i, n := 0, int(c.u16()); i < n; i++ {
		imp := FuncSig{Module: c.str(), Name: c.str()}
		imp.Params = c.types()
		imp.Results = c.types()
		m.Imports = append(m.Imports, imp)
	}
	for i, n := 0, int(c.u16()); i < n; i++ {
		m.ControlGlobals = append(m.ControlGlobals, c.str())
	}
	m.GlobalsAreaSize = c.u32()
	m.ResultsAreaSize = c.u32()
	if err := c.done(); err != nil {
		return nil, fmt.Errorf("invalid weave.meta: %w", err)
	}
	return m, nil
}

func readWasmU32LEB(wasm []byte, pos *int, limit int) (uint32, error) {
	var result uint32
	for shift := uint(0); shift < 35; shift += 7 {
		if *pos >= limit {
			return 0, io.ErrUnexpectedEOF
		}
		b := wasm[*pos]
		*pos++
		if shift == 28 && b&0xf0 != 0 {
			return 0, fmt.Errorf("u32 LEB overflow")
		}
		result |= uint32(b&0x7f) << shift
		if b&0x80 == 0 {
			return result, nil
		}
	}
	return 0, fmt.Errorf("invalid u32 LEB")
}

type wasmExport struct {
	name  string
	kind  byte
	index uint32
}

// inspectWasmStructure reads only the section headers, memory count, and
// exports needed to validate weave.meta. The module is also compiled by the
// caller, but keeping this walker bounded avoids relying on runtime-internal
// APIs for unexported memory definitions.
func inspectWasmStructure(wasm []byte) (uint32, []wasmExport, error) {
	if len(wasm) < 8 || binary.LittleEndian.Uint32(wasm) != 0x6d736100 ||
		binary.LittleEndian.Uint32(wasm[4:]) != 1 {
		return 0, nil, fmt.Errorf("not a wasm module")
	}
	var definedMemories uint32
	var exports []wasmExport
	pos := 8
	for pos < len(wasm) {
		id := wasm[pos]
		pos++
		size, err := readWasmU32LEB(wasm, &pos, len(wasm))
		if err != nil || uint64(size) > uint64(len(wasm)-pos) {
			return 0, nil, fmt.Errorf("malformed wasm section")
		}
		end := pos + int(size)
		switch id {
		case 5: // memory section: vec(memorytype), count is the first field
			count, err := readWasmU32LEB(wasm, &pos, end)
			if err != nil {
				return 0, nil, fmt.Errorf("malformed memory section: %w", err)
			}
			definedMemories = count
		case 7: // export section: vec(name, kind, index)
			count, err := readWasmU32LEB(wasm, &pos, end)
			if err != nil {
				return 0, nil, fmt.Errorf("malformed export section: %w", err)
			}
			for i := uint32(0); i < count; i++ {
				nameLen, err := readWasmU32LEB(wasm, &pos, end)
				if err != nil || uint64(nameLen) > uint64(end-pos) {
					return 0, nil, fmt.Errorf("malformed export name")
				}
				name := string(wasm[pos : pos+int(nameLen)])
				pos += int(nameLen)
				if pos >= end {
					return 0, nil, fmt.Errorf("malformed export descriptor")
				}
				kind := wasm[pos]
				pos++
				index, err := readWasmU32LEB(wasm, &pos, end)
				if err != nil {
					return 0, nil, fmt.Errorf("malformed export index: %w", err)
				}
				exports = append(exports, wasmExport{name: name, kind: kind, index: index})
			}
			if pos != end {
				return 0, nil, fmt.Errorf("trailing bytes in export section")
			}
		case 8:
			return 0, nil, fmt.Errorf("woven migration module must not contain a start section")
		}
		pos = end
	}
	return definedMemories, exports, nil
}

func metaValueType(code byte) (api.ValueType, error) {
	switch code {
	case 0:
		return api.ValueTypeI32, nil
	case 1:
		return api.ValueTypeI64, nil
	case 2:
		return api.ValueTypeF32, nil
	case 3:
		return api.ValueTypeF64, nil
	case 4:
		return api.ValueType(0x7b), nil // v128 (not exported by wazero/api)
	case 5:
		return api.ValueType(0x70), nil // funcref (not exported by wazero/api)
	default:
		return 0, fmt.Errorf("unknown metadata value type %d", code)
	}
}

func validateValueTypes(label string, actual []api.ValueType, expected []byte) error {
	if len(actual) != len(expected) {
		return fmt.Errorf("%s has %d values, metadata declares %d", label, len(actual), len(expected))
	}
	for i, code := range expected {
		want, err := metaValueType(code)
		if err != nil {
			return err
		}
		if actual[i] != want {
			return fmt.Errorf("%s value %d has type %#x, metadata declares %#x", label, i, actual[i], want)
		}
	}
	return nil
}

func validateFunctionExport(definitions map[string]api.FunctionDefinition, name string, params, results []byte) error {
	definition, ok := definitions[name]
	if !ok {
		return fmt.Errorf("module has no exported function %s", name)
	}
	if err := validateValueTypes("function "+name+" parameters", definition.ParamTypes(), params); err != nil {
		return err
	}
	return validateValueTypes("function "+name+" results", definition.ResultTypes(), results)
}

func validateMemoryContract(compiled wazero.CompiledModule, wasm []byte, meta *Meta) (uint64, error) {
	definedMemories, _, err := inspectWasmStructure(wasm)
	if err != nil {
		return 0, err
	}
	totalMemories := uint64(len(compiled.ImportedMemories())) + uint64(definedMemories)
	if totalMemories != uint64(len(meta.Memories)) {
		return 0, fmt.Errorf("metadata names %d memories, module defines or imports %d", len(meta.Memories), totalMemories)
	}

	memoryDefinitions := compiled.ExportedMemories()
	seenMemories := make(map[string]struct{}, len(meta.Memories))
	var initialMemoryBytes uint64
	for index, name := range meta.Memories {
		if _, duplicate := seenMemories[name]; duplicate {
			return 0, fmt.Errorf("metadata contains duplicate memory export %q", name)
		}
		seenMemories[name] = struct{}{}
		memory, ok := memoryDefinitions[name]
		if !ok {
			return 0, fmt.Errorf("metadata memory export %q is absent from module", name)
		}
		if memory.Index() != uint32(index) {
			return 0, fmt.Errorf("metadata memory %q maps to index %d, expected %d", name, memory.Index(), index)
		}
		bytes := uint64(memory.Min()) * WasmPage
		if initialMemoryBytes > ^uint64(0)-bytes {
			return 0, fmt.Errorf("aggregate declared initial memory overflows u64")
		}
		initialMemoryBytes += bytes
	}

	return initialMemoryBytes, nil
}

// validateCompiledABI proves that untrusted weave.meta describes the actual
// module ABI used by migration. It returns aggregate declared initial memory.
func validateCompiledABI(compiled wazero.CompiledModule, wasm []byte, meta *Meta) (uint64, error) {
	initialMemoryBytes, err := validateMemoryContract(compiled, wasm, meta)
	if err != nil {
		return 0, err
	}
	_, exports, err := inspectWasmStructure(wasm)
	if err != nil {
		return 0, err
	}

	functions := compiled.ExportedFunctions()
	if err := validateFunctionExport(functions, "__weave_init", nil, nil); err != nil {
		return 0, err
	}
	if err := validateFunctionExport(functions, "__weave_resume", nil, nil); err != nil {
		return 0, err
	}
	seenEntries := make(map[string]struct{}, len(meta.Entries))
	for _, entry := range meta.Entries {
		if _, duplicate := seenEntries[entry.Name]; duplicate {
			return 0, fmt.Errorf("metadata contains duplicate entry %q", entry.Name)
		}
		seenEntries[entry.Name] = struct{}{}
		if err := validateFunctionExport(functions, entry.Name, entry.Params, entry.Results); err != nil {
			return 0, err
		}
	}

	var controlExports []string
	for _, export := range exports {
		if export.kind == api.ExternTypeGlobal && strings.HasPrefix(export.name, "__weave") {
			controlExports = append(controlExports, export.name)
		}
	}
	if len(controlExports) != len(meta.ControlGlobals) {
		return 0, fmt.Errorf("metadata names %d control globals, module exports %d", len(meta.ControlGlobals), len(controlExports))
	}
	for i := range controlExports {
		if controlExports[i] != meta.ControlGlobals[i] {
			return 0, fmt.Errorf("metadata control global %d is %q, module exports %q", i, meta.ControlGlobals[i], controlExports[i])
		}
	}
	requiredControls := []string{GState, GFlag, GEntry, GCtr, GSp, GSBase, GSEnd, GRbase}
	if len(meta.ControlGlobals) < len(requiredControls) {
		return 0, fmt.Errorf("metadata omits fixed Weave control globals")
	}
	for i, name := range requiredControls {
		if meta.ControlGlobals[i] != name {
			return 0, fmt.Errorf("metadata control global %d is %q, expected %q", i, meta.ControlGlobals[i], name)
		}
	}
	suffix := meta.ControlGlobals[len(requiredControls):]
	if len(suffix)%2 != 0 {
		return 0, fmt.Errorf("metadata table-shadow control globals are incomplete")
	}
	tableShadows := len(suffix) / 2
	for i := 0; i < tableShadows; i++ {
		if want := fmt.Sprintf("__weave_tsh%d", i); suffix[i] != want {
			return 0, fmt.Errorf("metadata table-shadow global %d is %q, expected %q", i, suffix[i], want)
		}
		if want := fmt.Sprintf("__weave_tshcap%d", i); suffix[tableShadows+i] != want {
			return 0, fmt.Errorf("metadata table-shadow capacity global %d is %q, expected %q", i, suffix[tableShadows+i], want)
		}
	}
	if meta.GlobalsAreaSize%16 != 0 {
		return 0, fmt.Errorf("metadata globals area size %d is not 16-byte aligned", meta.GlobalsAreaSize)
	}
	maxResults := 0
	for _, entry := range meta.Entries {
		if len(entry.Results) > maxResults {
			maxResults = len(entry.Results)
		}
	}
	wantResultsArea := uint64(maxResults) * 16
	if uint64(meta.ResultsAreaSize) != wantResultsArea {
		return 0, fmt.Errorf("metadata results area size is %d, expected %d", meta.ResultsAreaSize, wantResultsArea)
	}
	return initialMemoryBytes, nil
}

// extractMeta walks the wasm binary's custom sections for weave.meta.
func extractMeta(wasm []byte) (*Meta, []byte, error) {
	if len(wasm) < 8 || binary.LittleEndian.Uint32(wasm) != 0x6d736100 ||
		binary.LittleEndian.Uint32(wasm[4:]) != 1 {
		return nil, nil, fmt.Errorf("not a wasm module")
	}
	pos := 8
	for pos < len(wasm) {
		id := wasm[pos]
		pos++
		size, err := readWasmU32LEB(wasm, &pos, len(wasm))
		if err != nil || uint64(size) > uint64(len(wasm)-pos) {
			return nil, nil, fmt.Errorf("malformed wasm section")
		}
		end := pos + int(size)
		if id == 0 {
			nameLen, err := readWasmU32LEB(wasm, &pos, end)
			if err != nil || uint64(nameLen) > uint64(end-pos) {
				return nil, nil, fmt.Errorf("malformed custom section name")
			}
			name := string(wasm[pos : pos+int(nameLen)])
			pos += int(nameLen)
			if name == "weave.meta" {
				payload := append([]byte(nil), wasm[pos:end]...)
				m, err := decodeMeta(payload)
				return m, payload, err
			}
		}
		pos = end
	}
	return nil, nil, fmt.Errorf("module has no weave.meta section")
}

// ------------------------------------------------------------------ wire

const (
	FtHello      = 1
	FtModuleMeta = 2
	FtModuleNeed = 3
	FtModuleHave = 4
	FtModuleData = 5
	FtModuleOk   = 6
	FtMemLayout  = 7
	FtPage       = 8
	FtRoundEnd   = 9
	FtRoundAck   = 10
	FtFinalBegin = 11
	FtGlobals    = 12
	FtServices   = 13
	FtFinalEnd   = 14
	FtPrepared   = 15
	FtAbort      = 16
	FtCtlMigrate = 17
	FtCtlStatus  = 18
	FtCtlOk      = 19
	FtCtlErr     = 20
	FtCommit     = 21
	FtCommitOk   = 22
)

type frame struct {
	typ     byte
	payload []byte
}

func writeFrame(w *bufio.Writer, typ byte, payload []byte) error {
	if len(payload) > 64<<20 {
		return fmt.Errorf("frame payload too large: %d", len(payload))
	}
	var hdr [5]byte
	hdr[0] = typ
	binary.LittleEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func readFrameR(r *bufio.Reader) (frame, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return frame{}, err
	}
	n := binary.LittleEndian.Uint32(hdr[1:])
	if n > 64<<20 {
		return frame{}, fmt.Errorf("frame too large: %d", n)
	}
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return frame{}, err
	}
	return frame{typ: hdr[0], payload: payload}, nil
}

type wbuf struct{ bytes.Buffer }

func (w *wbuf) u8(v byte)     { w.WriteByte(v) }
func (w *wbuf) u16(v uint16)  { var b [2]byte; binary.LittleEndian.PutUint16(b[:], v); w.Write(b[:]) }
func (w *wbuf) u32(v uint32)  { var b [4]byte; binary.LittleEndian.PutUint32(b[:], v); w.Write(b[:]) }
func (w *wbuf) u64(v uint64)  { var b [8]byte; binary.LittleEndian.PutUint64(b[:], v); w.Write(b[:]) }
func (w *wbuf) str(s string)  { w.u32(uint32(len(s))); w.WriteString(s) }
func (w *wbuf) blob(b []byte) { w.u32(uint32(len(b))); w.Write(b) }

func abortFrame(w *bufio.Writer, code uint32, msg string) {
	var p wbuf
	p.u32(code)
	p.str(msg)
	writeFrame(w, FtAbort, p.Bytes())
	w.Flush()
}

func peerAbort(f frame) error {
	if f.typ == FtAbort {
		c := &cursor{b: f.payload}
		code := c.u32()
		msg := c.str()
		return fmt.Errorf("peer aborted (%d): %s", code, msg)
	}
	return fmt.Errorf("unexpected frame type %d", f.typ)
}

// ------------------------------------------------------------------ services

// Service carries migratable host-function state. Restore stages a fresh
// target before COMMIT and must not publish externally visible effects.
// env.emit* match the Rust and JS runners byte-for-byte.
type Service interface {
	Name() string
	Snapshot() []byte
	Restore([]byte) error
}

type emitState struct {
	count uint64
	sum   int64
}

type emitSvc struct {
	name string
	st   *emitState
}

func (s *emitSvc) Name() string { return s.name }
func (s *emitSvc) Snapshot() []byte {
	var b [16]byte
	binary.LittleEndian.PutUint64(b[:8], s.st.count)
	binary.LittleEndian.PutUint64(b[8:], uint64(s.st.sum))
	return b[:]
}
func (s *emitSvc) Restore(blob []byte) error {
	if len(blob) != 16 {
		return fmt.Errorf("bad emit snapshot")
	}
	s.st.count = binary.LittleEndian.Uint64(blob[:8])
	s.st.sum = int64(binary.LittleEndian.Uint64(blob[8:]))
	return nil
}

func snapshotServices(svcs []Service) [][2]interface{} {
	out := make([][2]interface{}, 0, len(svcs))
	names := make([]string, len(svcs))
	byName := map[string]Service{}
	for i, s := range svcs {
		names[i] = s.Name()
		byName[s.Name()] = s
	}
	sort.Strings(names)
	for _, n := range names {
		out = append(out, [2]interface{}{n, byName[n].Snapshot()})
	}
	return out
}

func validateServices(services []Service) error {
	seen := make(map[string]struct{}, len(services))
	for _, service := range services {
		if service == nil {
			return fmt.Errorf("nil host service")
		}
		name := service.Name()
		if !utf8.ValidString(name) {
			return fmt.Errorf("host-service name is not valid UTF-8")
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("duplicate host-service name %q", name)
		}
		seen[name] = struct{}{}
	}
	return nil
}

// ------------------------------------------------------------------ instance

type Instance struct {
	runtime  wazero.Runtime
	module   api.Module
	wasm     []byte
	metaRaw  []byte
	meta     *Meta
	hash     [32]byte
	services []Service
	// poll control
	pollMode  func() int32 // returns 0/1
	pollCount uint64
}

type Poll struct {
	inst *Instance
}

func (in *Instance) Close(ctx context.Context) error {
	if in.runtime == nil {
		return nil
	}
	err := in.runtime.Close(ctx)
	in.runtime = nil
	return err
}

func NewInstance(ctx context.Context, wasm []byte, services []Service, emitLog func(string)) (*Instance, error) {
	if err := validateServices(services); err != nil {
		return nil, err
	}
	meta, metaRaw, err := extractMeta(wasm)
	if err != nil {
		return nil, err
	}
	inst := &Instance{
		wasm:     wasm,
		meta:     meta,
		metaRaw:  metaRaw,
		hash:     sha256.Sum256(wasm),
		services: services,
	}
	inst.pollMode = func() int32 { return 0 }

	rt := wazero.NewRuntime(ctx)
	inst.runtime = rt
	completed := false
	defer func() {
		if !completed {
			_ = rt.Close(ctx)
		}
	}()

	compiled, err := rt.CompileModule(ctx, wasm)
	if err != nil {
		return nil, fmt.Errorf("compiling module: %w", err)
	}
	defer compiled.Close(ctx)
	if _, err := validateCompiledABI(compiled, wasm, meta); err != nil {
		return nil, fmt.Errorf("validating module ABI: %w", err)
	}

	_, err = rt.NewHostModuleBuilder("weave").
		NewFunctionBuilder().
		WithFunc(func() int32 {
			inst.pollCount++
			return inst.pollMode()
		}).
		Export("poll").
		Instantiate(ctx)
	if err != nil {
		return nil, fmt.Errorf("registering weave.poll: %w", err)
	}

	env := rt.NewHostModuleBuilder("env")
	// built-in emit services (state lives in inst.services)
	var emit, emit32, emit64 *emitState
	for _, s := range services {
		if es, ok := s.(*emitSvc); ok {
			switch es.name {
			case "env.emit":
				emit = es.st
			case "env.emit32":
				emit32 = es.st
			case "env.emit64":
				emit64 = es.st
			}
		}
	}
	if emit != nil {
		env = env.NewFunctionBuilder().WithFunc(func(i int32, h int64) {
			emit.count++
			emit.sum += h + int64(i)
			emitLog(fmt.Sprintf("EMIT %d %d", i, h))
		}).Export("emit")
	}
	if emit32 != nil {
		env = env.NewFunctionBuilder().WithFunc(func(v int32) {
			emit32.count++
			emit32.sum += int64(v)
			emitLog(fmt.Sprintf("EMIT32 %d", v))
		}).Export("emit32")
	}
	if emit64 != nil {
		env = env.NewFunctionBuilder().WithFunc(func(v int64) {
			emit64.count++
			emit64.sum += v
			emitLog(fmt.Sprintf("EMIT64 %d", v))
		}).Export("emit64")
	}
	if _, err := env.Instantiate(ctx); err != nil {
		return nil, fmt.Errorf("registering env services: %w", err)
	}

	mod, err := rt.InstantiateModule(ctx, compiled, wazero.NewModuleConfig())
	if err != nil {
		return nil, fmt.Errorf("instantiating module: %w", err)
	}
	inst.module = mod
	if err := inst.validateRuntimeABI(); err != nil {
		return nil, err
	}
	completed = true
	return inst, nil
}

func (in *Instance) validateRuntimeABI() error {
	seen := make(map[string]struct{}, len(in.meta.ControlGlobals))
	for _, name := range in.meta.ControlGlobals {
		if _, duplicate := seen[name]; duplicate {
			return fmt.Errorf("metadata contains duplicate control global %q", name)
		}
		seen[name] = struct{}{}
		global := in.module.ExportedGlobal(name)
		if global == nil {
			return fmt.Errorf("module has no exported control global %s", name)
		}
		if global.Type() != api.ValueTypeI32 {
			return fmt.Errorf("control global %s is not i32", name)
		}
		if _, mutable := global.(api.MutableGlobal); !mutable {
			return fmt.Errorf("control global %s is not mutable", name)
		}
	}
	return nil
}

func (in *Instance) global(name string) int32 {
	g := in.module.ExportedGlobal(name)
	if g == nil {
		panic("no global " + name)
	}
	return int32(uint32(g.Get()))
}

func (in *Instance) setGlobal(name string, v int32) error {
	g := in.module.ExportedGlobal(name)
	if g == nil {
		return fmt.Errorf("no global %s", name)
	}
	mg, ok := g.(api.MutableGlobal)
	if !ok {
		return fmt.Errorf("global %s not mutable", name)
	}
	mg.Set(uint64(uint32(v)))
	return nil
}

func (in *Instance) mem(i int) api.Memory {
	m := in.module.ExportedMemory(in.meta.Memories[i])
	if m == nil {
		panic("no memory " + in.meta.Memories[i])
	}
	return m
}

func (in *Instance) Init(ctx context.Context) error {
	function := in.module.ExportedFunction("__weave_init")
	if function == nil {
		return fmt.Errorf("module has no __weave_init export")
	}
	_, err := function.Call(ctx)
	return err
}

// CallEntry runs an entry to completion or unwind. Args are raw u64-encoded.
func (in *Instance) CallEntry(ctx context.Context, entry string, args []uint64) (bool, error) {
	fn := in.module.ExportedFunction(entry)
	if fn == nil {
		return false, fmt.Errorf("no export %s", entry)
	}
	if _, err := fn.Call(ctx, args...); err != nil {
		return false, err
	}
	return in.global(GFlag) == FlagUnwound, nil
}

func (in *Instance) Resume(ctx context.Context) (bool, error) {
	function := in.module.ExportedFunction("__weave_resume")
	if function == nil {
		return false, fmt.Errorf("module has no __weave_resume export")
	}
	if _, err := function.Call(ctx); err != nil {
		return false, err
	}
	return in.global(GFlag) == FlagUnwound, nil
}

// ReadResults reads the completed entry's results from the results area.
func (in *Instance) ReadResults() ([]string, error) {
	idx := int(in.global(GEntry))
	if idx < 0 || idx >= len(in.meta.Entries) {
		return nil, fmt.Errorf("bad entry index")
	}
	e := in.meta.Entries[idx]
	rbase := uint64(uint32(in.global(GRbase)))
	base := rbase + uint64(in.meta.GlobalsAreaSize)
	if base > uint64(^uint32(0)) {
		return nil, fmt.Errorf("results area offset overflow")
	}
	var out []string
	for i, ty := range e.Results {
		off := base + uint64(i)*16
		if off > uint64(^uint32(0)) {
			return nil, fmt.Errorf("results area offset overflow")
		}
		b, ok := in.mem(0).Read(uint32(off), 16)
		if !ok {
			return nil, fmt.Errorf("results area out of bounds")
		}
		switch ty {
		case 0:
			out = append(out, fmt.Sprintf("%d", int32(binary.LittleEndian.Uint32(b))))
		case 1:
			out = append(out, fmt.Sprintf("%d", int64(binary.LittleEndian.Uint64(b))))
		case 2:
			out = append(out, fmt.Sprintf("%v", float32frombits(binary.LittleEndian.Uint32(b))))
		case 3:
			out = append(out, fmt.Sprintf("%v", float64frombits(binary.LittleEndian.Uint64(b))))
		default:
			return nil, fmt.Errorf("unsupported result type %d", ty)
		}
	}
	return out, nil
}

func (in *Instance) captureGlobals() [][2]interface{} {
	out := make([][2]interface{}, 0, len(in.meta.ControlGlobals))
	for _, n := range in.meta.ControlGlobals {
		out = append(out, [2]interface{}{n, in.global(n)})
	}
	return out
}

// stateHash mirrors weave-core's StateHasher byte stream exactly.
func (in *Instance) stateHash(globals [][2]interface{}, services [][2]interface{}) [32]byte {
	h := sha256.New()
	h.Write([]byte("WVSH"))
	var b wbuf
	b.u32(uint32(len(in.meta.Memories)))
	h.Write(b.Bytes())
	for i := range in.meta.Memories {
		m := in.mem(i)
		size := m.Size()
		var lb wbuf
		lb.u64(uint64(size))
		h.Write(lb.Bytes())
		data, _ := m.Read(0, size)
		h.Write(data)
	}
	var gb wbuf
	gb.u32(uint32(len(globals)))
	for _, g := range globals {
		gb.str(g[0].(string))
		gb.u32(uint32(g[1].(int32)))
	}
	h.Write(gb.Bytes())
	var sb wbuf
	sb.u32(uint32(len(services)))
	for _, s := range services {
		sb.str(s[0].(string))
		sb.u64(uint64(len(s[1].([]byte))))
		sb.Write(s[1].([]byte))
	}
	h.Write(sb.Bytes())
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func float32frombits(b uint32) float32 { return math.Float32frombits(b) }
func float64frombits(b uint64) float64 { return math.Float64frombits(b) }
