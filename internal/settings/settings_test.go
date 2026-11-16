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
		len(got.Rewrites) != len(want.Rewrites) {
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
	// 旧键迁移：downstream_mode=extension → routing.default_source=extension
	if s.Get().Routing.DefaultSource != SourceExtension || s.Get().Sources.ExtensionToken != "tok-1" {
		t.Fatalf("旧键迁移异常: default=%s token=%s", s.Get().Routing.DefaultSource, s.Get().Sources.ExtensionToken)
	}
	// 非法枚举忽略（旧键通道）；空 token 忽略
	updated, err := s.Update(map[string]any{"downstream_mode": "bogus", "ext_token": "   "})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Routing.DefaultSource != SourceExtension || updated.Sources.ExtensionToken != "tok-1" {
		t.Fatalf("非法值应被忽略保持原值: default=%s token=%s", updated.Routing.DefaultSource, updated.Sources.ExtensionToken)
	}
	updated, err = s.Update(map[string]any{"downstream_mode": "chrome", "ext_token": "tok-2"})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Routing.DefaultSource != SourceStandalone || updated.Sources.ExtensionToken != "tok-2" {
		t.Fatalf("合法更新未生效: default=%s token=%s", updated.Routing.DefaultSource, updated.Sources.ExtensionToken)
	}
	// 新结构整对象更新：sources + routing（含前缀规则表）
	updated, err = s.Update(map[string]any{
		"sources": map[string]any{"standalone_enabled": true, "extension_enabled": false, "token": "tok-3"},
		"routing": map[string]any{"default_source": "extension",
			"rules": []any{map[string]any{"prefix": "sa-", "source": "standalone"}}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Sources.ExtensionEnabled || updated.Sources.ExtensionToken != "tok-3" {
		t.Fatalf("sources 更新异常: %+v", updated.Sources)
	}
	if updated.Routing.DefaultSource != SourceExtension || len(updated.Routing.Rules) != 1 ||
		updated.Routing.Rules[0].Prefix != "sa-" {
		t.Fatalf("routing 更新异常: %+v", updated.Routing)
	}
	// 子对象合并语义：只传 default_source 不清空 rules；只传 token 不动开关
	updated, err = s.Update(map[string]any{"routing": map[string]any{"default_source": "standalone"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Routing.Rules) != 1 || updated.Routing.Rules[0].Prefix != "sa-" {
		t.Fatalf("routing 部分更新不应清空 rules: %+v", updated.Routing)
	}
	updated, err = s.Update(map[string]any{"sources": map[string]any{"token": "tok-4"}})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.Sources.StandaloneEnabled || updated.Sources.ExtensionEnabled || updated.Sources.ExtensionToken != "tok-4" {
		t.Fatalf("sources 部分更新不应动开关: %+v", updated.Sources)
	}
	// 两源同时禁用被拒
	if _, err := s.Update(map[string]any{"sources": map[string]any{"standalone_enabled": false, "extension_enabled": false}}); err == nil {
		t.Fatal("两源同时禁用应报错")
	}
	// 默认值：令牌自动生成（强随机、非 dev），内置两条接入点
	fresh := NewStore(filepath.Join(t.TempDir(), "none.json"))
	if fresh.Get().Routing.DefaultSource != SourceStandalone {
		t.Fatalf("默认应为 standalone: %+v", fresh.Get().Routing)
	}
	if len(fresh.Get().Routing.Rules) != 1 || fresh.Get().Routing.Rules[0].Prefix != "ext-" {
		t.Fatalf("默认路由规则应含 ext- 前缀: %+v", fresh.Get().Routing)
	}
	ft := fresh.Get().Sources.ExtensionToken
	fa := fresh.Get().Sources.AllocToken
	if len(ft) < 16 || ft == "dev" || len(fa) < 16 {
		t.Fatalf("首启应生成强随机令牌: ext=%q alloc=%q", ft, fa)
	}
	eps := fresh.Get().Endpoints
	if len(eps) != 2 || eps[0].Path != "standalone" || eps[1].Path != "extension" {
		t.Fatalf("首启应生成内置两条接入点: %+v", eps)
	}
	for _, ep := range eps {
		if len(ep.Token) < 16 {
			t.Fatalf("接入点令牌应自动生成: %+v", ep)
		}
	}
	// 弱默认 dev 在加载时被废除换新（旧文件迁移路径）
	devPath := filepath.Join(t.TempDir(), "dev.json")
	os.WriteFile(devPath, []byte(`{"sources":{"token":"dev","alloc_token":"dev"}}`), 0o644)
	ds := NewStore(devPath)
	if ds.Get().Sources.ExtensionToken == "dev" || ds.Get().Sources.AllocToken == "dev" {
		t.Fatalf("dev 默认令牌应被自动废除: %+v", ds.Get().Sources)
	}
}

func TestEndpointsUpdate(t *testing.T) {
	store, _ := newStore(t)
	base := store.Get()
	tokSA := base.Endpoints[0].Token
	// 整表更新：改 session 名 + 新增自定义端点；token 不随 PUT 变（按 path 保留）
	updated, err := store.Update(map[string]any{"endpoints": []any{
		map[string]any{"path": "standalone", "source": "standalone", "session": "base-work"},
		map[string]any{"path": "extension", "source": "extension"},
		map[string]any{"path": "work", "source": "extension", "session": "research"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(updated.Endpoints) != 3 {
		t.Fatalf("应有三条接入点: %+v", updated.Endpoints)
	}
	if updated.Endpoints[0].Token != tokSA {
		t.Fatalf("PUT 不应更换现有接入点令牌: %q vs %q", updated.Endpoints[0].Token, tokSA)
	}
	if updated.Endpoints[0].Session != "base-work" || updated.Endpoints[2].Session != "research" {
		t.Fatalf("session 名未生效: %+v", updated.Endpoints)
	}
	if len(updated.Endpoints[2].Token) < 16 {
		t.Fatalf("新接入点应自动生成令牌: %+v", updated.Endpoints[2])
	}
	// 非法：保留字 / 重复 / 非法 source
	if _, err := store.Update(map[string]any{"endpoints": []any{map[string]any{"path": "cdp", "source": "standalone"}}}); err == nil {
		t.Fatal("保留字 path 应被拒绝")
	}
	if _, err := store.Update(map[string]any{"endpoints": []any{
		map[string]any{"path": "a", "source": "standalone"},
		map[string]any{"path": "a", "source": "extension"},
	}}); err == nil {
		t.Fatal("重复 path 应被拒绝")
	}
	if _, err := store.Update(map[string]any{"endpoints": []any{map[string]any{"path": "ok", "source": "bogus"}}}); err == nil {
		t.Fatal("非法 source 应被拒绝")
	}
	// 重置令牌：新值生效；reset 是写时复制——旧快照（updated）不受影响
	oldTok := updated.Endpoints[2].Token
	after, err := store.ResetEndpointToken("work")
	if err != nil || after.Endpoints[2].Token == oldTok {
		t.Fatalf("重置应换新令牌: err=%v old=%s new=%s", err, oldTok, after.Endpoints[2].Token)
	}
	if updated.Endpoints[2].Token != oldTok {
		t.Fatalf("reset 不应改动旧快照（写时复制）: %s", updated.Endpoints[2].Token)
	}
	if _, err := store.ResetEndpointToken("nope"); err == nil {
		t.Fatal("重置不存在的接入点应报错")
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
	if _, err := s.Update(map[string]any{"popup_policy": "close"}); err == nil {
		t.Fatal("popup_policy 已移除（事件向永不回写），作为未知键必须报错")
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
