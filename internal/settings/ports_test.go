package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPortDefaults(t *testing.T) {
	s := Defaults()
	if s.ControlPort != 9224 || s.WsPort != 9225 || !s.PortsEnabled {
		t.Fatalf("默认端口/开关不符: %+v", s)
	}
}

func TestUpdatePorts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	s := NewStore(path)
	up, err := s.Update(map[string]any{"control_port": 9301, "ws_port": 9302})
	if err != nil {
		t.Fatal(err)
	}
	if up.ControlPort != 9301 || up.WsPort != 9302 {
		t.Fatalf("端口更新未生效: %+v", up)
	}
	// 持久化往返
	s2 := NewStore(path)
	if s2.Get().ControlPort != 9301 || s2.Get().WsPort != 9302 {
		t.Fatalf("端口未持久化: %+v", s2.Get())
	}
}

func TestUpdatePortValidation(t *testing.T) {
	s := NewStore(t.TempDir() + "/settings.json")
	for _, bad := range []any{0.0, 65536.0, -1.0, "9224", true} {
		if _, err := s.Update(map[string]any{"control_port": bad}); err == nil {
			t.Fatalf("非法 control_port %v 必须报错", bad)
		}
	}
	// 两端口同值：拒绝整次 patch（防把生效配置改坏）
	if _, err := s.Update(map[string]any{"control_port": 9301, "ws_port": 9301}); err == nil {
		t.Fatal("端口同值必须报错")
	}
	// 被拒后原值不变
	if s.Get().ControlPort != 9224 || s.Get().WsPort != 9225 {
		t.Fatalf("被拒的 patch 不应改值: %+v", s.Get())
	}
}

func TestPortsEnabledToggle(t *testing.T) {
	s := NewStore(t.TempDir() + "/settings.json")
	up, err := s.Update(map[string]any{"ports_enabled": false})
	if err != nil {
		t.Fatal(err)
	}
	if up.PortsEnabled {
		t.Fatal("ports_enabled=false 未生效")
	}
	// 非布尔值静默忽略（与其他 bool 类字段一致）
	if _, err := s.Update(map[string]any{"ports_enabled": "off"}); err != nil {
		t.Fatalf("非布尔值应忽略而非报错: %v", err)
	}
}

func TestLoadPortConflictFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "settings.json")
	if err := os.WriteFile(path, []byte(`{"control_port": 9001, "ws_port": 9001}`), 0o644); err != nil {
		t.Fatal(err)
	}
	s := NewStore(path)
	if s.Get().ControlPort != 9224 || s.Get().WsPort != 9225 {
		t.Fatalf("端口冲突应回落默认: %+v", s.Get())
	}
}
