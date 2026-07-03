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

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

const (
	ProtoVersion = 1
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
}

func (c *cursor) u8() byte     { v := c.b[c.pos]; c.pos++; return v }
func (c *cursor) u16() uint16  { v := binary.LittleEndian.Uint16(c.b[c.pos:]); c.pos += 2; return v }
func (c *cursor) u32() uint32  { v := binary.LittleEndian.Uint32(c.b[c.pos:]); c.pos += 4; return v }
func (c *cursor) u64() uint64  { v := binary.LittleEndian.Uint64(c.b[c.pos:]); c.pos += 8; return v }
func (c *cursor) str() string  { n := int(c.u32()); s := string(c.b[c.pos : c.pos+n]); c.pos += n; return s }
func (c *cursor) types() []byte {
	n := int(c.u16())
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = c.u8()
	}
	return out
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
	return m, nil
}

// extractMeta walks the wasm binary's custom sections for weave.meta.
func extractMeta(wasm []byte) (*Meta, []byte, error) {
	if len(wasm) < 8 || binary.LittleEndian.Uint32(wasm) != 0x6d736100 {
		return nil, nil, fmt.Errorf("not a wasm module")
	}
	pos := 8
	leb := func() int {
		r, s := 0, 0
		for {
			b := wasm[pos]
			pos++
			r |= int(b&0x7f) << s
			if b&0x80 == 0 {
				return r
			}
			s += 7
		}
	}
	for pos < len(wasm) {
		id := wasm[pos]
		pos++
		size := leb()
		end := pos + size
		if id == 0 {
			save := pos
			nameLen := leb()
			name := string(wasm[pos : pos+nameLen])
			pos += nameLen
			if name == "weave.meta" {
				payload := wasm[pos:end]
				m, err := decodeMeta(payload)
				return m, payload, err
			}
			pos = save
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
	FtResumeOk   = 15
	FtAbort      = 16
	FtCtlMigrate = 17
	FtCtlStatus  = 18
	FtCtlOk      = 19
	FtCtlErr     = 20
)

type frame struct {
	typ     byte
	payload []byte
}

func writeFrame(w *bufio.Writer, typ byte, payload []byte) error {
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

func (w *wbuf) u8(v byte)      { w.WriteByte(v) }
func (w *wbuf) u16(v uint16)   { var b [2]byte; binary.LittleEndian.PutUint16(b[:], v); w.Write(b[:]) }
func (w *wbuf) u32(v uint32)   { var b [4]byte; binary.LittleEndian.PutUint32(b[:], v); w.Write(b[:]) }
func (w *wbuf) u64(v uint64)   { var b [8]byte; binary.LittleEndian.PutUint64(b[:], v); w.Write(b[:]) }
func (w *wbuf) str(s string)   { w.u32(uint32(len(s))); w.WriteString(s) }
func (w *wbuf) blob(b []byte)  { w.u32(uint32(len(b))); w.Write(b) }

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

// Service carries migratable host-function state. env.emit* match the Rust
// and JS runners byte-for-byte.
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

func NewInstance(ctx context.Context, wasm []byte, services []Service, emitLog func(string)) (*Instance, error) {
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

	mod, err := rt.Instantiate(ctx, wasm)
	if err != nil {
		return nil, fmt.Errorf("instantiating module: %w", err)
	}
	inst.module = mod
	return inst, nil
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
	_, err := in.module.ExportedFunction("__weave_init").Call(ctx)
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
	if _, err := in.module.ExportedFunction("__weave_resume").Call(ctx); err != nil {
		return false, err
	}
	return in.global(GFlag) == FlagUnwound, nil
}

// ReadResults reads the completed entry's results from the results area.
func (in *Instance) ReadResults() ([]string, error) {
	idx := int(in.global(GEntry))
	if idx >= len(in.meta.Entries) {
		return nil, fmt.Errorf("bad entry index")
	}
	e := in.meta.Entries[idx]
	rbase := uint32(in.global(GRbase))
	base := rbase + in.meta.GlobalsAreaSize
	var out []string
	for i, ty := range e.Results {
		off := base + uint32(i)*16
		b, ok := in.mem(0).Read(off, 16)
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
