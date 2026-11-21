// cdp-ext service worker — 反向 CDP 桥核心（Chrome MV3）。
//
// 职责：装在用户日常 Chrome 中，通过反向 WebSocket 连向 cdproxy（/ext?token=…），
// 用 chrome.debugger + chrome.tabs + chrome.tabGroups 把宿主浏览器仿真为浏览器级
// CDP 端点（flatten-only，无需 --remote-debugging-port）：
//
//   cdproxy(9225 /ext) ◄── 反向拨出（本 SW 发起）── 本 SW ── chrome.debugger ──► 各 tab
//
// 协议帧：
//   收：{id, method, params[, sessionId]}  命令（含 sessionId=页面会话命令）
//       {"abCtl":"reload"}                 控制面下发的热重载指令（chrome.runtime.reload）
//   发：{id, result|error}                 响应
//       {method, params[, sessionId]}      事件（Target 生命周期 / 页面会话事件）
//       {"abCtl":"hello","version":...}    握手版本上报
//       {"abCtl":"restore"}                SW 重启后原位恢复，通知 proxy 跳过清归属
//       {"abCtl":"gstate"|"sync",...}      标签组真相快照/增量投影
//       {"hb":1}                           心跳（20s，兼作 MV3 SW 保活）
//
// 仿真的浏览器级命令：
//   Target.getTargets / getTargetInfo  ← chrome.debugger.getTargets（无参返回浏览器自身）
//   Target.createTarget / closeTarget / activateTarget ← chrome.tabs.*
//   Target.attachToTarget(flatten) / detachFromTarget / setAutoAttach / attachToBrowserTarget
//                                      ← 虚拟会话多路复用（1 物理 attach 叠 N 虚拟会话）
//   Target.getBrowserContexts          ← 恒空（单默认 context：cdp-ext-default）
//   Browser.getVersion / setDownloadBehavior ← 合成 Chrome/cdp-ext-bridge / 假成功
//   Browser.close                      ← 拒绝（宿主是用户浏览器，proxy 侧另有基座保护）
//   页面会话命令 & OOPIF/worker 子会话   ← chrome.debugger.sendCommand 全透传
//
// Playwright connectOverCDP 关键契约（改动须过 ext_smoke_test + ext_playwright_e2e）：
//   1) 响应必回带 sessionId；targetInfo 必带 browserContextId；detachedFromTarget 必带 targetId
//   2) attachedToTarget 先于 setAutoAttach / createTarget 响应送达
//   3) 会话内 attach 事件须嵌套在父 sessionId 下，禁止广播（防 Duplicate target）
//   4) createTarget 毫秒级应答（防 alloc 预开归属输给紧随其后的 getTargets）
//
// 会话韧性与软休眠（改动须过 ext_restart_test）：
//   - 虚拟会话表变更即写透 chrome.storage.session（禁止防抖写——SW 挂起会冻住计时器丢写入）；
//     SW 重启由 loadPersistedState 原位恢复并回发 {"abCtl":"restore"}；0.5min alarm + 工具栏
//     点按（chrome.action.onClicked）兜底唤醒
//   - 用户点调试横幅「取消」或 DevTools 接管 → 软休眠（摘物理 attach，保留会话表且静默不发事件）；
//     下一条会话命令懒重挂；若休眠期 tab 已关则诚实报错未知 sessionId
//
// 标签组投影与事件准入（组 = 唯一真相，改动须过 ext_group_test + ext_cold_test + ext_event_gate_test）：
//   - 会话 tab 自动入组 `ab: <会话名>`（入组按会话名经 groupChain 串行防并发双组）；
//     拖入=归属、拖出=收回、跨组拖动=领地转移；组内 tab 允许真关
//   - release 策略由 options 页 releasePolicy 控制：close（全关删组）/ mark（墓碑 `· released`
//     灰组，同名会话回来摘碑认领）/ keep（原样保留）；冷启动凭 gstate 全量重建无孤儿
//   - 事件准入：仅会话组成员进入事件流；创建单出口在 createTarget 归组且应答之后，
//     tabs.onCreated 不直发 targetCreated（用户手动开 tab = 组外不可见）
//
// 已知边界：一 tab 一 debugger（开 DevTools 时 attach 报错）；软休眠/SW 重启不保留 OOPIF/worker
// 子会话；heap/CPU profiler 等浏览器级域不可用；下载落盘按宿主默认行为。

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
const RELEASED_SUFFIX = " · released";
const GROUP_COLORS = ["red", "yellow", "green", "cyan", "blue", "purple", "pink", "orange"];
let reconcileTimer = null;

function groupColorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

// SW 重启后组表重建：按标题前缀识别会话组（标题是稳定契约）
// parseSessionName 组标题 → 会话名：仅认 "ab: " 前缀；release 策略 mark 打的
// " · released" 后缀剥掉（墓碑组仍是该会话的领地，可被同名 alloc 复活认领）。
function parseSessionName(title) {
  if (!title || !title.startsWith(GROUP_PREFIX)) return null;
  let name = title.slice(GROUP_PREFIX.length);
  if (name.endsWith(RELEASED_SUFFIX)) name = name.slice(0, -RELEASED_SUFFIX.length);
  return name || null;
}

async function rebuildGroupMaps() {
  try {
    const groups = await chrome.tabGroups.query({});
    for (const g of groups) {
      const name = parseSessionName(g.title);
      if (name !== null) sessionGroups.set(name, g.id);
    }
  } catch { /* tabGroups 权限缺失等，静默降级为不分组 */ }
}

async function addToGroupInner(sessionName, tabId) {
  try {
    let groupId = sessionGroups.get(sessionName);
    if (groupId !== undefined) {
      // 缓存组可能已死（release 后组被删/用户手动解散）：死缓存清掉走完整
      // 查找，否则 tabs.group 抛错导致永不入组。
      const g = await chrome.tabGroups.get(groupId).catch(() => null);
      if (!g) {
        sessionGroups.delete(sessionName);
        groupId = undefined;
      } else if (g.title.endsWith(RELEASED_SUFFIX)) {
        // 缓存命中的是墓碑组：先摘碑再入组（复活语义与显式查找一致）。
        await chrome.tabGroups.update(groupId, {
          title: GROUP_PREFIX + sessionName,
          color: groupColorFor(sessionName),
        }).catch(() => {});
      }
    }
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
      } else {
        // 墓碑复活：release 策略 mark 留下的 "… · released" 组是同会话的
        // 领地标记——同名会话回来时摘掉墓碑（改回标题+配色）复用该组，
        // 不另建新组（组在即领地）。
        const tomb = await chrome.tabGroups.query({ title: GROUP_PREFIX + sessionName + RELEASED_SUFFIX });
        if (tomb.length) {
          groupId = tomb[0].id;
          await chrome.tabGroups.update(groupId, {
            title: GROUP_PREFIX + sessionName,
            color: groupColorFor(sessionName),
          }).catch(() => {});
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

// groupFor 会话组解析（reconcile/gstate 用）：优先缓存绑定；缓存组已空时
// 按标题重绑（防历史竞态/用户删组后重建导致的空绑定——空绑定会让对账误
// 判全量收回）。墓碑组（mark 策略）不算活组：gstate 不把 "… · released"
// 当作当前领地（它是已释放的标记，等同名会话回来时 addToGroup 摘碑复活）。
async function groupFor(sessionName) {
  const cached = sessionGroups.get(sessionName);
  if (cached !== undefined) {
    const inG = await chrome.tabs.query({ groupId: cached });
    if (inG.length) {
      const g = await chrome.tabGroups.get(cached).catch(() => null);
      if (g && parseSessionName(g.title) === sessionName && !g.title.endsWith(RELEASED_SUFFIX)) return cached;
    }
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
    // 兼容两种来源：chrome.debugger 原始 targetInfo（id 字段）与缓存归一化
    // 条目（targetId 字段，sync/gstate 随行信息用）
    targetId: ti.id ?? ti.targetId,
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
      send({ abCtl: "hello", version: chrome.runtime.getManifest().version });
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
      // 全量组事实：每次回连必报（冷热皆同）。proxy 据此重建归属投影——
      // 组在即领地：扩展刷新/浏览器重启都不再制造孤儿，旧组等待同名会话
      // 认领。墓碑组（· released）不算活领地，不在此上报。
      await sendGstate();
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
        // 组员身份回填：tab 静止（无 onUpdated）时这是 entry.groupId 的唯一
        // 更新来源（adopt 拖入/SW 重启恢复后尤其如此）
        for (const t of tabs) {
          const e = targetByTab.get(t.id);
          if (e) e.groupId = groupId;
        }
        const entries = tabs
          .map((t) => targetByTab.get(t.id))
          .filter(Boolean);
        send({
          abCtl: "sync", session: sessionName,
          targetIds: entries.map((e) => e.targetId),
          // targetInfo 全量随行：proxy 归属新增时向客户端合成 targetCreated
          // 事件（页面列表靠事件流维护，getTargets 轮询不可依赖）
          infos: entries.map((e) => cdpTargetInfo(e)),
        });
      }
    } catch (e) {
      console.warn("[cdp-ext] 组对账失败", e);
    }
  }, delayMs);
}

// onControl proxy → 扩展的控制消息。
async function onControl(msg) {
  switch (msg.abCtl) {
    case "release": {
      // 会话结束：tab 处置归本扩展的 release 策略（options 配置）——
      // close：关闭全部组内 tab（组随最后一个 tab 消失）；
      // mark：组加墓碑（标题 "… · released" + 灰色），tab 保留，同名会话
      //       回来时摘碑复活、整组认领；
      // keep：什么都不动（领地原样保留）。
      // 三种策略下该会话的虚拟会话与物理 attach 都清理（daemon 已断，
      // E 句柄作废；proxy 已合成销毁事件）。
      const sessionName = msg.session;
      const cfg = await chrome.storage.local.get(["releasePolicy"]);
      const policy = cfg.releasePolicy || "close";
      const groupId = await groupFor(sessionName);
      if (groupId !== undefined) {
        const tabs = await chrome.tabs.query({ groupId });
        const tids = tabs.map((t) => (targetByTab.get(t.id) || {}).targetId).filter(Boolean);
        for (const tid of tids) await dropTarget(tid);
        if (policy === "close") {
          await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
        } else if (policy === "mark") {
          await chrome.tabGroups.update(groupId, {
            title: GROUP_PREFIX + sessionName + RELEASED_SUFFIX,
            color: "grey",
          }).catch(() => {});
        }
        // keep：组与 tab 原样保留
      }
      break;
    }
    case "reload": {
      console.info("[cdp-ext] 收到 proxy 重载指令");
      setTimeout(() => chrome.runtime.reload(), 60);
      break;
    }
  }
}

// sendGstate 全量组事实上报：所有 "ab: " 活组（非墓碑）的 会话名 → 成员
// targetId 列表。proxy 以此重建归属投影。
async function sendGstate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    await refreshTargets();
    const groups = await chrome.tabGroups.query({});
    const bySession = new Map(); // 会话名 → targetIds（多组同名取并集）
    for (const g of groups) {
      if (!g.title || !g.title.startsWith(GROUP_PREFIX) || g.title.endsWith(RELEASED_SUFFIX)) continue;
      const name = parseSessionName(g.title);
      if (name === null) continue;
      const tabs = await chrome.tabs.query({ groupId: g.id });
      // 组员身份回填（同 scheduleReconcile：gstate 是重启/回连后的权威全量）
      for (const t of tabs) {
        const e = targetByTab.get(t.id);
        if (e) e.groupId = g.id;
      }
      const entries = tabs.map((t) => targetByTab.get(t.id)).filter(Boolean);
      if (!bySession.has(name)) bySession.set(name, { targetIds: [], infos: [] });
      const agg = bySession.get(name);
      agg.targetIds.push(...entries.map((e) => e.targetId));
      agg.infos.push(...entries.map((e) => cdpTargetInfo(e)));
    }
    send({
      abCtl: "gstate",
      groups: [...bySession.entries()].map(([session, agg]) => ({
        session, targetIds: agg.targetIds, infos: agg.infos,
      })),
    });
  } catch (e) {
    console.warn("[cdp-ext] gstate 上报失败", e);
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
      // targetCreated 单出口：归组完成后在应答之后发出。应答先到 → proxy 记
      // 归属 → 事件到达时 OwnerOf 命中，路由给会话（顺序反了会以无主身份
      // 被丢弃——创建与登记在组模型下由这一个出口原子完成）。
      if (sessionName) {
        await addToGroup(sessionName, tab.id);
        const entry = targetByTab.get(tab.id);
        if (entry && tab.groupId !== undefined) entry.groupId = tab.groupId;
        respond(id, { targetId, abGroup: GROUP_PREFIX + sessionName });
        send({
          method: "Target.targetCreated",
          params: {
            targetInfo: {
              targetId,
              type: "page",
              title: tab.title || "",
              url: tab.url || params.url || "about:blank",
              attached: false,
              browserContextId: "cdp-ext-default",
              tabId: tab.id,
            },
          },
        });
      } else {
        respond(id, { targetId });
        send({
          method: "Target.targetCreated",
          params: {
            targetInfo: {
              targetId,
              type: "page",
              title: tab.title || "",
              url: tab.url || params.url || "about:blank",
              attached: false,
              browserContextId: "cdp-ext-default",
              tabId: tab.id,
              ...(tab.openerTabId !== undefined && targetByTab.has(tab.openerTabId)
                ? { openerId: targetByTab.get(tab.openerTabId).targetId }
                : {}),
            },
          },
        });
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
// 事件准入（组=唯一真相）：只有会话组成员（含墓碑组）的生命周期进入事件流。
// 物理宇宙里其余 tab（用户手动开/页面弹窗）与系统无关——不是"被过滤掉"，
// 而是本就不在系统定义的宇宙里。创建单出口：我们自己 createTarget 的 tab
// 在归组完成后由命令处理直接发 targetCreated（天然原子，无双报竞态）。

// sessionGroupIds 当前全部会话组（含墓碑）的 groupId 集合。
function sessionGroupIds() {
  return new Set(sessionGroups.values());
}

chrome.tabs.onCreated.addListener((tab) => {
  // 新 tab 不发 targetCreated：createTarget 路径自己发（归组后），
  // 其余来源（用户手动/页面 window.open）= 组外 = 无主不可见（设计语义）。
  // 只建立映射供后续 onUpdated/命令使用。
  if (tab.groupId !== undefined && tab.groupId !== -1) {
    // 极罕见：创建即带组（组内新标签按钮）。记下，事件由 onUpdated 通道覆盖。
  }
  refreshTargets().then(() => {
    const entry = targetByTab.get(tab.id);
    if (entry && tab.groupId !== undefined) entry.groupId = tab.groupId;
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined || changeInfo.windowId !== undefined) scheduleReconcile();
  const entry = targetByTab.get(tabId);
  if (!entry) return;
  if (changeInfo.url) entry.url = changeInfo.url;
  if (changeInfo.title) entry.title = changeInfo.title;
  // 组员身份缓存：tab.groupId 是最新事实（-1=无组）
  if (tab && tab.groupId !== undefined) entry.groupId = tab.groupId;
  // 准入：非会话组成员的 tab 不进入事件流
  if (!entry.groupId || !sessionGroupIds().has(entry.groupId)) return;
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
  // 准入：组员的关闭才进入事件流（entry.groupId 是最后已知身份，不查实时——
  // 关闭瞬间 Chrome 可能已把 tab 移出组，实时查询会误判成组外）。组外的
  // 用户 tab 关闭与系统无关。
  const wasMember = entry.groupId && sessionGroupIds().has(entry.groupId);
  if (!wasMember) return;
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
