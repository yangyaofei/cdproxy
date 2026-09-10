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

// chromeRoot Chrome 应用束根路径（macOS 形如 /Applications/Google Chrome.app）。
// Helper 进程命令行含该前缀但不含主二进制路径，双校验用它。
func (c Config) chromeRoot() string {
	if i := strings.Index(c.ChromePath, ".app/"); i >= 0 {
		return c.ChromePath[:i+4]
	}
	return c.ChromePath
}

// chromePIDs 定位基座 Chrome 的全部 PID。双重校验防止误杀：
// ①命令行含 user-data-dir 标记 ②命令行含 Chrome 应用束路径——任何 argv 里
// 恰好带该字符串的非 Chrome 进程（编辑器/tail/其他 agent 的 shell）都不会命中。
// 主进程与全部 Helper 必须全量返回：只杀首个（可能是 Helper）会留下主进程假活，
// 重启变成重连。
func (c Config) chromePIDs() []int {
	out, err := exec.Command("pgrep", "-f", c.marker()).Output()
	if err != nil {
		return nil
	}
	root := c.chromeRoot()
	var pids []int
	for _, line := range strings.Fields(string(out)) {
		pid, err := strconv.Atoi(line)
		if err != nil {
			continue
		}
		cmdline, err := exec.Command("ps", "-p", line, "-o", "command=").Output()
		if err != nil {
			continue
		}
		cmd := string(cmdline)
		if strings.Contains(cmd, c.marker()) && strings.Contains(cmd, root) {
			pids = append(pids, pid)
		}
	}
	return pids
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
	if pids := c.chromePIDs(); len(pids) > 0 {
		// 半死：进程在、端口死 —— 精确回收后重启
		c.stopPIDs(pids)
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

// Stop 精确停止基座：对全部匹配 PID 先 SIGTERM 后 SIGKILL（宽限各 2s），
// 并验证死亡。返回 error = 仍有存活进程（通常卡在不可中断内核态 U，
// 任何信号都无效，只能等内核返回或重启系统）——调用方必须如实上报，
// 不得宣称"已重启"。
func (c Config) Stop() error {
	pids := c.chromePIDs()
	if len(pids) == 0 {
		return nil
	}
	if alive := c.stopPIDs(pids); len(alive) > 0 {
		return fmt.Errorf("基座进程无法终止（不可中断内核态 U，信号无效）: %v", alive)
	}
	return nil
}

// stopPIDs 对给定 PID 集合先 TERM 后 KILL（各 2s 宽限），返回仍存活的 PID。
func (c Config) stopPIDs(pids []int) []int {
	var procs []*os.Process
	for _, pid := range pids {
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Signal(syscall.SIGTERM)
			procs = append(procs, proc)
		}
	}
	if !c.waitForDeath(pids, 2*time.Second) {
		for _, proc := range procs {
			_ = proc.Signal(syscall.SIGKILL)
		}
		c.waitForDeath(pids, 2*time.Second)
	}
	var alive []int
	for _, pid := range pids {
		if processAlive(pid) {
			alive = append(alive, pid)
		}
	}
	return alive
}

// waitForDeath 轮询等待全部 PID 死亡，全部死亡提前返回 true。
func (c Config) waitForDeath(pids []int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for {
		live := false
		for _, pid := range pids {
			if processAlive(pid) {
				live = true
				break
			}
		}
		if !live {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// processAlive 进程是否真的活着——僵尸（Z）不算：它不占 CDP 端口不占
// SingletonLock，功能上已死；父进程未 Wait 前会短暂停留僵尸态。
func processAlive(pid int) bool {
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return false
	}
	stat := strings.TrimSpace(string(out))
	return stat != "" && !strings.HasPrefix(stat, "Z") && !strings.HasPrefix(stat, "z")
}
