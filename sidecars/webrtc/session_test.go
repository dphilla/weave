package rtcsidecar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

func TestEventBarrierKeepsResponseAheadOfConcurrentCallbacks(t *testing.T) {
	var output bytes.Buffer
	writer := newProtocolWriter(&output)
	session := &rtcSession{writer: writer}
	if err := session.beginEventBarrier(); err != nil {
		t.Fatal(err)
	}
	const callbacks = 64
	var wait sync.WaitGroup
	wait.Add(callbacks)
	for index := 0; index < callbacks; index++ {
		go func(value int) {
			defer wait.Done()
			session.emit("callback", map[string]any{"value": value})
		}(index)
	}
	wait.Wait()
	if err := writer.response("signal-1", nil); err != nil {
		t.Fatal(err)
	}
	if err := session.endEventBarrier(); err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte{'\n'})
	if len(lines) != callbacks+1 {
		t.Fatalf("got %d records, want %d", len(lines), callbacks+1)
	}
	var response map[string]any
	if err := json.Unmarshal(lines[0], &response); err != nil {
		t.Fatal(err)
	}
	if response["id"] != "signal-1" || response["ok"] != true {
		t.Fatalf("first record = %s, want signal response", lines[0])
	}
	for index, line := range lines[1:] {
		var event map[string]any
		if err := json.Unmarshal(line, &event); err != nil {
			t.Fatal(err)
		}
		if event["event"] != "callback" || int(event["seq"].(float64)) != index+1 {
			t.Fatalf("event %d = %s", index+1, line)
		}
	}
}

func TestSignalFailureRespondsBeforeTerminalEvents(t *testing.T) {
	input := bytes.NewBuffer(nil)
	encoder := json.NewEncoder(input)
	start := map[string]any{
		"v":                1,
		"id":               "start",
		"command":          "start",
		"role":             "answerer",
		"connectTimeoutMs": 0,
		"rtcConfiguration": map[string]any{"iceServers": []any{}},
		"channels": []any{map[string]any{
			"mapping": "only", "label": "binary", "protocol": "example.v1",
			"local": map[string]any{
				"mode": "dial", "host": "127.0.0.1", "port": 9, "connectOn": "first-data",
			},
		}},
	}
	if err := encoder.Encode(start); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Encode(map[string]any{
		"v": 1, "id": "signal", "command": "signal",
		"message": map[string]any{
			"type":        "description",
			"description": map[string]any{"type": "offer", "sdp": "v=0\r\n"},
		},
	}); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	err := Run(context.Background(), input, &output)
	var exitErr *ExitError
	if !errors.As(err, &exitErr) || exitErr.Code != "signal-apply-failed" {
		t.Fatalf("Run error = %v, want signal-apply-failed\n%s", err, output.String())
	}
	records := decodeOutputRecords(t, output.Bytes())
	responseIndex := -1
	failedIndex := -1
	closedIndex := -1
	for index, record := range records {
		if record["id"] == "signal" {
			responseIndex = index
			if record["ok"] != false {
				t.Fatalf("signal response = %#v", record)
			}
			errorBody := record["error"].(map[string]any)
			if errorBody["fatal"] != true {
				t.Fatalf("terminal signal error was not marked fatal: %#v", record)
			}
		}
		if record["event"] == "session.state" && record["state"] == "failed" {
			failedIndex = index
		}
		if record["event"] == "closed" {
			closedIndex = index
		}
	}
	if responseIndex < 0 || failedIndex <= responseIndex || closedIndex <= failedIndex {
		t.Fatalf("response/terminal ordering indexes = response:%d failed:%d closed:%d\n%s", responseIndex, failedIndex, closedIndex, output.String())
	}
}

func TestRemoteCandidateEndMarkerIsTerminalForCandidateSequence(t *testing.T) {
	session := &rtcSession{}
	if protocolErr := session.applyRemoteCandidate(json.RawMessage(
		`{"type":"candidate","candidate":null}`,
	)); protocolErr != nil {
		t.Fatalf("end marker rejected: %v", protocolErr)
	}
	if len(session.pendingRemote) != 1 || session.pendingRemote[0].Candidate != "" {
		t.Fatalf("queued candidates = %#v, want one end marker", session.pendingRemote)
	}
	protocolErr := session.applyRemoteCandidate(json.RawMessage(
		`{"type":"candidate","candidate":{"candidate":"candidate:1 1 UDP 1 127.0.0.1 9 typ host"}}`,
	))
	if protocolErr == nil || protocolErr.Code != "signal-invalid" {
		t.Fatalf("candidate after end marker error = %#v", protocolErr)
	}
}

func TestMappingsCloseIndependentlyAndLastMappingEndsSession(t *testing.T) {
	validated := &validatedStart{
		role: "answerer",
		channels: []validatedChannel{
			{
				mapping: "one", label: "one", protocol: "example.one.v1",
				mode: "dial", host: "127.0.0.1", port: 9, connectOn: "first-data", dialTimeout: time.Second,
			},
			{
				mapping: "two", label: "two", protocol: "example.two.v1",
				mode: "dial", host: "127.0.0.1", port: 9, connectOn: "open", dialTimeout: time.Second,
			},
		},
	}
	session, err := newRTCSession(context.Background(), validated, newProtocolWriter(io.Discard))
	if err != nil {
		t.Fatal(err)
	}
	defer session.closeResources()

	status := session.status()
	channels := status["channels"].([]map[string]any)
	firstLocal := channels[0]["local"].(map[string]any)
	secondLocal := channels[1]["local"].(map[string]any)
	if firstLocal["connectOn"] != "first-data" || secondLocal["connectOn"] != "open" {
		t.Fatalf("status did not preserve dial triggers: %#v", channels)
	}

	session.bridges[0].finish("local-close", nil)
	if session.isTerminal() {
		t.Fatal("session ended when only one of two mappings closed")
	}
	if session.bridges[1].status()["state"] == "closed" {
		t.Fatal("closing one mapping closed its independent peer mapping")
	}
	select {
	case result := <-session.terminalChannel:
		t.Fatalf("unexpected early terminal result: %#v", result)
	default:
	}

	finished := make(chan struct{})
	go func() {
		session.bridges[1].finish("local-close", nil)
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("last mapping teardown deadlocked")
	}
	select {
	case result := <-session.terminalChannel:
		if result.reason != "all-channels-closed" || result.err != nil {
			t.Fatalf("terminal result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("last mapping did not end the session")
	}
}

type peerOutput struct {
	peer   int
	record map[string]any
}

type runningPeer struct {
	input  *io.PipeWriter
	done   chan error
	sendMu sync.Mutex
}

func startPeerProcess(ctx context.Context, index int, events chan<- peerOutput) *runningPeer {
	inputReader, inputWriter := io.Pipe()
	outputReader, outputWriter := io.Pipe()
	peer := &runningPeer{input: inputWriter, done: make(chan error, 1)}
	go func() {
		peer.done <- Run(ctx, inputReader, outputWriter)
		_ = outputWriter.Close()
		_ = inputReader.Close()
	}()
	go func() {
		scanner := bufio.NewScanner(outputReader)
		scanner.Buffer(make([]byte, 64<<10), MaxControlBytes+1)
		for scanner.Scan() {
			var record map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
				record = map[string]any{"testDecodeError": err.Error()}
			}
			events <- peerOutput{peer: index, record: record}
		}
		_ = outputReader.Close()
	}()
	return peer
}

func (p *runningPeer) send(value any) error {
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	record, err := json.Marshal(value)
	if err != nil {
		return err
	}
	record = append(record, '\n')
	_, err = p.input.Write(record)
	return err
}

func TestPionSidecarsBridgeBinaryBytes(t *testing.T) {
	for _, connectOn := range []string{"open", "first-data"} {
		t.Run(connectOn, func(t *testing.T) {
			testPionSidecarsBridgeBinaryBytes(t, connectOn)
		})
	}
}

func testPionSidecarsBridgeBinaryBytes(t *testing.T, connectOn string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	events := make(chan peerOutput, 1024)
	peers := []*runningPeer{
		startPeerProcess(ctx, 0, events),
		startPeerProcess(ctx, 1, events),
	}
	defer func() {
		for _, peer := range peers {
			_ = peer.input.Close()
		}
	}()

	targetListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer targetListener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := targetListener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	startOfferer := startControlRecord("offerer", map[string]any{
		"mode": "listen", "host": "127.0.0.1", "port": 0,
	})
	startOfferer["id"] = "start-offer"
	startAnswerer := startControlRecord("answerer", map[string]any{
		"mode": "dial", "host": "127.0.0.1", "port": targetListener.Addr().(*net.TCPAddr).Port,
		"connectOn": connectOn,
	})
	startAnswerer["id"] = "start-answer"
	if err := peers[0].send(startOfferer); err != nil {
		t.Fatal(err)
	}
	if err := peers[1].send(startAnswerer); err != nil {
		t.Fatal(err)
	}

	requestNumber := 0
	var offerAddress string
	connected := [2]bool{}
	rtcReadyAnswerer := false
	signalTypes := [2][]string{}
	handle := func(output peerOutput) {
		record := output.record
		if decodeErr, exists := record["testDecodeError"]; exists {
			t.Fatalf("decode sidecar %d output: %v", output.peer, decodeErr)
		}
		if ok, exists := record["ok"]; exists && ok == false {
			t.Fatalf("sidecar %d error response: %#v", output.peer, record)
		}
		if record["event"] == "signal" {
			message := record["message"].(map[string]any)
			signalTypes[output.peer] = append(signalTypes[output.peer], message["type"].(string))
			requestNumber++
			other := 1 - output.peer
			if err := peers[other].send(map[string]any{
				"v": 1, "id": fmt.Sprintf("signal-%d", requestNumber), "command": "signal", "message": record["message"],
			}); err != nil {
				t.Fatalf("route signal: %v", err)
			}
		}
		if record["id"] == "start-offer" && record["ok"] == true {
			result := record["result"].(map[string]any)
			channels := result["channels"].([]any)
			local := channels[0].(map[string]any)["local"].(map[string]any)
			offerAddress = local["address"].(string)
		}
		if record["event"] == "session.state" && record["state"] == "connected" {
			connected[output.peer] = true
		}
		if output.peer == 1 && record["event"] == "channel.state" && record["rtcReady"] == true {
			rtcReadyAnswerer = true
		}
		if record["event"] == "closed" {
			t.Fatalf("sidecar %d closed before byte test: %#v", output.peer, record)
		}
	}

	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	for offerAddress == "" || !connected[0] || !connected[1] || !rtcReadyAnswerer {
		select {
		case output := <-events:
			handle(output)
		case <-deadline.C:
			t.Fatalf("timed out waiting for connection: address=%q connected=%v rtcReady=%v", offerAddress, connected, rtcReadyAnswerer)
		}
	}
	for peer, types := range signalTypes {
		if len(types) == 0 || types[0] != "description" {
			t.Fatalf("sidecar %d signal order = %v, want description first", peer, types)
		}
	}

	offerTCP, err := net.Dial("tcp", offerAddress)
	if err != nil {
		t.Fatalf("dial offerer bridge: %v", err)
	}
	defer offerTCP.Close()

	var answerTCP net.Conn
	if connectOn == "first-data" {
		select {
		case connection := <-accepted:
			_ = connection.Close()
			t.Fatal("first-data mapping dialed before receiving bytes")
		case <-time.After(150 * time.Millisecond):
		}
	} else {
		select {
		case answerTCP = <-accepted:
		case <-time.After(3 * time.Second):
			t.Fatal("open mapping did not dial when the DataChannel opened")
		}
	}

	payload := bytes.Repeat([]byte("binary\x00payload-"), 6000)
	if _, err := offerTCP.Write(payload); err != nil {
		t.Fatal(err)
	}
	if answerTCP == nil {
		select {
		case answerTCP = <-accepted:
		case <-time.After(3 * time.Second):
			t.Fatal("first-data mapping did not dial after bytes arrived")
		}
	}
	defer answerTCP.Close()
	received := make([]byte, len(payload))
	if _, err := io.ReadFull(answerTCP, received); err != nil {
		t.Fatalf("read answer TCP: %v", err)
	}
	if !bytes.Equal(received, payload) {
		t.Fatal("offerer-to-answerer payload changed")
	}

	reply := bytes.Repeat([]byte{0, 1, 2, 3, 4, 255}, 12000)
	if _, err := answerTCP.Write(reply); err != nil {
		t.Fatal(err)
	}
	receivedReply := make([]byte, len(reply))
	if _, err := io.ReadFull(offerTCP, receivedReply); err != nil {
		t.Fatalf("read offer TCP: %v", err)
	}
	if !bytes.Equal(receivedReply, reply) {
		t.Fatal("answerer-to-offerer payload changed")
	}

	_ = offerTCP.Close()
	_ = answerTCP.Close()
	for index, peer := range peers {
		select {
		case runErr := <-peer.done:
			if runErr != nil {
				t.Fatalf("sidecar %d exit: %v", index, runErr)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("sidecar %d did not close after its only bridge ended", index)
		}
	}
}

func startControlRecord(role string, local map[string]any) map[string]any {
	return map[string]any{
		"v":                1,
		"command":          "start",
		"role":             role,
		"connectTimeoutMs": 10000,
		"rtcConfiguration": map[string]any{"iceServers": []any{}},
		"channels": []any{map[string]any{
			"mapping": "bytes", "label": "binary", "protocol": "example.binary.v1", "local": local,
		}},
	}
}

func decodeOutputRecords(t *testing.T, raw []byte) []map[string]any {
	t.Helper()
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 64<<10), MaxControlBytes+1)
	var records []map[string]any
	for scanner.Scan() {
		var record map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &record); err != nil {
			t.Fatalf("decode output record: %v", err)
		}
		records = append(records, record)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return records
}
