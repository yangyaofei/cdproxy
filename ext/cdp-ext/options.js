// options.js — 扩展配置页逻辑（relay URL + token 存 chrome.storage.local）。
const DEFAULT_RELAY = "ws://127.0.0.1:9235/ext";
const DEFAULT_TOKEN = "dev";

const relayInput = document.getElementById("relayUrl");
const tokenInput = document.getElementById("token");

chrome.storage.local.get(["relayUrl", "token"]).then((got) => {
  relayInput.value = got.relayUrl || DEFAULT_RELAY;
  tokenInput.value = got.token ?? DEFAULT_TOKEN;
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    relayUrl: relayInput.value.trim() || DEFAULT_RELAY,
    token: tokenInput.value.trim(),
  });
  const saved = document.getElementById("saved");
  saved.style.visibility = "visible";
  setTimeout(() => (saved.style.visibility = "hidden"), 1500);
});
