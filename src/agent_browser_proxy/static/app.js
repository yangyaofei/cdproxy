/* agent-browser-proxy Admin 逻辑（Alpine 组件） */

function admin() {
  return {
    healthy: false,
    status: null,
    logs: [],
    form: { disconnect_reap_seconds: null, alloc_reap_seconds: null },
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
        Number(this.form.alloc_reap_seconds) !== this.status.settings.alloc_reap_seconds
      );
    },

    async saveSettings() {
      this.busy = true;
      try {
        const updated = await this.api("PUT", "/settings", {
          disconnect_reap_seconds: Number(this.form.disconnect_reap_seconds),
          alloc_reap_seconds: Number(this.form.alloc_reap_seconds),
        });
        this.form.disconnect_reap_seconds = updated.disconnect_reap_seconds;
        this.form.alloc_reap_seconds = updated.alloc_reap_seconds;
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
