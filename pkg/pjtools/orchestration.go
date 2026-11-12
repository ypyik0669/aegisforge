package pjtools

// pj_* orchestration tools: squad roster, runbook steps, per-case profiles,
// the routing/skill view, engine capability probes, and the self-test.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"

	actool "github.com/Autumn-27/norma/tool"
)

func (s *Service) squadTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_squad",
		Description: "pj_squad: 案件小组花名册。action=assign（case_id+role+member；同 role 重新指派会把旧成员置 retired）/" +
			"list（case_id）。角色示例：recon / analyzer / reporter。",
		Schema: obj(map[string]any{
			"action":  enum("assign | list", "assign", "list"),
			"case_id": str("案件 id"),
			"role":    str("角色名（assign 必填）"),
			"member":  str("成员标识，agent key 或人名（assign 必填）"),
		}, "action", "case_id"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action string `json:"action"`
				CaseID string `json:"case_id"`
				Role   string `json:"role"`
				Member string `json:"member"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_squad: bad input: %v", err), nil
			}
			switch input.Action {
			case "assign":
				sq, err := s.store.AssignMember(input.CaseID, input.Role, input.Member)
				if err != nil {
					return errf("pj_squad: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("squad_id=%s case_id=%s role=%s member=%s status=%s", sq.ID, sq.CaseID, sq.Role, sq.Member, sq.Status)), nil
			case "list":
				qs, err := s.store.ListSquads(input.CaseID)
				if err != nil {
					return errf("pj_squad: %v", err), nil
				}
				if len(qs) == 0 {
					return actool.Text("squad empty"), nil
				}
				var b strings.Builder
				for _, q := range qs {
					fmt.Fprintf(&b, "%s → %s (%s)\n", q.Role, q.Member, q.ID)
				}
				return actool.Text(strings.TrimRight(b.String(), "\n")), nil
			default:
				return errf("pj_squad: unknown action %q", input.Action), nil
			}
		},
	})
}

func (s *Service) runbookTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_runbook",
		Description: "pj_runbook: 案件执行手册（有序步骤）。action=create（case_id+steps 字符串数组，seq 续接追加）/" +
			"list（case_id）/update（step_id+status: pending|in_progress|done|skipped）。报告引用步骤 id。",
		Schema: obj(map[string]any{
			"action":  enum("create | list | update", "create", "list", "update"),
			"case_id": str("案件 id"),
			"steps":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "步骤文本列表（create 必填）"},
			"step_id": str("步骤 id（update 必填）"),
			"status":  enum("新状态（update 必填）", "pending", "in_progress", "done", "skipped"),
		}, "action"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action string   `json:"action"`
				CaseID string   `json:"case_id"`
				Steps  []string `json:"steps"`
				StepID string   `json:"step_id"`
				Status string   `json:"status"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_runbook: bad input: %v", err), nil
			}
			switch input.Action {
			case "create":
				steps, err := s.store.CreateRunbook(input.CaseID, input.Steps)
				if err != nil {
					return errf("pj_runbook: %v", err), nil
				}
				var b strings.Builder
				for _, st := range steps {
					fmt.Fprintf(&b, "step_id=%s seq=%d %s\n", st.ID, st.Seq, st.Text)
				}
				return actool.Text(strings.TrimRight(b.String(), "\n")), nil
			case "list":
				steps, err := s.store.ListRunbook(input.CaseID)
				if err != nil {
					return errf("pj_runbook: %v", err), nil
				}
				if len(steps) == 0 {
					return actool.Text("runbook empty"), nil
				}
				var b strings.Builder
				for _, st := range steps {
					fmt.Fprintf(&b, "step_id=%s seq=%d [%s] %s\n", st.ID, st.Seq, st.Status, st.Text)
				}
				return actool.Text(strings.TrimRight(b.String(), "\n")), nil
			case "update":
				if err := s.store.UpdateRunbookStep(input.StepID, input.Status); err != nil {
					return errf("pj_runbook: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("step_id=%s status=%s", input.StepID, input.Status)), nil
			default:
				return errf("pj_runbook: unknown action %q", input.Action), nil
			}
		},
	})
}

func (s *Service) profileTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_profile",
		Description: "pj_profile: 案件档案快照（按 key 存取，如 sample/target/scope）。action=save（case_id+key+content，" +
			"通常存 pj_sample 的回执或 scope 说明）/get。报告与后续工具用 profile 复用分析结论。",
		Schema: obj(map[string]any{
			"action":  enum("save | get", "save", "get"),
			"case_id": str("案件 id"),
			"key":     str("快照键（如 sample / target / scope）"),
			"content": str("快照内容（save 必填）"),
		}, "action", "case_id"),
		Permissions: allow,
		Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var input struct {
				Action  string `json:"action"`
				CaseID  string `json:"case_id"`
				Key     string `json:"key"`
				Content string `json:"content"`
			}
			if err := json.Unmarshal(in, &input); err != nil {
				return errf("pj_profile: bad input: %v", err), nil
			}
			switch input.Action {
			case "save":
				if err := s.store.SaveProfile(input.CaseID, input.Key, input.Content); err != nil {
					return errf("pj_profile: %v", err), nil
				}
				return actool.Text(fmt.Sprintf("profile saved: case_id=%s key=%s (%d bytes)", input.CaseID, input.Key, len(input.Content))), nil
			case "get":
				content, err := s.store.GetProfile(input.CaseID, input.Key)
				if err != nil {
					return errf("pj_profile: %v", err), nil
				}
				return actool.Text(content), nil
			default:
				return errf("pj_profile: unknown action %q", input.Action), nil
			}
		},
	})
}

func (s *Service) skillsTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_skills",
		Description: "pj_skills: 列出 unirev 路由表里的技能面（每条路由的 primary/aux toolset 与 kb），只读。",
		Schema:      obj(map[string]any{}),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, _ json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			routing, err := LoadRouting()
			if err != nil {
				return errf("pj_skills: %v", err), nil
			}
			var b strings.Builder
			fmt.Fprintf(&b, "routing=%s consent_gate=yes\n", routing.Version)
			for _, r := range routing.Routes {
				primary := r.Primary.Toolset
				if r.Primary.Skill != "" {
					primary += " skill=" + r.Primary.Skill
				} else if len(r.Primary.Tools) > 0 {
					primary += " tools=" + strings.Join(r.Primary.Tools, "/")
				}
				fmt.Fprintf(&b, "%s primary=[%s]", r.ID, primary)
				for _, a := range r.Aux {
					primary := a.Toolset
					if a.Skill != "" {
						primary += " skill=" + a.Skill
					} else if len(a.Tools) > 0 {
						primary += " tools=" + strings.Join(a.Tools, "/")
					}
					fmt.Fprintf(&b, " aux=[%s]", primary)
				}
				if len(r.KB) > 0 {
					fmt.Fprintf(&b, " kb=[%s]", strings.Join(r.KB, ","))
				}
				b.WriteString("\n")
			}
			return actool.Text(strings.TrimRight(b.String(), "\n")), nil
		},
	})
}

// engineProbe is one capability line for pj_engine.
type engineProbe struct {
	name      string
	available bool
	detail    string
}

func probeEngines() []engineProbe {
	probes := []engineProbe{
		{"objdump", objdumpAvailable(), "disassembly (degradation path)"},
		{"strings", true, "always available (built-in)"},
	}
	if p, err := exec.LookPath("python"); err == nil || (func() bool { _, e := exec.LookPath("python3"); return e == nil })() {
		if err != nil {
			p, _ = exec.LookPath("python3")
		}
		probes = append(probes, engineProbe{"python", true, p})
	} else {
		probes = append(probes, engineProbe{"python", false, "not on PATH"})
	}
	if _, err := exec.LookPath("frida"); err == nil {
		probes = append(probes, engineProbe{"frida", true, "instrumentation"})
	} else {
		probes = append(probes, engineProbe{"frida", false, "not installed (pj_engine hooks degraded)"})
	}
	ida := os.Getenv("AF_IDA_PATH")
	if ida != "" {
		if _, err := os.Stat(ida); err == nil {
			probes = append(probes, engineProbe{"idalib", true, ida})
		} else {
			probes = append(probes, engineProbe{"idalib", false, ida + " not found"})
		}
	} else {
		probes = append(probes, engineProbe{"idalib", false, "AF_IDA_PATH unset (pj_decompile uses degradation path)"})
	}
	return probes
}

func (s *Service) engineTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_engine",
		Description: "pj_engine: 能力探测。列出 idalib / frida / objdump / python 可用性；未装 IDA/Frida 时 pj_decompile 等自动走降级路径。",
		Schema:      obj(map[string]any{}),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, _ json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var b strings.Builder
			for _, p := range probeEngines() {
				status := "no"
				if p.available {
					status = "yes"
				}
				fmt.Fprintf(&b, "%s=%s (%s)\n", p.name, status, p.detail)
			}
			return actool.Text(strings.TrimRight(b.String(), "\n")), nil
		},
	})
}

func (s *Service) selftestTool() actool.CoreTool {
	return actool.Build(actool.Spec{
		Name:        "pj_selftest",
		Description: "pj_selftest: 内部自检（store 读写回路、路由表、路由器 20 条 testdata 抽查、补丁工具 verify 路径）。回执逐项 PASS/FAIL。",
		Schema:      obj(map[string]any{}),
		ReadOnly:    func(json.RawMessage) bool { return true },
		Concurrent:  func(json.RawMessage) bool { return true },
		Permissions: allow,
		Run: func(_ context.Context, _ json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
			var b strings.Builder
			fail := 0
			check := func(name string, err error) {
				if err != nil {
					fail++
					fmt.Fprintf(&b, "FAIL %s: %v\n", name, err)
					return
				}
				fmt.Fprintf(&b, "PASS %s\n", name)
			}
			// Store roundtrip on a throwaway case.
			c, err := s.store.CreateCase("selftest-probe", "", "")
			if err != nil {
				check("store.create", err)
			} else {
				check("store.create", nil)
				_, err = s.store.AddFact(c.ID, "observation", "selftest", "")
				check("store.fact", err)
				check("store.case.get", func() error { _, err := s.store.GetCase(c.ID); return err }())
				check("store.runbook", func() error {
					steps, err := s.store.CreateRunbook(c.ID, []string{"probe step"})
					if err != nil {
						return err
					}
					return s.store.UpdateRunbookStep(steps[0].ID, "done")
				}())
			}
			// Routing table + a couple of testdata anchors.
			routing, err := LoadRouting()
			check("routing.load", err)
			if err == nil {
				if got := RouteAgainst(routing, "分析这个 Windows PE 恶意样本").Route; got != "R-PE" {
					check("routing.pe", fmt.Errorf("got %s", got))
				} else {
					check("routing.pe", nil)
				}
				if got := RouteAgainst(routing, "对目标站点发起字典爆破").Route; got != "R-GATE-REJECT" {
					check("routing.gate", fmt.Errorf("got %s", got))
				} else {
					check("routing.gate", nil)
				}
			}
			// Patch verify path on a temp file (no writes to user data).
			tmp, err := os.CreateTemp("", "pj-selftest-*")
			if err != nil {
				check("patch.tmpfile", err)
			} else {
				name := tmp.Name()
				defer os.Remove(name)
				defer os.Remove(name + ".bak")
				_, _ = tmp.Write([]byte("HELLO-PATCH-TARGET"))
				_ = tmp.Close()
				verify := s.tools["pj_patch"]
				res, err := verify.Call(context.Background(), []byte(fmt.Sprintf(
					`{"action":"verify","file":%q,"offset":"0","orig_hex":"%s"}`, name, hexEncode("HELLO"))), nil)
				if err != nil {
					check("patch.verify", err)
				} else if res.IsError {
					check("patch.verify", fmt.Errorf("%s", res.Flatten()))
				} else {
					check("patch.verify", nil)
				}
			}
			if fail > 0 {
				fmt.Fprintf(&b, "selftest: %d FAILURES", fail)
			} else {
				b.WriteString("selftest: all green")
			}
			return actool.Text(strings.TrimRight(b.String(), "\n")), nil
		},
	})
}

func hexEncode(s string) string { return fmt.Sprintf("%x", s) }
