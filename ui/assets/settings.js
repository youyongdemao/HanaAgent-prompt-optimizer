// assets/settings.js — 提示词优化设置页
// 必须 import SDK 并调用 hana.ready()：宿主收到这条 ready 消息才认页面就绪，
// 5 秒内收不到就一律显示「应用加载失败」。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";
import { openUpdateNotice } from "./update-notice.js";
import { initHostThemeSync } from "./theme-sync.js";
import { loadFixes, loadSuggest, pullConfig, pushConfig, pushSuggest, DEFAULT_FIXES, newFixId } from "./fixes.js";
import { loadCustomStyles, pullStyles, pushStyles, newStyleId, STYLE_LABEL_MAX } from "./styles.js";
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
let suggestOn = loadSuggest();

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
    empty.textContent = "这里还什么都没有~";
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

// 「根据内容主题推荐」开关：不等「保存修改」，拨一下就落盘（清单不动）。
// 卡片那侧监听了 App 存储变更，改完不用重开卡片就是新的。
const suggestBox = $("fxSuggest");
if (suggestBox) suggestBox.checked = suggestOn;
suggestBox?.addEventListener("change", async () => {
  suggestOn = suggestBox.checked;
  // 清单那份的未保存状态与这个开关无关：先记下来，落盘完再把提示放回去
  const pendingItems = dirty;
  setFxStatus("保存中…");
  const r = await pushSuggest(suggestOn);
  if (!r.ok) {
    setFxStatus(`开关没存到 App 那一侧（HTTP ${r.status || "网络异常"}），已留在本机`, "err");
    return;
  }
  if (pendingItems) setFxStatus("有未保存的修改", "warn");
  else setFxStatus(suggestOn ? "已开启" : "已关闭", "ok");
});

$("fxSave")?.addEventListener("click", async () => {
  setFxStatus("保存中…");
  const r = await pushConfig(fixes, suggestOn);
  dirty = false;
  setFxStatus(
    r.ok ? "已保存" : `没存到 App 那一侧（HTTP ${r.status || "网络异常"}），已留在本机`,
    r.ok ? "ok" : "err",
  );
});

renderFx();
$("aboutUpdate")?.addEventListener("click", () => openUpdateNotice());
load();

// 清单的真身在 App 那一侧，本地那份只是缓存：启动后拉一次对齐
void pullConfig().then((remote) => {
  if (!remote) return;
  if (remote.items) fixes = remote.items;
  suggestOn = remote.suggest;
  if (suggestBox) suggestBox.checked = suggestOn;
  renderFx();
});

// ---------------------------------------------------------------- 自定义场景
// 与上面那块同构：一份清单 + 一个添加行 + 保存按钮。
// 区别是每条多一栏「取向说明」——场景最后要落成系统提示里的一句话，
// 只有名字的场景点下去等于没点，所以说明必填。

let customStyles = loadCustomStyles();
let stylesDirty = false;

const stStatus = $("stStatus");
function setStStatus(text, cls = "") {
  if (!stStatus) return;
  stStatus.textContent = text;
  stStatus.className = "st-status" + (cls ? " " + cls : "");
}

function markStylesDirty() {
  stylesDirty = true;
  setStStatus("有未保存的修改", "warn");
}

function renderStyles() {
  const list = $("stList");
  if (!list) return;
  list.replaceChildren();

  if (!customStyles.length) {
    const empty = document.createElement("p");
    empty.className = "fx-empty";
    empty.textContent = "还没有自己的场景呢~";
    list.appendChild(empty);
  }

  customStyles.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "fx-row st-row";

    const del = document.createElement("button");
    del.type = "button";
    del.className = "fx-del";
    del.textContent = "×";
    del.title = "从场景里移除";
    del.addEventListener("click", () => {
      customStyles = customStyles.filter((_, i) => i !== index);
      markStylesDirty();
      renderStyles();
    });

    const nameInput = makeInput(
      item.label,
      "fx-input fx-input-label",
      "场景名",
      "显示在胶囊上的名字",
      (input) => () => {
        const next = input.value.trim().slice(0, STYLE_LABEL_MAX) || item.label;
        customStyles[index] = { ...customStyles[index], label: next };
        input.value = next;
        markStylesDirty();
      },
    );

    const hintInput = makeInput(
      item.hint,
      "fx-input",
      "这个场景往哪边写",
      "给模型看的一句取向说明",
      (input) => () => {
        customStyles[index] = { ...customStyles[index], hint: input.value.trim() };
        markStylesDirty();
      },
    );

    const gap = document.createElement("span");
    gap.className = "fx-add-gap";

    row.append(del, nameInput, hintInput, gap);
    list.appendChild(row);
  });
}

$("stAdd")?.addEventListener("click", () => {
  const label = $("stName").value.trim().slice(0, STYLE_LABEL_MAX);
  const hint = $("stHint").value.trim();
  if (!label) {
    setStStatus("场景名不能空着", "err");
    $("stName").focus();
    return;
  }
  if (!hint) {
    setStStatus("取向说明不能空着，不然模型不知道该往哪边写", "err");
    $("stHint").focus();
    return;
  }
  // 新加的一条插在最前（与提示词清单一致）
  customStyles = [{ id: newStyleId(), label, hint }, ...customStyles];
  $("stName").value = "";
  $("stHint").value = "";
  markStylesDirty();
  renderStyles();
});

$("stSave")?.addEventListener("click", async () => {
  setStStatus("保存中…");
  const r = await pushStyles(customStyles);
  stylesDirty = false;
  setStStatus(
    r.ok ? "已保存" : `没存到 App 那一侧（HTTP ${r.status || "网络异常"}），已留在本机`,
    r.ok ? "ok" : "err",
  );
});

renderStyles();

// 场景的真身也在 App 那一侧：启动后拉一次对齐（本地有未保存改动时不覆盖）
void pullStyles().then((list) => {
  if (!list || stylesDirty) return;
  customStyles = list;
  renderStyles();
});
