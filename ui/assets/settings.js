// assets/settings.js — 提示词优化设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { openUpdateNotice } from "./update-notice.js";
import { initHostThemeSync } from "./theme-sync.js";
import { loadFixes, saveFixes, DEFAULT_FIXES, PRESET_FIXES, hasFix, newFixId } from "./fixes.js";

hana.ready();

// 主题跟随宿主窗口：与其它页面共用同一套，不各自读 iframe URL 里的初值
initHostThemeSync();

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

// ---------------------------------------------------------------- 卡片上的改法
// 卡片和这里读写的是同一份本机配置（assets/fixes.js），改完卡片下次打开就是新的。

let fixes = loadFixes();

const fxStatus = $("fxStatus");

function setFxStatus(text, cls = "") {
  fxStatus.textContent = text;
  fxStatus.className = "st-status" + (cls ? " " + cls : "");
}

function persist(note) {
  saveFixes(fixes);
  if (note) setFxStatus(note, "ok");
}

function makeInput(value, className, title, onCommit) {
  const input = document.createElement("input");
  input.className = className;
  input.type = "text";
  input.value = value;
  input.title = title;
  input.spellcheck = false;
  input.addEventListener("change", onCommit(input));
  return input;
}

function renderFx() {
  // 当前清单：一行一个改法，「按钮上的字」和「勾上后让模型做什么」都能直接改
  const list = $("fxList");
  list.replaceChildren();

  if (!fixes.length) {
    const empty = document.createElement("p");
    empty.className = "fx-empty";
    empty.textContent = "清单是空的，卡片上不会出现任何改法。";
    list.appendChild(empty);
  }

  fixes.forEach((fix, index) => {
    const row = document.createElement("div");
    row.className = "fx-row";

    const labelInput = makeInput(fix.label, "fx-input fx-input-label", "按钮上的字", (input) => () => {
      const next = input.value.trim() || fixes[index].prompt.slice(0, 12);
      fixes[index] = { ...fixes[index], label: next };
      input.value = next;
      persist("已保存");
    });

    const promptInput = makeInput(fix.prompt, "fx-input", "勾上后让模型做什么", (input) => () => {
      const next = input.value.trim() || fixes[index].prompt;
      fixes[index] = { ...fixes[index], prompt: next };
      input.value = next;
      persist("已保存");
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "fx-del";
    del.textContent = "×";
    del.title = "从清单里移除";
    del.addEventListener("click", () => {
      fixes = fixes.filter((_, i) => i !== index);
      persist("已移除");
      renderFx();
    });

    row.append(labelInput, promptInput, del);
    list.appendChild(row);
  });

  // 可选预设：已经在清单里的置灰，避免重复加
  const presets = $("fxPresets");
  presets.replaceChildren();
  for (const preset of PRESET_FIXES) {
    const already = hasFix(fixes, preset.id);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "fx-preset" + (already ? " is-in" : "");
    btn.textContent = preset.label;
    btn.title = preset.prompt;
    btn.disabled = already;
    btn.addEventListener("click", () => {
      if (hasFix(fixes, preset.id)) return;
      fixes = fixes.concat({ ...preset });
      persist("已加入");
      renderFx();
    });
    presets.appendChild(btn);
  }
}

$("fxAdd")?.addEventListener("click", () => {
  const label = $("fxLabel").value.trim();
  const prompt = $("fxPrompt").value.trim();
  if (!prompt) {
    setFxStatus("「勾上后让模型做什么」不能空着", "err");
    $("fxPrompt").focus();
    return;
  }
  fixes = fixes.concat({ id: newFixId(), label: label || prompt.slice(0, 12), prompt });
  $("fxLabel").value = "";
  $("fxPrompt").value = "";
  persist("已加入");
  renderFx();
});

$("fxReset")?.addEventListener("click", () => {
  fixes = DEFAULT_FIXES.map((item) => ({ ...item }));
  persist("已恢复默认六个");
  renderFx();
});

renderFx();
$("aboutUpdate")?.addEventListener("click", () => openUpdateNotice());
load();
