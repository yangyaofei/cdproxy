// config-ui.js — cdp-ext Popup 与 Options 共用前端逻辑（实时状态 + 智能粘贴配对串 + 保存即重连）。
"use strict";

const DEFAULT_RELAY = "ws://127.0.0.1:9225/ext";
const DEFAULT_GROUP_PREFIX = "cdproxy:";

function msg(key, fallback = "") {
  if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getMessage) {
    const val = chrome.i18n.getMessage(key);
    if (val) return val;
  }
  return fallback || key;
}

function applyI18n() {
  if (typeof chrome !== "undefined" && chrome.i18n && chrome.i18n.getUILanguage) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
  for (const el of document.querySelectorAll("[data-i18n]")) {
    const val = msg(el.getAttribute("data-i18n"));
    if (val) el.textContent = val;
  }
  for (const el of document.querySelectorAll("[data-i18n-placeholder]")) {
    const val = msg(el.getAttribute("data-i18n-placeholder"));
    if (val) el.setAttribute("placeholder", val);
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

applyI18n();

const elVersion = document.getElementById("extVersion");
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
    elStatus.textContent = msg("statusConnected", "Connected");
  } else if (st === "connecting") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusConnecting", "Connecting…");
  } else if (st === "auth_error" || reason === "invalid_token") {
    elStatus.classList.add("bad");
    elStatus.textContent = msg("statusAuthError", "Token mismatch (401)");
  } else if (reason === "missing_token") {
    elStatus.classList.add("bad");
    elStatus.textContent = msg("statusMissingToken", "Access token required");
  } else if (reason === "source_disabled") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusSourceDisabled", "Extension source disabled");
  } else if (reason === "proxy_offline") {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusProxyOffline", "cdproxy app offline");
  } else {
    elStatus.classList.add("warn");
    elStatus.textContent = msg("statusDisconnected", "Disconnected");
  }
}

function renderGroups(groups, prefix) {
  const p = (prefix || "").trim() || DEFAULT_GROUP_PREFIX;
  elGroupsRow.innerHTML = "";
  const label = document.createElement("span");
  label.textContent = msg("activeGroupsLabel", "Active groups") + ":";
  elGroupsRow.appendChild(label);
  if (!groups || !groups.length) {
    const empty = document.createElement("span");
    empty.textContent = msg("noActiveGroups", "None");
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

async function refresh(fillInputs = false) {
  try {
    const res = await chrome.runtime.sendMessage({ type: "getStatus" });
    if (!res || !res.ok) return;
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
  showNotice(msg("pairParsed", "Pairing URL parsed"));
}

elRelay.addEventListener("input", () => handleSmartInput(elRelay));
elToken.addEventListener("input", () => handleSmartInput(elToken));
elPrefix.addEventListener("input", updatePrefixPreview);

elToggleToken.addEventListener("click", () => {
  const hidden = elToken.type === "password";
  elToken.type = hidden ? "text" : "password";
  elToggleToken.textContent = hidden ? msg("hideToken", "Hide") : msg("showToken", "Show");
});

elSave.addEventListener("click", async () => {
  // 保存前也检查一次是否直接粘贴了完整配对串
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
  showNotice(msg("savedNotice", "Saved & reconnecting…"));
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
      showNotice(msg("syncedNotice", "Synced from cdproxy app"));
      setTimeout(() => refresh(false), 400);
    }
  });
}

if (elFullOptions) {
  elFullOptions.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

refresh(true);
setInterval(() => refresh(false), 1500);
