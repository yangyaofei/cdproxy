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
// 会话表持久化（chrome.storage.session：SW 重启存活、浏览器重启清空——
// 恰好是「虚拟会话应随 SW 世代延续还是消亡」的正确语义）。MV3 SW 会被
// Chrome 随时终止（内存压力/生命周期上限），无持久化时一次终止即蒸发全部
// 虚拟会话，proxy 侧全量清归属 + 合成销毁事件，客户端在跑的命令全部报
// 「未知 sessionId」。
const STATE_KEY = "cdpExtState";
// ── 状态表 ─────────────────────────────────────────────────────────

// ── 标签组（可见性 = 组成员）─────────────────────────────────────
// 每个会话一个 "ab: <session>" 彩色组：扩展创建的 tab 自动入组；用户把
// 自己的 tab 拖进组 = 交给该会话，拖出 = 收回。组成员变化经 sync 控制消息
// 与 proxy 归属表对账（幂等，事件驱动 + alarm 兜底，漏事件可自愈）。
const GROUP_PREFIX = "ab: ";
const GROUP_COLORS = ["red", "yellow", "green", "cyan", "blue", "purple", "pink", "orange"];
let reconcileTimer = null;

function groupColorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

// SW 重启后组表重建：按标题前缀识别会话组（标题是稳定契约）
async function rebuildGroupMaps() {
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      if (g.title && g.title.startsWith(GROUP_PREFIX)) {
        sessionGroups.set(g.title.slice(GROUP_PREFIX.length), g.id);
      }
    }
  } catch { /* tabGroups 权限缺失等，静默降级为不分组 */ }
}

async function addToGroupInner(sessionName, tabId) {
  try {
    let groupId = sessionGroups.get(sessionName);
    if (groupId === undefined) {
      // 缓存缺失（SW 被 MV3 重启过）：按标题找回既有组，防重复建组
      const found = await chrome.tabGroups.query({ title: GROUP_PREFIX + sessionName });
      if (found.length) {
        groupId = found[0].id;
        // 并发竞态残留的同名空组：把残留组里的 tab 并回第一个组（组空后
        // Chrome 自动清理），保证一会话一组
        if (found.length > 1) {
          for (const g of found.slice(1)) {
            const stray = await chrome.tabs.query({ groupId: g.id });
            if (stray.length) {
              await chrome.tabs.group({ tabIds: stray.map((t) => t.id), groupId });
            }
          }
        }
      }
    }
    if (groupId !== undefined) {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
      sessionGroups.set(sessionName, groupId);
      return;
    }
    const tab = await chrome.tabs.get(tabId);
    groupId = await chrome.tabs.group({
      tabIds: [tabId],
      createProperties: { windowId: tab.windowId },
    });
    await chrome.tabGroups.update(groupId, {
      title: GROUP_PREFIX + sessionName,
      color: groupColorFor(sessionName),
    });
    sessionGroups.set(sessionName, groupId);
  } catch (e) {
    console.warn("[cdp-ext] 入组失败（不影响功能，仅无视觉分组）", sessionName, e);
  }
}

// addToGroup 按会话名串行化：preopen（fire-and-forget）与客户端 createTarget
// 可能并发入组，缓存检查→建组是多步异步，不串行会各建一个组（同名双组，
// sessionGroups 绑到空组 → 对账永远查不到成员）。
const groupChain = new Map(); // 会话名 → 进行中的入组 Promise
function addToGroup(sessionName, tabId) {
  const run = (groupChain.get(sessionName) || Promise.resolve())
    .catch(() => {})
    .then(() => addToGroupInner(sessionName, tabId));
  groupChain.set(sessionName, run);
  run.finally(() => {
    if (groupChain.get(sessionName) === run) groupChain.delete(sessionName);
  });
  return run;
}

// groupFor 会话组解析（reconcile 用）：优先缓存绑定；缓存组已空时按标题
// 重绑（防历史竞态/用户删组后重建导致的空绑定——空绑定会让对账误判全量
// 收回）。
async function groupFor(sessionName) {
  const cached = sessionGroups.get(sessionName);
  if (cached !== undefined) {
    const inG = await chrome.tabs.query({ groupId: cached });
    if (inG.length) return cached;
  }
  const byTitle = await chrome.tabGroups.query({ title: GROUP_PREFIX + sessionName });
  for (const g of byTitle) {
    const ts = await chrome.tabs.query({ groupId: g.id });
    if (ts.length) {
      sessionGroups.set(sessionName, g.id);
      return g.id;
    }
  }
  return undefined;
}

let ws = null;
let backoffMs = 500;
let heartbeatTimer = null;
const sessionGroups = new Map(); // 会话名 → groupId（SW 重启按组标题重建）

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
      const restored = await loadPersistedState();
      await refreshTargets();
      if (restored) {
        // SW 世代延续：会话表原位恢复，restore 让 proxy 跳过清归属/合成销毁；
        // 物理 attach 属于扩展而非 SW 实例，SW 重启不死——校验一遍，失效的
        // （如用户手动停过调试）重新挂上。
        // tabId 回填：持久化里缺失的（旧格式/浏览器重启换了 tab）按 target 映射补
        for (const [, s] of sessions) {
          if (s.tabId === undefined && !s.browser) s.tabId = tabByTarget.get(s.targetId);
        }
        await verifyAttached();
        send({
          abCtl: "restore",
          sessions: [...sessions.entries()].map(([sid, s]) => ({
            sid, targetId: s.targetId, browser: !!s.browser,
          })),
        });
      } else {
        await resetState();
      }
      await rebuildGroupMaps();
      scheduleReconcile(0);
      startHeartbeat();
    };
    sock.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && msg.id !== undefined) return onCommand(msg);
      if (msg && msg.abCtl !== undefined) return onControl(msg);
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

// ── 会话表持久化 ───────────────────────────────────────────────────
// 每次会话表变更立即写透 chrome.storage.session（串行链防并发交错）。
// 不可用防抖：MV3 SW 在事件间隙会近乎立即挂起，挂起会冻结计时器——
// 防抖窗口内的写入在 SW 被杀时直接丢失（实测复现：attach 后 1s 状态仍未
// 落盘）。写透后 SW 重启 loadPersistedState() 原位恢复，重连时经 restore
// 控制消息让 proxy 跳过「清归属 + 合成销毁」，命令流对 SW 重启无感。
let persistChain = Promise.resolve();
function persistStateSoon() {
  persistChain = persistChain
    .then(async () => {
      const st = serializeState();
      await chrome.storage.session.set({ [STATE_KEY]: st });
    })
    .catch(() => { /* 存储不可用：退化为旧的无持久化行为 */ });
}

function serializeState() {
  const sess = {};
  for (const [sid, s] of sessions) {
    sess[sid] = { targetId: s.targetId, tabId: s.tabId, browser: !!s.browser };
  }
  const roots = {};
  for (const [tid, set] of rootsByTarget) roots[tid] = [...set];
  const children = {};
  for (const [dsSid, c] of childByDsSid) {
    const byParent = {};
    for (const [p, child] of c.byParent) byParent[p] = child;
    children[dsSid] = { targetId: c.targetId, byParent };
  }
  return { sidSeq, rootAutoAttach, sessions: sess, roots, children, attached: [...attached.keys()] };
}

async function loadPersistedState() {
  try {
    const got = await chrome.storage.session.get(STATE_KEY);
    const st = got[STATE_KEY];
    if (!st) return false;
    sidSeq = st.sidSeq || 0;
    rootAutoAttach = !!st.rootAutoAttach;
    for (const [sid, s] of Object.entries(st.sessions || {})) {
      sessions.set(sid, { targetId: s.targetId, tabId: s.tabId, browser: !!s.browser, children: new Map() });
    }
    for (const [tid, sids] of Object.entries(st.roots || {})) {
      rootsByTarget.set(tid, new Set(sids));
    }
    for (const [dsSid, c] of Object.entries(st.children || {})) {
      childByDsSid.set(dsSid, { targetId: c.targetId, byParent: new Map(Object.entries(c.byParent || {})) });
    }
    for (const tid of st.attached || []) attached.set(tid, {});
    return true;
  } catch (err) {
    console.warn("[cdp-ext] 持久化恢复异常（按冷启动处理）", err && err.message);
    return false;
  }
}

// ── 组对账（sync 控制消息）────────────────────────────────────────
// 组成员 = 会话可见集。浏览器侧 tabs/tabGroups 事件驱动 + alarm 兜底，
// 防抖合并后把每个会话组的当前成员全量上报，proxy 差分 adopt/revoke。

function scheduleReconcile(delayMs = 300) {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(async () => {
    reconcileTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN || sessionGroups.size === 0) return;
    try {
      await refreshTargets();
      for (const [sessionName] of sessionGroups) {
        const groupId = await groupFor(sessionName);
        if (groupId === undefined) continue;
        const tabs = await chrome.tabs.query({ groupId });
        const targetIds = tabs
          .map((t) => (targetByTab.get(t.id) || {}).targetId)
          .filter(Boolean);
        send({ abCtl: "sync", session: sessionName, targetIds });
      }
    } catch (e) {
      console.warn("[cdp-ext] 组对账失败", e);
    }
  }, delayMs);
}

// onControl proxy → 扩展的控制消息。
async function onControl(msg) {
  switch (msg.abCtl) {
    case "return": {
      // 单个借出 tab 归还（会话仍活着）：移出会话组 + 清该 target 的虚拟
      // 会话与物理 attach；组绑定保留（用户可再次拖入 adopt）
      await ungroupAdopted(msg.adopted || []);
      for (const tid of msg.adopted || []) await dropTarget(tid);
      break;
    }
    case "release": {
      // 会话结束：借出的 tab 移出组（保持打开，归还用户）；扩展侧清理
      // 这些 target 的虚拟会话与物理 attach（proxy 已向会话合成销毁事件）
      await ungroupAdopted(msg.adopted || []);
      for (const tid of msg.adopted || []) await dropTarget(tid);
      sessionGroups.delete(msg.session);
      break;
    }
    case "adoptDenied":
      // 已属其他会话却出现在本组（理论少见：组间转移的正常路径是先 revoke）
      console.warn("[cdp-ext] adopt 被拒（tab 属其他会话）", msg.targetIds);
      break;
  }
}

// ungroupAdopted 把借出 tab 移出会话组（tab 保持打开，回到用户普通 tab 列）。
async function ungroupAdopted(targetIds) {
  const tabIds = targetIds
    .map((tid) => tabByTarget.get(tid))
    .filter((x) => x !== undefined);
  if (tabIds.length) {
    try { await chrome.tabs.ungroup(tabIds); } catch { /* tab 已关等 */ }
  }
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
// resetState 冷启动的干净起点（浏览器重启/无持久化状态）：清会话表并
// detach 上一世代 attach 过的 tab。
// 注意：SW 普通重启不走这里（loadPersistedState 命中 → restore 原位续接，
// 物理 attach 属于扩展不随 SW 死，无需 detach）。
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
  sessionGroups.clear(); // 组映射随后 rebuildGroupMaps() 按浏览器现状重建
  await refreshTargets();
  const got = await chrome.storage.session.get(ATTACH_STORAGE_KEY);
  const attachedList = got[ATTACH_STORAGE_KEY] || [];
  for (const target of attachedList) {
    chrome.debugger.detach(target).catch(() => {});
  }
  await chrome.storage.session.set({ [ATTACH_STORAGE_KEY]: [] });
  await chrome.storage.session.set({ [STATE_KEY]: null });
}

// verifyAttached 恢复后校验物理 attach 仍有效（用户可能经 chrome://extensions
// 手动停过调试）：发一条廉价命令探活，失效的重挂。
async function verifyAttached() {
  for (const targetId of [...attached.keys()]) {
    try {
      await chrome.debugger.sendCommand({ targetId }, "Target.getTargetInfo", {});
    } catch {
      try {
        const tabId = tabByTarget.get(targetId);
        await chrome.debugger.attach({ targetId, tabId }, "1.3");
      } catch { attached.delete(targetId); }
    }
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
      const sessionName = params.abSession || null; // proxy 夹带的会话名（私有参数）
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
      if (sessionName) {
        await addToGroup(sessionName, tab.id);
        respond(id, { targetId, abGroup: GROUP_PREFIX + sessionName });
      } else {
        respond(id, { targetId });
      }
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
      persistStateSoon();
      respond(id, { sessionId: ourSid });
      return;
    }
    case "Target.setAutoAttach": {
      rootAutoAttach = !!params.autoAttach;
      persistStateSoon();
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

  // 页面会话：物理 attach 可能处于软休眠（用户点过横幅「取消」）——先懒重挂
  // 再透传。重挂失败（DevTools 占用 / tab 已关）如实报错，客户端可见明确原因。
  try {
    await ensureAttached(sess.targetId, sess.tabId);
  } catch (err) {
    return send({
      id, sessionId: sid,
      error: {
        code: -32000,
        message: `cdp-ext: 会话 ${sid} 处于休眠，重新附加 ${sess.targetId} 失败` +
          `（tab 已关或被 DevTools 占用）: ${err && err.message ? err.message : String(err)}`,
      },
    });
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

// ensureAttached 确保某 target 的物理 debugger attach 在场（懒重挂）：
// 用户点横幅「取消」后会话转入软休眠（见 onBrowserDetach），下一条命令到达
// 时在此重新 attach——横幅重现即「又有活儿在干」的正确反馈。失败（用户开着
// DevTools / tab 已关）如实抛错由调用方转达客户端。
async function ensureAttached(targetId, tabId) {
  if (attached.has(targetId)) return;
  const debuggee = tabId !== undefined ? { tabId } : { targetId };
  try {
    await chrome.debugger.attach(debuggee, "1.3");
  } catch (err) {
    // 状态与现实赛跑的兜底：attach 报「已附加」说明物理层其实在场（如 SW
    // 恢复的 attached 表滞后），视作在场继续——其余错误（DevTools 占用/tab
    // 已关）原样抛出。
    const msg = (err && err.message) || String(err);
    if (!/already attached/i.test(msg)) throw err;
  }
  attached.set(targetId, { tabId });
  persistStateSoon();
}

// attachTarget 对 target 建立一个「虚拟会话」并回发 attachedToTarget；返回 ourSid。
// 物理层 chrome.debugger 每 tab 只允许一个 attach——多客户端复用同一 target
// 时在物理 attach 上叠加多个虚拟会话（与真浏览器端点每连接独立会话语义对齐），
// 最后一个虚拟会话撤除时才真正 detach。
async function attachTarget(targetId, parentSid) {
  const tabId = tabByTarget.get(targetId);
  const ti = await targetInfoOf(targetId);
  if (!ti) throw new Error(`target ${targetId} 不存在`);
  await ensureAttached(targetId, tabId);
  const ourSid = `E${++sidSeq}`;
  sessions.set(ourSid, { targetId, tabId, children: new Map() });
  if (!rootsByTarget.has(targetId)) rootsByTarget.set(targetId, new Set());
  rootsByTarget.get(targetId).add(ourSid);
  persistStateSoon();
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
  }
  persistStateSoon();
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
  persistStateSoon();
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
      persistStateSoon();
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
    persistStateSoon();
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
      persistStateSoon();
    }
    return;
  }
  for (const ourSid of siblings) {
    send({ method, params, sessionId: ourSid });
  }
});

// onBrowserDetach 浏览器侧断开调试的处理主体（onDetach 监听器调用；测试经
// sw_eval 直接调用以复现「用户点取消」路径）。区分两种语义：
// - target_closed：tab 本身没了 → 真死，dropTarget 撤全部会话并补 targetDestroyed
// - 其余（用户点横幅「取消」/ 开 DevTools 接管）：软休眠——只摘物理 attach，
//   虚拟会话表原样保留，**不向客户端发任何事件**（「取消」= 用户的真实意图
//   「现在别烦我」，静默到下一条命令到达时懒重挂，见 ensureAttached）。
//   休眠期间该 target 的子会话（OOPIF/worker，随物理 attach 生死）一并失效。
async function onBrowserDetach(targetId, reason) {
  if (!targetId) return;
  if (reason === "target_closed") {
    await dropTarget(targetId);
    send({ method: "Target.targetDestroyed", params: { targetId } });
    return;
  }
  attached.delete(targetId);
  // 休眠即物理 attach 死：其下的真实子会话（dsSid）全部失效，清账防串扰
  for (const [dsSid, rec] of [...childByDsSid]) {
    if (rec.targetId === targetId) {
      for (const parentOur of rec.byParent.keys()) {
        const parent = sessions.get(parentOur);
        if (parent) parent.children.delete(dsSid);
      }
      childByDsSid.delete(dsSid);
    }
  }
  for (const ourSid of rootsByTarget.get(targetId) || []) {
    const s = sessions.get(ourSid);
    if (s) s.children.clear();
  }
  persistStateSoon();
  console.info("[cdp-ext] 调试被浏览器侧断开，会话软休眠（下一条命令自动重挂）", targetId, reason);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const targetId =
    (targetByTab.get(source.tabId) || {}).targetId || source.targetId;
  onBrowserDetach(targetId, reason);
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
  if (changeInfo.groupId !== undefined || changeInfo.windowId !== undefined) scheduleReconcile();
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
  scheduleReconcile();
  if (!entry) return;
  targetByTab.delete(tabId);
  tabByTarget.delete(entry.targetId);
  dropTarget(entry.targetId).then(() => {
    send({ method: "Target.targetDestroyed", params: { targetId: entry.targetId } });
  });
});

// 组成员变化的原生入口：拖入/拖出组、跨窗口移动、组更名/解散
chrome.tabs.onMoved.addListener(() => scheduleReconcile());
chrome.tabs.onDetached.addListener(() => scheduleReconcile());
chrome.tabs.onAttached.addListener(() => scheduleReconcile());
if (chrome.tabGroups) {
  chrome.tabGroups.onUpdated.addListener(() => scheduleReconcile());
  chrome.tabGroups.onRemoved.addListener(() => scheduleReconcile());
}

// ── 生命周期入口 ────────────────────────────────────────────────────

chrome.alarms.create("cdp-ext-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cdp-ext-keepalive") {
    if (!ws) connect();
    scheduleReconcile(0); // 兜底对账（SW 沉睡期间的变化自愈）
  }
});

chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.action?.onClicked?.addListener(connect); // 手动唤醒口：扩展被刷新后点工具栏图标即重连
connect(); // SW 每次唤醒都尝试连接（已连接则幂等返回）
