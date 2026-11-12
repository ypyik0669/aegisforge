package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"time"

	"github.com/Autumn-27/artex/db"
)

// Workflow run mirror: flowd (the SDK-path runtime) POSTs terminal run states
// here so the unified runs view can query them from PostgreSQL instead of
// calling flowd. Auth is a shared token (X-Mirror-Token == ARTEX_MIRROR_TOKEN)
// instead of the operator JWT — flowd is a service, not a logged-in user.
// Fail-closed: token unset → the endpoint refuses everything.

func mirrorToken() string {
	return os.Getenv("ARTEX_MIRROR_TOKEN")
}

// mirrorAuth reports whether the request carries the configured mirror token.
func mirrorAuth(r *http.Request) bool {
	want := mirrorToken()
	if want == "" {
		return false
	}
	got := r.Header.Get("X-Mirror-Token")
	return got != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// handleWorkflowRunMirror serves POST /api/mirror/workflow-runs.
func (s *Server) handleWorkflowRunMirror(w http.ResponseWriter, r *http.Request) {
	if !mirrorAuth(r) {
		if mirrorToken() == "" {
			writeErr(w, http.StatusServiceUnavailable,
				"workflow run mirror is disabled (set ARTEX_MIRROR_TOKEN)")
		} else {
			writeErr(w, http.StatusUnauthorized, "invalid mirror token")
		}
		return
	}
	pg := s.pg(w)
	if pg == nil {
		return
	}
	var payload db.WorkflowRunMirror
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	if err := dec.Decode(&payload); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := pg.UpsertWorkflowRun(ctx, payload); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "id": payload.ID})
}
