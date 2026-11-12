// Package pjtools implements the pj_* reverse-engineering case tools
// (minimal P1 subset: pj_route / pj_case / pj_facts / pj_report). State lives
// in a per-deployment SQLite database; every tool answers with a plain-text
// receipt (the contract the workflow engine and agents parse).
//
// pj_route enforces the authorization gate first: without an explicit
// authorization marker the route is R-GATE-REJECT, mirroring the upstream
// routing contract (no work without scope).
package pjtools

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// Case is one reverse-engineering engagement record.
type Case struct {
	ID        string
	Title     string
	Route     string
	Goal      string
	Status    string // open | in_progress | closed
	CreatedAt time.Time
	UpdatedAt time.Time
}

// Fact is one piece of recorded evidence attached to a case.
type Fact struct {
	ID     string
	CaseID string
	Kind   string // observation | artifact | decision | finding
	Text   string
	Source string
	At     time.Time
}

// Store is the SQLite-backed case/fact state.
type Store struct {
	db *sql.DB
}

// openStore creates (idempotently) the SQLite store at dir/pj.sqlite3.
func openStore(dir string) (*Store, error) {
	db, err := sql.Open("sqlite", dir+"/pj.sqlite3")
	if err != nil {
		return nil, err
	}
	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, err
		}
	}
	schema := `
CREATE TABLE IF NOT EXISTS pj_cases (
	id         TEXT PRIMARY KEY,
	title      TEXT NOT NULL,
	route      TEXT NOT NULL DEFAULT '',
	goal       TEXT NOT NULL DEFAULT '',
	status     TEXT NOT NULL DEFAULT 'open',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pj_facts (
	id         TEXT PRIMARY KEY,
	case_id    TEXT NOT NULL,
	kind       TEXT NOT NULL DEFAULT 'observation',
	content    TEXT NOT NULL,
	source     TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_facts_case ON pj_facts(case_id);
CREATE TABLE IF NOT EXISTS pj_squads (
	id         TEXT PRIMARY KEY,
	case_id    TEXT NOT NULL,
	role       TEXT NOT NULL,
	member     TEXT NOT NULL,
	status     TEXT NOT NULL DEFAULT 'active',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_squads_case ON pj_squads(case_id);
CREATE TABLE IF NOT EXISTS pj_runbook_steps (
	id         TEXT PRIMARY KEY,
	case_id    TEXT NOT NULL,
	seq        INTEGER NOT NULL,
	text       TEXT NOT NULL,
	status     TEXT NOT NULL DEFAULT 'pending',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pj_runbook_case ON pj_runbook_steps(case_id);
CREATE TABLE IF NOT EXISTS pj_profiles (
	case_id    TEXT NOT NULL,
	key        TEXT NOT NULL,
	content    TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (case_id, key)
);
`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close releases the database handle.
func (s *Store) Close() error { return s.db.Close() }

const idTimeLayout = "20060102"

// newID builds a case id: PJ-20261112-a1b2 (date + 4 random hex chars).
func newID(prefix string) string {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("%s-%s-%s", prefix, time.Now().Format(idTimeLayout), hex.EncodeToString(b[:]))
}

func now() string { return time.Now().UTC().Format(time.RFC3339) }

// CreateCase inserts a case and returns it.
func (s *Store) CreateCase(title, route, goal string) (Case, error) {
	c := Case{
		ID: newID("PJ"), Title: title, Route: route, Goal: goal, Status: "open",
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}
	if strings.TrimSpace(c.Title) == "" {
		return Case{}, fmt.Errorf("title is required")
	}
	_, err := s.db.Exec(
		`INSERT INTO pj_cases (id, title, route, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
		c.ID, c.Title, c.Route, c.Goal, c.Status, now(), now())
	return c, err
}

// GetCase reads one case by id.
func (s *Store) GetCase(id string) (Case, error) {
	row := s.db.QueryRow(
		`SELECT id, title, route, goal, status, created_at, updated_at FROM pj_cases WHERE id=?`, id)
	var c Case
	var created, updated string
	if err := row.Scan(&c.ID, &c.Title, &c.Route, &c.Goal, &c.Status, &created, &updated); err != nil {
		if err == sql.ErrNoRows {
			return Case{}, fmt.Errorf("case %s not found", id)
		}
		return Case{}, err
	}
	c.CreatedAt, _ = time.Parse(time.RFC3339, created)
	c.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
	return c, nil
}

// ListCases returns every case, newest first.
func (s *Store) ListCases() ([]Case, error) {
	rows, err := s.db.Query(
		`SELECT id, title, route, goal, status, created_at, updated_at FROM pj_cases ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Case
	for rows.Next() {
		var c Case
		var created, updated string
		if err := rows.Scan(&c.ID, &c.Title, &c.Route, &c.Goal, &c.Status, &created, &updated); err != nil {
			return nil, err
		}
		c.CreatedAt, _ = time.Parse(time.RFC3339, created)
		c.UpdatedAt, _ = time.Parse(time.RFC3339, updated)
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateCase sets a case status (open | in_progress | closed).
func (s *Store) UpdateCase(id, status string) error {
	switch status {
	case "open", "in_progress", "closed":
	default:
		return fmt.Errorf("invalid status %q (open|in_progress|closed)", status)
	}
	res, err := s.db.Exec(`UPDATE pj_cases SET status=?, updated_at=? WHERE id=?`, status, now(), id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("case %s not found", id)
	}
	return nil
}

// AddFact appends an evidence entry to a case.
func (s *Store) AddFact(caseID, kind, text, source string) (Fact, error) {
	if strings.TrimSpace(text) == "" {
		return Fact{}, fmt.Errorf("content is required")
	}
	if kind == "" {
		kind = "observation"
	}
	switch kind {
	case "observation", "artifact", "decision", "finding":
	default:
		return Fact{}, fmt.Errorf("invalid kind %q (observation|artifact|decision|finding)", kind)
	}
	f := Fact{ID: newID("PF"), CaseID: caseID, Kind: kind, Text: text, Source: source, At: time.Now().UTC()}
	_, err := s.db.Exec(
		`INSERT INTO pj_facts (id, case_id, kind, content, source, created_at) VALUES (?,?,?,?,?,?)`,
		f.ID, f.CaseID, f.Kind, f.Text, f.Source, now())
	return f, err
}

// ListFacts returns a case's facts in insertion (chronological) order.
func (s *Store) ListFacts(caseID string) ([]Fact, error) {
	rows, err := s.db.Query(
		`SELECT id, case_id, kind, content, source, created_at FROM pj_facts WHERE case_id=? ORDER BY created_at, id`, caseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Fact
	for rows.Next() {
		var f Fact
		var at string
		if err := rows.Scan(&f.ID, &f.CaseID, &f.Kind, &f.Text, &f.Source, &at); err != nil {
			return nil, err
		}
		f.At, _ = time.Parse(time.RFC3339, at)
		out = append(out, f)
	}
	return out, rows.Err()
}

// Squad is one role assignment in a case's roster.
type Squad struct {
	ID     string
	CaseID string
	Role   string
	Member string
	Status string
}

// AssignMember adds (or re-assigns) a role on a case's squad. Re-assigning a
// role flips the previous holder to `retired` rather than deleting history.
func (s *Store) AssignMember(caseID, role, member string) (Squad, error) {
	if strings.TrimSpace(role) == "" || strings.TrimSpace(member) == "" {
		return Squad{}, fmt.Errorf("role and member are required")
	}
	if _, err := s.db.Exec(`UPDATE pj_squads SET status='retired' WHERE case_id=? AND role=? AND status='active'`, caseID, role); err != nil {
		return Squad{}, err
	}
	sq := Squad{ID: newID("PS"), CaseID: caseID, Role: role, Member: member, Status: "active"}
	_, err := s.db.Exec(
		`INSERT INTO pj_squads (id, case_id, role, member, status, created_at) VALUES (?,?,?,?,?,?)`,
		sq.ID, sq.CaseID, sq.Role, sq.Member, sq.Status, now())
	return sq, err
}

// ListSquads returns a case's active squad.
func (s *Store) ListSquads(caseID string) ([]Squad, error) {
	rows, err := s.db.Query(
		`SELECT id, case_id, role, member, status FROM pj_squads WHERE case_id=? AND status='active' ORDER BY created_at`, caseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Squad
	for rows.Next() {
		var q Squad
		if err := rows.Scan(&q.ID, &q.CaseID, &q.Role, &q.Member, &q.Status); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

// RunbookStep is one ordered step in a case's runbook.
type RunbookStep struct {
	ID     string
	CaseID string
	Seq    int
	Text   string
	Status string // pending | in_progress | done | skipped
}

// CreateRunbook replaces nothing: appends steps (with continuing seq) to the
// case's runbook.
func (s *Store) CreateRunbook(caseID string, steps []string) ([]RunbookStep, error) {
	if len(steps) == 0 {
		return nil, fmt.Errorf("at least one step is required")
	}
	var seq int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(seq),0) FROM pj_runbook_steps WHERE case_id=?`, caseID).Scan(&seq); err != nil {
		return nil, err
	}
	out := make([]RunbookStep, 0, len(steps))
	for _, text := range steps {
		if strings.TrimSpace(text) == "" {
			continue
		}
		seq++
		st := RunbookStep{ID: newID("PR"), CaseID: caseID, Seq: seq, Text: text, Status: "pending"}
		if _, err := s.db.Exec(
			`INSERT INTO pj_runbook_steps (id, case_id, seq, text, status, created_at) VALUES (?,?,?,?,?,?)`,
			st.ID, st.CaseID, st.Seq, st.Text, st.Status, now()); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("all steps were empty")
	}
	return out, nil
}

// ListRunbook returns a case's runbook in seq order.
func (s *Store) ListRunbook(caseID string) ([]RunbookStep, error) {
	rows, err := s.db.Query(
		`SELECT id, case_id, seq, text, status FROM pj_runbook_steps WHERE case_id=? ORDER BY seq`, caseID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RunbookStep
	for rows.Next() {
		var st RunbookStep
		if err := rows.Scan(&st.ID, &st.CaseID, &st.Seq, &st.Text, &st.Status); err != nil {
			return nil, err
		}
		out = append(out, st)
	}
	return out, rows.Err()
}

// UpdateRunbookStep sets a step status (pending|in_progress|done|skipped).
func (s *Store) UpdateRunbookStep(stepID, status string) error {
	switch status {
	case "pending", "in_progress", "done", "skipped":
	default:
		return fmt.Errorf("invalid status %q (pending|in_progress|done|skipped)", status)
	}
	res, err := s.db.Exec(`UPDATE pj_runbook_steps SET status=? WHERE id=?`, status, stepID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("step %s not found", stepID)
	}
	return nil
}

// SaveProfile upserts a named profile snapshot for a case.
func (s *Store) SaveProfile(caseID, key, content string) error {
	if strings.TrimSpace(key) == "" || strings.TrimSpace(content) == "" {
		return fmt.Errorf("key and content are required")
	}
	_, err := s.db.Exec(`
INSERT INTO pj_profiles (case_id, key, content, updated_at) VALUES (?,?,?,?)
ON CONFLICT (case_id, key) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`,
		caseID, key, content, now())
	return err
}

// GetProfile reads a named profile snapshot.
func (s *Store) GetProfile(caseID, key string) (string, error) {
	var content string
	err := s.db.QueryRow(`SELECT content FROM pj_profiles WHERE case_id=? AND key=?`, caseID, key).Scan(&content)
	if err == sql.ErrNoRows {
		return "", fmt.Errorf("profile %s/%s not found", caseID, key)
	}
	return content, err
}
