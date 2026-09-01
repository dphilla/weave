package rtcsidecar

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	ProtocolVersion      = 1
	ProtocolName         = "webrtc-sidecar.control.v1"
	MaxControlBytes      = 1 << 20
	MaxChannels          = 8
	MaxPendingCandidates = 256
	MaxSDPBytes          = 256 << 10
	MaxCandidateBytes    = 16 << 10
	MaxDataMessageBytes  = 64 << 10
	DataChunkBytes       = 16 << 10
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,64}$`)

type protocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Fatal   bool   `json:"fatal,omitempty"`
	cause   error
}

func (e *protocolError) Error() string { return e.Message }
func (e *protocolError) Unwrap() error { return e.cause }

func newProtocolError(code, message string, fatal bool, cause error) *protocolError {
	return &protocolError{Code: code, Message: message, Fatal: fatal, cause: cause}
}

type baseRequest struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Command string `json:"command"`
}

type startRequest struct {
	Version              int                    `json:"v"`
	ID                   string                 `json:"id"`
	Command              string                 `json:"command"`
	Role                 string                 `json:"role"`
	RTCConfiguration     rtcConfigurationWire   `json:"rtcConfiguration"`
	ConnectTimeoutMillis *int64                 `json:"connectTimeoutMs,omitempty"`
	Channels             []channelConfiguration `json:"channels"`
}

type signalRequest struct {
	Version int             `json:"v"`
	ID      string          `json:"id"`
	Command string          `json:"command"`
	Message json.RawMessage `json:"message"`
}

type statusRequest struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Command string `json:"command"`
}

type closeRequest struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Command string `json:"command"`
}

type closeChannelRequest struct {
	Version int    `json:"v"`
	ID      string `json:"id"`
	Command string `json:"command"`
	Mapping string `json:"mapping"`
}

type decodedRequest struct {
	base         baseRequest
	start        *startRequest
	signal       *signalRequest
	status       *statusRequest
	close        *closeRequest
	closeChannel *closeChannelRequest
}

type lineReader struct {
	reader *bufio.Reader
}

func newLineReader(reader io.Reader) *lineReader {
	return &lineReader{reader: bufio.NewReaderSize(reader, 64<<10)}
}

func (r *lineReader) read() ([]byte, error) {
	line := make([]byte, 0, 4096)
	for {
		fragment, err := r.reader.ReadSlice('\n')
		// The record limit excludes the LF terminator and an optional CR.
		if len(line)+len(fragment) > MaxControlBytes+2 {
			return nil, newProtocolError(
				"limit-exceeded",
				fmt.Sprintf("control record exceeds %d bytes", MaxControlBytes),
				true,
				nil,
			)
		}
		line = append(line, fragment...)
		switch {
		case err == nil:
			line = line[:len(line)-1]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			if len(line) == 0 {
				return nil, newProtocolError("invalid-message", "blank control record", true, nil)
			}
			if len(line) > MaxControlBytes {
				return nil, newProtocolError(
					"limit-exceeded",
					fmt.Sprintf("control record exceeds %d bytes", MaxControlBytes),
					true,
					nil,
				)
			}
			if !utf8.Valid(line) {
				return nil, newProtocolError("invalid-message", "control record is not valid UTF-8", true, nil)
			}
			return line, nil
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		case errors.Is(err, io.EOF) && len(line) == 0:
			return nil, io.EOF
		case errors.Is(err, io.EOF):
			return nil, newProtocolError(
				"invalid-message",
				"control stream ended in an unterminated record",
				true,
				io.ErrUnexpectedEOF,
			)
		default:
			return nil, err
		}
	}
}

type protocolWriter struct {
	mu       sync.Mutex
	writer   io.Writer
	timeout  time.Duration
	closed   bool
	sequence uint64
}

func newProtocolWriter(writer io.Writer) *protocolWriter {
	return newProtocolWriterWithTimeout(writer, 30*time.Second)

}

func newProtocolWriterWithTimeout(writer io.Writer, timeout time.Duration) *protocolWriter {
	return &protocolWriter{writer: writer, timeout: timeout}
}

func (w *protocolWriter) write(value any) error {
	record, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode control record: %w", err)
	}
	if len(record) > MaxControlBytes {
		return fmt.Errorf("encoded control record exceeds %d bytes", MaxControlBytes)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.writeRecordLocked(record)
}

func (w *protocolWriter) writeRecordLocked(record []byte) error {
	if w.closed {
		return io.ErrClosedPipe
	}
	line := make([]byte, len(record)+1)
	copy(line, record)
	line[len(record)] = '\n'
	completed := make(chan error, 1)
	go func() {
		for len(line) > 0 {
			written, err := w.writer.Write(line)
			if err != nil {
				completed <- err
				return
			}
			if written == 0 {
				completed <- io.ErrShortWrite
				return
			}
			line = line[written:]
		}
		completed <- nil
	}()
	if w.timeout <= 0 {
		err := <-completed
		if err != nil {
			w.closed = true
		}
		return err
	}
	timer := time.NewTimer(w.timeout)
	defer timer.Stop()
	select {
	case err := <-completed:
		if err != nil {
			w.closed = true
		}
		return err
	case <-timer.C:
		w.closed = true
		if closer, ok := w.writer.(io.Closer); ok {
			_ = closer.Close()
		}
		return fmt.Errorf("control output blocked for %s: %w", w.timeout, context.DeadlineExceeded)
	}
}

func (w *protocolWriter) ready() error {
	return w.write(map[string]any{
		"v":        ProtocolVersion,
		"event":    "ready",
		"protocol": ProtocolName,
		"capabilities": []string{
			"trickle-ice",
			"tcp-listen",
			"tcp-dial",
			"selected-path",
		},
		"limits": map[string]any{
			"maxChannels":     MaxChannels,
			"maxControlBytes": MaxControlBytes,
		},
	})
}

func (w *protocolWriter) response(id string, result any) error {
	if result == nil {
		result = map[string]any{}
	}
	return w.write(map[string]any{
		"v":      ProtocolVersion,
		"id":     id,
		"ok":     true,
		"result": result,
	})
}

func (w *protocolWriter) errorResponse(id string, protocolErr *protocolError) error {
	return w.write(map[string]any{
		"v":     ProtocolVersion,
		"id":    id,
		"ok":    false,
		"error": protocolErr,
	})
}

func (w *protocolWriter) event(name string, fields map[string]any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return io.ErrClosedPipe
	}
	encoded, err := w.encodeEventLocked(name, fields)
	if err != nil {
		return err
	}
	return w.writeRecordLocked(encoded)
}

// finalEvent writes the one terminal record and permanently seals the output
// while holding the same lock used by every response and event. A callback may
// win the lock before this method, but no callback can write after it.
func (w *protocolWriter) finalEvent(name string, fields map[string]any) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.closed {
		return io.ErrClosedPipe
	}
	encoded, err := w.encodeEventLocked(name, fields)
	if err != nil {
		w.closed = true
		return err
	}
	err = w.writeRecordLocked(encoded)
	w.closed = true
	return err
}

func (w *protocolWriter) encodeEventLocked(name string, fields map[string]any) ([]byte, error) {
	w.sequence++
	record := make(map[string]any, len(fields)+3)
	record["v"] = ProtocolVersion
	record["seq"] = w.sequence
	record["event"] = name
	for key, value := range fields {
		record[key] = value
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return nil, fmt.Errorf("encode control event: %w", err)
	}
	if len(encoded) > MaxControlBytes {
		return nil, fmt.Errorf("encoded control event exceeds %d bytes", MaxControlBytes)
	}
	return encoded, nil
}

func decodeRequest(record []byte) (*decodedRequest, *protocolError) {
	if !utf8.Valid(record) {
		return nil, newProtocolError("invalid-message", "control record is not valid UTF-8", true, nil)
	}
	if err := validateJSON(record); err != nil {
		return nil, newProtocolError("invalid-message", "control record is not strict JSON", true, err)
	}
	var base baseRequest
	if err := json.Unmarshal(record, &base); err != nil {
		return nil, newProtocolError("invalid-message", "invalid request envelope", true, err)
	}
	if base.Version != ProtocolVersion {
		return &decodedRequest{base: base}, newProtocolError(
			"protocol-version",
			fmt.Sprintf("unsupported protocol version %d", base.Version),
			true,
			nil,
		)
	}
	if !requestIDPattern.MatchString(base.ID) {
		return nil, newProtocolError("invalid-message", "request id must be 1..64 safe ASCII characters", true, nil)
	}
	request := &decodedRequest{base: base}
	var target any
	switch base.Command {
	case "start":
		request.start = &startRequest{}
		target = request.start
	case "signal":
		request.signal = &signalRequest{}
		target = request.signal
	case "status":
		request.status = &statusRequest{}
		target = request.status
	case "channel.close":
		request.closeChannel = &closeChannelRequest{}
		target = request.closeChannel
	case "close":
		request.close = &closeRequest{}
		target = request.close
	default:
		return request, newProtocolError("unknown-command", "unknown command", false, nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(record))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return request, newProtocolError("invalid-message", "invalid command fields", false, err)
	}
	return request, nil
}

// validateJSON rejects duplicate object members in addition to ordinary JSON
// syntax errors. Duplicate security-sensitive fields must never be interpreted
// differently by two implementations of the control protocol.
func validateJSON(record []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(record))
	decoder.UseNumber()
	if err := validateJSONValue(decoder, false); err != nil {
		return err
	}
	if token, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err != nil {
			return err
		}
		return fmt.Errorf("unexpected trailing JSON token %v", token)
	}
	return nil
}

func validateJSONValue(decoder *json.Decoder, nullAllowed bool) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	if token == nil {
		if nullAllowed {
			return nil
		}
		return errors.New("JSON null is not valid for this field")
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
		return nil
	}
	switch delimiter {
	case '{':
		members := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("object member name is not a string")
			}
			if _, duplicate := members[key]; duplicate {
				return fmt.Errorf("duplicate object member %q", key)
			}
			members[key] = struct{}{}
			if err := validateJSONValue(decoder, nullableJSONMember(key)); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim('}') {
			return errors.New("invalid object closing delimiter")
		}
	case '[':
		for decoder.More() {
			if err := validateJSONValue(decoder, false); err != nil {
				return err
			}
		}
		closing, err := decoder.Token()
		if err != nil {
			return err
		}
		if closing != json.Delim(']') {
			return errors.New("invalid array closing delimiter")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
	return nil
}

func nullableJSONMember(name string) bool {
	switch name {
	case "candidate", "sdpMid", "sdpMLineIndex", "usernameFragment":
		return true
	default:
		return false
	}
}
