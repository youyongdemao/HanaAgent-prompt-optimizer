// 提示词优化 · 卡片前端（v2 App）
// 传输层交给 v2 浏览器 SDK（sdk.js）：协议握手、主题推送、卡片高度上报、宿主能力都在里面。
// 应用自己的后端接口走 app-api.js（/api/apps/prompt-optimizer/routes/）。
import { hana } from "./sdk.js";
import { apiUrl, appHeaders } from "./app-api.js";
import { loadFixes } from "./fixes.js";

async function toast(message, type = "info") {
  try {
    await hana.toast.show({ message, type });
  } catch {
    /* toast 不可用时不打断 */
  }
}

// ---------------------------------------------------------------- 场景预设

const STYLES = [
  { id: "general", label: "通用" },
  { id: "code", label: "编程" },
  { id: "writing", label: "写作" },
  { id: "image", label: "图像" },
  { id: "analysis", label: "分析" },
  { id: "agent", label: "Agent" },
];

// ---------------------------------------------------------------- 主题跟随
// 颜色全部由宿主主题 CSS 派生（CSS 里一律走 color-mix）。
// 这里补两件 JS 才能做的事：
//   1. 从 --bg 亮度判定亮暗 → data-color-mode，暗色下 CSS 会把次级文字提亮一档；
//   2. 按 --accent 的亮度挑主按钮前景色 --po-on-accent（主题不提供这类 token）。

function luminanceOf(value) {
  const raw = String(value || "").trim();
  let r;
  let g;
  let b;
  let m;
  if ((m = /^#([0-9a-f]{3})$/i.exec(raw))) {
    r = parseInt(m[1][0] + m[1][0], 16);
    g = parseInt(m[1][1] + m[1][1], 16);
    b = parseInt(m[1][2] + m[1][2], 16);
  } else if ((m = /^#([0-9a-f]{6})$/i.exec(raw))) {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(raw))) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
    [r, g, b] = parts;
  } else {
    return null;
  }
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastRatio(a, b) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

const DARK_INK = luminanceOf("#1b1f23");

// ---- 主题 CSS 链接 ----------------
// 宿主换主题时不会重载这个 iframe（它的 useMemo 依赖里没有 theme），
// 只会推一条 hana.theme.changed（payload: { theme, cssUrl }）。
// 所以主题链接得这里自己换。

const THEME_CSS_PATH = "/api/apps/theme.css";
const AUTO_LIGHT_THEME = "warm-paper";
const AUTO_DARK_THEME = "midnight";

const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

let currentTheme = "";
let currentThemeCss = "";

function themeCssFor(themeId) {
  return `${THEME_CSS_PATH}?theme=${encodeURIComponent(themeId)}`;
}

function ensureThemeLink() {
  let link = document.getElementById("po-theme-css");
  if (!link) {
    link = document.createElement("link");
    link.id = "po-theme-css";
    link.rel = "stylesheet";
    document.head.appendChild(link);
  }
  return link;
}

function applyThemeCss(theme, cssUrl) {
  const link = ensureThemeLink();
  const t = typeof theme === "string" ? theme.trim() : "";
  if (t && t !== "auto") {
    link.href = typeof cssUrl === "string" && cssUrl ? cssUrl : themeCssFor(t);
    return;
  }
  link.href = themeCssFor(darkQuery && darkQuery.matches ? AUTO_DARK_THEME : AUTO_LIGHT_THEME);
}

function applyHostTheme(theme, cssUrl) {
  if (typeof theme === "string" && theme.trim()) currentTheme = theme.trim();
  if (typeof cssUrl === "string" && cssUrl) currentThemeCss = cssUrl;
  applyThemeCss(currentTheme, currentThemeCss);
}

function syncTheme() {
  const cs = getComputedStyle(document.documentElement);

  // 亮暗判定
  const bgLum = luminanceOf(cs.getPropertyValue("--bg"));
  if (bgLum !== null) {
    const mode = bgLum < 0.42 ? "dark" : "light";
    if (document.documentElement.dataset.colorMode !== mode) {
      document.documentElement.dataset.colorMode = mode;
    }
    if (document.body.dataset.colorMode !== mode) {
      document.body.dataset.colorMode = mode;
    }
  }

  // 主按钮前景色：白与近黑里挑对比度更高的那个
  const accentLum = luminanceOf(cs.getPropertyValue("--accent"));
  if (accentLum !== null && DARK_INK !== null) {
    const useWhite = contrastRatio(accentLum, 1) >= contrastRatio(accentLum, DARK_INK);
    document.documentElement.style.setProperty("--po-on-accent", useWhite ? "#ffffff" : "#1b1f23");
  }
}

// ---------------------------------------------------------------- 鼠标跟踪光晕
// 与 Session Insight 同一套算法（rAF 节流 → --mx/--my 光斑 + --ang 旋转描边），
// 区别是作用面只限按钮。

let glowRaf = null;
let glowX = 0;
let glowY = 0;
let glowPrev = null;

const GLOW_TARGET = ".po-btn, .po-tbtn";

function ensureLayer(parent, cls) {
  for (const child of parent.children) {
    if (child.classList && child.classList.contains(cls)) return child;
  }
  const node = document.createElement("div");
  node.className = cls;
  parent.prepend(node);
  return node;
}

function fadeGlow() {
  if (!glowPrev) return;
  glowPrev.spot.style.opacity = "0";
  glowPrev.bord.style.opacity = "0";
  glowPrev = null;
}

function updateGlow() {
  glowRaf = null;
  let target = null;
  try {
    const under = document.elementFromPoint(glowX, glowY);
    target = under && under.closest ? under.closest(GLOW_TARGET) : null;
  } catch {
    target = null;
  }
  if (!target) {
    fadeGlow();
    return;
  }

  const spot = ensureLayer(target, "po-glow-spot");
  const bord = ensureLayer(target, "po-border-glow");
  if (glowPrev && glowPrev.spot !== spot) {
    glowPrev.spot.style.opacity = "0";
    glowPrev.bord.style.opacity = "0";
  }
  glowPrev = { spot, bord };
  spot.style.opacity = "1";
  bord.style.opacity = "1";

  const r = target.getBoundingClientRect();
  if (!r.width || !r.height) return;
  const mx = glowX - r.left;
  const my = glowY - r.top;
  target.style.setProperty("--mx", `${((mx / r.width) * 100).toFixed(1)}%`);
  target.style.setProperty("--my", `${((my / r.height) * 100).toFixed(1)}%`);
  target.style.setProperty(
    "--ang",
    `${((Math.atan2(my - r.height / 2, mx - r.width / 2) * 180) / Math.PI + 90).toFixed(1)}deg`,
  );
}

function onPointerMove(evt) {
  glowX = evt.clientX;
  glowY = evt.clientY;
  if (!glowRaf) glowRaf = requestAnimationFrame(updateGlow);
}

// ---------------------------------------------------------------- 界面

const root = document.getElementById("root");

// fitHeight 在 render() 里赋值，这里先占位，好让主题 CSS / load 之后的
// 重新上报也能调到它（高度算不准时面板会白留一条或直接滚）。
let fitHeight = () => {};

function render() {
  if (!root) return;

  root.innerHTML = `
    <main class="po">
      <div class="po-top">
        <p class="po-hint">写粗糙版，优化成模型更懂的结构化提示词</p>
      </div>

      <div class="po-styles" role="group" aria-label="优化场景">
        ${STYLES.map(
          (s, i) =>
            `<button type="button" class="po-chip${i === 0 ? " is-on" : ""}" data-style="${s.id}">${s.label}</button>`,
        ).join("")}
      </div>

      <label class="po-label" for="po-input">
        <span>基础提示词</span>
        <span class="po-label-right">
          <span class="po-kbd" title="光标在输入框里时，按 Ctrl + Enter 直接优化">Ctrl + Enter</span>
          <span id="po-count" class="po-count">0 字</span>
        </span>
      </label>
      <textarea id="po-input" class="po-input" spellcheck="false"
        placeholder="例如：帮我讲清楚 PID 里的积分项到底在干嘛"></textarea>

      <input id="po-extra" class="po-extra" type="text"
        placeholder="可选：补充要求，如「面向零基础」「控制在 300 字内」">

      <div class="po-actions">
        <button id="po-run" class="po-btn primary" type="button"><span class="po-btn-tx" id="po-run-tx">优化</span></button>
        <button id="po-clear" class="po-btn" type="button"><span class="po-btn-tx">清空</span></button>
      </div>

      <p id="po-error" class="po-error" hidden></p>

      <section id="po-result-wrap" class="po-result-wrap" hidden>
        <div class="po-result-head">
          <span id="po-result-title">优化结果</span>
          <span class="po-versions" id="po-versions" hidden></span>
          <span id="po-leninfo" class="po-leninfo"></span>
        </div>
        <textarea id="po-result" class="po-result" spellcheck="false" readonly></textarea>

        <div class="po-source">
          <button id="po-source-toggle" class="po-source-toggle" type="button" aria-expanded="false">
            <span class="po-caret" aria-hidden="true">▸</span><span>原文对照</span><span class="po-source-len" id="po-source-len"></span>
          </button>
          <pre id="po-source-text" class="po-source-text" hidden></pre>
        </div>

        <div class="po-revise">
          <input id="po-revise" class="po-revise-input" type="text" spellcheck="false"
            placeholder="不满意？说要改哪儿；也可以勾下面的方向，可多选">
          <button id="po-revise-run" class="po-btn" type="button"><span class="po-btn-tx">改</span></button>
        </div>
        <div class="po-revise-quick" id="po-revise-quick"></div>

        <div class="po-result-actions">
          <button id="po-copy" class="po-btn primary" type="button"><span class="po-btn-tx">复制</span></button>
          <button id="po-back" class="po-btn" type="button"><span class="po-btn-tx">替换原文</span></button>
        </div>
      </section>

    </main>
  `;

  const inputEl = document.getElementById("po-input");
  const extraEl = document.getElementById("po-extra");
  const countEl = document.getElementById("po-count");
  const runBtn = document.getElementById("po-run");
  const runTx = document.getElementById("po-run-tx");
  const clearBtn = document.getElementById("po-clear");
  const errorEl = document.getElementById("po-error");
  const resultWrap = document.getElementById("po-result-wrap");
  const resultEl = document.getElementById("po-result");
  const lenInfoEl = document.getElementById("po-leninfo");
  const copyBtn = document.getElementById("po-copy");
  const backBtn = document.getElementById("po-back");
  const reviseEl = document.getElementById("po-revise");
  const reviseBtn = document.getElementById("po-revise-run");
  const reviseQuick = document.getElementById("po-revise-quick");
  const resultTitleEl = document.getElementById("po-result-title");
  const versionsEl = document.getElementById("po-versions");
  const sourceToggle = document.getElementById("po-source-toggle");
  const sourceTextEl = document.getElementById("po-source-text");
  const sourceLenEl = document.getElementById("po-source-len");

  let style = "general";
  let streaming = false;
  let abortCtrl = null;
  // 上一版结果的完整 assistant 消息（含模型的签名字段），迭代精修时原样带回
  let lastAssistant = null;
  // 本轮优化用的原文：既是长度对比的基准，也是「原文对照」展示的内容
  let sourceText = "";
  // 一次原文可以产出多个版本（「再来一版」追加），当前看的是哪一个
  let versions = [];
  let activeVersion = 0;
  // 勾选的改法（可多选）：点「改」时和手写的要求合并成一条
  const pickedFixes = new Set();
  // 卡片只负责用：清单从设置页配好的那份读（同一份本机配置）
  const fixes = loadFixes();

  // 高度只上报一次。宿主每次重排都会把滚动位置打回顶部，而且内容一变就重排，
  // 等于下面那些按钮永远点不顺。宁可让卡片自己滚（内容超出时内部滚动），
  // 也不再去叫宿主。
  let heightReported = false;
  fitHeight = () => {
    if (heightReported) return;
    const h = Math.ceil(
      Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0),
    );
    if (h <= 120) return;
    heightReported = true;
    hana.ui.resize({ height: Math.min(h, 760) });
  };

  const setError = (msg) => {
    if (!msg) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = msg;
    fitHeight();
  };

  const syncCount = () => {
    countEl.textContent = `${inputEl.value.length} 字`;
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(320, Math.max(96, inputEl.scrollHeight))}px`;
    fitHeight();
  };

  /** 结果框高度交给 CSS（min-height / max-height），JS 不再插手：
      反复改高度会让页面瞬时塌陷，宿主滚动位置就被打回顶部了。 */
  const growResult = () => {
    fitHeight();
  };

  // rAF 句柄：流式期间跟着滚到底用它合帧
  let growRaf = 0;

  // 生成期间内容一直变长，只把结果框自己滚到底，不动页面高度
  const keepResultAtBottom = () => {
    resultEl.scrollTop = resultEl.scrollHeight;
  };
  const followStream = () => {
    if (growRaf) return;
    growRaf = requestAnimationFrame(() => {
      growRaf = 0;
      keepResultAtBottom();
    });
  };

  /** 版本条：第一版就显示（否则「能出多版」这件事没人知道），末尾挂一个「+」再来一版 */
  const renderVersions = () => {
    if (!versions.length) {
      versionsEl.hidden = true;
      versionsEl.replaceChildren();
      return;
    }
    versionsEl.replaceChildren();
    versions.forEach((_, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "po-version-btn" + (index === activeVersion ? " is-on" : "");
      btn.textContent = String(index + 1);
      btn.title = "第 " + (index + 1) + " 版";
      btn.addEventListener("click", () => showVersion(index));
      versionsEl.appendChild(btn);
    });
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "po-version-add";
    addBtn.textContent = "+";
    addBtn.title = "再来一版";
    addBtn.addEventListener("click", () => {
      if (streaming) return;
      void runStream("", { append: true });
    });
    versionsEl.appendChild(addBtn);
    versionsEl.hidden = false;
  };

  /** 切到某一版：正文、长度、以及迭代精修要带回的 assistant 都跟着换 */
  const showVersion = (index) => {
    const item = versions[index];
    if (!item) return;
    activeVersion = index;
    resultEl.value = item.text;
    lastAssistant = item.assistant;
    lenInfoEl.textContent = `${sourceText.length} → ${item.text.length} 字`;
    renderVersions();
    growResult();
  };

  /** 原文对照：默认收起，展开才占地方 */
  const syncSource = () => {
    sourceTextEl.textContent = sourceText;
    sourceLenEl.textContent = sourceText ? `${sourceText.length} 字` : "";
    if (!sourceText) {
      sourceTextEl.hidden = true;
      sourceToggle.setAttribute("aria-expanded", "false");
      sourceToggle.classList.remove("is-open");
    }
  };

  const toggleSource = () => {
    const open = sourceTextEl.hidden;
    sourceTextEl.hidden = !open;
    sourceToggle.setAttribute("aria-expanded", open ? "true" : "false");
    sourceToggle.classList.toggle("is-open", open);
    growResult();
  };

  // ---- 改法：清单在设置页里配，卡片只负责勾选 ----

  const makeFixChip = (fix) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "po-chip-sm" + (pickedFixes.has(fix.id) ? " is-picked" : "");
    btn.dataset.fixId = fix.id;
    btn.title = fix.prompt;
    btn.textContent = fix.label;
    return btn;
  };

  const renderFixLists = () => {
    reviseQuick.replaceChildren();
    for (const fix of fixes) reviseQuick.appendChild(makeFixChip(fix));
  };

  /** 只改被点那个的样式，不重建整排：重建会让连点丢事件，也会把焦点和按压态一起抹掉 */
  const toggleFix = (id, btn) => {
    if (pickedFixes.has(id)) pickedFixes.delete(id);
    else pickedFixes.add(id);
    if (btn && btn.dataset.fixId === id) {
      btn.classList.toggle("is-picked", pickedFixes.has(id));
    } else {
      renderFixLists();
    }
  };

  /** 把「手写的要求」和「勾选的改法」拼成一条：顺序感就是先你说、后勾的 */
  const composeRevise = () => {
    const parts = [];
    const typed = reviseEl.value.trim();
    if (typed) parts.push(typed);
    for (const fix of fixes) {
      if (pickedFixes.has(fix.id)) parts.push(fix.prompt);
    }
    return parts.join("；");
  };

  const clearPicked = () => {
    pickedFixes.clear();
    reviseEl.value = "";
    renderFixLists();
  };

  /** 生成中主按钮变成「停止」，其余输入先按住 */
  const syncRunButton = () => {
    runBtn.disabled = false;
    runBtn.classList.toggle("is-stop", streaming);
    runTx.textContent = streaming ? "停止" : "优化";
    reviseBtn.disabled = streaming;
    clearBtn.disabled = streaming;
  };

  /**
   * 流式清洗：模型偶尔把整段包进代码围栏，或带一句「优化后的提示词：」前缀。
   * 流没结束时围栏只有半边，不能沿用后端的完整正则，这里逐段剥。
   */
  const cleanStreaming = (raw) => {
    let out = String(raw ?? "");
    out = out.replace(/^\s*`{3}[a-zA-Z0-9_-]*[ \t]*\r?\n?/, "");
    out = out.replace(/\r?\n?`{3}\s*$/, "");
    out = out.replace(/^(优化后的?提示词|optimized prompt)\s*[:：]\s*/i, "");
    return out;
  };

  const runStream = async (revise = "", { append = false } = {}) => {
    if (streaming) return;
    const text = inputEl.value.trim();
    if (!text) {
      setError("先写点什么，再点优化。");
      inputEl.focus();
      return;
    }
    const isRevise = Boolean(revise);
    if (isRevise && !lastAssistant) {
      setError("还没有可修改的结果，先优化一次。");
      return;
    }

    setError("");
    streaming = true;
    syncRunButton();

    if (!isRevise) {
      // 「再来一版」不丢已有版本；普通优化则重开一轮，也换掉对比用的原文
      if (!append) {
        versions = [];
        activeVersion = 0;
      }
      sourceText = text;
      resultEl.value = "";
      syncSource();
      renderVersions();
    }
    resultWrap.hidden = false;
    resultTitleEl.textContent = isRevise ? "修改中" : "生成中";
    lenInfoEl.textContent = "";
    fitHeight();

    abortCtrl = new AbortController();
    let acc = "";
    let finished = false;

    try {
      const res = await fetch(apiUrl("optimize-stream"), {
        method: "POST",
        headers: appHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          text,
          style,
          extra: extraEl.value,
          revise,
          priorAssistant: lastAssistant,
        }),
        signal: abortCtrl.signal,
      });

      if (!res.ok) {
        const info = await res.json().catch(() => null);
        throw new Error(info?.message || `生成失败（HTTP ${res.status}）`);
      }
      if (!res.body) throw new Error("生成失败：没有拿到数据流。");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done: readDone } = await reader.read();
        if (readDone) break;
        buffer += decoder.decode(value, { stream: true });

        let cut;
        while ((cut = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, cut).trim();
          buffer = buffer.slice(cut + 1);
          if (!line) continue;

          let event;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          if (event.type === "text-delta") {
            acc += event.delta;
            resultEl.value = cleanStreaming(acc);
            lenInfoEl.textContent = `${sourceText.length} → ${resultEl.value.length} 字`;
            followStream();
          } else if (event.type === "done") {
            finished = true;
            const finalText =
              typeof event.optimized === "string" && event.optimized
                ? event.optimized
                : cleanStreaming(acc);
            if (isRevise) {
              // 继续改是「改当前这一版」，不另开一版
              versions[activeVersion] = { text: finalText, assistant: event.assistant || null };
              lastAssistant = event.assistant || null;
            } else {
              versions.push({ text: finalText, assistant: event.assistant || null });
              activeVersion = versions.length - 1;
              lastAssistant = event.assistant || null;
            }
            resultEl.value = finalText;
            lenInfoEl.textContent = `${sourceText.length} → ${finalText.length} 字`;
            renderVersions();
            growResult();
          } else if (event.type === "error") {
            throw new Error(event.message || "生成失败。");
          }
        }
      }

      if (!finished) throw new Error("生成中断，请重试。");
      resultTitleEl.textContent = "优化结果";
      growResult();
    } catch (err) {
      if (err?.name === "AbortError") {
        // 主动停：已经收到的部分留着，不白扔
        resultTitleEl.textContent = "已停止";
        lenInfoEl.textContent = resultEl.value
          ? `${sourceText.length} → ${resultEl.value.length} 字`
          : "已停止";
        growResult();
        toast("已停止生成", "info");
      } else {
        setError(String(err?.message || err));
        if (!resultEl.value) resultWrap.hidden = true;
      }
    } finally {
      streaming = false;
      abortCtrl = null;
      syncRunButton();
      growResult();
    }
  };

  const copyResult = async () => {
    const text = resultEl.value;
    if (!text) return;
    let ok = false;
    try {
      await hana.clipboard.writeText(text);
      ok = true;
    } catch {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        ok = false;
      }
    }
    toast(ok ? "已复制优化后的提示词" : "复制失败，请手动选择复制", ok ? "success" : "error");
  };

  for (const chip of root.querySelectorAll(".po-chip")) {
    chip.addEventListener("click", () => {
      style = chip.dataset.style || "general";
      for (const other of root.querySelectorAll(".po-chip")) {
        other.classList.toggle("is-on", other === chip);
      }
    });
  }

  inputEl.addEventListener("input", syncCount);
  inputEl.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void runStream("");
    }
  });

  runBtn.addEventListener("click", () => {
    if (streaming) {
      abortCtrl?.abort();
      return;
    }
    void runStream("");
  });

  reviseBtn.addEventListener("click", () => {
    const request = composeRevise();
    if (!request) {
      reviseEl.focus();
      return;
    }
    // 先把这条回显到输入框，让用户看清这次到底要发什么
    reviseEl.value = request;
    void runStream(request).finally(clearPicked);
  });
  reviseEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      reviseBtn.click();
    }
  });

  // 改法 chip：点一下勾选/取消（可多选），点「改」才真的发出去
  reviseQuick.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fix-id]");
    if (!btn || streaming) return;
    toggleFix(btn.dataset.fixId, btn);
  });

  clearBtn.addEventListener("click", () => {
    if (streaming) abortCtrl?.abort();
    inputEl.value = "";
    extraEl.value = "";
    clearPicked();
    resultEl.value = "";
    resultWrap.hidden = true;
    lastAssistant = null;
    sourceText = "";
    versions = [];
    activeVersion = 0;
    syncSource();
    renderVersions();
    setError("");
    syncCount();
    inputEl.focus();
  });

  copyBtn.addEventListener("click", copyResult);

  // 把当前这一版搬回输入框：方便换场景再优化一轮，或者手工再改两笔
  backBtn.addEventListener("click", () => {
    const text = resultEl.value.trim();
    if (!text) return;
    inputEl.value = text;
    resultEl.value = "";
    resultWrap.hidden = true;
    lastAssistant = null;
    sourceText = "";
    clearPicked();
    versions = [];
    activeVersion = 0;
    syncSource();
    renderVersions();
    setError("");
    syncCount();
    inputEl.focus();
    toast("已放回输入框，可以改完再优化", "success");
  });

  // 同一段原文再出一版（从结果头那个「+」进来，已有版本留着）

  sourceToggle.addEventListener("click", toggleSource);

  syncCount();
  syncRunButton();
  renderFixLists();
  requestAnimationFrame(fitHeight);
}

// 先报活再干活：宿主有 5 秒握手超时（pl = 5000，readyOnTimeout 默认 false），
// ready 一旦被后面任何异常拦住，整个 widget 就会被判成「加载失败」。
hana.ready();
render();

// 初始主题：具体主题由外壳直接写好（可能带 token），这里只纠正 auto
currentTheme = (document.body.dataset.hanaTheme || "").trim();
if (!currentTheme || currentTheme === "auto") {
  applyThemeCss("auto", "");
} else {
  const l = document.getElementById("po-theme-css");
  currentThemeCss = (l && l.href) || "";
}
syncTheme();

// 主题 CSS 换完（异步加载）之后重算亮暗与主按钮前景色
const themeLink = document.getElementById("po-theme-css");
if (themeLink) themeLink.addEventListener("load", () => {
  syncTheme();
  // 主题字体/行高会改变内容高度，换完得重新上报一次
  requestAnimationFrame(() => fitHeight());
});
window.setTimeout(syncTheme, 300);
window.addEventListener("load", () => requestAnimationFrame(() => fitHeight()));

// 宿主推送主题变更：v2 由 SDK 统一收口，回调给出解析后的主题与 CSS 地址
hana.theme.subscribe((snapshot) => {
  applyHostTheme(snapshot?.theme, snapshot?.cssUrl);
  window.setTimeout(syncTheme, 80);
});

// 系统亮暗变化：仅当主题是 auto 时需要跟着换
if (darkQuery) {
  const onScheme = () => {
    if (!currentTheme || currentTheme === "auto") {
      applyThemeCss("auto", "");
      window.setTimeout(syncTheme, 80);
    }
  };
  if (darkQuery.addEventListener) darkQuery.addEventListener("change", onScheme);
  else if (darkQuery.addListener) darkQuery.addListener(onScheme);
}

// 兜底：宿主若直接改了文档根节点的主题属性
try {
  new MutationObserver(syncTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "class", "style"],
  });
} catch {
  /* 不支持 MutationObserver 时静默跳过 */
}

document.addEventListener("mousemove", onPointerMove, { passive: true });
document.addEventListener("mouseleave", fadeGlow);
document.addEventListener("mouseout", (e) => {
  if (!e.relatedTarget) fadeGlow();
}, true);
window.addEventListener("resize", () => {
  syncTheme();
  fadeGlow();
});
