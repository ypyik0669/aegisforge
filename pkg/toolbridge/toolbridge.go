// Package toolbridge exposes the Go tool registry (SSOT) over HTTP so the
// flowd/Node execution path can discover and invoke the same tools the Go
// agent runtime uses — every invocation passes through the same guard chain
// and the same audit ledger.
//
// Two surfaces: GET /api/tools/registry (catalog listing) and
// POST /api/tools/invoke (guarded execution, see invoke.go). pg may be nil in
// standalone mode (cmd/flowdbridge): the catalog is then served from the live
// registry and the enabled check is skipped.
package toolbridge

import (
	"encoding/json"
	"net/http"
	"sync"

	"github.com/Autumn-27/artex/db"
)

// Registry serves the tools table (and, when an Invoker is wired, the invoke
// endpoint) over HTTP. Constructed by the server assembly after wireTools has
// seeded the built-ins.
type Registry struct {
	pg      *db.DB
	invoker *Invoker

	mu      sync.Mutex
	clients map[string]bool // subscribed flowd instances for future change push
}

// New creates a Registry backed by pg. With a nil pg the registry endpoint
// serves the live code registry instead of the tools table.
func New(pg *db.DB) *Registry {
	return &Registry{pg: pg, clients: make(map[string]bool)}
}

// NewWithInvoker creates a Registry that also serves POST /api/tools/invoke.
func NewWithInvoker(pg *db.DB, invoker *Invoker) *Registry {
	return &Registry{pg: pg, invoker: invoker, clients: make(map[string]bool)}
}

// RegisterRoutes mounts the bridge on mux. The caller is responsible for
// auth middleware on mux (same token as the rest of /api).
func (r *Registry) RegisterRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/tools/registry", r.handleList)
	mux.HandleFunc("POST /api/tools/invoke", r.handleInvoke)
}

func (r *Registry) handleList(w http.ResponseWriter, req *http.Request) {
	type entry struct {
		Key         string          `json:"key"`
		System      bool            `json:"system"`
		Description string          `json:"description"`
		Schema      json.RawMessage `json:"schema"`
		Agents      []string        `json:"agents"`
		Enabled     bool            `json:"enabled"`
		Kind        string          `json:"kind"`
		Deferred    bool            `json:"deferred"`
	}
	var out []entry
	if r.pg != nil {
		rows, err := r.pg.ListTools()
		if err != nil {
			http.Error(w, `{"error":{"code":"db","message":"failed to read tools"}}`, http.StatusInternalServerError)
			return
		}
		out = make([]entry, 0, len(rows))
		for _, t := range rows {
			agents := t.Agents
			if agents == nil {
				agents = []string{}
			}
			out = append(out, entry{
				Key: t.Key, System: t.System, Description: t.Description,
				Schema: t.Schema, Agents: agents, Enabled: t.Enabled,
				Kind: t.Kind, Deferred: t.Deferred,
			})
		}
	} else if r.invoker != nil {
		reg := r.invoker.registry()
		out = make([]entry, 0, len(reg))
		for key, t := range reg {
			schema, _ := json.Marshal(t.InputSchema())
			out = append(out, entry{
				Key: key, System: true, Description: t.Description(),
				Schema: schema, Agents: []string{}, Enabled: true, Kind: "builtin",
			})
		}
	} else {
		out = []entry{}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"tools": out})
}
