package toolbridge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/Autumn-27/artex/db"
	"github.com/Autumn-27/norma/hook"
	actool "github.com/Autumn-27/norma/tool"
)

// ErrBlocked is returned when the guard chain denies an invocation.
type BlockedError struct{ Message string }

func (e *BlockedError) Error() string { return e.Message }

// UnknownToolError means the requested tool is not in the registry.
type UnknownToolError struct{ Tool string }

func (e *UnknownToolError) Error() string { return "unknown tool: " + e.Tool }

// DisabledError means the tool exists but is switched off in the tools table.
type DisabledError struct{ Tool string }

func (e *DisabledError) Error() string { return "tool disabled: " + e.Tool }

// Invoker runs a registry tool through the same guard chain the Go agent
// runtime uses: registry lookup → tools-table enabled check → PreToolUse
// hooks (deny rules / intercept rules / target gate) → CoreTool.Call.
// pg may be nil (standalone bridge): the enabled check is skipped.
type Invoker struct {
	pg         *db.DB
	registry   func() map[string]actool.CoreTool
	hooks      *hook.Registry
	defaultCwd string
}

// NewInvoker builds an invoker. registry is a live view (re-read per call so
// late registrations are visible); hooks is the guard's hook chain (may be nil,
// which disables gating — only acceptable for tests).
func NewInvoker(pg *db.DB, registry func() map[string]actool.CoreTool, hooks *hook.Registry, defaultCwd string) *Invoker {
	return &Invoker{pg: pg, registry: registry, hooks: hooks, defaultCwd: defaultCwd}
}

// Invoke resolves and executes one tool. Returns the flattened text content
// and the tool's own IsError flag.
func (iv *Invoker) Invoke(ctx context.Context, name string, args json.RawMessage, cwd string) (string, bool, error) {
	tool, ok := iv.registry()[name]
	if !ok {
		return "", false, &UnknownToolError{Tool: name}
	}
	if iv.pg != nil {
		if err := iv.checkEnabled(name); err != nil {
			return "", false, err
		}
	}
	if iv.hooks != nil {
		blocked, msg, updated := iv.hooks.PreToolUse(ctx, name, args)
		if blocked {
			return "", false, &BlockedError{Message: msg}
		}
		if len(updated) > 0 {
			args = updated
		}
	}
	if cwd == "" {
		cwd = iv.defaultCwd
	}
	result, err := tool.Call(ctx, args, &actool.ToolContext{WorkingDir: cwd, MaxOutputChars: 24000})
	if err != nil {
		return "", false, err
	}
	return result.Flatten(), result.IsError, nil
}

func (iv *Invoker) checkEnabled(name string) error {
	rows, err := iv.pg.ListTools()
	if err != nil {
		// Registry availability must not hinge on the catalog read: fail open
		// only for infrastructure errors, but log loudly via the returned error
		// path. Choose fail-closed: a broken catalog read blocks invocation.
		return fmt.Errorf("tools table unavailable: %w", err)
	}
	for _, t := range rows {
		if t.Key == name {
			if !t.Enabled {
				return &DisabledError{Tool: name}
			}
			return nil
		}
	}
	return nil // not in the table (e.g. standalone seeds pending) → allowed
}

// handleInvoke answers POST /api/tools/invoke with {tool, args, cwd}.
func (r *Registry) handleInvoke(w http.ResponseWriter, req *http.Request) {
	if r.invoker == nil {
		writeJSONError(w, http.StatusNotImplemented, "invoke_unavailable", "invoke is not wired on this instance")
		return
	}
	var body struct {
		Tool string          `json:"tool"`
		Args json.RawMessage `json:"args"`
		CWD  string          `json:"cwd"`
	}
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad_request", "invalid JSON body")
		return
	}
	if body.Tool == "" {
		writeJSONError(w, http.StatusBadRequest, "bad_request", "tool is required")
		return
	}
	if len(body.Args) == 0 {
		body.Args = json.RawMessage("{}")
	}
	content, isError, err := r.invoker.Invoke(req.Context(), body.Tool, body.Args, body.CWD)
	if err != nil {
		var blocked *BlockedError
		var unknown *UnknownToolError
		var disabled *DisabledError
		switch {
		case errors.As(err, &blocked):
			writeJSONError(w, http.StatusForbidden, "blocked", blocked.Message)
		case errors.As(err, &unknown):
			writeJSONError(w, http.StatusNotFound, "unknown_tool", unknown.Error())
		case errors.As(err, &disabled):
			writeJSONError(w, http.StatusConflict, "disabled", disabled.Error())
		default:
			writeJSONError(w, http.StatusInternalServerError, "invoke_failed", err.Error())
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok": true, "tool": body.Tool, "content": content, "is_error": isError,
	})
}

func writeJSONError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
