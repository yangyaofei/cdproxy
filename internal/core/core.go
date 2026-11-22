// Package core 引擎编排层：组装 settings/interlog/keeper 配置/proxy/control
// 并管理监听生命周期。CLI（serve 子命令）与桌面 App（Wails）共用同一引擎——
// 两者只是不同的宿主壳，端口重绑（改端口/开关外部端口）在进程内完成，
// 会话与令牌状态全程保留。
package core

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/yangyaofei/cdproxy/internal/control"
	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/proxy"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

// Options 构造参数。ControlPort/WsPort 为启动覆盖（0=用 settings 值），
// 仅作用于初始绑定——启动后 settings 是运行时唯一事实源（重绑读它）。
type Options struct {
	DataDir     string
	Version     string
	ControlPort int
	WsPort      int
	Headless    bool
	ProfileDir  string
	// OnShutdown 管理面收到 POST /shutdown 时回调（宿主决定如何收尾：
	// CLI 退出进程，App 可选择重启引擎或退出）。
	OnShutdown func()
	Logger     *slog.Logger
}

// Core 引擎实例。
type Core struct {
	onUIState func() // 宿主注入：状态变化回调（App 事件推送）
	opts   Options
	logger *slog.Logger

	store  *settings.Store
	ilg    *interlog.Log
	kcfg   keeper.Config
	proxy  *proxy.Proxy
	ctl    *control.Control
	ctlHandler http.Handler
	ctlSrv *http.Server
	logPath string

	mu sync.Mutex
}

// New 构造并准备数据目录（不绑定端口——Start 才开始监听）。
func New(opts Options) (*Core, error) {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if err := os.MkdirAll(opts.DataDir, 0o755); err != nil {
		return nil, fmt.Errorf("数据目录创建失败: %w", err)
	}
	logPath := filepath.Join(opts.DataDir, "service.log")
	store := settings.NewStore(filepath.Join(opts.DataDir, "settings.json"))
	ilg := interlog.New(filepath.Join(opts.DataDir, "logs"))

	kcfg := keeper.Defaults()
	if opts.ProfileDir != "" {
		kcfg.ProfileDir = opts.ProfileDir
	} else {
		kcfg.ProfileDir = filepath.Join(opts.DataDir, "browser-profile")
	}
	kcfg.Headed = !opts.Headless
	kcfg.ConfigPath = filepath.Join(opts.DataDir, "runtime", "keeper-config.json")
	// agent-browser 二进制走唯一解析链（显式覆盖 > 内嵌 bundle > PATH），
	// 与 UI 检测/版本探活共用——App 形态下基座由内嵌版运行。
	if bin, _ := keeper.ResolveAgentBrowser(store.Get().AgentBrowserBinary); bin != "" {
		kcfg.AgentBrowser = bin
	}

	c := &Core{
		opts: opts, logger: opts.Logger,
		store: store, ilg: ilg, kcfg: kcfg, logPath: logPath,
	}
	// 启动覆盖与 settings 不一致时提示（覆盖只管这一次绑定）
	s := store.Get()
	if opts.ControlPort != 0 && opts.ControlPort != s.ControlPort {
		c.logger.Info("control_port 启动覆盖", "flag", opts.ControlPort, "settings", s.ControlPort)
	}
	if opts.WsPort != 0 && opts.WsPort != s.WsPort {
		c.logger.Info("ws_port 启动覆盖", "flag", opts.WsPort, "settings", s.WsPort)
	}
	return c, nil
}

// effectivePorts 解析生效端口：覆盖 > settings。
func (c *Core) effectivePorts() (controlPort, wsPort int) {
	s := c.store.Get()
	controlPort, wsPort = s.ControlPort, s.WsPort
	if c.opts.ControlPort != 0 {
		controlPort = c.opts.ControlPort
	}
	if c.opts.WsPort != 0 {
		wsPort = c.opts.WsPort
	}
	return
}

// Store 暴露设置存储（App 绑定层直接读写设置，不绕道 REST）。
func (c *Core) Store() *settings.Store { return c.store }

// Proxy 暴露代理（App 绑定层查询状态/操作会话）。
func (c *Core) Proxy() *proxy.Proxy { return c.proxy }

// ControlHandler 暴露控制面路由（桌面 App 的 DoRequest 在进程内执行
// 同一套 handler——与 REST 行为逐字节一致，端口关闭也可用）。
func (c *Core) ControlHandler() http.Handler {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctl == nil {
		return nil
	}
	if c.ctlHandler == nil {
		c.ctlHandler = c.ctl.Handler()
	}
	return c.ctlHandler
}

// SetUINotifier 注入状态变化回调（引擎各状态点统一上报，宿主转发为
// 前端事件——桌面 App 的事件驱动形态）。
func (c *Core) SetUINotifier(fn func()) { c.onUIState = fn }

// Start 启动引擎。ports_enabled=false 时只起保活与内部状态，
// 不绑定任何外部监听（App 内嵌模式）。
func (c *Core) Start() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proxy != nil {
		return fmt.Errorf("引擎已启动")
	}
	_, wsPort := c.effectivePorts()
	c.proxy = proxy.New(c.kcfg, wsPort, c.store, c.ilg, c.logger, proxy.Options{
		OnStateChange: c.onUIState, // 状态变化 → 宿主（App）事件推送
	})
	c.ctl = control.New(c.proxy, c.ilg, c.store, c.kcfg, c.logPath, c.opts.Version,
		c.opts.OnShutdown, c.rebind, c.logger)
	c.ctl.SetStateNotifier(c.onUIState)
	c.ctlHandler = nil // 引擎重建后旧 handler 失效，惰性重建
	c.ctl.EnsureExtensionReady()

	if err := c.proxy.Start(); err != nil {
		return err
	}
	s := c.store.Get()
	if !s.PortsEnabled {
		// App 内嵌模式：Start 会绑监听+保活，这里即刻摘掉监听（窗口期
		// 微秒级；保活与状态机照常运行）
		c.proxy.StopListener()
		c.logger.Info("外部端口停用（App 内嵌模式）")
		return nil
	}
	controlPort, _ := c.effectivePorts()
	srv, err := control.StartControl(fmt.Sprintf("127.0.0.1:%d", controlPort), c.ctl.Handler(), c.logger)
	if err != nil {
		c.proxy.Stop()
		c.proxy = nil
		return err
	}
	c.ctlSrv = srv
	return nil
}

// rebind 按 settings 现值重建监听（端口变更/开关端口共用）。旧监听先关；
// 会话与令牌状态不动，上游客户端按自身重连策略恢复。
func (c *Core) rebind() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.proxy == nil {
		return
	}
	s := c.store.Get()
	// 控制面：关旧（如有）→ 开新（如启用）
	if c.ctlSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = c.ctlSrv.Shutdown(ctx)
		cancel()
		c.ctlSrv = nil
	}
	// WS 面：重绑或关闭
	if s.PortsEnabled {
		if err := c.proxy.RestartListener(s.WsPort); err != nil {
			c.logger.Error("WS 监听重绑失败", "err", err)
		}
		srv, err := control.StartControl(fmt.Sprintf("127.0.0.1:%d", s.ControlPort), c.ctl.Handler(), c.logger)
		if err != nil {
			c.logger.Error("管理面重绑失败", "err", err)
			return
		}
		c.ctlSrv = srv
		c.logger.Info("监听已重绑", "control", s.ControlPort, "ws", s.WsPort)
	} else {
		c.proxy.StopListener()
		c.logger.Info("外部端口已停用（App 内嵌模式）")
	}
}

// Rebind 导出重绑（App 绑定层用）。
func (c *Core) Rebind() { c.rebind() }

// Stop 停止引擎（监听+下游链路全下线；状态丢弃——进程收尾用）。
func (c *Core) Stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ctlSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = c.ctlSrv.Shutdown(ctx)
		cancel()
		c.ctlSrv = nil
	}
	if c.proxy != nil {
		c.proxy.Stop()
		c.proxy = nil
	}
}
