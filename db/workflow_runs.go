package db

import (
	"context"
	"fmt"
)

// WorkflowRunMirror is one row for the workflow_runs table (schema.sql).
// flowd owns the runtime state as state.yaml files (the SSOT); these rows hold
// terminal states so the unified runs view and the Go gateway can query runs
// without calling flowd. Writes are async best-effort — eventual consistency.
type WorkflowRunMirror struct {
	ID           string
	WorkflowID   string
	WorkflowName string
	Runtime      string // 'go' | 'sdk'
	Status       string // 'running' | 'done' | 'failed' | 'stopped'
	ModelProfile string
	StartedAt    string // RFC3339; parsed by PostgreSQL, "" → now()
	UpdatedAt    string // RFC3339; stamped as finished_at on terminal status
}

// UpsertWorkflowRun mirrors one workflow run row, idempotent on re-send.
// Terminal statuses stamp finished_at with UpdatedAt; a re-send with
// 'running' clears it again (re-runs overwrite, matching state.yaml SSOT).
func (db *DB) UpsertWorkflowRun(ctx context.Context, run WorkflowRunMirror) error {
	if run.ID == "" {
		return fmt.Errorf("workflow run mirror: id is required")
	}
	if run.Runtime != "go" && run.Runtime != "sdk" {
		return fmt.Errorf("workflow run mirror %s: runtime must be 'go' or 'sdk'", run.ID)
	}
	switch run.Status {
	case "running", "done", "failed", "stopped":
	default:
		return fmt.Errorf("workflow run mirror %s: status must be running/done/failed/stopped", run.ID)
	}
	const query = `
INSERT INTO workflow_runs
    (id, workflow_id, workflow_name, runtime, status, model_profile, started_at, finished_at)
VALUES ($1, $2, $3, $4, $5, $6,
        COALESCE(NULLIF($7, '')::timestamptz, now()),
        CASE WHEN $5 IN ('done','failed','stopped') THEN NULLIF($8, '')::timestamptz END)
ON CONFLICT (id) DO UPDATE SET
    workflow_id   = EXCLUDED.workflow_id,
    workflow_name = EXCLUDED.workflow_name,
    runtime       = EXCLUDED.runtime,
    status        = EXCLUDED.status,
    model_profile = EXCLUDED.model_profile,
    started_at    = EXCLUDED.started_at,
    finished_at   = EXCLUDED.finished_at`
	_, err := db.ExecContext(ctx, query, run.ID, run.WorkflowID, run.WorkflowName,
		run.Runtime, run.Status, run.ModelProfile, run.StartedAt, run.UpdatedAt)
	return err
}
