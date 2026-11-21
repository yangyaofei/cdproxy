/* cdproxy Admin 前端逻辑（零构建 Alpine 组件，static/admin 为唯一源，
 * 经 scripts/sync_admin_frontend.py 同步至 desktop/frontend）。
 *
 * 传输与同步模型：
 *   - 桌面 App 态：window.__cdpWails.doRequest 进程内直调 control Handler（外部端口关闭时照常工作），
 *     正常在线靠 Wails 事件 `cdp:state` 实时推送（零轮询）；离线时 800ms 快探恢复。
 *   - Web 网页态：回落同源 REST fetch + 5s 轮询（受 settings.admin_web_enabled 控制）。
 *   - 六页签结构：overview（双源概览）/ sessions（Tabulator 会话表+交互详情）/ rules（CDP 改写规则）/
 *     sources（源、接入点与路由）/ settings（端口与回收时限）/ logs（运行日志）/ about（三组件版本与升级）。
 */

const DEFAULT_REWRITES = [
  { match: "Target.createTarget", action: "rewrite", set: { background: true }, remove: [], group: "focus", note: "tab 创建不抢焦点（+background:true）" },
  { match: "Target.activateTarget", action: "fake", set: {}, remove: [], group: "focus", note: "激活拦截（假成功）" },
  { match: "Page.bringToFront", action: "fake", set: {}, remove: [], group: "focus", note: "置前拦截（假成功）" },
  { match: "Browser.setWindowBounds", action: "rewrite", set: {}, remove: ["bounds.focused"], group: "focus", note: "剥离窗口 focused 字段" },
  { match: "Emulation.setFocusEmulationEnabled", action: "rewrite", set: {}, remove: [], group: "focus", note: "焦点仿真透传（页内 hasFocus 失真来源）" },
  { match: "Browser.close", action: "fake", set: {}, remove: [], group: "base", note: "基座保护（全体会话共用基础设施）" },
];

/* ── JSON 树查看器（无依赖，<details> 原生折叠）── */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function jsonTree(value, key, depth) {
  const k = key !== null ? `<span class="k">"${esc(key)}"</span>: ` : "";
  if (value === null) return `${k}<span class="u">null</span>`;
  if (typeof value === "string") return `${k}<span class="s">"${esc(value)}"</span>`;
  if (typeof value === "number") return `${k}<span class="n">${value}</span>`;
  if (typeof value === "boolean") return `${k}<span class="b">${value}</span>`;
  const isOpen = depth < 1 ? " open" : "";
  if (Array.isArray(value)) {
    if (!value.length) return `${k}<span class="br">[]</span>`;
    const items = value.map((v) => `<div>${jsonTree(v, null, depth + 1)}</div>`).join("");
    return `${k}<details${isOpen}><summary><span class="br">[</span> ${value.length} 项 <span class="br">]</span></summary>${items}</details>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return `${k}<span class="br">{}</span>`;
    const items = keys.map((kk) => `<div>${jsonTree(value[kk], kk, depth + 1)}</div>`).join("");
    return `${k}<details${isOpen}><summary><span class="br">{</span> ${keys.length} 键 <span class="br">}</span></summary>${items}</details>`;
  }
  return `${k}<span class="u">${esc(value)}</span>`;
}

/* ── slog 行解析：time=… level=… msg=… [k=v …] ── */
function parseSlogLine(line) {
  const m = line.match(/^time=(\S+) level=(\S+) msg=(?:"((?:[^"\\]|\\.)*)"|(\S+)) ?(.*)$/);
  if (!m) return null;
  const ts = m[1];
  return {
    ts,
    level: m[2],
    msg: m[3] !== undefined ? m[3] : (m[4] || ""),
    rest: (m[5] || "").trim(),
    timeShort: (ts.includes("T") ? ts.split("T")[1] : ts).replace(/([+-]\d{2}:\d{2}|Z)$/, ""),
    day: ts.includes("T") ? ts.split("T")[0] : "",
  };
}

/* ── JSON / URL / 日志参数语法高亮（无外部依赖） ── */
function highlightJson(src) {
  const s = String(src ?? "");
  const re = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}\[\]:,])/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out += esc(s.slice(last, m.index));
    const tok = m[0];
    if (tok[0] === '"') {
      if (m[2]) {
        const colonIdx = tok.lastIndexOf(":");
        out += `<span class="k">${esc(tok.slice(0, colonIdx))}</span><span class="br">${esc(tok.slice(colonIdx))}</span>`;
        last = re.lastIndex;
        continue;
      }
      out += `<span class="s">${esc(tok)}</span>`;
    } else if (tok === "true" || tok === "false") {
      out += `<span class="b">${tok}</span>`;
    } else if (tok === "null") {
      out += `<span class="u">${tok}</span>`;
    } else if (/^-?\d/.test(tok)) {
      out += `<span class="n">${esc(tok)}</span>`;
    } else {
      out += `<span class="br">${esc(tok)}</span>`;
    }
    last = re.lastIndex;
  }
  if (last < s.length) out += esc(s.slice(last));
  if (s.endsWith("\n")) out += " ";
  return out;
}

function highlightUrl(raw) {
  const s = String(raw || "");
  if (!s) return "";
  return esc(s)
    .replace(/^((?:ws|wss|http|https):\/\/)/, '<span class="hl-proto">$1</span>')
    .replace(/(127\.0\.0\.1(?::\d+)?|localhost(?::\d+)?)/g, '<span class="hl-host">$1</span>')
    .replace(/(&lt;[^&]+&gt;)/g, '<span class="hl-var">$1</span>');
}

function highlightSlogAttrs(rest) {
  if (!rest) return "";
  const re = /([a-zA-Z0-9_.-]+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  const parts = [];
  let last = 0;
  let m;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) {
      const gap = rest.slice(last, m.index).trim();
      if (gap) parts.push(`<span class="hint">${esc(gap)}</span>`);
    }
    const val = m[2];
    let vcls = "sv";
    if (val === "true" || val === "false") vcls = "sv bool";
    else if (/^-?\d+(\.\d+)?$/.test(val)) vcls = "sv num";
    parts.push(`<span class="slog-kv"><span class="sk">${esc(m[1])}</span><span class="seq">=</span><span class="${vcls}">${esc(val)}</span></span>`);
    last = re.lastIndex;
  }
  if (last < rest.length) {
    const tail = rest.slice(last).trim();
    if (tail) parts.push(`<span class="hint">${esc(tail)}</span>`);
  }
  return parts.length ? parts.join("") : `<span class="hint">${esc(rest)}</span>`;
}

function stableRulesKey(list) {
  try {
    return JSON.stringify((list || []).map(r => ({
      match: r.match || "",
      action: r.action || "rewrite",
      set: r.set || {},
      remove: r.remove || [],
      group: r.group || "",
      note: r.note || "",
    })));
  } catch (e) {
    return "";
  }
}

function admin() {
  return {
    healthy: null, // null=连接中 / true=在线 / false=离线
    status: null,
    tab: "overview",
    theme: "dark",
    viewSessions: [],
    sideCollapsed: localStorage.getItem("sideCol") === "1",
    isDesktop: document.documentElement.classList.contains("is-desktop"),
    isWindows: document.documentElement.classList.contains("is-windows"),
    winMaximized: false,

    // 局部异步态（避免全局锁导致无关按钮集体闪烁禁用）
    saving: {},
    actionKey: "",
    loadingTabs: false,
    loadingSessLogs: false,
    loadingSlogs: false,

    // Toast 与应用内确认弹层
    toasts: [],
    _toastSeq: 0,
    copiedKey: "",
    confirmDlg: null,
    _confirmResolver: null,

    // 会话页状态
    sessionQuery: "",
    sessionStateFilter: "all",
    selSessionName: "",
    detailTab: "tabs", // tabs | logs
    sessionTabs: [],
    tabsError: "",
    sessionLogs: [],
    sessLogsError: "",
    selLog: -1,
    sessGrid: null,

    // 设置表单
    form: {
      disconnect_reap_seconds: null,
      alloc_reap_seconds: null,
      keeper_idle_shutdown_seconds: null,
      control_port: null,
      ws_port: null,
      ports_enabled: null,
      admin_web_enabled: null,
    },
    savedAt: "",

    // 改写规则
    rules: [],
    savedRulesJson: "[]",
    expandedRules: {},
    ruleSetDrafts: {},
    ruleSetErrors: {},
    rulesError: "",
    rulesSavedAt: "",

    // 服务日志
    slogParsed: [],
    slogSkip: 0,
    slogTotal: 0,
    slogHasMore: false,
    slogLoadingOlder: false,
    slogCleared: false,
    slogLevel: "all",
    slogSrc: "all",
    slogQuery: "",
    slogAutoFollow: false,

    // 源 & 接入点
    abInfo: null,
    routeForm: { default_source: "standalone", rules: [] },
    savedRouteJson: "",
    routeSavedAt: "",
    routeError: "",
    sourcesLoaded: false,
    showExtToken: false,
    showAllocToken: false,
    epForm: [],
    savedEpJson: "",
    epSavedAt: "",
    epError: "",

    // JSON 编辑器与配置文件
    jsonDraft: "",
    jsonLoaded: false,
    jsonSavedAt: "",
    jsonError: "",
    configFiles: [],
    configView: "",
    configContent: null,

    // 应用更新与三组件版本状态
    updateMsg: "",
    updateKind: "",
    updateBusy: false,
    canUpdate: false,
    updaterInfo: null,
    versions: null,
    loadingVersions: false,
    abLatest: null,
    checkingAbLatest: false,
    upgradingAb: false,
    abUpgradeErr: "",
    exportingExt: false,
    reloadingExt: false,
    extActionMsg: "",

    // agent-browser 二进制选择
    abMode: "auto",
    abLookupPath: "",
    abPath: "",
    abCustomPath: "",
    abSavedAt: "",
    abError: "",
    abLoaded: false,

    // 数据目录
    layout: null,
    newDataDir: "",
    ddSavedAt: "",
    ddError: "",

    async init() {
      if (window.innerWidth <= 960) this.sideCollapsed = true;
      const saved = localStorage.getItem("abp_theme") || "dark";
      this.applyTheme(saved);

      this.$watch("viewSessions", () => this.$nextTick(() => this.gridSync()));
      this.$watch("sessionQuery", () => this.$nextTick(() => this.gridSync()));
      this.$watch("sessionStateFilter", () => this.$nextTick(() => this.gridSync()));
      this.$watch("selSessionName", () => this.syncGridSelection());
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.confirmDlg) this.resolveConfirm(false);
      });

      await this.refresh();
      this.loadSources();
      this.loadVersions({ silent: true });
      this.loadUpdaterInfo();
      this.$nextTick(() => this.ensureGrid());
      this.bindUpdaterEvents();
      this.bindResponsive();
      this.bindStateEvents();
      this.schedulePoll();
      this.bindLogSentinel();

      window.addEventListener("focus", () => this.refreshSoon());
    },

    /* ── Toast & 应用内确认弹窗 ── */
    toast(msg, kind = "info", ms = 2600) {
      const id = ++this._toastSeq;
      this.toasts.push({ id, msg, kind });
      if (this.toasts.length > 4) this.toasts.shift();
      if (ms > 0) setTimeout(() => this.dismissToast(id), ms);
    },
    dismissToast(id) {
      this.toasts = this.toasts.filter(t => t.id !== id);
    },
    askConfirm({ title, body, confirmText = "确认", cancelText = "取消", danger = false }) {
      return new Promise((resolve) => {
        this._confirmResolver = resolve;
        this.confirmDlg = { title, body, confirmText, cancelText, danger };
      });
    },
    resolveConfirm(ok) {
      const res = this._confirmResolver;
      this._confirmResolver = null;
      this.confirmDlg = null;
      if (res) res(!!ok);
    },

    /* ── 主题与桌面宿主外观同步 ── */
    applyTheme(next) {
      this.theme = next === "light" ? "light" : "dark";
      document.documentElement.dataset.theme = this.theme;
      localStorage.setItem("abp_theme", this.theme);
      if (window.__cdpWails && window.__cdpWails.setAppearance) {
        try { window.__cdpWails.setAppearance(this.theme); } catch (e) {}
      }
    },
    toggleTheme() {
      this.applyTheme(this.theme === "dark" ? "light" : "dark");
    },

    /* ── Windows 桌面端窗口控制（macOS 用系统交通灯，Web 无窗口按钮） ── */
    winMin() {
      if (window.__cdpWails && window.__cdpWails.windowMinimize) window.__cdpWails.windowMinimize();
    },
    async winToggleMax() {
      if (window.__cdpWails && window.__cdpWails.windowToggleMaximize) {
        this.winMaximized = await window.__cdpWails.windowToggleMaximize();
      }
    },
    winClose() {
      if (window.__cdpWails && window.__cdpWails.windowClose) window.__cdpWails.windowClose();
    },
    topbarDblClick(e) {
      if (!this.isWindows) return;
      if (e.target && e.target.closest("button, input, .status-strip, .win-ctrls")) return;
      this.winToggleMax();
    },

    highlightJson(src) { return highlightJson(src); },
    highlightUrl(raw) { return highlightUrl(raw); },
    highlightSlogAttrs(rest) { return highlightSlogAttrs(rest); },
    configContentHtml() {
      if (this.configContent === null) return "";
      const txt = String(this.configContent);
      const t = txt.trimStart();
      if ((this.configView && this.configView.endsWith(".json")) || t.startsWith("{") || t.startsWith("[")) {
        return highlightJson(txt);
      }
      return esc(txt);
    },

    /* ── 事件驱动与轮询 ── */
    bindStateEvents() {
      const bind = () => {
        if (!window.__wailsEvents) return false;
        window.__wailsEvents.On("cdp:state", (data) => {
          const payload = data && data.data !== undefined ? data.data : data;
          if (payload === "engine-offline") {
            this.healthy = false;
            return;
          }
          try { this.applyStatus(JSON.parse(payload)); } catch (e) {}
        });
        return true;
      };
      if (!bind()) window.addEventListener("wails-events-ready", () => bind(), { once: true });
    },
    refreshSoon() {
      clearTimeout(this._soonT);
      this._soonT = setTimeout(() => this.refresh(), 60);
    },
    schedulePoll() {
      clearTimeout(this._pollT);
      const inApp = !!window.__wailsEvents;
      const iv = inApp ? (this.healthy ? 0 : 900) : (this.healthy ? 5000 : 900);
      if (!iv) return;
      this._pollT = setTimeout(async () => {
        await this.refresh();
        this.schedulePoll();
      }, iv);
    },

    /* ── 导航与响应式 ── */
    toggleSide() {
      this.sideCollapsed = !this.sideCollapsed;
      localStorage.setItem("sideCol", this.sideCollapsed ? "1" : "0");
    },
    pageTitle() {
      return {
        sessions: "会话概览",
        rules: "改写规则",
        sources: "源 & 接入点",
        settings: "全局设置",
        logs: "运行日志",
      }[this.tab] || "";
    },
    go(tab) {
      this.tab = tab;
      if (tab === "overview" || tab === "sources") this.loadSources();
      if (tab === "about" || tab === "settings") {
        this.loadVersions({ silent: true });
        this.loadUpdaterInfo();
      }
      if (tab === "sessions") this.$nextTick(() => { this.ensureGrid(); if (this.sessGrid) this.gridSync(); });
      if (tab === "settings") {
        this.loadConfigs();
        this.loadLayout();
        this.loadAbChoice();
        if (!this.jsonLoaded) this.reloadJsonDraft();
      }
      if (tab === "logs" && !this.slogParsed.length && !this.slogCleared) {
        this.loadLogs();
      }
    },

    /* ── 概览首页快捷计算与操作 ── */
    sourceSessionCount(kind) {
      return this.viewSessions.filter(s => s.state !== "released" && s.type === kind).length;
    },
    overviewSessions() {
      const active = this.viewSessions.filter(s => s.state !== "released");
      const released = this.viewSessions.filter(s => s.state === "released");
      return active.concat(released).slice(0, 6);
    },
    openSession(name) {
      this.tab = "sessions";
      this.$nextTick(() => {
        this.ensureGrid();
        if (this.sessGrid) this.gridSync();
        this.selectSession(name);
      });
    },
    async setDefaultSource(src) {
      if (!["standalone", "extension"].includes(src)) return;
      if (this.saving.routing) return;
      this.saving = { ...this.saving, routing: true };
      try {
        const rules = JSON.parse(JSON.stringify(this.status?.routing?.rules || []));
        const updated = await this.api("PUT", "/settings", { routing: { default_source: src, rules } });
        this.syncAllFromSettings(updated);
        await this.refresh();
        this.toast(`默认路由源已设为 ${src}`, "ok");
      } catch (err) {
        this.toast("切换默认源失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, routing: false };
      }
    },

    async api(method, path, body) {
      if (window.__cdpWails) {
        const r = await window.__cdpWails.doRequest(method, path, body === undefined ? "" : JSON.stringify(body));
        const data = r.body ? JSON.parse(r.body) : {};
        if (r.status >= 400) throw new Error(data.error || `${method} ${path} → ${r.status}`);
        return data;
      }
      const resp = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data.error || `${method} ${path} → ${resp.status}`);
      return data;
    },

    syncFormFromSettings(s) {
      if (!s) return;
      this.form.disconnect_reap_seconds = s.disconnect_reap_seconds;
      this.form.alloc_reap_seconds = s.alloc_reap_seconds;
      this.form.keeper_idle_shutdown_seconds = s.keeper_idle_shutdown_seconds;
      this.form.control_port = s.control_port;
      this.form.ws_port = s.ws_port;
      this.form.ports_enabled = s.ports_enabled;
      this.form.admin_web_enabled = s.admin_web_enabled;
    },

    syncAllFromSettings(s) {
      if (!s) return;
      this.syncFormFromSettings(s);
      if (Array.isArray(s.rewrites)) {
        this.rules = JSON.parse(JSON.stringify(s.rewrites));
        this.savedRulesJson = stableRulesKey(this.rules);
        this.expandedRules = {};
        this.ruleSetDrafts = {};
        this.ruleSetErrors = {};
      }
      if (s.routing) {
        this.routeForm.default_source = s.routing.default_source || "standalone";
        this.routeForm.rules = JSON.parse(JSON.stringify(s.routing.rules || []));
        this.savedRouteJson = JSON.stringify(this.routeForm);
      }
      if (Array.isArray(s.endpoints)) {
        this.epForm = JSON.parse(JSON.stringify(s.endpoints)).map(e => ({ ...e, _show: false }));
        this.savedEpJson = JSON.stringify(this.epForm.map(e => ({ path: e.path, source: e.source, session: e.session || "" })));
      }
      this.jsonDraft = JSON.stringify(s, null, 2);
      this.jsonLoaded = true;
    },

    applyStatus(snap) {
      this.status = snap;
      this.healthy = true;
      const lastTs = {};
      (snap.recent_sessions || []).forEach(r => { lastTs[r.name] = r.last_ts; });
      const active = (snap.sessions || []).map(s => ({
        ...s,
        state: s.connected ? "connected" : "idle",
        last_ts: lastTs[s.name],
      }));
      const activeNames = new Set(active.map(s => s.name));
      const recent = (snap.recent_sessions || [])
        .filter(r => !activeNames.has(r.name))
        .map(r => ({ name: r.name, state: "released", targets: 0, last_ts: r.last_ts }));
      this.viewSessions = [...active, ...recent];

      if (this.form.disconnect_reap_seconds === null) {
        this.syncFormFromSettings(snap.settings);
        this.rules = JSON.parse(JSON.stringify(snap.settings.rewrites || []));
        this.savedRulesJson = stableRulesKey(this.rules);
      }
      if (!this.sourcesLoaded && snap.routing) {
        this.routeForm.default_source = snap.routing.default_source;
        this.routeForm.rules = JSON.parse(JSON.stringify(snap.routing.rules || []));
        this.savedRouteJson = JSON.stringify(this.routeForm);
        this.sourcesLoaded = true;
      }
      if (!this.epForm.length && snap.endpoints && !this.savedEpJson) {
        this.epForm = JSON.parse(JSON.stringify(snap.endpoints)).map(e => ({ ...e, _show: false }));
        this.savedEpJson = JSON.stringify(this.epForm.map(e => ({ path: e.path, source: e.source, session: e.session || "" })));
      }
      if (!this.slogParsed.length && !this.slogCleared) this.loadLogs({ silent: true });
    },

    async refresh() {
      try {
        this.applyStatus(await this.api("GET", "/status"));
        if (this.selSessionName && this.detailTab === "logs") {
          this.loadSessionLogs(this.selSessionName, { silent: true });
        }
      } catch (err) {
        this.healthy = false;
      }
    },

    async startEngine() {
      if (!window.__cdpWails || !window.__cdpWails.startEngine) return;
      this.actionKey = "start";
      try {
        await window.__cdpWails.startEngine();
        await this.refresh();
        this.toast("引擎已启动", "ok");
      } catch (err) {
        this.toast("启动引擎失败：" + (err.message || err), "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    /* ── 边栏状态 ── */
    keeperIdleText() {
      if (!this.status) return "";
      if (!this.status.keeper.alive) return "未运行";
      const s = this.status.settings.keeper_idle_shutdown_seconds;
      return s === 0 ? "不关闭" : `≤ ${s}s`;
    },
    keeperIdlePct() {
      if (!this.status || !this.status.keeper.alive) return 0;
      const s = this.status.settings.keeper_idle_shutdown_seconds;
      if (!s) return 100;
      const n = (this.status.sessions || []).length;
      return n ? 100 : 35;
    },

    /* ── 会话统计 & 过滤 ── */
    sessionStats() {
      let connected = 0;
      let idle = 0;
      let released = 0;
      for (const s of this.viewSessions) {
        if (s.state === "connected") connected++;
        else if (s.state === "idle") idle++;
        else released++;
      }
      return { totalActive: connected + idle, connected, idle, released };
    },
    filteredSessions() {
      let list = this.viewSessions;
      if (this.sessionStateFilter !== "all") {
        list = list.filter(s => s.state === this.sessionStateFilter);
      }
      const q = (this.sessionQuery || "").trim().toLowerCase();
      if (!q) return list;
      return list.filter(s =>
        (s.name || "").toLowerCase().includes(q) ||
        (s.group_name || "").toLowerCase().includes(q) ||
        (s.via || "").toLowerCase().includes(q) ||
        (s.type || "").toLowerCase().includes(q)
      );
    },

    /* ── 响应式 & 更新事件 ── */
    bindResponsive() {
      const apply = async () => {
        if (window.innerWidth <= 960 && !this.sideCollapsed) this.sideCollapsed = true;
        else if (window.innerWidth > 960 && localStorage.getItem("sideCol") !== "1") this.sideCollapsed = false;
        if (this.isWindows && window.__cdpWails && window.__cdpWails.windowIsMaximized) {
          try { this.winMaximized = await window.__cdpWails.windowIsMaximized(); } catch (e) {}
        }
      };
      window.addEventListener("resize", apply);
      apply();
    },

    bindUpdaterEvents() {
      document.addEventListener("cdp-updater", (ev) => {
        const { type, data } = ev.detail || {};
        if (type === "runtime-ready") { this.canUpdate = true; return; }
        if (!type || !type.startsWith("wails:updater:")) return;
        this.canUpdate = true;
        const kind = type.split(":").pop();
        if (kind === "update-available" && data) {
          this.updateMsg = `发现新版本 v${data.version || "?"}，正在下载…`;
          this.updateKind = "info";
        } else if (kind === "no-update") {
          this.updateMsg = "已是最新版本";
          this.updateKind = "ok";
          setTimeout(() => { if (this.updateKind === "ok") this.updateMsg = ""; }, 4000);
        } else if (kind === "download-progress" && data) {
          const pct = data.total ? Math.round((data.written / data.total) * 100) : 0;
          this.updateMsg = `下载更新中 ${pct}%`;
          this.updateKind = "info";
        } else if (kind === "update-ready") {
          this.updateMsg = "新版本已就绪，重启后生效";
          this.updateKind = "ready";
        } else if (kind === "error" && data) {
          this.updateMsg = `更新失败：${data.message || data.stage || "未知"}`;
          this.updateKind = "err";
        }
      });
    },

    async checkUpdate() {
      if (!window.__cdpWails || !window.__cdpWails.checkForUpdate) {
        this.toast("网页版不支持自更新，请打开 GitHub Releases 或通过桌面 App 检查", "info", 3500);
        return;
      }
      this.updateBusy = true;
      try {
        await window.__cdpWails.checkForUpdate();
      } catch (err) {
        const msg = err?.message || String(err);
        this.updateMsg = msg;
        this.updateKind = "err";
        this.toast(msg, "err", 4200);
      } finally {
        this.updateBusy = false;
      }
    },
    async installUpdate() {
      if (window.__cdpWails && window.__cdpWails.restartForUpdate) await window.__cdpWails.restartForUpdate();
    },

    /* ── 版本全景与三组件升级 ── */
    async loadUpdaterInfo() {
      if (!window.__cdpWails || !window.__cdpWails.updaterInfo) return;
      try { this.updaterInfo = await window.__cdpWails.updaterInfo(); } catch (e) {}
    },
    async loadVersions(opts = {}) {
      if (!opts.silent) this.loadingVersions = true;
      try {
        this.versions = await this.api("GET", "/versions");
      } catch (err) {
        if (!opts.silent) this.toast("读取版本信息失败：" + err.message, "err", 3500);
      } finally {
        this.loadingVersions = false;
      }
    },
    hasAnyUpgrade() {
      const extUp = !!(this.versions?.extension?.needs_export || this.versions?.extension?.needs_reload);
      const abUp = !!this.abLatest?.update_available;
      return extUp || abUp || this.updateKind === "ready";
    },
    async checkAllUpdates() {
      await Promise.allSettled([
        this.loadVersions(),
        this.checkAbLatest(),
        ...(this.updaterInfo?.configured ? [this.checkUpdate()] : []),
      ]);
    },
    async checkAbLatest() {
      this.abUpgradeErr = "";
      this.checkingAbLatest = true;
      try {
        this.abLatest = await this.api("GET", "/sources/agent-browser/latest");
        if (this.abLatest.update_available) {
          this.toast(`发现 agent-browser 新版 v${this.abLatest.latest_version}`, "info", 3200);
        } else {
          this.toast(`agent-browser 已是最新 (v${this.abLatest.latest_version})`, "ok", 2600);
        }
      } catch (err) {
        this.abUpgradeErr = err.message;
        this.toast("检查 agent-browser 更新失败：" + err.message, "err", 4000);
      } finally {
        this.checkingAbLatest = false;
      }
    },
    async upgradeAgentBrowser(ver = "") {
      const target = ver || this.abLatest?.latest_version || "";
      const ok = await this.askConfirm({
        title: target ? `升级 agent-browser 到 v${target}？` : "升级 agent-browser 到最新版？",
        body: "将从 GitHub Releases 下载平台二进制并做 SHA-256 校验，装入数据目录 bin/ 并自动切换 agent_browser_binary 设置（原内嵌版本不受影响，可随时还原）。",
        confirmText: "下载并升级",
      });
      if (!ok) return;
      this.abUpgradeErr = "";
      this.upgradingAb = true;
      try {
        const res = await this.api("POST", "/sources/agent-browser/upgrade", target ? { version: target } : {});
        await Promise.allSettled([
          this.loadVersions({ silent: true }),
          this.loadSources(),
          this.loadAbChoice(),
          this.refresh(),
        ]);
        if (this.abLatest) {
          this.abLatest = { ...this.abLatest, current_version: res.version, update_available: false };
        }
        this.toast(`agent-browser 已升级到 v${res.version}`, "ok", 3200);
      } catch (err) {
        this.abUpgradeErr = err.message;
        this.toast("升级失败：" + err.message, "err", 4500);
      } finally {
        this.upgradingAb = false;
      }
    },
    async useBundledAgentBrowser() {
      try {
        await this.api("POST", "/sources/agent-browser/use-bundled", {});
        await Promise.allSettled([
          this.loadVersions({ silent: true }),
          this.loadSources(),
          this.loadAbChoice(),
          this.refresh(),
        ]);
        this.toast("已恢复使用默认解析链（优先内嵌版本）", "ok", 2800);
      } catch (err) {
        this.toast("切换失败：" + err.message, "err", 3500);
      }
    },
    async exportExtension(openAfter = false) {
      this.exportingExt = true;
      this.extActionMsg = "";
      try {
        const res = await this.api("POST", "/sources/extension/export", {});
        await this.loadVersions({ silent: true });
        this.extActionMsg = `已写入 v${res.version} 至 ${res.path}`;
        this.toast(`已同步 cdp-ext v${res.version} 到本地目录`, "ok", 2800);
        if (openAfter && window.__cdpWails && window.__cdpWails.openPath) {
          await window.__cdpWails.openPath(res.path);
        }
      } catch (err) {
        this.toast("导出扩展失败：" + err.message, "err", 4000);
      } finally {
        this.exportingExt = false;
      }
    },
    async reloadExtension() {
      this.reloadingExt = true;
      try {
        await this.api("POST", "/sources/extension/reload", {});
        this.toast("已通知 Chrome 重载 cdp-ext，正在重新回连…", "ok", 2800);
        setTimeout(() => {
          this.refresh();
          this.loadVersions({ silent: true });
        }, 900);
      } catch (err) {
        this.toast(err.message, "err", 4000);
      } finally {
        this.reloadingExt = false;
      }
    },
    async openLocalPath(p) {
      if (!p) return;
      if (window.__cdpWails && window.__cdpWails.openPath) {
        try {
          await window.__cdpWails.openPath(p);
        } catch (err) {
          this.toast("打开目录失败：" + (err.message || err), "err", 3500);
        }
      } else {
        this.copyText(p, "路径已复制（网页端无法直接唤起文件管理器）", "ext-dir");
      }
    },
    downloadExtZip() {
      const path = "/sources/extension/bundle.zip";
      if (!this.isDesktop) {
        window.location.href = path;
        return;
      }
      if (this.status?.settings?.ports_enabled && this.status?.settings?.control_port) {
        this.openExternalURL(`http://127.0.0.1:${this.status.settings.control_port}${path}`);
        return;
      }
      this.toast("当前仅内嵌通道开放；请点击「同步到本地扩展目录」直接解压写入磁盘", "info", 3600);
    },
    openExternalURL(url) {
      if (!url) return;
      if (window.__cdpWails && window.__cdpWails.openURL) {
        window.__cdpWails.openURL(url).catch(() => {});
      } else {
        window.open(url, "_blank", "noopener");
      }
    },

    /* ── 会话表（Tabulator） ── */
    selSession() {
      return this.viewSessions.find(s => s.name === this.selSessionName) || null;
    },

    syncGridSelection() {
      if (!this.sessGrid || !this.sessGrid.getRows) return;
      const cur = this.selSessionName;
      for (const row of this.sessGrid.getRows()) {
        const el = row.getElement && row.getElement();
        if (!el) continue;
        const active = cur && row.getData().name === cur;
        el.classList.toggle("is-active", !!active);
      }
    },

    selectSession(name) {
      if (this.selSessionName === name) {
        this.selSessionName = "";
        this.sessionTabs = [];
        this.tabsError = "";
        this.sessionLogs = [];
        this.sessLogsError = "";
        this.selLog = -1;
      } else {
        this.selSessionName = name;
        this.selLog = -1;
        this.loadTabs(name);
        if (this.detailTab === "logs") this.loadSessionLogs(name);
      }
      this.syncGridSelection();
    },

    switchDetailTab(tab) {
      this.detailTab = tab;
      if (!this.selSessionName) return;
      if (tab === "tabs") this.loadTabs(this.selSessionName);
      if (tab === "logs") this.loadSessionLogs(this.selSessionName);
    },

    ensureGrid() {
      const holder = document.querySelector("#sessions-grid");
      if (!holder || holder.offsetParent === null) return;
      if (this.sessGrid) {
        if (this._applyGridCols) this._applyGridCols(holder.clientWidth);
        return;
      }
      if (typeof Tabulator === "undefined") return;
      if (this._gridRO) this._gridRO.disconnect();
      this._applyGridCols = (w) => {
        const g = this.sessGrid;
        if (!g || !g.initialized || !holder || holder.offsetParent === null || !w) return;
        const want = [
          { col: "last_ts", need: 820 },
          { col: "via", need: 700 },
          { col: "group_name", need: 560 },
        ];
        for (const { col, need } of want) {
          const visible = w >= need;
          try { visible ? g.showColumn(col) : g.hideColumn(col); } catch (e) {}
        }
        try { g.redraw(true); } catch (e) {}
      };
      this._gridRO = new ResizeObserver((ents) => {
        const w = ents[0] && ents[0].contentRect ? ents[0].contentRect.width : 0;
        if (w <= 0 || !holder.offsetParent) return;
        if (this.sessGrid && this.sessGrid.initialized && this._applyGridCols) this._applyGridCols(w);
      });
      this._gridRO.observe(holder);

      this.sessGrid = new Tabulator("#sessions-grid", {
        data: this.filteredSessions(),
        index: "name",
        layout: "fitColumns",
        resizableColumns: true,
        height: "auto",
        selectableRows: false,
        rowFormatter: (row) => {
          const el = row.getElement();
          if (el) el.classList.toggle("is-active", !!this.selSessionName && row.getData().name === this.selSessionName);
        },
        columns: [
          {
            title: "名称", field: "name", headerSort: false, formatter: "plaintext",
            cssClass: "mono", widthGrow: 3, minWidth: 140, maxWidth: 420,
          },
          {
            title: "类型", field: "type", headerSort: false, width: 128, minWidth: 114,
            formatter: (cell) => {
              const t = cell.getValue() || "";
              if (!t) return '<span class="hint">—</span>';
              const isExt = t === "extension";
              const ic = isExt ? "#i-puzzle" : "#i-chrome";
              return `<span class="bdg with-ic ${isExt ? "ext" : "sa"}"><svg class="ic-xs"><use href="${ic}"/></svg><span>${esc(t)}</span></span>`;
            },
          },
          {
            title: "状态", field: "state", headerSort: false, width: 92, minWidth: 82,
            formatter: (cell) => {
              const v = cell.getValue() || "";
              const cls = v === "connected" ? "ok" : (v === "idle" ? "idle" : "warn");
              const zh = v === "connected" ? "已连接" : (v === "idle" ? "空闲" : "已释放");
              return `<span class="bdg ${cls}">${zh}</span>`;
            },
          },
          {
            title: "Tabs", field: "targets", headerSort: false, width: 64, minWidth: 52,
            formatter: (cell) => `<span class="bdg plain">${cell.getValue() ?? 0}</span>`,
          },
          {
            title: "组名", field: "group_name", headerSort: false, cssClass: "mono sg-col",
            widthGrow: 1, minWidth: 100, maxWidth: 260,
            formatter: (cell) => esc(cell.getValue() || "—"),
          },
          {
            title: "入口", field: "via", headerSort: false, cssClass: "mono sg-col",
            width: 108, minWidth: 82,
            formatter: (cell) => esc(cell.getValue() || "—"),
          },
          {
            title: "最近活动", field: "last_ts", headerSort: false, width: 96, minWidth: 80,
            cssClass: "mono sg-col",
            formatter: (cell) => {
              const v = cell.getValue();
              if (!v) return '<span class="hint">—</span>';
              return `<span title="${esc(this.fmtFullTime(v))}">${esc(this.fmtRelTime(v))}</span>`;
            },
          },
        ],
      });
      this.sessGrid.on("tableBuilt", () => {
        if (this._applyGridCols) this._applyGridCols(holder.clientWidth);
        this.gridSync();
      });
      this.sessGrid.on("rowClick", (_e, row) => {
        this.selectSession(row.getData().name);
      });
    },

    gridSync() {
      if (!this.sessGrid) return this.ensureGrid();
      const holder = document.querySelector("#sessions-grid");
      if (!holder || holder.offsetParent === null) return;
      if (!this.sessGrid.initialized) return;
      this.sessGrid.replaceData(this.filteredSessions());
      try { if (this.sessGrid.redraw) this.sessGrid.redraw(true); } catch (e) {}
      const cur = this.selSessionName;
      if (cur && !this.viewSessions.some(s => s.name === cur)) {
        this.selSessionName = "";
        this.sessionTabs = [];
        this.sessionLogs = [];
        this.selLog = -1;
      } else {
        this.syncGridSelection();
      }
    },

    async loadTabs(name) {
      this.tabsError = "";
      this.loadingTabs = true;
      try {
        const r = await this.api("GET", `/sessions/${encodeURIComponent(name)}/tabs`);
        if (this.selSessionName === name) this.sessionTabs = r.tabs || [];
      } catch (err) {
        if (this.selSessionName === name) {
          this.tabsError = err.message;
          this.sessionTabs = [];
        }
      } finally {
        this.loadingTabs = false;
      }
    },

    /* ── 源 & 接入点 ── */
    extRelayUrl() {
      if (!this.status) return "";
      return `ws://127.0.0.1:${this.status.settings.ws_port}/ext`;
    },
    abSourceText(src) {
      return { bundled: "内嵌", setting: "外部·指定", path: "外部·PATH", none: "无" }[src] || src;
    },
    fmtAbVersion(v) {
      if (!v) return "";
      const clean = String(v).trim().replace(/^agent-browser\s+/i, "");
      return clean.startsWith("v") ? clean : "v" + clean;
    },
    async loadSources() {
      try {
        this.abInfo = await this.api("GET", "/sources/agent-browser");
        this.abLookupPath = this.abInfo.path_lookup || "";
      } catch (err) {
        this.abInfo = null;
      }
    },

    async toggleSource(kind, enable) {
      if (this.saving.source) return;
      const cur = this.status?.sources || {};
      const other = kind === "standalone" ? cur.extension?.enabled : cur.standalone?.enabled;
      if (!enable && !other) {
        this.toast("至少需要保留一个启用中的数据源", "err");
        await this.refresh();
        return;
      }
      this.saving = { ...this.saving, source: true };
      try {
        await this.api("PUT", "/settings", {
          sources: { [kind === "standalone" ? "standalone_enabled" : "extension_enabled"]: enable },
        });
        await this.refresh();
        this.toast(`${kind} 源已${enable ? "启用" : "禁用"}`, "ok");
      } catch (err) {
        this.toast("切换失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, source: false };
      }
    },

    /* ── 剪贴板复制（全局 Toast + 局部勾选回显） ── */
    async copyText(text, tip, key = "") {
      try {
        await navigator.clipboard.writeText(text);
        if (key) {
          this.copiedKey = key;
          setTimeout(() => { if (this.copiedKey === key) this.copiedKey = ""; }, 1500);
        }
        this.toast(tip || "已复制到剪贴板", "ok", 2000);
      } catch (err) {
        this.toast("复制失败：" + (err.message || "剪贴板不可用"), "err", 3500);
      }
    },

    endpointURL(ep) {
      return `ws://127.0.0.1:${this.status.ws_port}/${ep.path}/${ep.token}`;
    },
    copyEndpoint(ep, idx) {
      if (!ep.path || !ep.token) {
        this.toast("请先保存接入点以生成令牌", "err");
        return;
      }
      this.copyText(this.endpointURL(ep), `已复制 ${ep.path} 连接 URL`, `ep-url-${idx}`);
    },
    epTokenPreview(ep) {
      return ep.token ? ep.token.slice(0, 8) + "…" : "保存后自动生成";
    },

    async resetToken(kind) {
      const ok = await this.askConfirm({
        title: kind === "ext" ? "重置扩展准入令牌？" : "重置分配令牌？",
        body: kind === "ext"
          ? "旧令牌将立即吊销。重置后需同步更新浏览器 cdp-ext 扩展的 Options 配置，否则扩展无法回连。"
          : "旧分配令牌将立即吊销。正在使用旧令牌的脚本会收到 401（本机 agent-browser plugin 会自动重取）。",
        confirmText: "确认重置",
        danger: true,
      });
      if (!ok) return;
      this.actionKey = `reset-${kind}`;
      try {
        const path = kind === "ext" ? "/sources/ext-token/reset" : "/sources/alloc-token/reset";
        await this.api("POST", path, {});
        await this.refresh();
        this.toast("令牌已重置并生效", "ok");
      } catch (err) {
        this.toast("重置失败：" + err.message, "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    async resetEndpointToken(ep) {
      const ok = await this.askConfirm({
        title: `重置接入点「${ep.path}」令牌？`,
        body: "旧令牌将立即吊销，使用旧连接 URL 的客户端会断开。",
        confirmText: "重置令牌",
        danger: true,
      });
      if (!ok) return;
      this.actionKey = `ep-reset-${ep.path}`;
      try {
        const r = await this.api("POST", `/endpoints/${encodeURIComponent(ep.path)}/reset-token`, {});
        ep.token = r.token;
        this.toast(`接入点 ${ep.path} 令牌已更新`, "ok");
      } catch (err) {
        this.epError = err.message;
        this.toast(err.message, "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    epDirty() {
      if (!this.savedEpJson) return false;
      const cur = JSON.stringify(this.epForm.map(e => ({ path: e.path || "", source: e.source || "extension", session: e.session || "" })));
      return cur !== this.savedEpJson;
    },
    resetEndpoints() {
      if (!this.status) return;
      this.epForm = JSON.parse(JSON.stringify(this.status.endpoints || [])).map(e => ({ ...e, _show: false }));
      this.epError = "";
    },
    async saveEndpoints() {
      this.epError = "";
      const eps = [];
      for (const ep of this.epForm) {
        const path = (ep.path || "").trim();
        if (!path) continue;
        eps.push({ path, source: ep.source, session: (ep.session || "").trim() });
      }
      this.saving = { ...this.saving, endpoints: true };
      try {
        const updated = await this.api("PUT", "/settings", { endpoints: eps });
        this.syncAllFromSettings(updated);
        this.epSavedAt = "已保存 " + new Date().toLocaleTimeString();
        this.toast("接入点配置已保存", "ok");
      } catch (err) {
        this.epError = err.message;
        this.toast("保存接入点失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, endpoints: false };
      }
    },

    routeDirty() {
      if (!this.savedRouteJson) return false;
      return JSON.stringify(this.routeForm) !== this.savedRouteJson;
    },
    moveRoute(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= this.routeForm.rules.length) return;
      const arr = [...this.routeForm.rules];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      this.routeForm.rules = arr;
    },
    resetRoutes() {
      if (!this.status?.routing) return;
      this.routeForm.default_source = this.status.routing.default_source;
      this.routeForm.rules = JSON.parse(JSON.stringify(this.status.routing.rules || []));
      this.routeError = "";
    },
    async saveRouting() {
      this.routeError = "";
      const rules = this.routeForm.rules
        .map(r => ({ prefix: (r.prefix || "").trim(), source: r.source }))
        .filter(r => r.prefix);
      if (this.routeForm.rules.some(r => (r.prefix || "").trim() && !["standalone", "extension"].includes(r.source))) {
        this.routeError = "规则 source 须为 standalone 或 extension";
        return;
      }
      this.saving = { ...this.saving, routing: true };
      try {
        const updated = await this.api("PUT", "/settings", {
          routing: { default_source: this.routeForm.default_source, rules },
        });
        this.syncAllFromSettings(updated);
        this.routeSavedAt = new Date().toLocaleTimeString();
        await this.refresh();
        this.toast("路由规则已保存", "ok");
      } catch (err) {
        this.routeError = err.message;
        this.toast("保存路由失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, routing: false };
      }
    },

    /* ── 全局设置表单 ── */
    isSettingDirty(key) {
      if (!this.status?.settings) return false;
      const cur = this.form[key];
      const orig = this.status.settings[key];
      if (cur === null || cur === undefined) return false;
      if (typeof orig === "boolean") return !!cur !== orig;
      return Number(cur) !== orig;
    },
    dirty() {
      if (!this.status) return false;
      const s = this.status.settings;
      return (
        Number(this.form.disconnect_reap_seconds) !== s.disconnect_reap_seconds ||
        Number(this.form.alloc_reap_seconds) !== s.alloc_reap_seconds ||
        Number(this.form.keeper_idle_shutdown_seconds ?? s.keeper_idle_shutdown_seconds) !== s.keeper_idle_shutdown_seconds ||
        Number(this.form.control_port) !== s.control_port ||
        Number(this.form.ws_port) !== s.ws_port ||
        this.form.ports_enabled !== s.ports_enabled ||
        this.form.admin_web_enabled !== s.admin_web_enabled
      );
    },
    resetSettingsForm() {
      if (this.status?.settings) this.syncFormFromSettings(this.status.settings);
    },
    async saveSettings() {
      this.saving = { ...this.saving, settings: true };
      try {
        const updated = await this.api("PUT", "/settings", {
          disconnect_reap_seconds: Number(this.form.disconnect_reap_seconds),
          alloc_reap_seconds: Number(this.form.alloc_reap_seconds),
          keeper_idle_shutdown_seconds: Number(this.form.keeper_idle_shutdown_seconds),
          control_port: Number(this.form.control_port),
          ws_port: Number(this.form.ws_port),
          ports_enabled: !!this.form.ports_enabled,
          admin_web_enabled: !!this.form.admin_web_enabled,
        });
        this.syncAllFromSettings(updated);
        this.savedAt = new Date().toLocaleTimeString();
        this.toast("引擎与网络设置已保存", "ok");
        await new Promise(r => setTimeout(r, 500));
        await this.refresh();
      } catch (err) {
        this.toast("保存失败：" + err.message, "err", 4500);
      } finally {
        this.saving = { ...this.saving, settings: false };
      }
    },

    /* ── agent-browser 二进制选择 ── */
    switchAbMode(mode) {
      this.abMode = mode;
      if (mode === "external") {
        this.abPath = this.abCustomPath || this.abLookupPath || "";
      } else {
        this.abCustomPath = this.abPath;
      }
    },
    async loadAbChoice() {
      try {
        const cur = await this.api("GET", "/settings");
        const p = cur.agent_browser_binary || "";
        this.abMode = p ? "external" : "auto";
        if (p) this.abCustomPath = p;
        this.abPath = p || this.abLookupPath;
        this.abLoaded = true;
      } catch (err) {}
      this.loadSources();
    },
    async saveAgentBrowser() {
      this.abError = "";
      const path = this.abMode === "external" ? (this.abPath || this.abLookupPath).trim() : "";
      if (this.abMode === "external" && !path) {
        this.abError = "外部模式须填绝对路径（PATH 中也未探测到）";
        return;
      }
      this.saving = { ...this.saving, ab: true };
      try {
        const updated = await this.api("PUT", "/settings", { agent_browser_binary: path });
        this.abPath = path;
        if (path) this.abCustomPath = path;
        this.abSavedAt = "已保存 " + new Date().toLocaleTimeString();
        this.jsonDraft = JSON.stringify(updated, null, 2);
        await this.loadSources();
        this.toast("agent-browser 配置已保存", "ok");
      } catch (err) {
        this.abError = err.message;
        this.toast("保存失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, ab: false };
      }
    },

    /* ── 数据目录 ── */
    async loadLayout() {
      try {
        this.layout = await this.api("GET", "/layout");
      } catch (err) {
        this.layout = null;
      }
    },
    async applyDataDir() {
      this.ddError = "";
      const dir = (this.newDataDir || "").trim();
      if (!dir) return;
      const ok = await this.askConfirm({
        title: "修改数据目录？",
        body: `新目录：${dir}\n\n将写入数据目录指针（重启后生效）。原有数据不会自动迁移。`,
        confirmText: "写入指针",
      });
      if (!ok) return;
      this.saving = { ...this.saving, datadir: true };
      try {
        await this.api("PUT", "/data-dir", { data_dir: dir });
        this.ddSavedAt = "已写入指针，重启后生效";
        this.newDataDir = "";
        await this.loadLayout();
        this.toast("数据目录指针已更新，重启后生效", "ok", 3500);
      } catch (err) {
        this.ddError = err.message;
      } finally {
        this.saving = { ...this.saving, datadir: false };
      }
    },

    /* ── settings.json 全文编辑 ── */
    async reloadJsonDraft() {
      try {
        const cur = await this.api("GET", "/settings");
        this.jsonDraft = JSON.stringify(cur, null, 2);
        this.jsonLoaded = true;
        this.jsonError = "";
      } catch (err) {
        this.jsonError = err.message;
      }
    },
    async saveJson() {
      this.jsonError = "";
      let obj;
      try { obj = JSON.parse(this.jsonDraft); } catch (err) {
        this.jsonError = "JSON 解析失败: " + err.message;
        return;
      }
      if (typeof obj !== "object" || Array.isArray(obj) || obj === null) {
        this.jsonError = "顶层须为 JSON 对象";
        return;
      }
      this.saving = { ...this.saving, json: true };
      try {
        const updated = await this.api("PUT", "/settings", obj);
        this.syncAllFromSettings(updated);
        this.jsonSavedAt = new Date().toLocaleTimeString();
        await this.refresh();
        this.toast("settings.json 已保存并同步至界面表单", "ok");
      } catch (err) {
        this.jsonError = err.message;
        this.toast("JSON 保存失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, json: false };
      }
    },

    /* ── 配置文件只读查看 ── */
    async loadConfigs() {
      if (this.configFiles.length) return;
      try {
        const r = await this.api("GET", "/config/files");
        this.configFiles = r.files || [];
      } catch (err) {
        this.configFiles = [];
      }
    },
    async loadConfigFile(key) {
      this.saving = { ...this.saving, cfg: true };
      try {
        const r = await this.api("GET", `/config/files/${encodeURIComponent(key)}`);
        this.configView = key;
        this.configContent = r.content ?? "（空文件）";
      } catch (err) {
        this.configView = key;
        this.configContent = "读取失败: " + err.message;
      } finally {
        this.saving = { ...this.saving, cfg: false };
      }
    },

    /* ── 改写规则（精简主行 + 行内手风琴展开） ── */
    isPresetActive(kind) {
      const target = kind === "focus" ? DEFAULT_REWRITES : DEFAULT_REWRITES.filter(r => r.group === "base");
      return stableRulesKey(this.rules) === stableRulesKey(target);
    },
    rulesDirty() {
      return stableRulesKey(this.rules) !== this.savedRulesJson;
    },
    toggleRule(i) {
      const next = !this.expandedRules[i];
      this.expandedRules = { ...this.expandedRules, [i]: next };
      if (next && this.ruleSetDrafts[i] === undefined) {
        this.ruleSetDrafts = { ...this.ruleSetDrafts, [i]: JSON.stringify(this.rules[i].set || {}, null, 2) };
      }
    },
    applyPreset(kind) {
      this.rules = JSON.parse(JSON.stringify(kind === "focus" ? DEFAULT_REWRITES : DEFAULT_REWRITES.filter(r => r.group === "base")));
      this.expandedRules = {};
      this.ruleSetDrafts = {};
      this.ruleSetErrors = {};
      this.rulesError = "";
    },
    addRule() {
      this.rules.push({ match: "", action: "rewrite", set: {}, remove: [], group: "", note: "" });
      const idx = this.rules.length - 1;
      this.expandedRules = { ...this.expandedRules, [idx]: true };
      this.ruleSetDrafts = { ...this.ruleSetDrafts, [idx]: "{}" };
      this.$nextTick(() => {
        const el = document.querySelector(`.rules-table tbody:nth-of-type(${idx + 1}) input`);
        if (el) el.focus();
      });
    },
    delRule(i) {
      this.rules.splice(i, 1);
      this.expandedRules = {};
      this.ruleSetDrafts = {};
      this.ruleSetErrors = {};
      this.rulesError = "";
    },
    moveRule(i, delta) {
      const j = i + delta;
      if (j < 0 || j >= this.rules.length) return;
      const arr = [...this.rules];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      this.rules = arr;
      this.expandedRules = { [j]: !!this.expandedRules[i] };
      this.ruleSetDrafts = {};
      this.ruleSetErrors = {};
    },
    async resetRules() {
      try {
        const cur = await this.api("GET", "/settings");
        this.rules = JSON.parse(JSON.stringify(cur.rewrites || []));
        this.savedRulesJson = stableRulesKey(this.rules);
        this.expandedRules = {};
        this.ruleSetDrafts = {};
        this.ruleSetErrors = {};
        this.rulesError = "";
      } catch (err) {
        this.rulesError = err.message;
      }
    },
    ruleSetText(i) {
      if (this.ruleSetDrafts[i] !== undefined) return this.ruleSetDrafts[i];
      try { return JSON.stringify(this.rules[i]?.set || {}, null, 2); } catch (err) { return "{}"; }
    },
    onRuleSetText(i, text) {
      this.ruleSetDrafts = { ...this.ruleSetDrafts, [i]: text };
      try {
        const v = JSON.parse((text || "").trim() || "{}");
        if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error("须为 JSON 对象");
        this.rules[i].set = v;
        const next = { ...this.ruleSetErrors };
        delete next[i];
        this.ruleSetErrors = next;
        this.rulesError = "";
      } catch (err) {
        this.ruleSetErrors = { ...this.ruleSetErrors, [i]: err.message };
        this.rulesError = `第 ${i + 1} 条 set JSON 无效：${err.message}`;
      }
    },
    formatRuleSet(i) {
      if (this.ruleSetErrors[i]) return;
      try {
        const formatted = JSON.stringify(this.rules[i]?.set || {}, null, 2);
        this.ruleSetDrafts = { ...this.ruleSetDrafts, [i]: formatted };
      } catch (err) {}
    },
    ruleSummary(r) {
      if (!r) return "";
      const parts = [];
      if (r.action === "fake") {
        parts.push('<span class="rs-tok warn">拦截 · 返回伪成功</span>');
      } else {
        const setObj = r.set || {};
        for (const k of Object.keys(setObj)) {
          const raw = setObj[k];
          let vcls = "v-s";
          let val = "";
          if (typeof raw === "boolean") { vcls = "v-b"; val = String(raw); }
          else if (typeof raw === "number") { vcls = "v-n"; val = String(raw); }
          else if (raw === null) { vcls = "v-b"; val = "null"; }
          else { val = typeof raw === "object" ? JSON.stringify(raw) : `"${raw}"`; }
          parts.push(`<span class="rs-tok"><span class="k">${esc(k)}</span><span class="eq">=</span><span class="${vcls}">${esc(val)}</span></span>`);
        }
        for (const p of (r.remove || [])) {
          parts.push(`<span class="rs-tok rm">− ${esc(p)}</span>`);
        }
      }
      if (r.note) parts.push(`<span class="sum-note">${esc(r.note)}</span>`);
      else if (!parts.length) parts.push('<span class="sum-note">点击展开编辑参数…</span>');
      return parts.join("");
    },
    async saveRules() {
      this.rulesError = "";
      if (Object.keys(this.ruleSetErrors).length) {
        this.rulesError = "请先修正标红行的 set JSON 格式";
        return;
      }
      const payload = [];
      for (const r of this.rules) {
        if (!r.match || !r.match.trim()) {
          this.rulesError = "存在空的 match 方法名";
          return;
        }
        payload.push({
          match: r.match.trim(),
          action: r.action || "rewrite",
          set: r.set || {},
          remove: r.remove || [],
          group: (r.group || "").trim(),
          note: (r.note || "").trim(),
        });
      }
      this.saving = { ...this.saving, rules: true };
      try {
        const updated = await this.api("PUT", "/settings", { rewrites: payload });
        this.syncAllFromSettings(updated);
        this.rulesSavedAt = new Date().toLocaleTimeString();
        this.toast("改写规则已保存并生效", "ok");
      } catch (err) {
        this.rulesError = err.message;
        this.toast("保存规则失败：" + err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, rules: false };
      }
    },

    /* ── 会话操作与基座控制 ── */
    async release(name) {
      const ok = await this.askConfirm({
        title: `释放会话「${name}」？`,
        body: "将关闭该会话名下归属的标签页并摘除连接会话。",
        confirmText: "释放会话",
        danger: true,
      });
      if (!ok) return;
      this.actionKey = "release";
      try {
        await this.api("POST", `/sessions/${encodeURIComponent(name)}/release`, {});
        await this.refresh();
        this.toast(`会话 ${name} 已释放`, "ok");
      } catch (err) {
        this.toast("释放失败：" + err.message, "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    async restartKeeper() {
      const ok = await this.askConfirm({
        title: "重启基座 Chrome？",
        body: "standalone 源的所有会话将短暂断开，extension 源会话不受影响。",
        confirmText: "重启基座",
      });
      if (!ok) return;
      this.actionKey = "restartKeeper";
      try {
        await this.api("POST", "/keeper/restart", {});
        await this.refresh();
        this.toast("基座 Chrome 已重启", "ok");
      } catch (err) {
        this.toast("重启基座失败：" + err.message, "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    /* ── 会话交互日志 ── */
    async loadSessionLogs(name, opts = {}) {
      if (!opts.silent) this.loadingSessLogs = true;
      this.sessLogsError = "";
      try {
        const data = await this.api("GET", `/sessions/${encodeURIComponent(name)}/logs?limit=200`);
        if (this.selSessionName === name) {
          this.sessionLogs = data.entries || [];
          if (this.selLog >= this.sessionLogs.length) this.selLog = -1;
        }
      } catch (err) {
        if (this.selSessionName === name) {
          this.sessionLogs = [];
          this.sessLogsError = err.message;
        }
      } finally {
        this.loadingSessLogs = false;
      }
    },

    fmtFullTime(ts) {
      if (!ts) return "";
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
    },
    fmtRelTime(ts) {
      if (!ts) return "";
      const diff = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
      if (Number.isNaN(diff)) return "";
      if (diff < 5) return "刚刚";
      if (diff < 60) return `${diff}s 前`;
      const m = Math.floor(diff / 60);
      if (m < 60) return `${m}m 前`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h 前`;
      return `${Math.floor(h / 24)}d 前`;
    },
    fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : ""; },

    logSummary(e) {
      const src = e.in !== undefined ? e.in : null;
      const chips = [];
      if (src && typeof src === "object" && !Array.isArray(src)) {
        for (const k of Object.keys(src).slice(0, 4)) {
          let v = src[k];
          if (v === null) v = "null";
          else if (typeof v === "object") v = Array.isArray(v) ? `[${v.length} 项]` : "{…}";
          v = String(v);
          if (v.length > 40) v = v.slice(0, 40) + "…";
          chips.push(`<span class="kvp"><b>${esc(k)}</b>=${esc(v)}</span>`);
        }
        const more = Object.keys(src).length - 4;
        if (more > 0) chips.push(`<span class="kvp">+${more}</span>`);
        if (chips.length) return chips.join("");
      }
      if (e.delta) return esc(e.delta);
      if (e.detail) return esc(e.detail);
      return "";
    },
    pretty(v) {
      if (v === undefined || v === null) return "";
      try { return JSON.stringify(v, null, 2); } catch (err) { return String(v); }
    },

    /* ── 服务日志（最新在顶；自动跟随最新 + 触底加载更早） ── */
    filteredSlog() {
      let rows = this.slogParsed;
      if (this.slogLevel !== "all") rows = rows.filter(e => e.level === this.slogLevel);
      if (this.slogSrc !== "all") rows = rows.filter(e => (e.rest || "").includes(this.slogSrc) || (e.msg || "").includes(this.slogSrc));
      const q = (this.slogQuery || "").trim().toLowerCase();
      if (q) rows = rows.filter(e => (e.msg || "").toLowerCase().includes(q) || (e.rest || "").toLowerCase().includes(q));
      return rows;
    },

    bindLogSentinel() {
      const sentinel = document.getElementById("slogSentinel");
      const root = document.getElementById("slogScroll");
      if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
      this._logIO = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting) && this.tab === "logs") {
          this.loadOlderLogs();
        }
      }, { root, rootMargin: "200px" });
      this._logIO.observe(sentinel);
    },

    toggleAutoFollow() {
      clearInterval(this._logFollowT);
      if (this.slogAutoFollow) {
        this.loadLogs({ silent: true });
        this.$nextTick(() => this.scrollSlogTop());
        this._logFollowT = setInterval(() => {
          if (this.tab === "logs" && this.slogAutoFollow) this.loadLogs({ silent: true });
        }, 2500);
      }
    },

    clearSlogView() {
      this.slogParsed = [];
      this.slogTotal = 0;
      this.slogHasMore = false;
      this.slogCleared = true;
    },

    async loadLogs(opts = {}) {
      if (!opts.silent) this.loadingSlogs = true;
      this.slogCleared = false;
      try {
        const data = await this.api("GET", "/logs/tail?n=200&skip=0");
        this.slogTotal = data.total || 0;
        this.slogHasMore = !!data.hasMore;
        this.slogSkip = 0;
        this.slogParsed = (data.lines || []).map(parseSlogLine).filter(Boolean).reverse();
        if (this.slogAutoFollow) this.$nextTick(() => this.scrollSlogTop());
      } catch (err) {
        if (!opts.silent) this.slogParsed = [];
      } finally {
        this.loadingSlogs = false;
      }
    },

    scrollSlogTop() {
      const el = document.getElementById("slogScroll");
      if (el) el.scrollTop = 0;
    },

    async loadOlderLogs() {
      if (this.slogLoadingOlder || !this.slogHasMore) return;
      this.slogLoadingOlder = true;
      try {
        const skip = this.slogSkip + 200;
        const data = await this.api("GET", "/logs/tail?n=200&skip=" + skip);
        this.slogSkip = skip;
        if (data.total) this.slogTotal = data.total;
        this.slogHasMore = !!data.hasMore;
        const older = (data.lines || []).map(parseSlogLine).filter(Boolean).reverse();
        this.slogParsed = this.slogParsed.concat(older);
      } catch (err) {
      } finally {
        this.slogLoadingOlder = false;
      }
    },

    async shutdown() {
      const ok = await this.askConfirm({
        title: "停止代理服务？",
        body: "将关闭控制面与代理引擎，正在运行的基座 Chrome 不受影响。",
        confirmText: "停止服务",
        danger: true,
      });
      if (!ok) return;
      this.actionKey = "shutdown";
      try {
        await this.api("POST", "/shutdown", {});
        this.healthy = false;
        this.toast("服务已停止", "info");
      } catch (err) {
        this.healthy = false;
      } finally {
        this.actionKey = "";
      }
    },
  };
}
