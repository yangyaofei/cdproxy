// ext_restart_test.mjs — SW 重启/软休眠（会话韧性）端到端测试。
//
// 验证两套机制（详见 ext/cdp-ext/README.md）：
//   R1 SW 重启续接：SW 死亡（runtime.reload 模拟）→ 会话表经
//      chrome.storage.session 持久化恢复 → restore 续接 → 同 sid 命令照常
//   R2 软休眠+懒重挂：模拟用户点调试横幅「取消」（chrome.debugger.detach +
//      onBrowserDetach）→ 无任何事件发给客户端 → 下一条命令自动重挂并成功
//   R3 休眠中 tab 被关：诚实报错（未知 sessionId），不复活死 target
//
// 前置：extension 服务运行中（EXT_CONTROL，默认 9234）+ 测试浏览器带调试
// 端口（CHROME_CDP，默认 9333）+ cdp-ext 已加载并回连。
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const CHROME_CDP = process.env.CHROME_CDP || "http://127.0.0.1:9333";
const RUN = "rst" + Date.now().toString(36);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};

// 分配令牌：从管理面 /status 自取（POST /sessions 需要 Bearer 准入）
let _tok = "";
const allocToken = async () => {
  if (_tok) return _tok;
  const r = await http("GET", "/status");
  _tok = r?.data?.sources?.alloc_token || r?.sources?.alloc_token || "";
  return _tok;
};

const http = async (method, path, body) => {
  const resp = await fetch(CONTROL + path, {
    method, headers: { "Content-Type": "application/json",
      ...(method === "POST" && path === "/sessions" ? { Authorization: `Bearer ${await allocToken()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: resp.status, data: await resp.json().catch(() => ({})) };
};

class Up {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("上游连接失败")); });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id !== undefined && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.events.push(m);
    };
  }
  async call(method, params = {}, timeout = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("上游命令超时: " + method)), timeout);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  async sessionCall(sessionId, method, params = {}, timeout = 15000) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, sessionId, method, params }));
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("上游会话命令超时: " + method)), timeout);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
    });
  }
  async waitEvent(method, timeout = 5000) {
    const found = this.events.find((e) => e.method === method);
    if (found) return found;
    return new Promise((res) => {
      const t = setTimeout(() => res(null), timeout);
      const iv = setInterval(() => {
        const hit = this.events.find((e) => e.method === method);
        if (hit) { clearTimeout(t); clearInterval(iv); res(hit); }
      }, 100);
    });
  }
}

// ── SW 内 eval（经浏览器调试端点 attach SW target）──
// SW 可能处于死亡等待 alarm 唤醒的窗口（≤30s）：先等 target 出现再 attach。
async function swEval(expr, waitSpawnMs = 0) {
  const t0 = Date.now();
  let t = null;
  for (;;) {
    const targets = await (await fetch(`${CHROME_CDP}/json/list`)).json();
    t = targets.find((x) => x.url.endsWith("sw.js"));
    if (t || Date.now() - t0 > (waitSpawnMs || 0)) break;
    await sleep(300);
  }
  if (!t) throw new Error("SW target 未找到");
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("SW attach 失败")); });
  const reply = await new Promise((res, rej) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); };
    ws.send(JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }));
    ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }));
    setTimeout(() => rej(new Error("SW eval 超时")), 15000);
  });
  ws.close();
  if (reply.result?.exceptionDetails) throw new Error("SW eval 异常: " + JSON.stringify(reply.result.exceptionDetails.exception));
  return reply.result?.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitExtConnected(timeoutMs = 20000, requireDrop = true) {
  const t0 = Date.now();
  let everFalse = false;
  while (Date.now() - t0 < timeoutMs) {
    const s = await http("GET", "/status");
    const connected = s.data?.sources?.extension?.connected === true;
    if (!connected) everFalse = true; // 观察到断开态，说明确实经历了重连
    if ((!requireDrop || everFalse) && connected) return true;
    await sleep(200);
  }
  return false;
}

// ── R0 前置 ──
await http("PUT", "/settings", { downstream_mode: "extension" });
{
  // 扩展可能处于上一轮测试遗留的「SW 死等 alarm 唤醒」窗口（≤30s）——等它回来
  const ok = await waitExtConnected(45000, false);
  const s = await http("GET", "/status");
  check("R0 扩展已回连", ok && s.data?.sources?.extension?.connected === true);
  if (!ok) { console.error("扩展未回连，前置失败"); process.exit(1); }
}

// ── 会话建立 + 基线 ──
const alloc = await http("POST", "/sessions", { name: RUN });
const up = new Up(alloc.data.cdpUrl);
await up.open();
const tg = await up.call("Target.getTargets");
let mine = tg.result.targetInfos.find((t) => t.url === "about:blank");
for (let i = 0; !mine && i < 20; i++) {
  await sleep(250); // 预开 tab 的映射到达有几百毫秒竞速（alloc 预开是 fire-and-forget）
  const t2 = await up.call("Target.getTargets");
  mine = t2.result.targetInfos.find((t) => t.url === "about:blank");
}
check("基线：预开 tab 可见", !!mine, mine?.targetId);
const att = await up.call("Target.attachToTarget", { targetId: mine.targetId, flatten: true });
const E1 = att.result.sessionId;
const base = await up.sessionCall(E1, "Runtime.evaluate", { expression: "1+1", returnByValue: true });
check("基线：会话命令可用", base.result?.result?.value === 2, `E1=${E1}`);

// ── R1 SW 重启续接（同 sid 命令照常，客户端无事件）──
// SW 死亡用「浏览器侧关闭 SW target」模拟（Chrome 空闲回收的真实路径）。
// 注：chrome.runtime.reload 会连 alarms 一起清掉（unpack 重载的边缘语义），
// SW 将无唤醒源——生产里手动刷新扩展后点一下工具栏图标即重连。
{
  const targets = await (await fetch(`${CHROME_CDP}/json/list`)).json();
  const swT = targets.find((x) => x.url.endsWith("sw.js"));
  if (!swT) throw new Error("R1 前置失败：SW target 不在");
  const ver = await (await fetch(`${CHROME_CDP}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => { bws.onopen = r; });
  const closed = await new Promise((res) => {
    bws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 9) res(m); };
    bws.send(JSON.stringify({ id: 9, method: "Target.closeTarget", params: { targetId: swT.id } }));
    setTimeout(() => res(null), 10000);
  });
  check("R1 SW target 已被关闭（模拟 Chrome 回收）", !!closed && !closed.error, JSON.stringify(closed?.error || "ok"));
  bws.close();
}
// SW 死透，唯一唤醒源是 0.5min keepalive alarm（Chrome 周期下限 30s）
const back = await waitExtConnected(45000);
check("R1 扩展重连（观察到断开→回连，alarm 兜底 ≤30s）", back === true);
if (!back) { console.error("R1 未重连，后续依赖 SW 的步骤无法进行"); process.exit(1); }
await sleep(1000); // restore 落账 + 会话命令窗口
const ev1 = await up.sessionCall(E1, "Runtime.evaluate", { expression: "20+22", returnByValue: true });
check("R1 SW 重启后同 sid 命令照常", ev1.result?.result?.value === 42, `E1=${E1}`);
const destroyed = up.events.find((e) => e.method === "Target.targetDestroyed" && e.params?.targetId === mine.targetId);
check("R1 SW 重启期间客户端未收到 targetDestroyed", !destroyed);

// ── R2 软休眠 + 懒重挂（模拟点横幅「取消」）──
const sleepInfo = await swEval(`(async () => {
  const sid = [...sessions.keys()].find((s) => !sessions.get(s).browser);
  const sess = sessions.get(sid);
  await chrome.debugger.detach({ tabId: sess.tabId });
  await onBrowserDetach(sess.targetId, "canceled_by_user");
  return { sid, targetId: sess.targetId, attachedNow: attached.has(sess.targetId) };
})()`, 15000);
check("R2 软休眠生效（attached 摘除）", sleepInfo?.attachedNow === false, JSON.stringify(sleepInfo));
const ev2 = await up.sessionCall(E1, "Runtime.evaluate", { expression: "6*7", returnByValue: true });
check("R2 休眠后下一条命令自动重挂并成功", ev2.result?.result?.value === 42);
const reAttached = await swEval(`[...attached.keys()].length`);
check("R2 重挂后 attached 表恢复", reAttached >= 1, `attached=${reAttached}`);
const detachedEv = up.events.find((e) => e.method === "Target.detachedFromTarget" && e.params?.sessionId === E1);
check("R2 休眠期间未向客户端发 detachedFromTarget", !detachedEv);

// ── R3 休眠中 tab 被关 → 诚实报错 ──
const ct = await up.call("Target.createTarget", { url: "about:blank", background: true });
const tid2 = ct.result.targetId;
const att2 = await up.call("Target.attachToTarget", { targetId: tid2, flatten: true });
const E2 = att2.result.sessionId;
const ev3a = await up.sessionCall(E2, "Runtime.evaluate", { expression: "1", returnByValue: true });
check("R3 第二 tab 基线可用", ev3a.result?.result?.value === 1);
await swEval(`(async () => {
  const sess = sessions.get(${JSON.stringify(E2)});
  await chrome.debugger.detach({ tabId: sess.tabId });
  await onBrowserDetach(sess.targetId, "canceled_by_user");
})()`);
const closeReply = await up.call("Target.closeTarget", { targetId: tid2 });
check("R3 休眠中 closeTarget 正常（root 命令不经 debugger）", !closeReply.error, JSON.stringify(closeReply.error || ""));
const gone = await up.waitEvent("Target.detachedFromTarget", 5000);
check("R3 tab 关闭事件送达客户端", !!gone && gone.params?.sessionId === E2, JSON.stringify(gone?.params || null));
const ev3b = await up.sessionCall(E2, "Runtime.evaluate", { expression: "1", returnByValue: true });
check("R3 死 sid 诚实报错（不复活）", !!ev3b.error, ev3b.error?.message?.slice(0, 60) || "无错误");

// ── R4 清理 ──
const rel = await http("POST", `/sessions/${RUN}/release`, {});
check("R4 会话释放", rel.code === 200 || rel.code === 404);

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} 通过${pass === results.length ? " ✅" : " ❌"}`);
process.exit(pass === results.length ? 0 : 1);
