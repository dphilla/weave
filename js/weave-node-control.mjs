// Native node control schema v1. Keep this ledger aligned with weave-core/control.rs.
// IDs are scoped to a random process epoch and never evicted or re-executed.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const MAX_CONTROL_FRAME = 65536;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const keys = new Set(["schema_version", "action", "node_epoch", "operation_id", "target"]);

export function decodeRequest(bytes) {
  if (bytes.length > MAX_CONTROL_FRAME) throw new Error("control request exceeds frame limit");
  const text = utf8.decode(bytes);
  const value = JSON.parse(text);
  if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error("request must be an object");
  // Accepted requests contain only scalar values. Tokenizing JSON strings also
  // catches escaped duplicate keys, which JSON.parse otherwise silently loses.
  const seen = new Set();
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    const string = JSON.parse(match[0]);
    if (utf8.decode(encoder.encode(string)) !== string) throw new Error("invalid Unicode surrogate in request");
    if (!/^\s*:/.test(text.slice(match.index + match[0].length))) continue;
    const key = string;
    if (seen.has(key)) throw new Error(`duplicate field ${key}`);
    seen.add(key);
    if (key === "schema_version" && !/^\s*:\s*(?:0|[1-9]\d*)\s*[,}]/.test(text.slice(match.index + match[0].length))) throw new Error("schema_version must be a u32");
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new Error(`unknown field ${key}`);
  }
  if (!Number.isInteger(value.schema_version) || value.schema_version < 0 || value.schema_version > 0xffffffff) throw new Error("schema_version must be a u32");
  if (!["status", "migrate", "operation"].includes(value.action)) throw new Error("invalid action");
  for (const key of ["node_epoch", "operation_id", "target"]) {
    if (value[key] != null && typeof value[key] !== "string") throw new Error(`${key} must be a string or null`);
  }
  return value;
}

export function encodeResponse(response) {
  const bytes = encoder.encode(JSON.stringify(response));
  if (bytes.length > MAX_CONTROL_FRAME) throw new Error("control response exceeds frame limit");
  return bytes;
}

export function builtinCapabilities(runtime = "node") {
  return {
    runtime, adapter_version: "0.1.0", migration_protocol: 2,
    services: ["env.emit", "env.emit32", "env.emit64"],
    imports: [
      { module: "env", name: "emit", params: ["i32", "i64"], results: [] },
      { module: "env", name: "emit32", params: ["i32"], results: [] },
      { module: "env", name: "emit64", params: ["i64"], results: [] },
    ],
    features: ["simd", "reference_types", "bulk_memory", "multi_value", "sign_extension", "saturating_float_to_int",
      ...(WebAssembly.validate(new Uint8Array([0,97,115,109,1,0,0,0,5,5,2,0,0,0,0])) ? ["multi_memory"] : [])],
    limits: { control_frame_bytes: MAX_CONTROL_FRAME, retained_operations: 256,
      operation_id_bytes: 128, memory_bytes: 1 << 30, module_bytes: 512 * 1024 * 1024 },
  };
}

function boundedMessage(message) {
  const bytes = encoder.encode(message);
  if (bytes.length <= 2048) return message;
  let end = 2048;
  while ((bytes[end] & 0xc0) === 0x80) end--;
  return utf8.decode(bytes.subarray(0, end));
}

export function validTarget(target) {
  if (typeof target !== "string" || encoder.encode(target).length > 4096 || /[\s\x00-\x1f\x7f]/u.test(target)) return false;
  const index = target.lastIndexOf(":");
  const port = target.slice(index + 1);
  const host = target.slice(0, index);
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || isIP(host.slice(1, -1)) !== 6) return false;
  } else if (/[:\[\]]/.test(host)) return false;
  return index > 0 && /^\d+$/.test(port) && Number(port) > 0 && Number(port) <= 65535;
}

export class ControlState {
  constructor(capabilities, lifecycle = "idle", epoch = randomBytes(16).toString("hex")) {
    this.epoch = epoch;
    this.capabilities = structuredClone(capabilities);
    if (encoder.encode(JSON.stringify(capabilities)).length > 32768) throw new Error("control capabilities exceed advertisement limit");
    this.operations = new Map();
    this.activeOperation = null;
    this.setLifecycle(lifecycle);
    encodeResponse(this.status());
  }

  setLifecycle(lifecycle) {
    this.lifecycle = lifecycle;
    this.ownership = ["running", "migrating"].includes(lifecycle) ? "retained" : lifecycle === "retired" ? "retired" : "none";
  }

  response(ok, code, message, retry = "never") {
    return { schema_version: 1, ok, code, message: boundedMessage(message),
      node_epoch: this.epoch, lifecycle: this.lifecycle, ownership: this.ownership,
      retry, operation: null, capabilities: null };
  }

  status() {
    return { ...this.response(true, "STATUS_OK", "node status"),
      capabilities: structuredClone(this.capabilities),
      operation: this.activeOperation === null ? null : structuredClone(this.operations.get(this.activeOperation)) };
  }

  invalidRequest(message) { return this.response(false, "INVALID_REQUEST", message); }

  operationResponse(operation) {
    return { ...this.response(["accepted", "succeeded"].includes(operation.state), operation.code, operation.message, operation.retry), operation: structuredClone(operation) };
  }

  handle(request, canMigrate) {
    const error = (code, message, retry = "never") => ({ response: this.response(false, code, message, retry), accepted: null });
    if (request.schema_version !== 1) return error("UNSUPPORTED_SCHEMA", "unsupported control schema version");
    if (request.action === "status") {
      if ([request.node_epoch, request.operation_id, request.target].some((value) => value != null)) return error("INVALID_REQUEST", "status does not accept operation fields");
      return { response: this.status(), accepted: null };
    }
    if (request.node_epoch !== this.epoch) return error("NODE_EPOCH_MISMATCH", "node epoch is missing or changed; inspect ownership before submitting a new operation", "inspect_ownership");
    const id = request.operation_id;
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(id)) return error("INVALID_REQUEST", "operation_id must be 1..128 ASCII letters, digits, '.', '_' or '-'");
    if (request.action === "operation") {
      if (request.target != null) return error("INVALID_REQUEST", "operation lookup does not accept target");
      const operation = this.operations.get(id);
      return operation ? { response: this.operationResponse(operation), accepted: null } : error("OPERATION_NOT_FOUND", "operation was not accepted in this node epoch", "same_operation");
    }
    if (!validTarget(request.target)) return error("INVALID_REQUEST", "target must be a nonempty host:port address with port 1..65535");
    const existing = this.operations.get(id);
    if (existing) return existing.target === request.target ? { response: this.operationResponse(existing), accepted: null } : error("OPERATION_CONFLICT", "operation_id was already accepted with a different target");
    if (this.operations.size >= 256) return error("OPERATION_CAPACITY", "node operation ledger is full; accepted IDs are never evicted");
    if (this.activeOperation !== null || ["migrating", "accepting"].includes(this.lifecycle)) return error("NODE_BUSY", "node already has an active migration", "new_operation");
    if (!canMigrate || this.lifecycle !== "running") return error("NO_ACTIVE_WORKLOAD", "node has no active workload");
    const operation = { operation_id: id, target: request.target, state: "accepted", code: "ACCEPTED", ownership: "retained", retry: "same_operation", message: "migration accepted; query this operation ID for its outcome" };
    this.activeOperation = id;
    this.operations.set(id, operation);
    this.setLifecycle("migrating");
    return { response: this.operationResponse(operation), accepted: { operation_id: id, target: request.target } };
  }

  sourceRetired() {
    this.setLifecycle("retired");
    const operation = this.operations.get(this.activeOperation);
    if (operation) Object.assign(operation, { code: "COMMIT_PENDING", ownership: "retired", retry: "inspect_ownership", message: "source retired; commit confirmation is pending" });
  }

  complete(completion, message) {
    if (completion === "failed_before_commit" && this.operations.get(this.activeOperation)?.ownership === "retired") completion = "commit_uncertain";
    const results = {
      migrated: ["succeeded", "MIGRATED", "retired", "never"],
      commit_uncertain: ["uncertain", "COMMIT_UNCERTAIN", "retired", "inspect_ownership"],
      failed_before_commit: ["failed", "MIGRATION_FAILED", "running", "new_operation"],
      workload_completed: ["failed", "WORKLOAD_COMPLETED", "completed", "never"],
      workload_trapped: ["failed", "WORKLOAD_TRAPPED", "failed", "never"],
    };
    const [state, code, lifecycle, retry] = results[completion];
    this.setLifecycle(lifecycle);
    const operation = this.operations.get(this.activeOperation);
    if (operation) Object.assign(operation, { state, code, ownership: this.ownership, retry, message: boundedMessage(message) });
    this.activeOperation = null;
  }
}
