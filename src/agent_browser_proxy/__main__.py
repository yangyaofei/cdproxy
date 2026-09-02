"""CLI 入口：serve / status / stop / version。"""

import argparse
import asyncio
import json
import logging
import os
import sys
import urllib.request

from . import __version__
from .service import (
    ServiceOptions,
    default_log_file,
    default_pid_file,
    run,
    service_alive,
    stop_service,
    write_pid_file,
)


def _build_parser() -> argparse.ArgumentParser:
    """构造 CLI 参数解析器。"""
    parser = argparse.ArgumentParser(
        prog="agent-browser-proxy",
        description="agent-browser 共享 Chrome 的 CDP 转发代理",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="前台运行服务（keeper + 代理 + 控制面）")
    serve.add_argument("--chrome", default=None, help="Chrome 可执行文件路径")
    serve.add_argument("--profile", default=None, help="Chrome 用户数据目录")
    serve.add_argument("--cdp-port", type=int, default=9222, help="Chrome 调试端口")
    serve.add_argument("--control-port", type=int, default=9224, help="控制面端口")
    serve.add_argument("--ws-port", type=int, default=9225, help="代理 WS 端口")

    sub.add_parser("status", help="查询服务与基座状态")
    sub.add_parser("stop", help="优雅停机")
    sub.add_parser("version", help="版本号")
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI 主入口。

    :param argv: 参数列表（测试用），缺省取 sys.argv。
    :return: 进程退出码。
    """
    args = _build_parser().parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    if args.command == "serve":
        options = ServiceOptions(
            chrome=args.chrome,
            profile=args.profile,
            cdp_port=args.cdp_port,
            control_port=args.control_port,
            ws_port=args.ws_port,
            log_file=default_log_file(),
        )
        write_pid_file(default_pid_file(), os.getpid())
        asyncio.run(run(options))
        return 0

    if args.command == "status":
        if not service_alive():
            print("服务未运行")
            return 1
        with urllib.request.urlopen(
            "http://127.0.0.1:9224/status", timeout=5
        ) as resp:
            print(json.dumps(json.load(resp), ensure_ascii=False, indent=2))
        return 0

    if args.command == "stop":
        ok = stop_service(default_pid_file())
        print("已发送停机信号" if ok else "服务未运行或停机失败")
        return 0 if ok else 1

    if args.command == "version":
        print(__version__)
        return 0

    return 2


if __name__ == "__main__":
    sys.exit(main())
