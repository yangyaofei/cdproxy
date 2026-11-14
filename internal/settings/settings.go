// Package settings 提供运行时设置：可在 Admin 页在线修改的参数。
//
// 持久化到数据目录的 settings.json（启动加载，修改即存盘并即时生效——
// 被 proxy 在排程回收时现读，无缓存失效问题）。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// knownKeys 合法设置键（Update 对未知键显式报错而非静默忽略——配置写错
// 必须当场暴露，否则调用方以为生效，事后才发现被吞）。
var knownKeys = []string{"alloc_reap_seconds", "disconnect_reap_seconds", "keeper_idle_shutdown_seconds", "popup_policy", "rewrites", "downstream_mode", "ext_token"}

// 各字段的下限（防误配成 0 导致回收风暴）。
var minValues = map[string]float64{
	"disconnect_reap_seconds": 5.0,
	"alloc_reap_seconds":      5.0,
}

// 枚举字段合法值。
var enumValues = map[string][]string{
	"popup_policy":    {"close", "allow"},
	"downstream_mode": {"chrome", "extension"},
}

// RewriteRule 上游命令改写规则。
//
//	Match   方法名（精确匹配；尾部 * 为前缀通配，如 "Network.*"）
//	Action  rewrite = 对 params 做 Set/Remove 后转发；fake = 假成功不转发
//	Set     覆盖 params 顶层键
//	Remove  删除 params 键（支持点路径，如 "bounds.focused"）
//	Group   规则分组标记（focus/base），仅用于预设与展示
//	Note    人类说明（日志 delta 用）
type RewriteRule struct {
	Match  string         `json:"match"`
	Action string         `json:"action"`
	Set    map[string]any `json:"set,omitempty"`
	Remove []string       `json:"remove,omitempty"`
	Group  string         `json:"group,omitempty"`
	Note   string         `json:"note,omitempty"`
}

// DefaultRewrites 默认规则集 = 「不抢焦点」预设 + 基座保护。
func DefaultRewrites() []RewriteRule {
	return []RewriteRule{
		{Match: "Target.createTarget", Action: "rewrite", Set: map[string]any{"background": true},
			Group: "focus", Note: "tab 创建不抢焦点（+background:true）"},
		{Match: "Target.activateTarget", Action: "fake", Group: "focus", Note: "激活拦截（假成功）"},
		{Match: "Page.bringToFront", Action: "fake", Group: "focus", Note: "置前拦截（假成功）"},
		{Match: "Browser.setWindowBounds", Action: "rewrite", Remove: []string{"bounds.focused"},
			Group: "focus", Note: "剥离窗口 focused 字段"},
		{Match: "Emulation.setFocusEmulationEnabled", Action: "rewrite",
			Group: "focus", Note: "焦点仿真透传（页内 hasFocus 失真来源）"},
		{Match: "Browser.close", Action: "fake", Group: "base", Note: "基座保护（全体会话共用基础设施）"},
	}
}

// PassthroughRewrites 「原生透传」预设 = 仅保留基座保护。
func PassthroughRewrites() []RewriteRule {
	return []RewriteRule{DefaultRewrites()[5]}
}

func validRewrites(list []RewriteRule) error {
	for i, r := range list {
		if r.Match == "" {
			return fmt.Errorf("rewrites[%d].match 不能为空", i)
		}
		if r.Action != "rewrite" && r.Action != "fake" {
			return fmt.Errorf("rewrites[%d].action 必须是 rewrite|fake", i)
		}
	}
	return nil
}

// Settings 运行时可调参数。
type Settings struct {
	// DisconnectReapSeconds 上游断连后的回收宽限（容忍 daemon 重启）。
	DisconnectReapSeconds float64 `json:"disconnect_reap_seconds"`
	// AllocReapSeconds 分配后从未连接的回收时限（防泄漏）。
	AllocReapSeconds float64 `json:"alloc_reap_seconds"`
	// PopupPolicy 弹窗策略：close=关闭页面发起的弹窗（openerId 判别，
	// session 无法操作它们且会劫持活动 tab）；allow=放行。
	PopupPolicy string `json:"popup_policy"`
	// KeeperIdleShutdownSeconds 基座空闲自动关闭阈值：连续无会话且无人工
	// 页面达到该秒数后关闭基座 Chrome（登录态在磁盘 profile，零损失），
	// 下次分配时冷启动。0 = 不启用。
	KeeperIdleShutdownSeconds float64 `json:"keeper_idle_shutdown_seconds"`
	// Rewrites 上游命令改写规则（顺序执行；默认=「不抢焦点」+ 基座保护）。
	Rewrites []RewriteRule `json:"rewrites"`
	// DownstreamMode 新会话的默认下游形态：chrome=keeper 管理的基座 Chrome；
	// extension=cdp-ext 扩展反向回连的用户宿主浏览器。运行时可切，仅影响
	// 之后的新分配——存量会话继续绑定原下游直至自然结束（平滑语义）。
	DownstreamMode string `json:"downstream_mode"`
	// ExtToken /ext 反向入口的准入令牌（扩展 options 页配同一值）。
	// 空串 = 不校验（仅回环监听，与控制面同信任级）。
	ExtToken string `json:"ext_token"`
}

// Defaults 返回默认设置。
func Defaults() Settings {
	return Settings{
		DisconnectReapSeconds: 60.0,
		AllocReapSeconds:      300.0,
		PopupPolicy:           "close",
		KeeperIdleShutdownSeconds: 600.0,
		Rewrites:              DefaultRewrites(),
		DownstreamMode:        "chrome",
		ExtToken:              "dev",
	}
}

// Store 设置的加载/校验/保存（并发安全）。
type Store struct {
	mu       sync.Mutex
	path     string
	settings Settings
}

// NewStore 构造并加载（缺失/损坏回落默认值）。
func NewStore(path string) *Store {
	s := &Store{path: path, settings: load(path)}
	return s
}

func load(path string) Settings {
	data, err := os.ReadFile(path)
	if err != nil {
		return Defaults()
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		slog.Warn("settings.json 损坏，回落默认值", "path", path)
		return Defaults()
	}
	out := Defaults()
	if v, ok := raw["disconnect_reap_seconds"].(float64); ok {
		out.DisconnectReapSeconds = v
	}
	if v, ok := raw["alloc_reap_seconds"].(float64); ok {
		out.AllocReapSeconds = v
	}
	if v, ok := raw["popup_policy"].(string); ok && validEnum("popup_policy", v) {
		out.PopupPolicy = v
	}
	if v, ok := raw["keeper_idle_shutdown_seconds"].(float64); ok {
		out.KeeperIdleShutdownSeconds = v
	}
	if v, ok := raw["rewrites"].([]any); ok {
		data, _ := json.Marshal(v)
		var rules []RewriteRule
		if err := json.Unmarshal(data, &rules); err == nil && validRewrites(rules) == nil {
			out.Rewrites = rules
		} else if err == nil {
			slog.Warn("settings.json rewrites 校验失败，回落默认规则", "err", validRewrites(rules))
		}
	}
	if v, ok := raw["downstream_mode"].(string); ok && validEnum("downstream_mode", v) {
		out.DownstreamMode = v
	}
	if v, ok := raw["ext_token"].(string); ok && strings.TrimSpace(v) != "" {
		out.ExtToken = strings.TrimSpace(v)
	}
	return out
}

// Get 返回当前设置快照。
func (s *Store) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

// Update 合并式更新（未知键 422 报错，数值越下限钳制，非法枚举忽略），
// 原子存盘并返回新值。
func (s *Store) Update(patch map[string]any) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if patch == nil {
		return Settings{}, errors.New("settings 必须是 JSON 对象")
	}
	var unknown []string
	for key := range patch {
		if !contains(knownKeys, key) {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		return Settings{}, fmt.Errorf("未知设置键: %s（合法键: %s）",
			strings.Join(unknown, ", "), strings.Join(knownKeys, ", "))
	}
	current := s.settings
	for key, value := range patch {
		if allowed, ok := enumValues[key]; ok {
			if str, isStr := value.(string); isStr && contains(allowed, str) {
				switch key {
				case "popup_policy":
					current.PopupPolicy = str
				case "downstream_mode":
					current.DownstreamMode = str
				}
			}
			continue
		}
		if key == "ext_token" {
			if str, isStr := value.(string); isStr {
				str = strings.TrimSpace(str)
				if str != "" {
					current.ExtToken = str
				}
			}
			continue
		}
		if key == "rewrites" {
			data, err := json.Marshal(value)
			if err != nil {
				return Settings{}, fmt.Errorf("rewrites 序列化失败: %v", err)
			}
			var rules []RewriteRule
			if err := json.Unmarshal(data, &rules); err != nil {
				return Settings{}, fmt.Errorf("rewrites 解析失败: %v", err)
			}
			if err := validRewrites(rules); err != nil {
				return Settings{}, err
			}
			current.Rewrites = rules
			continue
		}
		num, ok := value.(float64)
		if !ok {
			continue
		}
		switch key {
		case "disconnect_reap_seconds":
			current.DisconnectReapSeconds = clampMin(num, minValues[key])
		case "alloc_reap_seconds":
			current.AllocReapSeconds = clampMin(num, minValues[key])
		case "keeper_idle_shutdown_seconds":
			// 0 = 关闭该功能；启用时下限 60s 防抖动
			if num == 0 {
				current.KeeperIdleShutdownSeconds = 0
			} else {
				current.KeeperIdleShutdownSeconds = clampMin(num, 60)
			}
		}
	}
	s.settings = current
	if err := save(s.path, current); err != nil {
		slog.Error("settings 存盘失败", "path", s.path, "err", err)
		return current, err
	}
	slog.Info("设置已更新", "settings", current)
	return current, nil
}

// save 原子写盘（临时文件 + rename）。
func save(path string, s Settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func clampMin(v, min float64) float64 {
	if v < min {
		return min
	}
	return v
}

func validEnum(key, value string) bool {
	return contains(enumValues[key], value)
}

func contains(list []string, v string) bool {
	for _, item := range list {
		if item == v {
			return true
		}
	}
	return false
}
