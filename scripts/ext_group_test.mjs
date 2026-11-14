// ext_group_test.mjs — 标签组 adopt/revoke 端到端测试。
//
// 验证「组成员 = 会话可见性」闭环（不依赖真实拖拽——用 SW 内 chrome.tabs
// .group/ungroup 模拟用户拖入/拖出组，走的与真实操作完全相同的对账路径）：
//   G1 会话创建的 tab 自动入组（createTarget 响应带 abGroup）
//   G2 用户 tab 拖入组 → sync 对账 → 会话可见（adopt）且可 attach/eval
//   G3 会话 closeTarget 借用 tab → 假成功 + 归还（tab 仍活着，会话不再可见）
//   G4 再次拖入 → 再拖出（ungroup）→ 收回（revoke），会话不可见
//   G5 会话 release → 借用 tab 被移出组且保持打开，自建 tab 被关闭
//
// 前置：extension 服务运行中（EXT_CONTROL，默认 9234）+ 测试浏览器带调试
// 端口（CHROME_CDP，默认 9333）+ cdp-ext 已加载并回连。
import { createRequire } from "node:module";
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
const http = async (method, path, body) => {
  const resp = await fetch(CONTROL + path, {
    method, headers: { "Content-Type": "application/json" },
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

// G1 自建 tab 自动入组
const created = await up.call("Target.createTarget", { url: "about:blank?created" });
check("G1 createTarget 响应带 abGroup", created.result?.abGroup === "ab: " + RUN, JSON.stringify(created.result?.abGroup));

// 用户 tab + 拖入组（SW 存活窗口内完成：MV3 SW 在 eval 结束后可能被挂起，
// 组变化事件与对账定时器须在同一存活窗口里跑完——真实浏览器由 WS 心跳
// + alarm 保活，此处等价模拟）
const userInfo = await swEval(`(async () => {
  const groups = await chrome.tabGroups.query({});
  const g = groups.find(x => x.title === "ab: ${RUN}");
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

// attach + eval 借用 tab
const att = await up.call("Target.attachToTarget", { targetId: userTargetId, flatten: true });
const sid = att.result?.sessionId;
const ev = await up.sessionCall(sid, "Runtime.evaluate", { expression: "2+3", returnByValue: true });
check("G2 借用 tab 可 attach + eval", ev.result?.result?.value === 5, JSON.stringify(ev.result?.result?.value));

// G3 会话 closeTarget 借用 tab → 假成功 + 归还
const kill = await up.call("Target.closeTarget", { targetId: userTargetId });
check("G3 closeTarget 假成功", kill.result !== undefined && !kill.error);
await sleep(500);
const stillAlive = await swEval(`(async () => {
  try { const t = await chrome.tabs.get(${userTabId}); return t.id === ${userTabId}; } catch { return false; }
})()`);
check("G3 借用 tab 仍活着（未真关）", stillAlive === true);
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G3 归还后会话不再可见", !targets.some((t) => t.targetId === userTargetId));
const destroyed = await up.waitEvent("Target.targetDestroyed");
check("G3 合成 targetDestroyed 送达", destroyed?.params?.targetId === userTargetId);

// G4 再拖入 → 再拖出（同窗口内完成操作+等待，见 G2 注释）
await swEval(`(async () => {
  await chrome.tabs.group({ tabIds: [${userTabId}], groupId: ${userInfo.groupId} });
  await new Promise((r) => setTimeout(r, 1500));
})()`);
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G4 再次拖入恢复可见", targets.some((t) => t.targetId === userTargetId));
await swEval(`(async () => {
  await chrome.tabs.ungroup([${userTabId}]);
  await new Promise((r) => setTimeout(r, 1500));
})()`);
targets = (await up.call("Target.getTargets")).result.targetInfos;
check("G4 拖出组收回（revoke）", !targets.some((t) => t.targetId === userTargetId));

// G5 release：借用归还（移出组+保持打开），自建关闭
await swEval(`(async () => {
  await chrome.tabs.group({ tabIds: [${userTabId}], groupId: ${userInfo.groupId} });
  await new Promise((r) => setTimeout(r, 1500));
})()`);
await http("POST", `/sessions/${RUN}/release`, {});
await sleep(1500);
const userAlive = await swEval(`(async () => {
  try { await chrome.tabs.get(${userTabId}); return true; } catch { return false; }
})()`);
check("G5 release 后借用 tab 保持打开", userAlive === true);
const userGroupless = await swEval(`(async () => {
  const t = await chrome.tabs.get(${userTabId});
  return t.groupId === -1;
})()`);
check("G5 借用 tab 已移出会话组", userGroupless === true);
const createdTabGone = await swEval(`(async () => {
  const tabs = await chrome.tabs.query({ url: "about:blank?created*" });
  return tabs.length === 0;
})()`);
check("G5 自建 tab 已关闭", createdTabGone === true);

// 清理
await browserCall("Target.closeTarget", { targetId: userTargetId }).catch(() => {});
console.log(results.every(Boolean) ? "\n组功能 E2E 全部通过 ✅" : "\n存在失败项 ❌");
process.exit(results.every(Boolean) ? 0 : 1);
