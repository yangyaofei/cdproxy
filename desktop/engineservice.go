// EngineService 桌面 App 的引擎服务：持有 internal/core 引擎实例，
// 对前端暴露统一请求入口 DoRequest——进程内直接执行 control 路由
//（与 REST 完全同一套 handler，行为逐字节一致），外部端口关闭时
// App 界面照常工作。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/yangyaofei/cdproxy/internal/core"
)

// DoResponse DoRequest 的返回（前端拿到的 JSON 形状）。
type DoResponse struct {
	// Status HTTP 状态码（沿用 REST 语义：4xx/5xx 表达业务错误）
	Status int `json:"status"`
	// Body 响应体原文（JSON 文本；错误时是 {"error": "..."} 形状）
	Body string `json:"body"`
}

// EngineService Wails 服务。方法首字母大写自动生成前端绑定。
type EngineService struct {
	mu      sync.Mutex
	eng     *core.Core
	handler http.Handler
	log     *slog.Logger
	dataDir string
	// engineStopped 引擎被管理面停机后的标记（Tray 状态展示用）
	engineStopped bool
	onStateChange func(running bool)
}

// NewEngineService 构造。dataDir 空则默认 ~/agent-browser/proxy（与 CLI
// 生产部署同目录：同一份 settings/日志，App 与 daemon 二选一运行）。
// 日志与 CLI 同源：dataDir/service.log（UI 无控制台，文件是唯一事实源）。
func NewEngineService(dataDir string, onStateChange func(running bool)) *EngineService {
	if dataDir == "" {
		home, _ := os.UserHomeDir()
		dataDir = filepath.Join(home, "agent-browser", "proxy")
	}
	_ = os.MkdirAll(dataDir, 0o755)
	logger := newFileLogger(filepath.Join(dataDir, "service.log"))
	return &EngineService{log: logger, dataDir: dataDir, onStateChange: onStateChange}
}

// newFileLogger 文件日志（打开失败回落 stderr）。
func newFileLogger(path string) *slog.Logger {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return slog.Default()
	}
	return slog.New(slog.NewTextHandler(f, nil))
}

// ServiceStartup Wails 生命周期：App 启动即拉起引擎。
// 签名必须精确匹配 application.ServiceStartup 接口（第二参是
// ServiceOptions——写成别的类型不构成接口实现，启动将被静默跳过）。
func (s *EngineService) ServiceStartup(_ context.Context, _ application.ServiceOptions) error {
	return s.startEngine()
}

// ServiceShutdown Wails 生命周期：App 退出前停引擎。
func (s *EngineService) ServiceShutdown() error {
	s.stopEngine()
	return nil
}

func (s *EngineService) startEngine() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eng != nil {
		return nil
	}
	eng, err := core.New(core.Options{
		DataDir:  s.dataDir,
		Version:  version,
		OnShutdown: func() { s.markStopped() },
		Logger:   s.log,
	})
	if err != nil {
		return err
	}
	if err := eng.Start(); err != nil {
		return err
	}
	s.eng = eng
	s.handler = eng.ControlHandler()
	s.engineStopped = false
	if s.onStateChange != nil {
		go s.onStateChange(true)
	}
	s.log.Info("引擎已启动", "data_dir", s.dataDir)
	return nil
}

func (s *EngineService) stopEngine() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eng == nil {
		return
	}
	s.eng.Stop()
	s.eng = nil
	s.handler = nil
	s.engineStopped = true
	if s.onStateChange != nil {
		go s.onStateChange(false)
	}
	s.log.Info("引擎已停止")
}

// markStopped 管理面 POST /shutdown 回调：引擎自停（App 不退出）。
func (s *EngineService) markStopped() {
	s.mu.Lock()
	s.eng = nil
	s.handler = nil
	s.engineStopped = true
	s.mu.Unlock()
	if s.onStateChange != nil {
		go s.onStateChange(false)
	}
	s.log.Info("引擎经管理面停机")
}

// UIDumpResult WebView 自检回传（DumpDOM 的 payload 形状）。
type UIDumpResult struct {
	Health string            `json:"health"` // doRequest('GET','/health') 的原始 JSON（绑定探活）
	Error  string            `json:"error"`  // 绑定调用异常（有则填）
	Errors []string          `json:"errors"` // 页面 error/unhandledrejection 收集（app.js/Alpine 早期异常）
	Probe  map[string]string `json:"probe"`  // 静态资源 fetch 探活（status:bytes）
	DOM    string            `json:"dom"`    // document.documentElement.outerHTML
}

// DumpDOM 调试/测试通道：WebView 把自身 DOM + 绑定探活结果落盘
//（ABP_UI_DUMP 指定目录）。测试用它替代截图读图——结构即证据。
func (s *EngineService) DumpDOM(payload string) {
	dir := os.Getenv("ABP_UI_DUMP")
	if dir == "" {
		return
	}
	var v UIDumpResult
	if err := json.Unmarshal([]byte(payload), &v); err != nil {
		s.log.Warn("DumpDOM payload 解析失败", "err", err)
		return
	}
	_ = os.MkdirAll(dir, 0o755)
	_ = os.WriteFile(filepath.Join(dir, "dom.html"), []byte(v.DOM), 0o644)
	meta, _ := json.MarshalIndent(v, "", "  ")
	_ = os.WriteFile(filepath.Join(dir, "dom-meta.json"), meta, 0o644)
	s.log.Info("UI 自检落盘", "dir", dir, "dom_bytes", len(v.DOM), "health", v.Health)
}

// StartEngine / StopEngine / RestartEngine 托盘与前端控制入口。func (s *EngineService) StartEngine() error { return s.startEngine() }
func (s *EngineService) StopEngine() error  { s.stopEngine(); return nil }
func (s *EngineService) RestartEngine() error {
	s.stopEngine()
	return s.startEngine()
}

// AgentBrowserInfo 内嵌 agent-browser 的解析结果（前端/托盘展示）。
type AgentBrowserInfo struct {
	Version string `json:"version"`
	Path    string `json:"path"`
	Source  string `json:"source"` // setting | bundled | path | none
}

// bundledAgentBrowser bundled 候选：env 覆盖（开发模式直指 staging 目录，
// 对应 OpenChamber 的 *_BUNDLED_CLI_DIR 交接）→ 可执行文件相对
// .app/Contents/Resources/agent-browser/。
func bundledAgentBrowser() string {
	if v := os.Getenv("AB_AGENT_BROWSER_BUNDLED_DIR"); v != "" {
		p := filepath.Join(v, "agent-browser")
		if fileExecutable(p) {
			return p
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	// dev 二进制：desktop/bin/abp-desktop → staging 在 ../build/agent-browser/
	for _, rel := range []string{"../build/agent-browser/agent-browser", "../Resources/agent-browser/agent-browser"} {
		if p := filepath.Join(filepath.Dir(exe), rel); fileExecutable(p) {
			return p
		}
	}
	return ""
}

func fileExecutable(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0
}

// resolveAgentBrowser 解析链（settings 覆盖 → bundled → PATH），逐级记 source。
func (s *EngineService) resolveAgentBrowser() AgentBrowserInfo {
	if s.eng != nil {
		if p := s.eng.Store().Get().AgentBrowserBinary; p != "" && fileExecutable(p) {
			return AgentBrowserInfo{Path: p, Source: "setting", Version: abVersion(p)}
		}
	}
	if p := bundledAgentBrowser(); p != "" {
		return AgentBrowserInfo{Path: p, Source: "bundled", Version: abVersion(p)}
	}
	if p, err := exec.LookPath("agent-browser"); err == nil {
		return AgentBrowserInfo{Path: p, Source: "path", Version: abVersion(p)}
	}
	return AgentBrowserInfo{Source: "none"}
}

func abVersion(bin string) string {
	out, err := exec.Command(bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// AgentBrowserInfo 绑定入口（版本探活在解析里同步跑一次，界面低频调用可接受）。
func (s *EngineService) AgentBrowser() AgentBrowserInfo {
	return s.resolveAgentBrowser()
}

// AgentBrowserInstall 把解析到的 agent-browser 安装到用户 PATH（写符号链接）。
// 目标目录按序探测可写者：/usr/local/bin → ~/bin。返回安装路径与是否在
// 当前 PATH 中（不在则前端提示用户加 PATH）。
func (s *EngineService) AgentBrowserInstall() (map[string]any, error) {
	info := s.resolveAgentBrowser()
	if info.Source == "none" {
		return nil, errors.New("无可安装的 agent-browser（setting/bundled/PATH 均未命中）")
	}
	home, _ := os.UserHomeDir()
	candidates := []string{"/usr/local/bin", filepath.Join(home, "bin")}
	var targetDir string
	for _, d := range candidates {
		if fi, err := os.Stat(d); err == nil && fi.IsDir() && unixWritable(d) {
			targetDir = d
			break
		}
	}
	if targetDir == "" {
		// ~/bin 兜底创建（无 sudo 场景）
		targetDir = filepath.Join(home, "bin")
		if err := os.MkdirAll(targetDir, 0o755); err != nil {
			return nil, fmt.Errorf("创建 %s 失败: %w", targetDir, err)
		}
	}
	dst := filepath.Join(targetDir, "agent-browser")
	_ = os.Remove(dst) // 旧链接/旧版本直接替换
	if err := os.Symlink(info.Path, dst); err != nil {
		return nil, fmt.Errorf("安装失败 %s: %w", dst, err)
	}
	inPath := strings.Contains(os.Getenv("PATH"), targetDir)
	return map[string]any{"installedTo": dst, "from": info.Path, "version": info.Version,
		"inPath": inPath, "pathHint": targetDir}, nil
}

// unixWritable 目录当前用户是否可写（实测创建探针文件，免 x/sys 依赖）。
func unixWritable(dir string) bool {
	probe := filepath.Join(dir, ".abp-write-probe")
	if err := os.WriteFile(probe, nil, 0o644); err != nil {
		return false
	}
	_ = os.Remove(probe)
	return true
}

// EngineRunning 引擎是否在跑（前端状态条 + 托盘）。
func (s *EngineService) EngineRunning() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.eng != nil
}

// DataDir 引擎数据目录（前端展示）。
func (s *EngineService) DataDir() string { return s.dataDir }

// DoRequest 统一请求入口：method/path/body 与 REST API 完全一致，
// 进程内执行 control 路由。引擎未运行时返回 503。
func (s *EngineService) DoRequest(method, path, body string) (DoResponse, error) {
	s.mu.Lock()
	h := s.handler
	s.mu.Unlock()
	if h == nil {
		return DoResponse{Status: http.StatusServiceUnavailable,
			Body: `{"error":"引擎未运行"}`}, nil
	}
	var rdr io.Reader
	if body != "" {
		rdr = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequest(method, "http://app.local"+path, rdr)
	if err != nil {
		return DoResponse{}, err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := newRecorder()
	h.ServeHTTP(rec, req)
	return DoResponse{Status: rec.code, Body: rec.body.String()}, nil
}

// recorder 轻量 ResponseWriter（只取状态码与响应体）。
type recorder struct {
	code int
	body bytes.Buffer
	head http.Header
}

func newRecorder() *recorder { return &recorder{code: 200, head: http.Header{}} }
func (r *recorder) Header() http.Header { return r.head }
func (r *recorder) WriteHeader(c int)  { r.code = c }
func (r *recorder) Write(b []byte) (int, error) { return r.body.Write(b) }
