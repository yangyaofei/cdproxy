package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func writeJSONFile(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDetectChromeExtensionsStates(t *testing.T) {
	tmp := t.TempDir()
	chromeRoot := filepath.Join(tmp, "Chrome")
	exportDir := filepath.Join(tmp, ".cdproxy", "extension", "cdp-ext")
	roots := []browserRoot{{Name: "Google Chrome", Dir: chromeRoot}}

	// 1) Profile exists with unrelated extension → not_installed
	writeJSONFile(t, filepath.Join(chromeRoot, "Local State"), map[string]any{
		"profile": map[string]any{
			"info_cache": map[string]any{
				"Default": map[string]any{"name": "Work"},
			},
		},
	})
	writeJSONFile(t, filepath.Join(chromeRoot, "Default", "Secure Preferences"), map[string]any{
		"extensions": map[string]any{
			"settings": map[string]any{
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa": map[string]any{
					"path":  "/some/other/ext",
					"state": 1,
					"manifest": map[string]any{
						"name":    "Other",
						"version": "1.0.0",
					},
				},
			},
		},
	})
	st := detectChromeExtensionsInRoots(roots, exportDir, false, "", "0.2.0", true)
	if st.State != "not_installed" || len(st.Installations) != 0 || len(st.BrowsersScanned) != 1 {
		t.Fatalf("expected not_installed, got %+v", st)
	}

	// 2) Installed but disabled (state=0) → disabled
	writeJSONFile(t, filepath.Join(chromeRoot, "Default", "Secure Preferences"), map[string]any{
		"extensions": map[string]any{
			"settings": map[string]any{
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": map[string]any{
					"path":  exportDir,
					"state": 0,
					"manifest": map[string]any{
						"name":         "cdp-ext",
						"version":      "0.2.0",
						"homepage_url": cdpExtHomepageURL,
					},
				},
			},
		},
	})
	st = detectChromeExtensionsInRoots(roots, exportDir, false, "", "0.2.0", true)
	if st.State != "disabled" || len(st.Installations) != 1 {
		t.Fatalf("expected disabled, got %+v", st)
	}
	if st.Installations[0].ProfileName != "Work" || !st.Installations[0].MatchesExportDir || st.Installations[0].Enabled {
		t.Fatalf("unexpected installation detail: %+v", st.Installations[0])
	}

	// 3) Installed & enabled (state=1) but offline → installed_offline
	writeJSONFile(t, filepath.Join(chromeRoot, "Default", "Secure Preferences"), map[string]any{
		"extensions": map[string]any{
			"settings": map[string]any{
				"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb": map[string]any{
					"path":  exportDir,
					"state": 1,
					"manifest": map[string]any{
						"name":         "cdp-ext",
						"version":      "0.2.0",
						"homepage_url": cdpExtHomepageURL,
					},
				},
			},
		},
	})
	st = detectChromeExtensionsInRoots(roots, exportDir, false, "", "0.2.0", true)
	if st.State != "installed_offline" || !st.Installations[0].Enabled {
		t.Fatalf("expected installed_offline, got %+v", st)
	}

	// 4) Connected with older version → outdated
	st = detectChromeExtensionsInRoots(roots, exportDir, true, "0.1.2", "0.2.0", true)
	if st.State != "outdated" {
		t.Fatalf("expected outdated, got %+v", st)
	}

	// 5) Connected with current version → connected
	st = detectChromeExtensionsInRoots(roots, exportDir, true, "0.2.0", "0.2.0", true)
	if st.State != "connected" {
		t.Fatalf("expected connected, got %+v", st)
	}
}
