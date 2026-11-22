package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAgentBrowserConfigLifecycle(t *testing.T) {
	tmp := t.TempDir()
	cfgPath := filepath.Join(tmp, ".agent-browser", "config.json")
	exe := filepath.Join(tmp, "cdproxy-desktop")

	// 1) Missing file -> not_found
	st := inspectAgentBrowserConfig(cfgPath, exe)
	if st.Status != "not_found" || st.Exists {
		t.Fatalf("want not_found, got %+v", st)
	}

	// 2) Existing other provider config -> other_provider
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	existingCfg := `{
  "headed": true,
  "idleTimeout": "15m",
  "provider": "ab-proxy",
  "plugins": [
    {"name": "ab-proxy", "command": "/old/agent-browser-proxy", "capabilities": ["browser.provider"]},
    {"name": "firecrawl", "command": "agent-browser-plugin-firecrawl", "capabilities": ["browser.provider"]}
  ]
}
`
	if err := os.WriteFile(cfgPath, []byte(existingCfg), 0o644); err != nil {
		t.Fatal(err)
	}
	st = inspectAgentBrowserConfig(cfgPath, exe)
	if st.Status != "other_provider" || st.CurrentProvider != "ab-proxy" {
		t.Fatalf("want other_provider, got %+v", st)
	}

	// 3) Install -> backs up original, preserves idleTimeout & ALL existing plugins, adds cdproxy & sets default provider
	t1 := time.Date(2026, 11, 22, 20, 30, 0, 0, time.UTC)
	st, bak, err := installAgentBrowserConfig(cfgPath, exe, t1)
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if bak == "" || st.Status != "configured" || len(st.Backups) != 1 {
		t.Fatalf("unexpected install result: st=%+v bak=%q", st, bak)
	}
	// Verify backup matches original bytes verbatim
	bakBytes, err := os.ReadFile(bak)
	if err != nil || string(bakBytes) != existingCfg {
		t.Fatalf("backup mismatch: err=%v", err)
	}
	// Verify preserved fields & all existing plugins + newly added cdproxy
	var written map[string]any
	raw, _ := os.ReadFile(cfgPath)
	_ = json.Unmarshal(raw, &written)
	if written["idleTimeout"] != "15m" || written["provider"] != "cdproxy" {
		t.Fatalf("unexpected written config: %+v", written)
	}
	plugins := written["plugins"].([]any)
	if len(plugins) != 3 {
		t.Fatalf("expected 3 plugins (ab-proxy + firecrawl + cdproxy), got %d: %+v", len(plugins), plugins)
	}

	// 3b) Moving app executable path -> outdated
	stMoved := inspectAgentBrowserConfig(cfgPath, filepath.Join(tmp, "moved", "cdproxy-desktop"))
	if stMoved.Status != "outdated" {
		t.Fatalf("want outdated when cdproxy path changed, got %+v", stMoved)
	}

	// 4) Uninstall -> removes cdproxy, keeps existing plugins & idleTimeout
	t2 := t1.Add(5 * time.Second)
	st, bak2, err := uninstallAgentBrowserConfig(cfgPath, exe, t2)
	if err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}
	if bak2 == "" || st.Status != "not_configured" || len(st.Backups) != 2 {
		t.Fatalf("unexpected uninstall result: st=%+v bak=%q", st, bak2)
	}

	// 5) Restore first backup -> back to other_provider
	st, err = restoreAgentBrowserConfig(cfgPath, exe, filepath.Base(bak))
	if err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	if st.Status != "other_provider" || st.CurrentProvider != "ab-proxy" {
		t.Fatalf("restore did not recover original config: %+v", st)
	}

	// 6) Reject path traversal on restore
	if _, err := restoreAgentBrowserConfig(cfgPath, exe, "../escape"); err == nil {
		t.Fatal("expected error for invalid backup name")
	}
}
