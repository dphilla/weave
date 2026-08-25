// Synchronous ownership admission for the Node runner. JavaScript can only
// interleave at awaits, so taking this token before acceptMigration() yields
// makes the idle -> accepting transition atomic with respect to other sockets.

export class TargetAdmission {
  constructor(hasInitialWork = false) {
    this.state = hasInitialWork ? "starting" : "idle";
    this.reservation = null;
  }

  tryReserve() {
    if (this.state !== "idle") return null;
    const token = Symbol("incoming migration");
    this.state = "accepting";
    this.reservation = token;
    return token;
  }

  commit(token) {
    if (this.state !== "accepting" || this.reservation !== token) {
      throw new Error("invalid incoming-migration reservation commit");
    }
    this.reservation = null;
    this.state = "running";
  }

  release(token) {
    if (this.state !== "accepting" || this.reservation !== token) return false;
    this.reservation = null;
    this.state = "idle";
    return true;
  }

  startRunning() {
    if (this.state !== "starting" && this.state !== "running") {
      throw new Error(`cannot start workload while node is ${this.state}`);
    }
    this.state = "running";
  }

  finishRunning() {
    if (this.state === "running") this.state = "idle";
  }

  get busy() {
    return this.state !== "idle";
  }

  isRunning() {
    return this.state === "running";
  }

  status() {
    switch (this.state) {
      case "idle": return "idle";
      case "accepting": return "accepting migration";
      case "starting": return "starting";
      case "running": return "running";
      default: throw new Error(`unknown target-admission state ${this.state}`);
    }
  }
}

// Outbound control requests have a separate reservation from target admission:
// a running node still owns its workload while an outbound migration is in
// progress, but exactly one controller may request that transfer. Each request
// owns its completion so a concurrent or stale controller cannot observe or
// clear another request's result.
export class OutboundMigrationAdmission {
  constructor(isWorkloadRunning) {
    this.isWorkloadRunning = isWorkloadRunning;
    this.active = null;
  }

  tryReserve(target) {
    if (typeof target !== "string" || target.trim().length === 0) {
      return { ok: false, error: "migration target must not be empty" };
    }
    if (!this.isWorkloadRunning()) {
      return { ok: false, error: "node has no active workload" };
    }
    if (this.active !== null) {
      return { ok: false, error: "migration already in progress" };
    }

    let resolve;
    const result = new Promise((done) => { resolve = done; });
    const request = Object.freeze({
      token: Symbol("outbound migration"),
      target,
      result,
    });
    this.active = { request, resolve };
    return { ok: true, request };
  }

  current() {
    return this.active?.request ?? null;
  }

  complete(request, message) {
    if (this.active?.request !== request) return false;
    const { resolve } = this.active;
    this.active = null;
    resolve(message);
    return true;
  }
}
