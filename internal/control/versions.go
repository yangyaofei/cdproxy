// versions.go — 三组件版本自检与在线升级控制面实现。
//
// 覆盖三类组件：
//   - cdproxy 主程序：回报编译期注入的 version、os/arch 与数据目录（升级由 Wails updater 负责）
//   - agent-browser 执行器：经 keeper.ResolveAgentBrowser 回报实际生效二进制；在线升级从
//     GitHub Release 拉取对应平台二进制、校验 SHA-256、执行 --version 探活后原子落入
//     <dataDir>/bin/ 并写入 settings.agent_browser_binary（绝不改动 .app bundle 破坏签名）
//   - cdp-ext 浏览器扩展：比对内嵌 manifest.json、本地导出目录与在线回连版本，支持一键导出、
//     ZIP 打包下载及经反向 WS 通道下发 chrome.runtime.reload 热重载指令
package control

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	assets "github.com/yangyaofei/cdproxy"
	"github.com/yangyaofei/cdproxy/internal/httputil"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

var (
	semverRe        = regexp.MustCompile(`([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)`)
	strictSemverRe  = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	assetDigestReFn = func(asset string) *regexp.Regexp {
		quoted := regexp.QuoteMeta(asset)
		return regexp.MustCompile(`sha256:([0-9a-fA-F]{64})[\s\S]{0,350}?digest for ` + quoted + `|` + `href="[^"]*/` + quoted + `"[\s\S]{0,900}?sha256:([0-9a-fA-F]{64})`)
	}
)

const (
	abReleasesLatestURL   = "https://github.com/vercel-labs/agent-browser/releases/latest"
	abReleasesExpandedURL = "https://github.com/vercel-labs/agent-browser/releases/expanded_assets/v%s"
	abReleaseDownloadURL  = "https://github.com/vercel-labs/agent-browser/releases/download/v%s/%s"
	abReleasesWebURL      = "https://github.com/vercel-labs/agent-browser/releases"
)

func cleanSemver(raw string) string {
	m := semverRe.FindStringSubmatch(strings.TrimSpace(raw))
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// compareSemver 比较两个 semver（忽略预发布后缀比较主次补丁号；有后缀低于无后缀）。
// 返回 >0 表示 a > b，<0 表示 a < b，0 表示相等。
func compareSemver(a, b string) int {
	aMain, aPre, _ := strings.Cut(cleanSemver(a), "-")
	bMain, bPre, _ := strings.Cut(cleanSemver(b), "-")
	if aMain == "" && bMain == "" {
		return 0
	}
	if aMain == "" {
		return -1
	}
	if bMain == "" {
		return 1
	}
	ap := strings.Split(aMain, ".")
	bp := strings.Split(bMain, ".")
	for i := 0; i < 3; i++ {
		var ai, bi int
		if i < len(ap) {
			ai, _ = strconv.Atoi(ap[i])
		}
		if i < len(bp) {
			bi, _ = strconv.Atoi(bp[i])
		}
		if ai != bi {
			if ai > bi {
				return 1
			}
			return -1
		}
	}
	if aPre == bPre {
		return 0
	}
	if aPre == "" {
		return 1
	}
	if bPre == "" {
		return -1
	}
	return strings.Compare(aPre, bPre)
}

func agentBrowserExeNameForOS(goos string) string {
	if goos == "windows" {
		return "agent-browser.exe"
	}
	return "agent-browser"
}

func agentBrowserAsset(goos, goarch string) (string, error) {
	switch goos + "/" + goarch {
	case "darwin/arm64":
		return "agent-browser-darwin-arm64", nil
	case "darwin/amd64":
		return "agent-browser-darwin-x64", nil
	case "linux/arm64":
		return "agent-browser-linux-arm64", nil
	case "linux/amd64":
		return "agent-browser-linux-x64", nil
	case "windows/amd64":
		return "agent-browser-win32-x64.exe", nil
	default:
		return "", fmt.Errorf("暂不支持在 %s/%s 上自动升级 agent-browser", goos, goarch)
	}
}

func readManifestVersion(fsys fs.FS, manifestPath string) string {
	data, err := fs.ReadFile(fsys, manifestPath)
	if err != nil {
		return ""
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	return strings.TrimSpace(m.Version)
}

func readDiskManifestVersion(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var m struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return ""
	}
	return strings.TrimSpace(m.Version)
}

func extensionExportDir(dataDir string) string {
	return filepath.Join(dataDir, "extension", "cdp-ext")
}

func (c *Control) extensionRuntimeConfigJSON() []byte {
	cfg := c.store.Get()
	wsPort := cfg.WsPort
	if snap := c.proxy.Status(); snap != nil {
		if p, ok := snap["ws_port"].(int); ok && p > 0 {
			wsPort = p
		}
	}
	payload := map[string]string{
		"relayUrl":    fmt.Sprintf("ws://127.0.0.1:%d/ext", wsPort),
		"token":       cfg.Sources.ExtensionToken,
		"groupPrefix": settings.NormalizeGroupPrefix(cfg.Sources.GroupPrefix),
		"generatedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
	data, _ := json.MarshalIndent(payload, "", "  ")
	return append(data, '\n')
}

// SyncExtensionRuntimeConfig 刷新已导出扩展目录下的 runtime-config.json（端口/令牌/分组前缀变更时自动调用）。
func (c *Control) SyncExtensionRuntimeConfig() {
	dataDir := filepath.Dir(c.logPath)
	extDir := extensionExportDir(dataDir)
	if _, err := os.Stat(filepath.Join(extDir, "manifest.json")); err != nil {
		return
	}
	cfgPath := filepath.Join(extDir, "runtime-config.json")
	if err := os.WriteFile(cfgPath, c.extensionRuntimeConfigJSON(), 0o600); err != nil {
		c.log.Warn("写入扩展 runtime-config.json 失败", "path", cfgPath, "err", err)
	}
}

// EnsureExtensionReady 启动时自动确保 <dataDir>/extension/cdp-ext 就绪且内置当前端口与令牌。
func (c *Control) EnsureExtensionReady() {
	dataDir := filepath.Dir(c.logPath)
	extDir := extensionExportDir(dataDir)
	bundledVer := readManifestVersion(assets.FS, "ext/cdp-ext/manifest.json")
	exportedVer := readDiskManifestVersion(filepath.Join(extDir, "manifest.json"))
	if exportedVer == "" || (bundledVer != "" && compareSemver(exportedVer, bundledVer) < 0) {
		if _, err := c.exportBundledExtension(); err != nil {
			c.log.Warn("启动自动导出 cdp-ext 失败", "err", err)
		}
		return
	}
	c.SyncExtensionRuntimeConfig()
}

func (c *Control) detectChromeExtension() ChromeExtStatus {
	dataDir := filepath.Dir(c.logPath)
	extDir := extensionExportDir(dataDir)
	extBundledVer := readManifestVersion(assets.FS, "ext/cdp-ext/manifest.json")
	extExportedVer := readDiskManifestVersion(filepath.Join(extDir, "manifest.json"))
	snap := c.proxy.Status()
	extConnected := false
	extConnectedVer := ""
	if src, ok := snap["sources"].(map[string]any); ok {
		if ex, ok := src["extension"].(map[string]any); ok {
			extConnected, _ = ex["connected"].(bool)
			extConnectedVer, _ = ex["version"].(string)
		}
	}
	return detectChromeExtensionsInRoots(defaultBrowserRoots(), extDir, extConnected, extConnectedVer, extBundledVer, extExportedVer != "")
}

func (c *Control) versionsPayload() map[string]any {
	dataDir := filepath.Dir(c.logPath)
	ab := c.agentBrowserInfo()

	bundledBin := keeper.BundledAgentBrowser()
	bundledVer := ""
	if bundledBin != "" {
		bundledVer = cleanSemver(keeper.AgentBrowserVersion(bundledBin))
	}
	ab["bundled_path"] = bundledBin
	ab["bundled_version"] = bundledVer
	curVerStr, _ := ab["version"].(string)
	ab["clean_version"] = cleanSemver(curVerStr)

	managedPath := filepath.Join(dataDir, "runtime", "bin", agentBrowserExeNameForOS(runtime.GOOS))
	ab["managed_path"] = managedPath
	if _, err := os.Stat(managedPath); err == nil {
		ab["managed_exists"] = true
		ab["managed_version"] = cleanSemver(keeper.AgentBrowserVersion(managedPath))
	} else {
		ab["managed_exists"] = false
		ab["managed_version"] = ""
	}
	assetName, assetErr := agentBrowserAsset(runtime.GOOS, runtime.GOARCH)
	ab["asset_name"] = assetName
	ab["upgradable"] = assetErr == nil

	extBundledVer := readManifestVersion(assets.FS, "ext/cdp-ext/manifest.json")
	extDir := extensionExportDir(dataDir)
	extExportedVer := readDiskManifestVersion(filepath.Join(extDir, "manifest.json"))

	snap := c.proxy.Status()
	extConnected := false
	extConnectedVer := ""
	if src, ok := snap["sources"].(map[string]any); ok {
		if ex, ok := src["extension"].(map[string]any); ok {
			extConnected, _ = ex["connected"].(bool)
			extConnectedVer, _ = ex["version"].(string)
		}
	}

	needsExport := extExportedVer != "" && extBundledVer != "" && compareSemver(extExportedVer, extBundledVer) < 0
	needsReload := extConnected && extBundledVer != "" && extConnectedVer != extBundledVer
	chromeExt := detectChromeExtensionsInRoots(defaultBrowserRoots(), extDir, extConnected, extConnectedVer, extBundledVer, extExportedVer != "")

	return map[string]any{
		"cdproxy": map[string]any{
			"version":  c.version,
			"os":       runtime.GOOS,
			"arch":     runtime.GOARCH,
			"data_dir": dataDir,
		},
		"agent_browser": ab,
		"extension": map[string]any{
			"bundled_version":   extBundledVer,
			"connected":         extConnected,
			"connected_version": extConnectedVer,
			"export_dir":        extDir,
			"exported":          extExportedVer != "",
			"exported_version":  extExportedVer,
			"needs_export":      needsExport,
			"needs_reload":      needsReload,
			"chrome":            chromeExt,
		},
	}
}

func (c *Control) downloadUserAgent() string {
	ver := strings.TrimSpace(c.version)
	if ver == "" {
		return httputil.DefaultUserAgent
	}
	return "cdproxy/" + ver
}

func (c *Control) fetchAgentBrowserLatest(ctx context.Context) (map[string]any, error) {
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := httputil.NewDownloadClient(httputil.DownloadClientOptions{
		UserAgent: c.downloadUserAgent(),
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	})
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, abReleasesLatestURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("访问 GitHub Release 失败: %w", err)
	}
	defer resp.Body.Close()

	loc := resp.Header.Get("Location")
	latest := cleanSemver(loc)
	if latest == "" && resp.StatusCode >= 200 && resp.StatusCode < 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
		if m := regexp.MustCompile(`/releases/tag/v([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)`).FindSubmatch(body); len(m) == 2 {
			latest = string(m[1])
		}
	}
	if latest == "" {
		return nil, fmt.Errorf("未能从 GitHub 解析最新版本号 (HTTP %d)", resp.StatusCode)
	}

	ab := c.agentBrowserInfo()
	curRaw, _ := ab["version"].(string)
	curVer := cleanSemver(curRaw)
	assetName, _ := agentBrowserAsset(runtime.GOOS, runtime.GOARCH)

	return map[string]any{
		"current_version":  curVer,
		"latest_version":   latest,
		"update_available": compareSemver(latest, curVer) > 0,
		"release_url":      fmt.Sprintf("%s/tag/v%s", abReleasesWebURL, latest),
		"asset_name":       assetName,
	}, nil
}

func fetchExpectedAssetSHA256(ctx context.Context, userAgent, version, assetName string) string {
	reqCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	client := httputil.NewDownloadClient(httputil.DownloadClientOptions{
		UserAgent: userAgent,
	})
	url := fmt.Sprintf(abReleasesExpandedURL, version)
	req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, url, nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		if resp != nil {
			resp.Body.Close()
		}
		return ""
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return ""
	}
	re := assetDigestReFn(assetName)
	if m := re.FindSubmatch(body); len(m) >= 3 {
		for _, g := range m[1:] {
			if len(g) == 64 {
				return strings.ToLower(string(g))
			}
		}
	}
	return ""
}

func (c *Control) upgradeAgentBrowser(ctx context.Context, targetVer string) (map[string]any, error) {
	assetName, err := agentBrowserAsset(runtime.GOOS, runtime.GOARCH)
	if err != nil {
		return nil, err
	}
	ver := strings.TrimPrefix(strings.TrimSpace(targetVer), "v")
	if ver == "" {
		latestInfo, err := c.fetchAgentBrowserLatest(ctx)
		if err != nil {
			return nil, err
		}
		ver, _ = latestInfo["latest_version"].(string)
	}
	if !strictSemverRe.MatchString(ver) {
		return nil, fmt.Errorf("无效的版本号: %q", ver)
	}

	ua := c.downloadUserAgent()
	expectedSHA := fetchExpectedAssetSHA256(ctx, ua, ver, assetName)
	dlURL := fmt.Sprintf(abReleaseDownloadURL, ver, assetName)
	dlCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	client := httputil.NewDownloadClient(httputil.DownloadClientOptions{
		UserAgent: ua,
	})
	req, err := http.NewRequestWithContext(dlCtx, http.MethodGet, dlURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载 agent-browser 失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载 agent-browser 返回 HTTP %d", resp.StatusCode)
	}

	dataDir := filepath.Dir(c.logPath)
	binDir := filepath.Join(dataDir, "runtime", "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建二进制目录失败: %w", err)
	}
	destPath := filepath.Join(binDir, agentBrowserExeNameForOS(runtime.GOOS))
	partPath := destPath + ".part"
	f, err := os.OpenFile(partPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return nil, fmt.Errorf("创建临时文件失败: %w", err)
	}
	hasher := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, hasher), io.LimitReader(resp.Body, 256<<20)); err != nil {
		f.Close()
		_ = os.Remove(partPath)
		return nil, fmt.Errorf("写入下载文件失败: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(partPath)
		return nil, err
	}
	actualSHA := hex.EncodeToString(hasher.Sum(nil))
	if expectedSHA != "" && !strings.EqualFold(actualSHA, expectedSHA) {
		_ = os.Remove(partPath)
		return nil, fmt.Errorf("SHA-256 校验失败: expect=%s actual=%s", expectedSHA, actualSHA)
	}
	if err := os.Chmod(partPath, 0o755); err != nil {
		_ = os.Remove(partPath)
		return nil, err
	}

	gotRaw := keeper.AgentBrowserVersion(partPath)
	gotClean := cleanSemver(gotRaw)
	if gotClean == "" {
		_ = os.Remove(partPath)
		return nil, fmt.Errorf("下载的可执行文件无法执行版本探活（output=%q）", gotRaw)
	}
	if err := os.Rename(partPath, destPath); err != nil {
		_ = os.Remove(partPath)
		return nil, fmt.Errorf("替换可执行文件失败（请先停止正在使用的基座 Chrome）: %w", err)
	}

	if _, err := c.store.Update(map[string]any{"agent_browser_binary": destPath}); err != nil {
		return nil, fmt.Errorf("更新设置指向新二进制失败: %w", err)
	}
	if c.onState != nil {
		c.onState()
	}
	c.log.Info("agent-browser 已升级并切换", "version", gotClean, "path", destPath)
	return map[string]any{
		"status":  "upgraded",
		"version": gotClean,
		"path":    destPath,
		"sha256":  actualSHA,
	}, nil
}

func (c *Control) exportBundledExtension() (map[string]any, error) {
	dataDir := filepath.Dir(c.logPath)
	destRoot := extensionExportDir(dataDir)
	if err := os.MkdirAll(destRoot, 0o755); err != nil {
		return nil, fmt.Errorf("创建扩展目录失败: %w", err)
	}
	sub, err := fs.Sub(assets.FS, "ext/cdp-ext")
	if err != nil {
		return nil, fmt.Errorf("读取内嵌扩展资产失败: %w", err)
	}
	var files []string
	err = fs.WalkDir(sub, ".", func(rel string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		target := filepath.Join(destRoot, filepath.FromSlash(rel))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := fs.ReadFile(sub, rel)
		if err != nil {
			return err
		}
		if err := os.WriteFile(target, data, 0o644); err != nil {
			return err
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, err
	}
	// 写入本机当前端口、令牌与分组前缀，加载到 Chrome 后无需手动配置即可自动回连
	if err := os.WriteFile(filepath.Join(destRoot, "runtime-config.json"), c.extensionRuntimeConfigJSON(), 0o600); err != nil {
		return nil, fmt.Errorf("写入扩展运行配置失败: %w", err)
	}
	files = append(files, "runtime-config.json")
	ver := readDiskManifestVersion(filepath.Join(destRoot, "manifest.json"))
	c.log.Info("已导出内置 cdp-ext 扩展到本地目录", "dir", destRoot, "version", ver)
	return map[string]any{
		"status":  "exported",
		"path":    destRoot,
		"version": ver,
		"files":   files,
	}, nil
}

func (c *Control) buildExtensionZip() ([]byte, string, error) {
	sub, err := fs.Sub(assets.FS, "ext/cdp-ext")
	if err != nil {
		return nil, "", fmt.Errorf("读取内嵌扩展资产失败: %w", err)
	}
	ver := readManifestVersion(sub, "manifest.json")
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	err = fs.WalkDir(sub, ".", func(rel string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		data, err := fs.ReadFile(sub, rel)
		if err != nil {
			return err
		}
		fw, err := zw.Create("cdp-ext/" + rel)
		if err != nil {
			return err
		}
		_, err = fw.Write(data)
		return err
	})
	if err != nil {
		return nil, "", err
	}
	if fw, err := zw.Create("cdp-ext/runtime-config.json"); err == nil {
		_, _ = fw.Write(c.extensionRuntimeConfigJSON())
	}
	if err := zw.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), ver, nil
}
