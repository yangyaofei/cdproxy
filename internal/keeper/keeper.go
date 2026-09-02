// Package keeper 管理 Chrome 基座：启动/复用/停止本地 Chrome。
//
// 与 Python 参考实现 keeper.py 语义对齐：
//   - 复用：CDP 端口活着（/json/version 有 webSocketDebuggerUrl）直接用
//   - 半死：进程在但端口死 → 精确 SIGTERM 该 PID 后重启
//   - 启动：脱离会话（Setsid），stale 锁文件清理，15s 就绪轮询
//   - 红线：绝不 killall —— 只精确操作 pgrep+ps 双重校验过的 PID
package keeper

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Config Chrome 基座配置。
type Config struct {
	ChromePath string // Chrome 可执行文件
	ProfileDir string // 登录态 profile 目录
	CDPPort    int    // 远程调试端口
	Headless   bool
}

// Defaults 默认配置：PATH 探测 → macOS 安装路径；profile 固定共享目录。
func Defaults() Config {
	cfg := Config{
		ProfileDir: filepath.Join(os.Getenv("HOME"), "agent-browser", "profile"),
		CDPPort:    9222,
	}
	for _, name := range []string{"google-chrome", "chromium", "chromium-browser", "google-chrome-stable"} {
		if p, err := exec.LookPath(name); err == nil {
			cfg.ChromePath = p
			return cfg
		}
	}
	mac := "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
	if _, err := os.Stat(mac); err == nil {
		cfg.ChromePath = mac
	}
	return cfg
}

func (c Config) versionURL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/json/version", c.CDPPort)
}

func (c Config) marker() string {
	return "user-data-dir=" + c.ProfileDir
}

// Alive CDP 端口是否存活（且为浏览器级端点）。
func (c Config) Alive() bool {
	_, err := c.browserWsURLWithTimeout(2 * time.Second)
	return err == nil
}

// BrowserWsURL 返回浏览器级调试 WS 地址。
func (c Config) BrowserWsURL() (string, error) {
	return c.browserWsURLWithTimeout(3 * time.Second)
}

func (c Config) browserWsURLWithTimeout(timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.versionURL(), nil)
	if err != nil {
		return "", err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("cdp /json/version 状态 %d", resp.StatusCode)
	}
	var payload map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	wsURL, _ := payload["webSocketDebuggerUrl"].(string)
	if wsURL == "" {
		return "", fmt.Errorf("cdp 响应缺 webSocketDebuggerUrl")
	}
	return wsURL, nil
}

// chromePID 精确定位基座 Chrome 的 PID（pgrep + ps 双重校验）。
func (c Config) chromePID() (int, bool) {
	out, err := exec.Command("pgrep", "-f", c.marker()).Output()
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(line)
		if err != nil {
			continue
		}
		cmdline, err := exec.Command("ps", "-p", line, "-o", "command=").Output()
		if err != nil {
			continue
		}
		if strings.Contains(string(cmdline), c.marker()) {
			return pid, true
		}
	}
	return 0, false
}

// cleanStaleLocks 清理 stale 单例锁（进程已死但锁残留会阻断启动）。
func (c Config) cleanStaleLocks() {
	for _, name := range []string{"SingletonLock", "SingletonCookie", "SingletonSocket"} {
		_ = os.RemoveAll(filepath.Join(c.ProfileDir, name))
	}
}

// EnsureRunning 确保基座在跑：活着复用；半死精确停止后重启；冷启动。
// 返回浏览器级 WS 地址。
func (c Config) EnsureRunning() (string, error) {
	if wsURL, err := c.BrowserWsURL(); err == nil {
		return wsURL, nil
	}
	if pid, ok := c.chromePID(); ok {
		// 半死：进程在、端口死 —— 精确回收后重启
		c.stopPID(pid)
	}
	c.cleanStaleLocks()
	if err := os.MkdirAll(c.ProfileDir, 0o755); err != nil {
		return "", fmt.Errorf("创建 profile 目录失败: %w", err)
	}
	args := []string{
		"--remote-debugging-port=" + strconv.Itoa(c.CDPPort),
		"--user-data-dir=" + c.ProfileDir,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-session-crashed-bubble",
		"--hide-crash-restore-bubble",
	}
	if c.Headless {
		args = append(args, "--headless=new")
	}
	cmd := exec.Command(c.ChromePath, args...)
	cmd.Stdout = nil
	cmd.Stderr = nil
	cmd.Stdin = nil
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} // 脱离服务进程组，服务退出不连坐
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("Chrome 启动失败: %w", err)
	}
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if wsURL, err := c.BrowserWsURL(); err == nil {
			return wsURL, nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return "", fmt.Errorf("Chrome 15s 内未就绪")
}

// Stop 精确停止基座（SIGTERM → 0.5s → SIGKILL）。
func (c Config) Stop() bool {
	pid, ok := c.chromePID()
	if !ok {
		return false
	}
	c.stopPID(pid)
	return true
}

func (c Config) stopPID(pid int) {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return
	}
	_ = proc.Signal(syscall.SIGTERM)
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = proc.Signal(syscall.SIGKILL)
}

func processAlive(pid int) bool {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "pid=").Output()
	return err == nil && strings.TrimSpace(string(out)) != ""
}
