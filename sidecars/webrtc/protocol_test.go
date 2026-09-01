package rtcsidecar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"sync"
	"testing"
	"time"
)

func TestLineReaderBoundariesAndEncoding(t *testing.T) {
	t.Run("CRLF at exact limit", func(t *testing.T) {
		input := append(bytes.Repeat([]byte{'x'}, MaxControlBytes), '\r', '\n')
		record, err := newLineReader(bytes.NewReader(input)).read()
		if err != nil {
			t.Fatalf("read exact-limit record: %v", err)
		}
		if len(record) != MaxControlBytes {
			t.Fatalf("record length = %d, want %d", len(record), MaxControlBytes)
		}
	})

	t.Run("one byte over limit", func(t *testing.T) {
		input := append(bytes.Repeat([]byte{'x'}, MaxControlBytes+1), '\n')
		_, err := newLineReader(bytes.NewReader(input)).read()
		var protocolErr *protocolError
		if !errors.As(err, &protocolErr) || protocolErr.Code != "limit-exceeded" {
			t.Fatalf("error = %v, want limit-exceeded", err)
		}
	})

	t.Run("invalid UTF-8", func(t *testing.T) {
		_, err := newLineReader(bytes.NewReader([]byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}', '\n'})).read()
		var protocolErr *protocolError
		if !errors.As(err, &protocolErr) || protocolErr.Code != "invalid-message" {
			t.Fatalf("error = %v, want invalid-message", err)
		}
	})

	t.Run("unterminated final record", func(t *testing.T) {
		_, err := newLineReader(bytes.NewBufferString(`{"v":1}`)).read()
		if !errors.Is(err, io.ErrUnexpectedEOF) {
			t.Fatalf("error = %v, want unexpected EOF", err)
		}
	})
}

func TestDecodeRequestIsStrict(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		code string
	}{
		{
			name: "duplicate member",
			raw:  `{"v":1,"id":"one","command":"close","command":"status"}`,
			code: "invalid-message",
		},
		{
			name: "unknown member",
			raw:  `{"v":1,"id":"one","command":"close","extra":true}`,
			code: "invalid-message",
		},
		{
			name: "unknown nested member",
			raw:  `{"v":1,"id":"one","command":"start","role":"offerer","rtcConfiguration":{},"channels":[{"mapping":"m","label":"l","protocol":"p","local":{"mode":"listen","port":0,"extra":true}}]}`,
			code: "invalid-message",
		},
		{
			name: "null scalar does not become a default",
			raw:  `{"v":1,"id":"one","command":"start","role":"offerer","rtcConfiguration":{},"channels":[{"mapping":"m","label":"l","protocol":null,"local":{"mode":"listen","port":0}}]}`,
			code: "invalid-message",
		},
		{
			name: "wrong version",
			raw:  `{"v":2,"id":"one","command":"close"}`,
			code: "protocol-version",
		},
		{
			name: "unknown command",
			raw:  `{"v":1,"id":"one","command":"launch"}`,
			code: "unknown-command",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, protocolErr := decodeRequest([]byte(test.raw))
			if protocolErr == nil || protocolErr.Code != test.code {
				t.Fatalf("error = %#v, want code %s", protocolErr, test.code)
			}
		})
	}

	request, protocolErr := decodeRequest([]byte(`{"v":1,"id":"one","command":"close"}`))
	if protocolErr != nil || request.close == nil {
		t.Fatalf("valid close decode = (%#v, %v)", request, protocolErr)
	}
}

func TestStrictJSONAllowsOnlyWebRTCCandidateNulls(t *testing.T) {
	for _, raw := range []string{
		`{"type":"candidate","candidate":null}`,
		`{"type":"candidate","candidate":{"candidate":"candidate:value","sdpMid":null,"sdpMLineIndex":null,"usernameFragment":null}}`,
	} {
		if err := validateJSON([]byte(raw)); err != nil {
			t.Fatalf("valid candidate JSON rejected: %v", err)
		}
	}
	for _, raw := range []string{
		`{"connectOn":null}`,
		`{"port":null}`,
		`[null]`,
	} {
		if err := validateJSON([]byte(raw)); err == nil {
			t.Fatalf("ambiguous null accepted: %s", raw)
		}
	}
}

func TestProtocolWriterSerializesEventSequence(t *testing.T) {
	var output bytes.Buffer
	writer := newProtocolWriter(&output)
	const eventCount = 100
	var wait sync.WaitGroup
	wait.Add(eventCount)
	for index := 0; index < eventCount; index++ {
		go func(value int) {
			defer wait.Done()
			if err := writer.event("test", map[string]any{"value": value}); err != nil {
				t.Errorf("write event: %v", err)
			}
		}(index)
	}
	wait.Wait()
	scanner := bufio.NewScanner(bytes.NewReader(output.Bytes()))
	sequence := 0
	for scanner.Scan() {
		sequence++
		var event struct {
			Sequence int `json:"seq"`
		}
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			t.Fatalf("decode event %d: %v", sequence, err)
		}
		if event.Sequence != sequence {
			t.Fatalf("event %d has sequence %d", sequence, event.Sequence)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if sequence != eventCount {
		t.Fatalf("received %d events, want %d", sequence, eventCount)
	}
}

func TestProtocolWriterFinalEventIsLastUnderConcurrentCallbacks(t *testing.T) {
	var output bytes.Buffer
	writer := newProtocolWriter(&output)
	const callbackCount = 128
	start := make(chan struct{})
	errorsSeen := make(chan error, callbackCount+1)
	var wait sync.WaitGroup
	wait.Add(callbackCount + 1)
	for index := 0; index < callbackCount; index++ {
		go func(value int) {
			defer wait.Done()
			<-start
			err := writer.event("callback", map[string]any{"value": value})
			if err != nil && !errors.Is(err, io.ErrClosedPipe) {
				errorsSeen <- err
			}
		}(index)
	}
	go func() {
		defer wait.Done()
		<-start
		if err := writer.finalEvent("closed", map[string]any{"reason": "test"}); err != nil {
			errorsSeen <- err
		}
	}()
	close(start)
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Errorf("concurrent write: %v", err)
	}

	records := decodeOutputRecords(t, output.Bytes())
	closedCount := 0
	for index, record := range records {
		if record["event"] == "closed" {
			closedCount++
			if index != len(records)-1 {
				t.Fatalf("closed record at index %d of %d", index, len(records))
			}
		}
	}
	if closedCount != 1 {
		t.Fatalf("closed event count = %d, want 1", closedCount)
	}
	if err := writer.event("stale", nil); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("post-final event error = %v, want closed pipe", err)
	}
	if err := writer.response("late", nil); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("post-final response error = %v, want closed pipe", err)
	}
}

type blockingWriteCloser struct {
	started chan struct{}
	closed  chan struct{}
	once    sync.Once
}

func (w *blockingWriteCloser) Write([]byte) (int, error) {
	w.once.Do(func() { close(w.started) })
	<-w.closed
	return 0, io.ErrClosedPipe
}

func (w *blockingWriteCloser) Close() error {
	select {
	case <-w.closed:
	default:
		close(w.closed)
	}
	return nil
}

func TestProtocolWriterBoundsBlockedOutput(t *testing.T) {
	output := &blockingWriteCloser{started: make(chan struct{}), closed: make(chan struct{})}
	writer := newProtocolWriterWithTimeout(output, 20*time.Millisecond)
	started := time.Now()
	err := writer.event("test", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want deadline exceeded", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("blocked output took %s", elapsed)
	}
	select {
	case <-output.closed:
	default:
		t.Fatal("timed-out writer was not closed")
	}
}
