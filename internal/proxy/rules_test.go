package proxy

import (
	"encoding/json"
	"testing"

	"github.com/yangyaofei/agent-browser-proxy/internal/settings"
)

func mustParams(t *testing.T, s string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("params 解析: %v", err)
	}
	return m
}

func TestCreateTargetRewrite(t *testing.T) {
	params := mustParams(t, `{"url":"https://x.com"}`)
	out := applyUpstreamRules(settings.DefaultRewrites(), "Target.createTarget", params)
	if out.Stop {
		t.Fatalf("createTarget 不应停止转发")
	}
	if out.Action != "rewritten" {
		t.Fatalf("action=%s", out.Action)
	}
	if params["background"] != true {
		t.Fatalf("background 未注入: %v", params)
	}
}

func TestBringToFrontFaked(t *testing.T) {
	out := applyUpstreamRules(settings.DefaultRewrites(), "Page.bringToFront", map[string]any{})
	if !out.Stop || out.Action != "focus-guard" {
		t.Fatalf("bringToFront 应假成功: %+v", out)
	}
}

func TestSetWindowBoundsStripFocused(t *testing.T) {
	params := mustParams(t, `{"windowId": 3, "bounds": {"focused": true, "width": 100}}`)
	out := applyUpstreamRules(settings.DefaultRewrites(), "Browser.setWindowBounds", params)
	if out.Stop || out.Action != "rewritten" {
		t.Fatalf("setWindowBounds 应改写: %+v", out)
	}
	bounds := params["bounds"].(map[string]any)
	if _, has := bounds["focused"]; has {
		t.Fatalf("focused 未剥离: %v", bounds)
	}
	if bounds["width"] != float64(100) {
		t.Fatalf("其余字段应保留: %v", bounds)
	}
}

func TestBrowserCloseBaseGuard(t *testing.T) {
	out := applyUpstreamRules(settings.DefaultRewrites(), "Browser.close", map[string]any{})
	if !out.Stop || out.Action != "base-guard" {
		t.Fatalf("Browser.close 应基座保护: %+v", out)
	}
}

func TestPassthroughPreset(t *testing.T) {
	params := mustParams(t, `{"url":"https://x.com"}`)
	out := applyUpstreamRules(settings.PassthroughRewrites(), "Target.createTarget", params)
	if out.Stop || out.Action != "forwarded" {
		t.Fatalf("透传预设下 createTarget 应原样转发: %+v", out)
	}
	if _, has := params["background"]; has {
		t.Fatalf("透传预设不应注入 background")
	}
}

func TestWildcardMatch(t *testing.T) {
	rules := []settings.RewriteRule{{Match: "Network.*", Action: "fake"}}
	if out := applyUpstreamRules(rules, "Network.requestWillBeSent", map[string]any{}); !out.Stop {
		t.Fatalf("前缀通配未命中")
	}
	if out := applyUpstreamRules(rules, "Page.navigate", map[string]any{}); out.Stop {
		t.Fatalf("非前缀方法不应命中")
	}
}

func TestFocusEmulationPassthroughLogged(t *testing.T) {
	out := applyUpstreamRules(settings.DefaultRewrites(), "Emulation.setFocusEmulationEnabled", map[string]any{"enabled": true})
	if out.Stop || out.Action != "forwarded" || out.Delta == "" {
		t.Fatalf("焦点仿真应透传且带说明: %+v", out)
	}
}
