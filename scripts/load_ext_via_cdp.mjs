#!/usr/bin/env node
// load_ext_via_cdp.mjs — 通过 CDP Extensions.loadUnpacked 给运行中的
// Chromium 加载未打包扩展（Chrome 139+ 屏蔽了 --load-extension 的替代方案，
// 前提：浏览器带 --enable-unsafe-extension-debugging 启动）。
//
// 用法: node scripts/load_ext_via_cdp.mjs <cdp-http-endpoint> <extension-abs-path>
// 例:  node scripts/load_ext_via_cdp.mjs http://127.0.0.1:9333 "$PWD/ext/cdp-ext"

const [endpoint, extPath] = process.argv.slice(2);
if (!endpoint || !extPath) {
  console.error("用法: node load_ext_via_cdp.mjs <cdp-http-endpoint> <extension-abs-path>");
  process.exit(2);
}

const ver = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = (e) => rej(new Error("浏览器级 WS 连接失败: " + e.message));
});

const reply = await new Promise((res, rej) => {
  ws.onmessage = (ev) => res(JSON.parse(ev.data));
  ws.send(JSON.stringify({ id: 1, method: "Extensions.loadUnpacked", params: { path: extPath } }));
  setTimeout(() => rej(new Error("Extensions.loadUnpacked 应答超时")), 10_000);
});
ws.close();

if (reply.error) {
  console.error("加载失败:", JSON.stringify(reply.error));
  process.exit(1);
}
console.log("扩展已加载:", JSON.stringify(reply.result));
