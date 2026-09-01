package rtcsidecar

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

type detachedDataChannel interface {
	io.ReadWriteCloser
	ReadDataChannel([]byte) (int, bool, error)
	WriteDataChannel([]byte, bool) (int, error)
	SetReadDeadline(time.Time) error
	SetWriteDeadline(time.Time) error
}

type bridgeResult struct {
	reason string
	err    error
}

type channelBridge struct {
	session *rtcSession
	config  validatedChannel
	ctx     context.Context
	cancel  context.CancelFunc

	mu         sync.Mutex
	listener   net.Listener
	local      net.Conn
	dc         *webrtc.DataChannel
	raw        detachedDataChannel
	localReady bool
	rtcReady   bool
	state      string
	terminal   bool
	started    bool
	finishOnce sync.Once

	localChannel chan net.Conn
	rtcChannel   chan detachedDataChannel
}

func newChannelBridge(parent context.Context, session *rtcSession, config validatedChannel) (*channelBridge, error) {
	ctx, cancel := context.WithCancel(parent)
	bridge := &channelBridge{
		session:      session,
		config:       config,
		ctx:          ctx,
		cancel:       cancel,
		state:        "waiting",
		localChannel: make(chan net.Conn, 1),
		rtcChannel:   make(chan detachedDataChannel, 1),
	}
	if config.mode == "listen" {
		listener, err := (&net.ListenConfig{}).Listen(ctx, "tcp", net.JoinHostPort(config.host, fmt.Sprint(config.port)))
		if err != nil {
			cancel()
			return nil, fmt.Errorf("listen for mapping %s: %w", config.mapping, err)
		}
		bridge.listener = listener
	}
	return bridge, nil
}

func (b *channelBridge) result() map[string]any {
	return map[string]any{
		"mapping":  b.config.mapping,
		"label":    b.config.label,
		"protocol": b.config.protocol,
		"local":    b.localDescriptor(),
	}
}

func (b *channelBridge) localDescriptor() map[string]any {
	local := map[string]any{"mode": b.config.mode}
	if b.config.mode == "listen" {
		local["address"] = b.listener.Addr().String()
	} else {
		local["address"] = net.JoinHostPort(b.config.host, fmt.Sprint(b.config.port))
		local["connectOn"] = b.config.connectOn
	}
	return local
}

func (b *channelBridge) status() map[string]any {
	b.mu.Lock()
	defer b.mu.Unlock()
	return map[string]any{
		"mapping":    b.config.mapping,
		"label":      b.config.label,
		"protocol":   b.config.protocol,
		"state":      b.state,
		"localReady": b.localReady,
		"rtcReady":   b.rtcReady,
		"local":      b.localDescriptor(),
	}
}

func (b *channelBridge) start() {
	b.mu.Lock()
	if b.started || b.terminal {
		b.mu.Unlock()
		return
	}
	b.started = true
	b.mu.Unlock()
	if b.config.mode == "listen" {
		go b.acceptLocal()
	}
	go b.run()
}

func (b *channelBridge) acceptLocal() {
	connection, err := b.listener.Accept()
	if err != nil {
		if b.ctx.Err() == nil {
			b.finish("local-accept-failed", fmt.Errorf("accept local connection: %w", err))
		}
		return
	}
	_ = b.listener.Close()
	remote, ok := connection.RemoteAddr().(*net.TCPAddr)
	if !ok || remote.IP == nil || !remote.IP.IsLoopback() {
		_ = connection.Close()
		b.finish("local-accept-failed", errors.New("local connection did not originate on loopback"))
		return
	}
	b.setLocal(connection)
	select {
	case b.localChannel <- connection:
	case <-b.ctx.Done():
		_ = connection.Close()
	}
}

func (b *channelBridge) attachDataChannel(channel *webrtc.DataChannel) error {
	if channel.Label() != b.config.label || channel.Protocol() != b.config.protocol {
		return errors.New("DataChannel label or protocol does not match its configured mapping")
	}
	if !channel.Ordered() || channel.MaxPacketLifeTime() != nil || channel.MaxRetransmits() != nil || channel.Negotiated() {
		return errors.New("DataChannel must be ordered, fully reliable, and negotiated in-band")
	}
	b.mu.Lock()
	if b.dc != nil {
		b.mu.Unlock()
		return errors.New("duplicate DataChannel for mapping")
	}
	b.dc = channel
	b.mu.Unlock()

	channel.OnError(func(err error) {
		b.finish("data-channel-error", fmt.Errorf("DataChannel failed: %w", err))
	})
	channel.OnClose(func() {
		b.finish("remote-closed", nil)
	})
	channel.OnOpen(func() {
		raw, err := channel.DetachWithDeadline()
		if err != nil {
			b.finish("data-channel-detach-failed", fmt.Errorf("detach DataChannel: %w", err))
			return
		}
		b.mu.Lock()
		if b.terminal {
			b.mu.Unlock()
			_ = raw.Close()
			return
		}
		b.raw = raw
		b.rtcReady = true
		b.mu.Unlock()
		b.emitState("")
		select {
		case b.rtcChannel <- raw:
		case <-b.ctx.Done():
			_ = raw.Close()
		}
	})
	return nil
}

func (b *channelBridge) run() {
	var raw detachedDataChannel
	select {
	case raw = <-b.rtcChannel:
	case <-b.ctx.Done():
		return
	}

	var connection net.Conn
	var firstMessage []byte
	if b.config.mode == "listen" {
		select {
		case connection = <-b.localChannel:
		case <-b.ctx.Done():
			return
		}
	} else {
		if b.config.connectOn == "first-data" {
			buffer := make([]byte, MaxDataMessageBytes)
			for len(firstMessage) == 0 {
				n, isString, err := raw.ReadDataChannel(buffer)
				if err != nil {
					b.finish(classifyBridgeReason("data-channel-read", err), err)
					return
				}
				if isString {
					b.finish("text-data-rejected", errors.New("text DataChannel messages are not accepted"))
					return
				}
				if n > 0 {
					firstMessage = append([]byte(nil), buffer[:n]...)
				}
			}
		}
		dialContext := b.ctx
		cancel := func() {}
		if b.config.dialTimeout > 0 {
			dialContext, cancel = context.WithTimeout(b.ctx, b.config.dialTimeout)
		}
		var err error
		connection, err = (&net.Dialer{}).DialContext(
			dialContext,
			"tcp",
			net.JoinHostPort(b.config.host, fmt.Sprint(b.config.port)),
		)
		cancel()
		if err != nil {
			b.finish("local-connect-failed", fmt.Errorf("dial local mapping: %w", err))
			return
		}
		b.setLocal(connection)
	}

	b.mu.Lock()
	if b.terminal {
		b.mu.Unlock()
		_ = connection.Close()
		return
	}
	b.state = "bridging"
	b.mu.Unlock()
	b.emitState("")
	if len(firstMessage) > 0 {
		if err := writeTCP(connection, firstMessage); err != nil {
			b.finish(classifyBridgeReason("tcp-write", err), err)
			return
		}
	}

	results := make(chan bridgeResult, 2)
	go func() { results <- pumpRTCToTCP(raw, connection) }()
	go func() { results <- pumpTCPToRTC(connection, raw) }()
	select {
	case result := <-results:
		b.finish(result.reason, result.err)
	case <-b.ctx.Done():
	}
}

func (b *channelBridge) setLocal(connection net.Conn) {
	b.mu.Lock()
	if b.terminal {
		b.mu.Unlock()
		_ = connection.Close()
		return
	}
	b.local = connection
	b.localReady = true
	b.mu.Unlock()
	b.emitState("")
}

func (b *channelBridge) emitState(reason string) {
	status := b.status()
	if reason != "" {
		status["reason"] = reason
	}
	b.session.emit("channel.state", status)
}

func (b *channelBridge) finish(reason string, err error) {
	var listener net.Listener
	var connection net.Conn
	var raw detachedDataChannel
	var channel *webrtc.DataChannel
	finished := false
	b.finishOnce.Do(func() {
		finished = true
		b.mu.Lock()
		b.terminal = true
		b.state = "closed"
		if err != nil {
			b.state = "failed"
		}
		listener = b.listener
		connection = b.local
		raw = b.raw
		channel = b.dc
		b.mu.Unlock()
	})
	if !finished {
		return
	}
	b.cancel()
	if listener != nil {
		_ = listener.Close()
	}
	if connection != nil {
		_ = connection.Close()
	}
	if raw != nil {
		_ = raw.Close()
	} else if channel != nil {
		_ = channel.Close()
	}
	status := b.status()
	status["reason"] = reason
	if err != nil {
		status["error"] = sanitizeError(bridgeErrorCode(reason), err)
	}
	b.session.emit("channel.state", status)
	b.session.bridgeFinished(b, reason, err)
}

func (b *channelBridge) abortSilently() {
	var listener net.Listener
	var connection net.Conn
	var raw detachedDataChannel
	var channel *webrtc.DataChannel
	finished := false
	b.finishOnce.Do(func() {
		finished = true
		b.mu.Lock()
		b.terminal = true
		b.state = "closed"
		listener = b.listener
		connection = b.local
		raw = b.raw
		channel = b.dc
		b.mu.Unlock()
	})
	if !finished {
		return
	}
	b.cancel()
	if listener != nil {
		_ = listener.Close()
	}
	if connection != nil {
		_ = connection.Close()
	}
	if raw != nil {
		_ = raw.Close()
	} else if channel != nil {
		_ = channel.Close()
	}
}

func pumpRTCToTCP(raw detachedDataChannel, connection net.Conn) bridgeResult {
	buffer := make([]byte, MaxDataMessageBytes)
	for {
		n, isString, err := raw.ReadDataChannel(buffer)
		if err != nil {
			if isOrdinaryClose(err) {
				return bridgeResult{reason: "remote-closed"}
			}
			return bridgeResult{reason: classifyBridgeReason("data-channel-read", err), err: err}
		}
		if isString {
			return bridgeResult{reason: "text-data-rejected", err: errors.New("text DataChannel messages are not accepted")}
		}
		if err := writeTCP(connection, buffer[:n]); err != nil {
			if isOrdinaryClose(err) {
				return bridgeResult{reason: "local-closed"}
			}
			return bridgeResult{reason: classifyBridgeReason("tcp-write", err), err: err}
		}
	}
}

func pumpTCPToRTC(connection net.Conn, raw detachedDataChannel) bridgeResult {
	buffer := make([]byte, DataChunkBytes)
	for {
		n, err := connection.Read(buffer)
		if n > 0 {
			if deadlineErr := raw.SetWriteDeadline(time.Now().Add(defaultIOTimeout)); deadlineErr != nil {
				return bridgeResult{reason: "data-channel-write", err: deadlineErr}
			}
			written, writeErr := raw.WriteDataChannel(buffer[:n], false)
			if writeErr != nil {
				if isOrdinaryClose(writeErr) {
					return bridgeResult{reason: "remote-closed"}
				}
				return bridgeResult{reason: classifyBridgeReason("data-channel-write", writeErr), err: writeErr}
			}
			if written != n {
				return bridgeResult{reason: "data-channel-write", err: io.ErrShortWrite}
			}
		}
		if err != nil {
			if isOrdinaryClose(err) {
				return bridgeResult{reason: "local-closed"}
			}
			return bridgeResult{reason: classifyBridgeReason("tcp-read", err), err: err}
		}
	}
}

func writeTCP(connection net.Conn, data []byte) error {
	if err := connection.SetWriteDeadline(time.Now().Add(defaultIOTimeout)); err != nil {
		return err
	}
	for len(data) > 0 {
		written, err := connection.Write(data)
		if err != nil {
			return err
		}
		if written == 0 {
			return io.ErrShortWrite
		}
		data = data[written:]
	}
	return nil
}

func classifyBridgeReason(operation string, err error) string {
	var networkError net.Error
	if errors.As(err, &networkError) && networkError.Timeout() {
		return "bridge-timeout"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "bridge-timeout"
	}
	return operation
}

func bridgeErrorCode(reason string) string {
	switch reason {
	case "bridge-timeout":
		return "bridge-timeout"
	case "local-connect-failed", "local-accept-failed":
		return "local-connect-failed"
	default:
		return "webrtc-failed"
	}
}

func isOrdinaryClose(err error) bool {
	return errors.Is(err, io.EOF) ||
		errors.Is(err, net.ErrClosed) ||
		errors.Is(err, io.ErrClosedPipe) ||
		errors.Is(err, context.Canceled)
}
