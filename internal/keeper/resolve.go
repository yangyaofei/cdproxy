package keeper

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// agent-browser 二进制的唯一解析链。三处消费方（UI 检测显示、keeper 实际
// 拉起、版本探活）必须共用本链，禁止各自探测（历史教训：control 查 env、
// keeper 写死 LookPath，导致内嵌版从未实际参与工作）。
//
// 链序（先中先用）：
//  1. explicit——settings.agent_browser_binary 显式外部覆盖
//  2. bundled——.app Contents/Resources/agent-browser/ 或同级目录（env 覆盖
//     供开发模式直指 desktop/build staging）
//  3. PATH——exec.LookPath 兜底（无 bundle 的 CLI 部署形态）
//
// 架构约束：bundled 版永不离开 bundle——不存在也不允许「安装到 PATH」。

func agentBrowserExeName() string {
	if runtime.GOOS == "windows" {
		return "agent-browser.exe"
	}
	return "agent-browser"
}

func isExecutable(path string) bool {
	fi, err := os.Stat(path)
	if err != nil || fi.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		ext := strings.ToLower(filepath.Ext(path))
		return ext == ".exe" || ext == ".cmd" || ext == ".bat" || ext == ".com"
	}
	return fi.Mode()&0o111 != 0
}

// ResolveAgentBrowser 按唯一解析链定位 agent-browser，返回可执行文件
// 绝对路径与来源标签（setting|bundled|path|none）。
func ResolveAgentBrowser(explicit string) (string, string) {
	if p := explicit; p != "" && isExecutable(p) {
		return p, "setting"
	}
	if p := BundledAgentBrowser(); p != "" {
		return p, "bundled"
	}
	if p, err := exec.LookPath("agent-browser"); err == nil {
		return p, "path"
	}
	return "", "none"
}

// BundledAgentBrowser 探测内嵌 agent-browser：env 覆盖优先（开发模式
// 直指 staging），否则按当前可执行文件位置找 bundle 目录。
// CLI 部署（无内嵌目录）返回空。
func BundledAgentBrowser() string {
	bin := agentBrowserExeName()
	if v := os.Getenv("AB_AGENT_BROWSER_BUNDLED_DIR"); v != "" {
		p := filepath.Join(v, bin)
		if isExecutable(p) {
			return p
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exeDir := filepath.Dir(exe)
	// 开发二进制 desktop/bin/ → staging ../build/agent-browser/；
	// 打包 macOS .app/Contents/MacOS/ → ../Resources/agent-browser/；
	// Windows/Linux 便携包同级目录 → agent-browser/
	for _, rel := range []string{
		filepath.Join("..", "build", "agent-browser", bin),
		filepath.Join("..", "Resources", "agent-browser", bin),
		filepath.Join("agent-browser", bin),
	} {
		p := filepath.Join(exeDir, rel)
		if isExecutable(p) {
			return p
		}
	}
	return ""
}

// AgentBrowserVersion 探测二进制版本（3s 超时；失败返回空串，不阻断调用方）。
func AgentBrowserVersion(bin string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
