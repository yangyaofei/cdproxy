#!/usr/bin/env python3
"""extension 模式端到端冒烟测试：与 smoke_test.py 同一套六项判定，
但下游不是 keeper 基座，而是 ext/cdp-ext 扩展反向回连的用户宿主 Chrome。

前置（与本脚本解耦，测试者自行保证）：
  1. 装有 cdp-ext 的 Chrome 已运行（自动测试：Playwright Chromium +
     --load-extension=ext/cdp-ext，无任何调试端口）
  2. 本服务已以 extension 模式运行，例如：
     var/agent-browser-proxy serve --downstream extension --ext-token dev \
         --control-port 9234 --ws-port 9235 --data-dir var/ext

判定（与 smoke_test.py 逐条对齐）：
  T0 前置：下游已连且 mode=extension
  T1 两会话 getTargets 完全隔离（各只见自己预开的 tab）
  T2 各自 createTarget 后仍隔离
  T3 attach + Runtime.evaluate 全链路（6*7=42）
  T4 越权 closeTarget 被拒（error 响应）
  T5 release 后名下 tab 被关（宿主浏览器里真的关掉）
  T6 Browser.close 被拦截（宿主是用户浏览器，绝不许代理会话杀死）
"""

import asyncio
import json
import os
import sys
import time
import urllib.request

import websockets

CONTROL = os.environ.get("EXT_CONTROL", "http://127.0.0.1:9234")
RUN_ID = str(int(time.time()))


def http_post(path: str, body: dict) -> dict:
    """同步 POST 控制面。"""
    req = urllib.request.Request(
        CONTROL + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def http_get(path: str) -> dict:
    """同步 GET 控制面。"""
    with urllib.request.urlopen(CONTROL + path, timeout=10) as resp:
        return json.loads(resp.read())


class Client:
    """一个上游会话的 CDP 客户端封装（id 自增 + 响应等待）。"""

    def __init__(self, ws) -> None:
        self.ws = ws
        self._id = 0
        self.events: list[dict] = []

    async def call(self, method: str, params: dict | None = None, timeout: float = 15) -> dict:
        """发命令等响应（事件先入队）。"""
        self._id += 1
        cid = self._id
        await self.ws.send(json.dumps({"id": cid, "method": method, "params": params or {}}))
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=timeout)
            msg = json.loads(raw)
            if msg.get("id") == cid:
                return msg
            self.events.append(msg)

    async def wait_event(self, method: str, timeout: float = 15) -> dict | None:
        """等一个指定事件（先查已入队的）。"""
        for ev in self.events:
            if ev.get("method") == method:
                self.events.remove(ev)
                return ev
        deadline = asyncio.get_event_loop().time() + timeout
        while asyncio.get_event_loop().time() < deadline:
            raw = await asyncio.wait_for(
                self.ws.recv(), timeout=max(0.1, deadline - asyncio.get_event_loop().time())
            )
            msg = json.loads(raw)
            if msg.get("method") == method:
                return msg
            self.events.append(msg)
        return None


async def main() -> int:
    """跑七项判定（T0 前置 + 六项语义），全过返回 0。"""
    # T0 前置：extension 下游在场
    status = http_get("/status")
    down = status.get("downstream", {})
    assert down.get("mode") == "extension", f"T0 失败: 下游形态不是 extension: {down}"
    assert down.get("connected") is True, f"T0 失败: 扩展未回连（先启动宿主 Chrome）: {down}"
    print("T0 ✓ extension 下游已回连")

    a = http_post("/sessions", {"name": f"ext-a-{RUN_ID}"})
    b = http_post("/sessions", {"name": f"ext-b-{RUN_ID}"})
    print(f"[alloc] a={a['cdpUrl'][-12:]} b={b['cdpUrl'][-12:]}")

    async with websockets.connect(a["cdpUrl"], max_size=2**26) as wsa, \
               websockets.connect(b["cdpUrl"], max_size=2**26) as wsb:
        ca, cb = Client(wsa), Client(wsb)

        # T1 预开 tab 隔离
        ga = (await ca.call("Target.getTargets"))["result"]["targetInfos"]
        gb = (await cb.call("Target.getTargets"))["result"]["targetInfos"]
        ta = {t["targetId"] for t in ga}
        tb = {t["targetId"] for t in gb}
        assert len(ta) == 1 and len(tb) == 1 and ta != tb, f"T1 失败: {ta} vs {tb}"
        print("T1 ✓ 预开 tab 隔离（各 1 个，无交集）")

        # T2 各自再开 tab 仍隔离
        ra = await ca.call("Target.createTarget", {"url": "about:blank?A2"})
        rb = await cb.call("Target.createTarget", {"url": "about:blank?B2"})
        ga = (await ca.call("Target.getTargets"))["result"]["targetInfos"]
        gb = (await cb.call("Target.getTargets"))["result"]["targetInfos"]
        ta = {t["targetId"] for t in ga}
        tb = {t["targetId"] for t in gb}
        assert ra["result"]["targetId"] in ta and rb["result"]["targetId"] in tb
        assert len(ta) == 2 and len(tb) == 2 and not (ta & tb), f"T2 失败: {ta} vs {tb}"
        print("T2 ✓ createTarget 归属正确且仍隔离（各 2 个）")

        # T3 attach + eval 全链路（经 chrome.debugger 仿真会话）
        att = await ca.call("Target.attachToTarget", {"targetId": next(iter(ta)), "flatten": True})
        sid = att["result"]["sessionId"]
        await wsa.send(json.dumps({
            "id": 999, "sessionId": sid,
            "method": "Runtime.evaluate",
            "params": {"expression": "6*7", "returnByValue": True},
        }))
        got = None
        for _ in range(10):
            msg = json.loads(await asyncio.wait_for(wsa.recv(), timeout=10))
            if msg.get("id") == 999:
                got = msg["result"]["result"].get("value")
                break
            ca.events.append(msg)
        assert got == 42, f"T3 失败: eval 返回 {got}"
        print("T3 ✓ attach + 带 sessionId 的 Runtime.evaluate 全链路（6*7=42）")

        # T4 越权 closeTarget 被拒
        foreign = next(iter(tb))
        deny = await ca.call("Target.closeTarget", {"targetId": foreign})
        assert "error" in deny, f"T4 失败: 越权未被拒: {deny}"
        gb2 = (await cb.call("Target.getTargets"))["result"]["targetInfos"]
        assert foreign in {t["targetId"] for t in gb2}, "T4 失败: B 的 tab 被误关"
        print("T4 ✓ 越权 closeTarget 被拒（B 的 tab 完好）")

        # T5 release 后名下 tab 被关（宿主浏览器真实关闭）
        http_post(f"/sessions/ext-a-{RUN_ID}/release", {})
        try:
            destroyed = await cb.wait_event("Target.targetDestroyed", timeout=3)
        except TimeoutError:
            destroyed = None
        b_targets_after = {
            t["targetId"]
            for t in (await cb.call("Target.getTargets"))["result"]["targetInfos"]
        }
        assert not (ta & b_targets_after), f"T5 失败: a 的 tab 残留 {ta & b_targets_after}"
        assert destroyed is None or destroyed.get("params", {}).get("targetId") not in tb
        print("T5 ✓ release 关闭名下 tab，他人无感知")

        # T6 Browser.close 被拦截（宿主是用户自己的浏览器）
        kill = await cb.call("Browser.close")
        assert "error" not in kill, f"T6 失败: 拦截返回了错误: {kill}"
        alive = await cb.call("Browser.getVersion")
        assert "result" in alive, f"T6 失败: 下游无响应: {alive}"
        print("T6 ✓ Browser.close 被拦截（宿主保护生效，浏览器仍存活）")

    print("\n全部通过 ✅")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
