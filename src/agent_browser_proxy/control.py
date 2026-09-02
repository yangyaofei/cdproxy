"""HTTP 控制面：plugin、运维与 Admin 页面的入口。

跑在独立端口的 stdlib 线程 HTTP 服务，与 asyncio 主循环用
run_coroutine_threadsafe 桥接。端点分组：

- 静态：GET /（Admin 单页）、GET /static/<file>
- 运维：GET /health、GET /status、GET /logs/tail、POST /shutdown、POST /keeper/restart
- 会话：POST /sessions、POST /sessions/<name>/release
- 设置：GET /settings、PUT /settings（在线生效，见 settings.py）
"""

import asyncio
import json
import logging
import mimetypes
import threading
import urllib.parse
from collections.abc import Callable
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import keeper as keeper_mod
from .keeper import KeeperConfig
from .settings import SettingsStore

logger = logging.getLogger(__name__)

# 仓库根 static/admin（静态资产不入包，与 mh-ai-service #133 约定一致）
_STATIC_DIR = Path(__file__).resolve().parents[2] / "static" / "admin"
_LOG_TAIL_LINES = 200


def make_control_server(
    proxy: Any,
    config: KeeperConfig,
    loop: asyncio.AbstractEventLoop,
    port: int,
    settings_store: SettingsStore,
    log_file: Path | None,
    on_shutdown: Callable[[], None],
) -> ThreadingHTTPServer:
    """构造控制面 HTTP 服务（未启动）。

    :param proxy: CdpProxy 实例（alloc/release/status/重启基座）。
    :param config: 基座配置（状态查询与重启用）。
    :param loop: asyncio 主循环（桥接跨线程调用）。
    :param port: 控制端口。
    :param settings_store: 运行时设置存储。
    :param log_file: 服务日志路径（/logs/tail 读它）。
    :param on_shutdown: 停机回调（主线程收尾用）。
    """

    class Handler(BaseHTTPRequestHandler):
        def _send_json(self, code: int, body: dict[str, Any]) -> None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _send_file(self, path: Path) -> None:
            """发送静态文件（404 兜底）。"""
            if not path.is_file():
                self._send_json(404, {"error": "not found"})
                return
            mime, _ = mimetypes.guess_type(str(path))
            data = path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mime or "application/octet-stream")
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

        def _static_path(self, rel: str) -> Path | None:
            """解析静态文件路径（防目录穿越）。"""
            resolved = (_STATIC_DIR / rel).resolve()
            if not str(resolved).startswith(str(_STATIC_DIR)):
                return None
            return resolved

        def do_GET(self) -> None:
            parsed = urllib.parse.urlparse(self.path)
            route = parsed.path

            if route in ("/", "/index.html"):
                self._send_file(_STATIC_DIR / "index.html")
                return
            if route.startswith("/static/"):
                path = self._static_path(route[len("/static/"):])
                self._send_file(path if path else _STATIC_DIR / "404")
                return
            if route == "/health":
                self._send_json(200, {"status": "ok"})
                return
            if route == "/status":
                snap = proxy.status()
                snap["keeper"] = {
                    "chrome": "alive" if keeper_mod.chrome_alive(config) else "dead",
                    "cdp_port": config.cdp_port,
                    "profile": str(config.profile_dir),
                    "chrome_path": config.chrome_path,
                }
                snap["settings"] = asdict(settings_store.settings)
                self._send_json(200, snap)
                return
            if route == "/settings":
                self._send_json(200, asdict(settings_store.settings))
                return
            if route == "/logs/tail":
                lines = _tail(log_file, _LOG_TAIL_LINES) if log_file else []
                self._send_json(200, {"lines": lines})
                return
            self._send_json(404, {"error": "not found"})

        def do_PUT(self) -> None:
            if urllib.parse.urlparse(self.path).path == "/settings":
                patch = self._read_json()
                try:
                    updated = settings_store.update(patch)
                except ValueError as exc:
                    self._send_json(422, {"error": str(exc)})
                    return
                self._send_json(200, asdict(updated))
                return
            self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:
            route = urllib.parse.urlparse(self.path).path

            if route == "/sessions":
                body = self._read_json()
                name = str(body.get("name", "")).strip()
                if not name:
                    self._send_json(422, {"error": "name 必填"})
                    return
                fut = asyncio.run_coroutine_threadsafe(proxy.alloc_session(name), loop)
                try:
                    _session, url = fut.result(timeout=60)
                    self._send_json(200, {"name": name, "cdpUrl": url})
                except TimeoutError:
                    self._send_json(504, {"error": "alloc 超时"})
                except Exception as exc:  # 控制面边界：向调用方回因
                    logger.exception("alloc_session 失败")
                    self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return

            if route.endswith("/release"):
                name = route[len("/sessions/") : -len("/release")]
                if not name:
                    self._send_json(422, {"error": "name 必填"})
                    return
                fut = asyncio.run_coroutine_threadsafe(proxy.release_session(name), loop)
                try:
                    fut.result(timeout=60)
                    self._send_json(200, {"released": name})
                except TimeoutError:
                    self._send_json(504, {"error": "release 超时"})
                except Exception as exc:
                    logger.exception("release_session 失败")
                    self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return

            if route == "/keeper/restart":
                keeper_mod.stop(config)
                fut = asyncio.run_coroutine_threadsafe(proxy.restart_keeper(), loop)
                try:
                    fut.result(timeout=60)
                    self._send_json(200, {"restarted": True})
                except TimeoutError:
                    self._send_json(504, {"error": "keeper 重启超时"})
                except Exception as exc:
                    logger.exception("keeper 重启失败")
                    self._send_json(500, {"error": f"{type(exc).__name__}: {exc}"})
                return

            if route == "/shutdown":
                self._send_json(200, {"status": "shutting-down"})
                on_shutdown()
                return

            self._send_json(404, {"error": "not found"})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    return server


def serve_in_thread(server: ThreadingHTTPServer) -> threading.Thread:
    """后台线程跑控制面，返回线程对象。"""
    thread = threading.Thread(target=server.serve_forever, name="ab-proxy-control")
    thread.daemon = True
    thread.start()
    return thread


def _tail(path: Path | None, lines: int) -> list[str]:
    """读日志尾部 N 行（文件缺失返回空表）。"""
    if path is None or not path.is_file():
        return []
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return content.splitlines()[-lines:]
