// EngineService 桌面 App 的引擎服务：持有 internal/core 引擎实例，
// 对前端暴露统一请求入口 DoRequest——进程内直接执行 control 路由
//（与 REST 完全同一套 handler，行为逐字节一致），外部端口关闭时
// App 界面照常工作。
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/yangyaofei/cdproxy/internal/core"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/datadir"
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
	// emitMu/emitPending：状态事件节流（100ms 合并）——高频变化点（组 sync、
	// 命令流）统一收敛为一次前端推送，避免事件风暴。
	emitMu      sync.Mutex
	emitPending bool
	lastEmit    time.Time
}

// NewEngineService 构造。dataDir 解析链见 internal/datadir（显式 > env >
// 指针文件 > 默认 ~/agent-browser/proxy）。日志与 CLI 同源：
// dataDir/service.log（UI 无控制台，文件是唯一事实源）。
func NewEngineService(dataDir string, onStateChange func(running bool)) *EngineService {
	dataDir = datadir.Resolve(dataDir)
	_ = os.MkdirAll(dataDir, 0o755)
	logger := newFileLogger(filepath.Join(dataDir, "service.log"))
	return &EngineService{log: logger, dataDir: dataDir, onStateChange: onStateChange}
}

// DataDir 当前数据目录（前端「设置 → 数据目录」展示/修改用）。
func (s *EngineService) DataDir() string { return s.dataDir }

// Version 应用版本（编译期 -X main.version 注入；UI 侧栏/更新提示共用）。
func (s *EngineService) Version() string { return version }

// RestartForUpdate 更新就绪后的重启安装（helper swap：等本进程退出→
// 原子替换→回滚保护→拉起新版）。
func (s *EngineService) RestartForUpdate() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := application.Get().Updater.Restart(ctx); err != nil {
			s.log.Error("重启更新失败", "err", err)
		}
	}()
}

// CheckForUpdate 前端触发的手动检查（结果经 wails:updater:* 事件回 UI）。
func (s *EngineService) CheckForUpdate() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if _, err := application.Get().Updater.Check(ctx); err != nil {
			s.log.Error("检查更新失败", "err", err)
		}
	}()
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

// emitState 引擎状态变化的推送出口：节流合并后经 Wails 事件系统广播给
// 前端（Events.On("cdp:state")）——桌面 App 的事件驱动形态，前端收到即
// 重拉快照（进程内绑定毫秒级），轮询只作兜底。
func (s *EngineService) emitState() {
	const throttle = 100 * time.Millisecond
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	if s.emitPending {
		return // 冷却期内已有 trailing 计划，合并
	}
	// leading：距上次推送超过冷却期，立即推（单发事件零延迟）
	if time.Since(s.lastEmit) >= throttle {
		s.lastEmit = time.Now()
		go s.emitOnce()
		return
	}
	// trailing：冷却期内挂起，冷却到期补推一次
	s.emitPending = true
	time.AfterFunc(throttle-time.Since(s.lastEmit), func() {
		s.emitMu.Lock()
		s.emitPending = false
		s.lastEmit = time.Now()
		s.emitMu.Unlock()
		s.emitOnce()
	})
}

func (s *EngineService) emitOnce() {
	if app := application.Get(); app != nil && app.Event != nil {
		// 官方事件形态：payload 即数据（v3 文档 "Emit(name, data)"）。
		// 携带完整状态 JSON，前端回调直接写入响应式变量——无请求、无防抖。
		if resp, err := s.DoRequest("GET", "/status", ""); err == nil && resp.Status == 200 {
			app.Event.Emit("cdp:state", resp.Body)
		}
		s.log.Info("UI 状态事件已推送（cdp:state）")
	}
}

// EmitEngineOffline 引擎停机的专用信号（此刻 /status 已不可用，无法随行
// 状态）——前端收到即转离线态，数据保留并标过期。
func (s *EngineService) EmitEngineOffline() {
	if app := application.Get(); app != nil && app.Event != nil {
		app.Event.Emit("cdp:state", "engine-offline")
	}
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
	eng.SetUINotifier(s.emitState) // 引擎状态点 → 事件推送（Start 前注入）
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

// AgentBrowserInfo 绑定入口（版本探活在解析里同步跑一次，界面低频调用可接受）。
// settingAgentBrowser 引擎在运行时读 settings 显式覆盖（引擎未起时为空）。
func (s *EngineService) settingAgentBrowser() string {
	if s.eng != nil {
		return s.eng.Store().Get().AgentBrowserBinary
	}
	return ""
}

func (s *EngineService) AgentBrowser() AgentBrowserInfo {
	bin, src := keeper.ResolveAgentBrowser(s.settingAgentBrowser())
	return AgentBrowserInfo{Path: bin, Source: src, Version: keeper.AgentBrowserVersion(bin)}
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
