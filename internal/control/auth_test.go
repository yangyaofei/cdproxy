package control

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/proxy"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

func TestExternalControlAuthClosure(t *testing.T) {
	dir := t.TempDir()
	store := settings.NewStore(filepath.Join(dir, "settings.json"))
	ilg := interlog.New(filepath.Join(dir, "logs"))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	kcfg := keeper.Config{Session: "test-base", ProfileDir: filepath.Join(dir, "profile")}
	p := proxy.New(kcfg, 0, store, ilg, log, proxy.Options{})
	ctl := New(p, ilg, store, kcfg, filepath.Join(dir, "service.log"), "0.11.0-test", nil, nil, log)

	extH := ctl.Handler()
	intH := ctl.InternalHandler()
	tok := store.Get().Sources.AllocToken

	do := func(h http.Handler, method, path, auth, host, origin, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1:9224"+path, strings.NewReader(body))
		if host != "" {
			req.Host = host
		}
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		return rec
	}

	// 1. /health 免鉴权仅返状态
	if rec := do(extH, http.MethodGet, "/health", "", "", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("/health 应 200，实际 %d", rec.Code)
	}

	// 2. 外部无鉴权访问敏感/控制接口一律 401（彻底堵死免鉴权套走令牌）
	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/status", ""},
		{http.MethodGet, "/settings", ""},
		{http.MethodPut, "/settings", `{"alloc_reap_seconds":100}`},
		{http.MethodPost, "/sessions", `{"name":"x"}`},
		{http.MethodPost, "/sessions/x/release", `{}`},
		{http.MethodPost, "/sources/ext-token/reset", `{}`},
		{http.MethodPost, "/shutdown", `{}`},
		{http.MethodGet, "/integrations/agent-browser", ""},
	} {
		rec := do(extH, tc.method, tc.path, "", "", "", tc.body)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("外部无鉴权 %s %s 应 401，实际 %d: %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}

	// 3. 非回环 Host → 403；admin_web_enabled=false 时带 Origin → 403
	if rec := do(extH, http.MethodGet, "/status", "Bearer "+tok, "evil.example.com:9224", "", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("非本机 Host 应 403，实际 %d", rec.Code)
	}
	if rec := do(extH, http.MethodGet, "/status", "Bearer "+tok, "", "https://evil.example.com", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("关闭管理页时带 Origin 应 403，实际 %d", rec.Code)
	}

	// 4. 外部携带正确 Bearer alloc_token → 放行 200
	if rec := do(extH, http.MethodGet, "/status", "Bearer "+tok, "", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("带正确管理令牌 /status 应 200，实际 %d: %s", rec.Code, rec.Body.String())
	}
	if rec := do(extH, http.MethodPost, "/sessions/nonexistent/release", "Bearer "+tok, "", "", `{}`); rec.Code != http.StatusOK {
		t.Fatalf("带正确管理令牌 release 应 200，实际 %d", rec.Code)
	}

	// 5. 进程内可信通道（Wails DoRequest）免 Bearer 直接放行 200
	if rec := do(intH, http.MethodGet, "/status", "", "", "", ""); rec.Code != http.StatusOK {
		t.Fatalf("进程内通道 /status 应 200，实际 %d", rec.Code)
	}
}
