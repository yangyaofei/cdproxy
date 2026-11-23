// ext_cold_test.mjs — 冷启动孤儿场景验证（对齐后的核心语义）
//   C1 alloc + 建 tab → runtime.reload 扩展（清 storage.session = 冷启动）
//   C2 重连后 gstate 重建：会话仍看到全部组内 tab（不再孤儿化）
//   C3 客户端未收到 targetDestroyed 风暴
//   C4 release（close 策略）→ 组内 tab 全关、组消失
//   C5 mark 策略 release 后同名 alloc → 墓碑复活 + 整组认领（组在即领地）
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const CHROME_CDP = process.env.CHROME_CDP || "http://127.0.0.1:9333";
const RUN = "cold" + Date.now().toString(36);
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};

// ── HTTP 帮助 ──
const _tok = process.env.ALLOC_TOKEN || process.env.EXT_TOKEN || (() => {
  try {
    return JSON.parse(readFileSync(path.join(os.homedir(), ".cdproxy", "settings.json"), "utf8"))?.sources?.alloc_token || "";
  } catch { return ""; }
})();

const http = async (method, p, body) => {
  const resp = await fetch(CONTROL + p, {
    method, headers: { "Content-Type": "application/json", ...(_tok ? { Authorization: `Bearer ${_tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { code: resp.status, data: await resp.json().catch(() => ({})) };
};

// ── 上游 CDP 客户端（会话侧）──
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
  sawEvent(method) { return this.events.some((e) => e.method === method); }
}

// ── SW 内 eval ──
async function swEval(expr) {
  const targets = await (await fetch(`${CHROME_CDP}/json/list`)).json();
  const t = targets.find((x) => x.url.endsWith("sw.js"));
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
    setTimeout(() => rej(new Error("SW eval 超时")), 20000);
  });
  ws.close();
  if (reply.result?.exceptionDetails) throw new Error("SW eval 异常: " + JSON.stringify(reply.result.exceptionDetails.exception));
  return reply.result?.result?.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await http("PUT", "/settings", { downstream_mode: "extension" });

// C1
const alloc = await http("POST", "/sessions", { name: RUN });
const up = new Up(alloc.data.cdpUrl);
await up.open();
const c1 = await up.call("Target.createTarget", { url: "about:blank?cold1" });
check("C1 会话 tab 已建", !!c1.result?.targetId);
const before = (await up.call("Target.getTargets")).result.targetInfos.map((t) => t.targetId);
check("C1 建组后可见 ≥2（预开+新 tab）", before.length >= 2, `visible=${before.length}`);

// 冷启动模拟：清除持久化会话表 + 关闭 SW target（Chrome 回收）。
// 与 runtime.reload 等价的冷路径（loadPersistedState miss → gstate 重建），
// 且不触发 reload 的扩展 DISABLED 次生现象。alarm 兜底唤醒（≤30s）。
await swEval(`(async () => { await chrome.storage.session.remove("${"cdpExtState"}"); return true; })()`);
{
  const list = await (await fetch(`${CHROME_CDP}/json/list`)).json();
  const sw = list.find((x) => x.url.endsWith("sw.js"));
  if (sw) {
    const ws = new WebSocket(sw.webSocketDebuggerUrl);
    await new Promise((res) => { ws.onopen = res; });
    ws.send(JSON.stringify({ id: 1, method: "Runtime.runIfWaitingForDebugger" }));
    ws.send(JSON.stringify({ id: 2, method: "Target.closeTarget", params: { targetId: sw.id } }));
    await new Promise((res) => setTimeout(res, 1500));
    ws.close();
  }
}
let woken = false;
for (let i = 0; i < 40 && !woken; i++) {
  await sleep(1000);
  try { woken = await swEval(`(async () => new Promise(r => setTimeout(() => r(ws && ws.readyState === WebSocket.OPEN), 200)))()`); } catch { /* SW 未醒 */ }
}
check("C2 前置：SW 冷重启后已重连（alarm 兜底）", woken === true);
await sleep(2000); // gstate 重建窗口

// C2/C3：重连后同连接继续可用，无孤儿
const after = (await up.call("Target.getTargets")).result.targetInfos.map((t) => t.targetId);
check("C2 冷启动后 tab 全部仍可见（无孤儿）", after.length >= before.length,
  `before=${before.length} after=${after.length}`);
const ev = await up.call("Target.attachToTarget", { targetId: c1.result.targetId, flatten: true });
const sid = ev.result?.sessionId;
const ping = await up.sessionCall(sid, "Runtime.evaluate", { expression: "1+1", returnByValue: true });
check("C2 冷启动后 attach + eval 照常", ping.result?.result?.value === 2);
check("C3 客户端未收到 targetDestroyed 风暴", !up.sawEvent("Target.targetDestroyed"));

// C4 release（默认 close）
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const g4 = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({ title: "cdproxy: ${RUN}" });
  return groups.length;
})()`);
check("C4 close 策略：组已消失", g4 === 0);

// C5 mark 策略：release 留墓碑 → 同名 alloc 复活认领
await swEval(`(async () => { await chrome.storage.local.set({ releasePolicy: "mark" }); })()`);
const a2 = await http("POST", "/sessions", { name: RUN });
const up2 = new Up(a2.data.cdpUrl);
await up2.open();
const c5 = await up2.call("Target.createTarget", { url: "about:blank?cold5" });
check("C5 前置：tab 已建", !!c5.result?.targetId);
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const tomb = await swEval(`(async () => {
  const g = await chrome.tabGroups.query({ title: "cdproxy: ${RUN} · released" });
  return g.length === 1 && g[0].color === "grey";
})()`);
check("C5 墓碑就位（· released + 灰色）", tomb === true);
const a3 = await http("POST", "/sessions", { name: RUN });
const up3 = new Up(a3.data.cdpUrl);
await up3.open();
await sleep(1800);
const claimed = (await up3.call("Target.getTargets")).result.targetInfos;
check("C5 同名 alloc 摘碑复活，整组认领（组在即领地）", claimed.length >= 2, `visible=${claimed.length}`);

// 清理
await swEval(`(async () => {
  await chrome.storage.local.set({ releasePolicy: "close" });
  const gs = await chrome.tabGroups.query({ title: "cdproxy: ${RUN}*" });
  for (const g of gs) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    if (tabs.length) await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  }
  const loose = await chrome.tabs.query({ url: "about:blank?cold*" });
  if (loose.length) await chrome.tabs.remove(loose.map((t) => t.id)).catch(() => {});
})()`);
console.log(results.every(Boolean) ? "\n冷启动孤儿场景 全部通过 ✅" : "\n存在失败项 ❌");
process.exit(results.every(Boolean) ? 0 : 1);
