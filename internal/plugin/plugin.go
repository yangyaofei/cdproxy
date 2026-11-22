// Package plugin 实现 agent-browser.plugin.v1 stdio provider 协议桥。
//
// 桌面端（cdproxy-desktop plugin）与 CLI（cdproxy plugin / 隐式 stdin 管道）共用本包：
// 读取 stdin 的 JSON 信封，按需自动拉起后台服务，再经 HTTP POST /sessions 为指定
// session 分配隔离 CDP 连接并回写 stdout。
// 分配令牌优先从本地 <dataDir>/settings.json 读取（不依赖无鉴权 /status）。
package plugin

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/yangyaofei/cdproxy/internal/datadir"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

// Options 插件模式运行参数。
type Options struct {
	// DesktopApp 为 true 时，服务未启动时后台拉起桌面 App 自身（macOS 经 open -g -a）；
	// 为 false 时以 CLI 子进程 `serve --data-dir ...` 拉起。
	DesktopApp bool
	// ControlBase 可选覆盖控制面根地址（测试用；空时按 AB_PROXY_CONTROL > settings.json > 9224 解析）。
	ControlBase string
	// DataDir 可选覆盖数据目录（测试用；空时走 datadir.Resolve）。
	DataDir string
	// In / Out 可选替换 stdin/stdout（单元测试用）。
	In  io.Reader
	Out io.Writer
}

type response struct {
	Protocol string   `json:"protocol"`
	Success  bool     `json:"success"`
	Browser  *browser `json:"browser,omitempty"`
	Error    string   `json:"error,omitempty"`
}

type browser struct {
	CdpURL string `json:"cdpUrl"`
}

// Run 执行一次完整的 agent-browser.plugin.v1 stdio 交互，返回进程退出码。
func Run(opts Options) int {
	in := opts.In
	if in == nil {
		in = os.Stdin
	}
	out := opts.Out
	if out == nil {
		out = os.Stdout
	}
	writeResp := func(r response) {
		b, _ := json.Marshal(r)
		_, _ = fmt.Fprintln(out, string(b))
	}

	raw, err := io.ReadAll(in)
	if err != nil {
		writeResp(response{Protocol: "agent-browser.plugin.v1", Error: "stdin 读取失败"})
		return 1
	}
	var envelope struct {
		Type    string `json:"type"`
		Request struct {
			Session string `json:"session"`
		} `json:"request"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		writeResp(response{Protocol: "agent-browser.plugin.v1", Error: "invalid JSON request"})
		return 1
	}
	session := strings.TrimSpace(envelope.Request.Session)
	if session == "" {
		session = "default"
	}

	dataDir := datadir.Resolve(opts.DataDir)
	switch envelope.Type {
	case "browser.launch":
		base := resolveControlBase(opts.ControlBase, dataDir)
		if err := ensureServiceUp(opts, base, dataDir); err != nil {
			writeResp(response{Protocol: "agent-browser.plugin.v1", Error: fmt.Sprintf("服务拉起失败: %v", err)})
			return 1
		}
		// 服务首次拉起可能刚写入 settings.json，重读一次以拿到最新端口与分配令牌
		base = resolveControlBase(opts.ControlBase, dataDir)
		tok := resolveAllocToken(base, dataDir)
		payload, _ := json.Marshal(map[string]string{"name": session})
		body, code := httpPostAuth(base+"/sessions", payload, tok)
		if code == http.StatusUnauthorized {
			writeResp(response{
				Protocol: "agent-browser.plugin.v1",
				Error:    "alloc 被拒（401）：分配令牌不匹配，请检查数据目录 settings.json 或 AB_PROXY_ALLOC_TOKEN",
			})
			return 1
		}
		if code != http.StatusOK {
			writeResp(response{
				Protocol: "agent-browser.plugin.v1",
				Error:    fmt.Sprintf("alloc 失败 (HTTP %d): %s", code, strings.TrimSpace(string(body))),
			})
			return 1
		}
		var alloc struct {
			CdpURL string `json:"cdpUrl"`
		}
		_ = json.Unmarshal(body, &alloc)
		writeResp(response{
			Protocol: "agent-browser.plugin.v1",
			Success:  true,
			Browser:  &browser{CdpURL: alloc.CdpURL},
		})
		return 0

	case "browser.close":
		base := resolveControlBase(opts.ControlBase, dataDir)
		_, _ = httpPostAuth(base+"/sessions/"+session+"/release", nil, resolveAllocToken(base, dataDir))
		writeResp(response{Protocol: "agent-browser.plugin.v1", Success: true})
		return 0

	default:
		writeResp(response{Protocol: "agent-browser.plugin.v1", Error: "unsupported request type: " + envelope.Type})
		return 1
	}
}

func resolveControlBase(explicit, dataDir string) string {
	if explicit != "" {
		return strings.TrimRight(explicit, "/")
	}
	if v := strings.TrimSpace(os.Getenv("AB_PROXY_CONTROL")); v != "" {
		return strings.TrimRight(v, "/")
	}
	port := readControlPortFromSettings(filepath.Join(dataDir, "settings.json"))
	if port <= 0 {
		port = 9224
	}
	return fmt.Sprintf("http://127.0.0.1:%d", port)
}

func readControlPortFromSettings(path string) int {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	var raw struct {
		ControlPort int `json:"control_port"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return 0
	}
	return raw.ControlPort
}

func readAllocTokenFromSettings(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var raw struct {
		Sources struct {
			AllocToken string `json:"alloc_token"`
		} `json:"sources"`
	}
	if json.Unmarshal(data, &raw) != nil {
		return ""
	}
	return strings.TrimSpace(raw.Sources.AllocToken)
}

func resolveAllocToken(base, dataDir string) string {
	if v := strings.TrimSpace(os.Getenv("AB_PROXY_ALLOC_TOKEN")); v != "" {
		return v
	}
	if tok := readAllocTokenFromSettings(filepath.Join(dataDir, "settings.json")); tok != "" {
		return tok
	}
	// 兜底：若 settings.json 尚未在默认路径找到，再尝试 /status
	resp, err := http.Get(base + "/status")
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	var st struct {
		Sources struct {
			AllocToken string `json:"alloc_token"`
		} `json:"sources"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&st)
	return strings.TrimSpace(st.Sources.AllocToken)
}

func ensureServiceUp(opts Options, base, dataDir string) error {
	if _, code := httpGet(base + "/health"); code == http.StatusOK {
		return nil
	}
	if opts.ControlBase != "" {
		return fmt.Errorf("指定控制面 %s 不可达", opts.ControlBase)
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	var cmd *exec.Cmd
	if opts.DesktopApp {
		if runtime.GOOS == "darwin" {
			if bundle := macAppBundlePath(self); bundle != "" {
				cmd = exec.Command("open", "-g", "-a", bundle)
			}
		}
		if cmd == nil {
			cmd = exec.Command(self)
			cmd.SysProcAttr = detachedSysProcAttr()
		}
	} else {
		logPath := filepath.Join(dataDir, "runtime", "plugin-autostart.log")
		_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
		logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err == nil {
			defer func() { _ = logFile.Close() }()
		}
		cmd = exec.Command(self, "serve", "--data-dir", dataDir)
		cmd.Stdout = logFile
		cmd.Stderr = logFile
		cmd.Stdin = nil
		cmd.SysProcAttr = detachedSysProcAttr()
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		curBase := resolveControlBase("", dataDir)
		if _, code := httpGet(curBase + "/health"); code == http.StatusOK {
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("30s 内未就绪（端口 %d）", settings.Defaults().ControlPort)
}

// macAppBundlePath 从 /path/to/Foo.app/Contents/MacOS/foo 提取 /path/to/Foo.app。
func macAppBundlePath(exe string) string {
	clean := filepath.Clean(exe)
	dir := filepath.Dir(clean)
	if filepath.Base(dir) != "MacOS" {
		return ""
	}
	contents := filepath.Dir(dir)
	if filepath.Base(contents) != "Contents" {
		return ""
	}
	bundle := filepath.Dir(contents)
	if strings.HasSuffix(bundle, ".app") {
		return bundle
	}
	return ""
}

func httpGet(rawURL string) ([]byte, int) {
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(rawURL)
	if err != nil {
		return nil, 0
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}

func httpPostAuth(rawURL string, payload []byte, token string) ([]byte, int) {
	var bodyRdr io.Reader
	if len(payload) > 0 {
		bodyRdr = strings.NewReader(string(payload))
	}
	req, err := http.NewRequest(http.MethodPost, rawURL, bodyRdr)
	if err != nil {
		return nil, 0
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, 0
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	return body, resp.StatusCode
}
