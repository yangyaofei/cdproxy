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
	if got := s.Get(); got != Defaults() {
		t.Fatalf("期望默认值，实际 %v", got)
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

func TestFocusModeValidLoaded(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"focus_mode":"steal"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if NewStore(path).Get().FocusMode != "steal" {
		t.Fatal("期望 steal")
	}
}

func TestFocusModeInvalidFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"focus_mode":"chaos"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if NewStore(path).Get().FocusMode != "background" {
		t.Fatal("非法枚举应回落 background")
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

func TestUpdateIgnoresUnknownAndNonNumeric(t *testing.T) {
	store, _ := newStore(t)
	updated, err := store.Update(map[string]any{"hack": 1, "alloc_reap_seconds": "fast"})
	if err != nil {
		t.Fatal(err)
	}
	if updated != Defaults() {
		t.Fatalf("未知/非数值应被忽略，实际 %v", updated)
	}
}

func TestUpdateFocusMode(t *testing.T) {
	store, _ := newStore(t)
	if got := store.mustUpdate(t, "focus_mode", "steal"); got != "steal" {
		t.Fatalf("期望 steal，实际 %v", got)
	}
	if got := store.mustUpdate(t, "focus_mode", "nope"); got != "steal" {
		t.Fatalf("非法值应保持当前 steal，实际 %v", got)
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
	case "focus_mode":
		return updated.FocusMode
	}
	return nil
}
