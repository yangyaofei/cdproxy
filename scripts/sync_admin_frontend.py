#!/usr/bin/env python3
"""sync_admin_frontend.py — Admin 前端单一源同步（static/admin → desktop/frontend）。

Web 版（control 静态服务）与 Wails App 版共用 static/admin 源文件：
  - app.js / app.css / vendor 原样拷到 desktop/frontend/public/static/…
    （vite 原样搬运 public/ → dist/，脚本保持经典 defer 加载顺序，
     不经模块打包——曾因改写为 /src/ 模块入口被 vite 丢弃，App 白屏）
  - index.html 注入 Wails 绑定引导（window.__cdpWails = EngineService
    绑定 + 同步错误收集器 __abpErrors），其余引用保持 /static/… 原样

--check 校验同步一致性（CI/提交前跑）。
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "static" / "admin"
DST = ROOT / "desktop" / "frontend"

BOOTSTRAP = """  <!-- Wails 绑定引导：注入 window.__cdpWails，app.js 的 api() 优先走它 -->
  <script>
    // 同步错误收集器（先于 defer 脚本装上，app.js/Alpine 的早期异常不丢）
    window.__abpErrors = [];
    window.addEventListener('error', e => window.__abpErrors.push(String(e.message || e.error)));
    window.addEventListener('unhandledrejection', e => window.__abpErrors.push('promise: ' + String(e.reason)));
  </script>
  <script type="module">
    import { DoRequest, DumpDOM } from "/bindings/github.com/yangyaofei/cdproxy/desktop/engineservice.js";
    window.__cdpWails = { doRequest: DoRequest, dumpDOM: DumpDOM };
  </script>
  <!-- 事件系统：框架内置 runtime（/wails/runtime.js，运行时由 Wails 资产服务
       器提供）。放普通 script：vite 只处理 module script，此处动态 import 在
       运行时解析，不进构建图。 -->
  <script>
    const runtimeURL = "/wails/" + "runtime.js"; // 动态拼接：vite 构建期不解析（运行时路径）
    import(runtimeURL).then(m => {
      window.__wailsEvents = m.Events;
      window.dispatchEvent(new Event("wails-events-ready"));
    }).catch(() => {});
  </script>"""


def build_index() -> str:
    html = (SRC / "index.html").read_text(encoding="utf-8")
    marker = '<script src="/static/app.js'
    if marker not in html:
        raise SystemExit("index.html 缺少 /static/app.js 引用（结构变更？）")
    # 引导注入在 app.js 引用之前（错误收集器须先于一切 defer 脚本）
    html = html.replace(marker, f"{BOOTSTRAP}\n  {marker}", 1)
    if "__cdpWails" not in html:
        raise SystemExit("绑定引导注入失败")
    return html


def main() -> int:
    check = "--check" in sys.argv
    static_dst = DST / "public" / "static"
    (static_dst / "vendor").mkdir(parents=True, exist_ok=True)

    copies = [
        (SRC / "app.js", static_dst / "app.js"),
        (SRC / "app.css", static_dst / "app.css"),
        (SRC / "vendor" / "alpine.min.js", static_dst / "vendor" / "alpine.min.js"),
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
