package rtcsidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

type terminalResult struct {
	reason string
	err    error
}

type deferredEvent struct {
	name   string
	fields map[string]any
}

type selectedPath struct {
	Relayed             bool   `json:"relayed"`
	Protocol            string `json:"protocol"`
	LocalCandidateType  string `json:"localCandidateType"`
	RemoteCandidateType string `json:"remoteCandidateType"`
}

type signalDescription struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type candidateWire struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type rtcSession struct {
	ctx            context.Context
	cancel         context.CancelFunc
	writer         *protocolWriter
	role           string
	pc             *webrtc.PeerConnection
	connectTimeout time.Duration

	mu                     sync.Mutex
	state                  string
	started                bool
	terminal               bool
	remoteDescriptionSet   bool
	remoteCandidatesEnded  bool
	localDescriptionSent   bool
	pendingRemote          []webrtc.ICECandidateInit
	pendingLocal           []any
	bridges                []*channelBridge
	bridgesByMapping       map[string]*channelBridge
	bridgesByLabel         map[string]*channelBridge
	terminalBridgeCount    int
	bridgeFailure          error
	connectTimer           *time.Timer
	terminalChannel        chan terminalResult
	terminalOnce           sync.Once
	remoteDescriptionMutex sync.Mutex
	localSignalMutex       sync.Mutex
	eventMutex             sync.Mutex
	eventBarrier           bool
	eventOverflow          bool
	deferredEvents         []deferredEvent
}

func newRTCSession(parent context.Context, config *validatedStart, writer *protocolWriter) (*rtcSession, error) {
	ctx, cancel := context.WithCancel(parent)
	settings := webrtc.SettingEngine{}
	settings.DetachDataChannels()
	settings.EnableDataChannelBlockWrite(true)
	settings.SetSCTPMaxReceiveBufferSize(maxSCTPReceiveBuffer)
	settings.SetSCTPMaxMessageSize(MaxDataMessageBytes)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settings))
	peerConnection, err := api.NewPeerConnection(config.rtc)
	if err != nil {
		cancel()
		return nil, fmt.Errorf("create PeerConnection: %w", err)
	}
	session := &rtcSession{
		ctx:              ctx,
		cancel:           cancel,
		writer:           writer,
		role:             config.role,
		pc:               peerConnection,
		connectTimeout:   config.connectTimeout,
		state:            "new",
		bridgesByMapping: make(map[string]*channelBridge, len(config.channels)),
		bridgesByLabel:   make(map[string]*channelBridge, len(config.channels)),
		terminalChannel:  make(chan terminalResult, 1),
	}

	for _, channelConfig := range config.channels {
		bridge, bridgeErr := newChannelBridge(ctx, session, channelConfig)
		if bridgeErr != nil {
			session.closeResources()
			return nil, bridgeErr
		}
		session.bridges = append(session.bridges, bridge)
		session.bridgesByMapping[channelConfig.mapping] = bridge
		session.bridgesByLabel[channelConfig.label] = bridge
	}

	peerConnection.OnICECandidate(session.onLocalCandidate)
	peerConnection.OnConnectionStateChange(session.onConnectionState)
	peerConnection.OnDataChannel(session.onRemoteDataChannel)

	if session.role == "offerer" {
		ordered := true
		negotiated := false
		for _, bridge := range session.bridges {
			protocol := bridge.config.protocol
			channel, channelErr := peerConnection.CreateDataChannel(bridge.config.label, &webrtc.DataChannelInit{
				Ordered:    &ordered,
				Protocol:   &protocol,
				Negotiated: &negotiated,
			})
			if channelErr != nil {
				session.closeResources()
				return nil, fmt.Errorf("create DataChannel for mapping %s: %w", bridge.config.mapping, channelErr)
			}
			if channelErr = bridge.attachDataChannel(channel); channelErr != nil {
				session.closeResources()
				return nil, fmt.Errorf("attach DataChannel for mapping %s: %w", bridge.config.mapping, channelErr)
			}
		}
	}

	return session, nil
}

func (s *rtcSession) startResult() map[string]any {
	channels := make([]map[string]any, 0, len(s.bridges))
	for _, bridge := range s.bridges {
		channels = append(channels, bridge.result())
	}
	return map[string]any{
		"role":     s.role,
		"channels": channels,
	}
}

func (s *rtcSession) start() {
	s.mu.Lock()
	if s.started || s.terminal {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.state = "starting"
	if s.connectTimeout > 0 {
		s.connectTimer = time.AfterFunc(s.connectTimeout, func() {
			s.fail("webrtc-timeout", fmt.Errorf("WebRTC connection timed out after %s", s.connectTimeout))
		})
	}
	s.mu.Unlock()
	s.emitState()
	for _, bridge := range s.bridges {
		bridge.start()
	}
	if s.role == "answerer" {
		s.setState("connecting")
		return
	}
	go func() {
		offer, err := s.pc.CreateOffer(nil)
		if err != nil {
			s.fail("webrtc-failed", fmt.Errorf("create offer: %w", err))
			return
		}
		if err = s.pc.SetLocalDescription(offer); err != nil {
			s.fail("webrtc-failed", fmt.Errorf("set local offer: %w", err))
			return
		}
		if err = s.publishLocalDescription(signalDescription{Type: "offer", SDP: offer.SDP}); err != nil {
			s.fail("webrtc-failed", err)
			return
		}
		s.setState("connecting")
	}()
}

func (s *rtcSession) applySignal(raw json.RawMessage) (func() error, *protocolError) {
	if len(raw) == 0 || len(raw) > MaxControlBytes {
		return nil, newProtocolError("signal-invalid", "signal message is missing or too large", false, nil)
	}
	if err := validateJSON(raw); err != nil {
		return nil, newProtocolError("signal-invalid", "signal message is not strict JSON", false, err)
	}
	var kind struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(raw, &kind); err != nil {
		return nil, newProtocolError("signal-invalid", "invalid signal envelope", false, err)
	}
	switch kind.Type {
	case "description":
		return s.applyRemoteDescription(raw)
	case "candidate":
		return nil, s.applyRemoteCandidate(raw)
	default:
		return nil, newProtocolError("signal-invalid", "signal type must be description or candidate", false, nil)
	}
}

func (s *rtcSession) applyRemoteDescription(raw json.RawMessage) (func() error, *protocolError) {
	var envelope struct {
		Type        string            `json:"type"`
		Description signalDescription `json:"description"`
	}
	if err := strictDecode(raw, &envelope); err != nil {
		return nil, newProtocolError("signal-invalid", "invalid description signal", false, err)
	}
	expected := "answer"
	if s.role == "answerer" {
		expected = "offer"
	}
	if envelope.Description.Type != expected {
		return nil, newProtocolError("signal-invalid", fmt.Sprintf("expected %s description", expected), false, nil)
	}
	if len([]byte(envelope.Description.SDP)) == 0 || len([]byte(envelope.Description.SDP)) > MaxSDPBytes {
		return nil, newProtocolError("limit-exceeded", "SDP is empty or exceeds its size limit", false, nil)
	}

	s.remoteDescriptionMutex.Lock()
	defer s.remoteDescriptionMutex.Unlock()
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return nil, newProtocolError("invalid-state", "session is closed", false, nil)
	}
	if s.remoteDescriptionSet {
		s.mu.Unlock()
		return nil, newProtocolError("invalid-state", "remote description was already applied", false, nil)
	}
	s.mu.Unlock()

	descriptionType := webrtc.SDPTypeAnswer
	if expected == "offer" {
		descriptionType = webrtc.SDPTypeOffer
	}
	if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: descriptionType,
		SDP:  envelope.Description.SDP,
	}); err != nil {
		protocolErr := newProtocolError("signal-apply-failed", "failed to apply remote description", false, err)
		return nil, protocolErr
	}
	s.mu.Lock()
	s.remoteDescriptionSet = true
	pending := append([]webrtc.ICECandidateInit(nil), s.pendingRemote...)
	s.pendingRemote = nil
	s.mu.Unlock()
	for _, candidate := range pending {
		if err := s.pc.AddICECandidate(candidate); err != nil {
			protocolErr := newProtocolError("signal-apply-failed", "failed to apply queued ICE candidate", false, err)
			return nil, protocolErr
		}
	}
	if s.role != "answerer" {
		return nil, nil
	}
	answer, err := s.pc.CreateAnswer(nil)
	if err != nil {
		protocolErr := newProtocolError("webrtc-failed", "failed to create answer", false, err)
		return nil, protocolErr
	}
	if err = s.pc.SetLocalDescription(answer); err != nil {
		protocolErr := newProtocolError("webrtc-failed", "failed to set local answer", false, err)
		return nil, protocolErr
	}
	description := signalDescription{Type: "answer", SDP: answer.SDP}
	return func() error { return s.publishLocalDescription(description) }, nil
}

func (s *rtcSession) applyRemoteCandidate(raw json.RawMessage) *protocolError {
	var envelope struct {
		Type      string          `json:"type"`
		Candidate json.RawMessage `json:"candidate"`
	}
	if err := strictDecode(raw, &envelope); err != nil {
		return newProtocolError("signal-invalid", "invalid candidate signal", false, err)
	}
	if len(envelope.Candidate) == 0 || len(envelope.Candidate) > MaxCandidateBytes {
		return newProtocolError("limit-exceeded", "ICE candidate exceeds its size limit", false, nil)
	}
	var candidate webrtc.ICECandidateInit
	isEndMarker := bytes.Equal(bytes.TrimSpace(envelope.Candidate), []byte("null"))
	if isEndMarker {
		candidate = webrtc.ICECandidateInit{}
	} else {
		var wire candidateWire
		if err := strictDecode(envelope.Candidate, &wire); err != nil {
			return newProtocolError("signal-invalid", "invalid ICE candidate", false, err)
		}
		if wire.Candidate == "" {
			return newProtocolError("signal-invalid", "empty ICE candidate must use null end marker", false, nil)
		}
		candidate = webrtc.ICECandidateInit{
			Candidate:        wire.Candidate,
			SDPMid:           wire.SDPMid,
			SDPMLineIndex:    wire.SDPMLineIndex,
			UsernameFragment: wire.UsernameFragment,
		}
	}
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return newProtocolError("invalid-state", "session is closed", false, nil)
	}
	if s.remoteCandidatesEnded {
		s.mu.Unlock()
		return newProtocolError("signal-invalid", "ICE candidate followed the end-of-candidates marker", false, nil)
	}
	if isEndMarker {
		s.remoteCandidatesEnded = true
	}
	if !s.remoteDescriptionSet {
		if len(s.pendingRemote) >= MaxPendingCandidates {
			s.mu.Unlock()
			err := newProtocolError("limit-exceeded", "too many ICE candidates before remote description", false, nil)
			return err
		}
		s.pendingRemote = append(s.pendingRemote, candidate)
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	if err := s.pc.AddICECandidate(candidate); err != nil {
		protocolErr := newProtocolError("signal-apply-failed", "failed to apply ICE candidate", false, err)
		return protocolErr
	}
	return nil
}

func (s *rtcSession) onLocalCandidate(candidate *webrtc.ICECandidate) {
	var value any
	if candidate == nil {
		value = nil
	} else {
		value = candidate.ToJSON()
	}
	s.localSignalMutex.Lock()
	defer s.localSignalMutex.Unlock()
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return
	}
	if !s.localDescriptionSent {
		if len(s.pendingLocal) >= MaxPendingCandidates {
			s.mu.Unlock()
			go s.fail("limit-exceeded", errors.New("too many local ICE candidates before description publication"))
			return
		}
		s.pendingLocal = append(s.pendingLocal, value)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	if err := s.emitSignal(map[string]any{"type": "candidate", "candidate": value}); err != nil {
		go s.fail("webrtc-failed", fmt.Errorf("emit ICE candidate: %w", err))
	}
}

func (s *rtcSession) publishLocalDescription(description signalDescription) error {
	s.localSignalMutex.Lock()
	defer s.localSignalMutex.Unlock()
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return errors.New("session closed before local description publication")
	}
	if s.localDescriptionSent {
		s.mu.Unlock()
		return errors.New("local description was already published")
	}
	s.localDescriptionSent = true
	pending := append([]any(nil), s.pendingLocal...)
	s.pendingLocal = nil
	s.mu.Unlock()
	if err := s.emitSignal(map[string]any{
		"type":        "description",
		"description": description,
	}); err != nil {
		return err
	}
	for _, candidate := range pending {
		if err := s.emitSignal(map[string]any{"type": "candidate", "candidate": candidate}); err != nil {
			return err
		}
	}
	return nil
}

func (s *rtcSession) emitSignal(message map[string]any) error {
	return s.writeEvent("signal", map[string]any{"message": message})
}

func (s *rtcSession) onRemoteDataChannel(channel *webrtc.DataChannel) {
	if s.role != "answerer" {
		_ = channel.Close()
		s.fail("unexpected-channel", errors.New("offerer received an unexpected remote DataChannel"))
		return
	}
	s.mu.Lock()
	bridge := s.bridgesByLabel[channel.Label()]
	s.mu.Unlock()
	if bridge == nil {
		_ = channel.Close()
		s.fail("unexpected-channel", errors.New("remote DataChannel is not allowlisted"))
		return
	}
	if err := bridge.attachDataChannel(channel); err != nil {
		_ = channel.Close()
		s.fail("unexpected-channel", err)
	}
}

func (s *rtcSession) onConnectionState(state webrtc.PeerConnectionState) {
	switch state {
	case webrtc.PeerConnectionStateConnected:
		s.mu.Lock()
		if s.connectTimer != nil {
			s.connectTimer.Stop()
			s.connectTimer = nil
		}
		s.mu.Unlock()
		s.setState("connected")
		if path := s.selectedPath(); path != nil {
			s.emit("path", map[string]any{"path": path})
		}
	case webrtc.PeerConnectionStateDisconnected:
		s.setState("disconnected")
	case webrtc.PeerConnectionStateFailed:
		s.fail("webrtc-failed", errors.New("PeerConnection entered failed state"))
	case webrtc.PeerConnectionStateClosed:
		s.mu.Lock()
		terminal := s.terminal
		s.mu.Unlock()
		if !terminal {
			s.finish("closed", nil)
		}
	case webrtc.PeerConnectionStateConnecting:
		s.setState("connecting")
	}
}

func (s *rtcSession) selectedPath() *selectedPath {
	sctp := s.pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return nil
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return nil
	}
	return &selectedPath{
		Relayed:             pair.Local.Typ == webrtc.ICECandidateTypeRelay || pair.Remote.Typ == webrtc.ICECandidateTypeRelay,
		Protocol:            pair.Local.Protocol.String(),
		LocalCandidateType:  pair.Local.Typ.String(),
		RemoteCandidateType: pair.Remote.Typ.String(),
	}
}

func (s *rtcSession) setState(state string) {
	s.mu.Lock()
	if s.terminal || s.state == state {
		s.mu.Unlock()
		return
	}
	s.state = state
	s.mu.Unlock()
	s.emitState()
}

func (s *rtcSession) emitState() {
	s.mu.Lock()
	state := s.state
	s.mu.Unlock()
	s.emit("session.state", map[string]any{"state": state})
}

func (s *rtcSession) emit(event string, fields map[string]any) {
	if err := s.writeEvent(event, fields); err != nil {
		go s.fail("internal", fmt.Errorf("write control event: %w", err))
	}
}

func (s *rtcSession) beginEventBarrier() error {
	s.eventMutex.Lock()
	defer s.eventMutex.Unlock()
	if s.eventBarrier {
		return errors.New("event barrier is already active")
	}
	s.eventBarrier = true
	s.eventOverflow = false
	s.deferredEvents = nil
	return nil
}

func (s *rtcSession) writeEvent(name string, fields map[string]any) error {
	s.eventMutex.Lock()
	if s.eventBarrier {
		if len(s.deferredEvents) >= 1024 {
			s.eventOverflow = true
			s.eventMutex.Unlock()
			return nil
		}
		s.deferredEvents = append(s.deferredEvents, deferredEvent{name: name, fields: fields})
		s.eventMutex.Unlock()
		return nil
	}
	s.eventMutex.Unlock()
	return s.writer.event(name, fields)
}

func (s *rtcSession) endEventBarrier() error {
	for {
		s.eventMutex.Lock()
		if !s.eventBarrier {
			s.eventMutex.Unlock()
			return errors.New("event barrier is not active")
		}
		if len(s.deferredEvents) == 0 {
			overflow := s.eventOverflow
			s.eventBarrier = false
			s.eventOverflow = false
			s.eventMutex.Unlock()
			if overflow {
				return errors.New("deferred control event limit exceeded")
			}
			return nil
		}
		batch := append([]deferredEvent(nil), s.deferredEvents...)
		s.deferredEvents = nil
		s.eventMutex.Unlock()
		for _, event := range batch {
			if err := s.writer.event(event.name, event.fields); err != nil {
				s.eventMutex.Lock()
				s.eventBarrier = false
				s.deferredEvents = nil
				s.eventMutex.Unlock()
				return err
			}
		}
	}
}

func (s *rtcSession) discardEventBarrier() {
	s.eventMutex.Lock()
	s.eventBarrier = false
	s.eventOverflow = false
	s.deferredEvents = nil
	s.eventMutex.Unlock()
}

func (s *rtcSession) bridgeFinished(_ *channelBridge, reason string, err error) {
	s.mu.Lock()
	if s.terminal {
		s.mu.Unlock()
		return
	}
	s.terminalBridgeCount++
	if err != nil && s.bridgeFailure == nil {
		s.bridgeFailure = &protocolError{
			Code:    bridgeErrorCode(reason),
			Message: safeErrorMessage(bridgeErrorCode(reason)),
			Fatal:   true,
			cause:   err,
		}
	}
	allFinished := s.terminalBridgeCount == len(s.bridges)
	bridgeFailure := s.bridgeFailure
	s.mu.Unlock()
	if allFinished {
		if bridgeFailure != nil {
			s.finish("failed", bridgeFailure)
		} else {
			s.finish("all-channels-closed", nil)
		}
	}
}

func (s *rtcSession) bridge(mapping string) *channelBridge {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bridgesByMapping[mapping]
}

func (s *rtcSession) isTerminal() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.terminal
}

func (s *rtcSession) status() map[string]any {
	s.mu.Lock()
	state := s.state
	terminal := s.terminal
	s.mu.Unlock()
	channels := make([]map[string]any, 0, len(s.bridges))
	for _, bridge := range s.bridges {
		channels = append(channels, bridge.status())
	}
	result := map[string]any{
		"role":     s.role,
		"state":    state,
		"terminal": terminal,
		"channels": channels,
	}
	if path := s.selectedPath(); path != nil {
		result["path"] = path
	}
	return result
}

func (s *rtcSession) fail(code string, err error) {
	if err == nil {
		err = errors.New("WebRTC session failed")
	}
	s.finish("failed", &protocolError{Code: code, Message: safeErrorMessage(code), Fatal: true, cause: err})
}

func (s *rtcSession) finish(reason string, err error) {
	s.terminalOnce.Do(func() {
		s.mu.Lock()
		s.terminal = true
		if err != nil {
			s.state = "failed"
		} else {
			s.state = "closed"
		}
		if s.connectTimer != nil {
			s.connectTimer.Stop()
			s.connectTimer = nil
		}
		s.mu.Unlock()
		s.emitState()
		s.cancel()
		for _, bridge := range s.bridges {
			bridge.finish("session-closed", nil)
		}
		_ = s.pc.Close()
		s.terminalChannel <- terminalResult{reason: reason, err: err}
	})
}

func (s *rtcSession) closeResources() {
	s.terminalOnce.Do(func() {
		s.mu.Lock()
		s.terminal = true
		if s.connectTimer != nil {
			s.connectTimer.Stop()
			s.connectTimer = nil
		}
		s.mu.Unlock()
		s.cancel()
		for _, bridge := range s.bridges {
			bridge.abortSilently()
		}
		_ = s.pc.Close()
	})
}

func strictDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON content")
		}
		return err
	}
	return nil
}

func sanitizeError(code string, err error) map[string]any {
	return map[string]any{
		"code":    code,
		"message": safeErrorMessage(code),
	}
}

func safeErrorMessage(code string) string {
	switch code {
	case "webrtc-timeout":
		return "WebRTC connection timed out"
	case "unexpected-channel":
		return "remote DataChannel violated the configured channel policy"
	case "local-connect-failed":
		return "local TCP connection failed"
	case "bridge-timeout":
		return "byte bridge timed out"
	case "cancelled":
		return "session was cancelled"
	case "limit-exceeded":
		return "session resource limit exceeded"
	case "signal-invalid":
		return "invalid WebRTC signal"
	case "signal-apply-failed":
		return "failed to apply WebRTC signal"
	case "internal":
		return "internal sidecar failure"
	default:
		return "WebRTC session failed"
	}
}
