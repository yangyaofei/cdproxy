// cdp-ext service worker — 反向 CDP 桥核心。
//
// 职责：把本扩展伪装成一个「浏览器级 CDP 端点」，通过反向 WebSocket 提供给
// agent-browser-proxy（--downstream extension 模式）作为下游：
//
//   proxy(9235 /ext) ◄── 反向拨出（本 SW 发起）──  本 SW ── chrome.debugger ──► 各 tab
//
// 协议形态（与真 Chrome 浏览器级 WS 端点一致，flatten-only）：
//   收：{id, method, params[, sessionId]}  命令（sessionId=页面会话命令）
//   发：{id, result|error}                 响应
//       {method, params[, sessionId]}      事件（Target 生命周期 / 页面会话事件）
//       {"hb":1}                           心跳（20s，兼作 MV3 SW 保活）
//
// 浏览器级命令的仿真来源：
//   Target.getTargets / targetCreated…  ← chrome.debugger.getTargets + chrome.tabs 事件
//   Target.createTarget / closeTarget   ← chrome.tabs.create / remove
//   Target.attachToTarget (flatten)     ← chrome.debugger.attach（每 tab 一条）
//   页面会话命令                         ← chrome.debugger.sendCommand 透传
//   子会话（OOPIF/worker）               ← Chrome 125+ flat session 原生透传
//
// 已知边界（与调研结论一致）：
//   - 一个 tab 同时只能挂一个 debugger（用户开着 DevTools 的 tab 会 attach 失败）
//   - Browser.* 域只仿真 getVersion；其余按错误应答（proxy 侧另有基座保护规则）
//   - attach 后 tab 顶部出现「扩展程序已开始调试此浏览器」横幅，detach 即消失
//
// 生命周期：WS 断开→退避重连（alarms 兜底唤醒）；SW 重启→状态重建，
// 曾 attach 的 tab 先全部 detach（proxy 在重连时已清归属并合成销毁事件，
// 会话经 provider 重新分配，遗留 attach 只会白白挂横幅）。

const DEFAULT_RELAY = "ws://127.0.0.1:9235/ext";
const DEFAULT_TOKEN = "dev";
const HEARTBEAT_MS = 20_000; // 同时是 SW 保活间隔（须 <30s）
const ATTACH_STORAGE_KEY = "cdpExtAttachedTargets"; // chrome.storage.session

let ws = null;
let backoffMs = 500;
let heartbeatTimer = null;

// ── 会话表 ─────────────────────────────────────────────────────────
// ourSid → 会话；root 键（targetId）与 childDsSid 各有反向索引。
// 每次反向连接重建（proxy 侧同刻清归属，旧 id 无引用者）。

let sidSeq = 0;
const sessions = new Map(); // ourSid → {targetId, tabId, children: Map<dsSid, ourSid>}
const rootsByTarget = new Map(); // targetId → Set<ourSid>（一个物理 attach 叠 N 个虚拟会话）
const childByDsSid = new Map(); // dsChildSessionId → {targetId, byParent: Map<parentOurSid, childOurSid>}
const attached = new Map(); // targetId → {tabId} 物理 attach 状态（一 tab 一 debugger，引用计数去重）
let rootAutoAttach = false; // 浏览器级 Target.setAutoAttach 标志

// targetId ⇄ tabId 映射（getTargets 刷新维护；事件路由与 attach 都依赖）
const targetByTab = new Map(); // tabId → {targetId, url, title, type}
const tabByTarget = new Map(); // targetId → tabId

// ── 配置 ───────────────────────────────────────────────────────────

async function relayConfig() {
  const got = await chrome.storage.local.get(["relayUrl", "token"]);
  return {
    url: got.relayUrl || DEFAULT_RELAY,
    token: got.token ?? DEFAULT_TOKEN,
  };
}

// ── target 映射维护 ────────────────────────────────────────────────

async function refreshTargets() {
  const infos = await chrome.debugger.getTargets();
  for (const ti of infos) {
    if (ti.tabId === undefined) continue;
    const known = targetByTab.get(ti.tabId);
    const fresh = { targetId: ti.id, url: ti.url, title: ti.title, type: ti.type };
    targetByTab.set(ti.tabId, fresh);
    tabByTarget.set(ti.id, ti.tabId);
    if (known && known.targetId !== ti.id) tabByTarget.delete(known.targetId);
  }
  return infos;
}

function cdpTargetInfo(ti, openerTabId) {
  const info = {
    targetId: ti.id,
    type: ti.type,
    title: ti.title,
    url: ti.url,
    attached: ti.attached,
    // 真 Chrome 的 targetInfo 带 browserContextId（默认 context 亦有固定 id）；
    // Playwright 对缺失该字段的 target 直接 detach——必须带上（不在
    // getBrowserContexts 列表内的 id 会回落到默认 context，语义正确）。
    browserContextId: "cdp-ext-default",
  };
  if (ti.tabId !== undefined) info.tabId = ti.tabId;
  if (openerTabId && targetByTab.has(openerTabId)) {
    info.openerId = targetByTab.get(openerTabId).targetId;
  }
  return info;
}

async function targetInfoOf(targetId) {
  const infos = await refreshTargets();
  return infos.find((ti) => ti.id === targetId) || null;
}

// ── 反向连接 ───────────────────────────────────────────────────────

function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  relayConfig().then(({ url, token }) => {
    const full = url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
    const sock = new WebSocket(full);
    ws = sock;
    sock.onopen = async () => {
      backoffMs = 500;
      console.info("[cdp-ext] 已连上 proxy:", url);
      await resetState();
      startHeartbeat();
    };
    sock.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.id !== undefined) onCommand(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      stopHeartbeat();
      ws = null;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 5000);
    };
    sock.onerror = () => {
      /* onclose 随后触发，统一走重连 */
    };
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => send({ hb: 1 }), HEARTBEAT_MS);
}
function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

// resetState 新连接的干净起点：清会话表，detach 上一 SW 世代 attach 过的 tab。
async function resetState() {
  sessions.clear();
  rootsByTarget.clear();
  childByDsSid.clear();
  attached.clear();
  targetByTab.clear();
  tabByTarget.clear();
  idEcho.clear();
  rootAutoAttach = false;
  sidSeq = 0;
  await refreshTargets();
  const got = await chrome.storage.session.get(ATTACH_STORAGE_KEY);
  const attachedList = got[ATTACH_STORAGE_KEY] || [];
  for (const target of attachedList) {
    chrome.debugger.detach(target).catch(() => {});
  }
  await chrome.storage.session.set({ [ATTACH_STORAGE_KEY]: [] });
}

async function rememberAttach(target) {
  const got = await chrome.storage.session.get(ATTACH_STORAGE_KEY);
  const list = got[ATTACH_STORAGE_KEY] || [];
  if (!list.some((t) => t.targetId === target.targetId || t.tabId === target.tabId)) {
    list.push(target);
    await chrome.storage.session.set({ [ATTACH_STORAGE_KEY]: list });
  }
}

// ── 命令分发 ───────────────────────────────────────────────────────

function respond(id, result) {
  const echo = idEcho.get(id);
  if (echo !== undefined) {
    idEcho.delete(id);
    send({ id, sessionId: echo, result });
  } else {
    send({ id, result });
  }
}
function respondErr(id, message) {
  const echo = idEcho.get(id);
  if (echo !== undefined) {
    idEcho.delete(id);
    send({ id, sessionId: echo, error: { code: -32000, message } });
  } else {
    send({ id, error: { code: -32000, message } });
  }
}

// idEcho：浏览器 target 会话（attachToBrowserTarget 产物）内执行 root 命令
// 时，响应须回带该会话 sessionId（Playwright 按 sessionId 路由响应）。
const idEcho = new Map(); // 命令 id → 需回带的 sessionId

function onCommand(msg) {
  const method = msg.method || "";
  const params = msg.params || {};
  const sid = msg.sessionId;
  if (sid !== undefined && sid !== "") {
    onSessionCommand(msg.id, sid, method, params).catch((err) =>
      send({ id: msg.id, sessionId: sid, error: { code: -32000, message: `cdp-ext: ${method} 失败: ${err && err.message ? err.message : String(err)}` } })
    );
    return;
  }
  onRootCommand(msg.id, method, params).catch((err) => {
    respondErr(msg.id, `cdp-ext: ${method} 失败: ${err && err.message ? err.message : String(err)}`);
  });
}

// onRootCommand 浏览器级命令（无 sessionId）。
async function onRootCommand(id, method, params) {
  switch (method) {
    case "Target.getTargets": {
      const infos = await refreshTargets();
      respond(id, { targetInfos: infos.map((ti) => cdpTargetInfo(ti)) });
      return;
    }
    case "Target.getTargetInfo": {
      // 无 targetId = 查询浏览器自身 target（Playwright 连接序列依赖此语义）
      if (params.targetId === undefined || params.targetId === "") {
        respond(id, {
          targetInfo: {
            targetId: "browser", type: "browser", title: "",
            url: "", attached: true,
          },
        });
        return;
      }
      const ti = await targetInfoOf(params.targetId);
      if (!ti) return respondErr(id, `cdp-ext: target ${params.targetId} 不存在`);
      respond(id, { targetInfo: cdpTargetInfo(ti) });
      return;
    }
    case "Target.createTarget": {
      const tab = await chrome.tabs.create({
        url: params.url || "about:blank",
        active: !params.background,
      });
      // 等 target 映射就位：立即首查（新 tab 通常同步可见，应答须与真 Chrome
      // 同数量级——alloc 预开是 fire-and-forget，慢了会被客户端 getTargets
      // 抢先导致归属未记录）；未就位再 25ms×80 兜底轮询。
      let targetId = null;
      for (let i = 0; i < 80 && !targetId; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 25));
        await refreshTargets();
        targetId = (targetByTab.get(tab.id) || {}).targetId;
      }
      if (!targetId) return respondErr(id, "cdp-ext: 新 tab 的 targetId 解析超时");
      respond(id, { targetId });
      if (rootAutoAttach) await attachTarget(targetId);
      return;
    }
    case "Target.closeTarget": {
      const tabId = tabByTarget.get(params.targetId);
      if (tabId === undefined) return respondErr(id, `cdp-ext: target ${params.targetId} 不存在`);
      await chrome.tabs.remove(tabId);
      respond(id, { success: true });
      return;
    }
    case "Target.activateTarget": {
      const tabId = tabByTarget.get(params.targetId);
      if (tabId !== undefined) await chrome.tabs.update(tabId, { active: true });
      respond(id, {});
      return;
    }
    case "Target.attachToTarget": {
      if (params.flatten !== true) {
        return respondErr(id, "cdp-ext: 仅支持 flatten 会话（flatten:true）");
      }
      const sidNew = await attachTarget(params.targetId);
      if (!sidNew) return respondErr(id, `cdp-ext: attach ${params.targetId} 失败`);
      respond(id, { sessionId: sidNew });
      return;
    }
    case "Target.detachFromTarget": {
      const sess = sessions.get(params.sessionId);
      if (sess) await detachSession(params.sessionId);
      respond(id, {});
      return;
    }
    case "Target.attachToBrowserTarget": {
      // 浏览器 target 虚拟会话：Playwright ctx.newCDPSession(page) 先建它，
      // 再在其上 attachToTarget 页面。命令面等价 root（见 onSessionCommand）。
      const ourSid = `E${++sidSeq}`;
      sessions.set(ourSid, { targetId: "browser", tabId: undefined, children: new Map(), browser: true });
      respond(id, { sessionId: ourSid });
      return;
    }
    case "Target.setAutoAttach": {
      rootAutoAttach = !!params.autoAttach;
      if (rootAutoAttach) {
        // 直连场景（未经 proxy）：对全部 page 各建一个虚拟会话；经 proxy 时
        // 该命令被 proxy 拦截改写（只 attach 该会话拥有的 target），不会到达这里。
        const infos = await refreshTargets();
        for (const ti of infos) {
          if (ti.type === "page") await attachTarget(ti.id);
        }
      }
      respond(id, {});
      return;
    }
    case "Target.setDiscoverTargets":
    case "Target.setRemoteLocations": {
      respond(id, {});
      return;
    }
    case "Target.getBrowserContexts": {
      respond(id, { browserContextIds: [] });
      return;
    }
    case "Browser.getVersion": {
      respond(id, {
        protocolVersion: "1.3",
        product: "Chrome/cdp-ext-bridge",
        userAgent: navigator.userAgent,
        jsVersion: "",
      });
      return;
    }
    case "Browser.setDownloadBehavior": {
      // 假成功：Playwright 连接期无条件发送，报错会中断其初始化。下载按
      // 宿主浏览器默认行为落盘，Page.downloadWillBegan/Progress 事件仍经
      // 页面会话正常流动（playwright download 对象的路径解析受限，属文档化
      // 缺口——精确控制需 chrome.downloads，不在 CDP 语义层补偿）。
      respond(id, {});
      return;
    }
    case "Browser.close": {
      // 用户日常浏览器绝不允许被代理会话关闭（proxy 规则层也会拦，这里是双保险）
      respondErr(id, "cdp-ext: Browser.close 被扩展层拒绝（宿主是用户自己的浏览器）");
      return;
    }
    default:
      respondErr(id, `cdp-ext: 浏览器级命令不支持: ${method}`);
  }
}

// onSessionCommand 页面会话命令：透传 chrome.debugger（root 或 child 会话）。
// 响应必须回带 sessionId：真 Chrome flat 会话语义如此，Playwright 按
// sessionId 把响应路由到对应 CRSession（缺失则落到 browser 会话，id
// 对不上即断言崩溃）。
async function onSessionCommand(id, sid, method, params) {
  const sess = sessions.get(sid);
  if (!sess) return send({ id, sessionId: sid, error: { code: -32000, message: `cdp-ext: 未知 sessionId ${sid}` } });

  if (sess.browser) {
    // 浏览器 target 会话：命令面等价 root，响应回带本会话 sessionId
    idEcho.set(id, sid);
    if (method === "Target.attachToTarget") {
      if (params.flatten !== true) {
        return respondErr(id, "cdp-ext: 仅支持 flatten 会话（flatten:true）");
      }
      try {
        const pageSid = await attachTarget(params.targetId, sid);
        return respond(id, { sessionId: pageSid });
      } catch (err) {
        return respondErr(id, `cdp-ext: attach ${params.targetId} 失败: ${err && err.message}`);
      }
    }
    if (method === "Target.detachFromTarget") {
      if (params.sessionId) await detachSession(params.sessionId);
      return respond(id, {});
    }
    try {
      await onRootCommand(id, method, params);
    } catch (err) {
      respondErr(id, `cdp-ext: ${method} 失败: ${err && err.message ? err.message : String(err)}`);
    }
    return;
  }

  const target = sess.dsChildSid
    ? { tabId: sess.tabId, sessionId: sess.dsChildSid }
    : { tabId: sess.tabId };
  chrome.debugger
    .sendCommand(target, method, params)
    .then((result) => send({ id, sessionId: sid, result: result === undefined ? {} : result }))
    .catch((err) =>
      send({ id, sessionId: sid, error: { code: -32000, message: `${method}: ${err && err.message ? err.message : String(err)}` } })
    );
}

// ── attach / detach ────────────────────────────────────────────────

// attachTarget 对 target 建立一个「虚拟会话」并回发 attachedToTarget；返回 ourSid。
// 物理层 chrome.debugger 每 tab 只允许一个 attach——多客户端复用同一 target
// 时在物理 attach 上叠加多个虚拟会话（与真浏览器端点每连接独立会话语义对齐），
// 最后一个虚拟会话撤除时才真正 detach。
async function attachTarget(targetId, parentSid) {
  const tabId = tabByTarget.get(targetId);
  const ti = await targetInfoOf(targetId);
  if (!ti) throw new Error(`target ${targetId} 不存在`);
  if (!attached.has(targetId)) {
    const debuggee = tabId !== undefined ? { tabId } : { targetId };
    await chrome.debugger.attach(debuggee, "1.3");
    await rememberAttach(debuggee);
    attached.set(targetId, { tabId });
  }
  const ourSid = `E${++sidSeq}`;
  sessions.set(ourSid, { targetId, tabId, children: new Map() });
  if (!rootsByTarget.has(targetId)) rootsByTarget.set(targetId, new Set());
  rootsByTarget.get(targetId).add(ourSid);
  // 会话内 attach（如 attachToBrowserTarget 会话上的 attachToTarget）：
  // 事件嵌套发给该会话（顶层 sessionId=父），不广播浏览器级——真 Chrome
  // 如此，广播会让 Playwright 的浏览器级处理器重复注册 target 而断言。
  send({
    method: "Target.attachedToTarget",
    params: { sessionId: ourSid, targetInfo: cdpTargetInfo(ti) },
    ...(parentSid ? { sessionId: parentSid } : {}),
  });
  return ourSid;
}

async function detachSession(ourSid) {
  const sess = sessions.get(ourSid);
  if (!sess) return;
  sessions.delete(ourSid);
  for (const dsSid of sess.children.keys()) childByDsSid.delete(dsSid);
  const siblings = rootsByTarget.get(sess.targetId);
  if (siblings) siblings.delete(ourSid);
  if (siblings && siblings.size === 0) {
    rootsByTarget.delete(sess.targetId);
    attached.delete(sess.targetId);
    const debuggee = sess.tabId !== undefined ? { tabId: sess.tabId } : { targetId: sess.targetId };
    await chrome.debugger.detach(debuggee).catch(() => {});
    await forgetAttach(sess);
  }
  send({ method: "Target.detachedFromTarget", params: { sessionId: ourSid, targetId: sess.targetId } });
}

// dropTarget 撤除某 target 的全部虚拟会话（tab 关闭 / Chrome 侧强制断开调试）。
async function dropTarget(targetId, { notify = true } = {}) {
  const siblings = rootsByTarget.get(targetId);
  if (!siblings) return;
  for (const ourSid of [...siblings]) {
    const sess = sessions.get(ourSid);
    sessions.delete(ourSid);
    for (const dsSid of (sess ? sess.children.keys() : [])) childByDsSid.delete(dsSid);
    if (notify) {
      send({ method: "Target.detachedFromTarget", params: { sessionId: ourSid, targetId } });
    }
  }
  rootsByTarget.delete(targetId);
  attached.delete(targetId);
}

async function forgetAttach(sess) {
  const got = await chrome.storage.session.get(ATTACH_STORAGE_KEY);
  const list = (got[ATTACH_STORAGE_KEY] || []).filter(
    (t) => t.targetId !== sess.targetId && t.tabId !== sess.tabId
  );
  await chrome.storage.session.set({ [ATTACH_STORAGE_KEY]: list });
}

// ── chrome.debugger 事件 → CDP 事件 ─────────────────────────────────

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) {
    // 子会话（OOPIF/worker）事件：按 byParent 定向到各父会话自己的 child id
    const rec = childByDsSid.get(source.sessionId);
    if (!rec) return;
    if (method === "Target.detachedFromTarget") {
      for (const [parentOur, childOur] of rec.byParent) {
        send({
          method: "Target.detachedFromTarget",
          params: { sessionId: childOur, targetId: params && params.targetId },
          sessionId: parentOur,
        });
        const parent = sessions.get(parentOur);
        if (parent) parent.children.delete(source.sessionId);
      }
      childByDsSid.delete(source.sessionId);
      return;
    }
    for (const childOur of rec.byParent.values()) {
      send({ method, params, sessionId: childOur });
    }
    return;
  }

  // root 会话事件（source = {tabId}）：扇出到该 target 的全部虚拟会话
  const targetId = (targetByTab.get(source.tabId) || {}).targetId || source.targetId;
  const siblings = rootsByTarget.get(targetId);
  if (!siblings || siblings.size === 0) return;

  if (method === "Target.attachedToTarget") {
    // 页面会话内的 auto-attach（子 target）：每个父会话生成自己的 child id
    const dsSid = params && params.sessionId;
    if (!dsSid) return;
    if (!childByDsSid.has(dsSid)) {
      childByDsSid.set(dsSid, { targetId, byParent: new Map() });
    }
    const rec = childByDsSid.get(dsSid);
    for (const ourSid of siblings) {
      if (rec.byParent.has(ourSid)) continue;
      const parent = sessions.get(ourSid);
      if (!parent) continue;
      const childOur = `E${++sidSeq}`;
      parent.children.set(dsSid, childOur);
      rec.byParent.set(ourSid, childOur);
      send({
        method: "Target.attachedToTarget",
        params: { ...params, sessionId: childOur },
        sessionId: ourSid,
      });
    }
    return;
  }
  if (method === "Target.detachedFromTarget") {
    const dsSid = params && params.sessionId;
    const rec = dsSid && childByDsSid.get(dsSid);
    if (rec) {
      for (const [parentOur, childOur] of rec.byParent) {
        send({
          method: "Target.detachedFromTarget",
          params: { sessionId: childOur, targetId: params && params.targetId },
          sessionId: parentOur,
        });
        const parent = sessions.get(parentOur);
        if (parent) parent.children.delete(dsSid);
      }
      childByDsSid.delete(dsSid);
    }
    return;
  }
  for (const ourSid of siblings) {
    send({ method, params, sessionId: ourSid });
  }
});

// onDetach：Chrome 侧主动断开调试（tab 关闭 / 用户开 DevTools / 手动取消）
chrome.debugger.onDetach.addListener(async (source, reason) => {
  const targetId =
    (targetByTab.get(source.tabId) || {}).targetId || source.targetId;
  if (targetId) await dropTarget(targetId);
  if (reason === "target_closed" && targetId) {
    send({ method: "Target.targetDestroyed", params: { targetId } });
  }
});

// ── chrome.tabs 事件 → Target 生命周期事件 ──────────────────────────

chrome.tabs.onCreated.addListener((tab) => {
  refreshTargets().then(() => {
    const entry = targetByTab.get(tab.id);
    if (!entry) return; // 映射未就绪：下次 onUpdated 补 targetInfoChanged
    const opener = tab.openerTabId;
    send({
      method: "Target.targetCreated",
      params: {
        targetInfo: {
          targetId: entry.targetId,
          type: "page",
          title: tab.title || "",
          url: tab.url || "about:blank",
          attached: false,
          tabId: tab.id,
          ...(opener && targetByTab.has(opener)
            ? { openerId: targetByTab.get(opener).targetId }
            : {}),
        },
      },
    });
    if (rootAutoAttach) attachTarget(entry.targetId).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const entry = targetByTab.get(tabId);
  if (!entry) return;
  if (changeInfo.url) entry.url = changeInfo.url;
  if (changeInfo.title) entry.title = changeInfo.title;
  send({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: {
        targetId: entry.targetId,
        type: entry.type,
        title: entry.title,
        url: entry.url,
        attached: attached.has(entry.targetId),
        tabId,
      },
    },
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = targetByTab.get(tabId);
  if (!entry) return;
  targetByTab.delete(tabId);
  tabByTarget.delete(entry.targetId);
  dropTarget(entry.targetId).then(() => {
    send({ method: "Target.targetDestroyed", params: { targetId: entry.targetId } });
  });
});

// ── 生命周期入口 ────────────────────────────────────────────────────

chrome.alarms.create("cdp-ext-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cdp-ext-keepalive" && !ws) connect();
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect(); // SW 每次唤醒都尝试连接（已连接则幂等返回）
