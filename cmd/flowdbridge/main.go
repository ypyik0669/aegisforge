// Command flowdbridge serves the toolbridge standalone (no PostgreSQL, no
// full ARTEX stack): the pj_* registry behind the same guard chain, so the
// flowd/SDK path has a real Go tool endpoint for development and e2e runs.
//
//	AF_BRIDGE_ADDR  listen address (default 127.0.0.1:8901)
//	AF_BRIDGE_DATA  state dir for the pjtools SQLite store (default ./data/flowdbridge)
package main

import (
	"log"
	"net/http"
	"os"

	"github.com/Autumn-27/artex/guard"
	"github.com/Autumn-27/artex/pkg/pjtools"
	"github.com/Autumn-27/artex/pkg/toolbridge"
	actool "github.com/Autumn-27/norma/tool"
)

func main() {
	addr := os.Getenv("AF_BRIDGE_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8901"
	}
	dataDir := os.Getenv("AF_BRIDGE_DATA")
	if dataDir == "" {
		dataDir = "./data/flowdbridge"
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("[flowdbridge] data dir: %v", err)
	}

	svc, err := pjtools.Open(dataDir)
	if err != nil {
		log.Fatalf("[flowdbridge] pjtools: %v", err)
	}
	defer svc.Close()
	registry := func() map[string]actool.CoreTool { return svc.Tools() }

	// Same guard chain as the in-server bridge: built-in deny rules + hooks.
	// No interceptor here (no target gate in standalone mode).
	g := guard.New()
	invoker := toolbridge.NewInvoker(nil, registry, g.Hooks(), dataDir)
	bridge := toolbridge.NewWithInvoker(nil, invoker)

	mux := http.NewServeMux()
	bridge.RegisterRoutes(mux)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"flowdbridge"}`))
	})

	log.Printf("[flowdbridge] listening on %s (data: %s, tools: pj_route/pj_case/pj_facts/pj_report)", addr, dataDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}
