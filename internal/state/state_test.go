package state

import (
	"sync"
	"testing"

	"github.com/coder/websocket"
)

func alloc(t *testing.T, st *State, name string) *Session {
	t.Helper()
	return st.Alloc(name, "token-"+name)
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
	s2 := st.Alloc("a", "token-a2")
	if s1 != s2 {
		t.Fatal("未连接应复用同一 session")
	}
}

func TestAllocSameNameConnectedReplaces(t *testing.T) {
	st := New()
	s1 := alloc(t, st, "a")
	fakeWS(s1)
	s2 := st.Alloc("a", "token-a2")
	if s1 == s2 {
		t.Fatal("连接中应顶掉并新建")
	}
	if st.FindByToken("token-a") != nil {
		t.Fatal("旧 token 应失活")
	}
}

func TestReleaseReturnsTargetsAndCleans(t *testing.T) {
	st := New()
	s := alloc(t, st, "a")
	st.OwnTarget(s, "t1")
	st.OwnTarget(s, "t2")
	targets := st.Release("a")
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

func TestReleaseUnknownNameIsNoop(t *testing.T) {
	if New().Release("ghost") != nil {
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
	d1 := st.NextDsID(s, 100, true, "create")
	d2 := st.NextDsID(s, 101, true, "")
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
			s := st.Alloc("race", "token-race")
			st.NextDsID(s, 1, true, "")
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
