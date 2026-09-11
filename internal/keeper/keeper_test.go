package keeper

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coder/websocket"
)

func TestWriteConfigMinimalAndNoProvider(t *testing.T) {
	dir := t.TempDir()
	cfg := Defaults()
	cfg.ConfigPath = filepath.Join(dir, "keeper-config.json")
	cfg.ProfileDir = "/Users/x/agent-browser/profile"
	if err := cfg.WriteConfig("0"); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cfg.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	// 防递归红线：配置里绝不允许 provider/plugins
	for _, key := range []string{"provider", "plugins"} {
		if _, ok := m[key]; ok {
			t.Fatalf("keeper 配置不允许含 %q（会级联递归）", key)
		}
	}
	if m["profile"] != cfg.ProfileDir {
		t.Fatalf("profile 应为共享目录，实际 %v", m["profile"])
	}
	if m["idleTimeout"] != "0" {
		t.Fatalf("idleTimeout 应为传入值，实际 %v", m["idleTimeout"])
	}
	// 内容变化才重写：相同内容重复写不动；变化则覆盖（配置是生成的，非手工维护面）
	if err := cfg.WriteConfig("10m"); err != nil {
		t.Fatal(err)
	}
	raw, _ = os.ReadFile(cfg.ConfigPath)
	if !strings.Contains(string(raw), `"10m"`) {
		t.Fatal("阈值变化应触发重写")
	}
}

func TestRunKeeperUsesIsolatedEnvAndSessionFlags(t *testing.T) {
	cfg := Defaults()
	cfg.Session = "ab-keeper"
	cfg.ConfigPath = "/tmp/x/keeper-config.json"
	// runKeeper 经 exec 真跑会调用 agent-browser——这里只验证构造：
	// 借 runKeeper 跑一个假 agent-browser（shell 脚本）核对 argv 与 env
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-ab")
	argsCaptured := filepath.Join(dir, "args.txt")
	envCaptured := filepath.Join(dir, "env.txt")
	// #nosec 假脚本只记录 argv/env
	if err := os.WriteFile(script, []byte("#!/bin/sh\nfor a in \"$@\"; do echo \"$a\" >> "+argsCaptured+"; done\nenv | cut -d= -f1 | sort > "+envCaptured+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.AgentBrowser = script
	out, err := cfg.runKeeper([]string{"get", "cdp-url"}, 10e9)
	if err != nil {
		t.Fatal(err)
	}
	if out != "" {
		t.Fatalf("假脚本无输出，实际 %q", out)
	}
	args, _ := os.ReadFile(argsCaptured)
	got := strings.Fields(string(args))
	want := []string{"--session", "ab-keeper", "--config", "/tmp/x/keeper-config.json", "get", "cdp-url"}
	if len(got) != len(want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("argv[%d] = %q, want %q", i, got[i], want[i])
		}
	}
	envNames, _ := os.ReadFile(envCaptured)
	envs := strings.Fields(string(envNames))
	if len(envs) == 0 || envs[0] != "HOME" || envs[1] != "PATH" {
		t.Fatalf("环境必须只有 HOME/PATH（防 provider 递归），实际 %v", envs)
	}
}

func TestStopReportsStillAlive(t *testing.T) {
	// Stop 后旧 WS 仍可连接 → 必须报错（绝不宣称已关闭）。
	cfg := Defaults()
	cfg.Session = "ab-keeper-x"
	cfg.ConfigPath = filepath.Join(t.TempDir(), "k.json")
	if err := cfg.WriteConfig("0"); err != nil {
		t.Fatal(err)
	}
	// 用假 agent-browser 让 close "成功"（无输出退出 0）
	dir := t.TempDir()
	script := filepath.Join(dir, "fake-ab")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg.AgentBrowser = script
	ws := startFakeWSServer(t) + "/devtools/browser/x"
	if err := cfg.Stop(ws); err == nil {
		t.Fatal("旧 WS 仍可连接时 Stop 必须报错")
	}
}

func itoaPort(p int) string { return itoa(p) }

// startFakeWSServer 起一个可完成 WS 升级的最小服务（Dial 能成功 = 可连接）。
func startFakeWSServer(t *testing.T) string {
	t.Helper()
	done := make(chan struct{})
	mux := http.NewServeMux()
	mux.HandleFunc("/devtools/browser/x", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()
		ctx, cancel := context.WithCancel(context.Background())
		go func() { <-done; cancel() }()
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: mux}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() {
		close(done)
		_ = srv.Close()
	})
	return "ws://127.0.0.1:" + itoaPort(ln.Addr().(*net.TCPAddr).Port)
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}
