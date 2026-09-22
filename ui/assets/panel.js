// 提示词优化 · 卡片前端（v2 App）
// 传输层交给 v2 浏览器 SDK（sdk.js）：协议握手、主题推送、卡片高度上报、宿主能力都在里面。
// 应用自己的后端接口走 app-api.js（/api/apps/prompt-optimizer/routes/）。
import { hana } from "./sdk.js";
import { apiFetch } from "./app-api.js";

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
        <span id="po-count" class="po-count">0 字</span>
      </label>
      <textarea id="po-input" class="po-input" spellcheck="false"
        placeholder="例如：帮我讲清楚 PID 里的积分项到底在干嘛"></textarea>

      <input id="po-extra" class="po-extra" type="text"
        placeholder="可选：补充要求，如「面向零基础」「控制在 300 字内」">

      <div class="po-actions">
        <button id="po-run" class="po-btn primary" type="button"><span class="po-btn-tx" id="po-run-tx">优化</span></button>
        <button id="po-clear" class="po-btn" type="button"><span class="po-btn-tx">清空</span></button>
        <span class="po-kbd">Ctrl + Enter</span>
      </div>

      <p id="po-error" class="po-error" hidden></p>

      <section id="po-result-wrap" class="po-result-wrap" hidden>
        <div class="po-result-head">
          <span>优化结果</span>
          <span id="po-leninfo" class="po-leninfo"></span>
        </div>
        <textarea id="po-result" class="po-result" spellcheck="false" readonly></textarea>
        <div class="po-result-actions">
          <button id="po-copy" class="po-btn primary" type="button"><span class="po-btn-tx">复制</span></button>
          <button id="po-again" class="po-btn" type="button"><span class="po-btn-tx">再优化一次</span></button>
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
  const againBtn = document.getElementById("po-again");
  let style = "general";
  let loading = false;

  fitHeight = () => {
    // 取两者较大值：body 有 min-height:100%，只读 body 会在内容比视口矮时
    // 回一个等于视口的高，宿主收到「高度没变」就不会再调窗口。
    const h = Math.ceil(
      Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0),
    );
    if (h > 120) hana.ui.resize({ height: h });
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

  const setLoading = (on) => {
    loading = on;
    runBtn.disabled = on;
    runTx.textContent = on ? "优化中…" : "优化";
  };

  const optimize = async () => {
    if (loading) return;
    const text = inputEl.value.trim();
    if (!text) {
      setError("先写点什么，再点优化。");
      inputEl.focus();
      return;
    }
    setError("");
    setLoading(true);
    try {
      const data = await apiFetch(
        "optimize",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, style, extra: extraEl.value }),
        },
        60000,
      );
      if (!data?.ok) {
        setError(data?.message || "优化失败，请稍后再试。");
        return;
      }
      resultEl.value = data.optimized;
      resultWrap.hidden = false;
      lenInfoEl.textContent = `${data.originalLength} → ${data.optimizedLength} 字`;
      requestAnimationFrame(() => {
        resultEl.style.height = "auto";
        resultEl.style.height = `${Math.min(360, Math.max(120, resultEl.scrollHeight))}px`;
        fitHeight();
      });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
      fitHeight();
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
      optimize();
    }
  });
  runBtn.addEventListener("click", optimize);
  clearBtn.addEventListener("click", () => {
    inputEl.value = "";
    extraEl.value = "";
    resultEl.value = "";
    resultWrap.hidden = true;
    setError("");
    syncCount();
    inputEl.focus();
  });
  copyBtn.addEventListener("click", copyResult);
  againBtn.addEventListener("click", optimize);

  syncCount();
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
