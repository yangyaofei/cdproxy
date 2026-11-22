// ext_detect.go — 只读扫描本机 Chrome/Chromium 浏览器配置，检测 cdp-ext 扩展安装状态。
//
// 原理：Chrome 在各 Profile 目录下的 Secure Preferences / Preferences JSON 中记录
// extensions.settings.<id>（含 path、state=1 启用 / 0 禁用、manifest）。
// 本模块严格只读，绝不修改任何浏览器配置文件，扫描失败或无权限时静默回退为空列表。
package control

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

const cdpExtHomepageURL = "https://github.com/yangyaofei/cdproxy"

type browserRoot struct {
	Name string
	Dir  string
}

// ChromeExtInstall 单条检测到的浏览器扩展安装记录。
type ChromeExtInstall struct {
	Browser          string `json:"browser"`
	Profile          string `json:"profile"`
	ProfileName      string `json:"profile_name,omitempty"`
	ExtensionID      string `json:"extension_id"`
	Version          string `json:"version"`
	Enabled          bool   `json:"enabled"`
	Path             string `json:"path"`
	MatchesExportDir bool   `json:"matches_export_dir"`
}

// ChromeExtStatus 汇总检测结果（供首页状态徽章与源页内嵌配置步骤使用）。
type ChromeExtStatus struct {
	// State 取值：connected | outdated | not_installed | disabled | installed_offline
	State           string             `json:"state"`
	BrowsersScanned []string           `json:"browsers_scanned"`
	Installations   []ChromeExtInstall `json:"installations"`
	ExportDir       string             `json:"export_dir"`
	Exported        bool               `json:"exported"`
	BundledVersion  string             `json:"bundled_version"`
	ConnectedVer    string             `json:"connected_version,omitempty"`
}

func defaultBrowserRoots() []browserRoot {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return nil
	}
	switch runtime.GOOS {
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support")
		return []browserRoot{
			{Name: "Google Chrome", Dir: filepath.Join(base, "Google", "Chrome")},
			{Name: "Google Chrome Canary", Dir: filepath.Join(base, "Google", "Chrome Canary")},
			{Name: "Chromium", Dir: filepath.Join(base, "Chromium")},
			{Name: "Microsoft Edge", Dir: filepath.Join(base, "Microsoft Edge")},
			{Name: "Brave", Dir: filepath.Join(base, "BraveSoftware", "Brave-Browser")},
			{Name: "Arc", Dir: filepath.Join(base, "Arc", "User Data")},
		}
	case "windows":
		localAppData := os.Getenv("LOCALAPPDATA")
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		return []browserRoot{
			{Name: "Google Chrome", Dir: filepath.Join(localAppData, "Google", "Chrome", "User Data")},
			{Name: "Microsoft Edge", Dir: filepath.Join(localAppData, "Microsoft", "Edge", "User Data")},
			{Name: "Brave", Dir: filepath.Join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")},
		}
	default:
		cfg := filepath.Join(home, ".config")
		return []browserRoot{
			{Name: "Google Chrome", Dir: filepath.Join(cfg, "google-chrome")},
			{Name: "Chromium", Dir: filepath.Join(cfg, "chromium")},
			{Name: "Brave", Dir: filepath.Join(cfg, "BraveSoftware", "Brave-Browser")},
		}
	}
}

func readProfileNames(userDataDir string) map[string]string {
	out := map[string]string{}
	data, err := os.ReadFile(filepath.Join(userDataDir, "Local State"))
	if err != nil {
		return out
	}
	var parsed struct {
		Profile struct {
			InfoCache map[string]struct {
				Name string `json:"name"`
			} `json:"info_cache"`
		} `json:"profile"`
	}
	if json.Unmarshal(data, &parsed) != nil {
		return out
	}
	for dir, info := range parsed.Profile.InfoCache {
		if strings.TrimSpace(info.Name) != "" {
			out[dir] = strings.TrimSpace(info.Name)
		}
	}
	return out
}

type chromeExtPrefEntry struct {
	Path     string `json:"path"`
	State    int    `json:"state"`
	Manifest struct {
		Name        string   `json:"name"`
		Version     string   `json:"version"`
		HomepageURL string   `json:"homepage_url"`
		Permissions []string `json:"permissions"`
		Background  struct {
			ServiceWorker string `json:"service_worker"`
		} `json:"background"`
	} `json:"manifest"`
}

func isCdpExtEntry(e chromeExtPrefEntry, cleanExportDir string) bool {
	if strings.EqualFold(strings.TrimSpace(e.Manifest.HomepageURL), cdpExtHomepageURL) {
		return true
	}
	if e.Path != "" {
		cleanPath := filepath.Clean(e.Path)
		if cleanExportDir != "" && samePath(cleanPath, cleanExportDir) {
			return true
		}
		if strings.EqualFold(filepath.Base(cleanPath), "cdp-ext") {
			return true
		}
	}
	if e.Manifest.Background.ServiceWorker == "sw.js" {
		hasDbg, hasGroups := false, false
		for _, p := range e.Manifest.Permissions {
			if p == "debugger" {
				hasDbg = true
			}
			if p == "tabGroups" {
				hasGroups = true
			}
		}
		if hasDbg && hasGroups {
			return true
		}
	}
	return false
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" || runtime.GOOS == "darwin" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func scanProfilePrefs(prefPath string, browser, profile, profileName, cleanExportDir string, seen map[string]bool) []ChromeExtInstall {
	data, err := os.ReadFile(prefPath)
	if err != nil {
		return nil
	}
	var doc struct {
		Extensions struct {
			Settings map[string]chromeExtPrefEntry `json:"settings"`
		} `json:"extensions"`
	}
	if json.Unmarshal(data, &doc) != nil || len(doc.Extensions.Settings) == 0 {
		return nil
	}
	var out []ChromeExtInstall
	for extID, entry := range doc.Extensions.Settings {
		dedupKey := browser + "|" + profile + "|" + extID
		if seen[dedupKey] {
			continue
		}
		if !isCdpExtEntry(entry, cleanExportDir) {
			continue
		}
		seen[dedupKey] = true
		cleanPath := ""
		if entry.Path != "" {
			cleanPath = filepath.Clean(entry.Path)
		}
		out = append(out, ChromeExtInstall{
			Browser:          browser,
			Profile:          profile,
			ProfileName:      profileName,
			ExtensionID:      extID,
			Version:          strings.TrimSpace(entry.Manifest.Version),
			Enabled:          entry.State == 1,
			Path:             cleanPath,
			MatchesExportDir: cleanPath != "" && cleanExportDir != "" && samePath(cleanPath, cleanExportDir),
		})
	}
	return out
}

func detectChromeExtensionsInRoots(roots []browserRoot, exportDir string, connected bool, connectedVer, bundledVer string, exported bool) ChromeExtStatus {
	cleanExportDir := ""
	if exportDir != "" {
		cleanExportDir = filepath.Clean(exportDir)
	}
	res := ChromeExtStatus{
		BrowsersScanned: []string{},
		Installations:   []ChromeExtInstall{},
		ExportDir:       exportDir,
		Exported:        exported,
		BundledVersion:  bundledVer,
		ConnectedVer:    connectedVer,
	}

	seen := map[string]bool{}
	for _, root := range roots {
		entries, err := os.ReadDir(root.Dir)
		if err != nil {
			continue
		}
		res.BrowsersScanned = append(res.BrowsersScanned, root.Name)
		profileNames := readProfileNames(root.Dir)
		var profileDirs []string
		for _, d := range entries {
			if !d.IsDir() {
				continue
			}
			name := d.Name()
			if name == "Default" || strings.HasPrefix(name, "Profile ") {
				profileDirs = append(profileDirs, name)
			}
		}
		sort.Strings(profileDirs)
		for _, pdir := range profileDirs {
			pfull := filepath.Join(root.Dir, pdir)
			// Secure Preferences 优先（现代 Chrome 的扩展主存储），再扫 Preferences 兜底
			for _, fname := range []string{"Secure Preferences", "Preferences"} {
				found := scanProfilePrefs(filepath.Join(pfull, fname), root.Name, pdir, profileNames[pdir], cleanExportDir, seen)
				res.Installations = append(res.Installations, found...)
			}
		}
	}

	sort.Slice(res.Installations, func(i, j int) bool {
		if res.Installations[i].Enabled != res.Installations[j].Enabled {
			return res.Installations[i].Enabled
		}
		if res.Installations[i].Browser != res.Installations[j].Browser {
			return res.Installations[i].Browser < res.Installations[j].Browser
		}
		return res.Installations[i].Profile < res.Installations[j].Profile
	})

	switch {
	case connected && bundledVer != "" && connectedVer != "" && compareSemver(connectedVer, bundledVer) < 0:
		res.State = "outdated"
	case connected:
		res.State = "connected"
	case len(res.Installations) == 0:
		res.State = "not_installed"
	default:
		anyEnabled := false
		for _, inst := range res.Installations {
			if inst.Enabled {
				anyEnabled = true
				break
			}
		}
		if anyEnabled {
			res.State = "installed_offline"
		} else {
			res.State = "disabled"
		}
	}
	return res
}
