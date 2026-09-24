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

/** 勾选上限：卡片那一排摆不下更多了 */
const MAX_ON = 8;

let dirty = false;

function markDirty() {
  dirty = true;
  setFxStatus("有未保存的修改", "warn");
}

function persist(note) {
  saveFixes(fixes);
  if (note) setFxStatus(note, "ok");
}

function makeInput(value, className, placeholder, title, onCommit) {
  const input = document.createElement("input");
  input.className = className;
  input.type = "text";
  input.value = value;
  input.placeholder = placeholder;
  input.title = title;
  input.spellcheck = false;
  input.addEventListener("change", onCommit(input));
  return input;
}

function renderFx() {
  // 一张清单管全部：前面是提示词，后面是解释补充（可空），右边勾选与删除
  const list = $("fxList");
  list.replaceChildren();

  if (!fixes.length) {
    const empty = document.createElement("p");
    empty.className = "fx-empty";
    empty.textContent = "清单是空的，卡片上不会出现任何提示词。";
    list.appendChild(empty);
  }

  fixes.forEach((fix, index) => {
    const row = document.createElement("div");
    row.className = "fx-row";

    const labelInput = makeInput(fix.label, "fx-input fx-input-label", "请输入提示词", "显示在按钮上的字", (input) => () => {
      const next = input.value.trim() || fixes[index].label;
      fixes[index] = { ...fixes[index], label: next };
      input.value = next;
      markDirty();
    });

    const promptInput = makeInput(fix.prompt, "fx-input fx-input-desc", "解释补充（可空）", "给模型的解释补充；留空就直接把提示词本身交给模型", (input) => () => {
      fixes[index] = { ...fixes[index], prompt: input.value.trim() };
      markDirty();
    });

    // 开关：开着的才会上卡片
    const sw = document.createElement("label");
    sw.className = "fx-switch";
    sw.title = `上卡片的提示词，最多同时开 ${MAX_ON} 项`;
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!fix.on;
    box.addEventListener("change", () => {
      if (box.checked && fixes.filter((f) => f.on).length >= MAX_ON) {
        box.checked = false;
        setFxStatus(`最多同时开 ${MAX_ON} 项`, "err");
        return;
      }
      fixes[index] = { ...fixes[index], on: box.checked };
      markDirty();
    });
    const track = document.createElement("span");
    track.className = "fx-switch-track";
    sw.append(box, track);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "fx-del";
    del.textContent = "×";
    del.title = "从清单里移除";
    del.addEventListener("click", () => {
      fixes = fixes.filter((_, i) => i !== index);
      markDirty();
      renderFx();
    });

    row.append(del, labelInput, promptInput, sw);
    list.appendChild(row);
  });
}

$("fxAdd")?.addEventListener("click", () => {
  const label = $("fxLabel").value.trim();
  const prompt = $("fxPrompt").value.trim();
  if (!label) {
    setFxStatus("「请输入提示词」不能空着", "err");
    $("fxLabel").focus();
    return;
  }
  // 手加的一条插在列表第一条；解释补充留空就直接用提示词本身，不做额外改写
  const on = fixes.filter((f) => f.on).length < MAX_ON;
  fixes = [{ id: newFixId(), label, prompt: prompt || label, on }, ...fixes];
  $("fxLabel").value = "";
  $("fxPrompt").value = "";
  markDirty();
  renderFx();
});

$("fxReset")?.addEventListener("click", () => {
  fixes = DEFAULT_FIXES.map((item) => ({ ...item }));
  markDirty();
  renderFx();
});

$("fxSave")?.addEventListener("click", () => {
  saveFixes(fixes);
  dirty = false;
  setFxStatus("已保存", "ok");
});

renderFx();
$("aboutUpdate")?.addEventListener("click", () => openUpdateNotice());
load();
