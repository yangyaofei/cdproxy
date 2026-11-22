// config-ui.js — Cdproxy Connector Popup 与 Options 共用逻辑（实时中/英双语切换 + 状态诊断 + 智能粘贴配对串）。
"use strict";

const DEFAULT_RELAY = "ws://127.0.0.1:9225/ext";
const DEFAULT_GROUP_PREFIX = "cdproxy:";

const I18N = {
  zh: {
    pageTitle: "Cdproxy Connector 设置",
    statusConnected: "已连接",
    statusConnecting: "连接中…",
    statusAuthError: "令牌不匹配 (401)",
    statusMissingToken: "请填写连接令牌",
    statusProxyOffline: "未检测到 Cdproxy 运行",
    statusSourceDisabled: "扩展源已在 App 中关闭",
    statusDisconnected: "未连接",
    btnReconnect: "重连",
    activeGroupsLabel: "活跃会话分组",
    noActiveGroups: "暂无活跃会话",
    pairHint: "提示：从 App 复制「配对链接」后粘贴到任意输入框，即可自动拆分地址与令牌。",
    pairParsed: "已自动填入地址与令牌",
    labelRelayUrl: "代理连接地址（WebSocket URL）",
    labelToken: "连接令牌（Access Token）",
    tokenPlaceholder: "粘贴令牌或完整配对链接",
    showToken: "显示",
    hideToken: "隐藏",
    labelGroupPrefix: "标签页分组前缀",
    labelReleasePolicy: "会话结束后如何处理标签页",
    policyClose: "关闭标签页并移除分组（默认）",
    policyMark: "保留标签页，标灰标记（· released）",
    policyKeep: "原样保留，不做任何改动",
    saveButton: "保存并连接",
    syncBundledButton: "读取 App 默认配置",
    savedNotice: "已保存并重连…",
    syncedNotice: "已同步 App 导出配置",
    openFullOptions: "独立页",
    langToggleTitle: "Switch to English",
  },
  en: {
    pageTitle: "Cdproxy Connector Settings",
    statusConnected: "Connected",
    statusConnecting: "Connecting…",
    statusAuthError: "Token mismatch (401)",
    statusMissingToken: "Access token required",
    statusProxyOffline: "Cdproxy app offline",
    statusSourceDisabled: "Extension source disabled",
    statusDisconnected: "Disconnected",
    btnReconnect: "Reconnect",
    activeGroupsLabel: "Active session groups",
    noActiveGroups: "No active sessions",
    pairHint: "Tip: paste a full pairing URL (ws://...?token=...) into either field to fill both automatically.",
    pairParsed: "Pairing URL parsed",
    labelRelayUrl: "Proxy WebSocket URL",
    labelToken: "Access Token",
    tokenPlaceholder: "Paste token or full pairing URL",
    showToken: "Show",
    hideToken: "Hide",
    labelGroupPrefix: "Tab Group Prefix",
    labelReleasePolicy: "When a session ends",
    policyClose: "Close tabs and remove group (default)",
    policyMark: "Keep tabs, grey-mark group (· released)",
    policyKeep: "Keep tabs and group untouched",
    saveButton: "Save & Connect",
    syncBundledButton: "Load App Defaults",
    savedNotice: "Saved & reconnecting…",
    syncedNotice: "Synced from Cdproxy app",
    openFullOptions: "Full page",
    langToggleTitle: "切换为中文",
  },
};

function detectBrowserLang() {
  const raw =
    (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage && chrome.i18n.getUILanguage()) ||
    navigator.language ||
    "en";
  return /^zh/i.test(String(raw)) ? "zh" : "en";
}

let currentLang = detectBrowserLang();
let lastStatusPayload = null;

function msg(key) {
  return (I18N[currentLang] && I18N[currentLang][key]) || I18N.en[key] || key;
}

function applyI18n() {
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
  document.title = msg("pageTitle");
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const val = msg(el.getAttribute("data-i18n"));
    if (val) el.textContent = val;
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const val = msg(el.getAttribute("data-i18n-placeholder"));
    if (val) el.setAttribute("placeholder", val);
  }
  if (elToggleToken) {
    elToggleToken.textContent = elToken.type === "password" ? msg("showToken") : msg("hideToken");
  }
  if (elLangBtn) {
    elLangBtn.textContent = currentLang === "zh" ? "EN" : "中文";
    elLangBtn.title = msg("langToggleTitle");
  }
  if (lastStatusPayload) {
    renderStatus(lastStatusPayload.connState);
    renderGroups(lastStatusPayload.activeGroups, lastStatusPayload.config?.groupPrefix);
  }
}

// 解析单条配对链接（如 ws://127.0.0.1:9225/ext?token=xxx），自动拆分地址与令牌
function tryParsePairingString(raw) {
  const text = (raw || "").trim();
  if (!text || (!text.includes("token=") && !/^wss?:\/\//i.test(text))) return null;
  try {
    const normalized = text.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
    const u = new URL(normalized);
    const token = u.searchParams.get("token");
    if (!token) return null;
    u.searchParams.delete("token");
    const cleanUrl = u.toString().replace(/\?$/, "");
    return { relayUrl: cleanUrl, token };
  } catch {
    return null;
  }
}

const elVersion = document.getElementById("extVersion");
const elLangBtn = document.getElementById("btnLang");
const elStatus = document.getElementById("statusBadge");
const elReconnect = document.getElementById("btnReconnect");
const elGroupsRow = document.getElementById("groupsRow");
const elRelay = document.getElementById("relayUrl");
const elToken = document.getElementById("token");
const elToggleToken = document.getElementById("btnToggleToken");
const elPrefix = document.getElementById("groupPrefix");
const elPrefixPreview = document.getElementById("prefixPreview");
const elPolicy = document.getElementById("releasePolicy");
const elSave = document.getElementById("btnSave");
const elSync = document.getElementById("btnSyncBundled");
const elNotice = document.getElementById("notice");
const elFullOptions = document.getElementById("btnFullOptions");

let noticeTimer = null;
function showNotice(text) {
  elNotice.textContent = text;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    elNotice.textContent = "";
  }, 2400);
}

function updatePrefixPreview() {
  const p = (elPrefix.value || "").trim() || DEFAULT_GROUP_PREFIX;
  elPrefixPreview.textContent = `${p} research`;
}

function renderStatus(state) {
  const st = state?.status || "disconnected";
  const reason = state?.reason || "";
  elStatus.className = "badge";
  if (st === "connected") {
    elStatus.classList.add("ok");
    elStatus.textContent = msg("statusConnected");
  } else if (st === "connecting") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusConnecting");
  } else if (st === "auth_error" || reason === "invalid_token") {
    elStatus.classList.add("bad");
    elStatus.textContent = msg("statusAuthError");
  } else if (reason === "missing_token") {
    elStatus.classList.add("bad");
    elStatus.textContent = msg("statusMissingToken");
  } else if (reason === "source_disabled") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusSourceDisabled");
  } else if (reason === "proxy_offline") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusProxyOffline");
  } else {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusDisconnected");
  }
}

function renderGroups(groups, prefix) {
  const p = (prefix || "").trim() || DEFAULT_GROUP_PREFIX;
  elGroupsRow.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = msg("activeGroupsLabel") + ":";
  elGroupsRow.appendChild(label);
  if (!groups || !groups.length) {
    const empty = document.createElement("span");
    empty.textContent = msg("noActiveGroups");
    elGroupsRow.appendChild(empty);
    return;
  }
  for (const name of groups) {
    const chip = document.createElement("span");
    chip.className = "group-chip";
    chip.textContent = `${p} ${name}`;
    elGroupsRow.appendChild(chip);
  }
}

async function initLang() {
  try {
    const got = await chrome.storage.local.get(["uiLang"]);
    if (got.uiLang === "zh" || got.uiLang === "en") {
      currentLang = got.uiLang;
    }
  } catch {}
  applyI18n();
}

async function refresh(fillInputs = false) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getStatus" });
    if (!res || !res.ok) return;
    lastStatusPayload = res;
    if (elVersion && res.version) elVersion.textContent = "v" + res.version;
    renderStatus(res.connState);
    renderGroups(res.activeGroups, res.config?.groupPrefix);
    if (elSync) {
      elSync.style.display = res.config?.hasBundled ? "" : "none";
    }
    if (fillInputs && res.config) {
      elRelay.value = res.config.url || DEFAULT_RELAY;
      elToken.value = res.config.token || "";
      elPrefix.value = res.config.groupPrefix || DEFAULT_GROUP_PREFIX;
      elPolicy.value = res.config.releasePolicy || "close";
      updatePrefixPreview();
    }
  } catch {
    // SW 唤醒中，忽略单次错误
  }
}

function handleSmartInput(inputEl) {
  const parsed = tryParsePairingString(inputEl.value);
  if (!parsed) return;
  elRelay.value = parsed.relayUrl;
  elToken.value = parsed.token;
  showNotice(msg("pairParsed"));
}

elRelay.addEventListener("input", () => handleSmartInput(elRelay));
elToken.addEventListener("input", () => handleSmartInput(elToken));
elPrefix.addEventListener("input", updatePrefixPreview);

if (elLangBtn) {
  elLangBtn.addEventListener("click", async () => {
    currentLang = currentLang === "zh" ? "en" : "zh";
    applyI18n();
    try {
      await chrome.storage.local.set({ uiLang: currentLang });
    } catch {}
  });
}

elToggleToken.addEventListener("click", () => {
  const hidden = elToken.type === "password";
  elToken.type = hidden ? "text" : "password";
  elToggleToken.textContent = hidden ? msg("hideToken") : msg("showToken");
});

elSave.addEventListener("click", async () => {
  const parsed = tryParsePairingString(elRelay.value) || tryParsePairingString(elToken.value);
  if (parsed) {
    elRelay.value = parsed.relayUrl;
    elToken.value = parsed.token;
  }
  await chrome.runtime.sendMessage({
    type: "saveConfig",
    relayUrl: elRelay.value.trim() || DEFAULT_RELAY,
    token: elToken.value.trim(),
    groupPrefix: elPrefix.value.trim() || DEFAULT_GROUP_PREFIX,
    releasePolicy: elPolicy.value,
  });
  showNotice(msg("savedNotice"));
  setTimeout(() => refresh(false), 350);
  setTimeout(() => refresh(false), 1100);
});

elReconnect.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "reconnect" });
  setTimeout(() => refresh(false), 300);
  setTimeout(() => refresh(false), 1000);
});

if (elSync) {
  elSync.addEventListener("click", async () => {
    const res = await chrome.runtime.sendMessage({ type: "syncBundled" });
    if (res && res.ok && res.config) {
      elRelay.value = res.config.url || DEFAULT_RELAY;
      elToken.value = res.config.token || "";
      elPrefix.value = res.config.groupPrefix || DEFAULT_GROUP_PREFIX;
      updatePrefixPreview();
      showNotice(msg("syncedNotice"));
      setTimeout(() => refresh(false), 400);
    }
  });
}

if (elFullOptions) {
  elFullOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

initLang().then(() => refresh(true));
setInterval(() => refresh(false), 1500);
