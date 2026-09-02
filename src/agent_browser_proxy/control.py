"""HTTP 控制面：plugin 与运维的入口。

跑在独立端口的 stdlib 线程 HTTP 服务，与 asyncio 主循环用
run_coroutine_threadsafe 桥接。端点：

- GET  /health                     → 存活探针
- GET  /status                     → 基座 + 会话 + 归属快照
- POST /sessions      {"name":..}  → 分配会话，返回代理 cdpUrl
- POST /sessions/<name>/release    → 释放会话（关名下 tab）
- POST /shutdown                   → 优雅停机
"""

import asyncio
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from . import keeper as keeper_mod
from .keeper import KeeperConfig

logger = logging.getLogger(__name__)


def make_control_server(
    proxy: Any,
    config: KeeperConfig,
    loop: asyncio.AbstractEventLoop,
    port: int,
    on_shutdown: Callable[[], None],
) -> ThreadingHTTPServer:
    """构造控制面 HTTP 服务（未启动）。

    :param proxy: CdpProxy 实例（alloc/release/status）。
    :param config: 基座配置（状态查询用）。
    :param loop: asyncio 主循环（桥接跨线程调用）。
    :param port: 控制端口。
    :param on_shutdown: 停机回调（主线程收尾用）。
    """

    class Handler(BaseHTTPRequestHandler):
        def _send(self, code: int, body: dict[str, Any]) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return {}
            try:
                return json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return {}

        def log_message(self, fmt: str, *args: Any) -> None:  # 静默默认访问日志
            logger.debug("control %s %s", self.command, self.path)

        def do_GET(self) -> None:  # noqa: N802（stdlib 命名约定）
            if self.path == "/health":
                self._send(200, {"status": "ok"})
            elif self.path == "/status":
                snap = proxy.status()
                snap["keeper"] = {
                    "chrome": "alive" if keeper_mod.chrome_alive(config) else "dead",
                    "cdp_port": config.cdp_port,
                    "profile": str(config.profile_dir),
                }
                self._send(200, snap)
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path == "/sessions":
                body = self._read_json()
                name = str(body.get("name", "")).strip()
                if not name:
                    self._send(422, {"error": "name 必填"})
                    return
                fut = asyncio.run_coroutine_threadsafe(proxy.alloc_session(name), loop)
                try:
                    _session, url = fut.result(timeout=60)
                    self._send(200, {"name": name, "cdpUrl": url})
                except TimeoutError:
                    self._send(504, {"error": "alloc 超时"})
                except Exception as exc:  # 控制面边界：向调用方回因
                    logger.exception("alloc_session 失败")
                    self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
                return

            if self.path.endswith("/release"):
                name = self.path[len("/sessions/") : -len("/release")]
                if not name:
                    self._send(422, {"error": "name 必填"})
                    return
                fut = asyncio.run_coroutine_threadsafe(proxy.release_session(name), loop)
                try:
                    fut.result(timeout=60)
                    self._send(200, {"released": name})
                except TimeoutError:
                    self._send(504, {"error": "release 超时"})
                except Exception as exc:
                    logger.exception("release_session 失败")
                    self._send(500, {"error": f"{type(exc).__name__}: {exc}"})
                return

            if self.path == "/shutdown":
                self._send(200, {"status": "shutting-down"})
                on_shutdown()
                return

            self._send(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    """后台线程跑控制面。"""
    thread = threading.Thread(target=server.serve_forever, name="ab-proxy-control")
    thread.daemon = True
    thread.start()
    return thread
