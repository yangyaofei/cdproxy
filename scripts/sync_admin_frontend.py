#!/usr/bin/env python3
"""同步 Admin 前端到桌面 App（Wails）工程。

单一源原则：static/admin 是唯一事实源；desktop/frontend 的 src/admin 与
index.html 均由本脚本生成（--check 模式校验一致性，CI/发布前跑）。

变换规则：
- app.js / app.css / vendor/alpine.min.js 原样拷入 desktop/frontend/src/admin/
- index.html：静态资源引用 /static/* 改写为 /src/admin/*（Vite 处理），
  并注入 Wails 绑定引导模块（window.__abpWails.doRequest = EngineService
  .DoRequest，app.js 的 api() 检测到即走进程内绑定，不依赖外部端口）。
"""

from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "static" / "admin"
DST = REPO / "desktop" / "frontend"

BOOTSTRAP = """  <!-- Wails 绑定引导：注入 window.__abpWails，app.js 的 api() 优先走它 -->
  <script type="module">
    import { DoRequest } from "/bindings/github.com/yangyaofei/agent-browser-proxy/desktop/engineservice.js";
    window.__abpWails = { doRequest: DoRequest };
  </script>"""


def build_index() -> str:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    html = re.sub(
        r'<link rel="stylesheet" href="/static/app.css[^"]*">',
        '<link rel="stylesheet" href="/src/admin/app.css">',
        html,
    )
    html = re.sub(
        r'<script src="/static/app\.js[^"]*" defer></script>\s*<script src="/static/vendor/alpine\.min\.js" defer></script>',
        f"{BOOTSTRAP}\n  <script type=\"module\" src=\"/src/admin/app.js\"></script>\n  <script type=\"module\" src=\"/src/admin/vendor/alpine.min.js\"></script>",
        html,
    )
    if "/static/" in html:
        raise SystemExit("index.html 仍有未改写的 /static/ 引用")
    if "__abpWails" not in html:
        raise SystemExit("绑定引导注入失败（正则未命中 script 标签）")
    return html


def main() -> int:
    check = "--check" in sys.argv
    admin_dst = DST / "src" / "admin"
    admin_dst.mkdir(parents=True, exist_ok=True)
    (admin_dst / "vendor").mkdir(exist_ok=True)

    copies = [
        (SRC / "app.js", admin_dst / "app.js"),
        (SRC / "app.css", admin_dst / "app.css"),
        (SRC / "vendor" / "alpine.min.js", admin_dst / "vendor" / "alpine.min.js"),
    ]
    index = build_index()

    if check:
        ok = all(
            dst.exists() and src.read_bytes() == dst.read_bytes() for src, dst in copies
        ) and (DST / "index.html").exists() and (DST / "index.html").read_text(encoding="utf-8") == index
        print("admin 同步一致性: " + ("OK" if ok else "STALE — 跑 python3 scripts/sync_admin_frontend.py"))
        return 0 if ok else 1

    for src, dst in copies:
        shutil.copyfile(src, dst)
    (DST / "index.html").write_text(index, encoding="utf-8")
    print(f"已同步 {len(copies)} 个文件 + index.html → {DST}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
