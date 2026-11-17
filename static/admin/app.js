/* cdproxy Admin 逻辑（Alpine 组件，无外部依赖）v0.5.0
 * 双传输：Wails 进程内绑定（__cdpWails.doRequest）优先，回落 REST fetch。
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
    ts, level: m[2], msg: m[3] !== undefined ? m[3] : (m[4] || ""), rest: (m[5] || "").trim(),
    timeShort: (ts.includes("T") ? ts.split("T")[1] : ts).replace(/([+-]\d{2}:\d{2}|Z)$/, ""),
    day: ts.includes("T") ? ts.split("T")[0] : "",
  };
}

function admin() {
  return {
    healthy: null, // null=连接中（初始） / true=在线 / false=离线
    status: null,
    tab: "sessions",
    viewSessions: [],
    sideCollapsed: localStorage.getItem('sideCol') === '1',
    logOpen: "",
    sessionLogs: [],
    selLog: -1,
    form: { disconnect_reap_seconds: null, alloc_reap_seconds: null, keeper_idle_shutdown_seconds: null, control_port: null, ws_port: null, ports_enabled: null, admin_web_enabled: null },
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
    showExtToken: false,
    showAllocToken: false,
    // 接入点编辑器（token 只读展示；保存不提交 token；_show=脱敏开关）
    epForm: [],
    epSavedAt: "",
    epError: "",
    // 设置页 JSON 编辑器 + 配置查看
    jsonDraft: "",
    jsonSavedAt: "",
    jsonError: "",
    configFiles: [],
    configView: "",
    configContent: null,
    // 会话搜索
    sessionQuery: "",
    selSessionName: "",
    updateMsg: "", updateKind: "", updateBusy: false, canUpdate: false,   // master-detail 选中会话
    sessGrid: null,       // Tabulator 实例（会话表）
    // 规则预设高亮
    presetActive: "",
    // agent-browser 二进制选择
    abMode: "auto",
    abLookupPath: "",   // which 探测的外部 agent-browser 路径（空=未探测到）
    abPath: "",
    abSavedAt: "",
    abError: "",
    abLoaded: false,
    // 数据目录
    layout: null,
    newDataDir: "",
    ddSavedAt: "",
    ddError: "",
    // 日志过滤
    slogLevel: "all",
    slogSrc: "all",
    slogQuery: "",
    slogAutoScroll: false,

    async init() {
      // 窄窗判定先行（首帧即正确，不等 refresh）
      if (window.innerWidth <= 960) this.sideCollapsed = true;
      // 初始 tab 即会话页时也要建表（go() 之外的路径）。
      // 须等 Alpine 渲染完 + 容器可测量（display:none 下建表会使 Tabulator
      // renderer 拿不到尺寸 → verticalFillMode 空指针），故推迟到下一帧。
      setTimeout(() => this.ensureGrid(), 80);
      const saved = localStorage.getItem("abp_theme") || "dark";
      document.documentElement.dataset.theme = saved;
      await this.refresh();
      this.bindUpdaterEvents();
      this.bindResponsive();
      this.bindStateEvents();
      this.schedulePoll();
      // 窗口重新获得焦点立即对账一次（防 WebView 重载丢事件）
      window.addEventListener("focus", () => this.refreshSoon());
      // 触底加载更早日志：轮询哨兵位置（scroll 事件在本环境不可靠，轮询确定性最高；
      // slogLoading/hasMore 在 loadOlderLogs 内防重入，空闲开销为一次 getBoundingClientRect）
      setInterval(() => {
        const el = document.getElementById("slogSentinel");
        if (!el || el.offsetParent === null) return;
        if (el.getBoundingClientRect().top < innerHeight + 600) this.loadOlderLogs();
      }, 600);
    },

    /* 事件驱动（桌面 App）：引擎状态变化 → Wails Events 推送 cdp:state →
       50ms 防抖后立即重拉快照（进程内绑定毫秒级）——状态变化 1 秒内可见。
       轮询降为兜底：在线 30s 对账、离线 800ms 快探。浏览器模式（Admin 网页）
       无事件可订，自然回落纯轮询。 */
    bindStateEvents() {
      const bind = () => {
        if (!window.__wailsEvents) return false;
        // 官方模式：payload 即完整状态 JSON，直达写入——无请求无防抖。
        // 引擎停机信号（"engine-offline"）转离线态，数据保留标过期。
        window.__wailsEvents.On("cdp:state", (data) => {
          const payload = data && data.data !== undefined ? data.data : data;
          if (payload === "engine-offline") { this.healthy = false; return; }
          try { this.applyStatus(JSON.parse(payload)); } catch (e) { /* 非 JSON 忽略 */ }
        });
        return true;
      };
      if (!bind()) window.addEventListener("wails-events-ready", () => bind(), { once: true });
    },
    refreshSoon() {
      clearTimeout(this._soonT);
      this._soonT = setTimeout(() => this.refresh(), 50);
    },

    /* 状态轮询：兜底间隔——在线 30s 对账；离线/冷启动 800ms 快探 */
    schedulePoll() {
      clearTimeout(this._pollT);
      // 双形态分流：App（__wailsEvents 在场=事件已直达）在线零轮询，仅
      // 离线快探 800ms（引擎停机后无推送者，恢复感知靠这里）；
      // Admin 网页（无事件通道）维持 5s 轮询（网页的既有形态）。
      const inApp = !!window.__wailsEvents;
      let iv;
      if (inApp) iv = this.healthy ? 0 : 800;
      else iv = this.healthy ? 5000 : 800;
      if (!iv) return;
      this._pollT = setTimeout(async () => {
        await this.refresh();
        this.schedulePoll();
      }, iv);
    },

    /* tab 切换（带页面副作用：懒加载） */
    toggleSide() { this.sideCollapsed = !this.sideCollapsed; localStorage.setItem('sideCol', this.sideCollapsed ? '1' : '0'); },
    pageTitle() {
      return { sessions: '会话', rules: '改写规则', sources: '源 & 接入点', settings: '全局设置', logs: '运行日志' }[this.tab] || '';
    },
    go(tab) {
      this.tab = tab;
      if (tab === "sources") this.loadSources();
      if (tab === "sessions") this.ensureGrid();
      if (tab === "settings") { this.loadConfigs(); this.loadLayout(); this.loadAbChoice(); }
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

    // applyStatus 状态快照的唯一落库点：事件直达（payload 即数据）与首问
    //（bindings）共用——官方模式「变量跟着变」的写入侧。
    applyStatus(snap) {
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
          this.form.admin_web_enabled = snap.settings.admin_web_enabled;
          this.rules = JSON.parse(JSON.stringify(snap.settings.rewrites || []));
        }
        // 源页表单：仅在未编辑过时随状态初始化（编辑中不被轮询覆盖）
        if (!this.sourcesLoaded && snap.routing) {
          this.routeForm.default_source = snap.routing.default_source;
          this.routeForm.rules = JSON.parse(JSON.stringify(snap.routing.rules || []));
        }
        if (!this.srcForm.ext_token && snap.sources) this.srcForm.ext_token = snap.sources.extension.token;
        // 接入点表：同样仅初始化一次（编辑期间不被轮询覆盖；保存/重置后手动刷新）
        if (!this.epForm.length && snap.endpoints) {
          this.epForm = JSON.parse(JSON.stringify(snap.endpoints)).map(e => ({ ...e, _show: false }));
        }
        if (!this.slogParsed.length) this.loadLogs();
    },

    async refresh() {
      try {
        this.applyStatus(await this.api("GET", "/status"));
        if (this.logOpen) this.loadSessionLogs(this.logOpen);
      } catch (err) {
        this.healthy = false;
        console.error("刷新失败:", err);
      }
    },

    /* 边栏：基座空闲倒计时（粗粒度——无每会话计时数据，按设置上限与存活状态示意） */
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

    dirty() {
      if (!this.status) return false;
      return (
        Number(this.form.disconnect_reap_seconds) !== this.status.settings.disconnect_reap_seconds ||
        Number(this.form.alloc_reap_seconds) !== this.status.settings.alloc_reap_seconds ||
        Number(this.form.keeper_idle_shutdown_seconds ?? this.status.settings.keeper_idle_shutdown_seconds) !== this.status.settings.keeper_idle_shutdown_seconds ||
        Number(this.form.control_port) !== this.status.settings.control_port ||
        Number(this.form.ws_port) !== this.status.settings.ws_port ||
        this.form.ports_enabled !== this.status.settings.ports_enabled ||
        this.form.admin_web_enabled !== this.status.settings.admin_web_enabled
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
          admin_web_enabled: !!this.form.admin_web_enabled,
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

    /* ── 会话搜索 ── */
    filteredSessions() {
      const q = (this.sessionQuery || "").trim().toLowerCase();
      if (!q) return this.viewSessions;
      return this.viewSessions.filter(s =>
        (s.name || "").toLowerCase().includes(q) ||
        (s.group_name || "").toLowerCase().includes(q) ||
        (s.via || "").toLowerCase().includes(q) ||
        (s.type || "").toLowerCase().includes(q));
    },

    /* ── 会话表（Tabulator）：列宽弹性 + 窄窗自动折叠次要列 ── */
    /* ── 应用更新（App 形态；wails:updater:* 事件驱动提示条）── */
    bindResponsive() {
      // 窄窗自动收起侧栏为图标栏（临时态：不写 localStorage，宽回来自动展开）
      const apply = () => {
        if (window.innerWidth <= 960 && !this.sideCollapsed) this.sideCollapsed = true;
        else if (window.innerWidth > 960 && localStorage.getItem("sideCol") !== "1") this.sideCollapsed = false;
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
          this.updateMsg = `发现新版本 v${data.version || "?"}，正在下载…`; this.updateKind = "info";
        } else if (kind === "no-update") {
          this.updateMsg = "已是最新版本"; this.updateKind = "ok";
          setTimeout(() => { if (this.updateKind === "ok") this.updateMsg = ""; }, 4000);
        } else if (kind === "download-progress" && data) {
          const pct = data.total ? Math.round((data.written / data.total) * 100) : 0;
          this.updateMsg = `下载更新中 ${pct}%`; this.updateKind = "info";
        } else if (kind === "update-ready") {
          this.updateMsg = "新版本已就绪，重启后生效"; this.updateKind = "ready";
        } else if (kind === "error" && data) {
          this.updateMsg = `更新失败：${data.message || data.stage || "未知"}`; this.updateKind = "err";
        }
      });
    },

    async checkUpdate() {
      if (!window.__cdpWails || !window.__cdpWails.checkForUpdate) return;
      this.updateBusy = true;
      try { await window.__cdpWails.checkForUpdate(); } finally { this.updateBusy = false; }
    },
    async installUpdate() {
      if (window.__cdpWails && window.__cdpWails.restartForUpdate) await window.__cdpWails.restartForUpdate();
    },

    selSession() {
      return this.viewSessions.find(s => s.name === this.selSessionName) || null;
    },

    ensureGrid() {
      if (this.sessGrid) return;
      if (typeof Tabulator === "undefined") return; // Tabulator 未加载（admin 网页降级）
      const holder = document.querySelector("#sessions-grid");
      if (!holder || holder.offsetParent === null) {
        // 容器未挂/不可见（Alpine 未渲染完）：重试直至可见（上限 ~3s），避免首屏永远无表
        this._gridTries = (this._gridTries || 0) + 1;
        if (this._gridTries < 30) setTimeout(() => this.ensureGrid(), 100);
        return;
      }
      if (this._gridRO) this._gridRO.disconnect();
      // Tabulator 建表后不随容器伸缩（fitColumns 只在内部数据变化时重算）：
      // 用 ResizeObserver 在容器（窗口缩放/侧栏收起）变化时 redraw 重排
      this._gridRO = new ResizeObserver(() => {
        if (this.sessGrid && this._gridRO._pause) return;
        this.sessGrid && this.sessGrid.redraw && this.sessGrid.redraw(true);
      });
      this._gridRO.observe(holder);
      this.sessGrid = new Tabulator("#sessions-grid", {
        data: this.filteredSessions(),
        renderVertical: "basic",
        layout: "fitColumns",
        resizableColumns: true,
        responsiveLayout: "collapse",
        height: "auto",
        selectable: false,
        rowFormatter: () => {},
        columns: [
          { title: "名称", field: "name", headerSort: false, formatter: "plaintext",
            formatterParams: {}, cssClass: "mono",
            widthGrow: 2, minWidth: 120 },
          { title: "类型", field: "type", headerSort: false, width: 90, minWidth: 70,
            formatter: (cell) => {
              const t = cell.getValue() || "";
              return `<span class="bdg ${t === "extension" ? "ext" : "sa"}">${t}</span>`;
            } },
          { title: "状态", field: "state", headerSort: false, width: 84, minWidth: 70,
            formatter: (cell) => {
              const v = cell.getValue() || "";
              const cls = v === "connected" ? "ok" : (v === "idle" ? "idle" : "warn");
              const zh = v === "connected" ? "已连接" : (v === "idle" ? "空闲" : "已释放");
              return `<span class="bdg ${cls}">${zh}</span>`;
            } },
          { title: "tab", field: "targets", headerSort: false, width: 64, minWidth: 48,
            formatter: (cell) => `<span class="bdg plain">${cell.getValue() ?? 0}</span>` },
          { title: "组名", field: "group_name", headerSort: false, cssClass: "mono sg-col",
            widthGrow: 1, minWidth: 110, formatter: (cell) => cell.getValue() || "—" },
          { title: "入口", field: "via", headerSort: false, cssClass: "mono sg-col",
            widthGrow: 1, minWidth: 100, formatter: (cell) => cell.getValue() || "—" },
          { title: "最近活动", field: "last_ts", headerSort: false, width: 92, minWidth: 80,
            cssClass: "mono sg-col", formatter: (cell) => this.fmtLast(cell.getValue()) },
        ],
      });
      this.sessGrid.on("rowClick", (e, row) => {
        const name = row.getData().name;
        this.selSessionName = (this.selSessionName === name ? "" : name);
        if (this.selSessionName) {
          this.loadTabs(name);
        } else {
          this.sessionTabs = [];
          if (this.logOpen) { this.logOpen = ""; this.sessionLogs = []; this.selLog = -1; }
        }
      });
      // 数据变化（事件直达/轮询刷新后）同步进表格
      this.$watch("viewSessions", () => this.gridSync());
      this.$watch("sessionQuery", () => this.gridSync());
    },

    gridSync() {
      if (!this.sessGrid) return this.ensureGrid();
      const cur = this.selSessionName;
      // replaceData 须等实例完成模块初始化（首渲染前 replaceData 会触发
      // renderer.verticalFillMode 空指针——Tabulator 内部事件链未挂好）
      if (this.sessGrid.moduleExists && !this.sessGrid.initialized) {
        setTimeout(() => this.gridSync(), 120);
        return;
      }
      this.sessGrid.replaceData(this.filteredSessions());
      if (this.sessGrid.redraw) this.sessGrid.redraw(true);
      // 选中行高亮 + 选中会话消失时清详情
      if (cur && !this.viewSessions.some(s => s.name === cur)) {
        this.selSessionName = ""; this.sessionTabs = [];
        if (this.logOpen) { this.logOpen = ""; this.sessionLogs = []; this.selLog = -1; }
      } else if (cur && this.sessGrid.getRows) {
        this.sessGrid.getRows().forEach(r => r.deselect && r.deselect());
        const row = this.sessGrid.getRow(cur);
        if (row && row.select) row.select();
      }
    },

    /* ── 会话 tabs：展开即查（数据面实时，不缓存）── */
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

    /* ── 源页 ── */
    extRelayUrl() {
      if (!this.status) return "";
      return `ws://127.0.0.1:${this.status.settings.ws_port}/ext`;
    },

    abSourceText(src) {
      return { bundled: "内嵌", setting: "外部·指定", path: "外部·PATH", none: "无" }[src] || src;
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

    /* ── 令牌与接入点 ── */
    async copyText(text, tip) {
      try {
        await navigator.clipboard.writeText(text);
        this.epSavedAt = tip || "已复制";
        setTimeout(() => { this.epSavedAt = ""; }, 2000);
      } catch (err) {
        alert("复制失败（非安全上下文）: " + text);
      }
    },

    endpointURL(ep) {
      return `ws://127.0.0.1:${this.status.ws_port}/${ep.path}/${ep.token}`;
    },

    copyEndpoint(ep) {
      if (!ep.path || !ep.token) { this.epError = "path/令牌缺失"; return; }
      this.copyText(this.endpointURL(ep), "连接 URL 已复制");
    },

    epTokenPreview(ep) {
      return ep.token ? ep.token.slice(0, 8) + "…" : "（保存后自动生成）";
    },

    async resetToken(kind) {
      if (kind === "ext" && !confirm("重置扩展令牌？旧令牌立即吊销，扩展 options 页须同步更新")) return;
      if (kind === "alloc" && !confirm("重置分配令牌？旧令牌立即吊销（正在用它的脚本会 401）")) return;
      this.busy = true;
      try {
        const path = kind === "ext" ? "/sources/ext-token/reset" : "/sources/alloc-token/reset";
        await this.api("POST", path, {});
        await this.refresh();
      } catch (err) {
        alert("重置失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    async resetEndpointToken(ep) {
      if (!confirm(`重置接入点 ${ep.path} 的令牌？旧令牌立即吊销`)) return;
      this.busy = true;
      try {
        const r = await this.api("POST", `/endpoints/${encodeURIComponent(ep.path)}/reset-token`, {});
        ep.token = r.token;
      } catch (err) {
        this.epError = err.message;
      } finally {
        this.busy = false;
      }
    },

    async saveEndpoints() {
      this.epError = "";
      const eps = [];
      for (const ep of this.epForm) {
        const path = (ep.path || "").trim();
        if (!path) continue;
        eps.push({ path, source: ep.source, session: (ep.session || "").trim() });
      }
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", { endpoints: eps });
        this.epForm = JSON.parse(JSON.stringify(updated.endpoints || [])).map(e => ({ ...e, _show: false }));
        this.epSavedAt = "已保存 " + new Date().toLocaleTimeString();
      } catch (err) {
        this.epError = err.message;
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

    /* ── agent-browser 二进制选择（内置/外部）── */
    async loadAbChoice() {
      if (this.abLoaded) return;
      try {
        const cur = await this.api("GET", "/settings");
        const p = cur.agent_browser_binary || "";
        this.abMode = p ? "external" : "auto";
        this.abPath = p || this.abLookupPath;
        this.abLoaded = true;
      } catch (err) { /* 懒加载失败静默，保存时报错 */ }
      this.loadSources();
    },

    async saveAgentBrowser() {
      this.abError = "";
      const path = this.abMode === "external" ? (this.abPath || this.abLookupPath).trim() : "";
      if (this.abMode === "external" && !path) { this.abError = "外部模式须填绝对路径（PATH 中也未探测到）"; return; }
      this.busy = true;
      try {
        await this.api("PUT", "/settings", { agent_browser_binary: path });
        this.abPath = path;
        this.abSavedAt = "已保存 " + new Date().toLocaleTimeString();
        await this.loadSources();
      } catch (err) {
        this.abError = err.message;
      } finally {
        this.busy = false;
      }
    },

    /* ── 数据目录（结构展示 + 指针修改）── */
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
      if (!confirm(`修改数据目录为？\n${dir}\n\n写入指针（重启生效）；数据不自动迁移。`)) return;
      this.busy = true;
      try {
        const r = await this.api("PUT", "/data-dir", { data_dir: dir });
        this.ddSavedAt = "已写入指针，重启后生效";
        this.newDataDir = "";
        await this.loadLayout();
      } catch (err) {
        this.ddError = err.message;
      } finally {
        this.busy = false;
      }
    },

    /* ── settings.json 全文编辑 ── */
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

    /* ── 改写规则（结构化编辑）── */
    applyPreset(kind) {
      this.rules = JSON.parse(JSON.stringify(kind === "focus" ? DEFAULT_REWRITES : DEFAULT_REWRITES.filter(r => r.group === "base")));
      this.rulesError = "";
      this.presetActive = kind;
    },

    addRule() {
      this.rules.push({ match: "", action: "rewrite", set: {}, remove: [], group: "", note: "" });
      this.presetActive = "";
    },

    delRule(i) {
      this.rules.splice(i, 1);
      this.presetActive = "";
    },

    /* 放弃编辑：回到已保存的规则 */
    async resetRules() {
      try {
        const cur = await this.api("GET", "/settings");
        this.rules = JSON.parse(JSON.stringify(cur.rewrites || []));
        this.rulesError = "";
        this.presetActive = "";
      } catch (err) {
        this.rulesError = err.message;
      }
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
        this.presetActive = "";
      } catch (err) {
        this.rulesError = err.message;
      } finally {
        this.busy = false;
      }
    },

    /* ── 会话 ── */
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

    /* ── 会话交互日志 ── */
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

    /* ── 服务日志（过滤：级别/来源/关键词；自动滚动到底）── */
    filteredSlog() {
      let rows = this.slogParsed;
      if (this.slogLevel !== "all") rows = rows.filter(e => e.level === this.slogLevel);
      if (this.slogSrc !== "all") rows = rows.filter(e => (e.rest || "").includes(this.slogSrc) || (e.msg || "").includes(this.slogSrc));
      const q = (this.slogQuery || "").trim().toLowerCase();
      if (q) rows = rows.filter(e => (e.msg || "").toLowerCase().includes(q) || (e.rest || "").toLowerCase().includes(q));
      return rows;
    },

    async loadLogs() {
      this.busy = true;
      try {
        const data = await this.api("GET", "/logs/tail?n=200&skip=0");
        this.slogTotal = data.total || 0;
        this.slogHasMore = !!data.hasMore;
        this.slogSkip = 0;
        this.slogParsed = (data.lines || []).map(parseSlogLine).filter(Boolean).reverse();
        if (this.slogAutoScroll) this.$nextTick(() => this.scrollSlogBottom());
      } catch (err) {
        this.slogParsed = [];
      } finally { this.busy = false; }
    },

    scrollSlogBottom() {
      const el = document.getElementById("slogScroll");
      if (el) el.scrollTop = el.scrollHeight;
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
