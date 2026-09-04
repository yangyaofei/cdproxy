// Package control 提供管理面 HTTP 服务与 Admin 静态页。
//
// 端点与 Python 参考实现 control.py 一致：
//
//	GET  /health                   存活探针
//	GET  /status                   运行状态（下游/会话/基座/设置）
//	GET  /settings                 当前设置
//	PUT  /settings                 合并式更新（422 校验失败）
//	GET  /logs/tail                服务日志尾部（默认 200 行）
//	POST /sessions                 {"name": ...} 分配会话
//	POST /sessions/{name}/release  释放会话
//	POST /keeper/restart           重启基座 Chrome
//	POST /shutdown                 优雅停机
//	GET  /                         Admin 页（内嵌资产）
//	GET  /static/...               静态资源（内嵌资产）
package control

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	assets "github.com/yangyaofei/agent-browser-proxy" // 根目录 package assets（go:embed 只能嵌包内文件）
	"github.com/yangyaofei/agent-browser-proxy/internal/interlog"
	"github.com/yangyaofei/agent-browser-proxy/internal/keeper"
	"github.com/yangyaofei/agent-browser-proxy/internal/proxy"
	"github.com/yangyaofei/agent-browser-proxy/internal/settings"
)

// Control 管理面服务。
type Control struct {
	proxy    *proxy.Proxy
	ilg      *interlog.Log
	store    *settings.Store
	keeper   keeper.Config
	logPath  string
	version  string
	onShutdown func()
	log      *slog.Logger
}

// New 构造管理面。
func New(p *proxy.Proxy, ilg *interlog.Log, store *settings.Store, k keeper.Config, logPath, version string, onShutdown func(), log *slog.Logger) *Control {
	return &Control{proxy: p, ilg: ilg, store: store, keeper: k, logPath: logPath, version: version, onShutdown: onShutdown, log: log}
}

// Handler 构造路由。
func (c *Control) Handler() http.Handler {
	mux := http.NewServeMux()

	admin, err := fs.Sub(assets.FS, "static/admin")
	if err != nil {
		c.log.Error("内嵌资产缺失", "err", err)
	}
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		data, err := fs.ReadFile(admin, "index.html")
		if err != nil {
			http.Error(w, "index 缺失", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
	})
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServer(http.FS(admin))))

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		snapshot := c.proxy.Status()
		snapshot["keeper"] = map[string]any{"chrome": c.keeper.Alive()}
		snapshot["settings"] = c.store.Get()
		snapshot["version"] = c.version
		writeJSON(w, http.StatusOK, snapshot)
	})

	// per-session CDP 交互日志（内存环形快照）
	mux.HandleFunc("GET /sessions/{name}/logs", func(w http.ResponseWriter, r *http.Request) {
		limit := 0
		if v := r.URL.Query().Get("limit"); v != "" {
			fmt.Sscanf(v, "%d", &limit)
		}
		name := r.PathValue("name")
		entries := c.ilg.Ring(name, limit)
		if entries == nil {
			entries = []interlog.Entry{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"session": name, "entries": entries})
	})

	mux.HandleFunc("GET /settings", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, c.store.Get())
	})

	mux.HandleFunc("PUT /settings", func(w http.ResponseWriter, r *http.Request) {
		var patch map[string]any
		if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "settings 必须是 JSON 对象: " + err.Error()})
			return
		}
		updated, err := c.store.Update(patch)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, updated)
	})

	mux.HandleFunc("GET /logs/tail", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"lines": tailLog(c.logPath, 200)})
	})

	mux.HandleFunc("POST /sessions", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Name string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name 必填"})
			return
		}
		cdpURL, err := c.proxy.AllocSession(body.Name)
		if err != nil {
			c.log.Error("会话分配失败", "session", body.Name, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"name": body.Name, "cdpUrl": cdpURL})
	})

	mux.HandleFunc("POST /sessions/{name}/release", func(w http.ResponseWriter, r *http.Request) {
		c.proxy.ReleaseSession(r.PathValue("name"))
		writeJSON(w, http.StatusOK, map[string]string{"status": "released"})
	})

	mux.HandleFunc("POST /keeper/restart", func(w http.ResponseWriter, _ *http.Request) {
		if err := c.proxy.RestartKeeper(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "restarted"})
	})

	mux.HandleFunc("POST /shutdown", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "shutting down"})
		if c.onShutdown != nil {
			go c.onShutdown()
		}
	})

	return mux
}

// tailLog 读日志尾部 n 行。
func tailLog(path string, n int) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return []string{}
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// StartControl 启动管理面（绑定失败重试 10×1s，容忍前代实例退出竞态）。
func StartControl(addr string, handler http.Handler, log *slog.Logger) (*http.Server, error) {
	var lastErr error
	for attempt := 0; attempt < 10; attempt++ {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			lastErr = err
			log.Warn("管理面绑定失败，重试", "addr", addr, "attempt", attempt+1, "err", err)
			time.Sleep(time.Second)
			continue
		}
		srv := &http.Server{Handler: handler}
		go func() {
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Error("管理面服务退出", "err", err)
			}
		}()
		log.Info("管理面已启动", "addr", addr)
		return srv, nil
	}
	return nil, fmt.Errorf("管理面 10 次绑定失败 %s: %w", addr, lastErr)
}
