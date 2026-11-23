package proxy

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/yangyaofei/cdproxy/internal/interlog"
	"github.com/yangyaofei/cdproxy/internal/keeper"
	"github.com/yangyaofei/cdproxy/internal/settings"
)

func newTestProxyWithUpstream(t *testing.T, downstreamKind string) (*Proxy, string, <-chan map[string]any, func()) {
	t.Helper()
	dir := t.TempDir()
	store := settings.NewStore(filepath.Join(dir, "settings.json"))
	ilog := interlog.New(filepath.Join(dir, "logs"))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	p := New(keeper.Config{}, 0, store, ilog, logger)

	sess, _ := p.st.Alloc("s1", "tok1", downstreamKind)
	sess.SetAutoAttach(true)
	sess.SetDiscoverTargets(true)

	received := make(chan map[string]any, 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		sess.SetWS(conn)
		<-r.Context().Done()
	}))

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")
	ctx, cancel := context.WithCancel(context.Background())
	clientConn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		cancel()
		srv.Close()
		t.Fatalf("dial mock upstream: %v", err)
	}

	// 等服务端 SetWS 完成
	deadline := time.Now().Add(2 * time.Second)
	for sess.WS() == nil && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if sess.WS() == nil {
		cancel()
		clientConn.Close(websocket.StatusNormalClosure, "")
		srv.Close()
		t.Fatal("mock upstream WS not attached")
	}

	go func() {
		for {
			_, data, err := clientConn.Read(ctx)
			if err != nil {
				return
			}
			var m map[string]any
			if json.Unmarshal(data, &m) == nil {
				received <- m
			}
		}
	}()

	cleanup := func() {
		cancel()
		_ = clientConn.Close(websocket.StatusNormalClosure, "done")
		srv.Close()
	}
	return p, "s1", received, cleanup
}

func readEvent(t *testing.T, ch <-chan map[string]any) map[string]any {
	t.Helper()
	select {
	case m := <-ch:
		return m
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for upstream event")
		return nil
	}
}

func TestOnDsEvent_NestedChildSessionBindAndUnbind(t *testing.T) {
	p, name, rx, cleanup := newTestProxyWithUpstream(t, dsExtension)
	defer cleanup()
	sess := p.st.FindByName(name)
	p.st.OwnTarget(sess, "T1")
	p.st.BindDsSession(sess, "E1", "T1")

	// 1. 嵌套 Target.attachedToTarget（OOPIF/Worker 子会话 E4）→ 绑定并转发
	p.onDsEvent(map[string]any{
		"sessionId": "E1",
		"method":    "Target.attachedToTarget",
		"params": map[string]any{
			"sessionId":  "E4",
			"targetInfo": map[string]any{"targetId": "T_OOPIF", "type": "iframe"},
		},
	}, dsExtension)
	ev1 := readEvent(t, rx)
	if ev1["method"] != "Target.attachedToTarget" || ev1["sessionId"] != "E1" {
		t.Fatalf("unexpected attach event: %v", ev1)
	}
	if got := p.st.SessionOfDs("E4"); got != sess {
		t.Fatalf("expected child session E4 bound to s1, got %v", got)
	}

	// 2. 子会话 E4 自身发出的事件应路由回 s1
	p.onDsEvent(map[string]any{
		"sessionId": "E4",
		"method":    "Runtime.executionContextCreated",
		"params":    map[string]any{"context": map[string]any{"id": 1}},
	}, dsExtension)
	ev2 := readEvent(t, rx)
	if ev2["method"] != "Runtime.executionContextCreated" || ev2["sessionId"] != "E4" {
		t.Fatalf("unexpected child event: %v", ev2)
	}

	// 3. 嵌套 Target.detachedFromTarget → 转发并解绑 E4
	p.onDsEvent(map[string]any{
		"sessionId": "E1",
		"method":    "Target.detachedFromTarget",
		"params":    map[string]any{"sessionId": "E4", "targetId": "T_OOPIF"},
	}, dsExtension)
	ev3 := readEvent(t, rx)
	if ev3["method"] != "Target.detachedFromTarget" || ev3["sessionId"] != "E1" {
		t.Fatalf("unexpected detach event: %v", ev3)
	}
	if got := p.st.SessionOfDs("E4"); got != nil {
		t.Fatalf("expected child session E4 unbound after detach, got %v", got)
	}
}

func TestOnDsEvent_BFCacheRestoreSynthesizesLifecycle(t *testing.T) {
	p, name, rx, cleanup := newTestProxyWithUpstream(t, dsExtension)
	defer cleanup()
	sess := p.st.FindByName(name)
	p.st.OwnTarget(sess, "T1")
	p.st.BindDsSession(sess, "E1", "T1")

	p.onDsEvent(map[string]any{
		"sessionId": "E1",
		"method":    "Page.frameNavigated",
		"params": map[string]any{
			"type": "BackForwardCacheRestore",
			"frame": map[string]any{
				"id":       "F1",
				"loaderId": "L1",
				"url":      "https://example.com/a",
			},
		},
	}, dsExtension)

	gotMethods := []string{}
	gotLifecycle := []string{}
	for i := 0; i < 7; i++ {
		ev := readEvent(t, rx)
		if ev["sessionId"] != "E1" {
			t.Fatalf("expected sessionId E1, got %v", ev["sessionId"])
		}
		m, _ := ev["method"].(string)
		gotMethods = append(gotMethods, m)
		if m == "Page.lifecycleEvent" {
			params, _ := ev["params"].(map[string]any)
			if params["frameId"] != "F1" || params["loaderId"] != "L1" {
				t.Fatalf("unexpected lifecycle frame/loader: %v", params)
			}
			gotLifecycle = append(gotLifecycle, params["name"].(string))
		}
	}
	if gotMethods[0] != "Page.frameNavigated" {
		t.Fatalf("expected Page.frameNavigated first, got %v", gotMethods)
	}
	wantLC := []string{"DOMContentLoaded", "load", "networkAlmostIdle", "networkIdle"}
	if strings.Join(gotLifecycle, ",") != strings.Join(wantLC, ",") {
		t.Fatalf("expected lifecycle %v, got %v", wantLC, gotLifecycle)
	}
}

func TestOnDsEvent_StandaloneOpenerAdoptsBlankTarget(t *testing.T) {
	p, name, rx, cleanup := newTestProxyWithUpstream(t, dsStandalone)
	defer cleanup()
	sess := p.st.FindByName(name)
	p.st.OwnTarget(sess, "T_OPENER")

	p.onDsEvent(map[string]any{
		"method": "Target.targetCreated",
		"params": map[string]any{
			"targetInfo": map[string]any{
				"targetId": "T_POPUP",
				"type":     "page",
				"openerId": "T_OPENER",
				"url":      "https://example.com/popup",
			},
		},
	}, dsStandalone)

	if owner := p.st.OwnerOf("T_POPUP"); owner != sess {
		t.Fatalf("expected T_POPUP adopted by opener session, got %v", owner)
	}
	ev := readEvent(t, rx)
	if ev["method"] != "Target.targetCreated" {
		t.Fatalf("expected Target.targetCreated routed to opener, got %v", ev)
	}
}

func TestOnDsEvent_ExtensionDownloadSyncsFileBeforeCompleted(t *testing.T) {
	p, name, rx, cleanup := newTestProxyWithUpstream(t, dsExtension)
	defer cleanup()
	sess := p.st.FindByName(name)
	p.st.OwnTarget(sess, "T1")

	srcDir := t.TempDir()
	destDir := t.TempDir()
	srcFile := filepath.Join(srcDir, "report.txt")
	wantPayload := "hello-download-payload"
	if err := os.WriteFile(srcFile, []byte(wantPayload), 0o644); err != nil {
		t.Fatalf("write src: %v", err)
	}
	sess.SetDownloadConfig("allowAndName", destDir)

	p.onDsEvent(map[string]any{
		"method": "Browser.downloadWillBegin",
		"params": map[string]any{
			"frameId":           "F1",
			"guid":              "g-ext-1",
			"url":               "http://127.0.0.1/report.txt",
			"suggestedFilename": "report.txt",
			"abTargetId":        "T1",
		},
	}, dsExtension)
	ev1 := readEvent(t, rx)
	if ev1["method"] != "Browser.downloadWillBegin" {
		t.Fatalf("expected Browser.downloadWillBegin, got %v", ev1)
	}
	if params1, _ := ev1["params"].(map[string]any); params1["abTargetId"] != nil {
		t.Fatalf("abTargetId must be stripped before forwarding: %v", params1)
	}

	p.onDsEvent(map[string]any{
		"method": "Browser.downloadProgress",
		"params": map[string]any{
			"guid":          "g-ext-1",
			"totalBytes":    float64(len(wantPayload)),
			"receivedBytes": float64(5),
			"state":         "inProgress",
		},
	}, dsExtension)
	ev2 := readEvent(t, rx)
	if ev2["method"] != "Browser.downloadProgress" {
		t.Fatalf("expected inProgress event, got %v", ev2)
	}

	p.onDsEvent(map[string]any{
		"method": "Browser.downloadProgress",
		"params": map[string]any{
			"guid":          "g-ext-1",
			"totalBytes":    float64(len(wantPayload)),
			"receivedBytes": float64(len(wantPayload)),
			"state":         "completed",
			"abFilename":    srcFile,
		},
	}, dsExtension)
	ev3 := readEvent(t, rx)
	if ev3["method"] != "Browser.downloadProgress" {
		t.Fatalf("expected completed event, got %v", ev3)
	}
	params3, _ := ev3["params"].(map[string]any)
	if params3["state"] != "completed" || params3["abFilename"] != nil {
		t.Fatalf("unexpected completed params (abFilename must be stripped): %v", params3)
	}

	gotBytes, err := os.ReadFile(filepath.Join(destDir, "g-ext-1"))
	if err != nil {
		t.Fatalf("expected copied file at <destDir>/<guid>: %v", err)
	}
	if string(gotBytes) != wantPayload {
		t.Fatalf("payload mismatch: got %q want %q", string(gotBytes), wantPayload)
	}
	if _, err := os.Stat(srcFile); err != nil {
		t.Fatalf("source file must not be deleted: %v", err)
	}
}

func TestOnDsEvent_StandaloneSubframeDownloadRoutingAndCopy(t *testing.T) {
	p, name, rx, cleanup := newTestProxyWithUpstream(t, dsStandalone)
	defer cleanup()
	sess := p.st.FindByName(name)
	p.st.OwnTarget(sess, "T1")
	p.st.BindDsSession(sess, "S1", "T1")

	// 子帧事件自动登记 FrameOwnerOf
	p.onDsEvent(map[string]any{
		"sessionId": "S1",
		"method":    "Page.frameAttached",
		"params":    map[string]any{"frameId": "SUBF1", "parentFrameId": "T1"},
	}, dsStandalone)
	_ = readEvent(t, rx)

	otherDir := t.TempDir()
	sessDir := t.TempDir()
	wantPayload := "standalone-subframe-bytes"
	if err := os.WriteFile(filepath.Join(otherDir, "g-st-1"), []byte(wantPayload), 0o644); err != nil {
		t.Fatalf("write otherDir file: %v", err)
	}
	sess.SetDownloadConfig("allowAndName", sessDir)
	p.mu.Lock()
	p.standaloneDlPath = otherDir
	p.standaloneDlBehavior = "allowAndName"
	p.mu.Unlock()

	p.onDsEvent(map[string]any{
		"method": "Browser.downloadWillBegin",
		"params": map[string]any{
			"frameId":           "SUBF1",
			"guid":              "g-st-1",
			"url":               "http://127.0.0.1/sub.bin",
			"suggestedFilename": "sub.bin",
		},
	}, dsStandalone)
	ev1 := readEvent(t, rx)
	if ev1["method"] != "Browser.downloadWillBegin" {
		t.Fatalf("expected Browser.downloadWillBegin routed via subframe, got %v", ev1)
	}

	p.onDsEvent(map[string]any{
		"method": "Browser.downloadProgress",
		"params": map[string]any{
			"guid":          "g-st-1",
			"totalBytes":    float64(len(wantPayload)),
			"receivedBytes": float64(len(wantPayload)),
			"state":         "completed",
		},
	}, dsStandalone)
	ev2 := readEvent(t, rx)
	if ev2["method"] != "Browser.downloadProgress" {
		t.Fatalf("expected completed event, got %v", ev2)
	}
	gotBytes, err := os.ReadFile(filepath.Join(sessDir, "g-st-1"))
	if err != nil {
		t.Fatalf("expected copied standalone download at <sessDir>/<guid>: %v", err)
	}
	if string(gotBytes) != wantPayload {
		t.Fatalf("payload mismatch: got %q want %q", string(gotBytes), wantPayload)
	}
}
