"""ProxyState 纯逻辑单测（无 IO、无网络）。"""

import pytest

from agent_browser_proxy.state import ProxyState


@pytest.fixture()
def state() -> ProxyState:
    return ProxyState()


class TestSession:
    def test_alloc_returns_fresh_session_with_token(self, state: ProxyState) -> None:
        s = state.alloc("a")
        assert s.name == "a"
        assert s.token
        assert state.find_by_token(s.token) is s

    def test_alloc_same_name_unconnected_reuses(self, state: ProxyState) -> None:
        s1 = state.alloc("a")
        s2 = state.alloc("a")
        assert s1 is s2  # 未连接 → 复用（重连语义）

    def test_alloc_same_name_connected_replaces(self, state: ProxyState) -> None:
        s1 = state.alloc("a")
        s1.connected = True
        s2 = state.alloc("a")
        assert s2 is not s1
        assert state.find_by_token(s1.token) is None  # 旧 token 失活

    def test_release_returns_targets_and_cleans(self, state: ProxyState) -> None:
        s = state.alloc("a")
        state.own_target(s, "t1")
        state.own_target(s, "t2")
        targets = state.release("a")
        assert set(targets) == {"t1", "t2"}
        assert state.sessions == {}
        assert state.owner_of("t1") is None
        assert s.owned_targets == set()

    def test_release_unknown_name_is_noop(self, state: ProxyState) -> None:
        assert state.release("ghost") == []


class TestOwnership:
    def test_own_and_owner_of(self, state: ProxyState) -> None:
        sa, sb = state.alloc("a"), state.alloc("b")
        state.own_target(sa, "t1")
        assert state.owner_of("t1") is sa
        assert state.owner_of("t1") is not sb

    def test_drop_target_removes_ownership(self, state: ProxyState) -> None:
        s = state.alloc("a")
        state.own_target(s, "t1")
        state.drop_target("t1")
        assert state.owner_of("t1") is None
        assert "t1" not in s.owned_targets


class TestDsSessions:
    def test_bind_and_route(self, state: ProxyState) -> None:
        s = state.alloc("a")
        state.bind_ds_session(s, "sid-1")
        assert state.session_of_ds("sid-1") is s

    def test_unbind(self, state: ProxyState) -> None:
        s = state.alloc("a")
        state.bind_ds_session(s, "sid-1")
        state.unbind_ds_session("sid-1")
        assert state.session_of_ds("sid-1") is None

    def test_release_clears_ds_bindings(self, state: ProxyState) -> None:
        s = state.alloc("a")
        state.bind_ds_session(s, "sid-1")
        state.release("a")
        assert state.session_of_ds("sid-1") is None


class TestPending:
    def test_next_id_monotonic_and_take(self, state: ProxyState) -> None:
        s = state.alloc("a")
        d1 = state.next_ds_id(s, 100, "create")
        d2 = state.next_ds_id(s, 101, None)
        assert d2 > d1
        assert state.take_pending(d1) == (s, 100, "create")
        assert state.take_pending(d1) is None  # 一次性
        assert state.take_pending(d2) == (s, 101, None)
