// assets/settings.js — 提示词优化设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」。只 import 而不调用 ready，页面会卡在失败态。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { openUpdateNotice } from "./update-notice.js";

hana.ready();

const DEFAULT_REPO = "youyongdemao/HanaAgent-prompt-optimizer";

const $ = (id) => document.getElementById(id);
const repoEl = $("stRepo");
const saveEl = $("stSave");
const resetEl = $("stReset");
const statusEl = $("stStatus");

function setStatus(text, cls = "") {
  statusEl.textContent = text;
  statusEl.className = "st-status" + (cls ? " " + cls : "");
}

/** 仓库地址同时决定「关于」里的 GitHub 链接指向 */
function applyRepo(repo) {
  const value = typeof repo === "string" && repo.trim() ? repo.trim() : DEFAULT_REPO;
  repoEl.value = value;
  const link = $("aboutGithub");
  if (link) {
    link.href = `https://github.com/${value}`;
    link.textContent = value;
  }
}

async function load() {
  saveEl.disabled = true;
  try {
    const meta = await apiFetch("meta", {}, 8000);
    if (meta?.version) $("aboutVersion").textContent = "v" + meta.version;
  } catch {
    /* 读不到版本时保持占位 */
  }
  try {
    const res = await apiFetch("config", {}, 8000);
    applyRepo(res?.config?.githubRepo);
    setStatus("");
  } catch (error) {
    setStatus("读取配置失败：" + String(error?.message || error), "err");
  } finally {
    // 读配置期间先把保存键按住，读完必须放开：否则点它会毫无反应
    saveEl.disabled = false;
  }
}

saveEl.addEventListener("click", async () => {
  saveEl.disabled = true;
  setStatus("保存中…");
  try {
    const res = await apiFetch(
      "config",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubRepo: repoEl.value.trim() }),
      },
      8000,
    );
    applyRepo(res?.config?.githubRepo);
    setStatus("已保存", "ok");
  } catch (error) {
    setStatus("保存失败：" + String(error?.message || error), "err");
  } finally {
    // 无论成败都要放开：存一次就锁死的话，用户改第二次就没辙了
    saveEl.disabled = false;
  }
});

resetEl.addEventListener("click", () => {
  applyRepo(DEFAULT_REPO);
  setStatus("已恢复默认，点「保存」生效");
});

repoEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") saveEl.click();
});

$("aboutUpdate")?.addEventListener("click", () => openUpdateNotice());

load();
