#!/usr/bin/env node
// 接入点（连接即会话）冒烟：E1-E8
//   前置：服务已运行（EXT_CONTROL，默认 9234）；E2/E6 需 cdp-ext 扩展已回连
//   （E1 standalone 会现场经 keeper 拉起基座 Chrome）。
//   E1 端点直连 standalone（URL token）
//   E2 端点直连 extension + 会话名/组名正确
//   E3 错误 token → HTTP 401（升级前拒绝）
//   E4 Bearer 头等价认证
//   E5 重置令牌 → 旧拒新通（吊销语义）
//   E6 自定义接入点：添加 → 连接 → via 标记 endpoint:<path>
//   E7 POST /sessions 无令牌 → 401
//   E8 顶替：同端点第二连接顶掉第一连接
// 依赖：npm --prefix var/pwtest i ws（回落解析该目录）。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
const _req = createRequire(import.meta.url);
let WebSocket;
try {
  ({ WebSocket } = _req("ws"));
} catch {
  const local = path.resolve("var/pwtest/node_modules/ws");
  if (!existsSync(local)) throw new Error("缺依赖：npm --prefix var/pwtest i ws");
  ({ WebSocket } = _req(local));
}

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};

const http = async (method, path, body, headers = {}) => {
  const resp = await fetch(CONTROL + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: resp.status, data: await resp.json().catch(() => ({})) };
};
let _tok = "";
const allocToken = async () => {
  if (_tok) return _tok;
  const r = await http("GET", "/status");
  _tok = r.data?.sources?.alloc_token || "";
  return _tok;
};

const st0 = await http("GET", "/status");
// 接入点在 WS mux（settings.ws_port）上，不在控制面端口
const WS_HOST = `127.0.0.1:${st0.data?.ws_port || st0.data?.settings?.ws_port || 9235}`;
const WS = `ws://${WS_HOST}`;
const WSH = `http://${WS_HOST}`; // fetch 探测用（ws: 协议 fetch 不支持）
const eps = Object.fromEntries((st0.data?.endpoints || []).map((e) => [e.path, e]));
check("E0 前置：内置接入点存在", !!eps.standalone && !!eps.extension,
  JSON.stringify(Object.keys(eps)));

// WS 客户端小助手：发命令收响应
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    this.ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
    });
  }
  static async dial(url, headers) {
    console.log("  [dial]", url);
    const ws = new WebSocket(url, { headers });
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    return new Cdp(ws);
  }
  call(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.id;
      this.pending.set(id, res);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

// E3 错误 token（先做：不影响后续）
{
  const resp = await fetch(`${WSH}/standalone/wrong-token-xxxx`, { headers: { Connection: "Upgrade" } }).catch(() => null);
  check("E3 错误 token → HTTP 401", resp && resp.status === 401, `status=${resp?.status}`);
}
// E7 POST /sessions 无令牌
{
  const r = await http("POST", "/sessions", { name: "ep-noauth" });
  check("E7 POST /sessions 无令牌 → 401", r.code === 401, JSON.stringify(r.data).slice(0, 60));
}
// E1 standalone 端点直连
{
  const c = await Cdp.dial(`${WS}/standalone/${eps.standalone.token}`);
  const r = await c.call("Target.getTargets");
  const n = r.result?.targetInfos?.length ?? 0;
  check("E1 端点直连 standalone + 预开 tab", n === 1, `targets=${n}`);
  const st = await http("GET", "/status");
  const s = (st.data?.sessions || []).find((x) => x.name === "standalone");
  check("E1 会话名=端点 path + via 标记", !!s && s.via === "endpoint:standalone", JSON.stringify(s));
  c.close();
}
// E2 extension 端点直连（需扩展回连）
{
  const extConn = st0.data?.sources?.extension?.connected;
  if (extConn) {
    const c = await Cdp.dial(`${WS}/extension/${eps.extension.token}`);
    const r = await c.call("Target.getTargets");
    const n = r.result?.targetInfos?.length ?? 0;
    check("E2 端点直连 extension + 预开 tab", n === 1, `targets=${n}`);
    const st = await http("GET", "/status");
    const s = (st.data?.sessions || []).find((x) => x.name === "extension");
    check("E2 组名 ab: extension", !!s && s.group_name === "ab: extension", JSON.stringify(s));
    c.close();
    await http("POST", "/sessions/extension/release", {});
  } else {
    check("E2 端点直连 extension（扩展未回连，跳过）", true, "extension not connected");
  }
}
// E4 Bearer 等价
{
  const resp = await fetch(`${WSH}/standalone`, {
    headers: { Connection: "Upgrade", Authorization: `Bearer ${eps.standalone.token}` },
  }).catch(() => null);
  // fetch 不做 WS 升级：期望非 401（升级握手失败即可证明认证通过）
  check("E4 Bearer 头认证通过（非 401）", resp && resp.status !== 401, `status=${resp?.status}`);
}
// E5 重置 → 旧拒新通
{
  const r = await http("POST", "/endpoints/standalone/reset-token", {});
  const newTok = r.data?.token;
  check("E5a 重置返回新令牌", !!newTok && newTok !== eps.standalone.token);
  const resp = await fetch(`${WSH}/standalone/${eps.standalone.token}`).catch(() => null);
  check("E5b 旧令牌被拒（401）", resp && resp.status === 401, `status=${resp?.status}`);
  const c = await Cdp.dial(`${WS}/standalone/${newTok}`);
  const r2 = await c.call("Target.getTargets");
  check("E5c 新令牌可用", !!r2.result?.targetInfos);
  c.close();
  await http("POST", "/sessions/standalone/release", {});
}
// E6 自定义接入点
{
  const path = "smoke" + Date.now().toString(36).slice(-4);
  const put = await http("PUT", "/settings", {
    endpoints: [
      ...Object.values(eps).map((e) => ({ path: e.path, source: e.source, session: e.session || "" })),
      { path, source: "extension", session: path + "-ws" },
    ],
  }, { Authorization: "" });
  check("E6a 添加自定义接入点", put.code === 200 && (put.data?.endpoints || []).some((e) => e.path === path),
    put.code === 200 ? "" : JSON.stringify(put.data).slice(0, 80));
  if (put.code === 200) {
    const created = put.data.endpoints.find((e) => e.path === path);
    check("E6b 新接入点自动生成令牌", (created?.token || "").length >= 16);
    const extConn = st0.data?.sources?.extension?.connected;
    if (extConn) {
      const c = await Cdp.dial(`${WS}/${path}/${created.token}`);
      const r = await c.call("Target.getTargets");
      const st = await http("GET", "/status");
      const s = (st.data?.sessions || []).find((x) => x.name === path + "-ws");
      check("E6c 自定义 session 名生效 + 连接", !!r.result?.targetInfos && !!s && s.via === `endpoint:${path}`,
        JSON.stringify(s));
      c.close();
      await http("POST", `/sessions/${path}-ws/release`, {});
    } else {
      check("E6c 自定义接入点（扩展未回连，跳过连接）", true);
    }
    // 清理：还原内置两条
    await http("PUT", "/settings", {
      endpoints: Object.values(eps).map((e) => ({ path: e.path, source: e.source, session: e.session || "" })),
    });
  }
}
// E8 顶替
{
  const st = await http("GET", "/status");
  const tok = st.data?.endpoints?.find((e) => e.path === "standalone")?.token;
  const c1 = await Cdp.dial(`${WS}/standalone/${tok}`);
  let closed = false;
  c1.ws.on("close", () => { closed = true; });
  await new Promise((r) => setTimeout(r, 200));
  const c2 = await Cdp.dial(`${WS}/standalone/${tok}`);
  await new Promise((r) => setTimeout(r, 300));
  check("E8 同端点第二连接顶替第一连接", closed);
  c2.close();
  await http("POST", "/sessions/standalone/release", {});
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "接入点冒烟全部通过 ✅" : "存在失败 ❌"}（${pass}/${results.length}）`);
process.exit(results.every(Boolean) ? 0 : 1);
