package control

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/proxy"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

func newTestHandler(t *testing.T) (http.Handler, *settings.Store, string) {
	t.Helper()
	dir := t.TempDir()
	store := settings.NewStore(filepath.Join(dir, "settings.json"))
	ilg := interlog.New(filepath.Join(dir, "logs"))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	kcfg := keeper.Config{Session: "test-base", ProfileDir: filepath.Join(dir, "profile")}
	p := proxy.New(kcfg, 0, store, ilg, log, proxy.Options{})
	ctl := New(p, ilg, store, kcfg, filepath.Join(dir, "service.log"), "0.8.0-test", nil, nil, log)
	return ctl.Handler(), store, dir
}

func TestCleanAndCompareSemver(t *testing.T) {
	if got := cleanSemver("agent-browser 0.43.0"); got != "0.43.0" {
		t.Fatalf("cleanSemver = %q, want 0.43.0", got)
	}
	if got := cleanSemver("https://github.com/vercel-labs/agent-browser/releases/tag/v0.44.1"); got != "0.44.1" {
		t.Fatalf("cleanSemver(url) = %q, want 0.44.1", got)
	}
	if compareSemver("0.44.0", "0.43.9") <= 0 {
		t.Fatal("expected 0.44.0 > 0.43.9")
	}
	if compareSemver("0.43.0", "0.43.0") != 0 {
		t.Fatal("expected 0.43.0 == 0.43.0")
	}
	if compareSemver("0.43.0-rc.1", "0.43.0") >= 0 {
		t.Fatal("expected pre-release < release")
	}
}

func TestAgentBrowserAssetMappingAndDigestRegex(t *testing.T) {
	cases := [][3]string{
		{"darwin", "arm64", "agent-browser-darwin-arm64"},
		{"darwin", "amd64", "agent-browser-darwin-x64"},
		{"windows", "amd64", "agent-browser-win32-x64.exe"},
		{"linux", "amd64", "agent-browser-linux-x64"},
	}
	for _, tc := range cases {
		got, err := agentBrowserAsset(tc[0], tc[1])
		if err != nil || got != tc[2] {
			t.Fatalf("agentBrowserAsset(%s,%s) = (%q,%v), want %q", tc[0], tc[1], got, err, tc[2])
		}
	}

	sample := `
	<li>
	  <a href="/vercel-labs/agent-browser/releases/download/v0.43.0/agent-browser-darwin-arm64">agent-browser-darwin-arm64</a>
	  <span>sha256:05338a8eeddf0b3f9ebf0c87a6c21aedc10685608c68618e1a8483c43eae9c3f</span>
	  <clipboard-copy aria-label="Copy to clipboard digest for agent-browser-darwin-arm64"></clipboard-copy>
	</li>
	<li>
	  <a href="/vercel-labs/agent-browser/releases/download/v0.43.0/agent-browser-win32-x64.exe">agent-browser-win32-x64.exe</a>
	  <span>sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</span>
	  <clipboard-copy aria-label="Copy to clipboard digest for agent-browser-win32-x64.exe"></clipboard-copy>
	</li>`

	re := assetDigestReFn("agent-browser-win32-x64.exe")
	m := re.FindStringSubmatch(sample)
	if len(m) < 3 {
		t.Fatalf("expected match for win32-x64.exe, got %v", m)
	}
	found := m[1]
	if found == "" {
		found = m[2]
	}
	if found != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Fatalf("unexpected digest: %q", found)
	}
}

func TestVersionsExportZipAndReloadEndpoints(t *testing.T) {
	h, store, dir := newTestHandler(t)

	// 1) GET /versions before export
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/versions", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /versions status = %d", rec.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode /versions: %v", err)
	}
	ext, _ := payload["extension"].(map[string]any)
	if ext == nil || ext["bundled_version"] == "" {
		t.Fatalf("missing bundled extension version: %+v", payload)
	}
	if ext["exported"] != false {
		t.Fatalf("expected exported=false before export, got %v", ext["exported"])
	}

	// 2) POST /sources/extension/export writes manifest + locales + runtime-config.json
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sources/extension/export", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST /sources/extension/export status = %d: %s", rec.Code, rec.Body.String())
	}
	for _, rel := range []string{"manifest.json", "_locales/en/messages.json", "_locales/zh_CN/messages.json", "runtime-config.json"} {
		p := filepath.Join(dir, "extension", "cdp-ext", filepath.FromSlash(rel))
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("expected exported %s at %s: %v", rel, p, err)
		}
	}
	cfgRaw, err := os.ReadFile(filepath.Join(dir, "extension", "cdp-ext", "runtime-config.json"))
	if err != nil {
		t.Fatalf("read runtime-config.json: %v", err)
	}
	var rtCfg map[string]string
	if err := json.Unmarshal(cfgRaw, &rtCfg); err != nil {
		t.Fatalf("decode runtime-config.json: %v", err)
	}
	if rtCfg["token"] != store.Get().Sources.ExtensionToken || rtCfg["groupPrefix"] != settings.DefaultGroupPrefix {
		t.Fatalf("unexpected runtime-config.json: %+v", rtCfg)
	}

	// 3) GET /versions after export reflects exported_version
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/versions", nil))
	_ = json.Unmarshal(rec.Body.Bytes(), &payload)
	ext = payload["extension"].(map[string]any)
	if ext["exported"] != true || ext["exported_version"] != ext["bundled_version"] {
		t.Fatalf("expected exported_version == bundled_version, got %+v", ext)
	}

	// 4) GET /sources/extension/bundle.zip returns valid zip archive
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/sources/extension/bundle.zip", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("bundle.zip status=%d ct=%s", rec.Code, rec.Header().Get("Content-Type"))
	}
	zr, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatalf("invalid zip archive: %v", err)
	}
	zipFiles := map[string]bool{}
	for _, f := range zr.File {
		zipFiles[f.Name] = true
	}
	for _, want := range []string{"cdp-ext/manifest.json", "cdp-ext/_locales/en/messages.json", "cdp-ext/_locales/zh_CN/messages.json", "cdp-ext/runtime-config.json"} {
		if !zipFiles[want] {
			t.Fatalf("zip missing %s", want)
		}
	}

	// 5) POST /sources/extension/reload when disconnected returns 409
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sources/extension/reload", nil))
	if rec.Code != http.StatusConflict {
		t.Fatalf("reload when disconnected status=%d, want 409", rec.Code)
	}

	// 6) POST /sources/agent-browser/use-bundled clears custom binary setting
	_, _ = store.Update(map[string]any{"agent_browser_binary": "/tmp/fake-ab"})
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/sources/agent-browser/use-bundled", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("use-bundled status=%d", rec.Code)
	}
	if got := store.Get().AgentBrowserBinary; got != "" {
		t.Fatalf("expected AgentBrowserBinary cleared, got %q", got)
	}
}
