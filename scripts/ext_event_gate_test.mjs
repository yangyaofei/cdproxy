#!/usr/bin/env node
// 事件准入（组=唯一真相）验证：G1-G5
//   G1 用户 tab 静默：组外 tab 的创建/关闭不进入事件流（SW send 计数不增）
//   G2 创建单出口：会话预开 tab 恰好产生 1 条 targetCreated
//   G3 组员事件照常：组内 tab 的 targetInfoChanged 正常路由
//   G4 组员关闭照常：closeTarget → targetDestroyed 正常路由
//   G5 无主类别不复存在：__unowned__ 日志为空/不存在
// 前置：测试服务（EXT_CONTROL）+ 测试浏览器（EXT_CDP_HTTP，已装新 sw.js）+ 扩展已回连。
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
const _req = createRequire(import.meta.url);
let WebSocket;
try { ({ WebSocket } = _req("ws")); }
catch {
  const local = path.resolve("var/pwtest/node_modules/ws");
  if (!existsSync(local)) throw new Error("缺依赖：npm --prefix var/pwtest i ws");
  ({ WebSocket } = _req(local));
}

const CONTROL = process.env.EXT_CONTROL || "http://127.0.0.1:9234";
const CDP_HTTP = process.env.EXT_CDP_HTTP || "http://127.0.0.1:9333";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
};
const http = async (method, p, body, headers = {}) => {
  const resp = await fetch(CONTROL + p, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { code: resp.status, data: await resp.json().catch(() => ({})) };
};
const allocToken = async () => (await http("GET", "/status")).data?.sources?.alloc_token;

// 浏览器自身 CDP：开/关组外 tab（模拟用户手动开 tab）
const browserCdp = async (method, params = {}) => {
  const list = await (await fetch(`${CDP_HTTP}/json/list`)).json();
  const page = list.find((x) => x.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const r = await new Promise((res) => {
    const id = 1;
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === id) res(m); };
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.close();
  return r;
};

// 客户端：alloc 后收事件计数
class Client {
  constructor(ws) { this.ws = ws; this.events = []; this.id = 0; this.pending = new Map();
    this.ws.on("message", (d) => {
      const m = JSON.parse(d);
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      else if (m.method) this.events.push(m);
    });
  }
  static async dial(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
    return new Client(ws);
  }
  call(method, params = {}, sessionId) {
    return new Promise((res) => {
      const id = ++this.id; this.pending.set(id, res);
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
}

const st0 = await http("GET", "/status");
const wsPort = st0.data?.ws_port || 9235;
const tok = await allocToken();

// G5 前置基线：无主日志应不存在/为空
{
  const r = await http("GET", "/sessions/__unowned__/logs?limit=50");
  const n = (r.data?.entries || []).length;
  check("G5 无主日志为空", n === 0, `entries=${n}`);
}

// G1 用户 tab 静默（端到端：连接中的客户端事件流不出现组外 tab 的任何事件）
{
  const name = "gatesilence" + Date.now().toString(36).slice(-4);
  const alloc = await http("POST", "/sessions", { name }, { Authorization: `Bearer ${tok}` });
  const client = await Client.dial(alloc.data.cdpUrl.replace("9225", String(wsPort)));
  await client.call("Target.getTargets"); // 播种完毕
  const before = client.events.length;
  const created = await browserCdp("Target.createTarget", { url: "about:blank?gate-user-tab" });
  const tid = created.result?.targetId;
  await new Promise((r) => setTimeout(r, 1200));
  const mid = client.events.length;
  await browserCdp("Target.closeTarget", { targetId: tid });
  await new Promise((r) => setTimeout(r, 1200));
  const after = client.events.length;
  check("G1 组外 tab 创建/关闭静默（客户端事件流无变化）",
    mid === before && after === mid, `before=${before} mid=${mid} after=${after}`);
  client.ws.close();
  await http("POST", `/sessions/${name}/release`, {});
}

// G2-G4 会话链路
{
  const name = "gate" + Date.now().toString(36).slice(-4);
  const alloc = await http("POST", "/sessions", { name }, { Authorization: `Bearer ${tok}` });
  const client = await Client.dial(alloc.data.cdpUrl.replace("9225", String(wsPort)));
  // G2：alloc 应答回来时归属已就绪（创建单出口的另一半验证）——连接即见恰好 1 tab
  const tg0 = await client.call("Target.getTargets");
  const visible = tg0.result.targetInfos.length;
  check("G2 预开 tab 连接即见且恰好 1 个", visible === 1, `visible=${visible}`);
  // G3：navigate 组内 tab → targetInfoChanged
  const tg = await client.call("Target.getTargets");
  const tid = tg.result.targetInfos[0]?.targetId;
  const att = await client.call("Target.attachToTarget", { targetId: tid, flatten: true });
  const sid = att.result.sessionId;
  await client.call("Page.navigate", { url: "about:blank?gate-nav" }, sid);
  await new Promise((r) => setTimeout(r, 800));
  const got = client.events.filter((e) => e.method === "Target.targetInfoChanged").length;
  check("G3 组内 targetInfoChanged 照常路由", got >= 1, `infoChanged=${got}`);
  // G4：新建 tab → 关闭 → targetCreated/targetDestroyed 各一次
  const c2 = await client.call("Target.createTarget", { url: "about:blank?gate-new" });
  const tid2 = c2.result.targetId;
  await new Promise((r) => setTimeout(r, 600));
  const created2 = client.events.filter((e) => e.method === "Target.targetCreated"
    && e.params?.targetInfo?.targetId === tid2).length;
  await client.call("Target.closeTarget", { targetId: tid2 });
  await new Promise((r) => setTimeout(r, 800));
  const destroyed2 = client.events.filter((e) => e.method === "Target.targetDestroyed"
    && e.params?.targetId === tid2).length;
  check("G4 客户端建/关 tab 事件对称", created2 === 1 && destroyed2 === 1,
    `created=${created2} destroyed=${destroyed2}`);
  client.ws.close();
  await http("POST", `/sessions/${name}/release`, {});
}

// G5 复查：跑完全链路后无主日志仍为空
{
  const r = await http("GET", "/sessions/__unowned__/logs?limit=50");
  const n = (r.data?.entries || []).length;
  check("G5 复查：全链路后无主日志仍为空", n === 0, `entries=${n}`);
}

const pass = results.filter(Boolean).length;
console.log(`\n${pass === results.length ? "事件准入验证全部通过 ✅" : "存在失败 ❌"}（${pass}/${results.length}）`);
process.exit(results.every(Boolean) ? 0 : 1);
