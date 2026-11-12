package server

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Autumn-27/artex/db"
)

func mirrorRequest(t *testing.T, s *Server, token, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/mirror/workflow-runs", bytes.NewBufferString(body))
	if token != "" {
		req.Header.Set("X-Mirror-Token", token)
	}
	w := httptest.NewRecorder()
	s.handleWorkflowRunMirror(w, req)
	return w
}

const mirrorPayload = `{"id":"mir-run-1","runtime":"sdk","status":"done","model_profile":"claude-sonnet-4-6","workflow_id":"wf-1","workflow_name":"pojia-fullflow","started_at":"2026-11-12T10:00:00Z","updated_at":"2026-11-12T10:05:00Z"}`

// No-PG paths: fail-closed without a token, token mismatch, bad JSON.
func TestWorkflowRunMirrorHandlerNoPG(t *testing.T) {
	s := &Server{m: newNoPGManager()}

	t.Run("token unset → 503 fail-closed", func(t *testing.T) {
		t.Setenv("ARTEX_MIRROR_TOKEN", "")
		w := mirrorRequest(t, s, "whatever", mirrorPayload)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("token mismatch → 401", func(t *testing.T) {
		t.Setenv("ARTEX_MIRROR_TOKEN", "right-token")
		w := mirrorRequest(t, s, "wrong-token", mirrorPayload)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("no header → 401", func(t *testing.T) {
		t.Setenv("ARTEX_MIRROR_TOKEN", "right-token")
		w := mirrorRequest(t, s, "", mirrorPayload)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})

	t.Run("no PG → 503 before body parse", func(t *testing.T) {
		t.Setenv("ARTEX_MIRROR_TOKEN", "right-token")
		// 处理顺序：token → pg → 解析。无 PG 时坏 JSON 到不了解析那步。
		w := mirrorRequest(t, s, "right-token", "{not json")
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
}

// PG-backed upsert roundtrip (skipped without a test PostgreSQL).
func TestWorkflowRunMirrorUpsert(t *testing.T) {
	dsn, _, err := db.DSN()
	if err != nil {
		t.Skip("test postgres not configured")
	}
	pg, err := db.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	ctx := context.Background()
	cleanup := func() {
		_, _ = pg.Exec(`DELETE FROM workflow_runs WHERE id = 'mir-run-1'`)
	}
	cleanup()
	t.Cleanup(cleanup)

	// First send: terminal 'done' with finished_at stamped.
	if err := pg.UpsertWorkflowRun(ctx, db.WorkflowRunMirror{
		ID: "mir-run-1", WorkflowID: "wf-1", WorkflowName: "pojia-fullflow",
		Runtime: "sdk", Status: "done", ModelProfile: "claude-sonnet-4-6",
		StartedAt: "2026-11-12T10:00:00Z", UpdatedAt: "2026-11-12T10:05:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	var status, runtime string
	var finished *time.Time
	err = pg.QueryRow(`SELECT status, runtime, finished_at FROM workflow_runs WHERE id='mir-run-1'`).
		Scan(&status, &runtime, &finished)
	if err != nil {
		t.Fatal(err)
	}
	if status != "done" || runtime != "sdk" || finished == nil {
		t.Fatalf("row: status=%s runtime=%s finished=%v", status, runtime, finished)
	}

	// Re-send with 'running': status updated, finished_at cleared (SSOT re-run).
	if err := pg.UpsertWorkflowRun(ctx, db.WorkflowRunMirror{
		ID: "mir-run-1", WorkflowID: "wf-1", Runtime: "sdk", Status: "running",
		StartedAt: "2026-11-12T11:00:00Z", UpdatedAt: "2026-11-12T11:01:00Z",
	}); err != nil {
		t.Fatal(err)
	}
	err = pg.QueryRow(`SELECT status, finished_at FROM workflow_runs WHERE id='mir-run-1'`).Scan(&status, &finished)
	if err != nil {
		t.Fatal(err)
	}
	if status != "running" || finished != nil {
		t.Fatalf("after re-run: status=%s finished=%v", status, finished)
	}

	// Validation: bad runtime / bad status / empty id are rejected.
	for _, bad := range []db.WorkflowRunMirror{
		{ID: "x", Runtime: "weird", Status: "done"},
		{ID: "x", Runtime: "sdk", Status: "exploded"},
		{Runtime: "sdk", Status: "done"},
	} {
		if err := pg.UpsertWorkflowRun(ctx, bad); err == nil {
			t.Fatalf("expected error for %+v", bad)
		}
	}
}

// newNoPGManager builds a Manager whose pg is nil (mirror endpoint must 503).
func newNoPGManager() *Manager {
	m := &Manager{}
	m.pg = nil
	return m
}
