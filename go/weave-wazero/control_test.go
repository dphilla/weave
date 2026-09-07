package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"testing"
	"time"
)

func testControl(t *testing.T) *controlState {
	t.Helper()
	s, err := newControlState("running")
	if err != nil {
		t.Fatal(err)
	}
	s.epoch = "epoch"
	return s
}

func testControlRequest(id string) controlRequest {
	epoch, target := "epoch", "localhost:9000"
	return controlRequest{SchemaVersion: 1, Action: "migrate", NodeEpoch: &epoch, OperationID: &id, Target: &target}
}

func testControlLookup(id string) controlRequest {
	r := testControlRequest(id)
	r.Action, r.Target = "operation", nil
	return r
}

func TestControlRequestStrictJSON(t *testing.T) {
	for _, input := range []string{"null", "[]", "{}", `{"schema_version":1,"action":"status","extra":true}`,
		`{"schema_version":1,"schema_version":1,"action":"status"}`,
		`{"schema_version":1,"schema_versio\u006e":1,"action":"status"}`,
		`{"schema_version":1.0,"action":"status"}`, `{"schema_version":1e0,"action":"status"}`,
		`{"schema_version":null,"action":"status"}`, `{"schema_version":1,"action":"other"}`,
		`{"schema_version":1,"action":"status","target":{}}`,
		`{"schema_version":1,"action":"status"} {}`, string([]byte{255}), strings.Repeat(" ", 65537)} {
		if _, err := decodeControlRequest([]byte(input)); err == nil {
			t.Errorf("accepted invalid JSON %q", input)
		}
	}
	r, err := decodeControlRequest([]byte(`{"schema_version":2,"action":"status","target":null}`))
	if err != nil {
		t.Fatal(err)
	}
	s := testControl(t)
	result, _ := s.handle(r, true)
	if result.Code != "UNSUPPORTED_SCHEMA" {
		t.Fatal(result)
	}
}

func TestControlEpochAndIdempotency(t *testing.T) {
	s := testControl(t)
	if _, accepted := s.handle(testControlRequest("one"), true); accepted == nil {
		t.Fatal("not accepted")
	}
	if _, accepted := s.handle(testControlRequest("one"), true); accepted != nil {
		t.Fatal("duplicate execution")
	}
	if result, _ := s.handle(testControlRequest("two"), true); result.Code != "NODE_BUSY" {
		t.Fatal(result)
	}
	s.complete(controlFailedBeforeCommit, "migrated: misleading diagnostic")
	result, accepted := s.handle(testControlRequest("one"), true)
	if accepted != nil || result.Code != "MIGRATION_FAILED" || result.Operation.Ownership != "retained" {
		t.Fatal(result)
	}
	r := testControlRequest("one")
	target := "localhost:9001"
	r.Target = &target
	if result, _ := s.handle(r, true); result.Code != "OPERATION_CONFLICT" {
		t.Fatal(result)
	}
	epoch := "previous"
	r.NodeEpoch = &epoch
	if result, _ := s.handle(r, true); result.Code != "NODE_EPOCH_MISMATCH" {
		t.Fatal(result)
	}
	if result, _ := s.handle(testControlLookup("missing"), true); result.Code != "OPERATION_NOT_FOUND" {
		t.Fatal(result)
	}
	if _, accepted := s.handle(testControlRequest("two"), true); accepted == nil {
		t.Fatal("new operation not accepted")
	}
}

func TestControlCapacityNeverEvicts(t *testing.T) {
	s := testControl(t)
	for i := 0; i < 256; i++ {
		if _, accepted := s.handle(testControlRequest(fmt.Sprintf("id-%d", i)), true); accepted == nil {
			t.Fatal(i)
		}
		s.complete(controlFailedBeforeCommit, "unreachable")
	}
	if result, _ := s.handle(testControlRequest("overflow"), true); result.Code != "OPERATION_CAPACITY" {
		t.Fatal(result)
	}
	if result, _ := s.handle(testControlRequest("id-0"), true); result.Code != "MIGRATION_FAILED" {
		t.Fatal(result)
	}
	if len(s.operations) != 256 {
		t.Fatal(len(s.operations))
	}
}

func TestControlRetirementCannotBecomeRetryableFailure(t *testing.T) {
	s := testControl(t)
	s.handle(testControlRequest("one"), true)
	s.sourceRetired()
	result, _ := s.handle(testControlLookup("one"), false)
	if result.Code != "COMMIT_PENDING" || result.Ownership != "retired" || result.Operation.State != "accepted" || result.Operation.Ownership != "retired" {
		t.Fatal(result)
	}
	s.complete(controlFailedBeforeCommit, "misleading text")
	result, _ = s.handle(testControlLookup("one"), false)
	if result.Code != "COMMIT_UNCERTAIN" || result.OK || result.Retry != "inspect_ownership" || result.Ownership != "retired" {
		t.Fatal(result)
	}
	s.setLifecycle("running")
	result, _ = s.handle(testControlLookup("one"), true)
	if result.Operation.Ownership != "retired" {
		t.Fatal(result)
	}
}

func TestControlTypedCompletions(t *testing.T) {
	for _, tc := range []struct {
		completion                 controlCompletion
		code, lifecycle, ownership string
	}{
		{controlMigrated, "MIGRATED", "retired", "retired"},
		{controlCommitUncertain, "COMMIT_UNCERTAIN", "retired", "retired"},
		{controlFailedBeforeCommit, "MIGRATION_FAILED", "running", "retained"},
		{controlWorkloadCompleted, "WORKLOAD_COMPLETED", "completed", "none"},
		{controlWorkloadTrapped, "WORKLOAD_TRAPPED", "failed", "none"},
	} {
		s := testControl(t)
		s.handle(testControlRequest("one"), true)
		s.complete(tc.completion, "anything")
		r, _ := s.handle(testControlLookup("one"), false)
		if r.Code != tc.code || r.Lifecycle != tc.lifecycle || r.Ownership != tc.ownership {
			t.Fatal(r)
		}
	}
}

func TestControlTargetsBoundsAndEpochs(t *testing.T) {
	for _, target := range []string{"", "host", "host:0", "host:+1", "host:65536", "host:1\n", "a:b:1", "[invalid]:1", "::1:80", "[127.0.0.1]:1", "host:1.0"} {
		if validControlTarget(target) {
			t.Errorf("accepted %q", target)
		}
	}
	for _, target := range []string{"[::1]:9000", "localhost:09000"} {
		if !validControlTarget(target) {
			t.Errorf("rejected %q", target)
		}
	}
	for _, id := range []string{"", "a b", "../id", "☃", strings.Repeat("x", 129)} {
		if validControlID(id) {
			t.Errorf("accepted %q", id)
		}
	}
	first, err := newControlState("idle")
	if err != nil {
		t.Fatal(err)
	}
	second, err := newControlState("idle")
	if err != nil {
		t.Fatal(err)
	}
	if len(first.epoch) != 32 || first.epoch == second.epoch {
		t.Fatal("non-unique epoch")
	}
	s := testControl(t)
	s.handle(testControlRequest("one"), true)
	s.complete(controlFailedBeforeCommit, strings.Repeat("☃", 2048))
	r, _ := s.handle(testControlLookup("one"), true)
	if len(r.Message) > 2048 {
		t.Fatal("message not bounded")
	}
	r.Operation.State = "succeeded"
	r, _ = s.handle(testControlLookup("one"), true)
	if r.Operation.State != "failed" {
		t.Fatal("response aliases retained operation")
	}
	if _, err := r.encode(); err != nil {
		t.Fatal(err)
	}
}

func TestControlFrameBoundBeforePayloadAllocation(t *testing.T) {
	for _, typ := range []byte{FtCtlRequest, FtCtlResponse} {
		var header [5]byte
		header[0] = typ
		binary.LittleEndian.PutUint32(header[1:], 65537)
		if _, err := readFrameR(bufio.NewReader(bytes.NewReader(header[:]))); err == nil || !strings.Contains(err.Error(), "control frame too large") {
			t.Fatal(err)
		}
		var out bytes.Buffer
		if err := writeFrame(bufio.NewWriter(&out), typ, make([]byte, 65537)); err == nil {
			t.Fatal("oversize write accepted")
		}
		if out.Len() != 0 {
			t.Fatal("partial oversized write")
		}
	}
}

func controlExchange(t *testing.T, sh *shared, payload []byte) controlResponse {
	t.Helper()
	client, server := net.Pipe()
	defer client.Close()
	_ = client.SetDeadline(time.Now().Add(2 * time.Second))
	go classifyConn(server, sh, make(chan net.Conn, 1))
	w := bufio.NewWriter(client)
	if err := writeFrame(w, FtCtlRequest, payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	fr, err := readFrameR(bufio.NewReader(client))
	if err != nil {
		t.Fatal(err)
	}
	if fr.typ != FtCtlResponse {
		t.Fatalf("unexpected frame %d", fr.typ)
	}
	var result controlResponse
	if err := json.Unmarshal(fr.payload, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestControlRealConnectionAcceptanceReplayAndCompletion(t *testing.T) {
	sh := &shared{active: true, control: testControl(t)}
	if r := controlExchange(t, sh, []byte(`{"schema_version":1,"action":"status"}`)); r.Code != "STATUS_OK" || r.Capabilities.Runtime != "wazero" {
		t.Fatal(r)
	}
	if r := controlExchange(t, sh, []byte(`{"schema_version":1,"action":"status","typo":true}`)); r.Code != "INVALID_REQUEST" {
		t.Fatal(r)
	}
	payload, _ := json.Marshal(testControlRequest("one"))
	if r := controlExchange(t, sh, payload); r.Code != "ACCEPTED" {
		t.Fatal(r)
	}
	sh.mu.Lock()
	original := sh.request
	sh.mu.Unlock()
	if r := controlExchange(t, sh, payload); r.Code != "ACCEPTED" {
		t.Fatal(r)
	}
	sh.mu.Lock()
	if sh.request != original {
		t.Fatal("duplicate request was dispatched")
	}
	sh.control.sourceRetired()
	sh.mu.Unlock()
	lookup, _ := json.Marshal(testControlLookup("one"))
	if r := controlExchange(t, sh, lookup); r.Code != "COMMIT_PENDING" || r.Ownership != "retired" {
		t.Fatal(r)
	}
	sh.mu.Lock()
	sh.completeControlLocked(controlCommitUncertain, "no acknowledgment")
	sh.active = false
	sh.mu.Unlock()
	if r := controlExchange(t, sh, payload); r.Code != "COMMIT_UNCERTAIN" || r.Operation.State != "uncertain" {
		t.Fatal(r)
	}
}

func TestControlAcceptedOperationSurvivesLostResponse(t *testing.T) {
	sh := &shared{active: true, control: testControl(t)}
	client, server := net.Pipe()
	done := make(chan struct{})
	go func() { classifyConn(server, sh, make(chan net.Conn, 1)); close(done) }()
	payload, _ := json.Marshal(testControlRequest("lost-reply"))
	w := bufio.NewWriter(client)
	if err := writeFrame(w, FtCtlRequest, payload); err != nil {
		t.Fatal(err)
	}
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	client.Close() // the acknowledgement is intentionally never received
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not finish")
	}
	if r := controlExchange(t, sh, payload); r.Code != "ACCEPTED" {
		t.Fatal(r)
	}
	sh.mu.Lock()
	count := len(sh.control.operations)
	sh.mu.Unlock()
	if count != 1 {
		t.Fatal("lost reply caused duplicate execution")
	}
}
