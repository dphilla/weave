package main

// Native control schema v1; synchronized by shared.mu, never by message text.
import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const maxControlFrame = 65536

type controlRequest struct {
	SchemaVersion uint32  `json:"schema_version"`
	Action        string  `json:"action"`
	NodeEpoch     *string `json:"node_epoch,omitempty"`
	OperationID   *string `json:"operation_id,omitempty"`
	Target        *string `json:"target,omitempty"`
}

func decodeControlRequest(payload []byte) (controlRequest, error) {
	var request controlRequest
	if len(payload) > maxControlFrame || !utf8.Valid(payload) {
		return request, fmt.Errorf("invalid control request size or UTF-8")
	}
	d := json.NewDecoder(bytes.NewReader(payload))
	token, err := d.Token()
	if err != nil || token != json.Delim('{') {
		return request, fmt.Errorf("control request must be an object")
	}
	seen := map[string]bool{}
	for d.More() {
		token, err = d.Token()
		if err != nil {
			return request, err
		}
		key, ok := token.(string)
		if !ok || seen[key] {
			return request, fmt.Errorf("duplicate or invalid request field")
		}
		seen[key] = true
		var raw json.RawMessage
		if err = d.Decode(&raw); err != nil {
			return request, err
		}
		switch key {
		case "schema_version":
			if string(raw) == "null" {
				return request, fmt.Errorf("schema_version must be a u32")
			}
			err = json.Unmarshal(raw, &request.SchemaVersion)
		case "action":
			err = json.Unmarshal(raw, &request.Action)
		case "node_epoch":
			err = json.Unmarshal(raw, &request.NodeEpoch)
		case "operation_id":
			err = json.Unmarshal(raw, &request.OperationID)
		case "target":
			err = json.Unmarshal(raw, &request.Target)
		default:
			return request, fmt.Errorf("unknown request field %s", key)
		}
		if err != nil {
			return request, err
		}
	}
	if _, err = d.Token(); err != nil {
		return request, err
	}
	if _, err = d.Token(); err != io.EOF {
		return request, fmt.Errorf("trailing control JSON")
	}
	if !seen["schema_version"] || !seen["action"] || (request.Action != "status" && request.Action != "migrate" && request.Action != "operation") {
		return request, fmt.Errorf("missing schema_version or invalid action")
	}
	return request, nil
}

type controlOperation struct {
	OperationID string `json:"operation_id"`
	Target      string `json:"target"`
	State       string `json:"state"`
	Code        string `json:"code"`
	Ownership   string `json:"ownership"`
	Retry       string `json:"retry"`
	Message     string `json:"message"`
}

type controlImport struct {
	Module  string   `json:"module"`
	Name    string   `json:"name"`
	Params  []string `json:"params"`
	Results []string `json:"results"`
}

type controlLimits struct {
	ControlFrameBytes  int    `json:"control_frame_bytes"`
	RetainedOperations int    `json:"retained_operations"`
	OperationIDBytes   int    `json:"operation_id_bytes"`
	MemoryBytes        uint64 `json:"memory_bytes"`
	ModuleBytes        uint64 `json:"module_bytes"`
}

type controlCapabilities struct {
	Runtime           string          `json:"runtime"`
	AdapterVersion    string          `json:"adapter_version"`
	MigrationProtocol int             `json:"migration_protocol"`
	Services          []string        `json:"services"`
	Imports           []controlImport `json:"imports"`
	Features          []string        `json:"features"`
	Limits            controlLimits   `json:"limits"`
}

func wazeroCapabilities() controlCapabilities {
	return controlCapabilities{Runtime: "wazero", AdapterVersion: "0.1.0", MigrationProtocol: 2,
		Services: []string{"env.emit", "env.emit32", "env.emit64"},
		Imports: []controlImport{
			{Module: "env", Name: "emit", Params: []string{"i32", "i64"}, Results: []string{}},
			{Module: "env", Name: "emit32", Params: []string{"i32"}, Results: []string{}},
			{Module: "env", Name: "emit64", Params: []string{"i64"}, Results: []string{}},
		},
		Features: []string{"simd", "reference_types", "bulk_memory", "multi_value", "sign_extension", "saturating_float_to_int"},
		Limits:   controlLimits{maxControlFrame, 256, 128, maxMigrationMemorySize, maxModuleSize},
	}
}

type controlResponse struct {
	SchemaVersion int                  `json:"schema_version"`
	OK            bool                 `json:"ok"`
	Code          string               `json:"code"`
	Message       string               `json:"message"`
	NodeEpoch     string               `json:"node_epoch"`
	Lifecycle     string               `json:"lifecycle"`
	Ownership     string               `json:"ownership"`
	Retry         string               `json:"retry"`
	Operation     *controlOperation    `json:"operation"`
	Capabilities  *controlCapabilities `json:"capabilities"`
}

func (r controlResponse) encode() ([]byte, error) {
	bytes, err := json.Marshal(r)
	if len(bytes) > maxControlFrame {
		return nil, fmt.Errorf("control response exceeds frame limit")
	}
	return bytes, err
}

type controlCompletion uint8

const (
	controlMigrated controlCompletion = iota
	controlCommitUncertain
	controlFailedBeforeCommit
	controlWorkloadCompleted
	controlWorkloadTrapped
)

type controlState struct {
	epoch           string
	lifecycle       string
	ownership       string
	capabilities    controlCapabilities
	operations      map[string]controlOperation
	activeOperation string
}

func newControlState(lifecycle string) (*controlState, error) {
	var entropy [16]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return nil, fmt.Errorf("generating node epoch: %w", err)
	}
	state := &controlState{epoch: hex.EncodeToString(entropy[:]), capabilities: wazeroCapabilities(), operations: map[string]controlOperation{}}
	state.setLifecycle(lifecycle)
	return state, nil
}

func (s *controlState) setLifecycle(lifecycle string) {
	s.lifecycle, s.ownership = lifecycle, "none"
	if lifecycle == "running" || lifecycle == "migrating" {
		s.ownership = "retained"
	}
	if lifecycle == "retired" {
		s.ownership = "retired"
	}
}

func boundedControlMessage(message string) string {
	if len(message) <= 2048 {
		return message
	}
	end := 2048
	for !utf8.RuneStart(message[end]) {
		end--
	}
	return message[:end]
}

func (s *controlState) response(ok bool, code, message, retry string) controlResponse {
	return controlResponse{SchemaVersion: 1, OK: ok, Code: code, Message: boundedControlMessage(message), NodeEpoch: s.epoch, Lifecycle: s.lifecycle, Ownership: s.ownership, Retry: retry}
}

func (s *controlState) status() controlResponse {
	r := s.response(true, "STATUS_OK", "node status", "never")
	caps := s.capabilities
	r.Capabilities = &caps
	if op, ok := s.operations[s.activeOperation]; ok {
		r.Operation = &op
	}
	return r
}

func (s *controlState) operationResponse(op controlOperation) controlResponse {
	r := s.response(op.State == "accepted" || op.State == "succeeded", op.Code, op.Message, op.Retry)
	r.Operation = &op
	return r
}

func validControlID(id string) bool {
	if len(id) == 0 || len(id) > 128 {
		return false
	}
	for _, b := range []byte(id) {
		if !(b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z' || b >= '0' && b <= '9' || b == '.' || b == '_' || b == '-') {
			return false
		}
	}
	return true
}

func validControlTarget(target string) bool {
	if len(target) == 0 || len(target) > 4096 || strings.ContainsFunc(target, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) }) {
		return false
	}
	i := strings.LastIndexByte(target, ':')
	if i <= 0 {
		return false
	}
	host, port := target[:i], target[i+1:]
	if strings.HasPrefix(host, "[") {
		if !strings.HasSuffix(host, "]") || !strings.Contains(host, ":") || net.ParseIP(host[1:len(host)-1]) == nil {
			return false
		}
	} else if strings.ContainsAny(host, ":[]") {
		return false
	}
	for _, b := range []byte(port) {
		if b < '0' || b > '9' {
			return false
		}
	}
	p, err := strconv.ParseUint(port, 10, 16)
	return err == nil && p != 0
}

// Must run under the same lock as execution admission. accepted is non-nil once only.
func (s *controlState) handle(request controlRequest, canMigrate bool) (controlResponse, *controlOperation) {
	errorResponse := func(code, message, retry string) (controlResponse, *controlOperation) {
		return s.response(false, code, message, retry), nil
	}
	if request.SchemaVersion != 1 {
		return errorResponse("UNSUPPORTED_SCHEMA", "unsupported control schema version", "never")
	}
	if request.Action == "status" {
		if request.NodeEpoch != nil || request.OperationID != nil || request.Target != nil {
			return errorResponse("INVALID_REQUEST", "status does not accept operation fields", "never")
		}
		return s.status(), nil
	}
	if request.NodeEpoch == nil || *request.NodeEpoch != s.epoch {
		return errorResponse("NODE_EPOCH_MISMATCH", "node epoch is missing or changed; inspect ownership before submitting a new operation", "inspect_ownership")
	}
	if request.OperationID == nil || !validControlID(*request.OperationID) {
		return errorResponse("INVALID_REQUEST", "operation_id must be 1..128 ASCII letters, digits, '.', '_' or '-'", "never")
	}
	id := *request.OperationID
	if request.Action == "operation" {
		if request.Target != nil {
			return errorResponse("INVALID_REQUEST", "operation lookup does not accept target", "never")
		}
		if op, ok := s.operations[id]; ok {
			return s.operationResponse(op), nil
		}
		return errorResponse("OPERATION_NOT_FOUND", "operation was not accepted in this node epoch", "same_operation")
	}
	if request.Target == nil || !validControlTarget(*request.Target) {
		return errorResponse("INVALID_REQUEST", "target must be a nonempty host:port address with port 1..65535", "never")
	}
	if op, ok := s.operations[id]; ok {
		if op.Target != *request.Target {
			return errorResponse("OPERATION_CONFLICT", "operation_id was already accepted with a different target", "never")
		}
		return s.operationResponse(op), nil
	}
	if len(s.operations) >= 256 {
		return errorResponse("OPERATION_CAPACITY", "node operation ledger is full; accepted IDs are never evicted", "never")
	}
	if s.activeOperation != "" || s.lifecycle == "migrating" || s.lifecycle == "accepting" {
		return errorResponse("NODE_BUSY", "node already has an active migration", "new_operation")
	}
	if !canMigrate || s.lifecycle != "running" {
		return errorResponse("NO_ACTIVE_WORKLOAD", "node has no active workload", "never")
	}
	op := controlOperation{OperationID: id, Target: *request.Target, State: "accepted", Code: "ACCEPTED", Ownership: "retained", Retry: "same_operation", Message: "migration accepted; query this operation ID for its outcome"}
	s.operations[id], s.activeOperation = op, id
	s.setLifecycle("migrating")
	return s.operationResponse(op), &op
}

func (s *controlState) sourceRetired() {
	s.setLifecycle("retired")
	if op, ok := s.operations[s.activeOperation]; ok {
		op.Code, op.Ownership, op.Retry, op.Message = "COMMIT_PENDING", "retired", "inspect_ownership", "source retired; commit confirmation is pending"
		s.operations[s.activeOperation] = op
	}
}

func (s *controlState) complete(completion controlCompletion, message string) {
	if op, ok := s.operations[s.activeOperation]; ok && op.Ownership == "retired" && completion == controlFailedBeforeCommit {
		completion = controlCommitUncertain
	}
	state, code, lifecycle, retry := "failed", "WORKLOAD_TRAPPED", "failed", "never"
	switch completion {
	case controlMigrated:
		state, code, lifecycle = "succeeded", "MIGRATED", "retired"
	case controlCommitUncertain:
		state, code, lifecycle, retry = "uncertain", "COMMIT_UNCERTAIN", "retired", "inspect_ownership"
	case controlFailedBeforeCommit:
		code, lifecycle, retry = "MIGRATION_FAILED", "running", "new_operation"
	case controlWorkloadCompleted:
		code, lifecycle = "WORKLOAD_COMPLETED", "completed"
	}
	s.setLifecycle(lifecycle)
	if op, ok := s.operations[s.activeOperation]; ok {
		op.State, op.Code, op.Ownership, op.Retry, op.Message = state, code, s.ownership, retry, boundedControlMessage(message)
		s.operations[s.activeOperation] = op
	}
	s.activeOperation = ""
}
