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

/* ── 国际化辅助（字典见 static/admin/i18n.js）── */
function tr(lang, key, params) {
  return window.CDPROXY_I18N ? window.CDPROXY_I18N.t(lang, key, params) : key;
}

function defaultRewrites(lang) {
  const L = lang || "zh";
  return [
    { match: "Target.createTarget", action: "rewrite", set: { background: true }, remove: [], group: "focus", note: tr(L, "rules.note_create_target") },
    { match: "Target.activateTarget", action: "fake", set: {}, remove: [], group: "focus", note: tr(L, "rules.note_activate_target") },
    { match: "Page.bringToFront", action: "fake", set: {}, remove: [], group: "focus", note: tr(L, "rules.note_bring_to_front") },
    { match: "Browser.setWindowBounds", action: "rewrite", set: {}, remove: ["bounds.focused"], group: "focus", note: tr(L, "rules.note_window_bounds") },
    { match: "Emulation.setFocusEmulationEnabled", action: "rewrite", set: {}, remove: [], group: "focus", note: tr(L, "rules.note_focus_emulation") },
    { match: "Browser.close", action: "fake", set: {}, remove: [], group: "base", note: tr(L, "rules.note_browser_close") },
  ];
}

/* ── JSON 树查看器（无依赖，<details> 原生折叠）── */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function jsonTree(value, key, depth, lang) {
  const k = key !== null ? `<span class="k">"${esc(key)}"</span>: ` : "";
  if (value === null) return `${k}<span class="u">null</span>`;
  if (typeof value === "string") return `${k}<span class="s">"${esc(value)}"</span>`;
  if (typeof value === "number") return `${k}<span class="n">${value}</span>`;
  if (typeof value === "boolean") return `${k}<span class="b">${value}</span>`;
  const isOpen = depth < 1 ? " open" : "";
  if (Array.isArray(value)) {
    if (!value.length) return `${k}<span class="br">[]</span>`;
    const items = value.map((v) => `<div>${jsonTree(v, null, depth + 1, lang)}</div>`).join("");
    return `${k}<details${isOpen}><summary><span class="br">[</span> ${esc(tr(lang, "common.items_count", { n: value.length }))} <span class="br">]</span></summary>${items}</details>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return `${k}<span class="br">{}</span>`;
    const items = keys.map((kk) => `<div>${jsonTree(value[kk], kk, depth + 1, lang)}</div>`).join("");
    return `${k}<details${isOpen}><summary><span class="br">{</span> ${esc(tr(lang, "common.keys_count", { n: keys.length }))} <span class="br">}</span></summary>${items}</details>`;
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

function stablePresetKey(list) {
  try {
    return JSON.stringify((list || []).map(r => ({
      match: r.match || "",
      action: r.action || "rewrite",
      set: r.set || {},
      remove: r.remove || [],
      group: r.group || "",
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
    lang: window.CDPROXY_I18N ? window.CDPROXY_I18N.detect() : "zh",
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
    extGroupPrefix: "cdproxy:",
    savedExtGroupPrefix: "cdproxy:",
    extSetupOpen: null, // null=自动（未连接时展开，已连接时收起）
    detectingExt: false,
    abIntBusy: false,
    connectModal: null,
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
    _updateEvent: null,
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
    extExportedInfo: null,

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
    ddSaved: false,
    ddError: "",

    t(key, params) {
      return tr(this.lang, key, params);
    },
    layoutDesc(entry) {
      return window.CDPROXY_I18N ? window.CDPROXY_I18N.translateLayoutDesc(this.lang, entry) : (entry?.desc || "");
    },
    configFileTitle(file) {
      return window.CDPROXY_I18N ? window.CDPROXY_I18N.translateConfigTitle(this.lang, file) : (file?.title || "");
    },
    displayRuleNote(note) {
      return window.CDPROXY_I18N ? window.CDPROXY_I18N.translateRuleNote(this.lang, note) : (note || "");
    },
    applyLang(next, opts = {}) {
      const persist = opts.persist !== false;
      const norm = window.CDPROXY_I18N
        ? (persist ? window.CDPROXY_I18N.save(next) : window.CDPROXY_I18N.normalize(next))
        : (next === "en" ? "en" : "zh");
      this.lang = norm;
      if (document.documentElement) {
        document.documentElement.lang = norm === "zh" ? "zh-CN" : "en";
      }
      if (window.__cdpWails && window.__cdpWails.setLanguage) {
        try { window.__cdpWails.setLanguage(norm); } catch (e) {}
      }
      this.refreshGridLocale();
      this.refreshUpdaterMsg();
    },
    toggleLang() {
      this.applyLang(this.lang === "zh" ? "en" : "zh", { persist: true });
    },

    async init() {
      if (window.innerWidth <= 960) this.sideCollapsed = true;
      const saved = localStorage.getItem("abp_theme") || "dark";
      this.applyTheme(saved);
      this.applyLang(this.lang, { persist: false });

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
    askConfirm({ title, body, confirmText, cancelText, danger = false }) {
      return new Promise((resolve) => {
        this._confirmResolver = resolve;
        this.confirmDlg = {
          title,
          body,
          confirmText: confirmText || this.t("common.confirm"),
          cancelText: cancelText || this.t("common.cancel"),
          danger,
        };
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
      const map = {
        overview: "nav.overview",
        sessions: "nav.sessions",
        rules: "nav.rules",
        sources: "nav.sources",
        settings: "nav.settings",
        logs: "nav.logs",
        about: "nav.about",
      };
      return map[this.tab] ? this.t(map[this.tab]) : "";
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
        this.toast(this.t("toast.default_src_set", { src }), "ok");
      } catch (err) {
        this.toast(this.t("toast.default_src_fail", { err: err.message }), "err", 4000);
      } finally {
        this.saving = { ...this.saving, routing: false };
      }
    },

    getWebAdminToken() {
      try {
        const hash = String(window.location.hash || "");
        const m = hash.match(/token=([^&]+)/);
        if (m && m[1]) {
          const tok = decodeURIComponent(m[1]).trim();
          if (tok) {
            sessionStorage.setItem("cdproxy_admin_token", tok);
            try { history.replaceState(null, "", window.location.pathname + window.location.search); } catch (e) {}
            return tok;
          }
        }
        return sessionStorage.getItem("cdproxy_admin_token") || "";
      } catch (e) {
        return "";
      }
    },

    async api(method, path, body) {
      if (window.__cdpWails) {
        const r = await window.__cdpWails.doRequest(method, path, body === undefined ? "" : JSON.stringify(body));
        const data = r.body ? JSON.parse(r.body) : {};
        if (r.status >= 400) throw new Error(data.error || `${method} ${path} → ${r.status}`);
        return data;
      }
      const doFetch = async (tok) => {
        const headers = body !== undefined ? { "Content-Type": "application/json" } : {};
        if (tok) headers["Authorization"] = `Bearer ${tok}`;
        return fetch(path, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      };
      let tok = this.getWebAdminToken();
      let resp = await doFetch(tok);
      if (resp.status === 401 && !this._authPrompting) {
        this._authPrompting = true;
        try {
          const entered = window.prompt(this.t("web.auth_prompt"), tok || "");
          if (entered && entered.trim()) {
            tok = entered.trim();
            try { sessionStorage.setItem("cdproxy_admin_token", tok); } catch (e) {}
            resp = await doFetch(tok);
          }
        } finally {
          this._authPrompting = false;
        }
      }
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
        const gp = (snap.sources?.extension?.group_prefix || snap.settings?.sources?.group_prefix || "cdproxy:").trim() || "cdproxy:";
        this.extGroupPrefix = gp;
        this.savedExtGroupPrefix = gp;
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
        this.toast(this.t("toast.engine_started"), "ok");
      } catch (err) {
        this.toast(this.t("toast.engine_start_fail", { err: err.message || err }), "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    /* ── 边栏状态 ── */
    keeperIdleText() {
      if (!this.status) return "";
      if (!this.status.keeper.alive) return this.t("keeper.not_running");
      const s = this.status.settings.keeper_idle_shutdown_seconds;
      return s === 0 ? this.t("keeper.no_shutdown") : `≤ ${s}s`;
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

    _formatUpdaterMsg(kind, data) {
      if (kind === "update-available" && data) {
        return this.t("upd.available", { ver: data.version || "?" });
      }
      if (kind === "no-update") {
        return this.t("upd.up_to_date");
      }
      if (kind === "download-started") {
        return this.t("upd.download_started");
      }
      if (kind === "download-progress" && data) {
        if (!data.total) return this.t("upd.download_started");
        const pct = Math.min(100, Math.round((data.written / data.total) * 100));
        return this.t("upd.downloading", { pct });
      }
      if (kind === "verifying") {
        return this.t("upd.verifying");
      }
      if (kind === "installing") {
        return this.t("upd.installing");
      }
      if (kind === "update-ready") {
        return this.t("upd.ready");
      }
      if (kind === "error" && data) {
        return this.t("upd.error", { err: data.message || data.stage || this.t("upd.unknown") });
      }
      return "";
    },

    refreshUpdaterMsg() {
      const ev = this._updateEvent;
      if (!ev || !this.updateMsg) return;
      const msg = this._formatUpdaterMsg(ev.kind, ev.data);
      if (msg) this.updateMsg = msg;
    },

    bindUpdaterEvents() {
      document.addEventListener("cdp-updater", (ev) => {
        const { type, data } = ev.detail || {};
        if (type === "runtime-ready") { this.canUpdate = true; return; }
        if (!type || !type.startsWith("wails:updater:")) return;
        this.canUpdate = true;
        const kind = type.split(":").pop();
        const msg = this._formatUpdaterMsg(kind, data);
        if (!msg) return;
        this._updateEvent = { kind, data };
        this.updateMsg = msg;
        if (kind === "no-update") {
          this.updateKind = "ok";
          setTimeout(() => { if (this.updateKind === "ok") { this.updateMsg = ""; this._updateEvent = null; } }, 4000);
        } else if (kind === "update-available") {
          this.updateKind = "available";
        } else if (kind === "update-ready") {
          this.updateKind = "ready";
        } else if (kind === "error") {
          this.updateKind = "err";
        } else {
          this.updateKind = "info";
        }
      });
    },

    async checkUpdate() {
      if (!window.__cdpWails || !window.__cdpWails.checkForUpdate) {
        this.toast(this.t("toast.web_no_updater"), "info", 3500);
        return;
      }
      this.updateBusy = true;
      try {
        await window.__cdpWails.checkForUpdate();
      } catch (err) {
        const raw = err?.message || String(err);
        const msg = this.t("upd.error", { err: raw });
        this._updateEvent = { kind: "error", data: { message: raw } };
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
        if (!opts.silent) this.toast(this.t("toast.versions_fail", { err: err.message }), "err", 3500);
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
          this.toast(this.t("toast.ab_new_ver", { ver: this.abLatest.latest_version }), "info", 3200);
        } else {
          this.toast(this.t("toast.ab_latest", { ver: this.abLatest.latest_version }), "ok", 2600);
        }
      } catch (err) {
        this.abUpgradeErr = err.message;
        this.toast(this.t("toast.ab_check_fail", { err: err.message }), "err", 4000);
      } finally {
        this.checkingAbLatest = false;
      }
    },
    async upgradeAgentBrowser(ver = "") {
      const target = ver || this.abLatest?.latest_version || "";
      const ok = await this.askConfirm({
        title: target ? this.t("confirm.ab_upgrade_title", { ver: target }) : this.t("confirm.ab_upgrade_latest_title"),
        body: this.t("confirm.ab_upgrade_body"),
        confirmText: this.t("confirm.ab_upgrade_btn"),
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
        this.toast(this.t("toast.ab_upgraded", { ver: res.version }), "ok", 3200);
      } catch (err) {
        this.abUpgradeErr = err.message;
        this.toast(this.t("toast.ab_upgrade_fail", { err: err.message }), "err", 4500);
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
        this.toast(this.t("toast.ab_restored"), "ok", 2800);
      } catch (err) {
        this.toast(this.t("toast.switch_fail", { err: err.message }), "err", 3500);
      }
    },
    async exportExtension(openAfter = false) {
      this.exportingExt = true;
      this.extExportedInfo = null;
      try {
        const res = await this.api("POST", "/sources/extension/export", {});
        await this.loadVersions({ silent: true });
        this.extExportedInfo = { ver: res.version, path: res.path };
        this.toast(this.t("toast.ext_synced", { ver: res.version }), "ok", 2800);
        if (openAfter && window.__cdpWails && window.__cdpWails.openPath) {
          await window.__cdpWails.openPath(res.path);
        }
      } catch (err) {
        this.toast(this.t("toast.ext_export_fail", { err: err.message }), "err", 4000);
      } finally {
        this.exportingExt = false;
      }
    },
    async reloadExtension() {
      this.reloadingExt = true;
      try {
        await this.api("POST", "/sources/extension/reload", {});
        this.toast(this.t("toast.ext_reloading"), "ok", 2800);
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
          this.toast(this.t("toast.open_dir_fail", { err: err.message || err }), "err", 3500);
        }
      } else {
        this.copyText(p, this.t("toast.path_copied_web"), "ext-dir");
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
      this.toast(this.t("toast.ext_zip_embedded_only"), "info", 3600);
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

    gridColumns() {
      return [
        {
          title: this.t("sess.col_name"), field: "name", headerSort: false, formatter: "plaintext",
          cssClass: "mono", widthGrow: 3, minWidth: 140, maxWidth: 420,
        },
        {
          title: this.t("sess.col_type"), field: "type", headerSort: false, width: 128, minWidth: 114,
          formatter: (cell) => {
            const t = cell.getValue() || "";
            if (!t) return '<span class="hint">—</span>';
            const isExt = t === "extension";
            const ic = isExt ? "#i-puzzle" : "#i-chrome";
            return `<span class="bdg with-ic ${isExt ? "ext" : "sa"}"><svg class="ic-xs"><use href="${ic}"/></svg><span>${esc(t)}</span></span>`;
          },
        },
        {
          title: this.t("sess.col_state"), field: "state", headerSort: false, width: 114, minWidth: 102,
          formatter: (cell) => {
            const v = cell.getValue() || "";
            const cls = v === "connected" ? "ok" : (v === "idle" ? "idle" : "warn");
            const lbl = v === "connected"
              ? this.t("common.state_connected")
              : (v === "idle" ? this.t("common.state_idle") : this.t("common.state_released"));
            return `<span class="bdg ${cls}">${esc(lbl)}</span>`;
          },
        },
        {
          title: this.t("sess.col_tabs"), field: "targets", headerSort: false, width: 64, minWidth: 52,
          formatter: (cell) => `<span class="bdg plain">${cell.getValue() ?? 0}</span>`,
        },
        {
          title: this.t("sess.col_group"), field: "group_name", headerSort: false, cssClass: "mono sg-col",
          widthGrow: 1, minWidth: 100, maxWidth: 260,
          formatter: (cell) => esc(cell.getValue() || "—"),
        },
        {
          title: this.t("sess.col_via"), field: "via", headerSort: false, cssClass: "mono sg-col",
          width: 108, minWidth: 82,
          formatter: (cell) => esc(cell.getValue() || "—"),
        },
        {
          title: this.t("sess.col_last_ts"), field: "last_ts", headerSort: false, width: 104, minWidth: 86,
          cssClass: "mono sg-col",
          formatter: (cell) => {
            const v = cell.getValue();
            if (!v) return '<span class="hint">—</span>';
            return `<span title="${esc(this.fmtFullTime(v))}">${esc(this.fmtRelTime(v))}</span>`;
          },
        },
      ];
    },

    refreshGridLocale() {
      if (!this.sessGrid || !this.sessGrid.initialized) return;
      const holder = document.querySelector("#sessions-grid");
      if (!holder || holder.offsetParent === null) {
        // 隐藏态调用 Tabulator.setColumns 会导致行高/可见区坍缩，延迟到切回会话页再刷新列定义
        this._gridLocaleDirty = true;
        return;
      }
      this._gridLocaleDirty = false;
      try {
        this.sessGrid.setColumns(this.gridColumns());
        if (this._applyGridCols) this._applyGridCols(holder.clientWidth);
        this.sessGrid.replaceData(this.filteredSessions());
        this.sessGrid.redraw(true);
        this.syncGridSelection();
      } catch (e) {}
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
        columns: this.gridColumns(),
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
      if (this._gridLocaleDirty) {
        this._gridLocaleDirty = false;
        try {
          this.sessGrid.setColumns(this.gridColumns());
          if (this._applyGridCols) this._applyGridCols(holder.clientWidth);
        } catch (e) {}
      }
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
      return `ws://127.0.0.1:${this.status.ws_port || this.status.settings.ws_port}/ext`;
    },
    extPairingUrl() {
      const relay = this.extRelayUrl();
      const tok = this.status?.sources?.extension?.token || "";
      if (!relay) return "";
      return tok ? `${relay}?token=${encodeURIComponent(tok)}` : relay;
    },
    chromeExt() {
      return this.status?.chrome_ext || this.versions?.extension?.chrome || null;
    },
    chromeExtState() {
      const ce = this.chromeExt();
      if (ce && ce.state) return ce.state;
      return this.status?.sources?.extension?.connected ? "connected" : "not_installed";
    },
    chromeExtBadgeClass() {
      const st = this.chromeExtState();
      return st === "connected" ? "ok" : "warn";
    },
    chromeExtBadgeText() {
      const st = this.chromeExtState();
      return this.t("ext.state_" + st);
    },
    chromeExtWhere() {
      const list = this.chromeExt()?.installations || [];
      if (!list.length) return "Chrome";
      const first = list[0];
      const prof = first.profile_name && first.profile_name !== first.profile
        ? `${first.profile_name} (${first.profile})`
        : first.profile;
      return `${first.browser} · ${prof}`;
    },
    chromeExtDetailHint() {
      const ce = this.chromeExt();
      const st = this.chromeExtState();
      const where = this.chromeExtWhere();
      if (st === "connected") {
        const ver = ce?.connected_version || this.status?.sources?.extension?.version || ce?.bundled_version || "";
        return this.t("ext.detect_ok_hint", { where, ver });
      }
      if (st === "outdated") {
        return this.t("ext.detect_outdated_hint", { cur: ce?.connected_version || "?", bundled: ce?.bundled_version || "?" });
      }
      if (st === "disabled") {
        return this.t("ext.detect_disabled_hint", { where });
      }
      if (st === "installed_offline") {
        return this.t("ext.detect_offline_hint", { where });
      }
      return this.t("ext.detect_none");
    },
    isExtSetupExpanded() {
      if (this.extSetupOpen !== null) return this.extSetupOpen;
      return !this.status?.sources?.extension?.connected;
    },
    toggleExtSetup() {
      this.extSetupOpen = !this.isExtSetupExpanded();
    },
    goExtensionSetup() {
      this.extSetupOpen = true;
      this.go("sources");
      this.$nextTick(() => {
        const el = document.getElementById("ext-source-card");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    },
    async detectChromeExt() {
      if (this.detectingExt) return;
      this.detectingExt = true;
      try {
        const res = await this.api("GET", "/sources/extension/detect");
        if (this.status) this.status = { ...this.status, chrome_ext: res };
        this.toast(this.t("toast.detect_done"), "ok", 2200);
      } catch (err) {
        this.toast(err.message, "err", 3500);
      } finally {
        this.detectingExt = false;
      }
    },
    async saveExtGroupPrefix() {
      if (this.saving.extPrefix) return;
      const val = (this.extGroupPrefix || "").trim() || "cdproxy:";
      this.saving = { ...this.saving, extPrefix: true };
      try {
        await this.api("PUT", "/settings", { sources: { group_prefix: val } });
        this.extGroupPrefix = val;
        this.savedExtGroupPrefix = val;
        await this.refresh();
        this.toast(this.t("toast.prefix_saved"), "ok", 2500);
      } catch (err) {
        this.toast(err.message, "err", 4000);
      } finally {
        this.saving = { ...this.saving, extPrefix: false };
      }
    },
    async copyChromeExtensionsAndOpen() {
      await this.copyText("chrome://extensions", this.t("toast.chrome_url_copied"), "chrome-ext-url");
      if (window.__cdpWails && window.__cdpWails.openChrome) {
        try { await window.__cdpWails.openChrome(); } catch (_) {}
      }
    },
    async openExportedExtensionDir() {
      let dir = this.chromeExt()?.export_dir || this.versions?.extension?.export_dir || "";
      if (!dir || !this.chromeExt()?.exported) {
        await this.exportExtension(this.isDesktop);
        return;
      }
      await this.openLocalPath(dir);
    },
    abIntegration() {
      return this.status?.agent_browser_integration || null;
    },
    abIntBadgeClass() {
      const st = this.abIntegration()?.status || "not_found";
      if (st === "configured") return "ok";
      if (st === "invalid_json") return "bad";
      if (st === "outdated" || st === "other_provider") return "warn";
      return "idle";
    },
    abIntStatusText() {
      const st = this.abIntegration()?.status || "not_found";
      return this.t("abint.st_" + st);
    },
    abIntActionLabel() {
      const st = this.abIntegration()?.status || "not_found";
      if (st === "outdated") return this.t("abint.btn_update");
      if (st === "other_provider") return this.t("abint.btn_set_default");
      return this.t("abint.btn_install");
    },
    abIntDetailText() {
      const info = this.abIntegration();
      if (!info) return "";
      switch (info.status) {
        case "configured":
          return this.t("abint.detail_configured", { cmd: info.current_command || info.target_command });
        case "outdated":
          return this.t("abint.detail_outdated", { cmd: info.current_command || "—" });
        case "other_provider":
          return this.t("abint.detail_other", { prov: info.current_provider || "—" });
        case "not_configured":
          return this.t("abint.detail_not_configured");
        case "invalid_json":
          return this.t("abint.detail_invalid", { err: info.error || "" });
        default:
          return this.t("abint.detail_not_found");
      }
    },
    async redetectAbIntegration() {
      if (this.abIntBusy) return;
      this.abIntBusy = true;
      try {
        const res = await this.api("GET", "/integrations/agent-browser");
        if (this.status) this.status = { ...this.status, agent_browser_integration: res };
        this.toast(this.t("abint.toast_redetected"), "ok", 2200);
      } catch (err) {
        this.toast(err.message, "err", 3500);
      } finally {
        this.abIntBusy = false;
      }
    },
    async installAbIntegration() {
      const info = this.abIntegration();
      if (!info || this.abIntBusy) return;
      const ok = await this.askConfirm({
        title: this.t("abint.confirm_install_title"),
        body: this.t("abint.confirm_install_body", { path: info.config_path }),
        confirmText: this.t("abint.confirm_install_btn"),
      });
      if (!ok) return;
      this.abIntBusy = true;
      try {
        const r = await this.api("POST", "/integrations/agent-browser/install", {});
        if (this.status && r.integration) this.status = { ...this.status, agent_browser_integration: r.integration };
        await this.refresh();
        this.toast(r.backup_path ? this.t("abint.toast_installed") : this.t("abint.toast_installed_new"), "ok", 3200);
      } catch (err) {
        this.toast(err.message, "err", 4500);
      } finally {
        this.abIntBusy = false;
      }
    },
    async uninstallAbIntegration() {
      const info = this.abIntegration();
      if (!info || this.abIntBusy) return;
      const ok = await this.askConfirm({
        title: this.t("abint.confirm_uninstall_title"),
        body: this.t("abint.confirm_uninstall_body", { path: info.config_path }),
        confirmText: this.t("abint.btn_uninstall"),
        danger: true,
      });
      if (!ok) return;
      this.abIntBusy = true;
      try {
        const r = await this.api("POST", "/integrations/agent-browser/uninstall", {});
        if (this.status && r.integration) this.status = { ...this.status, agent_browser_integration: r.integration };
        await this.refresh();
        this.toast(this.t("abint.toast_uninstalled"), "ok", 3000);
      } catch (err) {
        this.toast(err.message, "err", 4000);
      } finally {
        this.abIntBusy = false;
      }
    },
    async restoreAbBackup(bak) {
      const info = this.abIntegration();
      if (!info || !bak || this.abIntBusy) return;
      const ok = await this.askConfirm({
        title: this.t("abint.confirm_restore_title"),
        body: this.t("abint.confirm_restore_body", { bak, path: info.config_path }),
        confirmText: this.t("common.restore"),
        danger: true,
      });
      if (!ok) return;
      this.abIntBusy = true;
      try {
        const r = await this.api("POST", "/integrations/agent-browser/restore", { backup: bak });
        if (this.status && r.integration) this.status = { ...this.status, agent_browser_integration: r.integration };
        await this.refresh();
        this.toast(this.t("abint.toast_restored", { bak }), "ok", 3000);
      } catch (err) {
        this.toast(err.message, "err", 4000);
      } finally {
        this.abIntBusy = false;
      }
    },
    abSourceText(src) {
      const map = {
        bundled: "ab.src_bundled",
        setting: "ab.src_setting",
        path: "ab.src_path",
        none: "ab.src_none",
      };
      return map[src] ? this.t(map[src]) : src;
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
        this.toast(this.t("toast.keep_one_source"), "err");
        await this.refresh();
        return;
      }
      this.saving = { ...this.saving, source: true };
      try {
        await this.api("PUT", "/settings", {
          sources: { [kind === "standalone" ? "standalone_enabled" : "extension_enabled"]: enable },
        });
        await this.refresh();
        this.toast(this.t(enable ? "toast.source_enabled" : "toast.source_disabled", { kind }), "ok");
      } catch (err) {
        this.toast(this.t("toast.switch_fail", { err: err.message }), "err", 4000);
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
        this.toast(tip || this.t("common.copied_default"), "ok", 2000);
      } catch (err) {
        this.toast(this.t("common.copy_failed", { err: err.message || this.t("common.clipboard_unavailable") }), "err", 3500);
      }
    },

    isBuiltinEndpoint(ep) {
      return ep && (ep.path === "default" || ep.path === "standalone" || ep.path === "extension");
    },
    endpointDisplayLabel(ep) {
      if (!ep) return "";
      if (ep.path === "default") return this.t("ep.label_default");
      return ep.path || "";
    },
    endpointTargetHint(ep) {
      if (!ep) return "";
      const defSrc = this.status?.routing?.default_source || "standalone";
      const sess = (ep.session || "").trim();
      if (ep.path === "default") {
        return sess ? `→ ${defSrc} / ${sess}` : `→ ${defSrc}`;
      }
      if (ep.path === "standalone" || ep.path === "extension") {
        return sess ? `→ ${sess}` : this.t("ep.auto_session_short");
      }
      const name = sess || ep.path;
      return ep.source ? `→ ${name}` : `→ ${name} (${defSrc})`;
    },
    endpointURL(ep, proto = "http") {
      const port = this.status?.ws_port || 9225;
      const base = `${proto}://127.0.0.1:${port}`;
      const tok = ep.token || "";
      const sess = (ep.session || "").trim();
      if (ep.path === "default") {
        return sess ? `${base}/session/${encodeURIComponent(sess)}/${tok}` : `${base}/${tok}`;
      }
      if (ep.path === "standalone" || ep.path === "extension") {
        return sess ? `${base}/${ep.path}/session/${encodeURIComponent(sess)}/${tok}` : `${base}/${ep.path}/${tok}`;
      }
      const srcPrefix = ep.source ? `/${ep.source}` : "";
      const fixed = sess || ep.path || "";
      return `${base}${srcPrefix}/session/${encodeURIComponent(fixed)}/${tok}`;
    },
    copyEndpoint(ep, idx, proto = "http") {
      if (!ep.path || !ep.token) {
        this.toast(this.t("toast.save_ep_first"), "err");
        return;
      }
      this.copyText(this.endpointURL(ep, proto), this.t("toast.ep_url_copied", { path: ep.path }), `ep-url-${idx}`);
    },
    endpointMaskedURL(ep, proto = "http") {
      const port = this.status?.ws_port || 9225;
      const base = `${proto}://127.0.0.1:${port}`;
      const tokMask = ep?.token ? `${ep.token.slice(0, 6)}••••` : "<token>";
      const sess = (ep?.session || "").trim();
      if (ep?.path === "default") {
        return sess ? `${base}/session/${encodeURIComponent(sess)}/${tokMask}` : `${base}/${tokMask}`;
      }
      if (ep?.path === "standalone" || ep?.path === "extension") {
        return sess ? `${base}/${ep.path}/session/${encodeURIComponent(sess)}/${tokMask}` : `${base}/${ep.path}/${tokMask}`;
      }
      const srcPrefix = ep?.source ? `/${ep.source}` : "";
      const fixed = sess || ep?.path || "";
      return `${base}${srcPrefix}/session/${encodeURIComponent(fixed)}/${tokMask}`;
    },
    openConnectModal(ep, tab = "ai") {
      if (!ep?.token) {
        this.toast(this.t("toast.save_ep_first"), "err");
        return;
      }
      this.connectModal = { ep: { ...ep }, tab, showToken: false };
    },
    closeConnectModal() {
      this.connectModal = null;
    },
    connectBaseURL(proto = "http") {
      const port = this.status?.ws_port || 9225;
      return `${proto}://127.0.0.1:${port}`;
    },
    connectSnippet(tab) {
      const m = this.connectModal;
      if (!m?.ep) return "";
      const ep = m.ep;
      const httpUrl = this.endpointURL(ep, "http");
      const wsUrl = this.endpointURL(ep, "ws");
      const baseHttp = this.connectBaseURL("http");
      const baseWs = this.connectBaseURL("ws");
      const tok = ep.token || "";
      const defSrc = this.status?.routing?.default_source || "standalone";
      const isZh = this.lang === "zh";
      const pinnedSess = this.isBuiltinEndpoint(ep) ? (ep.session || "").trim() : ((ep.session || ep.path || "").trim());
      const srcLabel = ep.path === "default"
        ? (isZh ? `默认入口（当前指向 ${defSrc}，可在 cdproxy App 内随时热切换）` : `Default entry (currently routing to ${defSrc}, hot-switchable in cdproxy)`)
        : ep.source === "extension"
          ? (isZh ? "日常 Chrome（Cdproxy Connector 扩展）" : "Everyday Chrome (Cdproxy Connector)")
          : ep.source === "standalone"
            ? (isZh ? "独立托管 Chrome（standalone）" : "Dedicated managed Chrome (standalone)")
            : (isZh ? `跟随默认源（当前 ${defSrc}）` : `Follows default source (currently ${defSrc})`);

      if (tab === "ai") {
        const sessUrl = pinnedSess
          ? httpUrl
          : (ep.path === "default"
            ? `${baseHttp}/session/work/${tok}`
            : `${baseHttp}/${ep.path}/session/work/${tok}`);
        if (isZh) {
          return [
            "请帮我把浏览器自动化工具 / MCP 连接到本机的 cdproxy（标准 Chrome CDP 代理）：",
            "",
            `- 入口：${this.endpointDisplayLabel(ep)} — ${srcLabel}`,
            `- 方式 1（推荐，URL 内含令牌，http:// 与 ws:// 均可直接连接）：`,
            `  ${httpUrl}`,
            `- 方式 2（若工具将地址与鉴权 Header 分开填，令牌会自动路由到对应源）：`,
            `  CDP 地址：${baseHttp}`,
            `  请求头：Authorization: Bearer ${tok}`,
            pinnedSess
              ? `- 固定会话：该令牌已绑定到会话「${pinnedSess}」，重连会自动回到同一组标签页。`
              : `- 会话隔离：每条连接默认自动分配独立会话与标签页分组；如需固定认领某分组（例如 work），使用：${sessUrl}`,
          ].join("\n");
        }
        return [
          "Please configure my browser automation tool / MCP server to connect to my local cdproxy (standard Chrome CDP proxy):",
          "",
          `- Entry: ${this.endpointDisplayLabel(ep)} — ${srcLabel}`,
          `- Option 1 (recommended, token embedded in URL — works with both http:// and ws://):`,
          `  ${httpUrl}`,
          `- Option 2 (if the tool separates URL and auth headers — the token automatically routes to this target):`,
          `  CDP URL: ${baseHttp}`,
          `  Header:  Authorization: Bearer ${tok}`,
          pinnedSess
            ? `- Pinned session: this token is bound to session "${pinnedSess}" so reconnects resume the same tabs/group.`
            : `- Session isolation: each connection gets its own isolated session/Tab Group automatically. To pin a specific group (e.g. "work"), use: ${sessUrl}`,
        ].join("\n");
      }

      if (tab === "pw") {
        return [
          isZh ? "// 1. Playwright 代码" : "// 1. Playwright",
          `const browser = await chromium.connectOverCDP("${httpUrl}");`,
          "",
          isZh ? "// 2. @playwright/mcp 配置（mcpServers）" : "// 2. @playwright/mcp (mcpServers)",
          JSON.stringify({
            playwright: {
              command: "npx",
              args: [
                "@playwright/mcp@latest",
                "--cdp-endpoint", baseHttp,
                "--cdp-header", `Authorization: Bearer ${tok}`,
              ],
            },
          }, null, 2),
          "",
          isZh ? "# 3. playwright-cli" : "# 3. playwright-cli",
          `playwright-cli attach --cdp="${baseHttp}" --cdp-header="Authorization: Bearer ${tok}"`,
        ].join("\n");
      }

      if (tab === "pptr") {
        return [
          isZh ? "// 1. Puppeteer 代码（v24+，URL 或 Header 均可）" : "// 1. Puppeteer (URL or Header mode)",
          `const browser = await puppeteer.connect({`,
          `  browserURL: "${baseHttp}",`,
          `  headers: { Authorization: "Bearer ${tok}" },`,
          `});`,
          "",
          isZh ? "// 2. chrome-devtools-mcp 配置（mcpServers）" : "// 2. chrome-devtools-mcp (mcpServers)",
          JSON.stringify({
            "chrome-devtools": {
              command: "npx",
              args: [
                "-y", "chrome-devtools-mcp@latest",
                `--wsEndpoint=${baseWs}`,
                `--wsHeaders=${JSON.stringify({ Authorization: `Bearer ${tok}` })}`,
              ],
            },
          }, null, 2),
        ].join("\n");
      }

      return [
        isZh ? "# 通过 --cdp + --cdp-headers 直接连接（令牌自动识别对应源）" : "# Direct CLI connection via --cdp + --cdp-headers (token auto-routes)",
        `agent-browser --cdp "${baseHttp}" \\`,
        `  --cdp-headers '${JSON.stringify({ Authorization: `Bearer ${tok}` })}' \\`,
        `  snapshot`,
        "",
        isZh ? "# 或直连 WebSocket（免填 Header）" : "# Or direct WebSocket URL (no header needed)",
        `agent-browser --cdp "${wsUrl}" snapshot`,
        "",
        isZh
          ? "# 提示：日常使用 agent-browser 推荐在「源与接入点 → agent-browser 自动接入」一键配置全局 provider，之后直接跑 agent-browser --session <名> 即可，无需传 --cdp。"
          : "# Tip: For everyday agent-browser usage, use \"Sources & Endpoints → agent-browser Provider Integration\" once so --session <name> works without passing --cdp.",
      ].join("\n");
    },
    copyConnectSnippet() {
      const m = this.connectModal;
      if (!m) return;
      const text = this.connectSnippet(m.tab);
      const tip = m.tab === "ai" ? this.t("conn.ai_copied") : this.t("conn.snippet_copied");
      this.copyText(text, tip, `conn-snip-${m.tab}`);
    },
    copyEndpointHeader(ep, key) {
      if (!ep?.token) {
        this.toast(this.t("toast.save_ep_first"), "err");
        return;
      }
      this.copyText(`Authorization: Bearer ${ep.token}`, this.t("ep.header_copied", { path: ep.path }), key);
    },
    epTokenPreview(ep) {
      return ep.token ? ep.token.slice(0, 8) + "…" : this.t("src.ep_gen_auto");
    },

    async resetToken(kind) {
      const ok = await this.askConfirm({
        title: kind === "ext" ? this.t("confirm.reset_ext_title") : this.t("confirm.reset_alloc_title"),
        body: kind === "ext" ? this.t("confirm.reset_ext_body") : this.t("confirm.reset_alloc_body"),
        confirmText: this.t("confirm.reset_confirm"),
        danger: true,
      });
      if (!ok) return;
      this.actionKey = `reset-${kind}`;
      try {
        const path = kind === "ext" ? "/sources/ext-token/reset" : "/sources/alloc-token/reset";
        await this.api("POST", path, {});
        await this.refresh();
        this.toast(this.t("toast.token_reset_ok"), "ok");
      } catch (err) {
        this.toast(this.t("toast.reset_fail", { err: err.message }), "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    async resetEndpointToken(ep) {
      const ok = await this.askConfirm({
        title: this.t("confirm.reset_ep_title", { path: ep.path }),
        body: this.t("confirm.reset_ep_body"),
        confirmText: this.t("confirm.reset_ep_btn"),
        danger: true,
      });
      if (!ok) return;
      this.actionKey = `ep-reset-${ep.path}`;
      try {
        const r = await this.api("POST", `/endpoints/${encodeURIComponent(ep.path)}/reset-token`, {});
        ep.token = r.token;
        this.toast(this.t("toast.ep_token_updated", { path: ep.path }), "ok");
      } catch (err) {
        this.epError = err.message;
        this.toast(err.message, "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    epDirty() {
      if (!this.savedEpJson) return false;
      const cur = JSON.stringify(this.epForm.map(e => ({ path: e.path || "", source: e.source ?? "", session: e.session || "" })));
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
        eps.push({ path, source: ep.source ?? "", session: (ep.session || "").trim() });
      }
      this.saving = { ...this.saving, endpoints: true };
      try {
        const updated = await this.api("PUT", "/settings", { endpoints: eps });
        this.syncAllFromSettings(updated);
        this.epSavedAt = new Date().toLocaleTimeString();
        this.toast(this.t("toast.ep_saved"), "ok");
      } catch (err) {
        this.epError = err.message;
        this.toast(this.t("toast.ep_save_fail", { err: err.message }), "err", 4000);
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
        this.routeError = this.t("src.route_err_source");
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
        this.toast(this.t("toast.route_saved"), "ok");
      } catch (err) {
        this.routeError = err.message;
        this.toast(this.t("toast.route_save_fail", { err: err.message }), "err", 4000);
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
        this.toast(this.t("toast.settings_saved"), "ok");
        await new Promise(r => setTimeout(r, 500));
        await this.refresh();
      } catch (err) {
        this.toast(this.t("toast.save_fail", { err: err.message }), "err", 4500);
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
        this.abError = this.t("set.ab_err_abs");
        return;
      }
      this.saving = { ...this.saving, ab: true };
      try {
        const updated = await this.api("PUT", "/settings", { agent_browser_binary: path });
        this.abPath = path;
        if (path) this.abCustomPath = path;
        this.abSavedAt = new Date().toLocaleTimeString();
        this.jsonDraft = JSON.stringify(updated, null, 2);
        await this.loadSources();
        this.toast(this.t("toast.ab_saved"), "ok");
      } catch (err) {
        this.abError = err.message;
        this.toast(this.t("toast.save_fail", { err: err.message }), "err", 4000);
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
        title: this.t("confirm.datadir_title"),
        body: this.t("confirm.datadir_body", { dir }),
        confirmText: this.t("confirm.datadir_btn"),
      });
      if (!ok) return;
      this.saving = { ...this.saving, datadir: true };
      try {
        await this.api("PUT", "/data-dir", { data_dir: dir });
        this.ddSaved = true;
        this.newDataDir = "";
        await this.loadLayout();
        this.toast(this.t("toast.datadir_updated"), "ok", 3500);
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
        this.jsonError = this.t("set.json_err_parse", { err: err.message });
        return;
      }
      if (typeof obj !== "object" || Array.isArray(obj) || obj === null) {
        this.jsonError = this.t("set.json_err_obj");
        return;
      }
      this.saving = { ...this.saving, json: true };
      try {
        const updated = await this.api("PUT", "/settings", obj);
        this.syncAllFromSettings(updated);
        this.jsonSavedAt = new Date().toLocaleTimeString();
        await this.refresh();
        this.toast(this.t("toast.json_saved"), "ok");
      } catch (err) {
        this.jsonError = err.message;
        this.toast(this.t("toast.json_save_fail", { err: err.message }), "err", 4000);
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
        this.configContent = r.content ?? this.t("set.cfg_empty_file");
      } catch (err) {
        this.configView = key;
        this.configContent = this.t("set.cfg_read_err", { err: err.message });
      } finally {
        this.saving = { ...this.saving, cfg: false };
      }
    },

    /* ── 改写规则（精简主行 + 行内手风琴展开） ── */
    isPresetActive(kind) {
      const defaults = defaultRewrites(this.lang);
      const target = kind === "focus" ? defaults : defaults.filter(r => r.group === "base");
      return stablePresetKey(this.rules) === stablePresetKey(target);
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
      const defaults = defaultRewrites(this.lang);
      this.rules = JSON.parse(JSON.stringify(kind === "focus" ? defaults : defaults.filter(r => r.group === "base")));
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
        if (typeof v !== "object" || Array.isArray(v) || v === null) throw new Error(this.t("rules.err_must_object"));
        this.rules[i].set = v;
        const next = { ...this.ruleSetErrors };
        delete next[i];
        this.ruleSetErrors = next;
        this.rulesError = "";
      } catch (err) {
        this.ruleSetErrors = { ...this.ruleSetErrors, [i]: err.message };
        this.rulesError = this.t("rules.err_invalid_set", { idx: i + 1, err: err.message });
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
        parts.push(`<span class="rs-tok warn">${esc(this.t("rules.summary_fake"))}</span>`);
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
      if (r.note) parts.push(`<span class="sum-note">${esc(this.displayRuleNote(r.note))}</span>`);
      else if (!parts.length) parts.push(`<span class="sum-note">${esc(this.t("rules.summary_empty"))}</span>`);
      return parts.join("");
    },
    async saveRules() {
      this.rulesError = "";
      if (Object.keys(this.ruleSetErrors).length) {
        this.rulesError = this.t("rules.err_fix_red");
        return;
      }
      const payload = [];
      for (const r of this.rules) {
        if (!r.match || !r.match.trim()) {
          this.rulesError = this.t("rules.err_empty_match");
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
        this.toast(this.t("toast.rules_saved"), "ok");
      } catch (err) {
        this.rulesError = err.message;
        this.toast(this.t("toast.rules_save_fail", { err: err.message }), "err", 4000);
      } finally {
        this.saving = { ...this.saving, rules: false };
      }
    },

    /* ── 会话操作与基座控制 ── */
    async release(name) {
      const ok = await this.askConfirm({
        title: this.t("confirm.release_title", { name }),
        body: this.t("confirm.release_body"),
        confirmText: this.t("confirm.release_btn"),
        danger: true,
      });
      if (!ok) return;
      this.actionKey = "release";
      try {
        await this.api("POST", `/sessions/${encodeURIComponent(name)}/release`, {});
        await this.refresh();
        this.toast(this.t("toast.session_released", { name }), "ok");
      } catch (err) {
        this.toast(this.t("toast.release_fail", { err: err.message }), "err", 4000);
      } finally {
        this.actionKey = "";
      }
    },

    async restartKeeper() {
      const ok = await this.askConfirm({
        title: this.t("confirm.restart_keeper_title"),
        body: this.t("confirm.restart_keeper_body"),
        confirmText: this.t("confirm.restart_keeper_btn"),
      });
      if (!ok) return;
      this.actionKey = "restartKeeper";
      try {
        await this.api("POST", "/keeper/restart", {});
        await this.refresh();
        this.toast(this.t("toast.keeper_restarted"), "ok");
      } catch (err) {
        this.toast(this.t("toast.keeper_restart_fail", { err: err.message }), "err", 4000);
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
      if (diff < 5) return this.t("time.just_now");
      if (diff < 60) return this.t("time.sec_ago", { n: diff });
      const m = Math.floor(diff / 60);
      if (m < 60) return this.t("time.min_ago", { n: m });
      const h = Math.floor(m / 60);
      if (h < 24) return this.t("time.hour_ago", { n: h });
      return this.t("time.day_ago", { n: Math.floor(h / 24) });
    },
    fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : ""; },

    logSummary(e) {
      const src = e.in !== undefined ? e.in : null;
      const chips = [];
      if (src && typeof src === "object" && !Array.isArray(src)) {
        for (const k of Object.keys(src).slice(0, 4)) {
          let v = src[k];
          if (v === null) v = "null";
          else if (typeof v === "object") v = Array.isArray(v) ? `[${this.t("common.items_count", { n: v.length })}]` : "{…}";
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
        title: this.t("confirm.shutdown_title"),
        body: this.t("confirm.shutdown_body"),
        confirmText: this.t("confirm.shutdown_btn"),
        danger: true,
      });
      if (!ok) return;
      this.actionKey = "shutdown";
      try {
        await this.api("POST", "/shutdown", {});
        this.healthy = false;
        this.toast(this.t("toast.service_stopped"), "info");
      } catch (err) {
        this.healthy = false;
      } finally {
        this.actionKey = "";
      }
    },
  };
}
