// EngineService 桌面 App 的引擎服务：持有 internal/core 引擎实例，
// 对前端暴露统一请求入口 DoRequest——进程内直接执行 control 路由
//（与 REST 完全同一套 handler，行为逐字节一致），外部端口关闭时
// App 界面照常工作。
package main

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/yangyaofei/agent-browser-proxy/internal/core"
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

// StartEngine / StopEngine / RestartEngine 托盘与前端控制入口。
func (s *EngineService) StartEngine() error { return s.startEngine() }
func (s *EngineService) StopEngine() error  { s.stopEngine(); return nil }
func (s *EngineService) RestartEngine() error {
	s.stopEngine()
	return s.startEngine()
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
