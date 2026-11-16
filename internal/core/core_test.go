package core

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// freePort 取一个空闲端口（绑定后立即释放；测试端口冲突概率极低）。
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

// probe 探测控制面健康端点；alive=期望可达。
func probe(t *testing.T, port int, alive bool) {
	t.Helper()
	url := fmt.Sprintf("http://127.0.0.1:%d/health", port)
	c := &http.Client{Timeout: 500 * time.Millisecond}
	resp, err := c.Get(url)
	got := err == nil && resp.StatusCode == http.StatusOK
	if got != alive {
		t.Fatalf("端口 %d 期望 alive=%v 实际=%v (err=%v)", port, alive, got, err)
	}
	if resp != nil {
		resp.Body.Close()
	}
}

// wsProbe 探测 WS 端口是否有监听（TCP 可连即认为监听在）。
func wsProbe(t *testing.T, port int, alive bool) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 500*time.Millisecond)
	got := err == nil
	if got != alive {
		t.Fatalf("WS 端口 %d 期望 alive=%v 实际=%v (err=%v)", port, alive, got, err)
	}
	if conn != nil {
		conn.Close()
	}
}

func TestCoreRebind(t *testing.T) {
	cp1, wp1 := freePort(t), freePort(t)
	cp2, wp2 := freePort(t), freePort(t)

	eng, err := New(Options{
		DataDir:     filepath.Join(t.TempDir(), "data"),
		Version:     "test",
		ControlPort: cp1,
		WsPort:      wp1,
		Logger:      nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.Start(); err != nil {
		t.Fatal(err)
	}
	defer eng.Stop()
	probe(t, cp1, true)
	wsProbe(t, wp1, true)

	// 改端口重绑：settings 是运行时事实源（flag 覆盖只管初始绑定）
	if _, err := eng.Store().Update(map[string]any{"control_port": cp2, "ws_port": wp2}); err != nil {
		t.Fatal(err)
	}
	eng.Rebind()
	probe(t, cp2, true)
	wsProbe(t, wp2, true)
	probe(t, cp1, false)
	wsProbe(t, wp1, false)

	// 关端口（App 内嵌模式）
	if _, err := eng.Store().Update(map[string]any{"ports_enabled": false}); err != nil {
		t.Fatal(err)
	}
	eng.Rebind()
	probe(t, cp2, false)
	wsProbe(t, wp2, false)

	// 重开端口恢复监听
	if _, err := eng.Store().Update(map[string]any{"ports_enabled": true}); err != nil {
		t.Fatal(err)
	}
	eng.Rebind()
	probe(t, cp2, true)
	wsProbe(t, wp2, true)
}

// mkdirWrite 建父目录并写文件（测试辅助）。
func mkdirWrite(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(content), 0o644)
}

func TestCoreStartPortsDisabled(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	cp, wp := freePort(t), freePort(t)
	// 预写 settings：端口关闭 + 指定端口
	path := filepath.Join(dir, "settings.json")
	if err := mkdirWrite(path, fmt.Sprintf(`{"ports_enabled": false, "control_port": %d, "ws_port": %d}`, cp, wp)); err != nil {
		t.Fatal(err)
	}
	eng, err := New(Options{DataDir: dir, Version: "test", Logger: nil})
	if err != nil {
		t.Fatal(err)
	}
	if err := eng.Start(); err != nil {
		t.Fatal(err)
	}
	defer eng.Stop()
	probe(t, cp, false)
	wsProbe(t, wp, false)
}
