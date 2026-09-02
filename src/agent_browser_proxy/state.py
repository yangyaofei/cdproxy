"""代理侧状态：会话、tab 归属、命令关联表。

所有权模型：
- 每个消费 session 分配一个 token（上游 WS 连接凭证）
- tab（CDP target）按创建者归属 session；getTargets 只见自己的
- 下游 CDP sessionId（attach 产物）按归属 session 路由事件
- 命令 id 重映射：下游自增 id ↔ (上游连接, 上游原始 id, 处理标签)
"""

import itertools
import secrets
from dataclasses import dataclass, field


@dataclass
class ProxySession:
    """一个消费 session（对应 agent-browser 的一个 daemon session）。"""

    name: str
    token: str
    owned_targets: set[str] = field(default_factory=set)
    connected: bool = False
    ws: object | None = None  # websockets.ServerConnection，避免循环依赖用弱类型

    @property
    def key(self) -> str:
        """会话索引键（同名复用，keep-alive 语义）。"""
        return self.name


class ProxyState:
    """全局状态表（单事件循环内访问，无需锁）。"""

    def __init__(self) -> None:
        self._id_counter = itertools.count(1)
        self.sessions: dict[str, ProxySession] = {}  # name → session
        self.by_token: dict[str, ProxySession] = {}  # token → session
        self.target_owner: dict[str, ProxySession] = {}  # targetId → session
        self.ds_session_owner: dict[str, ProxySession] = {}  # 下游 sessionId → session
        # 下游命令 id → (session, 上游原始 id, 标签)
        self.pending: dict[int, tuple[ProxySession, int | None, str | None]] = {}

    # ── session 管理 ──

    def alloc(self, name: str) -> ProxySession:
        """按名分配 session；同名未连接则复用（重连语义），否则新建。"""
        existing = self.sessions.get(name)
        if existing is not None and not existing.connected:
            return existing
        if existing is not None:
            # 旧连接还挂着：顶掉（token 换新，旧连接自然失活）
            self._drop(existing)
        session = ProxySession(name=name, token=secrets.token_urlsafe(16))
        self.sessions[name] = session
        self.by_token[session.token] = session
        return session

    def release(self, name: str) -> list[str]:
        """释放 session，返回其名下 target 列表（调用方负责关 tab）。"""
        session = self.sessions.get(name)
        if session is None:
            return []
        targets = list(session.owned_targets)
        self._drop(session)
        return targets

    def _drop(self, session: ProxySession) -> None:
        self.sessions.pop(session.name, None)
        self.by_token.pop(session.token, None)
        for tid in list(session.owned_targets):
            self.target_owner.pop(tid, None)
        for ds_sid in [
            sid for sid, s in self.ds_session_owner.items() if s is session
        ]:
            del self.ds_session_owner[ds_sid]

    def find_by_token(self, token: str) -> ProxySession | None:
        """按上游连接 token 定位 session。"""
        return self.by_token.get(token)

    # ── tab 归属 ──

    def own_target(self, session: ProxySession, target_id: str) -> None:
        """登记 tab 归属（创建响应到达时调用）。"""
        session.owned_targets.add(target_id)
        self.target_owner[target_id] = session

    def owner_of(self, target_id: str) -> ProxySession | None:
        """查询 tab 归属。"""
        return self.target_owner.get(target_id)

    def drop_target(self, target_id: str) -> None:
        """tab 消亡（targetDestroyed 事件）时解除归属。"""
        session = self.target_owner.pop(target_id, None)
        if session is not None:
            session.owned_targets.discard(target_id)

    def bind_ds_session(self, session: ProxySession, ds_session_id: str) -> None:
        """绑定下游 attach sessionId → session（事件路由依据）。"""
        self.ds_session_owner[ds_session_id] = session

    def session_of_ds(self, ds_session_id: str) -> ProxySession | None:
        """下游 sessionId → session（事件路由查询）。"""
        return self.ds_session_owner.get(ds_session_id)

    def unbind_ds_session(self, ds_session_id: str) -> None:
        """下游 session 拆除（detachedFromTarget 事件）。"""
        self.ds_session_owner.pop(ds_session_id, None)

    # ── 命令关联 ──

    def next_ds_id(self, session: ProxySession, up_id: int | None, tag: str | None) -> int:
        """登记一条上游命令，返回重映射后的下游 id。"""
        ds_id = next(self._id_counter)
        self.pending[ds_id] = (session, up_id, tag)
        return ds_id

    def take_pending(self, ds_id: int) -> tuple[ProxySession, int | None, str | None] | None:
        """响应到达时取回关联（一次性）。"""
        return self.pending.pop(ds_id, None)
