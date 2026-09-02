"""CDP WebSocket 转发核心。

拓扑：
  agent-browser daemon（多个上游，每人一条 WS）
        │  ws://127.0.0.1:<ws_port>/cdp/<token>
        ▼
  ProxyServer（本模块）
        │  单条浏览器级 WS（长连复用 + 自愈重连）
        ▼
  共享 Chrome（keeper，固定调试端口）

改写规则（隔离语义所在）：
- Target.getTargets 响应过滤：每个 session 只见自己名下的 page
- Target.createTarget 响应：登记归属
- Target.attachToTarget / closeTarget：越权（碰别人的 tab）直接拒绝
- 事件路由：targetCreated/Destroyed/InfoChanged 按归属定向广播；
  带 sessionId 的事件只发给归属 session；未归属事件（用户手开的 tab）
  对所有 session 不可见
- id 重映射：上游各连接 id 空间独立 → 下游全局自增 id → 响应还原
"""

import asyncio
import contextlib
import json
import logging
from typing import Any

import websockets

from . import keeper as keeper_mod
from .keeper import KeeperConfig
from .settings import SettingsStore
from .state import ProxySession, ProxyState

logger = logging.getLogger(__name__)


class CdpProxy:
    """CDP 转发代理主体（含下游连接管理）。

    :param config: 基座配置。
    :param ws_port: 上游 WS 监听端口。
    :param settings: 运行时设置（回收时限在 Admin 页在线可调，排程时现读）。
    """

    def __init__(self, config: KeeperConfig, ws_port: int, settings: SettingsStore) -> None:
        self._config = config
        self._ws_port = ws_port
        self._settings = settings
        self.state = ProxyState()
        self._downstream: websockets.ClientConnection | None = None
        self._ds_recv_task: asyncio.Task[None] | None = None
        self._lock = asyncio.Lock()
        self._server: Any | None = None

    # ── 生命周期 ──

    async def start(self) -> None:
        """启动上游 WS 服务与下游连接。"""
        self._server = await websockets.serve(
            self._handle_upstream,
            "127.0.0.1",
            self._ws_port,
            max_size=64 * 1024 * 1024,
            ping_interval=20,
            ping_timeout=60,
        )
        await self._ensure_downstream()
        logger.info("CDP 代理就绪: ws://127.0.0.1:%s/cdp/<token>", self._ws_port)

    async def stop(self) -> None:
        """关停：上游全部断开 + 下游断开（Chrome 由 keeper 独立管理）。"""
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
        if self._ds_recv_task is not None:
            self._ds_recv_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._ds_recv_task
        if self._downstream is not None:
            await self._downstream.close()

    async def _ensure_downstream(self) -> None:
        """确保下游浏览器级连接存在（单连接复用 + 断线重连）。"""
        async with self._lock:
            if self._downstream is not None and self._downstream.state.name == "OPEN":
                return
            keeper_mod.ensure_running(self._config)  # 同步拉起/复用 Chrome
            url = keeper_mod.browser_ws_url(self._config)
            self._downstream = await websockets.connect(url, max_size=64 * 1024 * 1024)
            self._ds_recv_task = asyncio.create_task(self._ds_recv_loop())
            logger.info("下游连接建立: %s", url)

    async def _restart_downstream(self) -> None:
        """下游断开后重建（清归属表，Chrome 可能重启导致 target 全换）。"""
        async with self._lock:
            if self._ds_recv_task is not None:
                self._ds_recv_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._ds_recv_task
            if self._downstream is not None:
                with contextlib.suppress(Exception):
                    await self._downstream.close()
            self._downstream = None
            for session in list(self.state.sessions.values()):
                session.owned_targets.clear()
            self.state.target_owner.clear()
            self.state.ds_session_owner.clear()
        await self._ensure_downstream()

    async def restart_keeper(self) -> None:
        """重启基座 Chrome 并重建下游连接（归属清空，daemon 重连后重新分配）。"""
        keeper_mod.stop(self._config)
        await self._restart_downstream()

    # ── 会话分配（供 control 调用）──

    async def alloc_session(self, name: str) -> tuple[ProxySession, str]:
        """分配 session 并预开一个归属 tab，返回 (session, cdpUrl)。"""
        await self._ensure_downstream()
        session = self.state.alloc(name)
        # 预开专属 tab：保证 getTargets 非空 + 与基座自身 UI 隔离
        await self._ds_command(
            session,
            None,
            "Target.createTarget",
            {"url": "about:blank", "background": True},
            tag="create",
        )
        # 分配即排程回收：覆盖「分配后从未连接」的泄漏（连接中会被跳过）
        asyncio.create_task(
            self._schedule_reap(session, self._settings.settings.alloc_reap_seconds)
        )
        url = f"ws://127.0.0.1:{self._ws_port}/cdp/{session.token}"
        return session, url

    async def release_session(self, name: str) -> None:
        """释放 session：关掉名下 tab 后摘除。"""
        targets = self.state.release(name)
        closed = 0
        for tid in targets:
            try:
                await self._ds_raw("Target.closeTarget", {"targetId": tid})
                closed += 1
            except (OSError, websockets.WebSocketException):
                logger.exception("关闭 tab %s 失败（session %s）", tid[:8], name)
        logger.info("session %s 已释放（关闭 %d/%d 个 tab）", name, closed, len(targets))

    # ── 上游（agent-browser daemon）──

    async def _handle_upstream(self, ws: websockets.ServerConnection) -> None:
        """每个消费 session 一条上游连接的处理循环。"""
        request = getattr(ws, "request", None)
        path = request.path if request is not None else ""
        token = str(path or "").rsplit("/", 1)[-1]
        session = self.state.find_by_token(token)
        if session is None:
            await ws.close(code=4401, reason="unknown token")
            return
        if session.connected and session.ws is not None:
            # 顶掉旧连接（daemon 重启场景）
            with contextlib.suppress(Exception):
                await session.ws.close(code=4400, reason="superseded")
        session.connected = True
        session.ws = ws
        logger.info("session %s 上游连接接入", session.name)
        try:
            async for raw in ws:
                await self._on_upstream_message(session, raw)
        except websockets.ConnectionClosed:
            pass
        finally:
            if session.ws is ws:
                session.connected = False
                session.ws = None
                logger.info("session %s 上游连接断开", session.name)
                asyncio.create_task(
                    self._schedule_reap(session, self._settings.settings.disconnect_reap_seconds)
                )

    async def _schedule_reap(self, session: ProxySession, delay: float) -> None:
        """延迟回收（到期仍非连接态才动手；连接中跳过）。"""
        await asyncio.sleep(delay)
        if not session.connected and self.state.sessions.get(session.name) is session:
            await self.release_session(session.name)

    async def _on_upstream_message(self, session: ProxySession, raw: str | bytes) -> None:
        """处理上游消息：命令 → 越权检查 → id 重映射 → 转发下游。"""
        try:
            msg: dict[str, Any] = json.loads(raw)
        except (ValueError, TypeError):
            logger.warning("session %s 非法消息丢弃", session.name)
            return
        method = msg.get("method", "")
        params = msg.get("params", {}) or {}
        up_id = msg.get("id")

        # ── 越权/归属相关的守卫 ──
        if method == "Target.attachToTarget":
            tid = str(params.get("targetId", ""))
            owner = self.state.owner_of(tid)
            if owner is not None and owner is not session:
                await self._reject(session, up_id, f"target {tid} 属于其他 session")
                return
        if method == "Target.closeTarget":
            tid = str(params.get("targetId", ""))
            owner = self.state.owner_of(tid)
            if owner is not None and owner is not session:
                await self._reject(session, up_id, f"target {tid} 属于其他 session")
                return

        tag: str | None = None
        if method == "Target.createTarget":
            tag = "create"
        elif method == "Target.attachToTarget":
            tag = "attach"
        elif method == "Target.getTargets":
            tag = "gettargets"

        out = dict(msg)
        if up_id is not None:
            out["id"] = self.state.next_ds_id(session, int(up_id), tag)
        # sessionId 身份传递（每 session 独立 attach，字符串天然不冲突）
        await self._ds_send(json.dumps(out))

    async def _reject(
        self, session: ProxySession, up_id: Any, message: str
    ) -> None:
        """向上游回一个 CDP 错误响应（拒绝越权命令）。"""
        if up_id is None:
            return
        resp = {
            "id": int(up_id),
            "error": {"code": -32000, "message": f"ab-proxy: {message}"},
        }
        if session.ws is not None:
            with contextlib.suppress(Exception):
                await session.ws.send(json.dumps(resp))

    # ── 下游（Chrome）──

    async def _ds_recv_loop(self) -> None:
        """下游消息循环：响应还原 + 事件路由。"""
        downstream = self._downstream
        assert downstream is not None
        try:
            async for raw in downstream:
                await self._on_downstream_message(raw)
        except websockets.ConnectionClosed:
            logger.warning("下游连接断开，触发重建")
            await self._restart_downstream()

    async def _on_downstream_message(self, raw: str | bytes) -> None:
        """处理下游消息：响应（id 还原/标签加工）或事件（归属路由）。"""
        try:
            msg: dict[str, Any] = json.loads(raw)
        except (ValueError, TypeError):
            return

        if "id" in msg:
            await self._on_ds_response(msg)
        elif "method" in msg:
            await self._on_ds_event(msg)

    async def _on_ds_response(self, msg: dict[str, Any]) -> None:
        """下游响应：取回关联 → 标签加工 → 还原上游 id 回给来源 session。"""
        entry = self.state.take_pending(int(msg["id"]))
        if entry is None:
            return  # 未知命令（外部观察者注入），忽略
        session, up_id, tag = entry
        if session is None:
            return  # 服务自管理命令（回收关 tab 等），无需回传上游

        if tag == "create":
            target_id = str((msg.get("result") or {}).get("targetId", ""))
            if target_id:
                self.state.own_target(session, target_id)
                logger.info("session %s 获得 tab %s", session.name, target_id[:8])
        elif tag == "attach":
            ds_sid = str((msg.get("result") or {}).get("sessionId", ""))
            if ds_sid:
                self.state.bind_ds_session(session, ds_sid)
        elif tag == "gettargets":
            infos = (msg.get("result") or {}).get("targetInfos", [])
            msg["result"] = {
                "targetInfos": [
                    info
                    for info in infos
                    if self.state.owner_of(str(info.get("targetId", ""))) is session
                ]
            }

        if up_id is not None and session.ws is not None:
            out = dict(msg)
            out["id"] = up_id
            with contextlib.suppress(Exception):
                await session.ws.send(json.dumps(out))

    async def _on_ds_event(self, msg: dict[str, Any]) -> None:
        """下游事件：按归属路由；未归属事件对 session 不可见。"""
        method = str(msg.get("method", ""))
        params = msg.get("params", {}) or {}
        ds_sid = msg.get("sessionId")

        if ds_sid is not None:
            # attach 后的定向事件（Runtime/Page/Log 域）
            session = self.state.session_of_ds(str(ds_sid))
            if session is not None and session.ws is not None:
                with contextlib.suppress(Exception):
                    await session.ws.send(json.dumps(msg))
            return

        if method == "Target.attachedToTarget":
            # flatten 自动附着的会话绑定：tab 归属谁，事件就归谁
            tid = str((params.get("targetInfo") or {}).get("targetId", ""))
            session = self.state.owner_of(tid)
            sid = str(params.get("sessionId", ""))
            if session is not None and sid:
                self.state.bind_ds_session(session, sid)
                if session.ws is not None:
                    with contextlib.suppress(Exception):
                        await session.ws.send(json.dumps(msg))
            return

        if method == "Target.detachedFromTarget":
            self.state.unbind_ds_session(str(params.get("sessionId", "")))
            return

        if method in ("Target.targetCreated", "Target.targetInfoChanged"):
            tid = str((params.get("targetInfo") or {}).get("targetId", ""))
            session = self.state.owner_of(tid)
            if session is not None and session.ws is not None:
                with contextlib.suppress(Exception):
                    await session.ws.send(json.dumps(msg))
            return

        if method == "Target.targetDestroyed":
            tid = str(params.get("targetId", ""))
            session = self.state.owner_of(tid)
            self.state.drop_target(tid)
            if session is not None and session.ws is not None:
                with contextlib.suppress(Exception):
                    await session.ws.send(json.dumps(msg))
            return

        # 其余浏览器级事件（如 Target.recorder 细流）不向 session 透传

    # ── 下游发送原语 ──

    async def _ds_send(self, text: str) -> None:
        """发送原始文本到下游（确保连接存在）。"""
        await self._ensure_downstream()
        downstream = self._downstream
        assert downstream is not None
        await downstream.send(text)

    async def _ds_raw(self, method: str, params: dict[str, Any]) -> Any:
        """服务自身发起的下游命令（fire-and-forget，响应经 pending 空转忽略）。"""
        ds_id = self.state.next_ds_id(None, None, None)
        payload = json.dumps({"id": ds_id, "method": method, "params": params})
        await self._ds_send(payload)

    async def _ds_command(
        self,
        session: ProxySession,
        up_id: int | None,
        method: str,
        params: dict[str, Any],
        tag: str | None = None,
    ) -> None:
        """带关联登记的下游命令发送。"""
        ds_id = self.state.next_ds_id(session, up_id, tag)
        payload = json.dumps({"id": ds_id, "method": method, "params": params})
        await self._ds_send(payload)

    # ── 状态查询（供 control）──

    def status(self) -> dict[str, Any]:
        """代理与基座状态快照。"""
        return {
            "downstream": "open" if self._downstream is not None else "closed",
            "sessions": [
                {
                    "name": s.name,
                    "connected": s.connected,
                    "targets": len(s.owned_targets),
                }
                for s in self.state.sessions.values()
            ],
        }
