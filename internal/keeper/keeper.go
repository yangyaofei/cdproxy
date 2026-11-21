// Package keeper 管理共享基座 Chrome 的生命周期——但不直接管理 Chrome 进程。
//
// 基座由一个长驻的 agent-browser 会话（默认名 ab-keeper）持有：启动、单例锁、
// 就绪等待、优雅关闭的全部进程事务都是 agent-browser 的原生职责。本包只做三件事：
//   - EnsureRunning：确保该会话活着并返回基座的浏览器级 WS 地址
//     （get cdp-url 纯查询探测；浏览器不在时由 open about:blank 冷启动。
//     agent-browser 0.41 起 get cdp-url 不再自动拉起，页面命令仍会）
//   - Stop：agent-browser 原生关闭该会话（close），并验证旧基座 WS 真死
//   - 写出会话专用最小配置（headed + 共享 profile，绝不带 provider——防递归）
//
// 两条从历史教训固化的红线：
//   - 所有对 agent-browser 的调用都用最小环境（HOME/PATH）——provider 的
//     环境变量会级联进子 daemon（env 优先于 config），无限递归
//   - 关闭必须验证基座真死（旧 WS 不可连接）才返回成功——杀不掉如实报错，
//     绝不宣称"已重启"
package keeper

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// Config 基座持有配置。
type Config struct {
	AgentBrowser string // agent-browser 可执行文件（默认 PATH 探测）
	Session      string // 持有基座的会话名（默认 ab-keeper）
	ConfigPath   string // 会话专用 agent-browser 配置文件（由 WriteConfig 生成）
	Headed       bool
	ProfileDir   string // 共享登录态目录（写进 ConfigPath 指向的配置）
}

// Defaults 默认配置。
func Defaults() Config {
	agentBrowser := "agent-browser"
	if p, err := exec.LookPath("agent-browser"); err == nil {
		agentBrowser = p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		home = os.Getenv("HOME")
	}
	return Config{
		AgentBrowser: agentBrowser,
		Session:      "ab-keeper",
		Headed:       true,
		ProfileDir:   filepath.Join(home, "agent-browser", "profile"),
	}
}

// WriteConfig 生成会话专用最小配置（内容变化才重写）。
// 绝不含 provider/plugins——ab-keeper 的 daemon 若继承 provider 配置，
// 会经插件再拉起自己（无限递归）。
// idleTimeout 即基座空闲策略，由 agent-browser 原生执行（"0"=禁用）：
// 消费者活动经 proxy 心跳（get cdp-url）重置计时；阈值修改在基座下次冷启动生效。
func (c Config) WriteConfig(idleTimeout string) error {
	if c.ConfigPath == "" {
		return fmt.Errorf("keeper 配置路径未设置")
	}
	body := fmt.Sprintf(`{
  "headed": %t,
  "profile": %q,
  "idleTimeout": %q
}
`, c.Headed, c.ProfileDir, idleTimeout)
	if old, err := os.ReadFile(c.ConfigPath); err == nil && string(old) == body {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(c.ConfigPath), 0o755); err != nil {
		return err
	}
	return os.WriteFile(c.ConfigPath, []byte(body), 0o644)
}

// IdleTimeoutString 把秒数转成 agent-browser 的 idle-timeout 形式（"0"=禁用）。
func IdleTimeoutString(seconds float64) string {
	if seconds <= 0 {
		return "0"
	}
	minutes := int(seconds/60 + 0.9999)
	if minutes < 1 {
		minutes = 1
	}
	return fmt.Sprintf("%dm", minutes)
}

// isolatedEnv 最小环境：HOME/PATH 之外全剥（防 provider 环境变量级联递归）。
// HOME 重定向到数据目录下的专用 home（HOME 沙箱）：agent-browser 的状态根
// 硬拼 HOME/.agent-browser（源码 get_state_dir，无 env 可重定向），会话
// 文件/auth/加密钥/tmp 与基座 Chrome 的副产物经此全部归仓数据目录，
// 不污染用户主目录。PATH 保留（Chrome 二进制查找仍需）。
// AGENT_BROWSER_SOCKET_DIR 显式指向短目录：daemon 的 Unix socket 路径
// 有 104 字节上限，跟随沙箱 HOME 会随数据目录深度超限（易失 IPC 端点，
// 与持久数据解耦，不违反归仓语义）。
func isolatedEnv(dataDir string) []string {
	home := filepath.Join(dataDir, "ab-home")
	_ = os.MkdirAll(home, 0o755)
	sockDir := filepath.Join(dataDir, "ab-sockets")
	_ = os.MkdirAll(sockDir, 0o755)
	env := []string{
		"HOME=" + home,
		"PATH=" + os.Getenv("PATH"),
		"AGENT_BROWSER_SOCKET_DIR=" + sockDir,
	}
	if runtime.GOOS == "windows" {
		// Windows 上 os.UserHomeDir 与 Node/Chrome 依赖 USERPROFILE 与系统目录环境变量
		env = append(env, "USERPROFILE="+home)
		for _, k := range []string{
			"SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "PATHEXT",
			"APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
			"ProgramData", "ProgramFiles", "ProgramFiles(x86)", "CommonProgramFiles",
		} {
			if v := os.Getenv(k); v != "" {
				env = append(env, k+"="+v)
			}
		}
	}
	return env
}

// runKeeper 执行一条 agent-browser 会话命令（最小环境 + 超时），返回 stdout。
func (c Config) runKeeper(args []string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	full := append([]string{"--session", c.Session, "--config", c.ConfigPath}, args...)
	cmd := exec.CommandContext(ctx, c.AgentBrowser, full...)
	cmd.Env = isolatedEnv(filepath.Dir(c.ConfigPath))
	out, err := cmd.Output()
	if err != nil {
		// 带上 stderr：exit status 1 无法定位，stderr 才有 agent-browser 的真实报错
		detail := ""
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			detail = ": " + strings.TrimSpace(string(ee.Stderr))
		}
		return "", fmt.Errorf("agent-browser %s 失败: %w%s", strings.Join(args, " "), err, detail)
	}
	return strings.TrimSpace(string(out)), nil
}

// EnsureRunning 确保基座活着，返回浏览器级 WS 地址。
// 探测-冷启动两段式：get cdp-url 是零副作用纯查询（agent-browser 0.41 起
// 浏览器不在时不再自动拉起，直接报 Browser not launched），探测失败即用
// 页面命令 open about:blank 冷启动（daemon+浏览器仍会自动拉起），再取地址。
func (c Config) EnsureRunning(idleTimeout string) (string, error) {
	if err := c.WriteConfig(idleTimeout); err != nil {
		return "", fmt.Errorf("生成 keeper 配置失败: %w", err)
	}
	// 重试：close 后 daemon 拆除存在竞态，紧随的重启可能撞上尚未释放的
	// 单例/套接字——3 次×2s 内基本都能过
	var out string
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			time.Sleep(2 * time.Second)
		}
		out, lastErr = c.runKeeper([]string{"get", "cdp-url"}, 60*time.Second)
		if lastErr == nil {
			break
		}
		// 探测失败=浏览器不在（或瞬断）：open 冷启动后重取地址。
		// open 只作用于 keeper 会话自己的 about:blank 标签页，
		// 不触碰消费者会话的页面；浏览器已在时不会走到这条路径，无标签页泄漏。
		if _, oerr := c.runKeeper([]string{"open", "about:blank"}, 60*time.Second); oerr != nil {
			lastErr = fmt.Errorf("open 冷启动失败: %w", oerr)
			continue
		}
		out, lastErr = c.runKeeper([]string{"get", "cdp-url"}, 60*time.Second)
		if lastErr == nil {
			break
		}
	}
	if lastErr != nil {
		return "", fmt.Errorf("基座就绪失败: %w", lastErr)
	}
	wsURL := strings.TrimSpace(out)
	if !strings.HasPrefix(wsURL, "ws://") && !strings.HasPrefix(wsURL, "wss://") {
		return "", fmt.Errorf("get cdp-url 未返回 WS 地址: %q", wsURL[:min(80, len(wsURL))])
	}
	return wsURL, nil
}

// Stop 原生关闭基座（agent-browser session close），并验证 oldWS 真死。
// 返回 error = 关闭后旧基座仍可连接（Chrome 卡在不可中断态等），调用方必须
// 如实上报，绝不宣称"已重启"。本包不做信号升级——进程事务是 agent-browser 的职责。
func (c Config) Stop(oldWS string) error {
	if _, err := c.runKeeper([]string{"close"}, 30*time.Second); err != nil {
		return fmt.Errorf("基座关闭失败: %w", err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if !wsReachable(oldWS) {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("关闭后基座仍可连接（Chrome 未真死）: %s", oldWS)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// wsReachable 尝试连接浏览器级 WS：连得上=活着。
func wsReachable(wsURL string) bool {
	if wsURL == "" {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		return false
	}
	_ = conn.Close(websocket.StatusNormalClosure, "probe")
	return true
}
