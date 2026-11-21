// options.js — cdp-ext 扩展配置页逻辑（持久化于 chrome.storage.local）。
// 配置项：
//   - relayUrl：cdproxy 反向接入地址（生产默认 ws://127.0.0.1:9225/ext；测试常用 9235）
//   - token：与 cdproxy settings.sources.token 一致的准入令牌
//   - releasePolicy：会话 release 处置策略（close=全关删组 / mark=灰组墓碑可复活 / keep=保留）
const DEFAULT_RELAY = "ws://127.0.0.1:9235/ext";
const DEFAULT_TOKEN = "dev";

const relayInput = document.getElementById("relayUrl");
const tokenInput = document.getElementById("token");
const releasePolicyInput = document.getElementById("releasePolicy");

chrome.storage.local.get(["relayUrl", "token", "releasePolicy"]).then((got) => {
  relayInput.value = got.relayUrl || DEFAULT_RELAY;
  tokenInput.value = got.token ?? DEFAULT_TOKEN;
  releasePolicyInput.value = got.releasePolicy || "close";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    relayUrl: relayInput.value.trim() || DEFAULT_RELAY,
    token: tokenInput.value.trim(),
    releasePolicy: releasePolicyInput.value,
  });
  const saved = document.getElementById("saved");
  saved.style.visibility = "visible";
  setTimeout(() => (saved.style.visibility = "hidden"), 1500);
});
