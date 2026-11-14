#!/usr/bin/env node
// sw_ws_probe.mjs — 在扩展 SW 里发起 WS 探测并收集 console/network 报错，
// 用于定位浏览器拒绝 WS 的真实原因（CSP/PNA/代理等）。
// 用法: node scripts/sw_ws_probe.mjs <cdp-http-endpoint> <ws-url>

const [endpoint, wsURL] = process.argv.slice(2);
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const t = targets.find((x) => x.url.includes("sw.js"));
if (!t) { console.error("SW target 未找到"); process.exit(1); }

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("attach 失败")); });

const entries = [];
let nextId = 1;
const send = (method, params = {}) => {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return id;
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === "Runtime.consoleAPICalled") {
    entries.push(["console." + msg.params.type,
      msg.params.args.map((a) => a.value ?? a.description ?? "").join(" ")]);
  } else if (msg.method === "Log.entryAdded") {
    const e = msg.params.entry;
    entries.push(["log." + e.level, `${e.source}/${e.url || ""} ${e.text}`]);
  } else if (msg.method === "Runtime.exceptionThrown") {
    entries.push(["exception", JSON.stringify(msg.params.exceptionDetails)]);
  }
};

send("Runtime.runIfWaitingForDebugger");
send("Runtime.enable");
send("Log.enable");
send("Runtime.evaluate", {
  expression: `(async () => {
    const log = [];
    const w = new WebSocket(${JSON.stringify(wsURL)});
    w.onopen = () => console.warn("[probe] open");
    w.onerror = () => console.warn("[probe] error");
    w.onclose = (e) => console.warn("[probe] close " + e.code + " '" + e.reason + "'");
    await new Promise((r) => setTimeout(r, 4000));
    return "probe done";
  })()`,
  awaitPromise: true, returnByValue: true,
});

await new Promise((r) => setTimeout(r, 6000));
console.log(JSON.stringify(entries, null, 2));
ws.close();
