// weave-wazero: Weave node runner on the wazero runtime (pure Go).
//
//	weave-wazero run --module M.wasm --invoke NAME [--arg V]...
//	weave-wazero serve --listen HOST:PORT [--module M --invoke NAME [--arg V]...] [--exit-on-done]
//	weave-wazero migrate --node HOST:PORT --to HOST:PORT
//	weave-wazero status --node HOST:PORT
//
// Speaks the same wire protocol as the wasmtime and Node runners.
package main

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type flags struct {
	vals map[string]string
	args []string
	set  map[string]bool
}

func parseFlags(argv []string) *flags {
	f := &flags{vals: map[string]string{}, set: map[string]bool{}}
	valueFlags := map[string]bool{
		"module": true, "invoke": true, "arg": true, "listen": true,
		"node": true, "to": true, "budget": true, "max-rounds": true,
		"dirty-threshold": true,
	}
	for i := 0; i < len(argv); i++ {
		a := argv[i]
		if strings.HasPrefix(a, "--") {
			name := a[2:]
			f.set[name] = true
			if valueFlags[name] && i+1 < len(argv) {
				i++
				if name == "arg" {
					f.args = append(f.args, argv[i])
				} else {
					f.vals[name] = argv[i]
				}
			}
		}
	}
	return f
}

func makeServices() []Service {
	return []Service{
		&emitSvc{name: "env.emit", st: &emitState{}},
		&emitSvc{name: "env.emit32", st: &emitState{}},
		&emitSvc{name: "env.emit64", st: &emitState{}},
	}
}

func entryArgs(meta *Meta, entry string, raw []string) ([]uint64, int, error) {
	for _, e := range meta.Entries {
		if e.Name != entry {
			continue
		}
		if len(e.Params) != len(raw) {
			return nil, 0, fmt.Errorf("entry %s takes %d args, got %d", entry, len(e.Params), len(raw))
		}
		out := make([]uint64, len(raw))
		for i, ty := range e.Params {
			switch ty {
			case 0:
				v, err := strconv.ParseInt(raw[i], 10, 32)
				if err != nil {
					return nil, 0, err
				}
				out[i] = uint64(uint32(int32(v)))
			case 1:
				v, err := strconv.ParseInt(raw[i], 10, 64)
				if err != nil {
					return nil, 0, err
				}
				out[i] = uint64(v)
			default:
				return nil, 0, fmt.Errorf("unsupported CLI param type %d", ty)
			}
		}
		return out, len(e.Results), nil
	}
	return nil, 0, fmt.Errorf("module has no entry %s", entry)
}

func printDone(inst *Instance) {
	res, err := inst.ReadResults()
	if err != nil {
		fmt.Fprintf(os.Stderr, "weave: reading results: %v\n", err)
		return
	}
	fmt.Printf("WEAVE_DONE [%s]\n", strings.Join(res, ", "))
}

func cmdRun(f *flags) error {
	ctx := context.Background()
	wasm, err := os.ReadFile(f.vals["module"])
	if err != nil {
		return err
	}
	inst, err := NewInstance(ctx, wasm, makeServices(), func(s string) { fmt.Println(s) })
	if err != nil {
		return err
	}
	if err := inst.Init(ctx); err != nil {
		return err
	}
	args, _, err := entryArgs(inst.meta, f.vals["invoke"], f.args)
	if err != nil {
		return err
	}
	unwound, err := inst.CallEntry(ctx, f.vals["invoke"], args)
	if err != nil {
		return err
	}
	if unwound {
		return fmt.Errorf("workload unwound without a migration in flight")
	}
	printDone(inst)
	return nil
}

type shared struct {
	mu               sync.Mutex
	request          *migrationRequest
	lastResult       string
	active           bool
	incomingReserved bool
}

type migrationRequest struct {
	target string
	result chan string
}

func (s *shared) completeRequestLocked(result string) {
	s.lastResult = result
	if s.request != nil {
		s.request.result <- result
		s.request = nil
	}
}

func cmdServe(f *flags) error {
	ctx := context.Background()
	listen := f.vals["listen"]
	exitOnDone := f.set["exit-on-done"]
	opts := sourceOpts{budgetBytes: 8 << 20, dirtyThreshold: 64, maxRounds: 10}
	if v, ok := f.vals["budget"]; ok {
		opts.budgetBytes, _ = strconv.Atoi(v)
	}
	if v, ok := f.vals["max-rounds"]; ok {
		opts.maxRounds, _ = strconv.Atoi(v)
	}
	if v, ok := f.vals["dirty-threshold"]; ok {
		opts.dirtyThreshold, _ = strconv.Atoi(v)
	}
	_, startsActive := f.vals["module"]
	sh := &shared{active: startsActive}
	moduleCache := map[[32]byte][]byte{}
	incoming := make(chan net.Conn, 1)

	ln, err := net.Listen("tcp", listen)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "weave: listening on %s (wazero)\n", listen)

	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go classifyConn(conn, sh, incoming)
		}
	}()

	// driveWorkload runs a workload to done/migrated. Returns "done"|"migrated".
	driveWorkload := func(inst *Instance, entry string, args []uint64, resume bool) string {
		defer inst.Close(ctx)
		var mig *sourceMigration
		// poll: check for migration requests; drive pre-copy.
		inst.pollMode = func() int32 {
			if mig == nil {
				sh.mu.Lock()
				target := ""
				if sh.request != nil {
					target = sh.request.target
				}
				sh.mu.Unlock()
				if target != "" {
					m, err := connectSource(target, inst, "wazero", opts)
					if err != nil {
						sh.mu.Lock()
						sh.completeRequestLocked(fmt.Sprintf("migration failed to start: %v", err))
						sh.mu.Unlock()
					} else {
						mig = m
					}
				}
			}
			if mig != nil {
				ready, err := mig.precopyStep()
				if err != nil {
					_ = mig.conn.Close()
					sh.mu.Lock()
					sh.completeRequestLocked(fmt.Sprintf("migration failed: %v", err))
					sh.mu.Unlock()
					mig = nil
					return 0
				}
				if ready {
					return 1
				}
			}
			return 0
		}
		var unwound bool
		var err error
		if resume {
			unwound, err = inst.Resume(ctx)
		} else {
			unwound, err = inst.CallEntry(ctx, entry, args)
		}
		if err != nil {
			if mig != nil {
				mig.abort(10, "workload trapped before checkpoint")
			}
			fmt.Fprintf(os.Stderr, "weave: workload trapped: %v\n", err)
			sh.mu.Lock()
			sh.active = false
			sh.completeRequestLocked(fmt.Sprintf("trap: %v", err))
			sh.mu.Unlock()
			return "done"
		}
		for unwound {
			if mig == nil {
				fmt.Fprintln(os.Stderr, "weave: unwound outside migration; resuming")
			} else {
				stats, err := mig.finish()
				if err == nil {
					msg := "migrated: " + stats.String()
					marker := "WEAVE_MIGRATED"
					if !stats.commitConfirmed {
						msg = "commit uncertain: " + stats.String() + "; COMMIT_OK unconfirmed (source retired)"
						marker = "WEAVE_MIGRATED_UNCONFIRMED"
						fmt.Fprintf(os.Stderr, "weave: %s\n", stats.commitError)
					}
					fmt.Fprintf(os.Stderr, "weave: %s\n", msg)
					fmt.Println(marker)
					sh.mu.Lock()
					sh.active = false
					sh.completeRequestLocked(msg)
					sh.mu.Unlock()
					return "migrated"
				}
				fmt.Fprintf(os.Stderr, "weave: final copy failed (%v), resuming locally\n", err)
				sh.mu.Lock()
				sh.completeRequestLocked(fmt.Sprintf("migration failed: %v", err))
				sh.mu.Unlock()
				mig = nil
			}
			unwound, err = inst.Resume(ctx)
			if err != nil {
				if mig != nil {
					mig.abort(10, "workload trapped while resuming")
				}
				fmt.Fprintf(os.Stderr, "weave: workload trapped: %v\n", err)
				sh.mu.Lock()
				sh.active = false
				sh.completeRequestLocked(fmt.Sprintf("trap: %v", err))
				sh.mu.Unlock()
				return "done"
			}
		}
		if mig != nil {
			mig.abort(10, "workload completed before checkpoint")
			mig = nil
		}
		res, err := inst.ReadResults()
		if err != nil {
			fmt.Fprintf(os.Stderr, "weave: reading workload results failed: %v\n", err)
			sh.mu.Lock()
			sh.active = false
			sh.completeRequestLocked(fmt.Sprintf("trap: reading results: %v", err))
			sh.mu.Unlock()
			return "done"
		}
		msg := fmt.Sprintf("done: [%s]", strings.Join(res, ", "))
		fmt.Printf("WEAVE_DONE [%s]\n", strings.Join(res, ", "))
		sh.mu.Lock()
		sh.active = false
		sh.completeRequestLocked(msg)
		sh.mu.Unlock()
		return "done"
	}

	maybeExit := func() {
		if exitOnDone {
			time.Sleep(150 * time.Millisecond)
			os.Exit(0)
		}
	}

	if path, ok := f.vals["module"]; ok {
		wasm, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		inst, err := NewInstance(ctx, wasm, makeServices(), func(s string) { fmt.Println(s) })
		if err != nil {
			return err
		}
		if err := inst.Init(ctx); err != nil {
			_ = inst.Close(ctx)
			return err
		}
		args, _, err := entryArgs(inst.meta, f.vals["invoke"], f.args)
		if err != nil {
			_ = inst.Close(ctx)
			return err
		}
		fmt.Fprintln(os.Stderr, "weave: starting workload")
		driveWorkload(inst, f.vals["invoke"], args, false)
		maybeExit()
	} else {
		fmt.Fprintln(os.Stderr, "weave: idle, waiting for workload")
	}

	for conn := range incoming {
		inst, from, err := acceptMigration(ctx, conn, func(wasm []byte) (*Instance, error) {
			// NOTE: __weave_init is NOT called on a restored instance.
			return NewInstance(ctx, wasm, makeServices(), func(s string) { fmt.Println(s) })
		}, moduleCache)
		if err != nil {
			sh.mu.Lock()
			sh.incomingReserved = false
			sh.mu.Unlock()
			fmt.Fprintf(os.Stderr, "weave: incoming migration failed: %v\n", err)
			continue
		}
		sh.mu.Lock()
		sh.incomingReserved = false
		sh.active = true
		sh.lastResult = ""
		sh.mu.Unlock()
		fmt.Fprintf(os.Stderr, "weave: workload received from %s, resuming\n", from)
		driveWorkload(inst, "", nil, true)
		maybeExit()
	}
	return nil
}

// classifyConn peeks the first frame byte: HELLO goes to the workload loop,
// CTL_* handled inline.
func classifyConn(conn net.Conn, sh *shared, incoming chan<- net.Conn) {
	if tc, ok := conn.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	_ = conn.SetReadDeadline(time.Now().Add(migrationIOTimeout))
	br := bufio.NewReader(conn)
	first, err := br.Peek(1)
	if err != nil {
		conn.Close()
		return
	}
	if first[0] == FtHello {
		sh.mu.Lock()
		if sh.active || sh.incomingReserved {
			sh.mu.Unlock()
			w := bufio.NewWriter(conn)
			abortFrame(w, 9, "node busy")
			_ = w.Flush()
			_ = conn.Close()
			return
		}
		sh.incomingReserved = true
		sh.mu.Unlock()
		select {
		case incoming <- peekedConn{Conn: conn, r: br}:
		default:
			sh.mu.Lock()
			sh.incomingReserved = false
			sh.mu.Unlock()
			w := bufio.NewWriter(conn)
			abortFrame(w, 9, "node busy")
			_ = w.Flush()
			_ = conn.Close()
		}
		return
	}
	defer conn.Close()
	f, err := readFrameR(br)
	if err != nil {
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	w := bufio.NewWriter(conn)
	switch f.typ {
	case FtCtlMigrate:
		c := &cursor{b: f.payload}
		target := c.str()
		if err := c.done(); err != nil {
			var p wbuf
			p.str("malformed migrate request")
			_ = writeFrame(w, FtCtlErr, p.Bytes())
			_ = w.Flush()
			return
		}
		result := make(chan string, 1)
		sh.mu.Lock()
		rejection := ""
		if strings.TrimSpace(target) == "" {
			rejection = "migration target must not be empty"
		} else if !sh.active {
			rejection = "node has no active workload"
		} else if sh.request != nil {
			rejection = "migration already in progress"
		} else {
			sh.request = &migrationRequest{target: target, result: result}
			sh.lastResult = ""
		}
		sh.mu.Unlock()
		if rejection != "" {
			var p wbuf
			p.str(rejection)
			_ = writeFrame(w, FtCtlErr, p.Bytes())
			_ = w.Flush()
			return
		}
		res := "timeout waiting for migration result"
		select {
		case res = <-result:
		case <-time.After(120 * time.Second):
		}
		var p wbuf
		p.str(res)
		t := byte(FtCtlErr)
		if strings.HasPrefix(res, "migrated") || strings.HasPrefix(res, "done") {
			t = FtCtlOk
		}
		_ = writeFrame(w, t, p.Bytes())
		_ = w.Flush()
	case FtCtlStatus:
		sh.mu.Lock()
		res := sh.lastResult
		if res == "" {
			if sh.active {
				res = "running"
			} else if sh.incomingReserved {
				res = "accepting"
			} else {
				res = "idle"
			}
		}
		sh.mu.Unlock()
		var p wbuf
		p.str(res)
		writeFrame(w, FtCtlOk, p.Bytes())
		w.Flush()
	}
}

// peekedConn lets the buffered reader's lookahead travel with the conn.
type peekedConn struct {
	net.Conn
	r *bufio.Reader
}

func (p peekedConn) Read(b []byte) (int, error) { return p.r.Read(b) }

func cmdCtl(f *flags, migrate bool) error {
	conn, err := net.Dial("tcp", f.vals["node"])
	if err != nil {
		return err
	}
	defer conn.Close()
	w := bufio.NewWriter(conn)
	r := bufio.NewReader(conn)
	if migrate {
		var p wbuf
		p.str(f.vals["to"])
		writeFrame(w, FtCtlMigrate, p.Bytes())
	} else {
		writeFrame(w, FtCtlStatus, nil)
	}
	w.Flush()
	fr, err := readFrameR(r)
	if err != nil {
		return err
	}
	c := &cursor{b: fr.payload}
	msg := c.str()
	if fr.typ == FtCtlOk {
		fmt.Printf("ok: %s\n", msg)
		return nil
	}
	return fmt.Errorf("node error: %s", msg)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: weave-wazero run|serve|migrate|status ...")
		os.Exit(2)
	}
	f := parseFlags(os.Args[2:])
	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(f)
	case "serve":
		err = cmdServe(f)
	case "migrate":
		err = cmdCtl(f, true)
	case "status":
		err = cmdCtl(f, false)
	default:
		err = fmt.Errorf("unknown command %s", os.Args[1])
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "weave: error: %v\n", err)
		os.Exit(1)
	}
}
