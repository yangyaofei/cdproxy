package keeper

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

// agent-browser 二进制的唯一解析链。三处消费方（UI 检测显示、keeper 实际
// 拉起、版本探活）必须共用本链，禁止各自探测（历史教训：control 查 env、
// keeper 写死 LookPath，导致内嵌版从未实际参与工作）。
//
// 链序（先中先用）：
//  1. explicit——settings.agent_browser_binary 显式外部覆盖
//  2. bundled——.app Contents/Resources/agent-browser/（env 覆盖供开发
//     模式直指 desktop/build staging）
//  3. PATH——exec.LookPath 兜底（无 bundle 的 CLI 部署形态）
//
// 架构约束：bundled 版永不离开 bundle——不存在也不允许「安装到 PATH」。

// ResolveAgentBrowser 按唯一解析链定位 agent-browser，返回可执行文件
// 绝对路径与来源标签（setting|bundled|path|none）。
func ResolveAgentBrowser(explicit string) (string, string) {
	if p := explicit; p != "" {
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p, "setting"
		}
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
// 直指 staging），否则按当前可执行文件位置找 .app Resources。
// CLI 部署（无 Resources）返回空。
func BundledAgentBrowser() string {
	if v := os.Getenv("AB_AGENT_BROWSER_BUNDLED_DIR"); v != "" {
		p := filepath.Join(v, "agent-browser")
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
			return p
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	// 开发二进制 desktop/bin/ → staging ../build/agent-browser/；
	// 打包 .app/Contents/MacOS/ → ../Resources/agent-browser/
	for _, rel := range []string{"../build/agent-browser/agent-browser", "../Resources/agent-browser/agent-browser"} {
		p := filepath.Join(filepath.Dir(exe), rel)
		if fi, err := os.Stat(p); err == nil && !fi.IsDir() && fi.Mode()&0o111 != 0 {
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
	return stringTrimSpace(string(out))
}

func stringTrimSpace(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t' || s[start] == '\n' || s[start] == '\r') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t' || s[end-1] == '\n' || s[end-1] == '\r') {
		end--
	}
	return s[start:end]
}
