// cdproxy 主入口。
//
// 子命令：
//
//	serve   前台运行服务（keeper + 代理 + 管理面）
//	status  查看运行状态
//	stop    停止运行中的服务
//	plugin  agent-browser stdio 插件模式（也可隐式触发：无参数 + stdin 为管道）
//
// 隐式 plugin 模式的意义：agent-browser 的插件配置只需
//
//	{"command": "<本二进制路径>"}（无需 args 字段——其支持性未经验证）
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yangyaofei/cdproxy/internal/core"
	"github.com/yangyaofei/cdproxy/internal/datadir"
	"github.com/yangyaofei/cdproxy/internal/plugin"
)

// version 经 -ldflags -X main.version 注入。
var version = "dev"

const usage = `cdproxy ` + "v" + `%s — Chrome CDP 隔离代理（Keeper + 多会话 WS 路由）

用法:
  cdproxy serve    [--chrome <path>] [--profile <dir>] [--cdp-port 9222]
                               [--control-port 9224] [--ws-port 9225] [--headless]
                               [--data-dir ~/.agent-browser/proxy]
  cdproxy status   [--control-port 9224]
  cdproxy stop     [--control-port 9224]
  cdproxy plugin   (stdin/stdout 插件协议；无参数+管道 stdin 时自动进入)

下游源（双源常开并存，会话按 显式 source > routing.rules 前缀 > routing.default_source 定格绑定，
Admin 页 / PUT /settings 可在线切换——仅影响新会话，存量会话不受干扰）:
  standalone  keeper 管理的共享基座 Chrome（9222），按需拉起
  extension   ext/cdp-ext 扩展反向回连 GET /ext（用户的宿主 Chrome 经
              chrome.debugger + 标签组映射桥接为下游；不管理宿主生命周期）
              准入令牌 = settings.sources.token（Admin 页「源与接入点」可查看/重置）

环境变量:
  AB_PROXY_CONTROL   管理面地址（默认 http://127.0.0.1:9224）
  AB_PROXY_DATA_DIR  数据目录（默认 ~/.agent-browser/proxy）
`

func main() {
	args := os.Args[1:]
	// 隐式 plugin：无子命令且 stdin 为管道（agent-browser 以管道拉起插件）
	if len(args) == 0 {
		if stdinIsPipe() {
			os.Exit(runPlugin())
		}
		fmt.Printf(usage, version)
		return
	}
	switch args[0] {
	case "serve":
		os.Exit(runServe(args[1:]))
	case "status":
		os.Exit(runStatus(args[1:]))
	case "stop":
		os.Exit(runStop(args[1:]))
	case "plugin":
		os.Exit(runPlugin())
	case "version", "--version", "-v":
		fmt.Println(version)
	default:
		fmt.Printf(usage, version)
		os.Exit(2)
	}
}

func stdinIsPipe() bool {
	info, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice == 0
}

// ── serve ────────────────────────────────────────────────────────

type serveOptions struct {
	chrome      string
	profile     string
	cdpPort     int
	controlPort int
	wsPort      int
	headless    bool
	dataDir     string
}

func parseServeOptions(args []string) serveOptions {
	opts := serveOptions{cdpPort: 9222, controlPort: 9224, wsPort: 9225, dataDir: defaultDataDir()}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--chrome":
			i++; opts.chrome = argAt(args, i)
		case "--profile":
			i++; opts.profile = argAt(args, i)
		case "--cdp-port":
			opts.cdpPort = intAt(args, i+1); i++
		case "--control-port":
			opts.controlPort = intAt(args, i+1); i++
		case "--ws-port":
			opts.wsPort = intAt(args, i+1); i++
		case "--headless":
			opts.headless = true
		case "--data-dir":
			i++; opts.dataDir = argAt(args, i)
		case "--downstream", "--ext-token":
			// 已迁移到 settings（downstream_mode / ext_token）：仅消费参数值
			// 兼容旧脚本，实际值以 settings/Admin 为准（见 usage）
			i++
		}
	}
	return opts
}

func argAt(args []string, i int) string {
	if i < len(args) {
		return args[i]
	}
	return ""
}

func intAt(args []string, i int) int {
	if i < len(args) {
		if v, err := strconv.Atoi(args[i]); err == nil {
			return v
		}
	}
	return 0
}

func defaultDataDir() string {
	// 解析链（datadir.Resolve）：env CDPROXY_DATA_DIR > ~/.cdproxy/pointer.json
	// > 默认 ~/agent-browser/proxy。CLI --data-dir 显式传入最高优先。
	return datadir.Resolve("")
}

func controlBase(args []string) string {
	// status/stop 的控制面地址：flag > env > 默认
	for i := 0; i < len(args); i++ {
		if args[i] == "--control-port" && i+1 < len(args) {
			return "http://127.0.0.1:" + args[i+1]
		}
	}
	if v := os.Getenv("AB_PROXY_CONTROL"); v != "" {
		return v
	}
	return "http://127.0.0.1:9224"
}

func runServe(args []string) int {
	opts := parseServeOptions(args)

	// 数据目录先行：日志文件要落在里面（MkdirAll 曾在 core.New 里，
	// 但 newLogger 先于 core.New 执行，目录缺失会静默回落 stderr）
	if err := os.MkdirAll(opts.dataDir, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "数据目录创建失败: %v\n", err)
		return 1
	}
	logger := newLogger(filepath.Join(opts.dataDir, "service.log"))
	logger.Info("服务启动", "version", version, "data_dir", opts.dataDir)

	// PID 文件（stop 的 SIGTERM 兜底用）
	pidPath := filepath.Join(opts.dataDir, "cdproxy.pid")
	if err := os.WriteFile(pidPath, []byte(strconv.Itoa(os.Getpid())), 0o644); err != nil {
		logger.Warn("PID 文件写入失败", "err", err)
	}
	defer func() { _ = os.Remove(pidPath) }()

	// 引擎组装下沉 internal/core（CLI 与桌面 App 共用）；端口 flags 是
	// 启动覆盖（兼容旧脚本），启动后 settings 是运行时唯一事实源
	shutdown := make(chan struct{})
	eng, err := core.New(core.Options{
		DataDir:     opts.dataDir,
		Version:     version,
		ControlPort: opts.controlPort,
		WsPort:      opts.wsPort,
		Headless:    opts.headless,
		ProfileDir:  opts.profile,
		OnShutdown:  func() { close(shutdown) },
		Logger:      logger,
	})
	if err != nil {
		logger.Error("引擎初始化失败", "err", err)
		return 1
	}
	if err := eng.Start(); err != nil {
		logger.Error("服务启动失败", "err", err)
		return 1
	}

	s := eng.Store().Get()
	controlPort, wsPort := opts.controlPort, opts.wsPort
	if controlPort == 0 {
		controlPort = s.ControlPort
	}
	if wsPort == 0 {
		wsPort = s.WsPort
	}
	logger.Info("服务就绪",
		"control", fmt.Sprintf("127.0.0.1:%d", controlPort),
		"proxy_ws", fmt.Sprintf("ws://127.0.0.1:%d/cdp/<token>", wsPort),
		"default_source", s.Routing.DefaultSource,
		"routing_rules", len(s.Routing.Rules),
		"cdp", fmt.Sprintf("127.0.0.1:%d", opts.cdpPort),
		"ports_enabled", s.PortsEnabled,
	)
	logger.Info("/ext 反向入口常开（等 cdp-ext 扩展回连）",
		"ext_ws", fmt.Sprintf("ws://127.0.0.1:%d/ext", wsPort),
		"token", s.Sources.ExtensionToken)

	ctx, stop := signal.NotifyContext(context.Background(), shutdownSignals()...)
	defer stop()
	select {
	case <-ctx.Done():
		logger.Info("收到停止信号")
	case <-shutdown:
		logger.Info("收到管理面停机指令")
	}
	eng.Stop()
	logger.Info("服务已停止")
	return 0
}

// newLogger 日志只写文件（service.log 是唯一事实源，避免调用方重定向 stderr
// 到同一文件时出现双份）；文件打不开才退回 stderr。
func newLogger(logPath string) *slog.Logger {
	file, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return slog.New(slog.NewTextHandler(os.Stderr, nil))
	}
	return slog.New(slog.NewTextHandler(file, nil))
}

// ── status / stop ────────────────────────────────────────────────

func runStatus(args []string) int {
	body, code := httpGet(controlBase(args) + "/status")
	if code != 200 {
		fmt.Fprintf(os.Stderr, "服务不可达（HTTP %d）\n", code)
		return 1
	}
	var pretty any
	if err := json.Unmarshal(body, &pretty); err == nil {
		out, _ := json.MarshalIndent(pretty, "", "  ")
		fmt.Println(string(out))
	} else {
		fmt.Println(string(body))
	}
	return 0
}

func runStop(args []string) int {
	base := controlBase(args)
	_, code := httpPost(base+"/shutdown", nil)
	if code == 200 {
		fmt.Println("停机指令已发送")
		// 等待退出（PID 消失）
		pidPath := filepath.Join(defaultDataDir(), "cdproxy.pid")
		for i := 0; i < 30; i++ {
			if _, err := os.Stat(pidPath); os.IsNotExist(err) {
				fmt.Println("服务已停止")
				return 0
			}
			time.Sleep(200 * time.Millisecond)
		}
		fmt.Println("停机指令已发送（等待退出超时，请查日志）")
		return 0
	}
	// HTTP 不通 → PID 兜底 SIGTERM
	pidPath := filepath.Join(defaultDataDir(), "cdproxy.pid")
	data, err := os.ReadFile(pidPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "服务不可达且无 PID 文件\n")
		return 1
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		fmt.Fprintf(os.Stderr, "PID 文件损坏\n")
		return 1
	}
	if err := terminatePID(pid); err != nil {
		fmt.Fprintf(os.Stderr, "停止进程失败: %v\n", err)
		return 1
	}
	fmt.Println("已发送停止信号")
	return 0
}

func httpGet(url string) ([]byte, int) {
	resp, err := http.Get(url)
	if err != nil {
		return nil, 0
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}

func httpPost(url string, payload []byte) ([]byte, int) {
	resp, err := http.Post(url, "application/json", strings.NewReader(string(payload)))
	if err != nil {
		return nil, 0
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}

// ── plugin（agent-browser stdio 协议桥）──────────────────────────

func runPlugin() int {
	return plugin.Run(plugin.Options{DesktopApp: false})
}
