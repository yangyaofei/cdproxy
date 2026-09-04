/* agent-browser-proxy Admin 逻辑（Alpine 组件） */

const DEFAULT_REWRITES = [
  { match: "Target.createTarget", action: "rewrite", set: { background: true }, group: "focus", note: "tab 创建不抢焦点（+background:true）" },
  { match: "Target.activateTarget", action: "fake", group: "focus", note: "激活拦截（假成功）" },
  { match: "Page.bringToFront", action: "fake", group: "focus", note: "置前拦截（假成功）" },
  { match: "Browser.setWindowBounds", action: "rewrite", remove: ["bounds.focused"], group: "focus", note: "剥离窗口 focused 字段" },
  { match: "Emulation.setFocusEmulationEnabled", action: "rewrite", group: "focus", note: "焦点仿真透传（页内 hasFocus 失真来源）" },
  { match: "Browser.close", action: "fake", group: "base", note: "基座保护（全体会话共用基础设施）" },
];

function admin() {
  return {
    healthy: false,
    status: null,
    tab: "sessions",
    logs: [],
    viewSessions: [],
    logOpen: "",
    sessionLogs: [],
    selLog: -1,
    form: { disconnect_reap_seconds: null, alloc_reap_seconds: null, popup_policy: null },
    savedAt: "",
    rulesText: "",
    rulesError: "",
    rulesSavedAt: "",
    busy: false,

    async init() {
      await this.refresh();
      setInterval(() => this.refresh(), 5000);
    },

    async api(method, path, body) {
      const resp = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(data.error || `${method} ${path} → ${resp.status}`);
      }
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
          this.form.popup_policy = snap.settings.popup_policy;
          this.rulesText = JSON.stringify(snap.settings.rewrites || [], null, 2);
        }
        if (!this.logs.length) this.loadLogs();
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
        this.form.popup_policy !== this.status.settings.popup_policy
      );
    },

    async saveSettings() {
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", {
          disconnect_reap_seconds: Number(this.form.disconnect_reap_seconds),
          alloc_reap_seconds: Number(this.form.alloc_reap_seconds),
          popup_policy: this.form.popup_policy,
        });
        this.form.disconnect_reap_seconds = updated.disconnect_reap_seconds;
        this.form.alloc_reap_seconds = updated.alloc_reap_seconds;
        this.form.popup_policy = updated.popup_policy;
        this.savedAt = new Date().toLocaleTimeString();
        await this.refresh();
      } catch (err) {
        alert("保存失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    // ── 改写规则 ──
    applyPreset(kind) {
      this.rulesText = JSON.stringify(kind === "focus" ? DEFAULT_REWRITES : DEFAULT_REWRITES.filter(r => r.group === "base"), null, 2);
      this.rulesError = "";
    },

    resetRulesEditor() {
      if (this.status && this.status.settings.rewrites) {
        this.rulesText = JSON.stringify(this.status.settings.rewrites, null, 2);
      }
      this.rulesError = "";
    },

    async saveRules() {
      this.rulesError = "";
      let rules;
      try {
        rules = JSON.parse(this.rulesText);
      } catch (err) {
        this.rulesError = "JSON 解析失败: " + err.message;
        return;
      }
      if (!Array.isArray(rules)) {
        this.rulesError = "rewrites 必须是数组";
        return;
      }
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", { rewrites: rules });
        this.rulesText = JSON.stringify(updated.rewrites, null, 2);
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
      } catch (err) {
        alert("释放失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

    async restartKeeper() {
      if (!confirm("重启基座 Chrome？所有会话将断开并重新分配。")) return;
      this.busy = true;
      try {
        await this.api("POST", "/keeper/restart", {});
        await this.refresh();
      } catch (err) {
        alert("重启失败: " + err.message);
      } finally {
        this.busy = false;
      }
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
      } finally {
        this.busy = false;
      }
    },

    fmtLast(ts) {
      if (!ts) return "";
      return new Date(ts).toLocaleTimeString();
    },

    fmtTime(ts) {
      return new Date(ts).toLocaleTimeString();
    },

    logSummary(e) {
      if (e.delta) return e.delta;
      if (e.detail) return e.detail;
      if (e.in !== undefined) return JSON.stringify(e.in);
      return "";
    },

    pretty(v) {
      if (v === undefined || v === null) return "";
      try { return JSON.stringify(v, null, 2); } catch (err) { return String(v); }
    },

    async loadLogs() {
      this.busy = true;
      try {
        const data = await this.api("GET", "/logs/tail");
        this.logs = data.lines;
      } catch (err) {
        this.logs = ["读取日志失败: " + err.message];
      } finally {
        this.busy = false;
      }
    },

    async shutdown() {
      if (!confirm("停止服务？基座 Chrome 不受影响。")) return;
      try {
        await this.api("POST", "/shutdown", {});
        this.healthy = false;
      } catch (err) {
        this.healthy = false;
      }
    },
  };
}
