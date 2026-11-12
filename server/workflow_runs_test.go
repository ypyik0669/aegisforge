package server

import (
	"bytes"
	"context"
	"encoding/json"
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

// List endpoint roundtrip (skipped without a test PostgreSQL): seed two runs,
// verify default ordering, filters and pagination.
func TestWorkflowRunList(t *testing.T) {
	dsn, _, err := db.DSN()
	if err != nil {
		t.Skip("test postgres not configured")
	}
	pg, err := db.Open(dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pg.Close()
	t.Setenv("ARTEX_MIRROR_TOKEN", "t")
	ctx := context.Background()
	cleanup := func() {
		_, _ = pg.Exec(`DELETE FROM workflow_runs WHERE id IN ('mir-list-1','mir-list-2')`)
	}
	cleanup()
	t.Cleanup(cleanup)

	seed := []db.WorkflowRunMirror{
		{ID: "mir-list-1", WorkflowID: "wf-a", WorkflowName: "e2e-hello", Runtime: "sdk", Status: "done",
			StartedAt: "2026-11-13T08:00:00Z", UpdatedAt: "2026-11-13T08:05:00Z"},
		{ID: "mir-list-2", WorkflowID: "wf-b", WorkflowName: "go-loop", Runtime: "go", Status: "failed",
			StartedAt: "2026-11-13T09:00:00Z", UpdatedAt: "2026-11-13T09:01:00Z"},
	}
	for _, m := range seed {
		if err := pg.UpsertWorkflowRun(ctx, m); err != nil {
			t.Fatal(err)
		}
	}

	s := &Server{m: newNoPGManager()}
	s.m.pg = pg
	get := func(query string) map[string]any {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/workflow-runs"+query, nil)
		w := httptest.NewRecorder()
		s.handleWorkflowRunList(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out
	}

	// Unfiltered: both rows, newest first.
	out := get("")
	if got := int(out["total"].(float64)); got < 2 {
		t.Fatalf("total=%d, want >=2", got)
	}
	first := out["runs"].([]any)[0].(map[string]any)
	if first["id"] != "mir-list-2" {
		t.Fatalf("newest-first violated: first=%v", first["id"])
	}

	// runtime=go filter keeps only the go row.
	out = get("?runtime=go")
	rows := out["runs"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["runtime"] != "go" {
		t.Fatalf("runtime filter: %v", rows)
	}

	// status filter + pagination: size=1 page=0 → exactly one row.
	out = get("?status=done&size=1")
	if n := len(out["runs"].([]any)); n != 1 {
		t.Fatalf("paged rows=%d, want 1", n)
	}

	// Full JSON ingest path (flowd's snake_case payload must decode into the
	// tagged struct — a missing json tag silently zeroes updated_at, losing
	// finished_at). Seed a third row through the real handler.
	if code, body := func() (int, string) {
		req := httptest.NewRequest(http.MethodPost, "/api/mirror/workflow-runs",
			bytes.NewBufferString(`{"id":"mir-list-3","runtime":"sdk","status":"done","model_profile":"deepseek-chat","workflow_id":"wf-c","workflow_name":"e2e","started_at":"2026-11-13T10:00:00Z","updated_at":"2026-11-13T10:02:00Z"}`))
		req.Header.Set("X-Mirror-Token", "t")
		w := httptest.NewRecorder()
		s.handleWorkflowRunMirror(w, req)
		return w.Code, w.Body.String()
	}(); code != http.StatusAccepted {
		t.Fatalf("mirror POST status=%d body=%s", code, body)
	}
	t.Cleanup(func() { _, _ = pg.Exec(`DELETE FROM workflow_runs WHERE id='mir-list-3'`) })
	var finished *time.Time
	var model string
	if err := pg.QueryRow(`SELECT finished_at, COALESCE(model_profile,'') FROM workflow_runs WHERE id='mir-list-3'`).
		Scan(&finished, &model); err != nil {
		t.Fatal(err)
	}
	if finished == nil {
		t.Fatal("finished_at NULL: WorkflowRunMirror json tags missing?")
	}
	if model != "deepseek-chat" {
		t.Fatalf("model_profile=%q (json decode broken)", model)
	}
}
