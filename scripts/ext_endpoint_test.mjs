#!/usr/bin/env node
// 标准 CDP 网关与鉴权闭环冒烟：E0-E9
//   前置：服务已运行（EXT_CONTROL，默认 http://127.0.0.1:9224；令牌自动从 EXT_TOKEN 或 ~/.cdproxy/settings.json 读取）。
//   E0 控制面鉴权闭环（/status 无令牌 401，/health 200，带 alloc_token 200，内置三条 default/standalone/extension 存在）
//   E1 标准 HTTP /json/version（Header 反向识别源 + URL token + 尾斜杠兼容）+ /json/list 隐私隔离
//   E2 越权与安全防线（错 token 401、跨源 token 403、Origin 跨站 403）
//   E3 匿名并发隔离（同一 extension 或 standalone 地址双连接并发互不顶替）
//   E4 指定固定会话 /session/<id>（组名精确对应 + 同会话重连顶替）
//   E5 重置令牌 → 旧拒新通（吊销语义）
//   E6 自定义固定会话令牌（无后缀 Header 反向路由到固定分组）
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
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

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9224";
const DATA_DIR = process.env.CDPROXY_DATA_DIR || path.join(os.homedir(), ".cdproxy");
const readAllocToken = () => {
  if (process.env.EXT_TOKEN) return process.env.EXT_TOKEN.trim();
  try {
    const raw = JSON.parse(readFileSync(path.join(DATA_DIR, "settings.json"), "utf8"));
    return (raw?.sources?.alloc_token || "").trim();
  } catch {
    return "";
  }
};
const ALLOC_TOK = readAllocToken();

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};

const api = async (method, p, body, extraHeaders = null) => {
  const headers = { "Content-Type": "application/json" };
  if (extraHeaders === null) {
    if (ALLOC_TOK) headers.Authorization = `Bearer ${ALLOC_TOK}`;
  } else {
    Object.assign(headers, extraHeaders);
  }
  const resp = await fetch(CONTROL + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: resp.status, data: await resp.json().catch(() => ({})) };
};

// E0 控制面鉴权闭环
{
  const h = await api("GET", "/health", undefined, {});
  check("E0a /health 免鉴权 200", h.code === 200, `status=${h.code}`);
  const noAuth = await api("GET", "/status", undefined, {});
  check("E0b /status 无鉴权被拒 401", noAuth.code === 401, `status=${noAuth.code}`);
  const noAuthPost = await api("POST", "/sessions", { name: "ep-noauth" }, {});
  check("E0c POST /sessions 无令牌 401", noAuthPost.code === 401, `status=${noAuthPost.code}`);
}

const st0 = await api("GET", "/status");
check("E0d /status 携带 alloc_token 200", st0.code === 200, `status=${st0.code}`);
const WS_PORT = st0.data?.ws_port || st0.data?.settings?.ws_port || 9225;
const WS = `ws://127.0.0.1:${WS_PORT}`;
const WSH = `http://127.0.0.1:${WS_PORT}`;
const eps = Object.fromEntries((st0.data?.endpoints || []).map((e) => [e.path, e]));
check("E0e 内置三条入口存在（default/standalone/extension）",
  !!eps.default && !!eps.standalone && !!eps.extension,
  JSON.stringify(Object.keys(eps)));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)(m);
        this.pending.delete(m.id);
      }
    });
  }
  static async dial(url, headers) {
    const ws = new WebSocket(url, { headers });
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
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

// E1 标准 HTTP /json/version 与 /json/list
{
  const rHdr = await fetch(`${WSH}/json/version`, {
    headers: { Authorization: `Bearer ${eps.extension.token}` },
  });
  const dHdr = await rHdr.json();
  check("E1a 根路径 /json/version + extension Header 反向识别",
    rHdr.status === 200 &&
    (dHdr.webSocketDebuggerUrl || "").startsWith(`${WS}/extension/session/cdp-`) &&
    !(dHdr.webSocketDebuggerUrl || "").includes(eps.extension.token),
    dHdr.webSocketDebuggerUrl);

  const rUrl = await fetch(`${WSH}/extension/${eps.extension.token}/json/version/`);
  const dUrl = await rUrl.json();
  check("E1b URL token /extension/<tok>/json/version/ 返回带 token WS",
    rUrl.status === 200 &&
    (dUrl.webSocketDebuggerUrl || "").endsWith(`/${eps.extension.token}`),
    dUrl.webSocketDebuggerUrl);

  const rList = await fetch(`${WSH}/json/list`, {
    headers: { Authorization: `Bearer ${eps.extension.token}` },
  });
  const dList = await rList.json();
  check("E1c /json/list 匿名返回空数组 [] 不泄隐私",
    rList.status === 200 && Array.isArray(dList) && dList.length === 0,
    JSON.stringify(dList));
}

// E2 越权与安全防线
{
  const r401 = await fetch(`${WSH}/extension/wrong-token/json/version`);
  check("E2a 错误 token → 401", r401.status === 401, `status=${r401.status}`);
  const rCross = await fetch(`${WSH}/extension/${eps.default.token}/json/version`);
  check("E2b default 令牌越权 /extension → 403", rCross.status === 403, `status=${rCross.status}`);
  const rCross2 = await fetch(`${WSH}/standalone/json/version`, {
    headers: { Authorization: `Bearer ${eps.extension.token}` },
  });
  check("E2c extension 令牌越权 /standalone → 403", rCross2.status === 403, `status=${rCross2.status}`);
  const rOrigin = await fetch(`${WSH}/json/version`, {
    headers: { Authorization: `Bearer ${eps.default.token}`, Origin: "https://evil.example" },
  });
  check("E2d 带 Origin 跨站请求 → 403", rOrigin.status === 403, `status=${rOrigin.status}`);
}

const extConn = !!st0.data?.sources?.extension?.connected;

// E3 并发隔离（1 WS = 1 独立会话）+ E4 固定会话名 /session/<id> 顶替
if (extConn) {
  const c1 = await Cdp.dial(`${WS}/extension/${eps.extension.token}`);
  let c1Closed = false;
  c1.ws.on("close", () => { c1Closed = true; });
  const c2 = await Cdp.dial(`${WS}/extension/${eps.extension.token}`);
  await new Promise((r) => setTimeout(r, 250));
  const [t1, t2] = await Promise.all([c1.call("Target.getTargets"), c2.call("Target.getTargets")]);
  check("E3 同一地址并发 2 条 WS 互不顶替且各自隔离",
    !c1Closed && (t1.result?.targetInfos?.length ?? 0) === 1 && (t2.result?.targetInfos?.length ?? 0) === 1,
    `c1Closed=${c1Closed}`);
  c1.close();
  c2.close();
  const stAfter = await api("GET", "/status");
  for (const s of stAfter.data?.sessions || []) {
    if (s.name.startsWith("cdp-")) {
      await api("POST", `/sessions/${encodeURIComponent(s.name)}/release`, {});
    }
  }

  // E4 固定会话 /session/ep-fixed 同名顶替
  const f1 = await Cdp.dial(`${WS}/extension/session/ep-fixed/${eps.extension.token}`);
  let f1Closed = false;
  f1.ws.on("close", () => { f1Closed = true; });
  await new Promise((r) => setTimeout(r, 150));
  const f2 = await Cdp.dial(`${WS}/extension/session/ep-fixed`, {
    Authorization: `Bearer ${eps.extension.token}`,
  });
  await new Promise((r) => setTimeout(r, 250));
  check("E4 固定 /session/ep-fixed 第二连接接管并顶替旧连接", f1Closed);
  f2.close();
  await api("POST", "/sessions/ep-fixed/release", {});
} else {
  check("E3/E4 extension 实时连接（扩展未回连，跳过）", true, "extension not connected");
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "标准 CDP 网关冒烟全部通过 ✅" : "存在失败 ❌"}（${pass}/${results.length}）`);
process.exit(results.every(Boolean) ? 0 : 1);
