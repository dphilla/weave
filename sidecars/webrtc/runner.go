package rtcsidecar

import (
	"context"
	"errors"
	"fmt"
	"io"
)

// ExitError is returned after the protocol has emitted a terminal failure.
// It deliberately contains only a stable code; sensitive SDP, candidates, and
// TURN credentials are never exposed through process diagnostics.
type ExitError struct {
	Code string
}

func (e *ExitError) Error() string { return "WebRTC sidecar failed: " + e.Code }

type lineResult struct {
	record []byte
	err    error
}

// Run serves one WebRTC session over bounded NDJSON control streams. The
// caller owns input and output; canceling ctx or ending input closes the
// session. A Run invocation is intentionally single-use.
func Run(ctx context.Context, input io.Reader, output io.Writer) error {
	if ctx == nil {
		return errors.New("context is required")
	}
	if input == nil || output == nil {
		return errors.New("control input and output are required")
	}
	writer := newProtocolWriter(output)
	if err := writer.ready(); err != nil {
		return fmt.Errorf("write ready event: %w", err)
	}
	readerContext, cancelReader := context.WithCancel(ctx)
	defer cancelReader()
	lines := make(chan lineResult, 1)
	go readControlLines(readerContext, input, lines)

	var session *rtcSession
	defer func() {
		if session != nil {
			session.closeResources()
		}
	}()
	var terminal <-chan terminalResult
	contextDone := ctx.Done()
	requestIDs := make(map[string]struct{})
	for {
		select {
		case <-contextDone:
			contextDone = nil
			if session != nil {
				cancelReader()
				lines = nil
				session.finish("cancelled", nil)
				continue
			}
			return writeClosed(writer, terminalResult{reason: "cancelled"})
		case result := <-terminal:
			cancelReader()
			if err := writeClosed(writer, result); err != nil {
				return err
			}
			if result.err != nil {
				return &ExitError{Code: terminalErrorCode(result.err)}
			}
			return nil
		case line, ok := <-lines:
			if !ok {
				lines = nil
				if session != nil {
					session.finish("control-eof", nil)
					continue
				}
				return writeClosed(writer, terminalResult{reason: "control-eof"})
			}
			if session != nil && session.isTerminal() {
				cancelReader()
				lines = nil
				continue
			}
			if line.err != nil {
				lines = nil
				if errors.Is(line.err, io.EOF) {
					if session != nil {
						session.finish("control-eof", nil)
						continue
					}
					return writeClosed(writer, terminalResult{reason: "control-eof"})
				}
				if session != nil {
					cancelReader()
					lines = nil
					session.fail("invalid-message", line.err)
					continue
				}
				protocolErr := asProtocolError(line.err, "invalid-message", true)
				if err := writeClosed(writer, terminalResult{reason: "failed", err: protocolErr}); err != nil {
					return err
				}
				return &ExitError{Code: protocolErr.Code}
			}

			request, protocolErr := decodeRequest(line.record)
			if request != nil && requestIDPattern.MatchString(request.base.ID) {
				if _, duplicate := requestIDs[request.base.ID]; duplicate {
					duplicateErr := newProtocolError("invalid-message", "duplicate request id", false, nil)
					if err := writer.errorResponse(request.base.ID, duplicateErr); err != nil {
						return err
					}
					continue
				}
				if len(requestIDs) >= 4096 {
					limitErr := newProtocolError("limit-exceeded", "too many control requests", true, nil)
					if err := writer.errorResponse(request.base.ID, limitErr); err != nil {
						return err
					}
					if session != nil {
						cancelReader()
						lines = nil
						session.fail(limitErr.Code, limitErr)
						continue
					}
					if err := writeClosed(writer, terminalResult{reason: "failed", err: limitErr}); err != nil {
						return err
					}
					return &ExitError{Code: limitErr.Code}
				}
				requestIDs[request.base.ID] = struct{}{}
			}
			if protocolErr != nil {
				if request != nil && requestIDPattern.MatchString(request.base.ID) {
					if err := writer.errorResponse(request.base.ID, protocolErr); err != nil {
						return err
					}
				}
				if protocolErr.Fatal {
					if session != nil {
						cancelReader()
						lines = nil
						session.fail(protocolErr.Code, protocolErr)
						continue
					}
					if err := writeClosed(writer, terminalResult{reason: "failed", err: protocolErr}); err != nil {
						return err
					}
					return &ExitError{Code: protocolErr.Code}
				}
				continue
			}

			switch request.base.Command {
			case "start":
				if session != nil {
					if err := writer.errorResponse(request.base.ID, newProtocolError(
						"invalid-state", "session was already started", false, nil,
					)); err != nil {
						return err
					}
					continue
				}
				validated, validationErr := validateStart(request.start)
				if validationErr != nil {
					if err := writer.errorResponse(request.base.ID, validationErr); err != nil {
						return err
					}
					continue
				}
				created, err := newRTCSession(ctx, validated, writer)
				if err != nil {
					startErr := newProtocolError("webrtc-failed", "failed to initialize WebRTC session", false, err)
					if writeErr := writer.errorResponse(request.base.ID, startErr); writeErr != nil {
						return writeErr
					}
					continue
				}
				session = created
				terminal = session.terminalChannel
				if err := writer.response(request.base.ID, session.startResult()); err != nil {
					session.finish("failed", newProtocolError("internal", "control output failed", true, err))
					return err
				}
				// Negotiation and bridge activity cannot produce events before the
				// successful start response above has been completely written.
				session.start()

			case "signal":
				if session == nil {
					if err := writer.errorResponse(request.base.ID, newProtocolError(
						"invalid-state", "start must succeed before signal", false, nil,
					)); err != nil {
						return err
					}
					continue
				}
				if err := session.beginEventBarrier(); err != nil {
					barrierErr := newProtocolError("internal", "failed to serialize signaling events", false, err)
					if writeErr := writer.errorResponse(request.base.ID, barrierErr); writeErr != nil {
						return writeErr
					}
					cancelReader()
					lines = nil
					session.fail(barrierErr.Code, barrierErr)
					continue
				}
				afterResponse, signalErr := session.applySignal(request.signal.Message)
				if signalErr != nil {
					// Signaling mutates PeerConnection state incrementally. Any rejected
					// signal therefore fails the v0.1 session closed rather than claiming
					// that a partially applied negotiation remains reusable.
					signalErr.Fatal = true
					if err := writer.errorResponse(request.base.ID, signalErr); err != nil {
						session.discardEventBarrier()
						session.closeResources()
						return err
					}
					if err := session.endEventBarrier(); err != nil {
						session.closeResources()
						return err
					}
					// Invalid or unappliable signaling is terminal, but only after
					// the triggering request's response is observable.
					cancelReader()
					lines = nil
					session.fail(signalErr.Code, signalErr)
					continue
				}
				if err := writer.response(request.base.ID, nil); err != nil {
					session.discardEventBarrier()
					session.closeResources()
					return err
				}
				var publicationErr error
				if afterResponse != nil {
					if err := afterResponse(); err != nil {
						publicationErr = err
					}
				}
				if err := session.endEventBarrier(); err != nil {
					cancelReader()
					lines = nil
					session.fail("internal", err)
					continue
				}
				if publicationErr != nil {
					cancelReader()
					lines = nil
					session.fail("webrtc-failed", publicationErr)
					continue
				}

			case "status":
				if session == nil {
					if err := writer.errorResponse(request.base.ID, newProtocolError(
						"invalid-state", "start must succeed before status", false, nil,
					)); err != nil {
						return err
					}
					continue
				}
				if err := writer.response(request.base.ID, session.status()); err != nil {
					return err
				}

			case "channel.close":
				if session == nil {
					if err := writer.errorResponse(request.base.ID, newProtocolError(
						"invalid-state", "start must succeed before channel.close", false, nil,
					)); err != nil {
						return err
					}
					continue
				}
				bridge := session.bridge(request.closeChannel.Mapping)
				if bridge == nil {
					if err := writer.errorResponse(request.base.ID, newProtocolError(
						"invalid-message", "unknown channel mapping", false, nil,
					)); err != nil {
						return err
					}
					continue
				}
				if err := writer.response(request.base.ID, nil); err != nil {
					return err
				}
				bridge.finish("local-close", nil)
				if session.isTerminal() {
					cancelReader()
					lines = nil
				}

			case "close":
				if err := writer.response(request.base.ID, nil); err != nil {
					return err
				}
				if session != nil {
					cancelReader()
					lines = nil
					session.finish("closed", nil)
					continue
				}
				return writeClosed(writer, terminalResult{reason: "closed"})
			}
		}
	}
}

func readControlLines(ctx context.Context, input io.Reader, results chan<- lineResult) {
	defer close(results)
	reader := newLineReader(input)
	for {
		record, err := reader.read()
		select {
		case results <- lineResult{record: record, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func writeClosed(writer *protocolWriter, result terminalResult) error {
	fields := map[string]any{"reason": result.reason}
	if result.err != nil {
		fields["error"] = sanitizeError(terminalErrorCode(result.err), result.err)
	}
	return writer.finalEvent("closed", fields)
}

func terminalErrorCode(err error) string {
	var protocolErr *protocolError
	if errors.As(err, &protocolErr) && protocolErr.Code != "" {
		return protocolErr.Code
	}
	return "internal"
}

func asProtocolError(err error, code string, fatal bool) *protocolError {
	var protocolErr *protocolError
	if errors.As(err, &protocolErr) {
		return protocolErr
	}
	return newProtocolError(code, safeErrorMessage(code), fatal, err)
}
