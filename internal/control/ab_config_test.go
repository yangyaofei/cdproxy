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

	// 2) Legacy ab-proxy config -> outdated
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	legacy := `{
  "headed": true,
  "idleTimeout": "15m",
  "provider": "ab-proxy",
  "plugins": [
    {"name": "ab-proxy", "command": "/old/agent-browser-proxy", "capabilities": ["browser.provider"]},
    {"name": "firecrawl", "command": "agent-browser-plugin-firecrawl", "capabilities": ["browser.provider"]}
  ]
}
`
	if err := os.WriteFile(cfgPath, []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}
	st = inspectAgentBrowserConfig(cfgPath, exe)
	if st.Status != "outdated" || st.CurrentProvider != "ab-proxy" {
		t.Fatalf("want outdated, got %+v", st)
	}

	// 3) Install -> backs up original, preserves idleTimeout & firecrawl, replaces ab-proxy with cdproxy
	t1 := time.Date(2026, 11, 22, 20, 30, 0, 0, time.UTC)
	st, bak, err := installAgentBrowserConfig(cfgPath, exe, t1)
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}
	if bak == "" || st.Status != "configured" || len(st.Backups) != 1 {
		t.Fatalf("unexpected install result: st=%+v bak=%q", st, bak)
	}
	// Verify backup matches legacy bytes verbatim
	bakBytes, err := os.ReadFile(bak)
	if err != nil || string(bakBytes) != legacy {
		t.Fatalf("backup mismatch: err=%v", err)
	}
	// Verify preserved fields & third-party plugin
	var written map[string]any
	raw, _ := os.ReadFile(cfgPath)
	_ = json.Unmarshal(raw, &written)
	if written["idleTimeout"] != "15m" || written["provider"] != "cdproxy" {
		t.Fatalf("unexpected written config: %+v", written)
	}
	plugins := written["plugins"].([]any)
	if len(plugins) != 2 {
		t.Fatalf("expected 2 plugins (firecrawl + cdproxy), got %d: %+v", len(plugins), plugins)
	}

	// 4) Uninstall -> removes cdproxy, keeps firecrawl & idleTimeout
	t2 := t1.Add(5 * time.Second)
	st, bak2, err := uninstallAgentBrowserConfig(cfgPath, exe, t2)
	if err != nil {
		t.Fatalf("uninstall failed: %v", err)
	}
	if bak2 == "" || st.Status != "not_configured" || len(st.Backups) != 2 {
		t.Fatalf("unexpected uninstall result: st=%+v bak=%q", st, bak2)
	}

	// 5) Restore first backup -> back to outdated legacy
	st, err = restoreAgentBrowserConfig(cfgPath, exe, filepath.Base(bak))
	if err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	if st.Status != "outdated" || st.CurrentProvider != "ab-proxy" {
		t.Fatalf("restore did not recover legacy config: %+v", st)
	}

	// 6) Reject path traversal on restore
	if _, err := restoreAgentBrowserConfig(cfgPath, exe, "../escape"); err == nil {
		t.Fatal("expected error for invalid backup name")
	}
}
