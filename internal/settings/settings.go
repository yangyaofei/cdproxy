// Package settings 提供运行时设置：可在 Admin 页在线修改的参数。
//
// 持久化到数据目录的 settings.json（启动加载，修改即存盘并即时生效——
// 被 proxy 在排程回收时现读，无缓存失效问题）。
package settings

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
)

// 各字段的下限（防误配成 0 导致回收风暴）。
var minValues = map[string]float64{
	"disconnect_reap_seconds": 5.0,
	"alloc_reap_seconds":      5.0,
}

// 枚举字段合法值。
var enumValues = map[string][]string{
	"focus_mode": {"background", "steal"},
}

// Settings 运行时可调参数。
type Settings struct {
	// DisconnectReapSeconds 上游断连后的回收宽限（容忍 daemon 重启）。
	DisconnectReapSeconds float64 `json:"disconnect_reap_seconds"`
	// AllocReapSeconds 分配后从未连接的回收时限（防泄漏）。
	AllocReapSeconds float64 `json:"alloc_reap_seconds"`
	// FocusMode 焦点策略：background=不抢焦点；steal=原生行为。
	FocusMode string `json:"focus_mode"`
}

// Defaults 返回默认设置。
func Defaults() Settings {
	return Settings{
		DisconnectReapSeconds: 60.0,
		AllocReapSeconds:      300.0,
		FocusMode:             "background",
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
	if v, ok := raw["focus_mode"].(string); ok && validEnum("focus_mode", v) {
		out.FocusMode = v
	}
	return out
}

// Get 返回当前设置快照。
func (s *Store) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.settings
}

// Update 合并式更新（未知字段忽略，数值越下限钳制，非法枚举忽略），
// 原子存盘并返回新值。
func (s *Store) Update(patch map[string]any) (Settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if patch == nil {
		return Settings{}, errors.New("settings 必须是 JSON 对象")
	}
	current := s.settings
	for key, value := range patch {
		if allowed, ok := enumValues[key]; ok {
			if str, isStr := value.(string); isStr && contains(allowed, str) {
				switch key {
				case "focus_mode":
					current.FocusMode = str
				}
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
