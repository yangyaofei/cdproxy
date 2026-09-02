"""共享 Chrome（基座）生命周期管理。

被并入代理服务一体管理：负责在固定调试端口上拉起/复用一个带登录态
profile 的 Chrome，处理 stale SingletonLock 清理与就绪探测。

启动方式沿用已验证的模式：subprocess + start_new_session 脱离进程组，
避免服务退出连带杀掉 Chrome（或反之）。
"""

import json
import logging
import os
import shutil
import signal
import subprocess
import time
import urllib.request
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

# 探活/就绪轮询参数
_READY_TIMEOUT_SECONDS = 15.0
_READY_INTERVAL_SECONDS = 0.2
_PROBE_TIMEOUT_SECONDS = 2.0


@dataclass(frozen=True)
class KeeperConfig:
    """基座配置。

    :param chrome_path: Chrome 可执行文件路径。
    :param profile_dir: Chrome 用户数据目录（承载共享登录态）。
    :param cdp_port: Chrome 调试端口（固定，代理下游连这里）。
    :param headless: 是否无头运行（默认有头，登录态需要可视化）。
    """

    chrome_path: str
    profile_dir: Path
    cdp_port: int
    headless: bool = False

    @classmethod
    def defaults(cls) -> "KeeperConfig":
        """默认配置：macOS Chrome + ~/agent-browser/profile + 9222。"""
        chrome = shutil.which("google-chrome") or (
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        )
        return cls(
            chrome_path=chrome,
            profile_dir=Path.home() / "agent-browser" / "profile",
            cdp_port=9222,
        )


class KeeperError(RuntimeError):
    """基座启动/探活失败。"""


def _http_get_json(url: str, timeout: float) -> dict | None:
    """GET 一个 JSON 端点，失败返回 None（不抛网络异常）。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (OSError, ValueError):
        return None


def chrome_alive(config: KeeperConfig) -> bool:
    """探测调试端口上的 Chrome 是否可用（/json/version 可达即视为活）。"""
    info = _http_get_json(
        f"http://127.0.0.1:{config.cdp_port}/json/version", _PROBE_TIMEOUT_SECONDS
    )
    return info is not None and "webSocketDebuggerUrl" in info


def browser_ws_url(config: KeeperConfig) -> str:
    """返回浏览器级 WS 地址（每次启动会变，需现查）。"""
    info = _http_get_json(
        f"http://127.0.0.1:{config.cdp_port}/json/version", _PROBE_TIMEOUT_SECONDS
    )
    if info is None or "webSocketDebuggerUrl" not in info:
        raise KeeperError("Chrome 未就绪：/json/version 不可达")
    return str(info["webSocketDebuggerUrl"])


def _chrome_pid(config: KeeperConfig) -> int | None:
    """找到持有指定 user-data-dir 的 Chrome 主进程 PID（未找到返回 None）。"""
    marker = f"user-data-dir={config.profile_dir}"
    try:
        out = subprocess.run(
            ["pgrep", "-f", marker],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines():
        pid = int(line)
        # 只认主进程（命令行直接带 marker 的）；渲染子进程路径不含该参数
        cmdline = subprocess.run(
            ["ps", "-o", "command=", "-p", str(pid)],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        ).stdout
        if marker in cmdline:
            return pid
    return None


def _clean_stale_locks(config: KeeperConfig) -> None:
    """清理 stale 单例锁（能走到启动说明无活进程，锁必为残留）。"""
    for name in ("SingletonLock", "SingletonCookie", "SingletonSocket"):
        target = config.profile_dir / name
        try:
            if target.is_symlink() or target.exists():
                target.unlink()
        except OSError as exc:
            logger.warning("清理 %s 失败: %s", name, exc)


def ensure_running(config: KeeperConfig) -> str:
    """确保调试端口上有一个可用 Chrome，返回浏览器级 WS 地址。

    - 端口已可达 → 直接复用（可能是本服务先前拉起，也可能是外部实例）
    - 不可达 → 清 stale 锁后拉起新实例，轮询就绪
    :raises KeeperError: 就绪超时。
    """
    if chrome_alive(config):
        url = browser_ws_url(config)
        logger.info("Chrome 复用中: %s", url)
        return url

    if _chrome_pid(config) is not None:
        # 进程在但端口不通：半死状态，先杀再重启
        logger.warning("Chrome 进程存活但调试端口不通，重启")
        stop(config)

    config.profile_dir.mkdir(parents=True, exist_ok=True)
    _clean_stale_locks(config)

    args = [
        config.chrome_path,
        f"--remote-debugging-port={config.cdp_port}",
        f"--user-data-dir={config.profile_dir}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    if config.headless:
        args.append("--headless=new")
    logger.info("启动 Chrome: %s", " ".join(args[:4]) + " …")
    # start_new_session：脱离服务进程组，服务重启不连坐 Chrome
    subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )

    deadline = time.monotonic() + _READY_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if chrome_alive(config):
            url = browser_ws_url(config)
            logger.info("Chrome 就绪: %s", url)
            return url
        time.sleep(_READY_INTERVAL_SECONDS)
    raise KeeperError(f"Chrome {_READY_TIMEOUT_SECONDS}s 内未就绪（端口 {config.cdp_port}）")


def stop(config: KeeperConfig) -> bool:
    """停掉基座 Chrome（精确 PID，绝不无差别杀）。返回是否有进程被终止。"""
    pid = _chrome_pid(config)
    if pid is None:
        return False
    try:
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
        try:
            os.kill(pid, 0)
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        logger.info("Chrome 已停止 (pid=%s)", pid)
        return True
    except OSError as exc:
        logger.warning("停止 Chrome (pid=%s) 失败: %s", pid, exc)
        return False
