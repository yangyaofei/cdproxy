// ext_group_test.mjs — 标签组 adopt/revoke 端到端测试。
//
// 验证「组成员 = 会话可见性」闭环（不依赖真实拖拽——用 SW 内 chrome.tabs
// .group/ungroup 模拟用户拖入/拖出组，走的与真实操作完全相同的对账路径）：
//   G1 会话创建的 tab 自动入组（createTarget 响应带 abGroup）
//   G2 用户 tab 拖入组 → sync 对账 → 会话可见（adopt）且可 attach/eval
//   G3 会话 closeTarget 组内 tab → 真关（组内=会话的，拖入即交出）
//   G4 再次拖入 → 再拖出（ungroup）→ 收回（revoke），会话不可见
//   G5 release 策略 close（默认）：组内全部 tab 关闭、组消失
//   G6 release 策略 mark：组加墓碑（· released + 灰色），tab 全保留
//   G7 墓碑复活：同名 alloc → 摘碑 + 整组认领（组在即领地）
//   G8 release 策略 keep：组与 tab 原样保留
//
// 前置：extension 服务运行中（EXT_CONTROL，默认 9234）+ 测试浏览器带调试
// 端口（CHROME_CDP，默认 9333）+ cdp-ext 已加载并回连。
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const CHROME_CDP = process.env.CHROME_CDP || "http://127.0.0.1:9333";
const RUN = "grp" + Date.now().toString(36);
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

// ── SW 内 eval（chrome.tabs.group / ungroup 模拟用户操作）──
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
    setTimeout(() => rej(new Error("SW eval 超时")), 15000);
  });
  ws.close();
  if (reply.result?.exceptionDetails) throw new Error("SW eval 异常: " + JSON.stringify(reply.result.exceptionDetails.exception));
  return reply.result?.result?.value;
}

// ── 浏览器直连 CDP（创建/查询用户 tab）──
async function browserCall(method, params = {}) {
  const ver = await (await fetch(`${CHROME_CDP}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res) => { ws.onopen = res; });
  const reply = await new Promise((res) => {
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) res(m); };
    ws.send(JSON.stringify({ id: 1, method, params }));
    setTimeout(() => res(null), 10000);
  });
  ws.close();
  return reply;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主流程 ──
await http("PUT", "/settings", { downstream_mode: "extension" });
const alloc = await http("POST", "/sessions", { name: RUN });
const up = new Up(alloc.data.cdpUrl);
await up.open();
await up.call("Target.setDiscoverTargets", { discover: true }); // 对齐 agent-browser 连接序列

// G1 自建 tab 自动入组
const created = await up.call("Target.createTarget", { url: "about:blank?created" });
const createdTid = created.result?.targetId;
check("G1 createTarget 响应带 abGroup", created.result?.abGroup === "cdproxy: " + RUN, JSON.stringify(created.result?.abGroup));

// 用户 tab + 拖入组（SW 存活窗口内完成：MV3 SW 在 eval 结束后可能被挂起，
// 组变化事件与对账定时器须在同一存活窗口里跑完——真实浏览器由 WS 心跳
// + alarm 保活，此处等价模拟）
const userInfo = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "cdproxy: ${RUN}");
  if (!g) return { err: "会话组不存在" };
  await refreshTargets();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  await new Promise((r) => setTimeout(r, 1500)); // 对账防抖 + sync 往返
  await refreshTargets();
  const entry = targetByTab.get(tab.id);
  return { groupId: g.id, tabId: tab.id, targetId: entry ? entry.targetId : null };
})()`);
const userTabId = userInfo?.tabId;
const userTargetId = userInfo?.targetId;
check("会话组存在 + 用户 tab 已建", !!userTargetId,
  `groupId=${userInfo?.groupId} tabId=${userTabId} targetId=${userTargetId}`);

let targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G2 拖入组后会话可见（adopt）", targets.some((t) => t.targetId === userTargetId),
  `visible=${targets.length}`);
const g2created = up.events.find((e) => e.method === "Target.targetCreated" && e.params?.targetInfo?.targetId === userTargetId);
check("G2 拖入后 targetCreated 事件送达（tab list 靠事件流）",
  !!g2created,
  JSON.stringify(up.events.filter((e) => e.method === "Target.targetCreated").map((e) => e.params?.targetInfo?.targetId)));

// attach + eval 借用 tab
const att = await up.call("Target.attachToTarget", { targetId: userTargetId, flatten: true });
const sid = att.result?.sessionId;
const ev = await up.sessionCall(sid, "Runtime.evaluate", { expression: "2+3", returnByValue: true });
check("G2 借用 tab 可 attach + eval", ev.result?.result?.value === 5, JSON.stringify(ev.result?.result?.value));

// G3 会话 closeTarget 组内 tab → 真关（组内 = 会话的）
const kill = await up.call("Target.closeTarget", { targetId: userTargetId });
check("G3 closeTarget 成功", kill.result !== undefined && !kill.error);
await sleep(600);
const stillAlive = await swEval(`(async () => {
  try { const t = await chrome.tabs.get(${userTabId}); return t.id === ${userTabId}; } catch { return false; }
})()`);
check("G3 组内 tab 已真关", stillAlive === false);
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G3 关闭后会话不再可见", !targets.some((t) => t.targetId === userTargetId));
const destroyed = await up.waitEvent("Target.targetDestroyed");
check("G3 targetDestroyed 送达", destroyed?.params?.targetId === userTargetId);

// G4 新用户 tab 拖入 → 拖出（G3 已真关旧 tab；同窗口内完成操作+等待，见 G2 注释）
const g4user = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "cdproxy: ${RUN}");
  if (!g) return { err: "no group" };
  await refreshTargets();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  await new Promise((r) => setTimeout(r, 1500));
  await refreshTargets();
  const entry = targetByTab.get(tab.id);
  return { tabId: tab.id, targetId: entry ? entry.targetId : null };
})()`);
check("G4 前置：新用户 tab 已入组", !!g4user?.targetId, JSON.stringify(g4user));
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G4 拖入组恢复可见", targets.some((t) => t.targetId === g4user.targetId));
await swEval(`(async () => {
  await chrome.tabs.ungroup([${g4user.tabId}]);
  await new Promise((r) => setTimeout(r, 1500));
})()`);
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G4 拖出组收回（revoke）", !targets.some((t) => t.targetId === g4user.targetId));

// G5 release 策略 close（默认）：组内全部 tab 关闭、组消失
const user2 = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "cdproxy: ${RUN}");
  if (!g) return { err: "no group" };
  await refreshTargets();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  await new Promise((r) => setTimeout(r, 1500));
  await refreshTargets();
  const entry = targetByTab.get(tab.id);
  return { tabId: tab.id, targetId: entry ? entry.targetId : null };
})()`);
check("G5 前置：新用户 tab 已入组", !!user2?.targetId, JSON.stringify(user2));
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G5 入组后会话可见", targets.some((t) => t.targetId === user2.targetId));
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const g5tabs = await swEval(`(async () => {
  let alive = false;
  try { await chrome.tabs.get(${user2.tabId}); alive = true; } catch {}
  let createdAlive = false;
  try { const tid = tabByTarget.get("${createdTid}"); if (tid !== undefined) { await chrome.tabs.get(tid); createdAlive = true; } } catch {}
  const groups = await chrome.tabGroups.query({ title: "cdproxy: ${RUN}" });
  return { userAlive: alive, createdAlive, groupLeft: groups.length };
})()`);
check("G5 close：用户 tab 已关", g5tabs?.userAlive === false);
check("G5 close：自建 tab 已关", g5tabs?.createdAlive === false, JSON.stringify(g5tabs));
check("G5 close：组已消失", g5tabs?.groupLeft === 0);

// G6 release 策略 mark：墓碑（· released + 灰色），tab 全保留
await swEval(`(async () => { await chrome.storage.local.set({ releasePolicy: "mark" }); })()`);
const alloc2 = await http("POST", "/sessions", { name: RUN });
const up2 = new Up(alloc2.data.cdpUrl);
await up2.open();
const c2 = await up2.call("Target.createTarget", { url: "about:blank?mk" });
check("G6 前置：新会话 tab 已建", !!c2.result?.targetId);
const g6user = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "cdproxy: ${RUN}");
  if (!g) return { err: "no group" };
  await refreshTargets();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  await new Promise((r) => setTimeout(r, 1500));
  await refreshTargets();
  const entry = targetByTab.get(tab.id);
  return { tabId: tab.id, targetId: entry ? entry.targetId : null };
})()`);
check("G6 前置：用户 tab 已入组", !!g6user?.targetId, JSON.stringify(g6user));
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const g6 = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const t = groups.find(x => x.title === "cdproxy: ${RUN} · released");
  let userAlive = false;
  try { await chrome.tabs.get(${g6user.tabId}); userAlive = true; } catch {}
  const mk = await chrome.tabs.query({ url: "about:blank?mk*" });
  return { tomb: !!t, color: t ? t.color : null, userAlive, mkLeft: mk.length };
})()`);
check("G6 mark：墓碑组存在", g6?.tomb === true, JSON.stringify(g6));
check("G6 mark：墓碑灰色", g6?.color === "grey", JSON.stringify(g6?.color));
check("G6 mark：用户 tab 保留", g6?.userAlive === true);
check("G6 mark：会话 tab 保留", g6?.mkLeft === 1);

// G7 墓碑复活：同名 alloc → 摘碑 + 整组认领（组在即领地）
const alloc3 = await http("POST", "/sessions", { name: RUN });
const up3 = new Up(alloc3.data.cdpUrl);
await up3.open();
await sleep(1800); // 预开 tab 入组（摘碑）+ sync 往返
const g7 = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const live = groups.find(x => x.title === "cdproxy: ${RUN}");
  const tomb = groups.find(x => x.title === "cdproxy: ${RUN} · released");
  return { live: !!live, tomb: !!tomb };
})()`);
check("G7 复活：活组回归（摘碑）", g7?.live === true && g7?.tomb === false, JSON.stringify(g7));
const t3 = (await up3.call("Target.getTargets")).result.targetInfos;
check("G7 旧 tab 整组认领（组在即领地）", t3.some((x) => x.targetId === g6user.targetId),
  `visible=${t3.length}`);

// G8 release 策略 keep：组与 tab 原样保留
await swEval(`(async () => { await chrome.storage.local.set({ releasePolicy: "keep" }); })()`);
const g8user = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "cdproxy: ${RUN}");
  if (!g) return { err: "no group" };
  await refreshTargets();
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.tabs.group({ tabIds: [tab.id], groupId: g.id });
  await new Promise((r) => setTimeout(r, 1500));
  await refreshTargets();
  const entry = targetByTab.get(tab.id);
  return { tabId: tab.id, targetId: entry ? entry.targetId : null };
})()`);
check("G8 前置：用户 tab 已入组", !!g8user?.targetId, JSON.stringify(g8user));
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const g8 = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({ title: "cdproxy: ${RUN}" });
  let userAlive = false;
  try { await chrome.tabs.get(${g8user.tabId}); userAlive = true; } catch {}
  return { group: groups.length, userAlive };
})()`);
check("G8 keep：组原样保留（无墓碑）", g8?.group === 1);
check("G8 keep：tab 原样保留", g8?.userAlive === true);

// 清理：关掉遗留 tab + 策略复位 close
await swEval(`(async () => {
  await chrome.storage.local.set({ releasePolicy: "close" });
  const groups = await chrome.tabGroups.query({ title: "cdproxy: ${RUN}" });
  for (const g of groups) {
    const tabs = await chrome.tabs.query({ groupId: g.id });
    if (tabs.length) await chrome.tabs.remove(tabs.map(t => t.id)).catch(() => {});
  }
})()`);
console.log(results.every(Boolean) ? "\n组功能 E2E 全部通过 ✅" : "\n存在失败项 ❌");
process.exit(results.every(Boolean) ? 0 : 1);
