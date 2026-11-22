// ab_config.go — 跨平台检测、备份与更新全局 ~/.agent-browser/config.json，
// 让外部 agent-browser 以 browser.provider 形态无感接入当前 cdproxy 应用。
//
// 约束：
//   - 配置文件路径固定按跨平台主目录解析（<Home>/.agent-browser/config.json；
//     如存在 AGENT_BROWSER_CONFIG 则仅只读尊重该路径，绝不写环境变量）。
//   - 每次写入前必先在同目录留存原样备份（config.json.bak-YYYYMMDD-HHMMSS），
//     保留用户原有其他字段与第三方插件，采用临时文件 + 原子重命名落盘。
package control

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// AgentBrowserIntegration 检测结果（供管理台展示当前接线状态与备份列表）。
type AgentBrowserIntegration struct {
	ConfigPath      string   `json:"config_path"`
	Exists          bool     `json:"exists"`
	// Status 取值：configured | outdated | other_provider | not_configured | not_found | invalid_json
	Status          string   `json:"status"`
	CurrentProvider string   `json:"current_provider,omitempty"`
	CurrentCommand  string   `json:"current_command,omitempty"`
	CurrentArgs     []string `json:"current_args,omitempty"`
	TargetCommand   string   `json:"target_command"`
	TargetArgs      []string `json:"target_args"`
	Backups         []string `json:"backups"`
	Error           string   `json:"error,omitempty"`
}

func defaultAgentBrowserConfigPath() string {
	if env := strings.TrimSpace(os.Getenv("AGENT_BROWSER_CONFIG")); env != "" {
		return env
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".agent-browser", "config.json")
}

func currentProviderExecutable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil && resolved != "" {
		exe = resolved
	}
	return filepath.Clean(exe)
}

func listConfigBackups(cfgPath string) []string {
	dir := filepath.Dir(cfgPath)
	prefix := filepath.Base(cfgPath) + ".bak-"
	entries, err := os.ReadDir(dir)
	if err != nil {
		return []string{}
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), prefix) {
			out = append(out, e.Name())
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(out)))
	return out
}

func stringSliceFromAny(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func sameArgs(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

func inspectAgentBrowserConfig(cfgPath, targetExe string) AgentBrowserIntegration {
	res := AgentBrowserIntegration{
		ConfigPath:    cfgPath,
		TargetCommand: targetExe,
		TargetArgs:    []string{"plugin"},
		Backups:       []string{},
	}
	if cfgPath == "" {
		res.Status = "not_found"
		return res
	}
	res.Backups = listConfigBackups(cfgPath)
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			res.Status = "not_found"
			return res
		}
		res.Status = "invalid_json"
		res.Error = err.Error()
		return res
	}
	res.Exists = true

	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		res.Status = "invalid_json"
		if err != nil {
			res.Error = err.Error()
		} else {
			res.Error = "config.json 顶层必须是 JSON 对象"
		}
		return res
	}

	curProv, _ := doc["provider"].(string)
	curProv = strings.TrimSpace(curProv)
	res.CurrentProvider = curProv

	pluginsRaw, _ := doc["plugins"].([]any)
	var matchedPlugin map[string]any
	for _, item := range pluginsRaw {
		pm, ok := item.(map[string]any)
		if !ok {
			continue
		}
		name, _ := pm["name"].(string)
		if name == "cdproxy" {
			matchedPlugin = pm
			break
		}
	}

	if matchedPlugin != nil {
		res.CurrentCommand, _ = matchedPlugin["command"].(string)
		res.CurrentArgs = stringSliceFromAny(matchedPlugin["args"])
		caps := stringSliceFromAny(matchedPlugin["capabilities"])
		cmdMatches := targetExe != "" && res.CurrentCommand != "" && samePath(res.CurrentCommand, targetExe)
		argsMatch := sameArgs(res.CurrentArgs, res.TargetArgs)
		capMatch := hasCapability(caps, "browser.provider")
		if curProv == "cdproxy" && cmdMatches && argsMatch && capMatch {
			res.Status = "configured"
			return res
		}
		if curProv != "" && curProv != "cdproxy" {
			res.Status = "other_provider"
			return res
		}
		res.Status = "outdated"
		return res
	}

	if curProv != "" {
		if curProv == "cdproxy" {
			res.Status = "outdated"
		} else {
			res.Status = "other_provider"
		}
		return res
	}

	res.Status = "not_configured"
	return res
}

func backupConfigFile(cfgPath string, now time.Time) (string, error) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	base := cfgPath + ".bak-" + now.Format("20060102-150405")
	bakPath := base
	for i := 1; i < 100; i++ {
		if _, err := os.Stat(bakPath); os.IsNotExist(err) {
			break
		}
		bakPath = fmt.Sprintf("%s-%d", base, i)
	}
	if err := os.WriteFile(bakPath, raw, 0o644); err != nil {
		return "", err
	}
	return bakPath, nil
}

func writeJSONAtomic(path string, doc map[string]any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func installAgentBrowserConfig(cfgPath, targetExe string, now time.Time) (AgentBrowserIntegration, string, error) {
	if cfgPath == "" {
		return AgentBrowserIntegration{}, "", fmt.Errorf("无法确定 agent-browser 配置文件路径")
	}
	if strings.TrimSpace(targetExe) == "" {
		return AgentBrowserIntegration{}, "", fmt.Errorf("无法定位当前 cdproxy 可执行文件路径")
	}

	doc := map[string]any{}
	var backupPath string
	if raw, err := os.ReadFile(cfgPath); err == nil {
		if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
			return AgentBrowserIntegration{}, "", fmt.Errorf("现有 %s 不是合法 JSON，已中止写入以防数据丢失: %v", cfgPath, err)
		}
		backupPath, err = backupConfigFile(cfgPath, now)
		if err != nil {
			return AgentBrowserIntegration{}, "", fmt.Errorf("备份原配置失败: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return AgentBrowserIntegration{}, "", fmt.Errorf("读取配置失败: %w", err)
	}

	// 新建配置时补默认 headed=true，保留已有用户配置不动
	if _, exists := doc["headed"]; !exists {
		doc["headed"] = true
	}
	doc["provider"] = "cdproxy"

	newEntry := map[string]any{
		"name":         "cdproxy",
		"command":      targetExe,
		"args":         []string{"plugin"},
		"capabilities": []string{"browser.provider"},
	}

	var nextPlugins []any
	inserted := false
	if existing, ok := doc["plugins"].([]any); ok {
		for _, item := range existing {
			pm, ok := item.(map[string]any)
			if !ok {
				nextPlugins = append(nextPlugins, item)
				continue
			}
			name, _ := pm["name"].(string)
			if name == "cdproxy" {
				if !inserted {
					nextPlugins = append(nextPlugins, newEntry)
					inserted = true
				}
				continue
			}
			// 原样保留用户已有的其他插件条目（不静默删除任何第三方或旧插件）
			nextPlugins = append(nextPlugins, item)
		}
	}
	if !inserted {
		nextPlugins = append(nextPlugins, newEntry)
	}
	doc["plugins"] = nextPlugins

	if err := writeJSONAtomic(cfgPath, doc); err != nil {
		return AgentBrowserIntegration{}, backupPath, fmt.Errorf("写入配置失败: %w", err)
	}
	return inspectAgentBrowserConfig(cfgPath, targetExe), backupPath, nil
}

func uninstallAgentBrowserConfig(cfgPath, targetExe string, now time.Time) (AgentBrowserIntegration, string, error) {
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return inspectAgentBrowserConfig(cfgPath, targetExe), "", nil
		}
		return AgentBrowserIntegration{}, "", err
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		return AgentBrowserIntegration{}, "", fmt.Errorf("现有配置不是合法 JSON: %v", err)
	}
	backupPath, err := backupConfigFile(cfgPath, now)
	if err != nil {
		return AgentBrowserIntegration{}, "", fmt.Errorf("备份原配置失败: %w", err)
	}

	if prov, _ := doc["provider"].(string); prov == "cdproxy" {
		delete(doc, "provider")
	}
	if existing, ok := doc["plugins"].([]any); ok {
		var kept []any
		for _, item := range existing {
			pm, ok := item.(map[string]any)
			if ok {
				if name, _ := pm["name"].(string); name == "cdproxy" {
					continue
				}
			}
			kept = append(kept, item)
		}
		if len(kept) == 0 {
			delete(doc, "plugins")
		} else {
			doc["plugins"] = kept
		}
	}
	if err := writeJSONAtomic(cfgPath, doc); err != nil {
		return AgentBrowserIntegration{}, backupPath, err
	}
	return inspectAgentBrowserConfig(cfgPath, targetExe), backupPath, nil
}

func restoreAgentBrowserConfig(cfgPath, targetExe, backupName string) (AgentBrowserIntegration, error) {
	prefix := filepath.Base(cfgPath) + ".bak-"
	if backupName == "" || filepath.Base(backupName) != backupName || !strings.HasPrefix(backupName, prefix) {
		return AgentBrowserIntegration{}, fmt.Errorf("无效的备份文件名: %q", backupName)
	}
	bakPath := filepath.Join(filepath.Dir(cfgPath), backupName)
	data, err := os.ReadFile(bakPath)
	if err != nil {
		return AgentBrowserIntegration{}, fmt.Errorf("读取备份失败: %w", err)
	}
	tmp := cfgPath + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return AgentBrowserIntegration{}, err
	}
	if err := os.Rename(tmp, cfgPath); err != nil {
		_ = os.Remove(tmp)
		return AgentBrowserIntegration{}, err
	}
	return inspectAgentBrowserConfig(cfgPath, targetExe), nil
}

func (c *Control) agentBrowserIntegration() AgentBrowserIntegration {
	_ = runtime.GOOS
	return inspectAgentBrowserConfig(defaultAgentBrowserConfigPath(), currentProviderExecutable())
}
