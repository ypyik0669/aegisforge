package pjtools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	acperm "github.com/Autumn-27/norma/permission"
	actool "github.com/Autumn-27/norma/tool"
)

// Routing mirrors the unirev routing contract (signal match → route id), with
// the authorization gate first: no authorization marker → R-GATE-REJECT.
const (
	RouteGateReject = "R-GATE-REJECT"
	RouteCross      = "R-CROSS"
)

// Seed is one tools-table row for the bridge catalog.
type Seed struct {
	Key    string
	Desc   string
	Schema map[string]any
	Agents []string
}

// Service binds a Store to its CoreTools.
type Service struct {
	store *Store
	tools map[string]actool.CoreTool
}

// Close releases the underlying store.
func (s *Service) Close() error { return s.store.Close() }

// Tools returns the name→CoreTool registry (for the toolbridge invoker).
func (s *Service) Tools() map[string]actool.CoreTool { return s.tools }

// Seeds returns the tools-table seed rows (pj tools bind to no Go agent by
// default; they are reachable through the toolbridge and by manual binding).
func (s *Service) Seeds() []Seed {
	out := make([]Seed, 0, len(s.tools))
	// Stable order for deterministic seeding.
	names := make([]string, 0, len(s.tools))
	for n := range s.tools {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		t := s.tools[n]
		out = append(out, Seed{Key: t.Name(), Desc: t.Description(), Schema: t.InputSchema(), Agents: []string{}})
	}
	return out
}

func obj(props map[string]any, required ...string) map[string]any {
	m := map[string]any{"type": "object", "properties": props}
	if len(required) > 0 {
		m["required"] = required
	}
	return m
}

func str(desc string) map[string]any { return map[string]any{"type": "string", "description": desc} }

func enum(desc string, values ...string) map[string]any {
	return map[string]any{"type": "string", "description": desc, "enum": values}
}

// Open creates the service at dir (SQLite file inside).
func Open(dir string) (*Service, error) {
	store, err := openStore(dir)
	if err != nil {
		return nil, err
	}
	s := &Service{store: store, tools: map[string]actool.CoreTool{}}
	s.tools["pj_route"] = s.routeTool()
	s.tools["pj_case"] = s.caseTool()
	s.tools["pj_facts"] = s.factsTool()
	s.tools["pj_report"] = s.reportTool()
	s.tools["pj_sample"] = s.sampleTool()
	s.tools["pj_scan"] = s.scanTool()
	s.tools["pj_aob"] = s.aobTool()
	s.tools["pj_va2off"] = s.va2offTool()
	s.tools["pj_decompile"] = s.decompileTool()
	s.tools["pj_bindiff"] = s.bindiffTool()
	s.tools["pj_crypto"] = s.cryptoTool()
	s.tools["pj_decode"] = s.decodeTool()
	s.tools["pj_keygen"] = s.keygenTool()
	s.tools["pj_patch"] = s.patchTool()
	s.tools["pj_squad"] = s.squadTool()
	s.tools["pj_runbook"] = s.runbookTool()
	s.tools["pj_profile"] = s.profileTool()
	s.tools["pj_skills"] = s.skillsTool()
	s.tools["pj_engine"] = s.engineTool()
	s.tools["pj_selftest"] = s.selftestTool()
	return s, nil
}

// allow is the per-tool self-check: the toolbridge guard chain is the gate.
func allow(context.Context, json.RawMessage, acperm.Context) acperm.Decision { return acperm.Allowed() }

// errf builds an error Result (actool.Errorf takes only the final string).
func errf(format string, args ...any) actool.Result {
	return actool.Errorf(fmt.Sprintf(format, args...))
}

func (s *Service) routeTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_route",
		Description: "pj_route: unirev 路由决策。输入需求描述（自由文本，可混 signals 数组补充关键词），" +
			"按 vendored routing.json 的 8 条路由加权匹配（长信号优先），回执带 primary toolset 与 kb。" +
			"无信号命中且无授权声明（authorized/scope）→ R-GATE-REJECT。",
		Schema: obj(map[string]any{
			"input":   str("需求描述（自由文本，如「分析这个 Windows PE 恶意样本」）"),
			"signals": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "补充信号词（可选，拼进匹配文本）"},
			"goal":    str("本次逆向目标（可选，仅用于回执展示）"),
		}, "input"),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Input   string   `json:"input"`
				Signals []string `json:"signals"`
				Goal    string   `json:"goal"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_route: bad input: %v", err), nil
			}
			routing, err := LoadRouting()
			if err != nil {
				return errf("pj_route: %v", err), nil
			}
			text := input.Input
			if len(input.Signals) > 0 {
				text = text + " " + strings.Join(input.Signals, " ")
			}
			match := RouteAgainst(routing, text)
			var b strings.Builder
			fmt.Fprintf(&b, "route=%s\n", match.Route)
			fmt.Fprintf(&b, "reason=%s\n", match.Reason)
			if match.Rule != nil {
				fmt.Fprintf(&b, "primary=%s", match.Rule.Primary.Toolset)
				if match.Rule.Primary.Skill != "" {
					fmt.Fprintf(&b, " skill=%s", match.Rule.Primary.Skill)
				} else if len(match.Rule.Primary.Tools) > 0 {
					fmt.Fprintf(&b, " tools=%s", strings.Join(match.Rule.Primary.Tools, "/"))
				}
				b.WriteString("\n")
				for len(match.Rule.KB) > 0 {
					fmt.Fprintf(&b, "kb=%s\n", strings.Join(match.Rule.KB, ","))
					break
				}
			}
			if match.Gated {
				b.WriteString("blocked: " + routing.Gates.Consent + "\n")
			}
			if input.Goal != "" {
				fmt.Fprintf(&b, "goal=%s\n", input.Goal)
			}
			return actool.Text(strings.TrimRight(b.String(), "\n")), nil
		},
	})
}

func (s *Service) caseTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_case",
		Description: "pj_case: 逆向案件管理。action=create（title 必填，可带 route/goal，返回 case_id）/" +
			"get（id）/list/update（id+status: open|in_progress|closed）。状态存 SQLite。",
		Schema: obj(map[string]any{
			"action": enum("create | get | list | update", "create", "get", "list", "update"),
			"id":     str("案件 id（get/update 必填）"),
			"title":  str("案件标题（create 必填）"),
			"route":  str("路由 id，如 R-PE / R-CTF-WEB（create 可选）"),
			"goal":   str("目标描述（create 可选）"),
			"status": enum("新状态（update 必填）", "open", "in_progress", "closed"),
		}, "action"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action string `json:"action"`
				ID     string `json:"id"`
				Title  string `json:"title"`
				Route  string `json:"route"`
				Goal   string `json:"goal"`
				Status string `json:"status"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_case: bad input: %v", err), nil
			}
			switch input.Action {
			case "create":
				c, err := s.store.CreateCase(input.Title, input.Route, input.Goal)
				if err != nil {
					return errf("pj_case: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("created case_id=%s title=%q route=%s status=%s", c.ID, c.Title, c.Route, c.Status)), nil
			case "get":
				c, err := s.store.GetCase(input.ID)
				if err != nil {
					return errf("pj_case: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("case_id=%s title=%q route=%s status=%s created=%s", c.ID, c.Title, c.Route, c.Status, c.CreatedAt.Format("2006-01-02 15:04"))), nil
			case "list":
				cs, err := s.store.ListCases()
				if err != nil {
					return errf("pj_case: %v", err), nil
				}
				if len(cs) == 0 {
					return actool.Text("no cases"), nil
				}
				var b strings.Builder
				for _, c := range cs {
					fmt.Fprintf(&b, "case_id=%s title=%q route=%s status=%s\n", c.ID, c.Title, c.Route, c.Status)
				}
				return actool.Text(strings.TrimRight(b.String(), "\n")), nil
			case "update":
				if err := s.store.UpdateCase(input.ID, input.Status); err != nil {
					return errf("pj_case: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("case_id=%s status=%s", input.ID, input.Status)), nil
			default:
				return errf("pj_case: unknown action %q (create|get|list|update)", input.Action), nil
			}
		},
	})
}

func (s *Service) factsTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_facts",
		Description: "pj_facts: 案件证据链。action=add（case_id+content 必填，kind=observation|artifact|decision|finding，" +
			"可选 source）/list（case_id）/export_bundle（case_id，写 evidence-bundle JSON，" +
			"供 craft-anything import_evidence_bundle 入账本）/import_bundle（case_id+bundle_path，" +
			"把 rea export_evidence_bundle 的证据入本案件账本，按证据 id 记来源）。证据按时间序追加，报告直接消费。",
		Schema: obj(map[string]any{
			"action":      enum("add | list | export_bundle | import_bundle", "add", "list", "export_bundle", "import_bundle"),
			"case_id":     str("案件 id"),
			"kind":        enum("证据类型（add 可选，默认 observation）", "observation", "artifact", "decision", "finding"),
			"content":     str("证据内容（add 必填）"),
			"source":      str("来源（文件/地址/工具，可选）"),
			"bundle_path": str("bundle 文件路径（export_bundle 输出 / import_bundle 输入，缺省 reports/<case_id>.evidence.json）"),
		}, "action", "case_id"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, tc *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action     string `json:"action"`
				CaseID     string `json:"case_id"`
				Kind       string `json:"kind"`
				Content    string `json:"content"`
				Source     string `json:"source"`
				BundlePath string `json:"bundle_path"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_facts: bad input: %v", err), nil
			}
			switch input.Action {
			case "add":
				f, err := s.store.AddFact(input.CaseID, input.Kind, input.Content, input.Source)
				if err != nil {
					return errf("pj_facts: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("fact_id=%s case_id=%s kind=%s", f.ID, f.CaseID, f.Kind)), nil
			case "list":
				fs, err := s.store.ListFacts(input.CaseID)
				if err != nil {
					return errf("pj_facts: %v", err), nil
				}
				if len(fs) == 0 {
					return actool.Text("no facts"), nil
				}
				var b strings.Builder
				for _, f := range fs {
					fmt.Fprintf(&b, "[%s] %s (%s) %s\n", f.Kind, f.Text, f.ID, f.Source)
				}
				return actool.Text(strings.TrimRight(b.String(), "\n")), nil
			case "export_bundle":
				return s.exportEvidenceBundle(input.CaseID, input.BundlePath, tc)
			case "import_bundle":
				return s.importEvidenceBundle(input.CaseID, input.BundlePath, tc)
			default:
				return errf("pj_facts: unknown action %q (add|list|export_bundle|import_bundle)", input.Action), nil
			}
		},
	})
}

// evidenceBundle is the interchange file between pj_facts and the external
// unirev toolsets (rea export_evidence_bundle ↔ craft-anything
// import_evidence_bundle). Entry ids are preserved on export so CA-side
// findings can reference them; imports keep the original id in the source
// line for traceability.
type evidenceBundle struct {
	Format     string         `json:"format"`
	Case       evidenceOrigin `json:"case"`
	ExportedAt string         `json:"exported_at"`
	Entries    []bundleEntry  `json:"entries"`
}

type evidenceOrigin struct {
	ID    string `json:"id"`
	Title string `json:"title,omitempty"`
	Route string `json:"route,omitempty"`
}

type bundleEntry struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Text   string `json:"text"`
	Source string `json:"source,omitempty"`
	At     string `json:"at,omitempty"`
}

const bundleFormat = "aegisforge.evidence-bundle/1"

func bundlePath(caseID, explicit string, tc *actool.ToolContext) string {
	p := explicit
	if p == "" {
		p = filepath.Join("reports", caseID+".evidence.json")
	}
	if tc != nil && tc.WorkingDir != "" && !filepath.IsAbs(p) {
		p = filepath.Join(tc.WorkingDir, p)
	}
	return p
}

func (s *Service) exportEvidenceBundle(caseID, explicitPath string, tc *actool.ToolContext) (actool.Result, error) {
	c, err := s.store.GetCase(caseID)
	if err != nil {
		return errf("pj_facts: %v", err), nil
	}
	fs, err := s.store.ListFacts(caseID)
	if err != nil {
		return errf("pj_facts: %v", err), nil
	}
	entries := make([]bundleEntry, 0, len(fs))
	for _, f := range fs {
		entries = append(entries, bundleEntry{
			ID: f.ID, Kind: f.Kind, Text: f.Text, Source: f.Source,
			At: f.At.Format(time.RFC3339),
		})
	}
	bundle := evidenceBundle{
		Format:     bundleFormat,
		Case:       evidenceOrigin{ID: c.ID, Title: c.Title, Route: c.Route},
		ExportedAt: now(),
		Entries:    entries,
	}
	data, err := json.MarshalIndent(bundle, "", "  ")
	if err != nil {
		return errf("pj_facts: marshal: %v", err), nil
	}
	path := bundlePath(caseID, explicitPath, tc)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return errf("pj_facts: %v", err), nil
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		return errf("pj_facts: %v", err), nil
	}
	return actool.Text(fmt.Sprintf("bundle written: %s (%d entries, format=%s)", path, len(entries), bundleFormat)), nil
}

func (s *Service) importEvidenceBundle(caseID, explicitPath string, tc *actool.ToolContext) (actool.Result, error) {
	path := bundlePath(caseID, explicitPath, tc)
	data, err := os.ReadFile(path)
	if err != nil {
		return errf("pj_facts: %v", err), nil
	}
	var bundle evidenceBundle
	if err := json.Unmarshal(data, &bundle); err != nil {
		return errf("pj_facts: bundle is not valid JSON: %v", err), nil
	}
	if bundle.Format != bundleFormat {
		return errf("pj_facts: unsupported bundle format %q (want %s)", bundle.Format, bundleFormat), nil
	}
	if len(bundle.Entries) == 0 {
		return actool.Text("bundle has no entries"), nil
	}
	origin := bundle.Case.ID
	if origin == "" {
		origin = filepath.Base(path)
	}
	imported := 0
	var skipped []string
	existing, err := s.store.ListFacts(caseID)
	if err != nil {
		return errf("pj_facts: %v", err), nil
	}
	for _, e := range bundle.Entries {
		// Idempotent: the same bundle entry (origin + id) is not re-imported.
		// The source may carry a " via <origin-source>" suffix — match the prefix.
		dupSource := "bundle:" + origin + "/" + e.ID
		seen := false
		for _, f := range existing {
			if strings.HasPrefix(f.Source, dupSource) {
				seen = true
				break
			}
		}
		if seen {
			skipped = append(skipped, e.ID)
			continue
		}
		src := dupSource
		if e.Source != "" {
			src += " via " + e.Source
		}
		if _, err := s.store.AddFact(caseID, e.Kind, e.Text, src); err != nil {
			skipped = append(skipped, e.ID+" ("+err.Error()+")")
			continue
		}
		imported++
	}
	var b strings.Builder
	fmt.Fprintf(&b, "bundle imported: %d entries from %s (origin case %s)", imported, path, origin)
	if len(skipped) > 0 {
		fmt.Fprintf(&b, "\nskipped %d: %s", len(skipped), strings.Join(skipped, ", "))
	}
	return actool.Text(b.String()), nil
}

func (s *Service) reportTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name: "pj_report",
		Description: "pj_report: 汇总案件生成 Markdown 报告（案件元信息 + 证据链），落盘 reports/<case_id>.md，" +
			"回执带路径。case 必须存在。",
		Schema: obj(map[string]any{
			"case_id": str("案件 id"),
		}, "case_id"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, tc *actool.ToolContext) (actool.Result, error) {
			var input struct {
				CaseID string `json:"case_id"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_report: bad input: %v", err), nil
			}
			c, err := s.store.GetCase(input.CaseID)
			if err != nil {
				return errf("pj_report: %v", err), nil
			}
			fs, err := s.store.ListFacts(input.CaseID)
			if err != nil {
				return errf("pj_report: %v", err), nil
			}
			var b strings.Builder
			fmt.Fprintf(&b, "# 逆向案件报告 %s\n\n", c.ID)
			fmt.Fprintf(&b, "- 标题：%s\n- 路由：%s\n- 状态：%s\n- 创建：%s\n", c.Title, c.Route, c.Status, c.CreatedAt.Format(time.RFC3339))
			if c.Goal != "" {
				fmt.Fprintf(&b, "- 目标：%s\n", c.Goal)
			}
			b.WriteString("\n## 证据链\n\n")
			if len(fs) == 0 {
				b.WriteString("（无证据记录）\n")
			}
			for _, f := range fs {
				fmt.Fprintf(&b, "- **[%s]** %s", f.Kind, f.Text)
				if f.Source != "" {
					fmt.Fprintf(&b, "（来源：%s）", f.Source)
				}
				fmt.Fprintf(&b, " — `%s`\n", f.ID)
			}
			path := filepath.Join("reports", c.ID+".md")
			if tc != nil && tc.WorkingDir != "" {
				path = filepath.Join(tc.WorkingDir, path)
			}
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return errf("pj_report: %v", err), nil
			}
			if err := os.WriteFile(path, []byte(b.String()), 0o644); err != nil {
				return errf("pj_report: %v", err), nil
			}
			return actool.Text(fmt.Sprintf("report written: %s (%d facts)", path, len(fs))), nil
		},
	})
}
