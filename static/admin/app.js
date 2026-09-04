/* agent-browser-proxy Admin 逻辑（Alpine 组件） */

function admin() {
  return {
    healthy: false,
    status: null,
    logs: [],
    logOpen: "",
    sessionLogs: [],
    form: { disconnect_reap_seconds: null, alloc_reap_seconds: null, focus_mode: null },
    savedAt: "",
    busy: false,

    async init() {
      await this.refresh();
      // 状态轮询（页面开着就保持新鲜）
      setInterval(() => this.refresh(), 5000);
    },

    async api(method, path, body) {
      const resp = await fetch(path, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!resp.ok) {
        throw new Error(`${method} ${path} → ${resp.status}`);
      }
      return resp.json();
    },

    async refresh() {
      try {
        const snap = await this.api("GET", "/status");
        this.status = snap;
        this.healthy = true;
        if (this.form.disconnect_reap_seconds === null) {
          this.form.disconnect_reap_seconds = snap.settings.disconnect_reap_seconds;
          this.form.alloc_reap_seconds = snap.settings.alloc_reap_seconds;
          this.form.focus_mode = snap.settings.focus_mode;
        }
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
        this.form.focus_mode !== this.status.settings.focus_mode
      );
    },

    async saveSettings() {
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", {
          disconnect_reap_seconds: Number(this.form.disconnect_reap_seconds),
          alloc_reap_seconds: Number(this.form.alloc_reap_seconds),
          focus_mode: this.form.focus_mode,
        });
        this.form.disconnect_reap_seconds = updated.disconnect_reap_seconds;
        this.form.alloc_reap_seconds = updated.alloc_reap_seconds;
        this.form.focus_mode = updated.focus_mode;
        this.savedAt = new Date().toLocaleTimeString();
        await this.refresh();
      } catch (err) {
        alert("保存失败: " + err.message);
      } finally {
        this.busy = false;
      }
    },

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

    // ── 会话 CDP 交互日志 ──
    toggleLogs(name) {
      this.logOpen = this.logOpen === name ? "" : name;
      if (this.logOpen) this.loadSessionLogs(name);
    },

    async loadSessionLogs(name) {
      this.busy = true;
      try {
        const data = await this.api("GET", `/sessions/${encodeURIComponent(name)}/logs?limit=200`);
        this.sessionLogs = data.entries || [];
      } catch (err) {
        this.sessionLogs = [{ ts: Date.now(), dir: "!", detail: "读取失败: " + err.message }];
      } finally {
        this.busy = false;
      }
    },

    fmtEntry(e) {
      const t = new Date(e.ts).toLocaleTimeString();
      const id = e.id !== undefined && e.id !== null ? ` #${e.id}` : "";
      const st = e.status ? ` [${e.status}]` : "";
      const act = e.action ? ` <${e.action}>` : "";
      return `${t} ${e.dir}/${e.kind}${id}${st}${act} ${e.method || ""} ${e.detail || ""}`.trimEnd();
    },

    async shutdown() {
      if (!confirm("停止服务？基座 Chrome 不受影响。")) return;
      try {
        await this.api("POST", "/shutdown", {});
        this.healthy = false;
      } catch (err) {
        // 停机过程中连接断开属预期
        this.healthy = false;
      }
    },
  };
}
