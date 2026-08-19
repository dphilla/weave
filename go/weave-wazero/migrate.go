// Source and target ends of a live migration for the wazero plugin.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"net"
)

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

func (t *pageTracker) scanFull(in *Instance) []dirtyPage {
	var all []dirtyPage
	for {
		pages, done := t.scanStep(in, 1<<62)
		all = append(all, pages...)
		if done {
			return all
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

func connectSource(target string, inst *Instance, runtime string, opts sourceOpts) (*sourceMigration, error) {
	conn, err := net.Dial("tcp", target)
	if err != nil {
		return nil, err
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
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
	s.w.Flush()
	f, err := readFrameR(s.r)
	if err != nil {
		return nil, err
	}
	if f.typ != FtHello {
		return nil, peerAbort(f)
	}
	// module sync
	var mp wbuf
	mp.Write(inst.hash[:])
	mp.u64(uint64(len(inst.wasm)))
	mp.blob(inst.metaRaw)
	writeFrame(s.w, FtModuleMeta, mp.Bytes())
	s.w.Flush()
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
			writeFrame(s.w, FtModuleData, dp.Bytes())
		}
		s.w.Flush()
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
		writeFrame(s.w, FtRoundEnd, rp.Bytes())
		s.w.Flush()
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

func (s *sourceMigration) finish() (string, error) {
	writeFrame(s.w, FtFinalBegin, nil)
	if err := s.syncLayout(); err != nil {
		return "", err
	}
	finalPages := s.tracker.scanFull(s.inst)
	for _, p := range finalPages {
		s.totalPages++
		var pp wbuf
		pp.u8(byte(p.mem))
		pp.u64(p.pageNo)
		pp.Write(p.bytes)
		writeFrame(s.w, FtPage, pp.Bytes())
	}
	globals := s.inst.captureGlobals()
	var gp wbuf
	gp.u16(uint16(len(globals)))
	for _, g := range globals {
		gp.str(g[0].(string))
		gp.u32(uint32(g[1].(int32)))
	}
	writeFrame(s.w, FtGlobals, gp.Bytes())
	services := snapshotServices(s.inst.services)
	var sp wbuf
	sp.u16(uint16(len(services)))
	for _, sv := range services {
		sp.str(sv[0].(string))
		sp.blob(sv[1].([]byte))
	}
	writeFrame(s.w, FtServices, sp.Bytes())
	hash := s.inst.stateHash(globals, services)
	writeFrame(s.w, FtFinalEnd, hash[:])
	s.w.Flush()
	f, err := readFrameR(s.r)
	if err != nil {
		return "", err
	}
	if f.typ != FtResumeOk {
		return "", peerAbort(f)
	}
	return fmt.Sprintf("%d rounds, %d pages total, %d in pause window",
		s.rounds, s.totalPages, len(finalPages)), nil
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
	if v := hc.u8(); v != ProtoVersion {
		abortFrame(w, 1, "bad protocol")
		return nil, "", fmt.Errorf("source protocol %d", v)
	}
	hc.u8()
	sourceRuntime := hc.str()
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
	copy(hash[:], mc.b[:32])
	mc.pos = 32
	size := mc.u64()

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
			off := binary.LittleEndian.Uint64(df.payload)
			chunk := df.payload[8:]
			copy(wasm[off:], chunk)
			got += uint64(len(chunk))
		}
		if sha256.Sum256(wasm) != hash {
			abortFrame(w, 2, "module hash mismatch")
			return nil, "", fmt.Errorf("module hash mismatch")
		}
		moduleCache[hash] = wasm
	}

	inst, err := makeInstance(wasm)
	if err != nil {
		abortFrame(w, 3, fmt.Sprintf("instantiation failed: %v", err))
		return nil, "", err
	}
	writeFrame(w, FtModuleOk, nil)
	w.Flush()

	var globals [][2]interface{}
	var services [][2]interface{}
	for {
		f, err := readFrameR(r)
		if err != nil {
			return nil, "", err
		}
		switch f.typ {
		case FtMemLayout:
			c := &cursor{b: f.payload}
			n := int(c.u8())
			for m := 0; m < n; m++ {
				pages := c.u64()
				mem := inst.mem(m)
				cur := uint64(mem.Size()) / WasmPage
				if pages > cur {
					mem.Grow(uint32(pages - cur))
				}
			}
		case FtPage:
			c := &cursor{b: f.payload}
			m := int(c.u8())
			pageNo := c.u64()
			bytes_ := f.payload[9:]
			mem := inst.mem(m)
			off := uint32(pageNo) * WPage
			if !mem.Write(off, bytes_) {
				return nil, "", fmt.Errorf("page write out of bounds")
			}
		case FtRoundEnd:
			writeFrame(w, FtRoundAck, nil)
			w.Flush()
		case FtFinalBegin:
		case FtGlobals:
			c := &cursor{b: f.payload}
			n := int(c.u16())
			globals = nil
			for i := 0; i < n; i++ {
				name := c.str()
				v := int32(c.u32())
				globals = append(globals, [2]interface{}{name, v})
			}
		case FtServices:
			c := &cursor{b: f.payload}
			n := int(c.u16())
			services = nil
			for i := 0; i < n; i++ {
				name := c.str()
				blob := make([]byte, c.u32())
				copy(blob, c.b[c.pos:c.pos+len(blob)])
				c.pos += len(blob)
				services = append(services, [2]interface{}{name, blob})
			}
		case FtFinalEnd:
			for _, g := range globals {
				if err := inst.setGlobal(g[0].(string), g[1].(int32)); err != nil {
					return nil, "", err
				}
			}
			byName := map[string]Service{}
			for _, s := range inst.services {
				byName[s.Name()] = s
			}
			for _, sv := range services {
				if s, ok := byName[sv[0].(string)]; ok {
					if err := s.Restore(sv[1].([]byte)); err != nil {
						return nil, "", err
					}
				}
			}
			ours := inst.stateHash(globals, services)
			if !bytes.Equal(ours[:], f.payload) {
				abortFrame(w, 4, "state hash mismatch")
				return nil, "", fmt.Errorf("migrated state hash mismatch")
			}
			writeFrame(w, FtResumeOk, nil)
			w.Flush()
			return inst, sourceRuntime, nil
		case FtAbort:
			return nil, "", peerAbort(f)
		default:
			return nil, "", fmt.Errorf("unexpected frame %d", f.typ)
		}
	}
}
