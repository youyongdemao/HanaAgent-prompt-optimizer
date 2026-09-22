// assets/settings.js — 提示词优化设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」。只 import 而不调用 ready，页面会卡在失败态。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { openUpdateNotice } from "./update-notice.js";

hana.ready();

const $ = (id) => document.getElementById(id);

/** 版本与仓库地址都来自后端写死的那份，界面不提供修改入口 */
async function load() {
  try {
    const meta = await apiFetch("meta", {}, 8000);
    if (meta?.version) $("aboutVersion").textContent = "v" + meta.version;
    const link = $("aboutGithub");
    if (link && typeof meta?.repo === "string" && meta.repo) {
      link.href = `https://github.com/${meta.repo}`;
      link.textContent = meta.repo;
    }
  } catch {
    /* 读不到就保持占位，不打断页面 */
  }
}

$("aboutUpdate")?.addEventListener("click", () => openUpdateNotice());

load();
