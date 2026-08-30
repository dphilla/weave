const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;

function requireObject(value, name) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireMethod(value, name, method) {
  if (typeof value[method] !== "function") {
    throw new TypeError(`${name}.${method} must be a function`);
  }
}

function normalizeError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

function validateWebSocket(websocket) {
  requireObject(websocket, "websocket");
  for (const method of [
    "once",
    "off",
    "setBinaryHandler",
    "resumeIncoming",
    "sendBinary",
    "close",
  ]) {
    requireMethod(websocket, "websocket", method);
  }
  if (typeof websocket.closed !== "boolean") {
    throw new TypeError("websocket.closed must be a boolean");
  }
}

function validateDuplex(duplex) {
  requireObject(duplex, "duplex");
  for (const method of ["on", "once", "off", "write", "pause", "resume", "end", "destroy"]) {
    requireMethod(duplex, "duplex", method);
  }
}

/**
 * Bridge a normalized binary-WebSocket endpoint to a Node stream-like duplex.
 *
 * The bridge is byte-transparent and owns both endpoint lifecycles until it is
 * closed. It does not perform WebSocket negotiation, open sockets, or impose an
 * application protocol.
 */
export function bridgeWebSocketToDuplex(websocket, duplex, options = {}) {
  validateWebSocket(websocket);
  validateDuplex(duplex);
  if (options === null || typeof options !== "object") {
    throw new TypeError("options must be an object");
  }

  const label = options.label ?? "websocket-duplex bridge";
  if (typeof label !== "string") throw new TypeError("options.label must be a string");

  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  if (!Number.isFinite(closeTimeoutMs) || closeTimeoutMs < 0) {
    throw new RangeError("options.closeTimeoutMs must be a non-negative finite number");
  }

  const onError = options.onError ?? (() => {});
  if (typeof onError !== "function") throw new TypeError("options.onError must be a function");

  let stopped = false;
  let waitingForDuplexDrain = false;
  let waitingForWebSocketDrain = false;

  const report = (value, side) => {
    const error = normalizeError(value);
    try {
      onError(error, { label, side });
    } catch {
      // Error reporting must never prevent endpoint shutdown and cleanup.
    }
    return error;
  };

  const onDuplexDrain = () => {
    if (!waitingForDuplexDrain) return;
    waitingForDuplexDrain = false;
    if (stopped) return;
    try {
      websocket.resumeIncoming();
    } catch (error) {
      shutdown("websocket", error, 1011, "WebSocket endpoint failed");
    }
  };

  const onWebSocketDrain = () => {
    if (!waitingForWebSocketDrain) return;
    waitingForWebSocketDrain = false;
    if (stopped) return;
    try {
      duplex.resume();
    } catch (error) {
      shutdown("duplex", error, 1011, "duplex endpoint failed");
    }
  };

  const onBinary = (bytes) => {
    if (stopped) return false;
    try {
      const writable = duplex.write(bytes);
      if (!writable && !waitingForDuplexDrain) {
        waitingForDuplexDrain = true;
        duplex.once("drain", onDuplexDrain);
      }
      return writable;
    } catch (error) {
      shutdown("duplex", error, 1011, "duplex endpoint failed");
      return false;
    }
  };

  const onDuplexData = (bytes) => {
    if (stopped) return;
    try {
      const writable = websocket.sendBinary(bytes);
      if (!writable && !waitingForWebSocketDrain) {
        waitingForWebSocketDrain = true;
        duplex.pause();
        websocket.once("drain", onWebSocketDrain);
      }
    } catch (error) {
      shutdown("websocket", error, 1011, "WebSocket endpoint failed");
    }
  };

  const onDuplexEnd = () => shutdown("duplex", null, 1000, "duplex ended");
  const onDuplexClose = () => shutdown("duplex", null, 1000, "duplex closed");
  const onDuplexError = (error) => {
    shutdown("duplex", error, 1011, "duplex endpoint failed");
  };
  const onWebSocketClose = () => shutdown("websocket", null, 1000, "WebSocket closed");
  const onWebSocketError = (error) => {
    shutdown("websocket", error, 1011, "WebSocket endpoint failed");
  };

  const detach = () => {
    try {
      websocket.setBinaryHandler(null);
    } catch (error) {
      report(error, "websocket");
    }
    websocket.off("close", onWebSocketClose);
    websocket.off("error", onWebSocketError);
    websocket.off("drain", onWebSocketDrain);
    duplex.off("data", onDuplexData);
    duplex.off("end", onDuplexEnd);
    duplex.off("close", onDuplexClose);
    duplex.off("error", onDuplexError);
    duplex.off("drain", onDuplexDrain);
    waitingForDuplexDrain = false;
    waitingForWebSocketDrain = false;
  };

  const destroyDuplex = () => {
    if (duplex.destroyed === true) return;
    try {
      duplex.destroy();
    } catch (error) {
      report(error, "duplex");
    }
  };

  const closeDuplex = (immediate) => {
    if (duplex.destroyed === true) return;
    if (immediate) {
      destroyDuplex();
      return;
    }
    try {
      duplex.end();
    } catch (error) {
      report(error, "duplex");
      destroyDuplex();
      return;
    }
    if (duplex.destroyed === true) return;
    if (closeTimeoutMs === 0) {
      destroyDuplex();
      return;
    }
    const timer = setTimeout(destroyDuplex, closeTimeoutMs);
    timer.unref?.();
  };

  function shutdown(side, error, code, reason) {
    if (stopped) return false;
    stopped = true;
    if (error !== null && error !== undefined) report(error, side);
    detach();

    if (!websocket.closed) {
      try {
        websocket.close(code, reason);
      } catch (closeError) {
        report(closeError, "websocket");
      }
    }
    closeDuplex(side === "duplex" && error !== null && error !== undefined);
    return true;
  }

  const controller = Object.freeze({
    get closed() {
      return stopped;
    },
    close(code = 1000, reason = "bridge closed") {
      return shutdown("manual", null, code, reason);
    },
  });

  websocket.once("close", onWebSocketClose);
  websocket.once("error", onWebSocketError);
  duplex.on("data", onDuplexData);
  duplex.once("end", onDuplexEnd);
  duplex.once("close", onDuplexClose);
  duplex.once("error", onDuplexError);

  let setupSide = "websocket";
  try {
    websocket.setBinaryHandler(onBinary);
    setupSide = "duplex";
    duplex.resume();
  } catch (error) {
    shutdown(setupSide, error, 1011, "bridge setup failed");
    throw error;
  }

  if (websocket.closed) {
    shutdown("websocket", null, 1000, "WebSocket already closed");
  } else if (duplex.destroyed === true) {
    shutdown("duplex", null, 1000, "duplex already closed");
  }

  return controller;
}

export { DEFAULT_CLOSE_TIMEOUT_MS };
