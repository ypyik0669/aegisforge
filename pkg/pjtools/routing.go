package pjtools

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// Routing is the vendored unirev routing contract (data/routing.json): 8 routes
// with Chinese/English signal keywords, primary/aux toolsets, and knowledge
// bases. R-GATE-REJECT is the no-scope catch-all.
type Routing struct {
	Version  string        `json:"version"`
	Gates    RoutingGates  `json:"gates"`
	Evidence RoutingEv     `json:"evidence"`
	Routes   []RoutingRule `json:"routes"`
}

// RoutingGates carries the consent gate text (and its upstream source path).
type RoutingGates struct {
	Consent string `json:"consent"`
	Source  string `json:"source"`
}

// RoutingEv carries the cross-phase evidence contract.
type RoutingEv struct {
	CrossPhase string `json:"crossPhase"`
}

// RoutingRule is one route: id, signal keywords, toolsets, knowledge bases.
type RoutingRule struct {
	ID      string   `json:"id"`
	Signals []string `json:"signals"`
	Primary struct {
		Toolset string   `json:"toolset"`
		Skill   string   `json:"skill"`
		Tools   []string `json:"tools"`
	} `json:"primary"`
	Aux []struct {
		Toolset string   `json:"toolset"`
		Skill   string   `json:"skill"`
		Tools   []string `json:"tools"`
	} `json:"aux"`
	KB []string `json:"kb"`
}

//go:embed data/routing.json
var routingJSON []byte

//go:embed data/testdata-routes.json
var routingTestJSON []byte

// LoadRouting parses the vendored routing table.
func LoadRouting() (*Routing, error) {
	var r Routing
	if err := json.Unmarshal(routingJSON, &r); err != nil {
		return nil, fmt.Errorf("routing.json: %w", err)
	}
	if len(r.Routes) < 8 {
		return nil, fmt.Errorf("routing.json: expected >= 8 routes, got %d", len(r.Routes))
	}
	return &r, nil
}

// RoutingTestCases parses the vendored unirev route-test testdata.
func RoutingTestCases() ([]RouteCase, error) {
	var parsed struct {
		Cases []RouteCase `json:"cases"`
	}
	if err := json.Unmarshal(routingTestJSON, &parsed); err != nil {
		return nil, fmt.Errorf("testdata-routes.json: %w", err)
	}
	return parsed.Cases, nil
}

// RouteCase is one routing acceptance case (input sentence → expected route).
type RouteCase struct {
	Input  string `json:"input"`
	Expect struct {
		RouteID string `json:"routeId"`
		KB      string `json:"kb"`
		Gate    bool   `json:"gate"`
	} `json:"expect"`
}

// authorizationMarkers still matter for the no-signal fallback: an input that
// matches no route but declares scope falls through to R-CROSS instead of the
// gate reject.
var authorizationMarkers = []string{"authorized", "authorization", "授权", "scope", "in-scope"}

// gateRejectIntent marks destructive-first intents that must never route
// without an explicit scope declaration, even in the fallback path.
var gateRejectIntent = []string{"爆破", "字典攻击", "ddos", "拒绝服务", "撞库"}

// RouteMatch is a routing decision with its evidence.
type RouteMatch struct {
	Route  string
	Rule   *RoutingRule
	Hits   []string // matched signals
	Gated  bool     // true when the decision is R-GATE-REJECT
	Reason string
}

// RouteAgainst matches free text against the routing table. Scoring: the sum
// of matched-signal lengths (longer signals are more specific and win ties —
// "逆向一个 CTF 的 crackme" must land on R-CTF-PWN via "crackme", not R-CTF-WEB
// via the shorter "CTF"). No signal hit: an authorization marker falls through
// to R-CROSS, anything else (or a destructive-first intent) gate-rejects.
func RouteAgainst(r *Routing, text string) RouteMatch {
	lower := strings.ToLower(text)
	type scored struct {
		idx   int
		score int
		hits  []string
	}
	var candidates []scored
	for i, rule := range r.Routes {
		if rule.ID == "R-GATE-REJECT" {
			continue
		}
		var hits []string
		total := 0
		for _, sig := range rule.Signals {
			s := strings.ToLower(sig)
			if s != "" && strings.Contains(lower, s) {
				hits = append(hits, sig)
				total += len(s)
			}
		}
		if total > 0 {
			candidates = append(candidates, scored{idx: i, score: total, hits: hits})
		}
	}
	if len(candidates) > 0 {
		sort.SliceStable(candidates, func(a, b int) bool {
			if candidates[a].score != candidates[b].score {
				return candidates[a].score > candidates[b].score
			}
			return candidates[a].idx < candidates[b].idx
		})
		best := candidates[0]
		rule := &r.Routes[best.idx]
		return RouteMatch{Route: rule.ID, Rule: rule, Hits: best.hits, Reason: fmt.Sprintf("signal hits: %s", strings.Join(best.hits, ", "))}
	}
	for _, m := range authorizationMarkers {
		if strings.Contains(lower, m) {
			for i := range r.Routes {
				if r.Routes[i].ID == "R-CROSS" {
					return RouteMatch{Route: "R-CROSS", Rule: &r.Routes[i], Reason: "no signal hit; authorization declared → cross-phase route"}
				}
			}
		}
	}
	return RouteMatch{Route: "R-GATE-REJECT", Gated: true, Reason: "no route signal and no authorization declaration"}
}
