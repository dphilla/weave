// Headless, application-neutral setup for one initial WebRTC DataChannel
// session. Signaling transport, application protocols, byte adaptation, and UI
// policy are deliberately injected or left to the caller.

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_PENDING_CANDIDATES = 256;
export const DEFAULT_MAX_SDP_BYTES = 256 * 1024;
export const DEFAULT_MAX_CANDIDATE_BYTES = 16 * 1024;

const DESCRIPTION_KEYS = new Set(["type", "sdp"]);
const CANDIDATE_KEYS = new Set([
  "candidate",
  "sdpMid",
  "sdpMLineIndex",
  "usernameFragment",
]);

export class WebRTCSessionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "WebRTCSessionError";
    this.code = options.code ?? "ERR_WEBRTC_SESSION";
    this.phase = options.phase ?? "session";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function sessionError(value, fallback, { code, phase } = {}) {
  if (value instanceof WebRTCSessionError) return value;
  const message = value instanceof Error && value.message
    ? `${fallback}: ${value.message}`
    : value === undefined || value === null
      ? fallback
      : `${fallback}: ${String(value)}`;
  return new WebRTCSessionError(message, {
    code,
    phase,
    cause: value,
  });
}

function requireObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} must be a function`);
}

function nonNegativeFinite(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function abortError() {
  return new WebRTCSessionError("WebRTC session was aborted", {
    code: "ERR_WEBRTC_SESSION_ABORTED",
    phase: "abort",
  });
}

function closedBeforeConnectedError() {
  return new WebRTCSessionError("WebRTC session closed before connecting", {
    code: "ERR_WEBRTC_SESSION_CLOSED",
    phase: "close",
  });
}

function addListener(target, type, listener) {
  requireFunction(target?.addEventListener, "RTCPeerConnection.addEventListener");
  requireFunction(target?.removeEventListener, "RTCPeerConnection.removeEventListener");
  target.addEventListener(type, listener);
  return () => target.removeEventListener(type, listener);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function descriptionInit(value, expectedType, maxSdpBytes) {
  const init = typeof value?.toJSON === "function" ? value.toJSON() : value;
  requireObject(init, "session description");
  if (!hasOnlyKeys(init, DESCRIPTION_KEYS)) {
    throw new WebRTCSessionError("session description contains unsupported fields", {
      code: "ERR_WEBRTC_SIGNAL_DESCRIPTION",
      phase: "signal-apply",
    });
  }
  if (init.type !== expectedType || typeof init.sdp !== "string") {
    throw new WebRTCSessionError(`expected a WebRTC ${expectedType} description`, {
      code: "ERR_WEBRTC_SIGNAL_DESCRIPTION",
      phase: "signal-apply",
    });
  }
  if (utf8Length(init.sdp) > maxSdpBytes) {
    throw new WebRTCSessionError(
      `session description exceeds the ${maxSdpBytes} byte SDP limit`,
      { code: "ERR_WEBRTC_SIGNAL_LIMIT", phase: "signal-apply" },
    );
  }
  return { type: init.type, sdp: init.sdp };
}

function candidateInit(value, maxCandidateBytes) {
  if (value === null) return null;
  const init = typeof value?.toJSON === "function" ? value.toJSON() : value;
  requireObject(init, "ICE candidate");
  if (!hasOnlyKeys(init, CANDIDATE_KEYS) || typeof init.candidate !== "string") {
    throw new WebRTCSessionError("invalid ICE candidate", {
      code: "ERR_WEBRTC_SIGNAL_CANDIDATE",
      phase: "signal-apply",
    });
  }
  if (init.sdpMid !== undefined && init.sdpMid !== null && typeof init.sdpMid !== "string") {
    throw new WebRTCSessionError("ICE candidate sdpMid must be a string or null", {
      code: "ERR_WEBRTC_SIGNAL_CANDIDATE",
      phase: "signal-apply",
    });
  }
  if (
    init.sdpMLineIndex !== undefined &&
    init.sdpMLineIndex !== null &&
    (!Number.isSafeInteger(init.sdpMLineIndex) || init.sdpMLineIndex < 0)
  ) {
    throw new WebRTCSessionError(
      "ICE candidate sdpMLineIndex must be a non-negative safe integer or null",
      { code: "ERR_WEBRTC_SIGNAL_CANDIDATE", phase: "signal-apply" },
    );
  }
  if (
    init.usernameFragment !== undefined &&
    init.usernameFragment !== null &&
    typeof init.usernameFragment !== "string"
  ) {
    throw new WebRTCSessionError(
      "ICE candidate usernameFragment must be a string or null",
      { code: "ERR_WEBRTC_SIGNAL_CANDIDATE", phase: "signal-apply" },
    );
  }

  let serialized;
  try { serialized = JSON.stringify(init); }
  catch (error) {
    throw sessionError(error, "ICE candidate is not JSON-serializable", {
      code: "ERR_WEBRTC_SIGNAL_CANDIDATE",
      phase: "signal-apply",
    });
  }
  if (typeof serialized !== "string" || utf8Length(serialized) > maxCandidateBytes) {
    throw new WebRTCSessionError(
      `ICE candidate exceeds the ${maxCandidateBytes} byte limit`,
      { code: "ERR_WEBRTC_SIGNAL_LIMIT", phase: "signal-apply" },
    );
  }

  const result = { candidate: init.candidate };
  for (const key of ["sdpMid", "sdpMLineIndex", "usernameFragment"]) {
    if (init[key] !== undefined) result[key] = init[key];
  }
  return result;
}

function validateSignalEnvelope(message, expectedDescriptionType, maxSdpBytes, maxCandidateBytes) {
  requireObject(message, "signaling message");
  if (message.type === "description") {
    if (!hasOnlyKeys(message, new Set(["type", "description"])) || !("description" in message)) {
      throw new WebRTCSessionError("invalid description signaling envelope", {
        code: "ERR_WEBRTC_SIGNAL_ENVELOPE",
        phase: "signal-apply",
      });
    }
    return {
      type: "description",
      description: descriptionInit(message.description, expectedDescriptionType, maxSdpBytes),
    };
  }
  if (message.type === "candidate") {
    if (!hasOnlyKeys(message, new Set(["type", "candidate"])) || !("candidate" in message)) {
      throw new WebRTCSessionError("invalid candidate signaling envelope", {
        code: "ERR_WEBRTC_SIGNAL_ENVELOPE",
        phase: "signal-apply",
      });
    }
    return {
      type: "candidate",
      candidate: candidateInit(message.candidate, maxCandidateBytes),
    };
  }
  throw new WebRTCSessionError("unknown WebRTC signaling message type", {
    code: "ERR_WEBRTC_SIGNAL_ENVELOPE",
    phase: "signal-apply",
  });
}

function validatePeerConnection(peerConnection) {
  requireObject(peerConnection, "RTCPeerConnection");
  for (const method of [
    "addEventListener",
    "removeEventListener",
    "createOffer",
    "createAnswer",
    "setLocalDescription",
    "setRemoteDescription",
    "addIceCandidate",
    "createDataChannel",
    "close",
  ]) {
    requireFunction(peerConnection[method], `RTCPeerConnection.${method}`);
  }
}

function validateDataChannel(channel) {
  if (channel === null || typeof channel !== "object") {
    throw new TypeError("RTCPeerConnection.createDataChannel returned an invalid channel");
  }
  if (typeof channel.label !== "string") {
    throw new TypeError("RTCDataChannel.label must be a string");
  }
  requireFunction(channel.close, "RTCDataChannel.close");
}

function connectionState(peerConnection) {
  return typeof peerConnection.connectionState === "string"
    ? peerConnection.connectionState
    : "new";
}

function iceConnectionState(peerConnection) {
  return typeof peerConnection.iceConnectionState === "string"
    ? peerConnection.iceConnectionState
    : "new";
}

/**
 * Establish one initial, DataChannel-only WebRTC session. The caller forwards
 * received signaling messages to receiveSignal() and supplies sendSignal() for
 * outbound descriptions and trickled candidates.
 */
export class WebRTCSession {
  constructor(options) {
    requireObject(options, "options");
    if (options.role !== "offerer" && options.role !== "answerer") {
      throw new TypeError('options.role must be "offerer" or "answerer"');
    }
    requireFunction(options.sendSignal, "options.sendSignal");

    for (const name of ["onDataChannel", "onStateChange", "onIceCandidateError", "onError"]) {
      if (options[name] !== undefined) requireFunction(options[name], `options.${name}`);
    }

    this.role = options.role;
    this.connectTimeoutMs = nonNegativeFinite(
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      "options.connectTimeoutMs",
    );
    this.maxPendingCandidates = positiveSafeInteger(
      options.maxPendingCandidates ?? DEFAULT_MAX_PENDING_CANDIDATES,
      "options.maxPendingCandidates",
    );
    this.maxSdpBytes = positiveSafeInteger(
      options.maxSdpBytes ?? DEFAULT_MAX_SDP_BYTES,
      "options.maxSdpBytes",
    );
    this.maxCandidateBytes = positiveSafeInteger(
      options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES,
      "options.maxCandidateBytes",
    );
    this.state = "new";
    this.started = false;
    this.error = null;
    this.channels = new Map();

    this._sendSignalCallback = options.sendSignal;
    this._onDataChannel = options.onDataChannel ?? null;
    this._onStateChange = options.onStateChange ?? null;
    this._onIceCandidateErrorCallback = options.onIceCandidateError ?? null;
    this._onErrorCallback = options.onError ?? null;
    this._startPromise = null;
    this._sendTail = Promise.resolve();
    this._receiveTail = Promise.resolve();
    this._candidateDrain = null;
    this._pendingLocalCandidates = [];
    this._pendingRemoteCandidates = [];
    this._localDescriptionSent = false;
    this._remoteDescriptionApplied = false;
    this._terminal = false;
    this._connectedSettled = false;
    this._closedInfo = null;
    this._connectTimer = null;
    this._removeListeners = [];

    this._lifetimeController = new AbortController();
    this._externalSignal = options.signal ?? null;
    this._externalAbortListener = null;
    if (this._externalSignal !== null) {
      if (
        typeof this._externalSignal.aborted !== "boolean" ||
        typeof this._externalSignal.addEventListener !== "function" ||
        typeof this._externalSignal.removeEventListener !== "function"
      ) {
        throw new TypeError("options.signal must be an AbortSignal-like object");
      }
      this._externalAbortListener = () => {
        const reason = this._externalSignal.reason;
        const error = reason === undefined
          ? abortError()
          : sessionError(reason, "WebRTC session was aborted", {
            code: "ERR_WEBRTC_SESSION_ABORTED",
            phase: "abort",
          });
        this._fail(error, "abort");
      };
    }

    this.connected = new Promise((resolve, reject) => {
      this._resolveConnected = resolve;
      this._rejectConnected = reject;
    });
    // Avoid an unhandled-rejection report when a caller uses only state/error
    // callbacks. The public promise retains its original rejection behavior.
    void this.connected.catch(() => {});
    this.closed = new Promise((resolve) => { this._resolveClosed = resolve; });

    const Constructor = options.RTCPeerConnection ?? globalThis.RTCPeerConnection;
    if (typeof Constructor !== "function") {
      throw new TypeError("an RTCPeerConnection constructor is required");
    }
    this.peerConnection = new Constructor(options.rtcConfiguration);
    try { validatePeerConnection(this.peerConnection); }
    catch (error) {
      try { this.peerConnection?.close?.(); }
      catch { /* preserve the validation error */ }
      throw error;
    }

    this._handleIceCandidate = (event) => this._onIceCandidate(event);
    this._handleDataChannel = (event) => this._onRemoteDataChannel(event);
    this._handleConnectionChange = () => this._onConnectionStateChange();
    this._handleIceConnectionChange = () => this._onConnectionStateChange();
    this._handleIceCandidateError = (event) => this._onIceCandidateError(event);

    try {
      this._removeListeners.push(
        addListener(this.peerConnection, "icecandidate", this._handleIceCandidate),
        addListener(this.peerConnection, "datachannel", this._handleDataChannel),
        addListener(
          this.peerConnection,
          "connectionstatechange",
          this._handleConnectionChange,
        ),
        addListener(
          this.peerConnection,
          "iceconnectionstatechange",
          this._handleIceConnectionChange,
        ),
        addListener(
          this.peerConnection,
          "icecandidateerror",
          this._handleIceCandidateError,
        ),
      );
    } catch (error) {
      for (const remove of this._removeListeners.splice(0)) {
        try { remove(); } catch { /* constructor failure is already being reported */ }
      }
      try { this.peerConnection.close(); } catch { /* preserve the listener error */ }
      throw error;
    }

    if (this._externalSignal !== null) {
      if (this._externalSignal.aborted) queueMicrotask(this._externalAbortListener);
      else {
        this._externalSignal.addEventListener(
          "abort",
          this._externalAbortListener,
          { once: true },
        );
      }
    }
  }

  channel(label) {
    return this.channels.get(label);
  }

  createDataChannel(label, init = {}) {
    if (this.role !== "offerer") {
      throw new WebRTCSessionError("only an offerer may create a DataChannel", {
        code: "ERR_WEBRTC_SESSION_ROLE",
        phase: "data-channel",
      });
    }
    if (this.started) {
      throw new WebRTCSessionError("DataChannels must be created before start()", {
        code: "ERR_WEBRTC_SESSION_STATE",
        phase: "data-channel",
      });
    }
    if (typeof label !== "string") throw new TypeError("DataChannel label must be a string");
    requireObject(init, "DataChannel init");
    if (init.negotiated) {
      throw new WebRTCSessionError("negotiated DataChannels are not supported", {
        code: "ERR_WEBRTC_NEGOTIATED_CHANNEL",
        phase: "data-channel",
      });
    }
    if (this.channels.has(label)) {
      throw new WebRTCSessionError(`duplicate RTCDataChannel label ${label}`, {
        code: "ERR_WEBRTC_DUPLICATE_CHANNEL",
        phase: "data-channel",
      });
    }
    const channel = this.peerConnection.createDataChannel(label, init);
    this._registerDataChannel(channel, "local");
    return channel;
  }

  start() {
    if (this._startPromise !== null) return this._startPromise;
    if (this._terminal) return Promise.reject(this.error ?? closedBeforeConnectedError());

    this.started = true;
    this._setState("starting");
    if (this.connectTimeoutMs > 0) {
      this._connectTimer = setTimeout(() => {
        this._fail(new WebRTCSessionError(
          `WebRTC connection timed out after ${this.connectTimeoutMs} ms`,
          { code: "ERR_WEBRTC_CONNECT_TIMEOUT", phase: "connect-timeout" },
        ), "connect-timeout");
      }, this.connectTimeoutMs);
      this._connectTimer.unref?.();
    }

    const operation = Promise.resolve().then(async () => {
      if (this.role === "offerer") {
        const offer = await this.peerConnection.createOffer();
        this._throwIfTerminal();
        await this.peerConnection.setLocalDescription(offer);
        this._throwIfTerminal();
        await this._publishLocalDescription("offer");
      }
      this._throwIfTerminal();
      if (this.state !== "connected" && this.state !== "disconnected") {
        this._setState("connecting");
      }
      this._onConnectionStateChange();
      this._throwIfTerminal();
      return this;
    }).catch((error) => {
      if (!this._terminal) this._fail(error, error?.phase ?? "start");
      throw this.error ?? error;
    });
    void operation.catch(() => {});
    this._startPromise = operation;
    return operation;
  }

  receiveSignal(message) {
    if (!this.started) {
      return Promise.reject(new WebRTCSessionError(
        "start() must be called before receiveSignal()",
        { code: "ERR_WEBRTC_SESSION_STATE", phase: "signal-apply" },
      ));
    }
    if (this._terminal) return Promise.reject(this.error ?? closedBeforeConnectedError());

    const operation = this._receiveTail.then(async () => {
      await this._startPromise;
      this._throwIfTerminal();
      const expected = this.role === "offerer" ? "answer" : "offer";
      const signal = validateSignalEnvelope(
        message,
        expected,
        this.maxSdpBytes,
        this.maxCandidateBytes,
      );
      if (signal.type === "description") {
        await this._applyRemoteDescription(signal.description);
      } else {
        await this._applyRemoteCandidate(signal.candidate);
      }
    });
    this._receiveTail = operation.catch(() => {});
    return operation.catch((error) => {
      if (!this._terminal) this._fail(error, error?.phase ?? "signal-apply");
      throw this.error ?? error;
    });
  }

  fail(error) {
    return this._fail(error, error?.phase ?? "external");
  }

  close() {
    if (!this._terminal) this._settle("closed", null);
    return this.closed;
  }

  _throwIfTerminal() {
    if (this._terminal) throw this.error ?? closedBeforeConnectedError();
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    if (this._onStateChange === null) return;
    try {
      this._onStateChange({
        state,
        connectionState: connectionState(this.peerConnection),
        iceConnectionState: iceConnectionState(this.peerConnection),
        session: this,
      });
    } catch (error) {
      this._reportError(
        sessionError(error, "onStateChange callback failed", {
          code: "ERR_WEBRTC_CALLBACK",
          phase: "state-callback",
        }),
        false,
        "state-callback",
      );
    }
  }

  _reportError(error, fatal, phase) {
    if (this._onErrorCallback === null) return;
    try { this._onErrorCallback(error, { fatal, phase, session: this }); }
    catch { /* diagnostic callbacks never interrupt lifecycle cleanup */ }
  }

  _fail(value, phase) {
    if (this._terminal) return false;
    const error = sessionError(value, "WebRTC session failed", {
      code: "ERR_WEBRTC_SESSION",
      phase,
    });
    this._settle("failed", error);
    this._reportError(error, true, error.phase ?? phase);
    return true;
  }

  _settle(reason, error) {
    if (this._terminal) return this._closedInfo;
    this._terminal = true;
    this.error = error;
    if (this._connectTimer !== null) clearTimeout(this._connectTimer);
    this._connectTimer = null;

    if (this._externalSignal !== null && this._externalAbortListener !== null) {
      this._externalSignal.removeEventListener("abort", this._externalAbortListener);
    }
    for (const remove of this._removeListeners.splice(0)) {
      try { remove(); } catch { /* cleanup remains best-effort */ }
    }

    this._lifetimeController.abort();
    for (const channel of this.channels.values()) {
      try { channel.close(); }
      catch (closeError) {
        this._reportError(
          sessionError(closeError, `RTCDataChannel ${channel.label} close failed`, {
            code: "ERR_WEBRTC_CLOSE",
            phase: "close",
          }),
          false,
          "close",
        );
      }
    }
    try { this.peerConnection.close(); }
    catch (closeError) {
      this._reportError(
        sessionError(closeError, "RTCPeerConnection close failed", {
          code: "ERR_WEBRTC_CLOSE",
          phase: "close",
        }),
        false,
        "close",
      );
    }

    this._setState(reason);
    if (!this._connectedSettled) {
      this._connectedSettled = true;
      this._rejectConnected(error ?? closedBeforeConnectedError());
    }
    this._closedInfo = { reason, error };
    this._resolveClosed(this._closedInfo);
    return this._closedInfo;
  }

  _onConnectionStateChange() {
    if (this._terminal) return;
    const connection = connectionState(this.peerConnection);
    const ice = iceConnectionState(this.peerConnection);
    if (connection === "failed" || ice === "failed") {
      this._fail(new WebRTCSessionError("RTCPeerConnection failed", {
        code: "ERR_WEBRTC_PEER_CONNECTION",
        phase: "peer-connection",
      }), "peer-connection");
      return;
    }
    if (connection === "closed") {
      this._settle("closed", null);
      return;
    }
    if (connection === "connected" || (connection === "new" && (ice === "connected" || ice === "completed"))) {
      if (this._connectTimer !== null) clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this._setState("connected");
      if (!this._connectedSettled) {
        this._connectedSettled = true;
        this._resolveConnected(this);
      }
      return;
    }
    if (connection === "disconnected" || ice === "disconnected") {
      this._setState("disconnected");
      return;
    }
    if (this.started && this.state !== "starting") this._setState("connecting");
  }

  _onIceCandidateError(event) {
    if (this._terminal) return;
    if (this._onIceCandidateErrorCallback !== null) {
      try { this._onIceCandidateErrorCallback(event, { session: this }); }
      catch (error) {
        this._reportError(
          sessionError(error, "onIceCandidateError callback failed", {
            code: "ERR_WEBRTC_CALLBACK",
            phase: "ice-candidate-callback",
          }),
          false,
          "ice-candidate-callback",
        );
      }
    }
    const detail = event?.errorText || "ICE candidate gathering failed";
    this._reportError(new WebRTCSessionError(detail, {
      code: "ERR_WEBRTC_ICE_CANDIDATE",
      phase: "ice-candidate",
    }), false, "ice-candidate");
  }

  _registerDataChannel(channel, origin) {
    validateDataChannel(channel);
    if (channel.negotiated === true) {
      try { channel.close(); } catch { /* rejection is primary */ }
      throw new WebRTCSessionError("negotiated DataChannels are not supported", {
        code: "ERR_WEBRTC_NEGOTIATED_CHANNEL",
        phase: "data-channel",
      });
    }
    if (this.channels.has(channel.label)) {
      try { channel.close(); } catch { /* rejection is primary */ }
      throw new WebRTCSessionError(`duplicate RTCDataChannel label ${channel.label}`, {
        code: "ERR_WEBRTC_DUPLICATE_CHANNEL",
        phase: "data-channel",
      });
    }
    this.channels.set(channel.label, channel);
    if (this._onDataChannel !== null) {
      try { this._onDataChannel(channel, { origin, session: this }); }
      catch (error) {
        this._reportError(
          sessionError(error, "onDataChannel callback failed", {
            code: "ERR_WEBRTC_CALLBACK",
            phase: "data-channel-callback",
          }),
          false,
          "data-channel-callback",
        );
      }
    }
  }

  _onRemoteDataChannel(event) {
    if (this._terminal) {
      try { event?.channel?.close(); } catch { /* session already owns shutdown */ }
      return;
    }
    try { this._registerDataChannel(event?.channel, "remote"); }
    catch (value) {
      const error = sessionError(value, "could not register remote RTCDataChannel", {
        code: "ERR_WEBRTC_DATA_CHANNEL",
        phase: "data-channel",
      });
      // A peer can announce an unwanted or duplicate channel without making
      // the already-established session unusable. Reject only that channel.
      this._reportError(error, false, error.phase);
    }
  }

  _onIceCandidate(event) {
    if (this._terminal) return;
    let candidate;
    try {
      candidate = candidateInit(event?.candidate ?? null, this.maxCandidateBytes);
    } catch (error) {
      this._fail(error, "ice-candidate");
      return;
    }
    if (this._pendingLocalCandidates.length >= this.maxPendingCandidates) {
      this._fail(new WebRTCSessionError(
        `local ICE candidate queue exceeds ${this.maxPendingCandidates} entries`,
        { code: "ERR_WEBRTC_CANDIDATE_QUEUE", phase: "ice-candidate" },
      ), "ice-candidate");
      return;
    }
    this._pendingLocalCandidates.push(candidate);
    if (this._localDescriptionSent) {
      void this._drainLocalCandidates().catch((error) => {
        this._fail(error, error?.phase ?? "signal-send");
      });
    }
  }

  async _publishLocalDescription(expectedType) {
    const description = descriptionInit(
      this.peerConnection.localDescription,
      expectedType,
      this.maxSdpBytes,
    );
    await this._sendOutbound({ type: "description", description });
    this._throwIfTerminal();
    this._localDescriptionSent = true;
    await this._drainLocalCandidates();
  }

  _drainLocalCandidates() {
    if (!this._localDescriptionSent || this._terminal) return Promise.resolve();
    if (this._candidateDrain !== null) return this._candidateDrain;
    // Begin in a later microtask so `operation` is initialized before the
    // empty-queue path reaches its finally block.
    let operation;
    operation = Promise.resolve().then(async () => {
      try {
        while (this._pendingLocalCandidates.length > 0) {
          const candidate = this._pendingLocalCandidates.shift();
          await this._sendOutbound({ type: "candidate", candidate });
          this._throwIfTerminal();
        }
      } finally {
        if (this._candidateDrain === operation) this._candidateDrain = null;
      }
    });
    this._candidateDrain = operation;
    return operation;
  }

  _sendOutbound(message) {
    const operation = this._sendTail.then(async () => {
      this._throwIfTerminal();
      try {
        await this._sendSignalCallback(message, {
          signal: this._lifetimeController.signal,
        });
      } catch (error) {
        throw sessionError(error, "could not send WebRTC signaling message", {
          code: "ERR_WEBRTC_SIGNAL_SEND",
          phase: "signal-send",
        });
      }
      this._throwIfTerminal();
    });
    this._sendTail = operation.catch(() => {});
    return operation;
  }

  async _applyRemoteDescription(description) {
    if (this._remoteDescriptionApplied) {
      throw new WebRTCSessionError("a remote description has already been applied", {
        code: "ERR_WEBRTC_RENEGOTIATION_UNSUPPORTED",
        phase: "signal-apply",
      });
    }
    await this.peerConnection.setRemoteDescription(description);
    this._throwIfTerminal();
    this._remoteDescriptionApplied = true;
    while (this._pendingRemoteCandidates.length > 0) {
      const candidate = this._pendingRemoteCandidates.shift();
      await this.peerConnection.addIceCandidate(candidate);
      this._throwIfTerminal();
    }
    if (this.role === "answerer") {
      const answer = await this.peerConnection.createAnswer();
      this._throwIfTerminal();
      await this.peerConnection.setLocalDescription(answer);
      this._throwIfTerminal();
      await this._publishLocalDescription("answer");
    }
  }

  async _applyRemoteCandidate(candidate) {
    if (!this._remoteDescriptionApplied) {
      if (this._pendingRemoteCandidates.length >= this.maxPendingCandidates) {
        throw new WebRTCSessionError(
          `remote ICE candidate queue exceeds ${this.maxPendingCandidates} entries`,
          { code: "ERR_WEBRTC_CANDIDATE_QUEUE", phase: "signal-apply" },
        );
      }
      this._pendingRemoteCandidates.push(candidate);
      return;
    }
    await this.peerConnection.addIceCandidate(candidate);
    this._throwIfTerminal();
  }
}

/**
 * Return the selected candidate path without exposing IP addresses, ports, or
 * other address-bearing RTCStats fields.
 */
export async function getSelectedCandidatePath(peerConnectionOrSession) {
  const peerConnection = peerConnectionOrSession?.peerConnection ?? peerConnectionOrSession;
  if (peerConnection === null || typeof peerConnection !== "object") {
    throw new TypeError("getSelectedCandidatePath requires an RTCPeerConnection or session");
  }
  requireFunction(peerConnection.getStats, "RTCPeerConnection.getStats");
  const report = await peerConnection.getStats();
  if (!report || typeof report.values !== "function" || typeof report.get !== "function") {
    throw new TypeError("RTCPeerConnection.getStats returned an invalid RTCStatsReport");
  }

  let pair = null;
  for (const item of report.values()) {
    if (item?.type === "transport" && item.selectedCandidatePairId) {
      pair = report.get(item.selectedCandidatePairId) ?? pair;
    }
  }
  if (pair === null) {
    for (const item of report.values()) {
      if (item?.type === "candidate-pair" && item.state === "succeeded" && item.nominated) {
        pair = item;
        break;
      }
    }
  }
  if (pair === null) return null;

  const local = report.get(pair.localCandidateId);
  const remote = report.get(pair.remoteCandidateId);
  const localCandidateType = typeof local?.candidateType === "string"
    ? local.candidateType
    : "unknown";
  const remoteCandidateType = typeof remote?.candidateType === "string"
    ? remote.candidateType
    : "unknown";
  const protocol = [
    local?.relayProtocol,
    remote?.relayProtocol,
    local?.protocol,
    remote?.protocol,
    pair.protocol,
  ].find((value) => typeof value === "string" && value.length > 0) ?? "unknown";

  return {
    relayed: localCandidateType === "relay" || remoteCandidateType === "relay",
    protocol,
    localCandidateType,
    remoteCandidateType,
  };
}
