#!/usr/bin/env node
// sw_eval.mjs — 在扩展 SW（或任意 target）里执行表达式并回显结果（调试用）。
// SW target attach 后可能处于等待调试器状态：先 runIfWaitingForDebugger 放行，
// 再等 evaluate 应答（忽略其间的通知类消息）。
// 用法: node scripts/sw_eval.mjs <cdp-http-endpoint> <url-substr> '<表达式>'

const [endpoint, substr, expr] = process.argv.slice(2);
const targets = await (await fetch(`${endpoint}/json/list`)).json();
const t = targets.find((x) => x.url.includes(substr));
if (!t) {
  console.error("未找到目标，现有 targets:", targets.map((x) => x.type + " " + x.url).join("\n"));
  process.exit(1);
}
console.error("attached:", t.type, t.url);

const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("attach 失败")); });

const reply = await new Promise((res, rej) => {
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id === 1) res(msg);
  };
  ws.send(JSON.stringify({ id: 2, method: "Runtime.runIfWaitingForDebugger" }));
  ws.send(JSON.stringify({
    id: 1, method: "Runtime.evaluate",
    params: { expression: expr, returnByValue: true, awaitPromise: true },
  }));
  setTimeout(() => rej(new Error("evaluate 应答超时")), 15_000);
});
console.log(JSON.stringify(reply.result?.result ?? reply, null, 2));
ws.close();
