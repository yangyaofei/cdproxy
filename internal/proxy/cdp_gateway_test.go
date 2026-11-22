package proxy

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

func newTestProxy(t *testing.T) (*Proxy, *settings.Store) {
	t.Helper()
	dir := t.TempDir()
	store := settings.NewStore(filepath.Join(dir, "settings.json"))
	// 追加一条自定义固定会话入口 work（归属 extension，钉死 session=work）
	base := store.Get().Endpoints
	eps := make([]map[string]any, 0, len(base)+1)
	for _, e := range base {
		eps = append(eps, map[string]any{"path": e.Path, "source": e.Source, "session": e.Session})
	}
	eps = append(eps, map[string]any{"path": "work", "source": "extension", "session": "work"})
	if _, err := store.Update(map[string]any{"endpoints": eps}); err != nil {
		t.Fatal(err)
	}
	ilog := interlog.New(filepath.Join(dir, "logs"))
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := New(keeper.Defaults(), 9225, store, ilog, log)
	return p, store
}

func tokenByPath(t *testing.T, store *settings.Store, path string) string {
	t.Helper()
	for _, e := range store.Get().Endpoints {
		if e.Path == path {
			return e.Token
		}
	}
	t.Fatalf("未找到接入点 %q", path)
	return ""
}

func TestParseCDPPath(t *testing.T) {
	cases := []struct {
		raw     string
		wantErr int
		kind    string
		src     string
		sess    string
		tail    int
	}{
		{"/", 0, cdpKindWS, "", "", 0},
		{"/json/version", 0, cdpKindVersion, "", "", 0},
		{"/json/version/", 0, cdpKindVersion, "", "", 0},
		{"/json/list", 0, cdpKindList, "", "", 0},
		{"/json", 0, cdpKindList, "", "", 0},
		{"/tok123", 0, cdpKindWS, "", "", 1},
		{"/tok123/json/version/", 0, cdpKindVersion, "", "", 1},
		{"/extension", 0, cdpKindWS, "extension", "", 0},
		{"/extension/json/version", 0, cdpKindVersion, "extension", "", 0},
		{"/extension/tok123", 0, cdpKindWS, "extension", "", 1},
		{"/extension/tok123/json/version/", 0, cdpKindVersion, "extension", "", 1},
		{"/standalone/session/my-s1", 0, cdpKindWS, "standalone", "my-s1", 0},
		{"/extension/session/my-s1/tok123/json/version", 0, cdpKindVersion, "extension", "my-s1", 1},
		{"/session/my-s1", 0, cdpKindWS, "", "my-s1", 0},
		{"/session/my-s1/tok123", 0, cdpKindWS, "", "my-s1", 1},
		{"/work/tok123", 0, cdpKindWS, "", "", 2},
		{"/work/tok123/json/version", 0, cdpKindVersion, "", "", 2},
		{"/session", http.StatusBadRequest, "", "", "", 0},
		{"/extension/a/b/c", http.StatusNotFound, "", "", "", 0},
	}
	for _, tc := range cases {
		r, code, _ := parseCDPPath(tc.raw)
		if code != tc.wantErr {
			t.Fatalf("path=%q 期望错误码 %d，实际 %d (route=%+v)", tc.raw, tc.wantErr, code, r)
		}
		if code != 0 {
			continue
		}
		if r.Kind != tc.kind || r.PathSrc != tc.src || r.Session != tc.sess || len(r.Tail) != tc.tail {
			t.Fatalf("path=%q 解析偏差: got=%+v want=(kind=%s src=%s sess=%s tail=%d)",
				tc.raw, r, tc.kind, tc.src, tc.sess, tc.tail)
		}
	}
}

func TestCDPGatewayVersionAndAuth(t *testing.T) {
	p, store := newTestProxy(t)
	tokDef := tokenByPath(t, store, "default")
	tokSA := tokenByPath(t, store, "standalone")
	tokExt := tokenByPath(t, store, "extension")
	tokWork := tokenByPath(t, store, "work")

	call := func(path, auth, host, origin string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:9225"+path, nil)
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
		p.handleCDPGateway(rec, req)
		return rec
	}

	// 1. 缺令牌 → 401；错令牌 → 401
	if rec := call("/json/version", "", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("无令牌应 401，实际 %d", rec.Code)
	}
	if rec := call("/extension/wrong-token/json/version", "", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("错令牌应 401，实际 %d", rec.Code)
	}

	// 2. Host DNS Rebinding 与网页 Origin → 403
	if rec := call("/json/version", "Bearer "+tokDef, "evil.example.com:9225", ""); rec.Code != http.StatusForbidden {
		t.Fatalf("非本机 Host 应 403，实际 %d", rec.Code)
	}
	if rec := call("/json/version", "Bearer "+tokDef, "", "https://evil.example.com"); rec.Code != http.StatusForbidden {
		t.Fatalf("带 Origin 头应 403，实际 %d", rec.Code)
	}

	// 3. 令牌反向推导（根路径 /json/version + Header）：分别用 default / standalone / extension / work
	for _, tc := range []struct {
		name       string
		tok        string
		wantPrefix string
	}{
		{"default", tokDef, "ws://127.0.0.1:9225/session/cdp-"},
		{"standalone", tokSA, "ws://127.0.0.1:9225/standalone/session/cdp-"},
		{"extension", tokExt, "ws://127.0.0.1:9225/extension/session/cdp-"},
		{"work", tokWork, "ws://127.0.0.1:9225/extension/session/work"},
	} {
		rec := call("/json/version", "Bearer "+tc.tok, "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s Header 发现应 200，实际 %d: %s", tc.name, rec.Code, rec.Body.String())
		}
		var body map[string]string
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		ws := body["webSocketDebuggerUrl"]
		if !strings.HasPrefix(ws, tc.wantPrefix) {
			t.Fatalf("%s webSocketDebuggerUrl 偏差: got=%q wantPrefix=%q", tc.name, ws, tc.wantPrefix)
		}
		if strings.Contains(ws, tc.tok) {
			t.Fatalf("%s Header 鉴权不应把 token 放进 webSocketDebuggerUrl: %q", tc.name, ws)
		}
	}

	// 4. URL Token 模式（Playwright 尾斜杠 /json/version/ 与 Puppeteer 无斜杠 /json/version）
	for _, path := range []string{
		"/extension/" + tokExt + "/json/version/",
		"/extension/" + tokExt + "/json/version",
	} {
		rec := call(path, "", "", "")
		if rec.Code != http.StatusOK {
			t.Fatalf("%s 应 200，实际 %d: %s", path, rec.Code, rec.Body.String())
		}
		var body map[string]string
		_ = json.Unmarshal(rec.Body.Bytes(), &body)
		ws := body["webSocketDebuggerUrl"]
		if !strings.HasPrefix(ws, "ws://127.0.0.1:9225/extension/session/cdp-") || !strings.HasSuffix(ws, "/"+tokExt) {
			t.Fatalf("URL Token 模式返回 webSocketDebuggerUrl 偏差: %q", ws)
		}
	}

	// 5. 指定会话名 /session/<id>（无 Header URL 模式 + Header 模式）
	rec := call("/extension/session/my-task/"+tokExt+"/json/version", "", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("指定 session 应 200，实际 %d", rec.Code)
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["webSocketDebuggerUrl"] != "ws://127.0.0.1:9225/extension/session/my-task/"+tokExt {
		t.Fatalf("指定 session URL 偏差: %q", body["webSocketDebuggerUrl"])
	}

	// 6. 严格越权拦截（403）
	for _, tc := range []struct {
		desc string
		path string
		auth string
	}{
		{"default 令牌越权访问 /extension", "/extension/" + tokDef + "/json/version", ""},
		{"standalone 令牌越权访问 /extension", "/extension/json/version", "Bearer " + tokSA},
		{"extension 令牌越权访问 /standalone", "/standalone/" + tokExt + "/json/version", ""},
		{"work 固定会话令牌越权访问其他会话", "/extension/session/other/" + tokWork + "/json/version", ""},
		{"work 固定会话令牌越权访问 /standalone", "/standalone/" + tokWork + "/json/version", ""},
		{"URL 与 Header 令牌不一致", "/extension/" + tokExt + "/json/version", "Bearer " + tokSA},
	} {
		r := call(tc.path, tc.auth, "", "")
		if r.Code != http.StatusForbidden && r.Code != http.StatusUnauthorized {
			t.Fatalf("%s 应被拒（401/403），实际 %d: %s", tc.desc, r.Code, r.Body.String())
		}
	}

	// 7. /json/list 匿名或未建会话返回空数组 []，不泄隐私
	for _, lp := range []string{"/json/list", "/json", "/extension/" + tokExt + "/json/list"} {
		auth := ""
		if !strings.Contains(lp, tokExt) {
			auth = "Bearer " + tokExt
		}
		r := call(lp, auth, "", "")
		if r.Code != http.StatusOK || strings.TrimSpace(r.Body.String()) != "[]" {
			t.Fatalf("%s 应返回 []，实际 %d: %q", lp, r.Code, r.Body.String())
		}
	}

	// 8. 验证 /json/version 完全无状态：不产生任何孤儿会话
	if got := p.st.Snapshot(); len(got) != 0 {
		t.Fatalf("/json/version 探测不应创建会话，实际存在 %d 个: %+v", len(got), got)
	}
}
