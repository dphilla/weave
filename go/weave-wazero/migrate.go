// Source and target ends of a live migration for the wazero plugin.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"fmt"
	"net"
	"sort"
	"time"

	"github.com/tetratelabs/wazero"
)

const (
	maxModuleSize          = 256 << 20
	maxMigrationMemorySize = 1 << 30
	migrationIOTimeout     = 30 * time.Second
)

// deadlineConn applies a rolling deadline to every underlying socket
// operation. Unlike one absolute SetDeadline for a long pre-copy session,
// this permits steady progress while bounding a peer that stops reading or
// writing at any protocol phase.
type deadlineConn struct {
	net.Conn
	timeout time.Duration
}

func (c *deadlineConn) Read(p []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(c.timeout))
	return c.Conn.Read(p)
}

func (c *deadlineConn) Write(p []byte) (int, error) {
	_ = c.Conn.SetWriteDeadline(time.Now().Add(c.timeout))
	return c.Conn.Write(p)
}

func declaredInitialMemoryBytes(ctx context.Context, wasm []byte, meta *Meta) (uint64, error) {
	config := wazero.NewRuntimeConfigInterpreter().WithMemoryLimitPages(
		uint32(maxMigrationMemorySize / WasmPage),
	)
	runtime := wazero.NewRuntimeWithConfig(ctx, config)
	defer runtime.Close(ctx)
	compiled, err := runtime.CompileModule(ctx, wasm)
	if err != nil {
		return 0, fmt.Errorf("compiling module for memory policy: %w", err)
	}
	defer compiled.Close(ctx)

	total, err := validateCompiledABI(compiled, wasm, meta)
	if err != nil {
		return 0, fmt.Errorf("validating module ABI: %w", err)
	}
	if total > maxMigrationMemorySize {
		return 0, fmt.Errorf("declared initial memory exceeds %d-byte limit", maxMigrationMemorySize)
	}
	return total, nil
}

// ------------------------------------------------------------------ pages

type pageTracker struct {
	digests [][][16]byte // per mem, per page; zero value + never-sent flag
	sent    [][]bool
	cursorM int
	cursorP int
	round   int
}

func newTracker(nMems int) *pageTracker {
	return &pageTracker{
		digests: make([][][16]byte, nMems),
		sent:    make([][]bool, nMems),
	}
}

func allZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

type dirtyPage struct {
	mem    int
	pageNo uint64
	bytes  []byte
}

// scanStep scans up to budget bytes; returns dirty pages and whether the
// round completed.
func (t *pageTracker) scanStep(in *Instance, budget int) ([]dirtyPage, bool) {
	var out []dirtyPage
	scanned := 0
	n := len(in.meta.Memories)
	for {
		if t.cursorM >= n {
			t.cursorM, t.cursorP = 0, 0
			t.round++
			return out, true
		}
		m := in.mem(t.cursorM)
		nPages := int(m.Size()) / WPage
		for len(t.digests[t.cursorM]) < nPages {
			t.digests[t.cursorM] = append(t.digests[t.cursorM], [16]byte{})
			t.sent[t.cursorM] = append(t.sent[t.cursorM], false)
		}
		if t.cursorP >= nPages {
			t.cursorM++
			t.cursorP = 0
			continue
		}
		if scanned >= budget {
			return out, false
		}
		page, _ := m.Read(uint32(t.cursorP*WPage), WPage)
		scanned += WPage
		if !t.sent[t.cursorM][t.cursorP] && allZero(page) {
			// never sent and still zero: target agrees already
		} else {
			full := sha256.Sum256(page)
			var d [16]byte
			copy(d[:], full[:16])
			if !t.sent[t.cursorM][t.cursorP] || d != t.digests[t.cursorM][t.cursorP] {
				t.digests[t.cursorM][t.cursorP] = d
				t.sent[t.cursorM][t.cursorP] = true
				cp := make([]byte, WPage)
				copy(cp, page)
				out = append(out, dirtyPage{t.cursorM, uint64(t.cursorP), cp})
			}
		}
		t.cursorP++
	}
}

const finalScanBatchBytes = 64 * WPage

func (t *pageTracker) scanFull(in *Instance, emit func(dirtyPage) error) (int, error) {
	dirty := 0
	for {
		pages, done := t.scanStep(in, finalScanBatchBytes)
		for _, page := range pages {
			if err := emit(page); err != nil {
				return dirty, err
			}
			dirty++
		}
		if done {
			return dirty, nil
		}
	}
}

// ------------------------------------------------------------------ source

type sourceOpts struct {
	budgetBytes    int
	dirtyThreshold int
	maxRounds      int
}

type sourceMigration struct {
	r          *bufio.Reader
	w          *bufio.Writer
	conn       net.Conn
	inst       *Instance
	tracker    *pageTracker
	sentLayout []uint64
	roundPages int
	rounds     int
	totalPages int
	opts       sourceOpts
	converged  bool
}

func (s *sourceMigration) abort(code uint32, message string) {
	defer s.conn.Close()
	var payload wbuf
	payload.u32(code)
	payload.str(message)
	_ = writeFrame(s.w, FtAbort, payload.Bytes())
	_ = s.w.Flush()
}

func connectSource(target string, inst *Instance, runtime string, opts sourceOpts) (*sourceMigration, error) {
	rawConn, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		return nil, err
	}
	if tc, ok := rawConn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	conn := &deadlineConn{Conn: rawConn, timeout: migrationIOTimeout}
	keep := false
	defer func() {
		if !keep {
			_ = conn.Close()
		}
	}()
	s := &sourceMigration{
		r:       bufio.NewReader(conn),
		w:       bufio.NewWriter(conn),
		conn:    conn,
		inst:    inst,
		tracker: newTracker(len(inst.meta.Memories)),
		opts:    opts,
	}
	var hp wbuf
	hp.u8(ProtoVersion)
	hp.u8(1)
	hp.str(runtime)
	if err := writeFrame(s.w, FtHello, hp.Bytes()); err != nil {
		return nil, err
	}
	if err := s.w.Flush(); err != nil {
		return nil, err
	}
	f, err := readFrameR(s.r)
	if err != nil {
		return nil, err
	}
	if f.typ != FtHello {
		return nil, peerAbort(f)
	}
	hc := &cursor{b: f.payload}
	proto, role := hc.u8(), hc.u8()
	_ = hc.str()
	if err := hc.done(); err != nil {
		return nil, fmt.Errorf("invalid target HELLO: %w", err)
	}
	if proto != ProtoVersion || role != 2 {
		return nil, fmt.Errorf("invalid target HELLO: protocol=%d role=%d", proto, role)
	}
	// module sync
	var mp wbuf
	mp.Write(inst.hash[:])
	mp.u64(uint64(len(inst.wasm)))
	mp.blob(inst.metaRaw)
	if err := writeFrame(s.w, FtModuleMeta, mp.Bytes()); err != nil {
		return nil, err
	}
	if err := s.w.Flush(); err != nil {
		return nil, err
	}
	f, err = readFrameR(s.r)
	if err != nil {
		return nil, err
	}
	switch f.typ {
	case FtModuleHave:
	case FtModuleNeed:
		const chunk = 256 * 1024
		for off := 0; off < len(inst.wasm); off += chunk {
			end := off + chunk
			if end > len(inst.wasm) {
				end = len(inst.wasm)
			}
			var dp wbuf
			dp.u64(uint64(off))
			dp.Write(inst.wasm[off:end])
			if err := writeFrame(s.w, FtModuleData, dp.Bytes()); err != nil {
				return nil, err
			}
		}
		if err := s.w.Flush(); err != nil {
			return nil, err
		}
	default:
		return nil, peerAbort(f)
	}
	f, err = readFrameR(s.r)
	if err != nil {
		return nil, err
	}
	if f.typ != FtModuleOk {
		return nil, peerAbort(f)
	}
	keep = true
	return s, nil
}

func (s *sourceMigration) syncLayout() error {
	cur := make([]uint64, len(s.inst.meta.Memories))
	for i := range cur {
		cur[i] = uint64(s.inst.mem(i).Size()) / WasmPage
	}
	same := len(cur) == len(s.sentLayout)
	if same {
		for i := range cur {
			if cur[i] != s.sentLayout[i] {
				same = false
				break
			}
		}
	}
	if !same {
		var p wbuf
		p.u8(byte(len(cur)))
		for _, v := range cur {
			p.u64(v)
		}
		if err := writeFrame(s.w, FtMemLayout, p.Bytes()); err != nil {
			return err
		}
		s.sentLayout = cur
	}
	return nil
}

// precopyStep: returns true when converged (time to unwind).
func (s *sourceMigration) precopyStep() (bool, error) {
	if s.converged {
		return true, nil
	}
	if err := s.syncLayout(); err != nil {
		return false, err
	}
	pages, roundDone := s.tracker.scanStep(s.inst, s.opts.budgetBytes)
	for _, p := range pages {
		s.roundPages++
		s.totalPages++
		var pp wbuf
		pp.u8(byte(p.mem))
		pp.u64(p.pageNo)
		pp.Write(p.bytes)
		if err := writeFrame(s.w, FtPage, pp.Bytes()); err != nil {
			return false, err
		}
	}
	if err := s.w.Flush(); err != nil {
		return false, err
	}
	if roundDone {
		s.rounds++
		var rp wbuf
		rp.u32(uint32(s.rounds))
		rp.u64(uint64(s.roundPages))
		if err := writeFrame(s.w, FtRoundEnd, rp.Bytes()); err != nil {
			return false, err
		}
		if err := s.w.Flush(); err != nil {
			return false, err
		}
		f, err := readFrameR(s.r)
		if err != nil {
			return false, err
		}
		if f.typ != FtRoundAck {
			return false, peerAbort(f)
		}
		done := s.roundPages <= s.opts.dirtyThreshold || s.rounds >= s.opts.maxRounds
		s.roundPages = 0
		if done {
			s.converged = true
			return true, nil
		}
	}
	return false, nil
}

type migrationStats struct {
	rounds          int
	totalPages      int
	finalPages      int
	commitConfirmed bool
	commitError     string
}

func (s migrationStats) String() string {
	return fmt.Sprintf("%d rounds, %d pages total, %d in pause window",
		s.rounds, s.totalPages, s.finalPages)
}

func (s *sourceMigration) finish() (migrationStats, error) {
	defer s.conn.Close()
	if err := writeFrame(s.w, FtFinalBegin, nil); err != nil {
		return migrationStats{}, err
	}
	if err := s.syncLayout(); err != nil {
		return migrationStats{}, err
	}
	finalPages, err := s.tracker.scanFull(s.inst, func(p dirtyPage) error {
		s.totalPages++
		var pp wbuf
		pp.u8(byte(p.mem))
		pp.u64(p.pageNo)
		pp.Write(p.bytes)
		return writeFrame(s.w, FtPage, pp.Bytes())
	})
	if err != nil {
		return migrationStats{}, err
	}
	globals := s.inst.captureGlobals()
	var gp wbuf
	gp.u16(uint16(len(globals)))
	for _, g := range globals {
		gp.str(g[0].(string))
		gp.u32(uint32(g[1].(int32)))
	}
	if err := writeFrame(s.w, FtGlobals, gp.Bytes()); err != nil {
		return migrationStats{}, err
	}
	services := snapshotServices(s.inst.services)
	var sp wbuf
	sp.u16(uint16(len(services)))
	for _, sv := range services {
		sp.str(sv[0].(string))
		sp.blob(sv[1].([]byte))
	}
	if err := writeFrame(s.w, FtServices, sp.Bytes()); err != nil {
		return migrationStats{}, err
	}
	hash := s.inst.stateHash(globals, services)
	if err := writeFrame(s.w, FtFinalEnd, hash[:]); err != nil {
		return migrationStats{}, err
	}
	if err := s.w.Flush(); err != nil {
		return migrationStats{}, err
	}
	f, err := readFrameR(s.r)
	if err != nil {
		return migrationStats{}, err
	}
	if f.typ != FtPrepared || len(f.payload) != 0 {
		return migrationStats{}, peerAbort(f)
	}

	// PREPARED is irreversible for the source. Any error below is an
	// unconfirmed commit, never permission to resume the local instance.
	stats := migrationStats{
		rounds:     s.rounds,
		totalPages: s.totalPages,
		finalPages: finalPages,
	}
	return s.commitPrepared(stats), nil
}

func (s *sourceMigration) commitPrepared(stats migrationStats) migrationStats {
	_ = s.conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	if err := writeFrame(s.w, FtCommit, nil); err != nil {
		stats.commitError = fmt.Sprintf("sending COMMIT failed: %v", err)
		return stats
	}
	if err := s.w.Flush(); err != nil {
		stats.commitError = fmt.Sprintf("flushing COMMIT failed: %v", err)
		return stats
	}
	_ = s.conn.SetReadDeadline(time.Now().Add(30 * time.Second))
	f, err := readFrameR(s.r)
	if err != nil {
		stats.commitError = fmt.Sprintf("waiting for COMMIT_OK failed: %v", err)
		return stats
	}
	if f.typ == FtCommitOk && len(f.payload) == 0 {
		stats.commitConfirmed = true
	} else {
		stats.commitError = fmt.Sprintf("expected COMMIT_OK, got frame %d", f.typ)
	}
	return stats
}

// ------------------------------------------------------------------ target

// acceptMigration drives the target side over an accepted connection, using
// makeInstance to build the received instance (without running __weave_init).
func acceptMigration(
	ctx context.Context,
	conn net.Conn,
	makeInstance func(wasm []byte) (*Instance, error),
	moduleCache map[[32]byte][]byte,
) (*Instance, string, error) {
	conn = &deadlineConn{Conn: conn, timeout: migrationIOTimeout}
	connectionOwned := true
	defer func() {
		if connectionOwned {
			_ = conn.Close()
		}
	}()
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	f, err := readFrameR(r)
	if err != nil {
		return nil, "", err
	}
	if f.typ != FtHello {
		return nil, "", fmt.Errorf("expected HELLO")
	}
	hc := &cursor{b: f.payload}
	v, role := hc.u8(), hc.u8()
	sourceRuntime := hc.str()
	if err := hc.done(); err != nil {
		abortFrame(w, 1, "malformed HELLO")
		return nil, "", fmt.Errorf("malformed source HELLO: %w", err)
	}
	if v != ProtoVersion {
		abortFrame(w, 1, "bad protocol")
		return nil, "", fmt.Errorf("source protocol %d", v)
	}
	if role != 1 {
		abortFrame(w, 1, "bad source role")
		return nil, "", fmt.Errorf("source role %d", role)
	}
	var hp wbuf
	hp.u8(ProtoVersion)
	hp.u8(2)
	hp.str("wazero")
	writeFrame(w, FtHello, hp.Bytes())
	w.Flush()

	f, err = readFrameR(r)
	if err != nil {
		return nil, "", err
	}
	if f.typ != FtModuleMeta {
		return nil, "", fmt.Errorf("expected MODULE_META")
	}
	mc := &cursor{b: f.payload}
	var hash [32]byte
	copy(hash[:], mc.take(32))
	size := mc.u64()
	offeredMeta := mc.blob()
	if err := mc.done(); err != nil {
		abortFrame(w, 2, "malformed module offer")
		return nil, "", fmt.Errorf("malformed MODULE_META: %w", err)
	}
	if size > maxModuleSize {
		abortFrame(w, 2, "module too large")
		return nil, "", fmt.Errorf("module size %d exceeds %d-byte limit", size, maxModuleSize)
	}

	wasm, have := moduleCache[hash]
	if have {
		writeFrame(w, FtModuleHave, nil)
		w.Flush()
	} else {
		writeFrame(w, FtModuleNeed, nil)
		w.Flush()
		wasm = make([]byte, size)
		var got uint64
		for got < size {
			df, err := readFrameR(r)
			if err != nil {
				return nil, "", err
			}
			if df.typ != FtModuleData {
				return nil, "", fmt.Errorf("expected MODULE_DATA")
			}
			dc := &cursor{b: df.payload}
			off := dc.u64()
			chunk := dc.take(len(df.payload) - dc.pos)
			if dc.err != nil || len(chunk) == 0 || off != got ||
				uint64(len(chunk)) > size-off {
				abortFrame(w, 2, "invalid module chunk")
				return nil, "", fmt.Errorf("invalid MODULE_DATA at offset %d", off)
			}
			copy(wasm[int(off):], chunk)
			got += uint64(len(chunk))
		}
		if sha256.Sum256(wasm) != hash {
			abortFrame(w, 2, "module hash mismatch")
			return nil, "", fmt.Errorf("module hash mismatch")
		}
		moduleCache[hash] = wasm
	}
	moduleMeta, actualMeta, err := extractMeta(wasm)
	if err != nil || !bytes.Equal(actualMeta, offeredMeta) {
		abortFrame(w, 2, "module metadata mismatch")
		if err != nil {
			return nil, "", fmt.Errorf("reading received module metadata: %w", err)
		}
		return nil, "", fmt.Errorf("offered metadata does not match module")
	}
	if _, err := declaredInitialMemoryBytes(ctx, wasm, moduleMeta); err != nil {
		abortFrame(w, 3, "module exceeds target memory policy")
		return nil, "", err
	}

	inst, err := makeInstance(wasm)
	if err != nil {
		abortFrame(w, 3, fmt.Sprintf("instantiation failed: %v", err))
		return nil, "", err
	}
	keepInstance := false
	defer func() {
		if !keepInstance {
			_ = inst.Close(ctx)
		}
	}()
	// Page tracking omits never-seen all-zero pages. Clear active data-segment
	// bytes so the receiving instance has that required zero baseline.
	for i := range inst.meta.Memories {
		memory := inst.mem(i)
		data, ok := memory.Read(0, memory.Size())
		if !ok {
			abortFrame(w, 3, "cannot initialize target memory")
			return nil, "", fmt.Errorf("cannot read target memory %d", i)
		}
		clear(data)
	}
	writeFrame(w, FtModuleOk, nil)
	w.Flush()

	var globals [][2]interface{}
	var services [][2]interface{}
	const (
		phasePrecopy = iota
		phaseFinalPages
		phaseFinalGlobals
		phaseFinalServices
	)
	phase := phasePrecopy
	layout := make([]uint64, len(inst.meta.Memories))
	layoutSeen := false
	expectedRound := uint32(1)
	var roundPages uint64
	type pageKey struct {
		memory int
		page   uint64
	}
	pagesSeen := make(map[pageKey]struct{})
	for {
		f, err := readFrameR(r)
		if err != nil {
			return nil, "", err
		}
		switch f.typ {
		case FtMemLayout:
			if phase != phasePrecopy && phase != phaseFinalPages {
				abortFrame(w, 5, "MEM_LAYOUT after final globals")
				return nil, "", fmt.Errorf("MEM_LAYOUT after final globals")
			}
			c := &cursor{b: f.payload}
			n := int(c.u8())
			if n != len(inst.meta.Memories) {
				return nil, "", fmt.Errorf("memory count mismatch: got %d, want %d", n, len(inst.meta.Memories))
			}
			nextLayout := make([]uint64, n)
			var totalBytes uint64
			for m := 0; m < n; m++ {
				pages := c.u64()
				if pages > ^uint64(0)/WasmPage {
					abortFrame(w, 5, "memory layout overflows byte count")
					return nil, "", fmt.Errorf("memory %d layout overflows byte count", m)
				}
				bytes := pages * WasmPage
				if bytes > maxMigrationMemorySize || totalBytes > maxMigrationMemorySize-bytes {
					abortFrame(w, 5, "memory layout exceeds target limit")
					return nil, "", fmt.Errorf("announced memory layout exceeds %d-byte limit", maxMigrationMemorySize)
				}
				totalBytes += pages * WasmPage
				if pages < layout[m] {
					abortFrame(w, 5, "memory layout cannot shrink")
					return nil, "", fmt.Errorf("memory %d layout shrank from %d to %d pages", m, layout[m], pages)
				}
				nextLayout[m] = pages
			}
			if err := c.done(); err != nil {
				return nil, "", fmt.Errorf("malformed MEM_LAYOUT: %w", err)
			}
			for m, pages := range nextLayout {
				mem := inst.mem(m)
				cur := uint64(mem.Size()) / WasmPage
				if pages > cur {
					if _, ok := mem.Grow(uint32(pages - cur)); !ok {
						abortFrame(w, 5, "memory growth failed")
						return nil, "", fmt.Errorf("growing memory %d from %d to %d pages", m, cur, pages)
					}
				}
			}
			layout = nextLayout
			layoutSeen = true
		case FtPage:
			if phase != phasePrecopy && phase != phaseFinalPages {
				abortFrame(w, 5, "PAGE after final globals")
				return nil, "", fmt.Errorf("PAGE after final globals")
			}
			c := &cursor{b: f.payload}
			m := int(c.u8())
			pageNo := c.u64()
			bytes_ := c.take(WPage)
			if err := c.done(); err != nil {
				return nil, "", fmt.Errorf("malformed PAGE: %w", err)
			}
			if !layoutSeen || m < 0 || m >= len(layout) || pageNo >= layout[m]*WasmPage/WPage {
				abortFrame(w, 5, "PAGE outside advertised memory layout")
				return nil, "", fmt.Errorf("PAGE outside advertised memory layout")
			}
			key := pageKey{memory: m, page: pageNo}
			if _, duplicate := pagesSeen[key]; duplicate {
				abortFrame(w, 5, "duplicate PAGE in migration round")
				return nil, "", fmt.Errorf("duplicate PAGE for memory %d page %d", m, pageNo)
			}
			pagesSeen[key] = struct{}{}
			mem := inst.mem(m)
			off := uint32(pageNo) * WPage
			if !mem.Write(off, bytes_) {
				abortFrame(w, 5, "page write out of bounds")
				return nil, "", fmt.Errorf("page write out of bounds")
			}
			if phase == phasePrecopy {
				roundPages++
			}
		case FtRoundEnd:
			if phase != phasePrecopy {
				abortFrame(w, 5, "ROUND_END during final transfer")
				return nil, "", fmt.Errorf("ROUND_END during final transfer")
			}
			c := &cursor{b: f.payload}
			round := c.u32()
			pagesSent := c.u64()
			if err := c.done(); err != nil {
				abortFrame(w, 5, "malformed ROUND_END")
				return nil, "", fmt.Errorf("malformed ROUND_END: %w", err)
			}
			if round != expectedRound || pagesSent != roundPages {
				abortFrame(w, 5, "invalid round terminator")
				return nil, "", fmt.Errorf(
					"invalid round terminator: expected round %d with %d pages, got round %d with %d",
					expectedRound, roundPages, round, pagesSent,
				)
			}
			writeFrame(w, FtRoundAck, nil)
			w.Flush()
			expectedRound++
			roundPages = 0
			pagesSeen = make(map[pageKey]struct{})
		case FtFinalBegin:
			if phase != phasePrecopy || roundPages != 0 || len(f.payload) != 0 {
				abortFrame(w, 5, "FINAL_BEGIN inside an incomplete round")
				return nil, "", fmt.Errorf("FINAL_BEGIN inside an incomplete round")
			}
			phase = phaseFinalPages
			pagesSeen = make(map[pageKey]struct{})
		case FtGlobals:
			if phase != phaseFinalPages {
				abortFrame(w, 5, "GLOBALS out of order")
				return nil, "", fmt.Errorf("GLOBALS out of order")
			}
			c := &cursor{b: f.payload}
			n := int(c.u16())
			if n != len(inst.meta.ControlGlobals) {
				return nil, "", fmt.Errorf("control-global count mismatch")
			}
			globals = nil
			for i := 0; i < n; i++ {
				name := c.str()
				v := int32(c.u32())
				if name != inst.meta.ControlGlobals[i] {
					return nil, "", fmt.Errorf("control-global mismatch at index %d", i)
				}
				globals = append(globals, [2]interface{}{name, v})
			}
			if err := c.done(); err != nil {
				return nil, "", fmt.Errorf("malformed GLOBALS: %w", err)
			}
			phase = phaseFinalGlobals
		case FtServices:
			if phase != phaseFinalGlobals {
				abortFrame(w, 5, "SERVICES out of order")
				return nil, "", fmt.Errorf("SERVICES out of order")
			}
			c := &cursor{b: f.payload}
			n := int(c.u16())
			services = nil
			for i := 0; i < n; i++ {
				name := c.str()
				blob := c.blob()
				services = append(services, [2]interface{}{name, blob})
			}
			if err := c.done(); err != nil {
				return nil, "", fmt.Errorf("malformed SERVICES: %w", err)
			}
			expected := make([]string, len(inst.services))
			for i, svc := range inst.services {
				expected[i] = svc.Name()
			}
			sort.Strings(expected)
			if len(services) != len(expected) {
				return nil, "", fmt.Errorf("host-service count mismatch")
			}
			for i, name := range expected {
				if services[i][0].(string) != name {
					return nil, "", fmt.Errorf("host-service mismatch at index %d", i)
				}
			}
			phase = phaseFinalServices
		case FtFinalEnd:
			if phase != phaseFinalServices || len(f.payload) != sha256.Size {
				abortFrame(w, 5, "incomplete or malformed final state")
				return nil, "", fmt.Errorf("incomplete or malformed final state")
			}
			ours := inst.stateHash(globals, services)
			if !bytes.Equal(ours[:], f.payload) {
				abortFrame(w, 4, "state hash mismatch")
				return nil, "", fmt.Errorf("migrated state hash mismatch")
			}
			for _, g := range globals {
				if err := inst.setGlobal(g[0].(string), g[1].(int32)); err != nil {
					abortFrame(w, 5, "control-global restore failed")
					return nil, "", err
				}
			}
			byName := make(map[string]Service, len(inst.services))
			for _, svc := range inst.services {
				byName[svc.Name()] = svc
			}
			for _, sv := range services {
				if err := byName[sv[0].(string)].Restore(sv[1].([]byte)); err != nil {
					abortFrame(w, 5, "service restore failed")
					return nil, "", err
				}
			}
			if err := writeFrame(w, FtPrepared, nil); err != nil {
				return nil, "", err
			}
			if err := w.Flush(); err != nil {
				return nil, "", err
			}
			_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
			commit, err := readFrameR(r)
			if err != nil {
				return nil, "", err
			}
			if commit.typ != FtCommit || len(commit.payload) != 0 {
				abortFrame(w, 5, "expected COMMIT")
				return nil, "", fmt.Errorf("expected COMMIT, got frame %d", commit.typ)
			}
			// COMMIT transfers ownership even if its acknowledgement is lost.
			// ACK delivery is best-effort and must not keep the sole owner paused.
			connectionOwned = false
			go func() {
				defer conn.Close()
				_ = writeFrame(w, FtCommitOk, nil)
				_ = w.Flush()
			}()
			keepInstance = true
			return inst, sourceRuntime, nil
		case FtAbort:
			return nil, "", peerAbort(f)
		default:
			return nil, "", fmt.Errorf("unexpected frame %d", f.typ)
		}
	}
}
