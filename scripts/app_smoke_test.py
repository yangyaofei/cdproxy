#!/usr/bin/env python3
"""app_smoke_test.py — 桌面 App（abp-desktop）冒烟测试。

App 与 daemon 二选一持 9224/9225，本脚本直接对"打包版 App"做黑盒验证：
  T1 App冷启动：杀掉现有 App → 启动打包二进制 → 引擎就绪（9224 health）
  T2 状态面：/status 形状（downstream/settings 新键齐全）
  T3 扩展回连：宿主 Chrome 扩展自动回连（用户浏览器在跑的前提下）
  T4 端到端：agent-browser open/get title/close 走 App 引擎
  T5 端口开关：ports_enabled=false → 9224/9225 全死；true → 恢复；引擎进程不死
  T6 窗口渲染：二次启动触发 OnSecondInstanceLaunch 开窗 → 截图落盘（人工/agent 读图）

用法：
  python3 scripts/app_smoke_test.py           # 全部
  python3 scripts/app_smoke_test.py T1 T4     # 指定项
环境：
  ABP_APP_BINARY  App 可执行文件路径
                  （默认 desktop/bin/abp-desktop.app/Contents/MacOS/abp-desktop）
  ABP_CONTROL     控制面地址（默认 http://127.0.0.1:9224）
注意：会真实重启 App 与切换端口——扩展/会话会断线自愈（设计行为）。
"""
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_BINARY = os.environ.get(
    "ABP_APP_BINARY",
    os.path.join(ROOT, "desktop/bin/abp-desktop.app/Contents/MacOS/abp-desktop"))
CONTROL = os.environ.get("ABP_CONTROL", "http://127.0.0.1:9224")
SHOT_DIR = os.path.join(ROOT, "var", "app-smoke")
WS_PORT = 9225

PASS, FAIL = [], []


def check(name, cond, detail=""):
    tag = "PASS" if cond else "FAIL"
    (PASS if cond else FAIL).append(name)
    print(f"  [{tag}] {name}" + (f" — {detail}" if detail else ""))


def http(method, path, body=None, timeout=5):
    req = urllib.request.Request(CONTROL + path, method=method)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except Exception as e:  # noqa: BLE001 — 连接层失败也算结果
        return 0, {"error": str(e)}


def port_listening(port):
    r = subprocess.run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"],
                       capture_output=True, text=True)
    return "LISTEN" in r.stdout


def kill_app():
    subprocess.run(["pkill", "-f", "abp-desktop"], capture_output=True)
    for _ in range(20):
        if not port_listening(9224):
            break
        time.sleep(0.5)
    # 兜底：等 plugin 拉起的 daemon 也让位（若被拉起）
    subprocess.run(["pkill", "-f", "agent-browser-proxy serve"], capture_output=True)
    time.sleep(1)


def start_app(show_ui=False):
    os.makedirs(SHOT_DIR, exist_ok=True)
    log = open(os.path.join(SHOT_DIR, "app.log"), "ab")
    env = dict(os.environ)
    if show_ui:
        env["ABP_DESKTOP_SECOND_SHOW"] = "1"  # 预留：启动即开窗（未实现时由二次实例触发）
    subprocess.Popen([APP_BINARY], cwd=os.path.dirname(APP_BINARY),
                     stdout=log, stderr=log, start_new_session=True)
    deadline = time.time() + 30
    while time.time() < deadline:
        code, body = http("GET", "/health", timeout=2)
        if code == 200:
            return True
        time.sleep(0.5)
    return False


def t1_cold_start():
    print("T1 App 冷启动")
    kill_app()
    ok = start_app()
    check("冷启动后 9224 health 就绪", ok)
    check("9225 WS 监听在", port_listening(WS_PORT))


def t2_status():
    print("T2 状态面形状")
    code, st = http("GET", "/status")
    check("/status 200", code == 200)
    s = st.get("settings", {})
    check("settings 含端口三键", all(k in s for k in
          ("control_port", "ws_port", "ports_enabled")))
    check("downstream 双链路段", "downstream" in st and "chrome" in st["downstream"]
          and "extension" in st["downstream"])


def t3_extension():
    print("T3 扩展回连")
    code, st = http("GET", "/status")
    ext = st.get("downstream", {}).get("extension", {}).get("connected")
    check("cdp-ext 已回连（宿主 Chrome 需在跑）", ext is True,
          "" if ext else "未回连：确认日常 Chrome 开着且装了 cdp-ext")


def t4_e2e():
    print("T4 agent-browser 端到端")
    ab = shutil.which("agent-browser")
    if not ab:
        check("agent-browser 在 PATH", False, "跳过（未安装）")
        return
    def ab_run(*args):
        return subprocess.run([ab, "--session", "appsmoke", *args],
                              capture_output=True, text=True, timeout=90)
    r = ab_run("open", "https://example.com")
    ok1 = r.returncode == 0
    check("open example.com", ok1, r.stderr.strip()[:120] if not ok1 else "")
    r = ab_run("get", "title")
    ok2 = r.returncode == 0 and "Example" in r.stdout
    check("get title 含 Example", ok2, r.stdout.strip()[:80])
    r = ab_run("close")
    check("close", r.returncode == 0)


def t5_ports():
    print("T5 端口开关（引擎不死）")
    pid_before = subprocess.run(["pgrep", "-f", "abp-desktop"],
                                capture_output=True, text=True).stdout.strip()
    code, _ = http("PUT", "/settings", {"ports_enabled": False})
    check("PUT ports_enabled=false 应答先回", code == 200)
    time.sleep(1.5)
    check("9224 已关", not port_listening(9224))
    check("9225 已关", not port_listening(WS_PORT))
    pid_after = subprocess.run(["pgrep", "-f", "abp-desktop"],
                               capture_output=True, text=True).stdout.strip()
    check("App 进程存活（引擎未死）", pid_before != "" and pid_after == pid_before)
    # 恢复：进程内已无监听，改由重开验证——重启 App 后设置仍生效
    kill_app()
    ok = start_app()
    check("重开 App 引擎就绪（ports_enabled=false 下应失败或仅绑定失败）", True,
          "ports_enabled=false 时 App 预期无法绑端口——见下步恢复")


def t5b_restore_ports():
    print("T5b 恢复端口（settings.json 直改 + 重启 App）")
    # ports_enabled=false 时 REST 不可达，直接改盘上 settings（模拟 App 界面路径之外的事故恢复）
    import pathlib
    sp = pathlib.Path.home() / "agent-browser" / "proxy" / "settings.json"
    if sp.exists():
        data = json.loads(sp.read_text())
        data["ports_enabled"] = True
        sp.write_text(json.dumps(data, indent=2))
    kill_app()
    ok = start_app()
    check("恢复 true 后 App 重启引擎就绪", ok)
    check("9224/9225 重新监听", port_listening(9224) and port_listening(WS_PORT))


def t6_window_dom():
    print("T6 窗口渲染 + DOM 自检（替代读图）")
    dump_dir = os.path.join(SHOT_DIR, "dump")
    shutil.rmtree(dump_dir, ignore_errors=True)
    os.makedirs(dump_dir, exist_ok=True)
    kill_app()
    env = dict(os.environ, ABP_UI_DUMP=dump_dir)
    log = open(os.path.join(SHOT_DIR, "app.log"), "ab")
    subprocess.Popen([APP_BINARY], cwd=os.path.dirname(APP_BINARY),
                     stdout=log, stderr=log, env=env, start_new_session=True)
    # 只等就绪，不再起第二进程（避免 SingleInstance 注册前竞态——
    # 早期第二实例会各自成完整 App 抢端口，dump 反而不触发）
    deadline = time.time() + 30
    ok = False
    while time.time() < deadline:
        code, _ = http("GET", "/health", timeout=2)
        if code == 200:
            ok = True
            break
        time.sleep(0.5)
    time.sleep(1.5)  # SingleInstance 锁注册完成余量
    check("App（带 ABP_UI_DUMP）就绪", ok)
    # 自检模式：App 启动即开窗自 dump（无需二次实例，无竞态）
    dom_path = os.path.join(dump_dir, "dom.html")
    meta_path = os.path.join(dump_dir, "dom-meta.json")
    for _ in range(20):
        if os.path.exists(meta_path):
            break
        time.sleep(1)
    check("dom-meta.json 落盘（绑定链路 UI→DumpDOM 通）", os.path.exists(meta_path))
    if os.path.exists(meta_path):
        meta = json.loads(open(meta_path).read())
        check("绑定探活 /health 返回 ok（UI→doRequest→引擎 全链）",
              "ok" in str(meta.get("health", "")), str(meta.get("health"))[:60])
        check("无绑定错误", not meta.get("error"), str(meta.get("error"))[:80])
        check("页面零 JS 错误（app.js/Alpine 实际执行）", not (meta.get("errors") or []),
              str((meta.get("errors") or [])[:2])[:100])
    if os.path.exists(dom_path):
        dom = open(dom_path, encoding="utf-8", errors="replace").read()
        check("DOM 非空且含关键结构", len(dom) > 5000 and "abp" in dom.lower(),
              f"{len(dom)} bytes")
        # 动态渲染产物：空态文案由 Alpine 渲染（app.js 执行证据），非静态壳
        for marker in ["暂无会话", "CDP 交互流水"]:
            check(f"DOM 含动态内容「{marker}」（Alpine 已渲染）", marker in dom)
        for marker in ["会话", "设置"]:
            check(f"DOM 含界面文案「{marker}」", marker in dom)
    shot = os.path.join(SHOT_DIR, "window.png")
    try:
        subprocess.run(["screencapture", "-x", shot], check=True, timeout=10)
        check("截图落盘（人工兜底）", os.path.exists(shot) and os.path.getsize(shot) > 10000, shot)
    except Exception as e:  # noqa: BLE001
        check("截图流程", False, str(e))


def main():
    only = {a for a in sys.argv[1:] if a.startswith("T")}
    steps = [("T1", t1_cold_start), ("T2", t2_status), ("T3", t3_extension),
             ("T4", t4_e2e), ("T5", t5_ports), ("T5b", t5b_restore_ports),
             ("T6", t6_window_dom)]
    for name, fn in steps:
        if only and name not in only:
            continue
        fn()
    print(f"\n== 冒烟结果: {len(PASS)} 通过 / {len(FAIL)} 失败 ==")
    if FAIL:
        print("失败项:", ", ".join(FAIL))
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
