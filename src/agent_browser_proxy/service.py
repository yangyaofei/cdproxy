"""服务编排：keeper + CDP 代理 + 控制面的一体生命周期。"""

import asyncio
import contextlib
import logging
import os
import signal
import urllib.request
from pathlib import Path

from .control import make_control_server, serve_in_thread
from .keeper import KeeperConfig
from .proxy import CdpProxy
from .settings import SettingsStore, default_settings_path

logger = logging.getLogger(__name__)


class ServiceOptions:
    """运行参数（CLI 层组装）。"""

    def __init__(
        self,
        chrome: str | None = None,
        profile: str | None = None,
        cdp_port: int = 9222,
        control_port: int = 9224,
        ws_port: int = 9225,
        log_file: Path | None = None,
    ) -> None:
        base = KeeperConfig.defaults()
        self.config = KeeperConfig(
            chrome_path=chrome or base.chrome_path,
            profile_dir=Path(profile) if profile else base.profile_dir,
            cdp_port=cdp_port,
        )
        self.control_port = control_port
        self.ws_port = ws_port
        self.log_file = log_file


def _setup_logging(log_file: Path | None) -> None:
    """日志：文件 + stderr 双路。"""
    handlers: list[logging.Handler] = [logging.StreamHandler()]
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


async def run(options: ServiceOptions) -> None:
    """主入口：启动代理 + 控制面，挂住直到停机信号。"""
    _setup_logging(options.log_file)
    logger.info(
        "agent-browser-proxy 启动: cdp=%s control=%s ws=%s profile=%s",
        options.config.cdp_port,
        options.control_port,
        options.ws_port,
        options.config.profile_dir,
    )

    settings_store = SettingsStore(default_settings_path())
    proxy = CdpProxy(options.config, options.ws_port, settings_store)
    await proxy.start()

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _shutdown() -> None:
        loop.call_soon_threadsafe(stop_event.set)

    # 端口可能被停机中的前代实例短暂占用（TIME_WAIT/退出竞态），重试绑定
    control = None
    for attempt in range(10):
        try:
            control = make_control_server(
                proxy, options.config, loop, options.control_port,
                settings_store, log_file=options.log_file, on_shutdown=_shutdown,
            )
            break
        except OSError:
            logger.warning("控制面端口 %s 被占用，重试 %d/10", options.control_port, attempt + 1)
            await asyncio.sleep(1)
    if control is None:
        raise OSError(f"控制面端口 {options.control_port} 绑定失败（重试 10 次后放弃）")
    serve_in_thread(control)
    logger.info("控制面就绪: http://127.0.0.1:%s", options.control_port)

    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, stop_event.set)

    await stop_event.wait()
    logger.info("停机中…")
    control.shutdown()
    await proxy.stop()
    logger.info("已退出")


def write_pid_file(path: Path, pid: int) -> None:
    """落 PID 文件（status/stop 用）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(str(pid))


def read_pid_file(path: Path) -> int | None:
    """读 PID 文件；不存在或损坏返回 None。"""
    try:
        return int(path.read_text().strip())
    except (OSError, ValueError):
        return None


def default_pid_file() -> Path:
    """默认 PID 文件位置（仓库 var/ 下）。"""
    return Path(__file__).resolve().parents[2] / "var" / "agent-browser-proxy.pid"


def default_log_file() -> Path:
    """默认日志位置。"""
    return Path(__file__).resolve().parents[2] / "var" / "service.log"


def service_alive() -> bool:
    """探测本服务是否在跑（控制面 /health）。"""
    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:9224/health", timeout=2
        ) as resp:
            return resp.status == 200
    except OSError:
        return False


def stop_service(pid_file: Path) -> bool:
    """向服务发停机（HTTP 优先，退化为 SIGTERM）。"""
    try:
        urllib.request.urlopen(
            urllib.request.Request("http://127.0.0.1:9224/shutdown", method="POST"),
            timeout=5,
        )
        return True
    except OSError:
        pid = read_pid_file(pid_file)
        if pid is None:
            return False
        try:
            os.kill(pid, signal.SIGTERM)
            return True
        except OSError:
            return False
