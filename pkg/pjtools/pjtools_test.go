package pjtools

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func openTest(t *testing.T) *Service {
	t.Helper()
	svc, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { svc.Close() })
	return svc
}

func TestRouteSemantics(t *testing.T) {
	routing, err := LoadRouting()
	if err != nil {
		t.Fatalf("load routing: %v", err)
	}
	// Signal hit → route (authorization markers are a work-start concern, not routing).
	if got := RouteAgainst(routing, "分析这个 Windows PE 恶意样本").Route; got != "R-PE" {
		t.Fatalf("PE sample → R-PE, got %s", got)
	}
	if got := RouteAgainst(routing, "逆向一个 CTF 的 crackme").Route; got != "R-CTF-PWN" {
		t.Fatalf("longer signal must win the tie → R-CTF-PWN, got %s", got)
	}
	// No signal hit, no authorization → gate reject.
	if got := RouteAgainst(routing, "对目标站点发起字典爆破"); got.Route != RouteGateReject || !got.Gated {
		t.Fatalf("destructive intent without scope → gate reject, got %+v", got)
	}
	// No signal hit, authorization declared → cross fallback.
	if got := RouteAgainst(routing, "authorized by owner, review the thing").Route; got != RouteCross {
		t.Fatalf("authorized no-hit → R-CROSS, got %s", got)
	}
}

func TestCaseLifecycle(t *testing.T) {
	svc := openTest(t)
	c, err := svc.store.CreateCase("toolbridge-e2e", "R-PE", "prove the chain")
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if !strings.HasPrefix(c.ID, "PJ-") || c.Status != "open" {
		t.Fatalf("unexpected case %+v", c)
	}
	if _, err := svc.store.CreateCase("", "", ""); err == nil {
		t.Fatal("empty title must be rejected")
	}
	if err := svc.store.UpdateCase(c.ID, "in_progress"); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := svc.store.GetCase(c.ID)
	if err != nil || got.Status != "in_progress" {
		t.Fatalf("get after update: %+v err=%v", got, err)
	}
	if err := svc.store.UpdateCase(c.ID, "bogus"); err == nil {
		t.Fatal("bogus status must be rejected")
	}
	if err := svc.store.UpdateCase("PJ-19700101-0000", "open"); err == nil {
		t.Fatal("unknown case update must fail")
	}
}

func TestFactsAndValidation(t *testing.T) {
	svc := openTest(t)
	c, _ := svc.store.CreateCase("facts", "R-APK", "")
	if _, err := svc.store.AddFact(c.ID, "", "found packed dex", "sample.apk"); err != nil {
		t.Fatalf("add default-kind fact: %v", err)
	}
	if _, err := svc.store.AddFact(c.ID, "bogus", "x", ""); err == nil {
		t.Fatal("bogus kind must be rejected")
	}
	if _, err := svc.store.AddFact(c.ID, "finding", "  ", ""); err == nil {
		t.Fatal("empty content must be rejected")
	}
	fs, err := svc.store.ListFacts(c.ID)
	if err != nil || len(fs) != 1 || fs[0].Kind != "observation" {
		t.Fatalf("facts: %+v err=%v", fs, err)
	}
}

func TestToolReceipts(t *testing.T) {
	svc := openTest(t)
	call := func(name, input string) (string, bool) {
		t.Helper()
		tool := svc.Tools()[name]
		if tool == nil {
			t.Fatalf("tool %s missing", name)
		}
		res, err := tool.Call(t.Context(), []byte(input), nil)
		if err != nil {
			t.Fatalf("%s call: %v", name, err)
		}
		return res.Flatten(), res.IsError
	}
	// Gate reject on unguarded route.
	out, isErr := call("pj_route", `{"signals":["exe"]}`)
	if isErr || !strings.Contains(out, "R-GATE-REJECT") {
		t.Fatalf("pj_route receipt: %q isErr=%v", out, isErr)
	}
	out, _ = call("pj_case", `{"action":"create","title":"chain","route":"R-PE"}`)
	var caseID string
	for _, f := range strings.Fields(out) {
		if strings.HasPrefix(f, "case_id=") {
			caseID = strings.TrimPrefix(f, "case_id=")
		}
	}
	if caseID == "" {
		t.Fatalf("create receipt missing case_id: %q", out)
	}
	if out, isErr = call("pj_case", `{"action":"create"}`); !isErr {
		t.Fatalf("empty-title create must be an error receipt, got %q", out)
	}
	if out, _ = call("pj_facts", `{"action":"add","case_id":"`+caseID+`","kind":"finding","content":"entropy 7.8","source":"pj_sample"}`); !strings.HasPrefix(out, "fact_id=") {
		t.Fatalf("fact add receipt: %q", out)
	}
	if out, _ = call("pj_facts", `{"action":"list","case_id":"`+caseID+`"}`); !strings.Contains(out, "entropy 7.8") {
		t.Fatalf("fact list receipt: %q", out)
	}
	out, isErr = call("pj_case", `{"action":"get","case_id":"nope"}`)
	if !isErr || !strings.Contains(out, "not found") {
		t.Fatalf("unknown case receipt: %q isErr=%v", out, isErr)
	}
}

func TestSeedsShape(t *testing.T) {
	svc := openTest(t)
	seeds := svc.Seeds()
	if len(seeds) != 20 {
		t.Fatalf("expected 20 seeds, got %d", len(seeds))
	}
	seen := map[string]bool{}
	for _, s := range seeds {
		seen[s.Key] = true
		if s.Desc == "" || s.Schema == nil {
			t.Fatalf("seed %s missing desc/schema", s.Key)
		}
	}
	for _, want := range []string{"pj_route", "pj_case", "pj_facts", "pj_report"} {
		if !seen[want] {
			t.Fatalf("missing seed %s", want)
		}
	}
}

func TestEvidenceBundleRoundtrip(t *testing.T) {
	svc := openTest(t)
	src, err := svc.store.CreateCase("bundle-src", "R-PE", "")
	if err != nil {
		t.Fatalf("create src: %v", err)
	}
	if _, err := svc.store.AddFact(src.ID, "observation", "entrypoint is at 0x1400", "pj_decompile"); err != nil {
		t.Fatalf("add fact: %v", err)
	}
	if _, err := svc.store.AddFact(src.ID, "finding", "activation check at VA 0x140001000", ""); err != nil {
		t.Fatalf("add fact: %v", err)
	}
	dir := t.TempDir()
	bundleFile := dir + "/bundle.json"

	callTool := func(action, caseID, path string) (string, bool) {
		t.Helper()
		res, err := svc.tools["pj_facts"].Call(t.Context(), []byte(
			`{"action":"`+action+`","case_id":"`+caseID+`","bundle_path":`+quoteJSON(path)+`}`), nil)
		if err != nil {
			t.Fatalf("%s: %v", action, err)
		}
		return res.Flatten(), res.IsError
	}

	out, isErr := callTool("export_bundle", src.ID, bundleFile)
	if isErr || !strings.Contains(out, "2 entries") {
		t.Fatalf("export receipt: %q isErr=%v", out, isErr)
	}
	// Cross-case import: a second case ingests the bundle once per entry.
	dst, err := svc.store.CreateCase("bundle-dst", "", "")
	if err != nil {
		t.Fatalf("create dst: %v", err)
	}
	out, isErr = callTool("import_bundle", dst.ID, bundleFile)
	if isErr || !strings.Contains(out, "2 entries") || strings.Contains(out, "skipped") {
		t.Fatalf("import receipt: %q isErr=%v", out, isErr)
	}
	fs, err := svc.store.ListFacts(dst.ID)
	if err != nil || len(fs) != 2 {
		t.Fatalf("dst facts: %d err=%v", len(fs), err)
	}
	if fs[0].Source != "bundle:"+src.ID+"/"+fs[0].ID && !strings.HasPrefix(fs[0].Source, "bundle:"+src.ID+"/") {
		t.Fatalf("import source must record origin bundle id, got %q", fs[0].Source)
	}
	// Re-import is idempotent: same entries skipped.
	out, isErr = callTool("import_bundle", dst.ID, bundleFile)
	if isErr || !strings.Contains(out, "skipped 2") {
		t.Fatalf("re-import receipt: %q isErr=%v", out, isErr)
	}
	fs, _ = svc.store.ListFacts(dst.ID)
	if len(fs) != 2 {
		t.Fatalf("re-import duplicated facts: %d", len(fs))
	}
	// Bad format rejected.
	if err := writeFile(bundleFile, []byte(`{"format":"other/9","entries":[]}`)); err != nil {
		t.Fatal(err)
	}
	out, isErr = callTool("import_bundle", dst.ID, bundleFile)
	if !isErr || !strings.Contains(out, "unsupported bundle format") {
		t.Fatalf("bad format receipt: %q isErr=%v", out, isErr)
	}
}

func quoteJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func writeFile(path string, data []byte) error {
	return os.WriteFile(path, data, 0o644)
}
