/* cdproxy Admin 逻辑（Alpine 组件，无外部依赖） */

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
    ts, level: m[2], msg: m[3] !== undefined ? m[3] : (m[4] || ""), rest: (m[5] || "").trim(),
    timeShort: (ts.includes("T") ? ts.split("T")[1] : ts).replace(/([+-]\d{2}:\d{2}|Z)$/, ""),
    day: ts.includes("T") ? ts.split("T")[0] : "",
  };
}

function admin() {
  return {
    healthy: false,
    status: null,
    tab: "sessions",
    viewSessions: [],
    logOpen: "",
    sessionLogs: [],
    selLog: -1,
    form: { disconnect_reap_seconds: null, alloc_reap_seconds: null, keeper_idle_shutdown_seconds: null, control_port: null, ws_port: null, ports_enabled: null },
    savedAt: "",
    rules: [],
    rulesError: "",
    rulesSavedAt: "",
    slogParsed: [],
    slogSkip: 0,
    slogTotal: 0,
    slogHasMore: false,
    slogLoading: false,
    busy: false,
    // 会话 tabs 展开即查
    tabsOpen: "",
    sessionTabs: [],
    tabsError: "",
    // 源页
    abInfo: null,
    srcForm: { ext_token: "" },
    routeForm: { default_source: "standalone", rules: [] },
    routeSavedAt: "",
    routeError: "",
    sourcesLoaded: false,
    // 设置页 JSON 编辑器 + 配置查看
    jsonDraft: "",
    jsonSavedAt: "",
    jsonError: "",
    configFiles: [],
    configView: "",
    configContent: null,

    async init() {
      const saved = localStorage.getItem("abp_theme") || "dark";
      document.documentElement.dataset.theme = saved;
      await this.refresh();
      setInterval(() => this.refresh(), 5000);
      // 触底加载更早日志：轮询哨兵位置（scroll 事件在本环境不可靠，轮询确定性最高；
      // slogLoading/hasMore 在 loadOlderLogs 内防重入，空闲开销为一次 getBoundingClientRect）
      setInterval(() => {
        const el = document.getElementById("slogSentinel");
        if (!el || el.offsetParent === null) return;
        if (el.getBoundingClientRect().top < innerHeight + 600) this.loadOlderLogs();
      }, 600);
    },

    toggleTheme() {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("abp_theme", next);
    },

    async api(method, path, body) {
      // 桌面 App（Wails）：进程内绑定执行同一套 control 路由（端口关闭也可用）
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

    async refresh() {
      try {
        const snap = await this.api("GET", "/status");
        this.status = snap;
        this.healthy = true;
        const lastTs = {};
        (snap.recent_sessions || []).forEach(r => { lastTs[r.name] = r.last_ts; });
        const active = (snap.sessions || []).map(s => ({ ...s, state: s.connected ? "connected" : "idle", last_ts: lastTs[s.name] }));
        const activeNames = new Set(active.map(s => s.name));
        const recent = (snap.recent_sessions || [])
          .filter(r => !activeNames.has(r.name))
          .map(r => ({ name: r.name, state: "released", targets: 0, last_ts: r.last_ts }));
        this.viewSessions = [...active, ...recent];
        if (this.form.disconnect_reap_seconds === null) {
          this.form.disconnect_reap_seconds = snap.settings.disconnect_reap_seconds;
          this.form.alloc_reap_seconds = snap.settings.alloc_reap_seconds;
          this.form.keeper_idle_shutdown_seconds = snap.settings.keeper_idle_shutdown_seconds;
          this.form.control_port = snap.settings.control_port;
          this.form.ws_port = snap.settings.ws_port;
          this.form.ports_enabled = snap.settings.ports_enabled;
          this.rules = JSON.parse(JSON.stringify(snap.settings.rewrites || []));
        }
        // 源页表单：仅在未编辑过时随状态初始化（编辑中不被轮询覆盖）
        if (!this.sourcesLoaded && snap.routing) {
          this.routeForm.default_source = snap.routing.default_source;
          this.routeForm.rules = JSON.parse(JSON.stringify(snap.routing.rules || []));
        }
        if (!this.srcForm.ext_token && snap.sources) this.srcForm.ext_token = snap.sources.extension.token;
        if (!this.slogParsed.length) this.loadLogs();
        if (this.logOpen) this.loadSessionLogs(this.logOpen);
      } catch (err) {
        this.healthy = false;
        console.error("刷新失败:", err);
      }
    },

    dirty() {
      if (!this.status) return false;
      return (
        Number(this.form.disconnect_reap_seconds) !== this.status.settings.disconnect_reap_seconds ||
        Number(this.form.alloc_reap_seconds) !== this.status.settings.alloc_reap_seconds ||
        Number(this.form.keeper_idle_shutdown_seconds ?? this.status.settings.keeper_idle_shutdown_seconds) !== this.status.settings.keeper_idle_shutdown_seconds ||
        Number(this.form.control_port) !== this.status.settings.control_port ||
        Number(this.form.ws_port) !== this.status.settings.ws_port ||
        this.form.ports_enabled !== this.status.settings.ports_enabled
      );
    },

    async saveSettings() {
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", {
          disconnect_reap_seconds: Number(this.form.disconnect_reap_seconds),
          alloc_reap_seconds: Number(this.form.alloc_reap_seconds),
          keeper_idle_shutdown_seconds: Number(this.form.keeper_idle_shutdown_seconds),
          control_port: Number(this.form.control_port),
          ws_port: Number(this.form.ws_port),
          ports_enabled: !!this.form.ports_enabled,
        });
        this.form.disconnect_reap_seconds = updated.disconnect_reap_seconds;
        this.form.alloc_reap_seconds = updated.alloc_reap_seconds;
        this.form.keeper_idle_shutdown_seconds = updated.keeper_idle_shutdown_seconds;
        this.form.control_port = updated.control_port;
        this.form.ws_port = updated.ws_port;
        this.form.ports_enabled = updated.ports_enabled;
        this.savedAt = new Date().toLocaleTimeString();
        // 端口类变更会触发监听重绑：Web 版本连接可能随旧监听断开，稍后自愈
        await new Promise(r => setTimeout(r, 600));
        await this.refresh();
      } catch (err) {
        alert("保存失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    // ── 会话 tabs：展开即查（数据面实时，不缓存）──
    toggleTabs(name) {
      if (this.tabsOpen === name) { this.tabsOpen = ""; return; }
      this.tabsOpen = name;
      this.loadTabs(name);
    },

    async loadTabs(name) {
      this.tabsError = "";
      this.busy = true;
      try {
        const r = await this.api("GET", `/sessions/${encodeURIComponent(name)}/tabs`);
        this.sessionTabs = r.tabs || [];
      } catch (err) {
        this.tabsError = err.message;
        this.sessionTabs = [];
      } finally {
        this.busy = false;
      }
    },

    // ── 源页 ──
    extRelayUrl() {
      if (!this.status) return "";
      return `ws://127.0.0.1:${this.status.settings.ws_port}/ext`;
    },

    async loadSources() {
      try {
        this.abInfo = await this.api("GET", "/sources/agent-browser");
      } catch (err) {
        this.abInfo = null;
      }
    },

    async toggleSource(kind, enable) {
      if (this.busy) return;
      // 双源至少留一个：前端先拦（后端同样拒绝）
      const cur = this.status?.sources || {};
      const other = kind === "standalone" ? cur.extension?.enabled : cur.standalone?.enabled;
      if (!enable && !other) { alert("不能两源同时禁用"); return; }
      this.busy = true;
      try {
        await this.api("PUT", "/settings", { sources: { [kind === "standalone" ? "standalone_enabled" : "extension_enabled"]: enable } });
        await this.refresh();
      } catch (err) {
        alert("切换失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    async saveExtToken() {
      this.busy = true;
      try {
        await this.api("PUT", "/settings", { sources: { token: this.srcForm.ext_token.trim() } });
        await this.refresh();
      } catch (err) {
        alert("保存失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    async saveRouting() {
      this.routeError = "";
      const rules = this.routeForm.rules
        .map(r => ({ prefix: (r.prefix || "").trim(), source: r.source }))
        .filter(r => r.prefix);
      if (this.routeForm.rules.some(r => (r.prefix || "").trim() && !["standalone", "extension"].includes(r.source))) {
        this.routeError = "规则 source 须为 standalone 或 extension"; return;
      }
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", { routing: { default_source: this.routeForm.default_source, rules } });
        this.routeForm.rules = JSON.parse(JSON.stringify(updated.routing?.rules || []));
        this.routeForm.default_source = updated.routing?.default_source;
        this.routeSavedAt = new Date().toLocaleTimeString();
        await this.refresh();
      } catch (err) {
        this.routeError = err.message;
      } finally {
        this.busy = false;
      }
    },

    // ── settings.json 全文编辑 ──
    async reloadJsonDraft() {
      try {
        const cur = await this.api("GET", "/settings");
        this.jsonDraft = JSON.stringify(cur, null, 2);
        this.jsonError = "";
      } catch (err) {
        this.jsonError = err.message;
      }
    },

    async saveJson() {
      this.jsonError = "";
      let obj;
      try { obj = JSON.parse(this.jsonDraft); } catch (err) {
        this.jsonError = "JSON 解析失败: " + err.message; return;
      }
      if (typeof obj !== "object" || Array.isArray(obj) || obj === null) {
        this.jsonError = "顶层须为对象"; return;
      }
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", obj);
        this.jsonDraft = JSON.stringify(updated, null, 2);
        this.jsonSavedAt = new Date().toLocaleTimeString();
        await this.refresh();
      } catch (err) {
        this.jsonError = err.message;
      } finally {
        this.busy = false;
      }
    },

    // ── 配置文件只读查看 ──
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
      this.busy = true;
      try {
        const r = await this.api("GET", `/config/files/${encodeURIComponent(key)}`);
        this.configView = key;
        this.configContent = r.content ?? "（空文件）";
      } catch (err) {
        this.configView = key;
        this.configContent = "读取失败: " + err.message;
      } finally {
        this.busy = false;
      }
    },

    // ── 改写规则（结构化编辑）──
    applyPreset(kind) {
      this.rules = JSON.parse(JSON.stringify(kind === "focus" ? DEFAULT_REWRITES : DEFAULT_REWRITES.filter(r => r.group === "base")));
      this.rulesError = "";
    },

    addRule() {
      this.rules.push({ match: "", action: "rewrite", set: {}, remove: [], group: "", note: "" });
    },

    delRule(i) {
      this.rules.splice(i, 1);
    },

    // set 的 JSON 文本输入（key=value 双向绑定由 x-model 直连 setJson 缓存）
    setJsonOf(i) {
      try { return JSON.stringify(this.rules[i].set || {}); } catch (err) { return "{}"; }
    },

    onSetInput(i, text) {
      try {
        const v = JSON.parse(text || "{}");
        this.rules[i].set = v;
        this.rulesError = "";
      } catch (err) {
        this.rulesError = `第 ${i + 1} 条 set 不是合法 JSON：${err.message}`;
      }
    },

    async saveRules() {
      this.rulesError = "";
      for (const r of this.rules) {
        if (!r.match || !r.match.trim()) { this.rulesError = "存在空的 match"; return; }
      }
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", { rewrites: this.rules });
        this.rules = JSON.parse(JSON.stringify(updated.rewrites || []));
        this.rulesSavedAt = new Date().toLocaleTimeString();
      } catch (err) {
        this.rulesError = err.message;
      } finally {
        this.busy = false;
      }
    },

    // ── 会话 ──
    async release(name) {
      if (!confirm(`释放会话 ${name}？（将关闭其名下 tab）`)) return;
      this.busy = true;
      try {
        await this.api("POST", `/sessions/${encodeURIComponent(name)}/release`, {});
        await this.refresh();
      } catch (err) { alert("释放失败: " + err.message); } finally { this.busy = false; }
    },

    async restartKeeper() {
      if (!confirm("重启基座 Chrome？所有会话将断开并重新分配。")) return;
      this.busy = true;
      try {
        await this.api("POST", "/keeper/restart", {});
        await this.refresh();
      } catch (err) { alert("重启失败: " + err.message); } finally { this.busy = false; }
    },

    // ── 会话交互日志 ──
    toggleLogs(name) {
      this.logOpen = this.logOpen === name ? "" : name;
      this.selLog = -1;
      if (this.logOpen) this.loadSessionLogs(name);
    },

    async loadSessionLogs(name) {
      this.busy = true;
      try {
        const data = await this.api("GET", `/sessions/${encodeURIComponent(name)}/logs?limit=200`);
        this.sessionLogs = data.entries || [];
        if (this.selLog >= this.sessionLogs.length) this.selLog = -1;
      } catch (err) {
        this.sessionLogs = [];
        alert("读取日志失败: " + err.message);
      } finally { this.busy = false; }
    },

    fmtLast(ts) { return ts ? new Date(ts).toLocaleTimeString() : ""; },
    fmtTime(ts) { return ts ? new Date(ts).toLocaleTimeString() : ""; },

    logSummary(e) {
      // 摘要：结构化键值 chips（顶层至多 4 个，值截断）——JSON 内容可视化而非字符串
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

    // ── 服务日志（最新在前；下滑到底自动加载更早一页）──
    async loadLogs() {
      this.busy = true;
      try {
        const data = await this.api("GET", "/logs/tail?n=200&skip=0");
        this.slogTotal = data.total || 0;
        this.slogHasMore = !!data.hasMore;
        this.slogSkip = 0;
        this.slogParsed = (data.lines || []).map(parseSlogLine).filter(Boolean).reverse();
      } catch (err) {
        this.slogParsed = [];
      } finally { this.busy = false; }
    },

    async loadOlderLogs() {
      if (this.slogLoading || !this.slogHasMore) return;
      this.slogLoading = true;
      try {
        const skip = this.slogSkip + 200;
        const data = await this.api("GET", "/logs/tail?n=200&skip=" + skip);
        this.slogSkip = skip;
        if (data.total) this.slogTotal = data.total;
        this.slogHasMore = !!data.hasMore;
        const older = (data.lines || []).map(parseSlogLine).filter(Boolean).reverse();
        this.slogParsed = this.slogParsed.concat(older);
      } catch (err) { /* 失败静默，下次触底重试 */ }
      finally { this.slogLoading = false; }
    },

    async shutdown() {
      if (!confirm("停止服务？基座 Chrome 不受影响。")) return;
      try { await this.api("POST", "/shutdown", {}); this.healthy = false; }
      catch (err) { this.healthy = false; }
    },
  };
}
