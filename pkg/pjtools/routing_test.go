package pjtools

import (
	"strings"
	"testing"
)

// TestUnirevRouteTest is the AegisForge port of unirev's route-test: every
// vendored testdata case must route to its expected route id through the real
// Go router (upstream's script only checks substring presence; this runs the
// actual matcher).
func TestUnirevRouteTest(t *testing.T) {
	routing, err := LoadRouting()
	if err != nil {
		t.Fatalf("load routing: %v", err)
	}
	if routing.Gates.Consent == "" {
		t.Fatal("gates.consent missing in vendored routing.json")
	}
	if routing.Evidence.CrossPhase == "" {
		t.Fatal("evidence.crossPhase missing in vendored routing.json")
	}
	cases, err := RoutingTestCases()
	if err != nil {
		t.Fatalf("load testdata: %v", err)
	}
	if len(cases) < 20 {
		t.Fatalf("expected >= 20 testdata cases, got %d", len(cases))
	}
	for _, c := range cases {
		got := RouteAgainst(routing, c.Input)
		if got.Route != c.Expect.RouteID {
			t.Errorf("case %q: want %s got %s (%s)", c.Input, c.Expect.RouteID, got.Route, got.Reason)
			continue
		}
		if c.Expect.Gate && routing.Gates.Consent == "" {
			t.Errorf("case %q: expects the consent gate contract, gates.consent empty", c.Input)
		}
		if c.Expect.KB != "" && (got.Rule == nil || !strings.Contains(strings.Join(got.Rule.KB, ","), c.Expect.KB)) {
			t.Errorf("case %q: expected kb %s, got %v", c.Input, c.Expect.KB, got.Rule.KB)
		}
	}
}

// TestRoutingConsistency mirrors upstream's structural checks: unique route ids
// and every gate case is representable.
func TestRoutingConsistency(t *testing.T) {
	routing, err := LoadRouting()
	if err != nil {
		t.Fatalf("load routing: %v", err)
	}
	seen := map[string]bool{}
	for _, r := range routing.Routes {
		if r.ID == "" || len(r.Signals) == 0 {
			t.Fatalf("route missing id/signals: %+v", r)
		}
		if seen[r.ID] {
			t.Fatalf("duplicate route id %s", r.ID)
		}
		seen[r.ID] = true
	}
	for _, want := range []string{"R-CTF-WEB", "R-CTF-PWN", "R-APK", "R-PE", "R-WEBJS", "R-REBUILD", "R-CROSS", "R-GATE-REJECT"} {
		if !seen[want] {
			t.Fatalf("route %s missing", want)
		}
	}
}
