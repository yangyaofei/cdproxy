package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "settings.json")
	return NewStore(path), path
}

func TestMissingFileReturnsDefaults(t *testing.T) {
	s := NewStore(filepath.Join(t.TempDir(), "none.json"))
	got := s.Get()
	want := Defaults()
	if got.DisconnectReapSeconds != want.DisconnectReapSeconds || got.AllocReapSeconds != want.AllocReapSeconds ||
		got.PopupPolicy != want.PopupPolicy || len(got.Rewrites) != len(want.Rewrites) {
		t.Fatalf("期望默认值，实际 %+v", got)
	}
}

func TestCorruptFileReturnsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	if got := s.Get().DisconnectReapSeconds; got != 60.0 {
		t.Fatalf("期望 60，实际 %v", got)
	}
}

func TestKnownFieldsLoaded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	raw, _ := json.Marshal(map[string]any{"disconnect_reap_seconds": 30, "unknown": 1})
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	if s.Get().DisconnectReapSeconds != 30.0 {
		t.Fatalf("期望 30，实际 %v", s.Get().DisconnectReapSeconds)
	}
	if s.Get().AllocReapSeconds != 300.0 {
		t.Fatalf("未提及应保持默认 300，实际 %v", s.Get().AllocReapSeconds)
	}
}

func TestRewritesLoaded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	raw := `{"rewrites":[{"match":"Page.bringToFront","action":"fake","group":"focus","note":"x"},
	                     {"match":"Network.*","action":"rewrite","set":{"block":true}}]}`
	if err := os.WriteFile(path, []byte(raw), 0o644); err != nil {
		t.Fatal(err)
	}
	rules := NewStore(path).Get().Rewrites
	if len(rules) != 2 || rules[0].Match != "Page.bringToFront" || rules[1].Set["block"] != true {
		t.Fatalf("rewrites 加载异常: %+v", rules)
	}
}

func TestRewritesInvalidFallsBackToDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"rewrites":[{"match":"X","action":"nuke"}]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	rules := NewStore(path).Get().Rewrites
	if len(rules) != len(DefaultRewrites()) {
		t.Fatalf("非法规则应回落默认集: %d", len(rules))
	}
}

func TestDownstreamModeAndExtToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"downstream_mode":"extension","ext_token":"tok-1"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	if s.Get().DownstreamMode != "extension" || s.Get().ExtToken != "tok-1" {
		t.Fatalf("加载异常: mode=%s token=%s", s.Get().DownstreamMode, s.Get().ExtToken)
	}
	// 非法枚举回落默认 chrome；空 token 忽略
	updated, err := s.Update(map[string]any{"downstream_mode": "bogus", "ext_token": "   "})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DownstreamMode != "extension" || updated.ExtToken != "tok-1" {
		t.Fatalf("非法值应被忽略保持原值: mode=%s token=%s", updated.DownstreamMode, updated.ExtToken)
	}
	updated, err = s.Update(map[string]any{"downstream_mode": "chrome", "ext_token": "tok-2"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.DownstreamMode != "chrome" || updated.ExtToken != "tok-2" {
		t.Fatalf("合法更新未生效: mode=%s token=%s", updated.DownstreamMode, updated.ExtToken)
	}
	// 默认值
	fresh := NewStore(filepath.Join(t.TempDir(), "none.json"))
	if fresh.Get().DownstreamMode != "chrome" || fresh.Get().ExtToken != "dev" {
		t.Fatalf("默认应为 chrome/dev: %+v", fresh.Get())
	}
}

func TestUpdatePersistsAndApplies(t *testing.T) {
	store, path := newStore(t)
	updated, err := store.Update(map[string]any{"alloc_reap_seconds": 120.0})
	if err != nil {
		t.Fatal(err)
	}
	if updated.AllocReapSeconds != 120.0 {
		t.Fatalf("期望 120，实际 %v", updated.AllocReapSeconds)
	}
	if re := NewStore(path).Get().AllocReapSeconds; re != 120.0 {
		t.Fatalf("重载应持久化为 120，实际 %v", re)
	}
}

func TestUpdateClampsToMinimum(t *testing.T) {
	store, _ := newStore(t)
	if got := store.mustUpdate(t, "disconnect_reap_seconds", 0.0); got != 5.0 {
		t.Fatalf("期望钳制到 5，实际 %v", got)
	}
}

func TestUpdateRejectsUnknownButIgnoresNonNumeric(t *testing.T) {
	store, _ := newStore(t)
	// 未知键：必须报错（静默吞掉会让调用方误以为已生效）
	if _, err := store.Update(map[string]any{"hack": 1}); err == nil {
		t.Fatal("未知键必须报错")
	}
	// 已知键的非数值：类型不匹配忽略，不报错不改动
	updated, err := store.Update(map[string]any{"alloc_reap_seconds": "fast"})
	if err != nil {
		t.Fatal(err)
	}
	base := Defaults()
	if updated.AllocReapSeconds != base.AllocReapSeconds {
		t.Fatalf("非数值应被忽略，实际 %+v", updated)
	}
}

func TestUpdateRewrites(t *testing.T) {
	store, path := newStore(t)
	rules := []map[string]any{{"match": "Page.bringToFront", "action": "fake"}}
	if _, err := store.Update(map[string]any{"rewrites": rules}); err != nil {
		t.Fatal(err)
	}
	if got := NewStore(path).Get().Rewrites; len(got) != 1 || got[0].Match != "Page.bringToFront" {
		t.Fatalf("rewrites 应持久化: %+v", got)
	}
	// 非法 action → 422 语义（返回错误，不改当前值）
	if _, err := store.Update(map[string]any{"rewrites": []map[string]any{{"match": "X", "action": "nuke"}}}); err == nil {
		t.Fatal("非法 action 应报错")
	}
	if got := store.Get().Rewrites; len(got) != 1 {
		t.Fatalf("失败更新不应改动当前值: %d", len(got))
	}
}

func TestUpdateRejectsNilPatch(t *testing.T) {
	store, _ := newStore(t)
	if _, err := store.Update(nil); err == nil {
		t.Fatal("nil patch 应报错")
	}
}

func (s *Store) mustUpdate(t *testing.T, key string, value any) any {
	t.Helper()
	updated, err := s.Update(map[string]any{key: value})
	if err != nil {
		t.Fatal(err)
	}
	switch key {
	case "disconnect_reap_seconds":
		return updated.DisconnectReapSeconds
	case "alloc_reap_seconds":
		return updated.AllocReapSeconds
	}
	return nil
}

func TestUpdateRejectsUnknownKeys(t *testing.T) {
	s := NewStore(t.TempDir() + "/settings.json")
	if _, err := s.Update(map[string]any{"focus_mode": "steal"}); err == nil {
		t.Fatal("未知键必须报错（静默吞掉会让调用方误以为已生效）")
	}
	if _, err := s.Update(map[string]any{"popup_policy": "allow"}); err != nil {
		t.Fatalf("合法键不应报错: %v", err)
	}
}

func TestKeeperIdleShutdownClampAndDisable(t *testing.T) {
	s := NewStore(t.TempDir() + "/settings.json")
	up, err := s.Update(map[string]any{"keeper_idle_shutdown_seconds": 5.0})
	if err != nil {
		t.Fatal(err)
	}
	if up.KeeperIdleShutdownSeconds != 60 {
		t.Fatalf("启用时下限 60，实际 %v", up.KeeperIdleShutdownSeconds)
	}
	up, err = s.Update(map[string]any{"keeper_idle_shutdown_seconds": 0.0})
	if err != nil || up.KeeperIdleShutdownSeconds != 0 {
		t.Fatalf("0 应原样通过（禁用），实际 %v err=%v", up.KeeperIdleShutdownSeconds, err)
	}
}
