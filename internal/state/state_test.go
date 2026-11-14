package state

import (
	"sync"
	"testing"

	"github.com/coder/websocket"
)

func alloc(t *testing.T, st *State, name string) *Session {
	t.Helper()
	s, _ := st.Alloc(name, "token-"+name, "chrome")
	return s
}

func TestAllocFreshSession(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	if s.Name != "a" || s.Token != "token-a" {
		t.Fatalf("字段不符: %+v", s)
	}
	if st.FindByToken("token-a") != s {
		t.Fatal("token 定位失败")
	}
}

func TestAllocSameNameUnconnectedReuses(t *testing.T) {
	st := New()
	s1 := alloc(t, st, "a")
	s2, _ := st.Alloc("a", "token-a2", "chrome")
	if s1 != s2 {
		t.Fatal("未连接应复用同一 session")
	}
}

func TestAllocReuseKeepsOriginalToken(t *testing.T) {
	// 不变量：复用路径保留原 token——AllocSession 返回的连接 URL 以
	// sess.Token 拼接，若此处换新 token，daemon 重连必命中 4401。
	st := New()
	s1, _ := st.Alloc("a", "tok-1", "chrome")
	s2, _ := st.Alloc("a", "tok-2", "chrome")
	if s1 != s2 {
		t.Fatal("未连接应复用")
	}
	if s2.Token != "tok-1" {
		t.Fatalf("复用必须保留原 token，实际 %q", s2.Token)
	}
	if st.FindByToken("tok-1") != s2 {
		t.Fatal("原 token 必须仍可定位")
	}
	if st.FindByToken("tok-2") != nil {
		t.Fatal("未注册的新 token 不应可定位")
	}
}

func TestAllocSameNameConnectedAlsoReuses(t *testing.T) {
	// 连接中的同名 alloc 也复用（接管由 WS supersede 完成，token 保持稳定）
	st := New()
	s1 := alloc(t, st, "a")
	fakeWS(s1)
	s2, created := st.Alloc("a", "token-a2", "chrome")
	if s1 != s2 || created {
		t.Fatal("同名一律复用，不新建")
	}
	if s2.Token != "token-a" {
		t.Fatalf("token 应保持稳定，实际 %q", s2.Token)
	}
	if st.FindByToken("token-a") != s2 {
		t.Fatal("原 token 应仍可定位")
	}
}

func TestReleaseReturnsTargetsAndCleans(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	st.OwnTarget(s, "t1")
	st.OwnTarget(s, "t2")
	sess, targets := st.Release("a")
	if sess == nil || sess.Name != "a" {
		t.Fatalf("期望返回原 session，实际 %v", sess)
	}
	if len(targets) != 2 {
		t.Fatalf("期望 2 个 target，实际 %v", targets)
	}
	if st.OwnerOf("t1") != nil {
		t.Fatal("归属应清除")
	}
	if len(s.OwnedTargets()) != 0 {
		t.Fatal("session 名下应清空")
	}
}

func TestClearOwnershipReturnsSnapshot(t *testing.T) {
	st := New()
	a := alloc(t, st, "a")
	b := alloc(t, st, "b")
	st.OwnTarget(a, "ta")
	st.OwnTarget(b, "tb")
	st.BindDsSession(a, "dsa")
	st.BindDsSession(b, "dsb")
	owned, bound := st.ClearOwnershipFor("chrome")
	if len(owned[a]) != 1 || owned[a][0] != "ta" {
		t.Fatalf("期望 owned[a]=[ta]，实际 %v", owned[a])
	}
	if len(bound[b]) != 1 || bound[b][0] != "dsb" {
		t.Fatalf("期望 bound[b]=[dsb]，实际 %v", bound[b])
	}
	if st.OwnerOf("ta") != nil || st.SessionOfDs("dsa") != nil {
		t.Fatal("清理后归属与绑定应为空")
	}
	if len(a.OwnedTargets()) != 0 || len(b.OwnedTargets()) != 0 {
		t.Fatal("session 名下应清空")
	}
}

func TestClearOwnershipForOnlyTouchesKind(t *testing.T) {
	st := New()
	chr, _ := st.Alloc("chr", "t-chr", "chrome")
	ext, _ := st.Alloc("ext", "t-ext", "extension")
	st.OwnTarget(chr, "t-chrome-tab")
	st.OwnTarget(ext, "t-ext-tab")
	st.BindDsSession(chr, "ds-chrome")
	st.BindDsSession(ext, "ds-ext")

	owned, bound := st.ClearOwnershipFor("extension")
	if len(owned) != 1 || len(owned[ext]) != 1 || owned[ext][0] != "t-ext-tab" {
		t.Fatalf("extension 清理应只含 ext 会话，实际 %v", owned)
	}
	if len(bound) != 1 || len(bound[ext]) != 1 {
		t.Fatalf("extension 绑定清理应只含 ext 会话，实际 %v", bound)
	}
	if st.OwnerOf("t-chrome-tab") != chr || st.SessionOfDs("ds-chrome") != chr {
		t.Fatal("chrome 侧归属不应被 extension 清理牵连")
	}
	if st.OwnerOf("t-ext-tab") != nil || st.SessionOfDs("ds-ext") != nil {
		t.Fatal("extension 侧应已清空")
	}
}

func TestDetachSessionTargetsAndDownstreamBinding(t *testing.T) {
	st := New()
	a, _ := st.Alloc("a", "t-a", "chrome")
	if a.Downstream() != "chrome" {
		t.Fatalf("期望下游绑定 chrome，实际 %s", a.Downstream())
	}
	st.OwnTarget(a, "t1")
	st.OwnTarget(a, "t2")
	st.BindDsSession(a, "ds1")
	tids, sids := st.DetachSessionTargets(a)
	if len(tids) != 2 || len(sids) != 1 {
		t.Fatalf("期望 detach 2 target + 1 session，实际 %d/%d", len(tids), len(sids))
	}
	if st.OwnerOf("t1") != nil || st.SessionOfDs("ds1") != nil || len(a.OwnedTargets()) != 0 {
		t.Fatal("detach 后归属与绑定应清空")
	}
	a.SetDownstream("extension")
	if a.Downstream() != "extension" {
		t.Fatal("SetDownstream 未生效")
	}
}

func TestReleaseUnknownNameIsNoop(t *testing.T) {
	if sess, targets := New().Release("ghost"); sess != nil || targets != nil {
		t.Fatal("未知名应为 no-op")
	}
}

func TestOwnership(t *testing.T) {
	st := New()
	sa, sb := alloc(t, st, "a"), alloc(t, st, "b")
	st.OwnTarget(sa, "t1")
	if st.OwnerOf("t1") != sa || st.OwnerOf("t1") == sb {
		t.Fatal("归属错误")
	}
	st.DropTarget("t1")
	if st.OwnerOf("t1") != nil {
		t.Fatal("解除归属失败")
	}
}

func TestDsSessionBinding(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	st.BindDsSession(s, "sid-1")
	if st.SessionOfDs("sid-1") != s {
		t.Fatal("绑定/查询失败")
	}
	st.UnbindDsSession("sid-1")
	if st.SessionOfDs("sid-1") != nil {
		t.Fatal("解绑失败")
	}
}

func TestReleaseClearsDsBindings(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	st.BindDsSession(s, "sid-1")
	st.Release("a")
	if st.SessionOfDs("sid-1") != nil {
		t.Fatal("释放应清除 ds 绑定")
	}
}

func TestPendingMonotonicAndTakeOnce(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	d1 := st.NextDsID(s, 100, true, "create", "")
	d2 := st.NextDsID(s, 101, true, "", "")
	if d2 <= d1 {
		t.Fatal("id 应单调递增")
	}
	e1, ok := st.TakePending(d1)
	if !ok || e1.Sess != s || e1.UpID != 100 || e1.Tag != "create" || !e1.HasUpID {
		t.Fatalf("取回不符: %+v", e1)
	}
	if _, ok := st.TakePending(d1); ok {
		t.Fatal("应一次性")
	}
	if e2, _ := st.TakePending(d2); e2.Sess != s || e2.UpID != 101 {
		t.Fatalf("第二条不符: %+v", e2)
	}
}

func TestConcurrentAllocAndPending(t *testing.T) {
	st := New()
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			s, _ := st.Alloc("race", "token-race", "chrome")
			st.NextDsID(s, 1, true, "", "")
			st.OwnTarget(s, "tid")
		}()
	}
	wg.Wait()
	// 50 并发后：1 个 session、pending 50 条、归属 1 条
	if snap := st.Snapshot(); len(snap) != 1 || snap[0]["name"] != "race" {
		t.Fatalf("并发后应恰一个 race session: %v", snap)
	}
	if st.OwnerOf("tid") == nil {
		t.Fatal("归属应存在")
	}
}

// fakeWS 标记连接态（无真实连接，仅测试状态语义）。
func fakeWS(s *Session) {
	s.SetWS(&websocket.Conn{})
}
