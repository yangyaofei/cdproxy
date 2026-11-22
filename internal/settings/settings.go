// Package settings 提供运行时设置：可在 Admin 页在线修改的参数。
//
// 持久化到数据目录的 settings.json（启动加载，修改即存盘并即时生效——
// 被 proxy 在排程回收时现读，无缓存失效问题）。
package settings

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// knownKeys 合法设置键（Update 对未知键显式报错而非静默忽略——配置写错
// 必须当场暴露，否则调用方以为生效，事后才发现被吞）。
var knownKeys = []string{"alloc_reap_seconds", "disconnect_reap_seconds", "keeper_idle_shutdown_seconds", "rewrites", "downstream_mode", "ext_token", "sources", "routing", "endpoints", "control_port", "ws_port", "ports_enabled", "admin_web_enabled", "agent_browser_binary"}

// 各字段的下限（防误配成 0 导致回收风暴）。
var minValues = map[string]float64{
	"disconnect_reap_seconds": 5.0,
	"alloc_reap_seconds":      5.0,
}

// 枚举字段合法值。
var enumValues = map[string][]string{
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
	// KeeperIdleShutdownSeconds 基座空闲自动关闭阈值：连续无会话且无人工
	// 页面达到该秒数后关闭基座 Chrome（登录态在磁盘 profile，零损失），
	// 下次分配时冷启动。0 = 不启用。
	KeeperIdleShutdownSeconds float64 `json:"keeper_idle_shutdown_seconds"`
	// Rewrites 上游命令改写规则（顺序执行；默认=「不抢焦点」+ 基座保护）。
	Rewrites []RewriteRule `json:"rewrites"`
	// Sources 双源配置（并存、独立开关与令牌；取代旧 downstream_mode/ext_token）。
	Sources Sources `json:"sources"`
	// Routing 会话 → 源 路由（显式指定 > 前缀规则 > 默认源）。
	Routing Routing `json:"routing"`
	// Endpoints 常驻 CDP 接入点表（连接即会话；内置 standalone/extension
	// 两条，可增删自定义）。nil（配置缺失）= 首启自动生成内置两条。
	Endpoints []Endpoint `json:"endpoints"`
	// ControlPort 管理面（REST/Admin 页）监听端口。变更经进程内重绑生效
	//（监听重建，无需换进程）；会话/令牌状态全程保留。
	ControlPort int `json:"control_port"`
	// WsPort 上游 CDP WS（/cdp/<token> 与 /ext 反向入口）监听端口。
	// 变更语义同 ControlPort：重绑监听，存量上游连接断开后由客户端
	//（daemon/扩展）自动重连。
	WsPort int `json:"ws_port"`
	// PortsEnabled 外部端口总开关。false = 控制面与 WS 监听全部关闭
	//（App 内嵌模式：仅 Wails 绑定可用，外部进程一律连不上）。
	// 关闭时存量上游连接断开，回收宽限后清理；重新打开即恢复监听。
	PortsEnabled bool `json:"ports_enabled"`
	// AdminWebEnabled 是否开放浏览器版管理页（GET / 与 /static/*）。
	// 桌面 App 的资产由 Wails 内嵌服务，不经此开关；REST API 也不受影响。
	// 默认关：管理走 App（事件直达形态），网页仅按需临时打开。
	AdminWebEnabled bool `json:"admin_web_enabled"`
	// AgentBrowserBinary agent-browser 二进制覆盖路径（空 = 自动解析：
	// App 内嵌 bundled → PATH）。桌面 App 的内嵌集成用——CLI daemon
	// 忽略此键（自己就在 PATH 世界里）。
	AgentBrowserBinary string `json:"agent_browser_binary"`
}

// 源名常量（对外 JSON/状态面统一用这两个词；内部 dsKind 同值）。
const (
	SourceStandalone = "standalone"
	SourceExtension  = "extension"
)

// validSource 源名合法性。
func validSource(s string) bool { return s == SourceStandalone || s == SourceExtension }

// SourceRoute 前缀路由规则：会话名命中 prefix 即路由到 source（有序，先中先用）。
type SourceRoute struct {
	Prefix string `json:"prefix"`
	Source string `json:"source"` // standalone | extension
}

// DefaultGroupPrefix extension 源 Chrome 原生标签页分组默认前缀。
const DefaultGroupPrefix = "cdproxy:"

// NormalizeGroupPrefix 规范化标签页分组前缀（去首尾空白；空值回落默认 cdproxy:）。
func NormalizeGroupPrefix(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return DefaultGroupPrefix
	}
	return s
}

// FormatGroupPrefix 生成实际拼在 Chrome 标签组标题上的前缀（带单个分隔空格）。
func FormatGroupPrefix(raw string) string {
	return NormalizeGroupPrefix(raw) + " "
}

// Sources 双源配置（并存，按会话路由）。
type Sources struct {
	// StandaloneEnabled standalone 源（agent-browser 管理的基座 Chrome）开关。
	StandaloneEnabled bool `json:"standalone_enabled"`
	// ExtensionEnabled extension 源（用户宿主 Chrome + cdp-ext 回连）开关。
	ExtensionEnabled bool `json:"extension_enabled"`
	// ExtensionToken /ext 反向入口的准入令牌（扩展弹窗/选项页配同一值）。
	// 首次启动自动生成强随机（旧默认 dev 已废除——自动换新并记日志）。
	ExtensionToken string `json:"token"`
	// GroupPrefix extension 源的 Chrome 标签页分组前缀（默认 cdproxy:，展示为 "cdproxy: <会话名>"）。
	GroupPrefix string `json:"group_prefix"`
	// AllocToken POST /sessions 分配路径的准入令牌，
	// 客户端以 Authorization: Bearer <token> 携带。首次启动自动生成。
	AllocToken string `json:"alloc_token"`
}

// Endpoint CDP 访问凭证与接入点：
//
// 内置三条常驻入口：
//   - default    (Source="")          跟随全局 routing.default_source（可热切）
//   - standalone (Source="standalone") 仅允许独立托管 Chrome
//   - extension  (Source="extension")  仅允许日常 Chrome（Cdproxy Connector）
//
// 三条内置入口默认 Session=""，表示每条匿名 WS 连接自动分配独立会话（1 WS = 1 Session），
// 也可在 URL 中显式带 /session/<id> 绑定/续接指定会话。
// 自定义入口（非内置 path）默认钉死为固定会话/分组令牌（Session 空时回落为 Path），
// 实现最小权限隔离——只能访问该指定源与会话。
type Endpoint struct {
	// Path 入口标识（内置 default/standalone/extension，或自定义 [a-z0-9-]）。
	Path string `json:"path"`
	// Source 目标源（"" = 跟随默认源 | standalone | extension）。
	Source string `json:"source"`
	// Token 准入令牌（首建自动生成；PUT 更新时忽略此字段，重置走专用动作）。
	Token string `json:"token"`
	// Session 固定会话名（内置入口空 = 动态 1 WS = 1 Session；自定义入口空 = Path）。
	Session string `json:"session"`
}

// IsBuiltin 是否为三条内置基础入口之一（default / standalone / extension）。
func (ep Endpoint) IsBuiltin() bool {
	return ep.Path == "default" || ep.Path == SourceStandalone || ep.Path == SourceExtension
}

// EffectiveSession 返回令牌绑定的固定会话名（空串 = 不钉死会话，按连接动态分配或接受 URL /session/<id>）。
func (ep Endpoint) EffectiveSession() string {
	s := strings.TrimSpace(ep.Session)
	if ep.IsBuiltin() {
		return s
	}
	if s != "" {
		return s
	}
	return ep.Path
}

// Routing 会话 → 源 的路由策略。
type Routing struct {
	// DefaultSource 无规则命中时的默认源。
	DefaultSource string `json:"default_source"` // standalone | extension
	// Rules 前缀规则（有序，先中先用；都不中用 DefaultSource）。
	Rules []SourceRoute `json:"rules"`
}

func validRoutes(rules []SourceRoute) error {
	for i, r := range rules {
		if strings.TrimSpace(r.Prefix) == "" {
			return fmt.Errorf("routing.rules[%d].prefix 不能为空", i)
		}
		if !validSource(r.Source) {
			return fmt.Errorf("routing.rules[%d].source 必须是 standalone|extension", i)
		}
	}
	return nil
}

// Defaults 返回默认设置。
func Defaults() Settings {
	return Settings{
		DisconnectReapSeconds:     60.0,
		AllocReapSeconds:          300.0,
		KeeperIdleShutdownSeconds: 600.0,
		Rewrites:                  DefaultRewrites(),
		Sources: Sources{
			StandaloneEnabled: true,
			ExtensionEnabled:  true,
			GroupPrefix:       DefaultGroupPrefix,
		},
		Routing: Routing{
			DefaultSource: SourceStandalone,
			Rules:         []SourceRoute{{Prefix: "ext-", Source: SourceExtension}},
		},
		ControlPort:  9224,
		WsPort:       9225,
		PortsEnabled: true,
	}
}

// newSecretToken 强随机准入令牌（24 hex 字符；crypto/rand）。
func newSecretToken() string {
	b := make([]byte, 12)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand 不可用: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// endpointPathRE 接入点路径段：小写字母/数字/连字符，2-32 位。
var endpointPathRE = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,31}$`)

// wsReservedPaths WS mux 上的保留路径（字面路由优先，接入点不可占用）。
var wsReservedPaths = map[string]bool{
	"cdp":      true,
	"ext":      true,
	"session":  true,
	"json":     true,
	"devtools": true,
}

// reservedSessionNames 会话名不可使用的路由关键字（防与源/控制路径混淆）。
var reservedSessionNames = map[string]bool{
	"standalone": true,
	"extension":  true,
	"default":    true,
	"session":    true,
	"json":       true,
	"cdp":        true,
	"ext":        true,
	"devtools":   true,
}

// ValidSessionName 校验会话名合法性（供 settings 与 proxy 路由解析共用）。
func ValidSessionName(name string) error {
	s := strings.TrimSpace(name)
	if s == "" {
		return errors.New("session 不能为空")
	}
	if len([]rune(s)) > 64 {
		return fmt.Errorf("session 过长（≤64 字符）: %q", s)
	}
	if strings.ContainsAny(s, "/\\?#") {
		return fmt.Errorf("session 不能包含路径或查询符号（/ \\ ? #）: %q", s)
	}
	if reservedSessionNames[strings.ToLower(s)] {
		return fmt.Errorf("session 不能使用保留关键字: %q", s)
	}
	return nil
}

// validEndpoints 接入点表校验。
func validEndpoints(eps []Endpoint) error {
	seen := map[string]bool{}
	for i, ep := range eps {
		if !endpointPathRE.MatchString(ep.Path) {
			return fmt.Errorf("endpoints[%d].path 须为 2-32 位小写字母/数字/连字符: %q", i, ep.Path)
		}
		if wsReservedPaths[ep.Path] {
			return fmt.Errorf("endpoints[%d].path %q 是保留路径", i, ep.Path)
		}
		if seen[ep.Path] {
			return fmt.Errorf("endpoints[%d].path %q 重复", i, ep.Path)
		}
		seen[ep.Path] = true
		if ep.Source != "" && !validSource(ep.Source) {
			return fmt.Errorf("endpoints[%d].source 必须是空（跟随默认）或 standalone|extension", i)
		}
		switch ep.Path {
		case "default":
			if ep.Source != "" {
				return fmt.Errorf("内置 default 接入点的 source 必须为空（跟随全局默认源）")
			}
		case SourceStandalone:
			if ep.Source != SourceStandalone {
				return fmt.Errorf("内置 standalone 接入点的 source 必须为 standalone")
			}
		case SourceExtension:
			if ep.Source != SourceExtension {
				return fmt.Errorf("内置 extension 接入点的 source 必须为 extension")
			}
		}
		s := strings.TrimSpace(ep.Session)
		if s != "" {
			if err := ValidSessionName(s); err != nil {
				return fmt.Errorf("endpoints[%d].%v", i, err)
			}
		} else if !ep.IsBuiltin() {
			if err := ValidSessionName(ep.Path); err != nil {
				return fmt.Errorf("endpoints[%d].%v", i, err)
			}
		}
	}
	return nil
}

// ensureSecrets 补齐/强化凭证（首启、旧版升级迁移与弱默认废除）：返回是否发生变更
// （调用方负责持久化）。规则：ext/alloc 令牌空或 "dev" → 生成强随机；
// endpoints 缺失 → 生成内置三条（default/standalone/extension）；
// 已有旧版 standalone/extension 但缺 default → 自动前置补齐 default（保留旧令牌不动）；
// 单条 token 空 → 生成。
func ensureSecrets(s *Settings, warns *[]string) bool {
	changed := false
	weak := func(t string) bool { return strings.TrimSpace(t) == "" || t == "dev" }
	if weak(s.Sources.ExtensionToken) {
		if s.Sources.ExtensionToken == "dev" {
			*warns = append(*warns, "扩展令牌为旧默认值 dev，已自动换强随机——请到「源」页复制新令牌并更新 cdp-ext options 页")
		}
		s.Sources.ExtensionToken = newSecretToken()
		changed = true
	}
	if weak(s.Sources.AllocToken) {
		if s.Sources.AllocToken == "dev" {
			*warns = append(*warns, "分配令牌为旧默认值 dev，已自动换强随机——请到「源」页复制并更新 agent-browser plugin 配置")
		}
		s.Sources.AllocToken = newSecretToken()
		changed = true
	}
	if s.Endpoints == nil {
		s.Endpoints = []Endpoint{
			{Path: "default", Source: ""},
			{Path: SourceStandalone, Source: SourceStandalone},
			{Path: SourceExtension, Source: SourceExtension},
		}
		changed = true
	} else if len(s.Endpoints) > 0 {
		hasDefault := false
		hasLegacyBuiltin := false
		for _, ep := range s.Endpoints {
			if ep.Path == "default" {
				hasDefault = true
			}
			if ep.Path == SourceStandalone || ep.Path == SourceExtension {
				hasLegacyBuiltin = true
			}
		}
		if !hasDefault && hasLegacyBuiltin {
			s.Endpoints = append([]Endpoint{{Path: "default", Source: ""}}, s.Endpoints...)
			changed = true
		}
	}
	for i := range s.Endpoints {
		if strings.TrimSpace(s.Endpoints[i].Token) == "" {
			s.Endpoints[i].Token = newSecretToken()
			changed = true
		}
	}
	return changed
}

// validPort 端口合法区间（1-65535）。
func validPort(p int) bool { return p >= 1 && p <= 65535 }

// Store 设置的加载/校验/保存（并发安全）。
type Store struct {
	mu       sync.Mutex
	path     string
	settings Settings
}

// NewStore 构造并加载（缺失/损坏回落默认值）。
func NewStore(path string) *Store {
	s := &Store{path: path, settings: load(path)}
	// 凭证补齐/强化对全新安装同样生效（无文件路径 Defaults 的令牌为空）；
	// 变更即回盘，保证 UI/测试读到的是持久值。
	var warns []string
	if ensureSecrets(&s.settings, &warns) {
		for _, w := range warns {
			slog.Warn(w)
		}
		if err := save(path, s.settings); err != nil {
			slog.Error("settings 初始存盘失败", "path", path, "err", err)
		}
	} else {
		// 收紧既有配置文件权限为仅属主可读写（含全部访问令牌）
		_ = os.Chmod(path, 0o600)
	}
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
	// 新结构：sources / routing（整对象替换式解析，字段级校验）
	if v, ok := raw["sources"]; ok {
		if src, ok := v.(map[string]any); ok {
			if b, ok := src["standalone_enabled"].(bool); ok {
				out.Sources.StandaloneEnabled = b
			}
			if b, ok := src["extension_enabled"].(bool); ok {
				out.Sources.ExtensionEnabled = b
			}
			if t, ok := src["token"].(string); ok && strings.TrimSpace(t) != "" {
				out.Sources.ExtensionToken = strings.TrimSpace(t)
			}
			if at, ok := src["alloc_token"].(string); ok && strings.TrimSpace(at) != "" {
				out.Sources.AllocToken = strings.TrimSpace(at)
			}
			if gp, ok := src["group_prefix"].(string); ok && strings.TrimSpace(gp) != "" {
				if trimmed := strings.TrimSpace(gp); len([]rune(trimmed)) <= 32 {
					out.Sources.GroupPrefix = trimmed
				}
			}
		}
	}
	if v, ok := raw["routing"]; ok {
		if rt, ok := v.(map[string]any); ok {
			if d, ok := rt["default_source"].(string); ok && validSource(d) {
				out.Routing.DefaultSource = d
			}
			if rs, ok := rt["rules"].([]any); ok {
				data, _ := json.Marshal(rs)
				var rules []SourceRoute
				if err := json.Unmarshal(data, &rules); err == nil && validRoutes(rules) == nil {
					out.Routing.Rules = rules
				} else {
					slog.Warn("settings.json routing.rules 校验失败，回落默认规则", "err", err)
				}
			}
		}
	}
	// 旧键迁移（下游模式/扩展令牌 → 双源结构；旧值仅在缺省时兜底）
	if v, ok := raw["downstream_mode"].(string); ok {
		if _, exists := raw["routing"]; !exists {
			switch v {
			case "chrome":
				out.Routing.DefaultSource = SourceStandalone
			case "extension":
				out.Routing.DefaultSource = SourceExtension
			}
		}
	}
	if v, ok := raw["ext_token"].(string); ok && strings.TrimSpace(v) != "" {
		if _, exists := raw["sources"]; !exists {
			out.Sources.ExtensionToken = strings.TrimSpace(v)
		}
	}
	if v, ok := raw["control_port"].(float64); ok && validPort(int(v)) {
		out.ControlPort = int(v)
	}
	if v, ok := raw["ws_port"].(float64); ok && validPort(int(v)) {
		out.WsPort = int(v)
	}
	if v, ok := raw["admin_web_enabled"].(bool); ok {
		out.AdminWebEnabled = v
	}
	if v, ok := raw["ports_enabled"].(bool); ok {
		out.PortsEnabled = v
	}
	if v, ok := raw["agent_browser_binary"].(string); ok {
		out.AgentBrowserBinary = strings.TrimSpace(v)
	}
	// 端口互斥校验：冲突回落默认并警告（load 不失败——损坏文件已有回落语义）
	if out.ControlPort == out.WsPort {
		slog.Warn("settings.json 端口冲突，回落默认端口", "port", out.ControlPort)
		out.ControlPort, out.WsPort = 9224, 9225
	}
	// endpoints 表（缺失键 = 首启 → nil 走 ensureSecrets 生成内置两条；
	// 显式空数组 = 用户删光，尊重）
	if v, ok := raw["endpoints"].([]any); ok {
		data, _ := json.Marshal(v)
		var eps []Endpoint
		if err := json.Unmarshal(data, &eps); err == nil && validEndpoints(eps) == nil {
			out.Endpoints = eps
		} else {
			slog.Warn("settings.json endpoints 校验失败，回落内置两条", "err", err)
		}
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
		// 旧键迁移：downstream_mode/ext_token → 双源结构（向后兼容旧脚本/UI）
		if key == "downstream_mode" {
			if str, isStr := value.(string); isStr {
				switch str {
				case "chrome":
					current.Routing.DefaultSource = SourceStandalone
				case "extension":
					current.Routing.DefaultSource = SourceExtension
				}
			}
			continue
		}
		if key == "ext_token" {
			if str, isStr := value.(string); isStr {
				str = strings.TrimSpace(str)
				if str != "" {
					current.Sources.ExtensionToken = str
				}
			}
			continue
		}
		if key == "sources" {
			data, err := json.Marshal(value)
			if err != nil {
				return Settings{}, fmt.Errorf("sources 序列化失败: %v", err)
			}
			// 子对象合并语义（patch）：缺省字段保持现值——与 PUT /settings
			// 整体 patch 语义一致；只传 {token} 不会误关两个源。
			src := current.Sources
			if err := json.Unmarshal(data, &src); err != nil {
				return Settings{}, fmt.Errorf("sources 解析失败: %v", err)
			}
			if strings.TrimSpace(src.ExtensionToken) == "" {
				src.ExtensionToken = current.Sources.ExtensionToken // 空串=不修改
			} else {
				src.ExtensionToken = strings.TrimSpace(src.ExtensionToken)
			}
			if strings.TrimSpace(src.AllocToken) == "" {
				src.AllocToken = current.Sources.AllocToken // 空串=不修改
			} else {
				src.AllocToken = strings.TrimSpace(src.AllocToken)
			}
			src.GroupPrefix = NormalizeGroupPrefix(src.GroupPrefix)
			if len([]rune(src.GroupPrefix)) > 32 {
				return Settings{}, errors.New("sources.group_prefix 过长（≤32 字符）")
			}
			if !src.StandaloneEnabled && !src.ExtensionEnabled {
				return Settings{}, errors.New("两个源不能同时禁用（至少保留一个可用源）")
			}
			current.Sources = src
			continue
		}
		if key == "routing" {
			data, err := json.Marshal(value)
			if err != nil {
				return Settings{}, fmt.Errorf("routing 序列化失败: %v", err)
			}
			// 子对象合并语义（patch）：只传 default_source 不清空 rules
			rt := current.Routing
			if err := json.Unmarshal(data, &rt); err != nil {
				return Settings{}, fmt.Errorf("routing 解析失败: %v", err)
			}
			if !validSource(rt.DefaultSource) {
				return Settings{}, errors.New("routing.default_source 必须是 standalone|extension")
			}
			if err := validRoutes(rt.Rules); err != nil {
				return Settings{}, err
			}
			current.Routing = rt
			continue
		}
		if key == "endpoints" {
			data, err := json.Marshal(value)
			if err != nil {
				return Settings{}, fmt.Errorf("endpoints 序列化失败: %v", err)
			}
			var eps []Endpoint
			if err := json.Unmarshal(data, &eps); err != nil {
				return Settings{}, fmt.Errorf("endpoints 解析失败: %v", err)
			}
			// token 不走 PUT（UI 不回显完整值）：按 path 匹配保留现有令牌，
			// 新 path 生成新令牌——防止表单提交时误清/误换凭证。
			old := map[string]string{}
			for _, ep := range current.Endpoints {
				old[ep.Path] = ep.Token
			}
			for i := range eps {
				eps[i].Session = strings.TrimSpace(eps[i].Session)
				eps[i].Token = ""
				if t, ok := old[eps[i].Path]; ok && t != "" {
					eps[i].Token = t
				} else {
					eps[i].Token = newSecretToken()
				}
			}
			if err := validEndpoints(eps); err != nil {
				return Settings{}, err
			}
			current.Endpoints = eps
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
		if key == "ports_enabled" {
			if b, isBool := value.(bool); isBool {
				current.PortsEnabled = b
			}
			continue
		}
		if key == "admin_web_enabled" {
			if b, isBool := value.(bool); isBool {
				current.AdminWebEnabled = b
			}
			continue
		}
		if key == "agent_browser_binary" {
			if str, isStr := value.(string); isStr {
				current.AgentBrowserBinary = strings.TrimSpace(str)
			}
			continue
		}
		if key == "control_port" || key == "ws_port" {
			// REST 路径 decode 出 float64；Go 原生调用（App 绑定层）传 int
			port := 0
			switch v := value.(type) {
			case float64:
				port = int(v)
			case int:
				port = v
			case int64:
				port = int(v)
			}
			if port == 0 || !validPort(port) {
				return Settings{}, fmt.Errorf("%s 必须是 1-65535 的整数", key)
			}
			if key == "control_port" {
				current.ControlPort = port
			} else {
				current.WsPort = port
			}
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
	// 合并后互斥校验：两端口不得同值（拒绝整次 patch，防把生效配置改坏）
	if current.ControlPort == current.WsPort {
		return Settings{}, fmt.Errorf("control_port 与 ws_port 不能相同（均为 %d）", current.ControlPort)
	}
	s.settings = current
	if err := save(s.path, current); err != nil {
		slog.Error("settings 存盘失败", "path", s.path, "err", err)
		return current, err
	}
	slog.Info("设置已更新",
		"control_port", current.ControlPort,
		"ws_port", current.WsPort,
		"ports_enabled", current.PortsEnabled,
		"admin_web_enabled", current.AdminWebEnabled,
		"default_source", current.Routing.DefaultSource,
		"endpoints", len(current.Endpoints),
	)
	return current, nil
}

// save 原子写盘（临时文件 + 0600 仅属主可读 + rename）。
func save(path string, s Settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, path)
}

// ResetExtensionToken 重置 /ext 准入令牌（旧令牌立即失效；在场扩展连接
// 不断，但重连需新令牌——扩展 options 页同步更新）。
func (s *Store) ResetExtensionToken() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings.Sources.ExtensionToken = newSecretToken()
	if err := save(s.path, s.settings); err != nil {
		slog.Error("settings 存盘失败", "path", s.path, "err", err)
	}
	slog.Info("已重置扩展令牌（旧令牌吊销）")
	return s.settings
}

// ResetAllocToken 重置 POST /sessions 准入令牌（旧令牌立即失效）。
func (s *Store) ResetAllocToken() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settings.Sources.AllocToken = newSecretToken()
	if err := save(s.path, s.settings); err != nil {
		slog.Error("settings 存盘失败", "path", s.path, "err", err)
	}
	slog.Info("已重置分配令牌（旧令牌吊销）")
	return s.settings
}

// ResetEndpointToken 重置接入点令牌（旧令牌立即失效）。写时复制：
// Get/Update 返回的快照与内部切片共享底层数组，原地改写会让读者看到
// 变化（数据竞争）——重建新切片替换。
func (s *Store) ResetEndpointToken(path string) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.settings.Endpoints {
		if s.settings.Endpoints[i].Path == path {
			next := make([]Endpoint, len(s.settings.Endpoints))
			copy(next, s.settings.Endpoints)
			next[i].Token = newSecretToken()
			s.settings.Endpoints = next
			if err := save(s.path, s.settings); err != nil {
				return Settings{}, err
			}
			slog.Info("已重置接入点令牌（旧令牌吊销）", "path", path)
			return s.settings, nil
		}
	}
	return Settings{}, fmt.Errorf("接入点不存在: %s", path)
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
