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
// 仿真的浏览器级命令与扩展权限对应：
//   Target.*                           ← debugger + tabs + tabGroups（会话隔离/组映射/popup 归属）
//   Storage.getCookies/setCookies/clearCookies / clearDataForOrigin
//                                      ← 优先走会话已附着 tab 的原生 chrome.debugger（零损 CDP 字段）；
//                                        无可用 tab 时回落 chrome.cookies（依赖 cookies + <all_urls>）
//   Browser.setDownloadBehavior / cancelDownload + Browser.downloadWillBegin/Progress
//                                      ← 桥接 Page.download* 事件 + chrome.downloads（依赖 downloads）
//                                        落盘后把绝对路径传给同机 proxy，实现 saveAs/path/cancel 全闭环
//   Browser.grantPermissions / setPermission / resetPermissions
//                                      ← chrome.contentSettings（依赖 contentSettings；仅影响本扩展层，
//                                        resetPermissions 不擦除用户手动设置）
//   Browser.getVersion / getWindowForTarget / getWindowBounds / setWindowBounds
//                                      ← navigator.userAgent 真实版本 + chrome.windows.*（tabs 权限自带）
//   Browser.setDockTile                ← 无害 UI 提示假成功
//   Browser.close                      ← 拒绝（宿主是用户浏览器，proxy 侧另有基座保护）
//   页面会话命令 & OOPIF/worker 子会话   ← chrome.debugger.sendCommand 全透传（含嵌套子会话）
//
// Playwright connectOverCDP 关键契约（改动须过 ext_smoke_test + ext_playwright_e2e）：
//   1) 响应必回带 sessionId；targetInfo 必带 browserContextId（及 openerId）；detachedFromTarget 必带 targetId
//   2) attachedToTarget 先于 setAutoAttach / createTarget 响应送达
//   3) 会话内 attach 事件须嵌套在父 sessionId 下，禁止广播（防 Duplicate target）
//   4) createTarget 毫秒级应答（防 alloc 预开归属输给紧随其后的 getTargets）
//   5) 会话 tab 触发的 target="_blank" / window.open / popup 窗口按 openerTabId 自动归属并立即同步
//
// 会话韧性与软休眠（改动须过 ext_restart_test）：
//   - 虚拟会话表变更即写透 chrome.storage.session（禁止防抖写——SW 挂起会冻住计时器丢写入）；
//     SW 重启由 loadPersistedState 原位恢复并回发 {"abCtl":"restore"}；0.5min alarm + 工具栏
//     点按（chrome.action.onClicked）兜底唤醒
//   - 用户点调试横幅「取消」或 DevTools 接管 → 软休眠（摘物理 attach，保留会话表且静默不发事件）；
//     下一条会话命令懒重挂；若休眠期 tab 已关则诚实报错未知 sessionId
//
// 标签组投影与事件准入（组 = 唯一真相，改动须过 ext_group_test + ext_cold_test + ext_event_gate_test）：
//   - 会话 tab 自动入组 `cdproxy: <会话名>`（入组按会话名经 groupChain 串行防并发双组）；
//     拖入=归属、拖出=收回、跨组拖动=领地转移；组内 tab 允许真关；会话弹出的独立 popup 窗口
//     因 Chrome 不允许对 popup 窗口分组，由 popupSessionByTab 随同会话同步与回收
//   - release 策略由 options 页 releasePolicy 控制：close（全关删组）/ mark（墓碑 `· released`
//     灰组，同名会话回来摘碑认领）/ keep（原样保留）；冷启动凭 gstate 全量重建无孤儿
//   - 事件准入：仅会话组成员（及会话派生的 popup 窗口）进入事件流；用户手动开的无 opener tab
//     仍为组外不可见
//
// 已知平台边界（Chrome MV3 扩展无法在用户日常浏览器突破）：
//   - 一 tab 一 debugger（开 DevTools 时触发软休眠，关闭后懒重挂恢复）
//   - Target.createBrowserContext / Security.setIgnoreCertificateErrors 不可用（多沙箱/自签证书请走 standalone 源）
//   - chrome.contentSettings 未开放 clipboard/midi/sensors 等权限类型，遇不支持项如实报错
//   - 软休眠不保留 OOPIF/worker 子会话（需页面重载或重新附着）

const DEFAULT_RELAY = "ws://127.0.0.1:9225/ext";
const DEFAULT_TOKEN = "";
const DEFAULT_GROUP_PREFIX = "cdproxy:";
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
// 每个会话一个 "<prefix> <session>"（默认 "cdproxy: <session>"）彩色组：
// 扩展创建的 tab 自动入组；用户把自己的 tab 拖进组 = 交给该会话，拖出 = 收回。
// 组成员变化经 sync 控制消息与 proxy 归属表对账（幂等，事件驱动 + alarm 兜底）。
let activeGroupPrefix = DEFAULT_GROUP_PREFIX;
const RELEASED_SUFFIX = " · released";
const GROUP_COLORS = ["red", "yellow", "green", "cyan", "blue", "purple", "pink", "orange"];
let reconcileTimer = null;

function normalizeGroupPrefix(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  return s || DEFAULT_GROUP_PREFIX;
}

function formatGroupTitle(sessionName, released = false) {
  return `${activeGroupPrefix} ${sessionName}${released ? RELEASED_SUFFIX : ""}`;
}

function groupColorFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return GROUP_COLORS[h % GROUP_COLORS.length];
}

// SW 重启后组表重建：按标题前缀识别会话组（标题是稳定契约）
// parseSessionName 组标题 → 会话名：匹配 "<prefix> " 或 "<prefix>"；release 策略
// mark 打的 " · released" 后缀剥掉（墓碑组仍是该会话的领地，可被同名 alloc 认领）。
function parseSessionName(title) {
  if (!title) return null;
  const spaced = `${activeGroupPrefix} `;
  let name = null;
  if (title.startsWith(spaced)) {
    name = title.slice(spaced.length);
  } else if (title.startsWith(activeGroupPrefix)) {
    name = title.slice(activeGroupPrefix.length).trimStart();
  } else {
    return null;
  }
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
          title: formatGroupTitle(sessionName),
          color: groupColorFor(sessionName),
        }).catch(() => {});
      }
    }
    if (groupId === undefined) {
      // 缓存缺失（SW 被 MV3 重启过）：按标题找回既有组，防重复建组
      const found = await chrome.tabGroups.query({ title: formatGroupTitle(sessionName) });
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
        const tomb = await chrome.tabGroups.query({ title: formatGroupTitle(sessionName, true) });
        if (tomb.length) {
          groupId = tomb[0].id;
          await chrome.tabGroups.update(groupId, {
            title: formatGroupTitle(sessionName),
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
      title: formatGroupTitle(sessionName),
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
  const byTitle = await chrome.tabGroups.query({ title: formatGroupTitle(sessionName) });
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
const popupSessionByTab = new Map(); // popup 窗口 tabId → 会话名（Chrome 不允许 popup 窗口分组）
const openerByTab = new Map(); // tabId → openerTabId（保留给 targetInfo.openerId）
const closingTargets = new Set(); // Target.closeTarget 正在关闭的 targetId（防关组内最后 tab 时 Chrome 先发 onUpdated(groupId=-1) 误判为组外）
// recentWindowOpens：chrome.debugger 的 Page.windowOpen 先于 chrome.tabs.onCreated
// 触发，携带真正发起跳转的后台 tabId（Chrome 对后台 tab 调用 window.open('_blank') 时，
// tabs.onCreated.openerTabId 会误填为窗口当前激活的用户 tab，必须以 Page.windowOpen 为准）。
const recentWindowOpens = []; // { openerTabId, url, at }
const WINDOW_OPEN_TTL_MS = 3000;

function recordWindowOpen(openerTabId, url) {
  if (openerTabId === undefined) return;
  const now = Date.now();
  while (recentWindowOpens.length && now - recentWindowOpens[0].at > WINDOW_OPEN_TTL_MS) {
    recentWindowOpens.shift();
  }
  recentWindowOpens.push({ openerTabId, url: url || "", at: now });
}

function consumeWindowOpen(tabUrl) {
  const now = Date.now();
  while (recentWindowOpens.length && now - recentWindowOpens[0].at > WINDOW_OPEN_TTL_MS) {
    recentWindowOpens.shift();
  }
  if (!recentWindowOpens.length) return undefined;
  if (tabUrl) {
    const idx = recentWindowOpens.findIndex((r) => r.url && r.url === tabUrl);
    if (idx >= 0) return recentWindowOpens.splice(idx, 1)[0].openerTabId;
  }
  return recentWindowOpens.shift().openerTabId;
}

// ── 下载桥接与站点权限状态 ─────────────────────────────────────────
// 下载桥接：Chrome 扩展无法在 chrome.debugger 下调 Browser.setDownloadBehavior，
// 但已附着 tab 会原生发出 Page.downloadWillBegin / Page.downloadProgress；
// 结合 chrome.downloads 拿真实磁盘绝对路径并传给同机 proxy 复制到 <downloadPath>/<guid>，
// 使 Playwright waitForEvent('download') / path() / saveAs() / cancel() 全闭环。
const sessionDownloadBehavior = new Map(); // sessionName → "allowAndName" | "allow" | "deny" | "default"
const activeDownloads = new Map(); // guid → 下载跟踪记录
const downloadGuidById = new Map(); // chrome.downloads item.id → guid
const unmatchedChromeDownloads = []; // chrome.downloads.onCreated 先于 Page.downloadWillBegin 到达时的暂存
const DOWNLOAD_MATCH_TTL_MS = 10_000;
const touchedContentSettings = new Set(); // 本扩展通过 contentSettings 写入过的权限键
const textEncoder = new TextEncoder();

const CDP_PERMISSION_TO_CONTENT_SETTING = {
  geolocation: "location",
  location: "location",
  notifications: "notifications",
  camera: "camera",
  videoCapture: "camera",
  microphone: "microphone",
  audioCapture: "microphone",
  automaticDownloads: "automaticDownloads",
  "automatic-downloads": "automaticDownloads",
  popups: "popups",
  cookies: "cookies",
  images: "images",
  javascript: "javascript",
  fullscreen: "fullscreen",
  mouselock: "mouselock",
  "pointer-lock": "mouselock",
};

const RESETTABLE_CONTENT_SETTINGS = [
  "location",
  "notifications",
  "camera",
  "microphone",
  "automaticDownloads",
  "popups",
  "cookies",
  "images",
  "javascript",
  "fullscreen",
  "mouselock",
];

function sessionNameOfTabSync(tabId) {
  if (tabId === undefined) return null;
  if (popupSessionByTab.has(tabId)) return popupSessionByTab.get(tabId);
  const gid = targetByTab.get(tabId)?.groupId;
  if (gid !== undefined && gid !== -1) {
    for (const [name, id] of sessionGroups) {
      if (id === gid) return name;
    }
  }
  return null;
}

function basenameOf(p) {
  if (!p) return "";
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

function stripChromeDupSuffix(name) {
  // Chrome 重复下载自动重命名如 "report (1).pdf" → "report.pdf"
  return name.replace(/ \(\d+\)(\.[^.]+)?$/, "$1");
}

function matchChromeDownloadScore(rec, item) {
  if (!item) return 0;
  if (rec.url && (item.url === rec.url || item.finalUrl === rec.url)) return 3;
  if (rec.suggestedFilename && item.filename) {
    const base = basenameOf(item.filename);
    if (base === rec.suggestedFilename || stripChromeDupSuffix(base) === rec.suggestedFilename) {
      return 2;
    }
  }
  const itemTs = typeof item.at === "number"
    ? item.at
    : (item.startTime ? Date.parse(item.startTime) : NaN);
  if (Number.isFinite(itemTs) && Math.abs(itemTs - rec.createdAt) <= DOWNLOAD_MATCH_TTL_MS) {
    return 1;
  }
  return 0;
}

async function cancelChromeDownload(downloadId, eraseAfter = false) {
  if (!chrome.downloads || downloadId == null) return;
  await chrome.downloads.cancel(downloadId).catch(() => {});
  if (eraseAfter) {
    await chrome.downloads.removeFile(downloadId).catch(() => {});
    await chrome.downloads.erase({ id: downloadId }).catch(() => {});
  }
}

function bindChromeDownload(rec, itemId, filename) {
  rec.downloadId = itemId;
  downloadGuidById.set(itemId, rec.guid);
  if (filename) rec.filename = filename;
  if (rec.deny || rec.canceledRequested) {
    cancelChromeDownload(itemId, rec.deny);
  }
}

function pruneUnmatchedChromeDownloads() {
  const now = Date.now();
  while (unmatchedChromeDownloads.length && now - unmatchedChromeDownloads[0].at > DOWNLOAD_MATCH_TTL_MS) {
    unmatchedChromeDownloads.shift();
  }
}

function handlePageDownloadWillBegin(tabId, rootTargetId, params) {
  const guid = params && params.guid;
  if (!guid || activeDownloads.has(guid)) return;
  const sessionName = sessionNameOfTabSync(tabId);
  const behavior = sessionName ? (sessionDownloadBehavior.get(sessionName) || "default") : "default";
  const rec = {
    guid,
    rootTargetId: rootTargetId || "",
    tabId,
    frameId: (params && params.frameId) || "",
    url: (params && params.url) || "",
    suggestedFilename: (params && params.suggestedFilename) || "",
    deny: behavior === "deny",
    canceledRequested: false,
    downloadId: null,
    filename: "",
    createdAt: Date.now(),
    completing: false,
    finished: false,
  };
  activeDownloads.set(guid, rec);
  pruneUnmatchedChromeDownloads();
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < unmatchedChromeDownloads.length; i++) {
    const score = matchChromeDownloadScore(rec, unmatchedChromeDownloads[i]);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0 && (bestScore >= 2 || unmatchedChromeDownloads.length === 1)) {
    const matched = unmatchedChromeDownloads.splice(bestIdx, 1)[0];
    bindChromeDownload(rec, matched.id, matched.filename);
  }
  send({
    method: "Browser.downloadWillBegin",
    params: {
      frameId: rec.frameId,
      guid: rec.guid,
      url: rec.url,
      suggestedFilename: rec.suggestedFilename,
      abTargetId: rec.rootTargetId,
    },
  });
}

function finalizeDownload(rec, state, totalBytes, receivedBytes, abFilename) {
  if (rec.finished) return;
  rec.finished = true;
  activeDownloads.delete(rec.guid);
  if (rec.downloadId !== null) downloadGuidById.delete(rec.downloadId);
  send({
    method: "Browser.downloadProgress",
    params: {
      guid: rec.guid,
      totalBytes: totalBytes ?? 0,
      receivedBytes: receivedBytes ?? 0,
      state,
      ...(abFilename ? { abFilename } : {}),
    },
  });
}

async function resolveDownloadDiskPath(rec) {
  if (!chrome.downloads) return "";
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (rec.downloadId !== null) {
      const items = await chrome.downloads.search({ id: rec.downloadId }).catch(() => []);
      const it = items && items[0];
      if (it) {
        if (it.filename) rec.filename = it.filename;
        if (it.state === "complete" && it.filename) return it.filename;
        if (it.state === "interrupted") return "";
      }
    } else {
      const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 10 }).catch(() => []);
      let best = null;
      let bestScore = 0;
      let windowCandidates = 0;
      for (const it of items || []) {
        if (downloadGuidById.has(it.id)) continue;
        const score = matchChromeDownloadScore(rec, it);
        if (score >= 1) windowCandidates++;
        if (score > bestScore) {
          bestScore = score;
          best = it;
        }
      }
      if (best && (bestScore >= 2 || (bestScore === 1 && windowCandidates === 1))) {
        rec.downloadId = best.id;
        downloadGuidById.set(best.id, rec.guid);
        if (best.filename) rec.filename = best.filename;
        if (best.state === "complete" && best.filename) return best.filename;
        if (best.state === "interrupted") return "";
      }
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  return rec.filename || "";
}

function handlePageDownloadProgress(params) {
  const guid = params && params.guid;
  const rec = guid && activeDownloads.get(guid);
  if (!rec || rec.finished) return;
  const st = (params && params.state) || "inProgress";
  if (st === "inProgress") {
    send({
      method: "Browser.downloadProgress",
      params: {
        guid,
        totalBytes: params.totalBytes ?? 0,
        receivedBytes: params.receivedBytes ?? 0,
        state: "inProgress",
      },
    });
    return;
  }
  if (st === "canceled") {
    finalizeDownload(rec, "canceled", params.totalBytes, params.receivedBytes, "");
    return;
  }
  if (st === "completed") {
    if (rec.completing) return;
    rec.completing = true;
    (async () => {
      if (rec.deny || rec.canceledRequested) {
        if (rec.downloadId === null && chrome.downloads) {
          await resolveDownloadDiskPath(rec);
        }
        if (rec.downloadId !== null) {
          await cancelChromeDownload(rec.downloadId, rec.deny);
        }
        finalizeDownload(rec, "canceled", params.totalBytes, params.receivedBytes, "");
        return;
      }
      const diskPath = await resolveDownloadDiskPath(rec);
      finalizeDownload(rec, "completed", params.totalBytes, params.receivedBytes, diskPath);
    })();
  }
}

function contentSettingPattern(origin) {
  if (!origin || origin === "*") return "<all_urls>";
  const u = new URL(origin);
  return `${u.origin}/*`;
}

function callContentSetting(cs, methodName, arg) {
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = cs[methodName](arg, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise.then(resolve, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

async function applyContentSetting(apiKey, pattern, setting) {
  const cs = chrome.contentSettings && chrome.contentSettings[apiKey];
  if (!cs || typeof cs.set !== "function") {
    throw new Error(`chrome.contentSettings.${apiKey} 不可用`);
  }
  const effective = setting === "ask" && (apiKey === "popups" || apiKey === "images" || apiKey === "javascript")
    ? "allow"
    : setting;
  await callContentSetting(cs, "set", { primaryPattern: pattern, setting: effective });
  touchedContentSettings.add(apiKey);
}

async function handleCookiesViaExtAPI(method, params) {
  if (method === "Storage.getCookies") {
    const raw = await chrome.cookies.getAll({});
    const sameSiteMap = { no_restriction: "None", lax: "Lax", strict: "Strict" };
    const cookies = raw.map((c) => {
      const out = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.session || c.expirationDate === undefined ? -1 : c.expirationDate,
        size: textEncoder.encode(c.name + c.value).length,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        session: !!c.session,
        priority: "Medium",
        sameParty: false,
        sourceScheme: c.secure ? "Secure" : "NonSecure",
        sourcePort: c.secure ? 443 : 80,
      };
      if (sameSiteMap[c.sameSite]) out.sameSite = sameSiteMap[c.sameSite];
      return out;
    });
    return { cookies };
  }
  if (method === "Storage.setCookies") {
    const sameSiteRev = { None: "no_restriction", Lax: "lax", Strict: "strict" };
    for (const c of params.cookies || []) {
      let url = c.url;
      if (!url) {
        const host = (c.domain || "").replace(/^\./, "");
        if (!host) throw new Error("cookie 缺少 url 与 domain");
        const scheme = c.secure ? "https" : "http";
        const path = c.path && c.path.startsWith("/") ? c.path : "/";
        url = `${scheme}://${host}${path}`;
      }
      const details = { url, name: c.name, value: c.value };
      if (c.domain) details.domain = c.domain;
      if (c.path) details.path = c.path;
      if (c.secure !== undefined) details.secure = !!c.secure;
      if (c.httpOnly !== undefined) details.httpOnly = !!c.httpOnly;
      if (typeof c.expires === "number" && c.expires > 0) details.expirationDate = c.expires;
      if (c.sameSite && sameSiteRev[c.sameSite]) details.sameSite = sameSiteRev[c.sameSite];
      await chrome.cookies.set(details);
    }
    return {};
  }
  if (method === "Storage.clearCookies") {
    const raw = await chrome.cookies.getAll({});
    for (const c of raw) {
      const host = (c.domain || "").replace(/^\./, "");
      if (!host) continue;
      const url = `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
      await chrome.cookies.remove({ url, name: c.name, storeId: c.storeId }).catch(() => {});
    }
    return {};
  }
  throw new Error(`未知 cookies 方法: ${method}`);
}

// ── 会话表 ─────────────────────────────────────────────────────────
// ourSid → 会话；root 键（targetId）与 childDsSid 各有反向索引。
// 每次反向连接重建（proxy 侧同刻清归属，旧 id 无引用者）。

let sidSeq = 0;
const sessions = new Map(); // ourSid → {targetId, tabId, children: Map<dsSid, ourSid>, dsChildSid?, parentOurSid?, rootTargetId?, browser?}
const rootsByTarget = new Map(); // targetId → Set<ourSid>（一个物理 attach 叠 N 个虚拟会话）
const childByDsSid = new Map(); // dsChildSessionId → {targetId, childTargetId, byParent: Map<parentOurSid, childOurSid>}
const attached = new Map(); // targetId → {tabId} 物理 attach 状态（一 tab 一 debugger，引用计数去重）
let rootAutoAttach = false; // 浏览器级 Target.setAutoAttach 标志

// targetId ⇄ tabId 映射（getTargets 刷新维护；事件路由与 attach 都依赖）
const targetByTab = new Map(); // tabId → {targetId, url, title, type, groupId?, openerTabId?}
const tabByTarget = new Map(); // targetId → tabId

// ── 配置与状态 ────────────────────────────────────────────────────

let reconnectTimer = null;
const connState = {
  status: "disconnected", // connected | connecting | auth_error | disconnected
  reason: "",             // invalid_token | missing_token | proxy_offline | source_disabled | ""
  relayUrl: DEFAULT_RELAY,
  lastConnectedAt: 0,
};

function updateBadge(status, reason) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  try {
    if (status === "connected") {
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#16a34a" });
      chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    } else if (status === "auth_error" || reason === "missing_token" || reason === "invalid_token") {
      chrome.action.setBadgeText({ text: "!" });
      chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
      chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    } else if (status === "connecting") {
      chrome.action.setBadgeText({ text: "…" });
      chrome.action.setBadgeBackgroundColor({ color: "#64748b" });
      chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch { /* ignore badge errors */ }
}

function setConnState(status, reason = "", relayUrl = connState.relayUrl) {
  connState.status = status;
  connState.reason = reason;
  if (relayUrl) connState.relayUrl = relayUrl;
  if (status === "connected") connState.lastConnectedAt = Date.now();
  updateBadge(status, reason);
}

async function loadBundledConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL("runtime-config.json"), { cache: "no-store" });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data || typeof data !== "object") return null;
    return {
      relayUrl: typeof data.relayUrl === "string" ? data.relayUrl.trim() : "",
      token: typeof data.token === "string" ? data.token.trim() : "",
      groupPrefix: normalizeGroupPrefix(data.groupPrefix),
      generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
    };
  } catch {
    return null;
  }
}

async function relayConfig(forceBundled = false) {
  const [got, bundled] = await Promise.all([
    chrome.storage.local.get(["relayUrl", "token", "groupPrefix", "releasePolicy", "_syncedFrom"]),
    loadBundledConfig(),
  ]);
  let url = typeof got.relayUrl === "string" ? got.relayUrl.trim() : "";
  let token = typeof got.token === "string" ? got.token.trim() : "";
  let groupPrefix = normalizeGroupPrefix(got.groupPrefix);
  const releasePolicy = got.releasePolicy || "close";

  // App 导出目录写入了更新的 runtime-config.json 时自动同步（保留用户的 releasePolicy）
  if (bundled && (forceBundled || (bundled.generatedAt && bundled.generatedAt !== got._syncedFrom) || (!url && !token))) {
    if (bundled.relayUrl) url = bundled.relayUrl;
    if (bundled.token !== undefined) token = bundled.token;
    if (bundled.groupPrefix) groupPrefix = normalizeGroupPrefix(bundled.groupPrefix);
    await chrome.storage.local.set({
      relayUrl: url || DEFAULT_RELAY,
      token,
      groupPrefix,
      releasePolicy,
      _syncedFrom: bundled.generatedAt || "bundled",
    }).catch(() => {});
  }

  url = url || DEFAULT_RELAY;
  activeGroupPrefix = normalizeGroupPrefix(groupPrefix);
  return { url, token, groupPrefix: activeGroupPrefix, releasePolicy, hasBundled: !!bundled };
}

async function diagnoseFailure(wsUrl, token) {
  try {
    const httpUrl = wsUrl.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
    const full = httpUrl + (httpUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token || "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(full, { method: "GET", signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (resp.status === 401) {
      return { status: "auth_error", reason: token ? "invalid_token" : "missing_token" };
    }
    if (resp.status === 503 || resp.status === 403) {
      return { status: "disconnected", reason: "source_disabled" };
    }
    return { status: "disconnected", reason: "proxy_offline" };
  } catch {
    return { status: "disconnected", reason: "proxy_offline" };
  }
}

// ── target 映射维护 ────────────────────────────────────────────────

async function refreshTargets() {
  const infos = await chrome.debugger.getTargets();
  // 同一 tabId 下可能同时存在 page、iframe、worker、other（及 BFCache/prerender 临时目标）：
  // 仅 type === "page" 才可占据 targetByTab；同 tabId 多 page 时优先保留已附着/已注册会话的目标，
  // 防止非 page 或非活跃目标覆盖主 page targetId（导致 openerId 错配、事件路由丢失）。
  const pagesByTab = new Map();
  for (const ti of infos) {
    if (ti.tabId === undefined || ti.type !== "page") continue;
    const prev = pagesByTab.get(ti.tabId);
    if (!prev) {
      pagesByTab.set(ti.tabId, ti);
      continue;
    }
    const prevScore = (rootsByTarget.has(prev.id) ? 4 : 0) + (attached.has(prev.id) ? 2 : 0) + (prev.attached ? 1 : 0);
    const curScore = (rootsByTarget.has(ti.id) ? 4 : 0) + (attached.has(ti.id) ? 2 : 0) + (ti.attached ? 1 : 0);
    if (curScore > prevScore) pagesByTab.set(ti.tabId, ti);
  }
  for (const [tabId, ti] of pagesByTab) {
    const known = targetByTab.get(tabId);
    const fresh = {
      targetId: ti.id,
      url: ti.url,
      title: ti.title,
      type: ti.type,
      groupId: known?.groupId,
      openerTabId: known?.openerTabId ?? openerByTab.get(tabId),
    };
    targetByTab.set(tabId, fresh);
    tabByTarget.set(ti.id, tabId);
    if (known && known.targetId !== ti.id && !rootsByTarget.has(known.targetId)) {
      tabByTarget.delete(known.targetId);
    }
  }
  return infos;
}

async function waitForTargetId(tabId, maxAttempts = 80) {
  let targetId = null;
  for (let i = 0; i < maxAttempts && !targetId; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 25));
    await refreshTargets();
    targetId = (targetByTab.get(tabId) || {}).targetId || null;
  }
  return targetId;
}

function cdpTargetInfo(ti, openerTabId) {
  const tid = ti.id ?? ti.targetId;
  const tabId = ti.tabId !== undefined ? ti.tabId : tabByTarget.get(tid);
  const resolvedOpenerTabId = openerTabId ?? ti.openerTabId ?? (tabId !== undefined ? openerByTab.get(tabId) : undefined);
  const info = {
    // 兼容两种来源：chrome.debugger 原始 targetInfo（id 字段）与缓存归一化
    // 条目（targetId 字段，sync/gstate 随行信息用）
    targetId: tid,
    type: ti.type || "page",
    title: ti.title || "",
    url: ti.url || "",
    attached: ti.attached !== undefined ? !!ti.attached : attached.has(tid),
    // 真 Chrome 的 targetInfo 带 browserContextId（默认 context 亦有固定 id）；
    // Playwright 对缺失该字段的 target 直接 detach——必须带上（不在
    // getBrowserContexts 列表内的 id 会回落到默认 context，语义正确）。
    browserContextId: "cdp-ext-default",
  };
  if (tabId !== undefined) info.tabId = tabId;
  if (resolvedOpenerTabId !== undefined && targetByTab.has(resolvedOpenerTabId)) {
    info.openerId = targetByTab.get(resolvedOpenerTabId).targetId;
  }
  return info;
}

function windowBoundsOf(win) {
  const stateMap = {
    normal: "normal",
    minimized: "minimized",
    maximized: "maximized",
    fullscreen: "fullscreen",
    "locked-fullscreen": "fullscreen",
  };
  return {
    left: win.left ?? 0,
    top: win.top ?? 0,
    width: win.width ?? 0,
    height: win.height ?? 0,
    windowState: stateMap[win.state] || "normal",
  };
}

async function targetInfoOf(targetId) {
  const infos = await refreshTargets();
  return infos.find((ti) => ti.id === targetId) || null;
}

// ── 反向连接 ───────────────────────────────────────────────────────

function scheduleReconnect() {
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  const wait = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 5000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(false);
  }, wait);
}

function connect(force = false) {
  if (force) {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    backoffMs = 500;
    if (ws) {
      const old = ws;
      ws = null;
      stopHeartbeat();
      try { old.close(1000, "reconnect"); } catch {}
    }
  } else if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
    return;
  }
  relayConfig().then(({ url, token }) => {
    if (!force && ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    setConnState("connecting", "", url);
    let sock;
    try {
      const full = url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
      sock = new WebSocket(full);
    } catch {
      setConnState("disconnected", "proxy_offline", url);
      scheduleReconnect();
      return;
    }
    ws = sock;
    let opened = false;
    sock.onopen = async () => {
      if (ws !== sock) return;
      opened = true;
      backoffMs = 500;
      setConnState("connected", "", url);
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
    sock.onclose = async () => {
      if (ws !== sock) return;
      stopHeartbeat();
      ws = null;
      if (!opened) {
        const diag = await diagnoseFailure(url, token);
        if (ws === null) setConnState(diag.status, diag.reason, url);
      } else {
        setConnState("disconnected", "proxy_offline", url);
      }
      scheduleReconnect();
    };
    sock.onerror = () => {
      /* onclose 随后触发，统一走诊断与重连 */
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
    sess[sid] = {
      targetId: s.targetId,
      tabId: s.tabId,
      browser: !!s.browser,
      ...(s.dsChildSid ? { dsChildSid: s.dsChildSid } : {}),
      ...(s.parentOurSid ? { parentOurSid: s.parentOurSid } : {}),
      ...(s.rootTargetId ? { rootTargetId: s.rootTargetId } : {}),
    };
  }
  const roots = {};
  for (const [tid, set] of rootsByTarget) roots[tid] = [...set];
  const children = {};
  for (const [dsSid, c] of childByDsSid) {
    const byParent = {};
    for (const [p, child] of c.byParent) byParent[p] = child;
    children[dsSid] = { targetId: c.targetId, childTargetId: c.childTargetId || "", byParent };
  }
  const popups = {};
  for (const [tabId, name] of popupSessionByTab) popups[String(tabId)] = name;
  const openers = {};
  for (const [tabId, openerId] of openerByTab) openers[String(tabId)] = openerId;
  return { sidSeq, rootAutoAttach, sessions: sess, roots, children, attached: [...attached.keys()], popups, openers };
}

async function loadPersistedState() {
  try {
    const got = await chrome.storage.session.get(STATE_KEY);
    const st = got[STATE_KEY];
    if (!st) return false;
    sidSeq = st.sidSeq || 0;
    rootAutoAttach = !!st.rootAutoAttach;
    for (const [sid, s] of Object.entries(st.sessions || {})) {
      sessions.set(sid, {
        targetId: s.targetId,
        tabId: s.tabId,
        browser: !!s.browser,
        ...(s.dsChildSid ? { dsChildSid: s.dsChildSid } : {}),
        ...(s.parentOurSid ? { parentOurSid: s.parentOurSid } : {}),
        ...(s.rootTargetId ? { rootTargetId: s.rootTargetId } : {}),
        children: new Map(),
      });
    }
    for (const [tid, sids] of Object.entries(st.roots || {})) {
      rootsByTarget.set(tid, new Set(sids));
    }
    for (const [dsSid, c] of Object.entries(st.children || {})) {
      const byParent = new Map(Object.entries(c.byParent || {}));
      childByDsSid.set(dsSid, { targetId: c.targetId, childTargetId: c.childTargetId || "", byParent });
      for (const [p, child] of byParent) {
        const parent = sessions.get(p);
        if (parent) parent.children.set(dsSid, child);
      }
    }
    for (const tid of st.attached || []) attached.set(tid, {});
    for (const [k, name] of Object.entries(st.popups || {})) {
      const tabId = Number(k);
      if (Number.isInteger(tabId) && name) popupSessionByTab.set(tabId, name);
    }
    for (const [k, v] of Object.entries(st.openers || {})) {
      const tabId = Number(k);
      if (Number.isInteger(tabId) && Number.isInteger(v)) openerByTab.set(tabId, v);
    }
    return true;
  } catch (err) {
    console.warn("[cdp-ext] 持久化恢复异常（按冷启动处理）", err && err.message);
    return false;
  }
}

// ── 组对账（sync 控制消息）────────────────────────────────────────
// 组成员 = 会话可见集（标签组 tab ∪ 会话派生的 popup 窗口 tab）。浏览器侧
// tabs/tabGroups 事件驱动 + alarm 兜底，防抖合并后全量上报，proxy 差分 adopt/revoke。

async function collectPopupEntries(sessionName) {
  const out = [];
  for (const [tabId, name] of [...popupSessionByTab.entries()]) {
    if (name !== sessionName) continue;
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) {
      popupSessionByTab.delete(tabId);
      continue;
    }
    const e = targetByTab.get(tabId);
    if (e) out.push(e);
  }
  return out;
}

async function syncSession(sessionName) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  await refreshTargets();
  const groupId = await groupFor(sessionName);
  const byTid = new Map();
  if (groupId !== undefined) {
    const tabs = await chrome.tabs.query({ groupId });
    for (const t of tabs) {
      const e = targetByTab.get(t.id);
      if (e) {
        e.groupId = groupId;
        byTid.set(e.targetId, e);
      }
    }
  }
  for (const e of await collectPopupEntries(sessionName)) {
    byTid.set(e.targetId, e);
  }
  if (groupId === undefined && byTid.size === 0) {
    // 此前存在活组但现已解散（最后一张 tab 关闭或被拖出）：
    // 若非 mark 策略的墓碑组，须发空 sync 通知 proxy 收回残余归属并清理缓存。
    if (sessionGroups.has(sessionName)) {
      const tomb = await chrome.tabGroups.query({ title: formatGroupTitle(sessionName, true) }).catch(() => []);
      if (tomb.length === 0) {
        sessionGroups.delete(sessionName);
        send({ abCtl: "sync", session: sessionName, targetIds: [], infos: [] });
      }
    }
    return;
  }
  const entries = [...byTid.values()];
  send({
    abCtl: "sync",
    session: sessionName,
    targetIds: entries.map((e) => e.targetId),
    // targetInfo 全量随行（含 openerId）：proxy 归属新增时向客户端合成
    // targetCreated 事件并自动 attach（popup / target="_blank" 依赖 openerId）
    infos: entries.map((e) => cdpTargetInfo(e, e.openerTabId)),
  });
}

function scheduleReconcile(delayMs = 300) {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(async () => {
    reconcileTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const names = new Set([...sessionGroups.keys(), ...popupSessionByTab.values()]);
    if (names.size === 0) return;
    try {
      await refreshTargets();
      for (const sessionName of names) {
        await syncSession(sessionName);
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
      // close：关闭全部组内 tab 与派生 popup tab（组随最后一个 tab 消失）；
      // mark：组加墓碑（标题 "… · released" + 灰色），tab 保留，同名会话
      //       回来时摘碑复活、整组认领；
      // keep：什么都不动（领地原样保留）。
      // 三种策略下该会话的虚拟会话与物理 attach 都清理（daemon 已断，
      // E 句柄作废；proxy 已合成销毁事件）。
      const sessionName = msg.session;
      sessionDownloadBehavior.delete(sessionName);
      const cfg = await chrome.storage.local.get(["releasePolicy"]);
      const policy = cfg.releasePolicy || "close";
      const groupId = await groupFor(sessionName);
      const tabIdsToDrop = new Set();
      if (groupId !== undefined) {
        const tabs = await chrome.tabs.query({ groupId });
        for (const t of tabs) tabIdsToDrop.add(t.id);
      }
      const popupTabIds = [];
      for (const [tabId, name] of [...popupSessionByTab.entries()]) {
        if (name === sessionName) {
          tabIdsToDrop.add(tabId);
          popupTabIds.push(tabId);
        }
      }
      for (const tabId of tabIdsToDrop) {
        const tid = (targetByTab.get(tabId) || {}).targetId;
        if (tid) await dropTarget(tid);
      }
      if (policy === "close") {
        if (tabIdsToDrop.size > 0) {
          await chrome.tabs.remove([...tabIdsToDrop]).catch(() => {});
        }
        for (const tabId of popupTabIds) popupSessionByTab.delete(tabId);
      } else if (policy === "mark" && groupId !== undefined) {
        await chrome.tabGroups.update(groupId, {
          title: formatGroupTitle(sessionName, true),
          color: "grey",
        }).catch(() => {});
      }
      // keep：组与 tab 原样保留
      break;
    }
    case "config": {
      const updates = {};
      let prefixChanged = false;
      let urlChanged = false;
      if (typeof msg.groupPrefix === "string" && msg.groupPrefix.trim()) {
        const nextPrefix = normalizeGroupPrefix(msg.groupPrefix);
        if (nextPrefix !== activeGroupPrefix) {
          activeGroupPrefix = nextPrefix;
          updates.groupPrefix = nextPrefix;
          prefixChanged = true;
        }
      }
      if (typeof msg.relayUrl === "string" && msg.relayUrl.trim()) {
        const nextUrl = msg.relayUrl.trim();
        if (nextUrl !== connState.relayUrl) {
          updates.relayUrl = nextUrl;
          urlChanged = true;
        }
      }
      if (Object.keys(updates).length) {
        await chrome.storage.local.set(updates).catch(() => {});
      }
      if (prefixChanged) {
        sessionGroups.clear();
        await rebuildGroupMaps();
        await sendGstate();
      }
      if (urlChanged) {
        setTimeout(() => connect(true), 120);
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

// sendGstate 全量组事实上报：所有匹配当前前缀的活组（非墓碑）与派生 popup 的
// 会话名 → 成员 targetId 列表。proxy 以此重建归属投影。
async function sendGstate() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    await refreshTargets();
    const groups = await chrome.tabGroups.query({});
    const bySession = new Map(); // 会话名 → Map<targetId, entry>（多组/popup 取并集）
    for (const g of groups) {
      if (!g.title || g.title.endsWith(RELEASED_SUFFIX)) continue;
      const name = parseSessionName(g.title);
      if (name === null) continue;
      const tabs = await chrome.tabs.query({ groupId: g.id });
      // 组员身份回填（同 scheduleReconcile：gstate 是重启/回连后的权威全量）
      for (const t of tabs) {
        const e = targetByTab.get(t.id);
        if (e) e.groupId = g.id;
      }
      if (!bySession.has(name)) bySession.set(name, new Map());
      const map = bySession.get(name);
      for (const t of tabs) {
        const e = targetByTab.get(t.id);
        if (e) map.set(e.targetId, e);
      }
    }
    for (const [tabId, name] of [...popupSessionByTab.entries()]) {
      const t = await chrome.tabs.get(tabId).catch(() => null);
      if (!t) {
        popupSessionByTab.delete(tabId);
        continue;
      }
      const e = targetByTab.get(tabId);
      if (!e) continue;
      if (!bySession.has(name)) bySession.set(name, new Map());
      bySession.get(name).set(e.targetId, e);
    }
    send({
      abCtl: "gstate",
      groups: [...bySession.entries()].map(([session, map]) => {
        const entries = [...map.values()];
        return {
          session,
          targetIds: entries.map((e) => e.targetId),
          infos: entries.map((e) => cdpTargetInfo(e, e.openerTabId)),
        };
      }),
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
  popupSessionByTab.clear();
  openerByTab.clear();
  closingTargets.clear();
  recentWindowOpens.length = 0;
  sessionDownloadBehavior.clear();
  activeDownloads.clear();
  downloadGuidById.clear();
  unmatchedChromeDownloads.length = 0;
  touchedContentSettings.clear();
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
      const targetId = await waitForTargetId(tab.id);
      if (!targetId) return respondErr(id, "cdp-ext: 新 tab 的 targetId 解析超时");
      // targetCreated 单出口：归组完成后在应答之后发出。应答先到 → proxy 记
      // 归属 → 事件到达时 OwnerOf 命中，路由给会话（顺序反了会以无主身份
      // 被丢弃——创建与登记在组模型下由这一个出口原子完成）。
      if (sessionName) {
        await addToGroup(sessionName, tab.id);
        const entry = targetByTab.get(tab.id);
        const gid = sessionGroups.get(sessionName);
        if (entry && gid !== undefined) entry.groupId = gid;
        respond(id, { targetId, abGroup: formatGroupTitle(sessionName) });
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
      closingTargets.add(params.targetId);
      try {
        await chrome.tabs.remove(tabId);
      } catch (err) {
        closingTargets.delete(params.targetId);
        throw err;
      }
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
    case "Storage.getCookies":
    case "Storage.setCookies":
    case "Storage.clearCookies": {
      // 优先走本会话名下已附着 tab 的原生 chrome.debugger（返回完整 CDP Cookie 字段）；
      // 本会话当前无可用页面时回落 chrome.cookies（依赖 cookies + <all_urls> 权限），
      // 不触碰用户组外或其他会话的 tab。
      const picked = await resolveTabForStorage(params, { allowAnyAttached: !chrome.cookies });
      if (picked) {
        await ensureAttached(picked.targetId, picked.tabId);
        const fwd = { ...params };
        delete fwd.abSession;
        delete fwd.abTargetId;
        delete fwd.browserContextId;
        const res = await chrome.debugger.sendCommand({ tabId: picked.tabId }, method, fwd);
        respond(id, res === undefined ? {} : res);
        return;
      }
      if (chrome.cookies) {
        const res = await handleCookiesViaExtAPI(method, params);
        respond(id, res);
        return;
      }
      return respondErr(id, `cdp-ext: 当前会话无可用页面且未授予 cookies 权限，无法执行 ${method}`);
    }
    case "Storage.clearDataForOrigin": {
      const picked = await resolveTabForStorage(params, { allowAnyAttached: true });
      if (!picked) {
        return respondErr(id, "cdp-ext: 当前无可用页面，无法执行 Storage.clearDataForOrigin");
      }
      await ensureAttached(picked.targetId, picked.tabId);
      const fwd = { ...params };
      delete fwd.abSession;
      delete fwd.abTargetId;
      delete fwd.browserContextId;
      const res = await chrome.debugger.sendCommand({ tabId: picked.tabId }, method, fwd);
      respond(id, res === undefined ? {} : res);
      return;
    }
    case "Browser.getVersion": {
      const m = /Chrome\/([0-9.]+)/.exec(navigator.userAgent);
      respond(id, {
        protocolVersion: "1.3",
        product: m ? `Chrome/${m[1]}` : "Chrome/cdp-ext-bridge",
        revision: "",
        userAgent: navigator.userAgent,
        jsVersion: "",
      });
      return;
    }
    case "Browser.getWindowForTarget": {
      let tabId = params.targetId ? tabByTarget.get(params.targetId) : undefined;
      if (tabId === undefined && params.targetId) {
        await refreshTargets();
        tabId = tabByTarget.get(params.targetId);
      }
      if (tabId === undefined) return respondErr(id, `cdp-ext: target ${params.targetId || ""} 不存在`);
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      respond(id, { windowId: win.id, bounds: windowBoundsOf(win) });
      return;
    }
    case "Browser.getWindowBounds": {
      if (typeof params.windowId !== "number") {
        return respondErr(id, "cdp-ext: Browser.getWindowBounds 缺少 windowId");
      }
      const win = await chrome.windows.get(params.windowId);
      respond(id, { bounds: windowBoundsOf(win) });
      return;
    }
    case "Browser.setWindowBounds": {
      if (typeof params.windowId !== "number" || !params.bounds || typeof params.bounds !== "object") {
        return respondErr(id, "cdp-ext: Browser.setWindowBounds 参数不完整");
      }
      const b = params.bounds;
      const upd = {};
      if (b.windowState === "minimized" || b.windowState === "maximized" || b.windowState === "fullscreen") {
        upd.state = b.windowState;
      } else {
        if (b.windowState === "normal") upd.state = "normal";
        if (typeof b.left === "number") upd.left = Math.round(b.left);
        if (typeof b.top === "number") upd.top = Math.round(b.top);
        if (typeof b.width === "number") upd.width = Math.round(b.width);
        if (typeof b.height === "number") upd.height = Math.round(b.height);
      }
      await chrome.windows.update(params.windowId, upd);
      respond(id, {});
      return;
    }
    case "Browser.setDownloadBehavior": {
      // 记录本会话下载策略（allowAndName / allow / deny / default）；
      // 实际下载事件经 Page.download* + chrome.downloads 桥接并由 proxy 同步到会话 downloadPath。
      if (params.abSession) {
        sessionDownloadBehavior.set(params.abSession, params.behavior || "default");
      }
      respond(id, {});
      return;
    }
    case "Browser.cancelDownload": {
      const guid = params.guid;
      const rec = guid && activeDownloads.get(guid);
      if (rec) {
        rec.canceledRequested = true;
        if (chrome.downloads) {
          if (rec.downloadId === null) {
            const deadline = Date.now() + 600;
            while (rec.downloadId === null && !rec.finished && Date.now() < deadline) {
              const items = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 5 }).catch(() => []);
              for (const it of items || []) {
                if (!downloadGuidById.has(it.id) && matchChromeDownloadScore(rec, it) >= 2) {
                  rec.downloadId = it.id;
                  downloadGuidById.set(it.id, rec.guid);
                  break;
                }
              }
              if (rec.downloadId === null) await new Promise((r) => setTimeout(r, 30));
            }
          }
          if (rec.downloadId !== null) {
            await chrome.downloads.cancel(rec.downloadId).catch(() => {});
          }
        }
      }
      respond(id, {});
      return;
    }
    case "Browser.grantPermissions": {
      if (!chrome.contentSettings) {
        return respondErr(id, "cdp-ext: 未授予 contentSettings 权限，无法执行 Browser.grantPermissions");
      }
      const perms = Array.isArray(params.permissions) ? params.permissions : [];
      const unsupported = [];
      const apiKeys = [];
      for (const p of perms) {
        const key = CDP_PERMISSION_TO_CONTENT_SETTING[p];
        if (!key || !chrome.contentSettings[key]) {
          unsupported.push(String(p));
        } else {
          apiKeys.push(key);
        }
      }
      if (unsupported.length > 0) {
        return respondErr(
          id,
          `cdp-ext: Browser.grantPermissions 不支持权限 [${unsupported.join(", ")}]` +
            `（Chrome contentSettings API 未开放该类型，如需此权限请改用 standalone 源）`,
        );
      }
      const pattern = contentSettingPattern(params.origin);
      for (const key of apiKeys) {
        await applyContentSetting(key, pattern, "allow");
      }
      respond(id, {});
      return;
    }
    case "Browser.setPermission": {
      if (!chrome.contentSettings) {
        return respondErr(id, "cdp-ext: 未授予 contentSettings 权限，无法执行 Browser.setPermission");
      }
      const permName = params.permission && params.permission.name;
      const key = CDP_PERMISSION_TO_CONTENT_SETTING[permName];
      if (!key || !chrome.contentSettings[key]) {
        return respondErr(
          id,
          `cdp-ext: Browser.setPermission 不支持权限 "${permName || ""}"` +
            `（Chrome contentSettings API 未开放该类型，如需此权限请改用 standalone 源）`,
        );
      }
      const settingMap = { granted: "allow", denied: "block", prompt: "ask" };
      const mapped = settingMap[params.setting];
      if (!mapped) {
        return respondErr(id, `cdp-ext: Browser.setPermission 无效 setting: ${params.setting}`);
      }
      await applyContentSetting(key, contentSettingPattern(params.origin), mapped);
      respond(id, {});
      return;
    }
    case "Browser.resetPermissions": {
      if (chrome.contentSettings) {
        // Chrome contentSettings.*.clear({}) 仅清除本扩展层写入的规则，不会擦除用户手动设置
        const keys = new Set([...touchedContentSettings, ...RESETTABLE_CONTENT_SETTINGS]);
        for (const key of keys) {
          const cs = chrome.contentSettings[key];
          if (cs && typeof cs.clear === "function") {
            await callContentSetting(cs, "clear", {}).catch(() => {});
          }
        }
        touchedContentSettings.clear();
      }
      respond(id, {});
      return;
    }
    case "Browser.setDockTile": {
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

async function resolveTabForStorage(params, { allowAnyAttached = true } = {}) {
  if (params.abTargetId) {
    let tabId = tabByTarget.get(params.abTargetId);
    if (tabId === undefined) {
      await refreshTargets();
      tabId = tabByTarget.get(params.abTargetId);
    }
    if (tabId !== undefined) return { targetId: params.abTargetId, tabId };
  }
  if (params.abSession) {
    await refreshTargets();
    const gid = await groupFor(params.abSession);
    if (gid !== undefined) {
      const tabs = await chrome.tabs.query({ groupId: gid });
      for (const t of tabs) {
        const e = targetByTab.get(t.id);
        if (e) return { targetId: e.targetId, tabId: t.id };
      }
    }
    for (const [tabId, name] of popupSessionByTab) {
      if (name !== params.abSession) continue;
      const e = targetByTab.get(tabId);
      if (e) return { targetId: e.targetId, tabId };
    }
  }
  if (allowAnyAttached) {
    for (const [tid, rec] of attached) {
      const tabId = rec.tabId ?? tabByTarget.get(tid);
      if (tabId !== undefined) return { targetId: tid, tabId };
    }
  }
  return null;
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

  // 页面会话上的浏览器域只读/窗口命令（真 Chrome 在 page session 上同样受理）：
  // 含 Browser.getVersion / getWindowForTarget / getWindowBounds / setWindowBounds。
  if (method === "Browser.getVersion" || method === "Browser.getWindowBounds" || method === "Browser.setWindowBounds") {
    idEcho.set(id, sid);
    try {
      await onRootCommand(id, method, params);
    } catch (err) {
      respondErr(id, `cdp-ext: ${method} 失败: ${err && err.message ? err.message : String(err)}`);
    }
    return;
  }
  if (method === "Browser.getWindowForTarget") {
    let tabId = sess.tabId;
    if (params.targetId) tabId = tabByTarget.get(params.targetId) ?? tabId;
    if (tabId === undefined) {
      return send({ id, sessionId: sid, error: { code: -32000, message: "cdp-ext: 当前会话缺少 tabId" } });
    }
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);
    return send({ id, sessionId: sid, result: { windowId: win.id, bounds: windowBoundsOf(win) } });
  }
  if (method === "Page.setDownloadBehavior") {
    // chrome.debugger 在页面会话上直接调 Page.setDownloadBehavior 会报
    // "Cannot not access browser-level commands"；在此接管记录会话策略。
    const sessionName = params.abSession || sessionNameOfTabSync(sess.tabId);
    if (sessionName) {
      sessionDownloadBehavior.set(sessionName, params.behavior || "default");
    }
    return send({ id, sessionId: sid, result: {} });
  }

  // 页面会话上的 Target.detachFromTarget（如 Playwright 主动摘除 service_worker 子会话）：
  // 须把虚拟子 sessionId 映射回 chrome.debugger 的真实 dsChildSid 再透传。
  if (method === "Target.detachFromTarget" && params.sessionId) {
    const childSess = sessions.get(params.sessionId);
    if (childSess && childSess.dsChildSid) {
      const dsChildSid = childSess.dsChildSid;
      const target = sess.dsChildSid
        ? { tabId: sess.tabId, sessionId: sess.dsChildSid }
        : { tabId: sess.tabId };
      try {
        await chrome.debugger.sendCommand(target, "Target.detachFromTarget", { sessionId: dsChildSid });
      } catch { /* 子目标可能已自行退出 */ }
      detachChildSession(dsChildSid, childSess.targetId);
      return send({ id, sessionId: sid, result: {} });
    }
  }

  // 页面/子会话：物理 attach 挂在根 tab 上，可能处于软休眠（用户点过横幅「取消」）——
  // 先懒重挂再透传。重挂失败（DevTools 占用 / tab 已关）如实报错，客户端可见明确原因。
  const rootTid = sess.rootTargetId || sess.targetId;
  try {
    await ensureAttached(rootTid, sess.tabId);
  } catch (err) {
    return send({
      id, sessionId: sid,
      error: {
        code: -32000,
        message: `cdp-ext: 会话 ${sid} 处于休眠，重新附加 ${rootTid} 失败` +
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
  const resolvedTabId = tabId ?? ti.tabId;
  await ensureAttached(targetId, resolvedTabId);
  const ourSid = `E${++sidSeq}`;
  sessions.set(ourSid, { targetId, tabId: resolvedTabId, children: new Map() });
  if (!rootsByTarget.has(targetId)) rootsByTarget.set(targetId, new Set());
  rootsByTarget.get(targetId).add(ourSid);
  persistStateSoon();
  const openerTabId = resolvedTabId !== undefined
    ? (openerByTab.get(resolvedTabId) ?? targetByTab.get(resolvedTabId)?.openerTabId)
    : undefined;
  // 会话内 attach（如 attachToBrowserTarget 会话上的 attachToTarget）：
  // 事件嵌套发给该会话（顶层 sessionId=父），不广播浏览器级——真 Chrome
  // 如此，广播会让 Playwright 的浏览器级处理器重复注册 target 而断言。
  send({
    method: "Target.attachedToTarget",
    params: { sessionId: ourSid, targetInfo: cdpTargetInfo(ti, openerTabId) },
    ...(parentSid ? { sessionId: parentSid } : {}),
  });
  return ourSid;
}

// purgeChildTree 递归清理某父会话名下的全部子虚拟会话（OOPIF/Worker/嵌套子目标）。
function purgeChildTree(parentOurSid) {
  const parent = sessions.get(parentOurSid);
  if (!parent || !parent.children) return;
  for (const [dsSid, childOur] of [...parent.children.entries()]) {
    purgeChildTree(childOur);
    sessions.delete(childOur);
    const rec = childByDsSid.get(dsSid);
    if (rec) {
      rec.byParent.delete(parentOurSid);
      if (rec.byParent.size === 0) childByDsSid.delete(dsSid);
    }
  }
  parent.children.clear();
}

async function detachSession(ourSid) {
  const sess = sessions.get(ourSid);
  if (!sess) return;
  if (sess.dsChildSid) {
    detachChildSession(sess.dsChildSid, sess.targetId);
    return;
  }
  purgeChildTree(ourSid);
  sessions.delete(ourSid);
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
    purgeChildTree(ourSid);
    sessions.delete(ourSid);
    if (notify) {
      send({ method: "Target.detachedFromTarget", params: { sessionId: ourSid, targetId } });
    }
  }
  rootsByTarget.delete(targetId);
  attached.delete(targetId);
  persistStateSoon();
}

// ── chrome.debugger 事件 → CDP 事件 ─────────────────────────────────

// attachChildSession 为 OOPIF / Worker / 嵌套子目标在所有父虚拟会话下登记独立 childOur，
// 并写入 sessions（含 dsChildSid 与 rootTargetId），使子会话命令与事件双向贯通。
function attachChildSession(parentOurSids, dsSid, params, rootTargetId) {
  if (!dsSid) return;
  const childTargetId = (params && params.targetInfo && params.targetInfo.targetId) || "";
  if (!childByDsSid.has(dsSid)) {
    childByDsSid.set(dsSid, { targetId: rootTargetId, childTargetId, byParent: new Map() });
  }
  const rec = childByDsSid.get(dsSid);
  if (childTargetId && !rec.childTargetId) rec.childTargetId = childTargetId;
  for (const parentOur of parentOurSids) {
    if (rec.byParent.has(parentOur)) continue;
    const parent = sessions.get(parentOur);
    if (!parent) continue;
    const childOur = `E${++sidSeq}`;
    parent.children.set(dsSid, childOur);
    rec.byParent.set(parentOur, childOur);
    sessions.set(childOur, {
      targetId: childTargetId || rootTargetId,
      rootTargetId,
      tabId: parent.tabId,
      dsChildSid: dsSid,
      parentOurSid: parentOur,
      children: new Map(),
    });
    send({
      method: "Target.attachedToTarget",
      params: { ...params, sessionId: childOur },
      sessionId: parentOur,
    });
  }
  persistStateSoon();
}

function detachChildSession(dsSid, targetIdFromParams) {
  const rec = dsSid && childByDsSid.get(dsSid);
  if (!rec) return;
  for (const [parentOur, childOur] of [...rec.byParent.entries()]) {
    purgeChildTree(childOur);
    sessions.delete(childOur);
    send({
      method: "Target.detachedFromTarget",
      params: { sessionId: childOur, targetId: targetIdFromParams || rec.childTargetId },
      sessionId: parentOur,
    });
    const parent = sessions.get(parentOur);
    if (parent) parent.children.delete(dsSid);
  }
  childByDsSid.delete(dsSid);
  persistStateSoon();
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.sessionId) {
    // 子会话（OOPIF/worker）事件：按 byParent 定向到各父会话自己的 child id
    const rec = childByDsSid.get(source.sessionId);
    if (!rec) return;
    if (method === "Target.attachedToTarget") {
      // 嵌套子目标（如 OOPIF 内部再创建 Worker）
      attachChildSession(rec.byParent.values(), params && params.sessionId, params, rec.targetId);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const innerDsSid = params && params.sessionId;
      if (innerDsSid && childByDsSid.has(innerDsSid)) {
        detachChildSession(innerDsSid, params && params.targetId);
      } else {
        detachChildSession(source.sessionId, params && params.targetId);
      }
      return;
    }
    if (method === "Page.windowOpen" && source.tabId !== undefined) {
      recordWindowOpen(source.tabId, params && params.url);
    }
    if (method === "Page.downloadWillBegin") {
      handlePageDownloadWillBegin(source.tabId ?? tabByTarget.get(rec.targetId), rec.targetId, params);
    } else if (method === "Page.downloadProgress") {
      handlePageDownloadProgress(params);
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
    attachChildSession(siblings, params && params.sessionId, params, targetId);
    return;
  }
  if (method === "Target.detachedFromTarget") {
    detachChildSession(params && params.sessionId, params && params.targetId);
    return;
  }
  if (method === "Page.windowOpen" && source.tabId !== undefined) {
    recordWindowOpen(source.tabId, params && params.url);
  }
  if (method === "Page.downloadWillBegin") {
    handlePageDownloadWillBegin(source.tabId, targetId, params);
  } else if (method === "Page.downloadProgress") {
    handlePageDownloadProgress(params);
  }
  for (const ourSid of siblings) {
    send({ method, params, sessionId: ourSid });
  }
});

// chrome.downloads 桥接：绑定 Chrome 原生 downloadId 拿真实落盘路径并支持 cancelDownload / deny
if (chrome.downloads) {
  chrome.downloads.onCreated.addListener((item) => {
    if (!item || item.id == null) return;
    pruneUnmatchedChromeDownloads();
    let bestRec = null;
    let bestScore = 0;
    let openUnbound = 0;
    for (const rec of activeDownloads.values()) {
      if (rec.downloadId !== null || rec.finished) continue;
      openUnbound++;
      const score = matchChromeDownloadScore(rec, item);
      if (score > bestScore) {
        bestScore = score;
        bestRec = rec;
      }
    }
    if (bestRec && (bestScore >= 2 || (bestScore === 1 && openUnbound === 1))) {
      bindChromeDownload(bestRec, item.id, item.filename);
      return;
    }
    unmatchedChromeDownloads.push({
      id: item.id,
      url: item.url || "",
      finalUrl: item.finalUrl || "",
      filename: item.filename || "",
      at: Date.now(),
    });
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || delta.id == null) return;
    const guid = downloadGuidById.get(delta.id);
    const rec = guid && activeDownloads.get(guid);
    if (!rec) return;
    if (delta.filename && delta.filename.current) {
      rec.filename = delta.filename.current;
    }
    if (delta.state && delta.state.current === "interrupted" && !rec.finished && !rec.completing) {
      setTimeout(() => {
        if (!rec.finished && !rec.completing) {
          finalizeDownload(rec, "canceled", 0, 0, "");
        }
      }, 250);
    }
  });
}

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
  for (const ourSid of rootsByTarget.get(targetId) || []) {
    purgeChildTree(ourSid);
  }
  for (const [dsSid, rec] of [...childByDsSid]) {
    if (rec.targetId === targetId) {
      for (const childOur of rec.byParent.values()) sessions.delete(childOur);
      childByDsSid.delete(dsSid);
    }
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
// 事件准入（组=唯一真相）：只有会话组成员（含墓碑组）及会话派生 popup 窗口的
// 生命周期进入事件流。用户手动开的无 opener 组外 tab 与系统无关，静默忽略。
// 创建分两路：
//   1) Target.createTarget：归组完成后单出口直发 targetCreated；
//   2) 页面内 target="_blank" / window.open / popup：onCreated 凭 openerTabId
//      归属到 opener 所在会话（普通 tab 归同组，popup 窗口记入 popupSessionByTab），
//      保留 openerId 并 0ms 立即 syncSession 给 proxy 触发 targetCreated + autoAttach。

// sessionGroupIds 当前全部会话组（含墓碑）的 groupId 集合。
function sessionGroupIds() {
  return new Set(sessionGroups.values());
}

async function resolveSessionForTab(tabId, hintGroupId) {
  if (popupSessionByTab.has(tabId)) return popupSessionByTab.get(tabId);
  const gid = hintGroupId ?? targetByTab.get(tabId)?.groupId;
  if (gid !== undefined && gid !== -1) {
    for (const [name, id] of sessionGroups) {
      if (id === gid) {
        const g = await chrome.tabGroups.get(gid).catch(() => null);
        if (g && !g.title.endsWith(RELEASED_SUFFIX)) return name;
      }
    }
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.groupId === undefined || tab.groupId === -1) return null;
  const g = await chrome.tabGroups.get(tab.groupId).catch(() => null);
  if (!g || !g.title || g.title.endsWith(RELEASED_SUFFIX)) return null;
  const name = parseSessionName(g.title);
  if (name !== null) sessionGroups.set(name, g.id);
  return name;
}

chrome.tabs.onCreated.addListener((tab) => {
  // 优先消费刚由受控 tab 发出的 Page.windowOpen（解决后台 tab window.open('_blank') 时
  // Chrome 把 tabs.onCreated.openerTabId 误填成当前激活用户 tab 的问题），再回退 tab.openerTabId。
  const fromWindowOpen = consumeWindowOpen(tab.pendingUrl || tab.url || "");
  const effectiveOpenerTabId = fromWindowOpen !== undefined ? fromWindowOpen : tab.openerTabId;
  if (effectiveOpenerTabId !== undefined) {
    openerByTab.set(tab.id, effectiveOpenerTabId);
    (async () => {
      try {
        const sessionName = await resolveSessionForTab(effectiveOpenerTabId);
        if (!sessionName) {
          // 组外普通用户页打开的新 tab：仅建映射，不进事件流
          await refreshTargets();
          const entry = targetByTab.get(tab.id);
          if (entry && tab.groupId !== undefined) entry.groupId = tab.groupId;
          return;
        }
        const targetId = await waitForTargetId(tab.id);
        if (!targetId) return;
        const win = tab.windowId !== undefined
          ? await chrome.windows.get(tab.windowId).catch(() => null)
          : null;
        if (win && win.type !== "normal") {
          // 独立 popup 窗口无法加入 Chrome tabGroup，通过 popupSessionByTab 挂靠同一会话
          popupSessionByTab.set(tab.id, sessionName);
          persistStateSoon();
        } else {
          await addToGroup(sessionName, tab.id);
          const gid = sessionGroups.get(sessionName);
          const entry = targetByTab.get(tab.id);
          if (entry && gid !== undefined) entry.groupId = gid;
        }
        const entry = targetByTab.get(tab.id);
        if (entry) entry.openerTabId = effectiveOpenerTabId;
        await syncSession(sessionName);
      } catch (e) {
        console.warn("[cdp-ext] 自动归属派生 tab/popup 失败", tab.id, e);
      }
    })();
    return;
  }
  // 无 opener：Target.createTarget 由命令路径归组并单出口发 targetCreated；
  // 用户手动开组外 tab 保持完全静默；若用户在组内点「+」建 tab 则触发对账。
  refreshTargets().then(() => {
    const entry = targetByTab.get(tab.id);
    if (entry && tab.groupId !== undefined) entry.groupId = tab.groupId;
    if (tab.groupId !== undefined && tab.groupId !== -1 && sessionGroupIds().has(tab.groupId)) {
      scheduleReconcile(50);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined || changeInfo.windowId !== undefined) scheduleReconcile();
  const entry = targetByTab.get(tabId);
  if (!entry) return;
  if (changeInfo.url) entry.url = changeInfo.url;
  if (changeInfo.title) entry.title = changeInfo.title;
  // 组员身份缓存：tab.groupId 是最新事实（-1=无组）；
  // 若从会话组变为 -1，短暂记录 prevGroupId/ungroupedAt（Chrome 关掉组内 tab 时会先发
  // onUpdated(groupId=-1) 再发 onRemoved，避免 onRemoved 误判为组外而吞掉 detachedFromTarget）。
  if (tab && tab.groupId !== undefined) {
    const prev = entry.groupId;
    if (tab.groupId === -1 && prev && prev !== -1 && sessionGroupIds().has(prev)) {
      entry.prevGroupId = prev;
      entry.ungroupedAt = Date.now();
    } else if (tab.groupId !== -1) {
      entry.prevGroupId = undefined;
      entry.ungroupedAt = 0;
    }
    entry.groupId = tab.groupId;
  }
  // 准入：非会话组成员且非派生 popup 的 tab 不进入事件流
  const isMember = (entry.groupId && sessionGroupIds().has(entry.groupId)) || popupSessionByTab.has(tabId);
  if (!isMember) return;
  send({
    method: "Target.targetInfoChanged",
    params: {
      targetInfo: cdpTargetInfo(
        { ...entry, attached: attached.has(entry.targetId), tabId },
        entry.openerTabId ?? openerByTab.get(tabId),
      ),
    },
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = targetByTab.get(tabId);
  const wasPopup = popupSessionByTab.delete(tabId);
  openerByTab.delete(tabId);
  scheduleReconcile();
  if (!entry) return;
  targetByTab.delete(tabId);
  tabByTarget.delete(entry.targetId);
  const wasClosingTarget = closingTargets.delete(entry.targetId);
  // 准入：组员、刚在关闭瞬间退组的组员、派生 popup 或 Target.closeTarget 显式关闭的 tab
  // 才进入事件流；组外用户 tab 关闭保持完全静默。
  const gids = sessionGroupIds();
  const recentlyUngrouped =
    entry.prevGroupId && gids.has(entry.prevGroupId) && Date.now() - (entry.ungroupedAt || 0) < 1000;
  const wasMember = (entry.groupId && gids.has(entry.groupId)) || recentlyUngrouped || wasPopup || wasClosingTarget;
  if (!wasMember) {
    // 组外 tab 若曾挂载过虚拟会话（如被拖出组后关闭），静默清账防 sessions 泄漏，不发事件
    if (rootsByTarget.has(entry.targetId)) dropTarget(entry.targetId, { notify: false });
    return;
  }
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

// ── Popup / Options 页面消息通信 ──────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return false;
  (async () => {
    try {
      if (msg.type === "getStatus") {
        const cfg = await relayConfig(false);
        sendResponse({
          ok: true,
          version: chrome.runtime.getManifest().version,
          connState: { ...connState },
          config: cfg,
          activeGroups: [...sessionGroups.keys()],
        });
        return;
      }
      if (msg.type === "saveConfig") {
        const nextUrl = (msg.relayUrl || "").trim() || DEFAULT_RELAY;
        const nextToken = (msg.token || "").trim();
        const nextPrefix = normalizeGroupPrefix(msg.groupPrefix);
        const nextPolicy = msg.releasePolicy || "close";
        const prefixChanged = nextPrefix !== activeGroupPrefix;
        activeGroupPrefix = nextPrefix;
        await chrome.storage.local.set({
          relayUrl: nextUrl,
          token: nextToken,
          groupPrefix: nextPrefix,
          releasePolicy: nextPolicy,
        });
        if (prefixChanged) {
          sessionGroups.clear();
          await rebuildGroupMaps();
        }
        connect(true);
        sendResponse({ ok: true, connState: { ...connState } });
        return;
      }
      if (msg.type === "reconnect") {
        connect(true);
        sendResponse({ ok: true, connState: { ...connState } });
        return;
      }
      if (msg.type === "syncBundled") {
        const cfg = await relayConfig(true);
        sessionGroups.clear();
        await rebuildGroupMaps();
        connect(true);
        sendResponse({ ok: true, config: cfg, connState: { ...connState } });
        return;
      }
      sendResponse({ ok: false, error: "unknown message type" });
    } catch (e) {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  })();
  return true;
});

chrome.runtime.onStartup.addListener(() => connect(false));
chrome.runtime.onInstalled.addListener(() => connect(true));
connect(false); // SW 每次唤醒都尝试连接（已连接则幂等返回）
