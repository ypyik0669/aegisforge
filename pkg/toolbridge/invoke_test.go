package toolbridge

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Autumn-27/norma/hook"
	acperm "github.com/Autumn-27/norma/permission"
	actool "github.com/Autumn-27/norma/tool"
)

// blockingGuard returns a hook registry whose PreToolUse denies everything.
func blockingGuard() *hook.Registry {
	return hook.NewRegistry().On(hook.PreToolUse, func(_ context.Context, ev hook.Event) hook.Result {
		return hook.Result{Decision: "block", Message: "denied by test guard"}
	})
}

func echoRegistry() map[string]actool.CoreTool {
	return map[string]actool.CoreTool{
		"echo": actool.Build(actool.Spec{
			Name:        "echo",
			Description: "echoes its input",
			Schema:      map[string]any{"type": "object"},
			Permissions: func(context.Context, json.RawMessage, acperm.Context) acperm.Decision {
				return acperm.Allowed()
			},
			Run: func(_ context.Context, in json.RawMessage, _ *actool.ToolContext) (actool.Result, error) {
				return actool.Text("echo:" + string(in)), nil
			},
		}),
	}
}

func TestInvokeHappyPath(t *testing.T) {
	iv := NewInvoker(nil, echoRegistry, nil, "/tmp/work")
	content, isErr, err := iv.Invoke(t.Context(), "echo", json.RawMessage(`{"x":1}`), "")
	if err != nil || isErr {
		t.Fatalf("invoke: %v isErr=%v", err, isErr)
	}
	if content != `echo:{"x":1}` {
		t.Fatalf("content: %q", content)
	}
}

func TestInvokeGuardBlock(t *testing.T) {
	iv := NewInvoker(nil, echoRegistry, blockingGuard(), "")
	_, _, err := iv.Invoke(t.Context(), "echo", json.RawMessage(`{}`), "")
	blocked, ok := err.(*BlockedError)
	if !ok || !strings.Contains(blocked.Message, "denied by test guard") {
		t.Fatalf("expected BlockedError, got %v", err)
	}
}

func TestInvokeUnknownTool(t *testing.T) {
	iv := NewInvoker(nil, echoRegistry, nil, "")
	if _, _, err := iv.Invoke(t.Context(), "nope", json.RawMessage(`{}`), ""); err == nil || !strings.Contains(err.Error(), "unknown tool") {
		t.Fatalf("expected unknown tool error, got %v", err)
	}
}

func TestInvokeHTTPSurface(t *testing.T) {
	iv := NewInvoker(nil, echoRegistry, nil, "")
	reg := NewWithInvoker(nil, iv)
	mux := http.NewServeMux()
	reg.RegisterRoutes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	post := func(body string) (int, string) {
		resp, err := http.Post(srv.URL+"/api/tools/invoke", "application/json", strings.NewReader(body))
		if err != nil {
			t.Fatalf("post: %v", err)
		}
		defer resp.Body.Close()
		var buf bytes.Buffer
		_, _ = buf.ReadFrom(resp.Body)
		return resp.StatusCode, buf.String()
	}

	status, body := post(`{"tool":"echo","args":{"k":"v"}}`)
	if status != 200 || !strings.Contains(body, `"ok":true`) || !strings.Contains(body, `echo:{\"k\":\"v\"}`) {
		t.Fatalf("happy path: %d %s", status, body)
	}
	status, body = post(`{"tool":"ghost"}`)
	if status != 404 || !strings.Contains(body, "unknown_tool") {
		t.Fatalf("unknown tool: %d %s", status, body)
	}
	status, _ = post(`{}`)
	if status != 400 {
		t.Fatalf("missing tool: %d", status)
	}
	// Blocked path through the real HTTP surface.
	blocked := NewWithInvoker(nil, NewInvoker(nil, echoRegistry, blockingGuard(), ""))
	bmux := http.NewServeMux()
	blocked.RegisterRoutes(bmux)
	bsrv := httptest.NewServer(bmux)
	defer bsrv.Close()
	resp, err := http.Post(bsrv.URL+"/api/tools/invoke", "application/json", strings.NewReader(`{"tool":"echo"}`))
	if err != nil {
		t.Fatalf("blocked post: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("blocked invocation must be 403, got %d", resp.StatusCode)
	}
	// Registry listing from a live registry (standalone mode, pg nil).
	resp2, err := http.Get(srv.URL + "/api/tools/registry")
	if err != nil {
		t.Fatalf("registry get: %v", err)
	}
	defer resp2.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp2.Body)
	if !strings.Contains(buf.String(), `"echo"`) {
		t.Fatalf("registry listing missing echo: %s", buf.String())
	}
}
