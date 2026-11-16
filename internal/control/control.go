// Package control 提供管理面 HTTP 服务与 Admin 静态页。
//
// 端点与 Python 参考实现 control.py 一致：
//
//	GET  /health                   存活探针
//	GET  /status                   运行状态（下游/会话/基座/设置）
//	GET  /settings                 当前设置
//	PUT  /settings                 合并式更新（422 校验失败）
//	GET  /logs/tail                服务日志分页（n 默认 200 上限 1000，skip 向更早翻页）
//	POST /sessions                 {"name": ...} 分配会话
//	POST /sessions/{name}/release  释放会话
//	POST /keeper/restart           重启基座 Chrome
//	POST /shutdown                 优雅停机
//	GET  /                         Admin 页（内嵌资产）
//	GET  /static/...               静态资源（内嵌资产）
package control

import (
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	assets "github.com/yangyaofei/cdproxy" // 根目录 package assets（go:embed 只能嵌包内文件）
	"github.com/yangyaofei/cdproxy/internal/datadir"
	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/proxy"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

// Control 管理面服务。
type Control struct {
	proxy      *proxy.Proxy
	ilg        *interlog.Log
	store      *settings.Store
	keeper     keeper.Config
	logPath    string
	version    string
	onShutdown func()
	onRebind   func()
	onState    func() // 设置保存等管理面状态变化回调（UI 事件推送）
	log        *slog.Logger
}

// New 构造管理面。onRebind 在端口类设置（control_port/ws_port/ports_enabled）
// 变更后被异步调用——监听重绑由上层编排（见 internal/core）。
// SetStateNotifier 注入管理面状态变化回调（设置保存成功等）。
func (c *Control) SetStateNotifier(fn func()) { c.onState = fn }

func New(p *proxy.Proxy, ilg *interlog.Log, store *settings.Store, k keeper.Config, logPath, version string, onShutdown, onRebind func(), log *slog.Logger) *Control {
	return &Control{proxy: p, ilg: ilg, store: store, keeper: k, logPath: logPath, version: version, onShutdown: onShutdown, onRebind: onRebind, log: log}
}

// Handler 构造路由。
// adminWebGuard Admin 网页开关守卫：关闭时 /static/* 同样 403。
func adminWebGuard(c *Control, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !c.store.Get().AdminWebEnabled {
			http.Error(w, "Admin 网页未开放（admin_web_enabled=false）", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (c *Control) Handler() http.Handler {
	mux := http.NewServeMux()

	admin, err := fs.Sub(assets.FS, "static/admin")
	if err != nil {
		c.log.Error("内嵌资产缺失", "err", err)
	}
	// Admin 网页开关（默认关）：关时不服务浏览器版管理页；App 资产与
	// REST API 均不经此路径。API 一律放行（plugin/脚本依赖）。
	adminWebOK := func() bool { return c.store.Get().AdminWebEnabled }
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if !adminWebOK() {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			http.Error(w, "Admin 网页未开放（settings.admin_web_enabled=false；请使用桌面 App，或经 API 临时开启）", http.StatusForbidden)
			return
		}
		data, err := fs.ReadFile(admin, "index.html")
		if err != nil {
			http.Error(w, "index 缺失", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		_, _ = w.Write(data)
	})
	// 静态资源禁缓存（go:embed 随二进制更新，持久 profile 的浏览器会缓存旧版）
	mux.Handle("GET /static/", adminWebGuard(c, http.StripPrefix("/static/", noCache(http.FileServer(http.FS(admin))))))

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /status", func(w http.ResponseWriter, _ *http.Request) {
		snapshot := c.proxy.Status()
		// keeper 区块只描述 standalone 源的基座 Chrome（extension 信息在 sources.extension）
		alive := false
		if src, ok := snapshot["sources"].(map[string]any); ok {
			if sa, ok := src["standalone"].(map[string]any); ok {
				alive, _ = sa["connected"].(bool)
			}
		}
		snapshot["keeper"] = map[string]any{
			"alive":        alive,
			"base_session": c.keeper.Session,
			"manager":      "agent-browser",
			"profile":      c.keeper.ProfileDir,
		}
		snapshot["settings"] = c.store.Get()
		snapshot["version"] = c.version
		snapshot["recent_sessions"] = c.ilg.Recent(50)
		writeJSON(w, http.StatusOK, snapshot)
	})

	// 会话名下 tab 实时列表（会话页展开即查）
	mux.HandleFunc("GET /sessions/{name}/tabs", func(w http.ResponseWriter, r *http.Request) {
		tabs, err := c.proxy.SessionTabs(r.PathValue("name"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tabs": tabs})
	})

	// standalone 源的 agent-browser 安装检测（解析链：设置覆盖 → bundled → PATH）
	mux.HandleFunc("GET /sources/agent-browser", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, c.agentBrowserInfo())
	})

	// 配置文件清单与内容（只读白名单：设置页「配置查看」用）
	mux.HandleFunc("GET /config/files", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"files": c.configFiles()})
	})

	// GET /layout 数据目录全景：目录结构 + 各文件存在性（设置页「数据目录」
	// 展示/修改的依据）。path 全部现算（跟随数据目录）。
	mux.HandleFunc("GET /layout", func(w http.ResponseWriter, _ *http.Request) {
		dataDir := filepath.Dir(c.logPath)
		home, _ := os.UserHomeDir()
		type entry struct {
			Path  string `json:"path"`
			Title string `json:"title"`
			Desc  string `json:"desc"`
			Exists bool  `json:"exists"`
		}
		entries := []entry{
			{Path: filepath.Join(dataDir, "settings.json"), Title: "settings.json", Desc: "运行设置（本页「保存设置」写入）"},
			{Path: filepath.Join(dataDir, "logs"), Title: "logs/", Desc: "会话交互流水 <会话名>.jsonl（release 后保留，>100 文件清最老）"},
			{Path: filepath.Join(dataDir, "keeper-config.json"), Title: "keeper-config.json", Desc: "基座 Chrome 启动配置（autostart 等）"},
			{Path: filepath.Join(dataDir, "service.log"), Title: "service.log", Desc: "服务日志（App/CLI 同源）"},
			{Path: filepath.Join(home, ".agent-browser", "config.json"), Title: "~/.agent-browser/config.json", Desc: "agent-browser 插件配置（全局，不在数据目录内）"},
			{Path: datadir.Path(), Title: datadir.Path(), Desc: "数据目录指针（本页「修改数据目录」写入；重启生效）"},
		}
		for i := range entries {
			if _, err := os.Stat(entries[i].Path); err == nil {
				entries[i].Exists = true
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"data_dir": dataDir, "entries": entries})
	})

	// PUT /data-dir 修改数据目录指针（写 ~/.cdproxy/pointer.json，重启生效；
	// 数据不自动迁移——用户自行 mv，结构见 GET /layout）。
	mux.HandleFunc("PUT /data-dir", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DataDir string `json:"data_dir"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "body 必须是 {\"data_dir\": \"...\"}"})
			return
		}
		if err := datadir.WritePointer(body.DataDir); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"pointer": datadir.Path(), "data_dir": body.DataDir,
			"note": "已写入指针，重启服务后生效；数据不会自动迁移（如需保留请自行 mv 整个目录）",
		})
	})
	mux.HandleFunc("GET /config/files/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := r.PathValue("key")
		for _, f := range c.configFiles() {
			if f["key"] == key {
				data, err := os.ReadFile(f["path"].(string))
				if err != nil {
					writeJSON(w, http.StatusNotFound, map[string]string{"error": "文件不存在或不可读: " + err.Error()})
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"key": key, "path": f["path"], "content": string(data)})
				return
			}
		}
		writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "未知配置 key: " + key})
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
		before := c.store.Get()
		updated, err := c.store.Update(patch)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, updated)
		// 端口类变更：响应先写完，再异步触发监听重绑（本连接随旧监听关闭，
		// 客户端按响应里的新值重连）
		portsChanged := before.ControlPort != updated.ControlPort ||
			before.WsPort != updated.WsPort || before.PortsEnabled != updated.PortsEnabled
		if portsChanged && c.onRebind != nil {
			go func() {
				time.Sleep(300 * time.Millisecond)
				c.onRebind()
			}()
		}
		// 设置保存是状态变化（源页/设置页/UI 全量表单），上报 UI 推送
		if c.onState != nil {
			c.onState()
		}
	})

	mux.HandleFunc("GET /logs/tail", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		n, _ := strconv.Atoi(q.Get("n"))
		if n <= 0 || n > 1000 {
			n = 200
		}
		skip, _ := strconv.Atoi(q.Get("skip"))
		if skip < 0 {
			skip = 0
		}
		total, lines, hasMore := tailLogPaged(c.logPath, n, skip)
		writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "total": total, "hasMore": hasMore})
	})

	mux.HandleFunc("POST /sessions", func(w http.ResponseWriter, r *http.Request) {
		// 准入凭证：Authorization: Bearer <sources.alloc_token>。
		// agent-browser plugin 侧配置同一值（程序自动配置 provider 的那条
		// 路径也需要凭证——"谁想连就连"是被禁止的）。
		auth := r.Header.Get("Authorization")
		token := ""
		if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
			token = strings.TrimSpace(auth[7:])
		}
		want := c.store.Get().Sources.AllocToken
		if token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(want)) != 1 {
			c.log.Warn("会话分配被拒（凭证无效）", "remote", r.RemoteAddr)
			writeJSON(w, http.StatusUnauthorized, map[string]string{
				"error": "缺少或无效的分配令牌（Authorization: Bearer <token>，令牌在 Admin「源」页）"})
			return
		}
		var body struct {
			Name   string `json:"name"`
			Source string `json:"source"` // 可选：显式指定源（standalone|extension），缺省走路由
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Name) == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "name 必填"})
			return
		}
		if body.Source != "" && body.Source != "standalone" && body.Source != "extension" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "source 必须是 standalone|extension"})
			return
		}
		cdpURL, err := c.proxy.AllocSession(body.Name, body.Source)
		if err != nil {
			c.log.Error("会话分配失败", "session", body.Name, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"name": body.Name, "cdpUrl": cdpURL})
	})

	// 令牌重置（吊销语义：新值立即生效并落盘，旧值当场作废）。
	mux.HandleFunc("POST /sources/alloc-token/reset", func(w http.ResponseWriter, _ *http.Request) {
		s := c.store.ResetAllocToken()
		writeJSON(w, http.StatusOK, map[string]string{"alloc_token": s.Sources.AllocToken})
	})
	mux.HandleFunc("POST /sources/ext-token/reset", func(w http.ResponseWriter, _ *http.Request) {
		s := c.store.ResetExtensionToken()
		writeJSON(w, http.StatusOK, map[string]string{"token": s.Sources.ExtensionToken})
	})
	mux.HandleFunc("POST /endpoints/{path}/reset-token", func(w http.ResponseWriter, r *http.Request) {
		s, err := c.store.ResetEndpointToken(r.PathValue("path"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
			return
		}
		for _, ep := range s.Endpoints {
			if ep.Path == r.PathValue("path") {
				writeJSON(w, http.StatusOK, map[string]string{"path": ep.Path, "token": ep.Token})
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "接入点不存在"})
	})

	mux.HandleFunc("POST /sessions/{name}/release", func(w http.ResponseWriter, r *http.Request) {
		c.proxy.ReleaseSession(r.PathValue("name"))
		writeJSON(w, http.StatusOK, map[string]string{"status": "released"})
	})

	// POST /keeper/open 人工在基座窗口开页面：无主 tab（不经会话）、前台
	// （自管理命令不经改写规则，绕过 focus 组的 background 强制）、不受
	// 会话回收影响；计入基座空闲活动（人工页面在，基座不关）。
	mux.HandleFunc("POST /keeper/open", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			URL string `json:"url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.URL) == "" {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "url 必填"})
			return
		}
		if err := c.proxy.DsRawForControl("Target.createTarget", map[string]any{"url": body.URL}); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "opened", "url": body.URL})
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

// noCache 静态资源禁缓存包装（嵌入资产随二进制发布，浏览器不得缓存旧版）。
func noCache(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		next.ServeHTTP(w, r)
	})
}

// agentBrowserInfo standalone 源的 agent-browser 检测：与 keeper 实际
// 拉起、版本探活共用唯一解析链（显式覆盖 > 内嵌 bundle > PATH）——
// 界面显示的就是实际运行的那个二进制。
func (c *Control) agentBrowserInfo() map[string]any {
	bin, src := keeper.ResolveAgentBrowser(c.store.Get().AgentBrowserBinary)
	if bin == "" {
		return map[string]any{"found": false, "source": src}
	}
	return map[string]any{"found": true, "path": bin, "source": src, "version": keeper.AgentBrowserVersion(bin)}
}

// configFiles 配置文件只读白名单（设置页「配置查看」用）：key 稳定，
// path 现算（跟随数据目录/用户主目录）。
func (c *Control) configFiles() []map[string]any {
	home, _ := os.UserHomeDir()
	settingsPath := filepath.Join(filepath.Dir(c.logPath), "settings.json")
	entries := []map[string]any{
		{"key": "settings", "title": "cdproxy 设置", "path": settingsPath},
		{"key": "keeper-config", "title": "基座启动配置", "path": c.keeper.ConfigPath},
		{"key": "agent-browser-config", "title": "agent-browser 配置", "path": filepath.Join(home, ".agent-browser", "config.json")},
	}
	for _, e := range entries {
		_, err := os.Stat(e["path"].(string))
		e["exists"] = err == nil
	}
	return entries
}

// tailLog 读日志尾部 n 行。
// tailLogPaged 返回日志文件中结束于倒数第 skip 行的 n 行（skip=0 即最新一段）。
// 返回 total 总行数与 hasMore（更早是否还有），供前端无限下滑分页。
func tailLogPaged(path string, n, skip int) (int, []string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, []string{}, false
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return 0, []string{}, false
	}
	total := len(lines)
	end := total - skip
	if end < 0 {
		end = 0
	}
	start := end - n
	if start < 0 {
		start = 0
	}
	return total, lines[start:end], start > 0
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
