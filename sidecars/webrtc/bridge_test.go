package rtcsidecar

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

type scriptedDataMessage struct {
	data     []byte
	isString bool
	err      error
}

type scriptedDataChannel struct {
	messages  chan scriptedDataMessage
	closed    chan struct{}
	closeOnce sync.Once
}

func newScriptedDataChannel() *scriptedDataChannel {
	return &scriptedDataChannel{
		messages: make(chan scriptedDataMessage, 8),
		closed:   make(chan struct{}),
	}
}

func (c *scriptedDataChannel) Read([]byte) (int, error) {
	return 0, errors.New("stream Read is not supported by this test channel")
}

func (c *scriptedDataChannel) Write(data []byte) (int, error) {
	return len(data), nil
}

func (c *scriptedDataChannel) ReadDataChannel(destination []byte) (int, bool, error) {
	select {
	case message := <-c.messages:
		if message.err != nil {
			return 0, message.isString, message.err
		}
		if len(message.data) > len(destination) {
			return 0, message.isString, io.ErrShortBuffer
		}
		return copy(destination, message.data), message.isString, nil
	case <-c.closed:
		return 0, false, io.EOF
	}
}

func (c *scriptedDataChannel) WriteDataChannel(data []byte, _ bool) (int, error) {
	select {
	case <-c.closed:
		return 0, io.ErrClosedPipe
	default:
		return len(data), nil
	}
}

func (c *scriptedDataChannel) SetReadDeadline(time.Time) error  { return nil }
func (c *scriptedDataChannel) SetWriteDeadline(time.Time) error { return nil }

func (c *scriptedDataChannel) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

func newIsolatedDialBridge(t *testing.T, port int, raw detachedDataChannel) *channelBridge {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	session := &rtcSession{
		ctx:      ctx,
		cancel:   cancel,
		writer:   newProtocolWriter(io.Discard),
		terminal: true,
	}
	bridgeContext, bridgeCancel := context.WithCancel(ctx)
	bridge := &channelBridge{
		session: session,
		config: validatedChannel{
			mapping:     "lazy",
			label:       "bytes",
			protocol:    "example.bytes.v1",
			mode:        "dial",
			host:        "127.0.0.1",
			port:        port,
			connectOn:   "first-data",
			dialTimeout: time.Second,
		},
		ctx:          bridgeContext,
		cancel:       bridgeCancel,
		raw:          raw,
		rtcReady:     true,
		state:        "waiting",
		localChannel: make(chan net.Conn, 1),
		rtcChannel:   make(chan detachedDataChannel, 1),
	}
	bridge.start()
	bridge.rtcChannel <- raw
	t.Cleanup(func() {
		bridge.abortSilently()
		cancel()
	})
	return bridge
}

func TestFirstDataDialTriggerIgnoresEmptyBinaryMessage(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	raw := newScriptedDataChannel()
	bridge := newIsolatedDialBridge(t, listener.Addr().(*net.TCPAddr).Port, raw)
	raw.messages <- scriptedDataMessage{}
	select {
	case connection := <-accepted:
		_ = connection.Close()
		t.Fatal("zero-length binary message triggered the local dial")
	case <-time.After(100 * time.Millisecond):
	}
	if bridge.status()["localReady"] != false {
		t.Fatal("bridge reported localReady after only an empty binary message")
	}

	payload := []byte{0, 1, 2, 3, 255}
	raw.messages <- scriptedDataMessage{data: payload}
	var connection net.Conn
	select {
	case connection = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("non-empty binary message did not trigger the local dial")
	}
	defer connection.Close()
	received := make([]byte, len(payload))
	if _, err := io.ReadFull(connection, received); err != nil {
		t.Fatal(err)
	}
	for index := range payload {
		if received[index] != payload[index] {
			t.Fatalf("first payload changed: got %v, want %v", received, payload)
		}
	}
}

func TestFirstDataDialTriggerRejectsTextBeforeDial(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		connection, acceptErr := listener.Accept()
		if acceptErr == nil {
			accepted <- connection
		}
	}()

	raw := newScriptedDataChannel()
	bridge := newIsolatedDialBridge(t, listener.Addr().(*net.TCPAddr).Port, raw)
	raw.messages <- scriptedDataMessage{data: []byte("text"), isString: true}
	select {
	case <-raw.closed:
	case <-time.After(time.Second):
		t.Fatal("text message did not terminate the bridge")
	}
	if bridge.status()["state"] != "failed" {
		t.Fatalf("bridge state = %v, want failed", bridge.status()["state"])
	}
	select {
	case connection := <-accepted:
		_ = connection.Close()
		t.Fatal("text message triggered the local dial")
	case <-time.After(100 * time.Millisecond):
	}
}
