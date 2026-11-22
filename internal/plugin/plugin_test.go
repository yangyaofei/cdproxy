package plugin

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunPluginReadsSettingsTokenAndLaunches(t *testing.T) {
	dir := t.TempDir()
	cfg := `{"control_port": 9224, "sources": {"alloc_token": "tok-secret-123"}}`
	if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}

	var gotAuth, gotSession string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/health":
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"status":"ok"}`))
		case "/sessions":
			gotAuth = r.Header.Get("Authorization")
			var body struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			gotSession = body.Name
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"name":"research","cdpUrl":"ws://127.0.0.1:9225/cdp/s-abc"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	var out bytes.Buffer
	rc := Run(Options{
		DesktopApp:  true,
		ControlBase: srv.URL,
		DataDir:     dir,
		In:          strings.NewReader(`{"type":"browser.launch","request":{"session":"research"}}`),
		Out:         &out,
	})
	if rc != 0 {
		t.Fatalf("rc=%d, out=%s", rc, out.String())
	}
	if gotAuth != "Bearer tok-secret-123" || gotSession != "research" {
		t.Fatalf("auth=%q session=%q", gotAuth, gotSession)
	}
	var resp response
	if err := json.Unmarshal(out.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v (%s)", err, out.String())
	}
	if !resp.Success || resp.Browser == nil || resp.Browser.CdpURL != "ws://127.0.0.1:9225/cdp/s-abc" {
		t.Fatalf("unexpected resp: %+v", resp)
	}
}
