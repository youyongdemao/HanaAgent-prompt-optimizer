// 提示词优化 · 卡片前端（v2 App）
// 传输层交给 v2 浏览器 SDK（sdk.js）：协议握手、主题推送、卡片高度上报、宿主能力都在里面。
// 应用自己的后端接口走 app-api.js（/api/apps/prompt-optimizer/routes/）。
import { hana } from "./sdk.js";
import { apiUrl, appHeaders } from "./app-api.js";
import { DEFAULT_FIXES, loadActiveFixes, pullFixes } from "./fixes.js";

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

const GLOW_TARGET = ".po-btn, .po-tbtn, .po-split-btn";

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

/**
 * 按钮刚变成不可用时，把停在它上面的光晕立刻收掉。
 * 光晕只在鼠标移动（onPointerMove）时更新，鼠标不动的话它会一直亮着，
 * 直到用户动一下才淡出——那就是「亮一小会才灭」的来源。
 */
function dropStaleGlow() {
  if (!glowPrev || !glowPrev.spot) return;
  const owner = glowPrev.spot.parentElement;
  if (owner && owner.disabled) fadeGlow();
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
  // 禁用中的按钮不发发光：它点了也没反应，发光会误导
  // （CSS 那层写了 :not(:disabled)，光晕是 JS 单独插的，得自己判）
  if (!target || target.disabled) {
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
          <span id="po-count" class="po-count">0 字</span>
        </span>
      </label>
      <textarea id="po-input" class="po-input" spellcheck="false"
        placeholder="例如：帮我讲清楚 PID 里的积分项到底在干嘛"></textarea>

      <textarea id="po-extra" class="po-extra" rows="1" spellcheck="false"
        placeholder="可选：补充要求，如「面向零基础」「控制在 300 字内」"></textarea>
      <p class="po-kbd" title="Enter 直接优化">Shift + Enter 换行</p>

      <div class="po-actions">
        <button id="po-run" class="po-btn primary" type="button"><span class="po-btn-tx" id="po-run-tx">优化</span></button>
        <button id="po-clear" class="po-btn" type="button"><span class="po-btn-tx">清空</span></button>
      </div>

      <p id="po-error" class="po-error" hidden></p>

      <section id="po-result-wrap" class="po-result-wrap" hidden>
        <div class="po-result-head">
          <span id="po-result-title">优化结果</span>
          <span id="po-leninfo" class="po-leninfo"></span>
        </div>

        <div class="po-compare">
          <div class="po-pane">
            <div class="po-pane-head">
              <span class="po-pane-tag" id="po-latest-tag">最新一版</span>
              <span class="po-scroller" id="po-vtabs-scroller">
                <button class="po-scroll-btn po-scroll-left" type="button" aria-label="向前" tabindex="-1">‹</button>
                <span class="po-version-tabs po-scroll-track" id="po-version-tabs"></span>
                <button class="po-scroll-btn po-scroll-right" type="button" aria-label="向后" tabindex="-1">›</button>
              </span>
              <span class="po-pane-len" id="po-latest-len"></span>
            </div>
            <textarea id="po-result" class="po-result" spellcheck="false" readonly></textarea>
          </div>

          <div class="po-pane">
            <div class="po-pane-head">
              <div class="po-scroller" id="po-chain-scroller">
                <button class="po-scroll-btn po-scroll-left" type="button" aria-label="向前" tabindex="-1">‹</button>
                <div class="po-chain po-scroll-track" id="po-chain"></div>
                <button class="po-scroll-btn po-scroll-right" type="button" aria-label="向后" tabindex="-1">›</button>
              </div>
              <span class="po-pane-len" id="po-ref-len"></span>
            </div>
            <pre id="po-ref-text" class="po-ref-text"></pre>
          </div>
        </div>

        <div class="po-revise-tools">
          <div class="po-split">
            <button id="po-revise-picked" class="po-split-btn" type="button" title="从流程图上选中的那一项开始改进（带要求），它后面的版本会被新结果取代">以所选项改进</button>
            <button id="po-revise-left" class="po-split-btn" type="button" title="基于左栏这一版重出一版（不写要求时就等于「+」）">重写</button>
            <button id="po-revise-right" class="po-split-btn" type="button" title="基于右栏那一版，按新要求改进">改进</button>
          </div>
          <div class="po-revise-quick" id="po-revise-quick"></div>
        </div>
        <textarea id="po-revise" class="po-revise-input" rows="1" spellcheck="false"
          placeholder="不满意？说要改哪儿；上面的方向可以多选"></textarea>
        <div class="po-result-actions">
          <div class="po-split po-copy-split">
            <button id="po-copy" class="po-split-btn" type="button" title="复制左栏这个最新版本">复制最新项</button>
            <button id="po-copy-picked" class="po-split-btn" type="button" title="复制右栏正在看的那一版">复制所选项</button>
          </div>
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
  const copyPickedBtn = document.getElementById("po-copy-picked");
  const reviseEl = document.getElementById("po-revise");
  const revisePickedBtn = document.getElementById("po-revise-picked");
  const reviseQuick = document.getElementById("po-revise-quick");
  const resultTitleEl = document.getElementById("po-result-title");
  const chainEl = document.getElementById("po-chain");
  const refTextEl = document.getElementById("po-ref-text");
  const refLenEl = document.getElementById("po-ref-len");
  const latestLenEl = document.getElementById("po-latest-len");
  const latestTagEl = document.getElementById("po-latest-tag");
  const versionTabs = document.getElementById("po-version-tabs");
  const reviseLeft = document.getElementById("po-revise-left");
  const reviseRight = document.getElementById("po-revise-right");

  let style = "general";
  let streaming = false;
  let abortCtrl = null;
  // 上一版结果的完整 assistant 消息（含模型的签名字段），迭代精修时原样带回
  let lastAssistant = null;
  // 本轮优化用的原文：既是长度对比的基准，也是「原文对照」展示的内容
  let sourceText = "";
  // 一次原文可以产出多个版本（「再来一版」追加），当前看的是哪一个
  // 两层版本模型：
  //   大版本（branches）= 一次「带了新要求」的改动，链条上一节，标题就是那次的要求；
  //   小版本（branch.items）= 同一要求下的多次重写（左栏 1/2/3 切换，右侧「+」再重写一次）。
  let branches = []; // [{ label, detail, items: [{ text, assistant }] }]
  let activeBranch = 0; // 左栏看哪一大版本
  let activeItem = 0; // 左栏看该大版本下的哪一次
  let inspecting = null; // 右栏：null = 原文；否则 { branch, item }
  // 勾选的改法（可多选）：点「改」时和手写的要求合并成一条
  const pickedFixes = new Set();
  // 卡片只负责用：清单从设置页配好的那份读（同一份本机配置）
  let fixes = loadActiveFixes();

  // 清单的真身在 App 那一侧，本地那份只是缓存：先渲染，再拉一次对齐。
  // 切回卡片时也重拉：设置页改完不必把卡片关掉重开。
  const fixSig = (list) => JSON.stringify(list.map((f) => [f.id, f.label, f.prompt, f.on]));
  const pullIntoPanes = () => {
    void pullFixes().then((remote) => {
      if (!remote) return;
      const active = remote.filter((item) => item.on !== false);
      if (fixSig(active) === fixSig(fixes)) return; // 没变就别动，免得把已经勾好的清掉
      applyFixes(active.length ? active : remote);
    });
  };
  pullIntoPanes();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pullIntoPanes();
  });

  // 高度上报：只在真的变了（差 8px 以上）时发一次，且内容变短也要跟着缩，
  // 否则卡片底下会空一大片。生成期间不走这里（那时高度一直变，反复叫醒宿主会把滚动打回顶部）。
  let reportedHeight = 0;
  fitHeight = () => {
    const h = Math.ceil(
      Math.max(document.body.scrollHeight || 0, document.documentElement.scrollHeight || 0),
    );
    if (h <= 120) return;
    if (Math.abs(h - reportedHeight) < 8) return;
    reportedHeight = h;
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

  /** 一行起、六行封顶的自动增高（基础提示词、补充要求、继续改都用它） */
  const autoGrow = (el) => {
    el.style.height = "auto";
    const line = parseFloat(getComputedStyle(el).lineHeight) || 19;
    const pad = 22;
    el.style.height = `${Math.min(line * 6 + pad, Math.max(line + pad, el.scrollHeight))}px`;
  };

  const syncCount = () => {
    countEl.textContent = `${inputEl.value.length} 字`;
    autoGrow(inputEl);
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

  /** 最后一个大版本 / 某个大版本的最后一次重写 */
  const latestBranch = () => branches[branches.length - 1] || null;
  const latestItemOf = (branch) => (branch && branch.items.length ? branch.items[branch.items.length - 1] : null);

  /** 左栏当前该显示的那一次 */
  const currentItem = () => {
    const branch = branches[activeBranch];
    if (!branch) return null;
    return branch.items[activeItem] || latestItemOf(branch);
  };

  /** 右栏当前该显示的那一次（null = 原文） */
  const inspectedItem = () => {
    if (!inspecting) return null;
    const branch = branches[inspecting.branch];
    if (!branch) return null;
    return branch.items[inspecting.item] || latestItemOf(branch);
  };

  /**
   * 横向滚动壳：放不下不换行，改成左右可滚；不出滚动条，
   * 哪边还有内容没露出来，哪边就给箭头和边缘渐隐。
   * 返回一个 sync，内容变了调一次让它重新量。
   */
  const setupScroller = (scroller) => {
    const track = scroller && scroller.querySelector(".po-scroll-track");
    if (!track) return () => {};
    const sync = () => {
      const max = track.scrollWidth - track.clientWidth;
      const over = max > 2;
      scroller.classList.toggle("is-overflow", over);
      scroller.classList.toggle("can-left", over && track.scrollLeft > 2);
      scroller.classList.toggle("can-right", over && track.scrollLeft < max - 2);
    };
    const step = () => Math.max(80, track.clientWidth * 0.6);
    scroller.querySelector(".po-scroll-left")?.addEventListener("click", () => {
      track.scrollBy({ left: -step(), behavior: "smooth" });
    });
    scroller.querySelector(".po-scroll-right")?.addEventListener("click", () => {
      track.scrollBy({ left: step(), behavior: "smooth" });
    });
    track.addEventListener("scroll", sync, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(sync).observe(track);
    return sync;
  };

  const syncChainScroll = setupScroller(document.getElementById("po-chain-scroller"));
  const syncVtabScroll = setupScroller(document.getElementById("po-vtabs-scroller"));

  /**
   * 把当前选中的那一节滚回可视区（只动横向滚动壳，不牽动整页）。
   * 选中的那节跑到视野外时，链条就失去作用了。
   */
  const revealActiveNode = () => {
    const node = chainEl.querySelector(".po-chain-node.is-on");
    if (!node) return;
    const tr = chainEl.getBoundingClientRect();
    const nr = node.getBoundingClientRect();
    const pad = 14;
    let delta = 0;
    if (nr.left < tr.left + pad) delta = nr.left - (tr.left + pad);
    else if (nr.right > tr.right - pad) delta = nr.right - (tr.right - pad);
    if (!delta) return;
    chainEl.scrollBy({ left: delta, behavior: "smooth" });
    // 平滑滚动要过一会儿才落定，那时再量一次箭头与渐隐
    setTimeout(syncChainScroll, 280);
  };

  /** 流程链条：原文 → 每个大版本（节点标题就是那次的要求），点哪节就显示那节最新的一次重写 */
  const renderChain = () => {
    chainEl.replaceChildren();

    const makeNode = (index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const on =
        index === null ? inspecting === null : !!inspecting && inspecting.branch === index;
      btn.className = "po-chain-node" + (on ? " is-on" : "");
      if (index === null) {
        btn.textContent = "原文";
      } else {
        const branch = branches[index];
        // 后面跟上「正在看的那一次」的编号，例如 初版-2
        const shown =
          inspecting && inspecting.branch === index
            ? Math.min(inspecting.item, branch.items.length - 1)
            : branch.items.length - 1;
        btn.textContent = `${branch.label}-${shown + 1}`;
      }
      // 完整要求放悬停提示，不占标题位置
      btn.title = index === null ? "最初写下的那段" : branches[index].detail || branches[index].label;
      btn.addEventListener("click", () => inspectVersion(index));
      return btn;
    };
    const makeArrow = () => {
      const span = document.createElement("span");
      span.className = "po-chain-arrow";
      span.textContent = "→";
      span.setAttribute("aria-hidden", "true");
      return span;
    };

    chainEl.appendChild(makeNode(null));
    branches.forEach((_, index) => {
      chainEl.appendChild(makeArrow());
      chainEl.appendChild(makeNode(index));
    });
  };

  /** 左右两栏：左边是当前大版本的某一次重写，右边是正在对照的那一次 */
  const renderPanes = () => {
    const latest = latestItemOf(latestBranch());
    const item = currentItem() || latest;
    resultEl.value = item ? item.text : "";
    // 换版后从头看：先取消还在路上的「跟着滚到底」，再归位到顶部
    if (growRaf) {
      cancelAnimationFrame(growRaf);
      growRaf = 0;
    }
    resultEl.scrollTop = 0;
    // 左栏标题：先是大版本标题（这次的要求），后面才是编号与「+」
    const branch = branches[activeBranch];
    latestTagEl.textContent = branch ? branch.label : "";
    latestLenEl.textContent = item ? `${item.text.length} 字` : "";
    lenInfoEl.textContent = latest ? `${sourceText.length} → ${latest.text.length} 字` : "";
    renderVersionTabs();

    const ref = inspectedItem();
    const refText = inspecting === null ? sourceText : ref ? ref.text : "";
    refTextEl.textContent = refText;
    refLenEl.textContent = refText ? `${refText.length} 字` : "";

    renderChain();
    // 切了版本，chips 上「本版用过」的标记要跟着变
    renderFixLists();
    // 链条与小版本号是横向可滚的，内容变了要重新量一次；选中项也可能滚出了视野
    requestAnimationFrame(() => {
      syncChainScroll();
      syncVtabScroll();
      revealActiveNode();
    });
    // 结构变了（结果区出现、版本增减）就把高度重算一次；
    // 生成期间结果框高度是 CSS 固定的，这里算出来不会变，所以不会被反复报出去
    fitHeight();
  };

  /**
   * 结果出来后把视线带到结果区：滚到它的顶部（这样结果在卡片里露得最多）。
   * 用原生平滑滚动：自带缓进缓出，而且用户一滚动就自动被打断。
   * 没有滚动条、或者已经在那附近时不出手。
   */
  /** 每次生成只自动划一次：结果刚冒头就划，不等出完 */
  let scrolledThisRun = false;

  const scrollToResult = () => {
    try {
      const doc = document.scrollingElement || document.documentElement;
      if (!doc || doc.scrollHeight <= doc.clientHeight + 4) return;
      const rect = resultWrap.getBoundingClientRect();
      const target = Math.max(0, rect.top + doc.scrollTop - 8);
      if (Math.abs(target - doc.scrollTop) < 8) return;
      window.scrollTo({ top: target, behavior: "smooth" });
    } catch {
      /* 不支持平滑滚动就保持原地 */
    }
  };

  /** 左栏的编号：当前大版本下的第几次重写（1/2/3…），末尾挂一个「+」再单纯重写一次 */
  const renderVersionTabs = () => {
    versionTabs.replaceChildren();
    const branch = branches[activeBranch];
    if (!branch) return;

    const current = Math.min(activeItem, branch.items.length - 1);
    branch.items.forEach((_, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "po-vtab" + (current === index ? " is-on" : "");
      btn.textContent = String(index + 1);
      btn.title = `看第 ${index + 1} 次重写`;
      btn.addEventListener("click", () => {
        activeItem = index;
        renderPanes();
        growResult();
      });
      versionTabs.appendChild(btn);
    });

    // 「+」：这一大版本下不带新要求，单纯再重写一次（不在链条上留痕）
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "po-vtab po-vtab-add";
    addBtn.textContent = "+";
    addBtn.title = "不含新要求，再重写一次";
    addBtn.addEventListener("click", () => {
      if (streaming) return;
      void runAgain();
    });
    versionTabs.appendChild(addBtn);
  };

  /** 选一大节来对照：右栏显示那一节里最新的一次重写（null 表示原文） */
  const inspectVersion = (branchIndex) => {
    if (branchIndex === null) {
      inspecting = null;
    } else {
      const branch = branches[branchIndex];
      if (!branch) return;
      inspecting = { branch: branchIndex, item: Math.max(0, branch.items.length - 1) };
    }
    renderPanes();
    growResult();
    // 换了选中项，「以所选项改进」的可否跟着变
    syncRunButton();
  };

  // ---- 改法：清单在设置页里配，卡片只负责勾选 ----

  const makeFixChip = (fix) => {
    const btn = document.createElement("button");
    btn.type = "button";
    // 两种状态分开：is-picked 实线 = 这轮勾上要用；is-used 虚线 = 当前显示的那一版当初用过它
    const used = new Set((branches[activeBranch] && branches[activeBranch].labels) || []);
    btn.className =
      "po-chip-sm" + (pickedFixes.has(fix.id) ? " is-picked" : "") + (used.has(fix.label) ? " is-used" : "");
    btn.dataset.fixId = fix.id;
    btn.title = used.has(fix.label) ? `${fix.prompt}（当前这一版用过）` : fix.prompt;
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
    // 勾了改法也算「有了要求」，两个按钮的可用状态跟着变
    syncRunButton();
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
    // 要求清空了，「重写」得跟着恢复可用
    syncRunButton();
  };

  /** 生成中主按钮变成「停止」，其余输入先按住 */
  /** 换成一份新清单（模型建议的，或退回默认的），并刷新 chips */
  const applyFixes = (list) => {
    if (!Array.isArray(list) || !list.length) return;
    fixes = list;
    pickedFixes.clear();
    renderFixLists();
    syncReviseHint();
    syncRunButton();
  };

  /**
   * 基础提示词停下笔后，问一次「这条适合往哪改」，用它换掉 chips 清单。
   * 输入没停不发、后又改了就作废上一次结果，免得旧建议盖住新的。
   */
  let suggestTimer = 0;
  let suggestSeq = 0;
  const scheduleFixSuggestion = () => {
    const text = inputEl.value.trim();
    const seq = ++suggestSeq;
    clearTimeout(suggestTimer);
    if (text.length < 8) {
      applyFixes(DEFAULT_FIXES.map((item) => ({ ...item })));
      return;
    }
    suggestTimer = setTimeout(async () => {
      try {
        const res = await fetch(apiUrl("/suggest-fixes"), {
          method: "POST",
          headers: appHeaders({ "content-type": "application/json" }),
          body: JSON.stringify({ text }),
        });
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (seq !== suggestSeq) return; // 期间又改了输入，这次结果作废
        applyFixes(data?.items);
      } catch {
        /* 拿不到建议就留着现有清单，不打扰使用 */
      }
    }, 700);
  };

  /** 「继续改」输入框的提示跟着这轮勾选的改法实时变，一眼知道这次要改什么 */
  const syncReviseHint = () => {
    const picked = fixes.filter((item) => pickedFixes.has(item.id)).map((item) => item.label);
    reviseEl.placeholder = picked.length
      ? `将按「${picked.join("、")}」改进；也可以补一句自己的要求`
      : "不满意？说要改哪儿；上面的方向可以多选";
  };

  const syncRunButton = () => {
    runBtn.disabled = false;
    runBtn.classList.toggle("is-stop", streaming);
    runTx.textContent = streaming ? "停止" : "优化";
    // 两个改进都得有要求才发得出去；重写相反，没要求才是它。两组互斥。
    const hasRequirement = reviseEl.value.trim().length > 0 || pickedFixes.size > 0;
    reviseLeft.disabled = streaming || hasRequirement;
    reviseLeft.title = hasRequirement
      ? "写了要求请点「改进」；「重写」是不改要求再出一版"
      : "基于左栏这一版重出一版（等于上面的「+」）";
    revisePickedBtn.disabled = streaming || !hasRequirement || !inspecting;
    revisePickedBtn.title = !inspecting
      ? "先在流程图上点一节（「原文」不算），再以所选项改进"
      : hasRequirement
        ? "从流程图上选中的那一项开始改进，它后面的版本会被取代"
        : "先勾改进方向或写一句要求，再以所选项改进";
    reviseRight.disabled = streaming || !hasRequirement;
    reviseRight.title = hasRequirement
      ? "从流程图的最后一版开始改进，接在末尾"
      : "先勾改进方向或写一句要求，再点改进";
    clearBtn.disabled = streaming;
    // 刚被禁用的按钮上如果正停着光晕，立刻收掉，不用等鼠标动
    dropStaleGlow();
    // 输入框的提示跟着这轮勾选走
    syncReviseHint();
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

  const runStream = async (revise = "", { labels = [], mode = "branch", at = -1 } = {}) => {
    if (streaming) return;
    scrolledThisRun = false;
    const text = inputEl.value.trim();
    if (!text) {
      setError("先写点什么，再点优化。");
      inputEl.focus();
      return;
    }
    const isRevise = Boolean(revise);
    const isRewrite = mode === "rewrite";
    // 重写（「+」或没写要求的改面）允许没有基底：初版本来就是从原文生成的，
    // 它的重写就退回原文再出一版。只有「带新要求」时才必须有基底可改。
    if (isRevise && !isRewrite && !lastAssistant) {
      setError("还没有可修改的结果，先优化一次。");
      return;
    }
    // 这次用了哪几个改法 + 完整要求，成功时要记进链条
    const pendingLabels = isRevise ? labels : [];
    const pendingDetail = isRevise ? revise : "";
    // 这次站在哪一版上改的：记进大版本。日后「重写一次」要退回它，
    // 否则模型会贴着上一版微调，新出的那一版看起来没区別。
    const startAssistant = lastAssistant;

    setError("");
    streaming = true;
    syncRunButton();

    if (!isRevise) {
      // 新的一轮：丢掉旧版本，换掉对比用的原文
      branches = [];
      activeBranch = 0;
      activeItem = 0;
      inspecting = null;
      sourceText = text;
      resultEl.value = "";
      renderPanes();
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
            // 结果刚冒头就把视线带过去，不等出完（只划一次，免得每来一段都划）
            if (!scrolledThisRun) {
              scrolledThisRun = true;
              if (resultWrap.hidden) resultWrap.hidden = false;
              scrollToResult();
            }
          } else if (event.type === "done") {
            finished = true;
            const finalText =
              typeof event.optimized === "string" && event.optimized
                ? event.optimized
                : cleanStreaming(acc);
            const item = { text: finalText, assistant: event.assistant || null };
            if (mode === "rewrite") {
              // 同一要求下再重写一次：只加小版本，链条不动
              const branch = branches[activeBranch];
              if (branch) {
                branch.items.push(item);
                activeItem = branch.items.length - 1;
              }
            } else if (isRevise) {
              // 带了新要求：记成新的大版本，标题就是这次的要求
              const detail = pendingDetail || pendingLabels.join("、") || "手写要求";
              const label = pendingLabels.length
                ? pendingLabels.join("、")
                : detail.length > 10
                  ? detail.slice(0, 10) + "…"
                  : detail;
              // 从中间那节改进：它后面的版本被这一版取代（链条不留分叉），
              // 大版本号就是被占住的那个位置，小版本从 1 重开。
              if (at >= 0 && at < branches.length) branches = branches.slice(0, at);
              branches.push({
                label,
                detail,
                labels: pendingLabels.slice(),
                base: startAssistant,
                items: [item],
              });
              activeBranch = branches.length - 1;
              activeItem = 0;
              activeBranch = branches.length - 1;
              activeItem = 0;
              // 右栏默认停在上一个大版本的最新一次重写，方便直接比
              const prev = branches[branches.length - 2];
              inspecting = prev
                ? { branch: branches.length - 2, item: Math.max(0, prev.items.length - 1) }
                : null;
            } else {
              // 首轮优化：第一个大版本
              branches.push({ label: "初版", detail: "从原文直接优化", labels: [], base: null, items: [item] });
              activeBranch = 0;
              activeItem = 0;
              inspecting = null;
            }
            lastAssistant = event.assistant || null;
            lenInfoEl.textContent = `${sourceText.length} → ${finalText.length} 字`;
            renderPanes();
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

  /** 复制一段文本：三层兜底。前两层都可能落空（宿主没授权 / 浏览器要用户手势，
      而 await 之后手势就过期了），所以最后一层用同步的 execCommand，不挑权限也不挑手势。 */
  const copyText = async (text, what) => {
    if (!text) return;
    let ok = false;

    try {
      await hana.clipboard.writeText(text);
      ok = true;
    } catch {
      /* 没授权或不支持，往下走 */
    }

    if (!ok) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch {
        /* 手势常见已失效 */
      }
    }

    if (!ok) {
      try {
        const holder = document.createElement("textarea");
        holder.value = text;
        holder.setAttribute("readonly", "readonly");
        holder.style.position = "fixed";
        holder.style.top = "0";
        holder.style.opacity = "0";
        document.body.appendChild(holder);
        holder.select();
        ok = document.execCommand("copy");
        holder.remove();
      } catch {
        ok = false;
      }
    }

    toast(ok ? `已复制${what}` : "复制失败，请手动选择复制", ok ? "success" : "error");
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
  // 提示词一改，就重新问一次「这条适合往哪改」
  inputEl.addEventListener("input", scheduleFixSuggestion);
  // 输入框里一有要求，「重写」就腾出位置给「改进」
  reviseEl.addEventListener("input", syncRunButton);

  // 光标在内容框里时，滚轮只滚框内；滚到头也不把滚动传给整张卡片
  //（滚轮默认会「滚动链」到祖先容器，这里在到边时截住）
  // 框内容没超出时，顶与底是同一个位置，两个方向都算到边，于是它一律不外传
  for (const el of [inputEl, extraEl, reviseEl, resultEl, refTextEl]) {
    el.addEventListener(
      "wheel",
      (e) => {
        const atTop = el.scrollTop <= 0;
        const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
        if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
      },
      { passive: false },
    );
  }
  inputEl.addEventListener("keydown", (e) => {
    // 聊天框那套：Enter 直接优化，Shift + Enter 换行；
    // isComposing 是输入法选词那一回车，不能当成提交
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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

  /** 纯重写：退回这一大版本的基底，用同样的要求再出一版（这样才能和上一版有区别） */
  const runRewriteOf = (branch) => {
    if (!branch) return;
    lastAssistant = branch.base || null;
    void runStream(branch.detail || "按同样的要求再写一版", {
      labels: branch.labels || [],
      mode: "rewrite",
    }).finally(clearPicked);
  };

  /**
   * 三格的分工，差别只在「底稿从哪来」：
   *   picked  从流程图上选中的那一项开始改进（带要求），它后面的版本会被新结果取代
   *   latest  从流程图的最后一版开始改进（带要求），接在末尾
   *   left    左栏当前那版（不带要求时等同那个「+」，算小版本）
   */
  const runRevise = (from) => {
    const labels = fixes.filter((item) => pickedFixes.has(item.id)).map((item) => item.label);
    const request = composeRevise();
    // 以所选项改进要求真的选中了某一节（停在「原文」不算），否则会退成以最新版改
    if (from === "picked" && !inspecting) {
      setError("先在流程图上点一节（「原文」不算），再以所选项改进。");
      return;
    }
    const usePicked = from === "picked";
    // 选中的那项不在时退回最后一版，不打断操作
    const base = usePicked
      ? inspectedItem() || latestItemOf(latestBranch())
      : from === "latest"
        ? latestItemOf(latestBranch())
        : currentItem() || latestItemOf(latestBranch());
    if (!base || !base.assistant) {
      setError(
        from === "picked"
          ? "先去流程图上点一节，再以所选项改进。"
          : "还没有可修改的结果，先优化一次。",
      );
      return;
    }

    if (!request) {
      // 没有新要求 → 等同「+」：在当前大版本上再重写一次
      runRewriteOf(branches[activeBranch]);
      return;
    }

    lastAssistant = base.assistant;
    // 新版本占住哪一节：从「被点的那节」往后一位。这样从中间改会取代后面的版本，
    // 而不是接在链条尾巴上。
    // 从所选项改进 → 占住它后面那一节（后面的被取代）；改进 / 重写 → 接在末尾
    const at = (usePicked ? inspecting.branch : branches.length - 1) + 1;
    // 先把这条回显到输入框，让用户看清这次到底要发什么
    reviseEl.value = request;
    autoGrow(reviseEl);
    void runStream(request, { labels, mode: "branch", at }).finally(clearPicked);
  };

  /** 「+」：不带新要求，在当前大版本上再重写一次，记成小版本 */
  const runAgain = () => {
    runRewriteOf(branches[activeBranch]);
  };

  // 三格：以所选项改进（带要求，取代它后面）｜重写（不带要求）｜改进（带要求，接在最后一版之后）
  revisePickedBtn.addEventListener("click", () => runRevise("picked"));
  reviseLeft.addEventListener("click", () => runRevise("left"));
  reviseRight.addEventListener("click", () => runRevise("latest"));
  // 与基础提示词一致：Enter 执行，Shift + Enter 换行
  reviseEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      runRevise("left");
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
    branches = [];
    activeBranch = 0;
    activeItem = 0;
    inspecting = null;
    renderPanes();
    setError("");
    syncCount();
    inputEl.focus();
  });

  // 左格：最新那一次重写（不等同于左栏正在显示的那次，左栏可以翻到旧的）
  copyBtn.addEventListener("click", () => {
    const latest = latestItemOf(latestBranch());
    if (!latest) return;
    void copyText(latest.text, "最新版本");
  });

  // 右格：右栏正在对照的那一版
  copyPickedBtn.addEventListener("click", () => {
    const item = inspectedItem();
    if (!item) {
      toast("右栏停在原文，先点链条切到某一版", "warning");
      return;
    }
    void copyText(item.text, item.label || "所选版");
  });

  // 补充要求与继续改都是多行框，跟着内容长（一行起、六行封顶）
  for (const el of [extraEl, reviseEl]) {
    el.addEventListener("input", () => autoGrow(el));
    autoGrow(el);
  }

  syncCount();
  syncRunButton();
  renderFixLists();
  renderVersionTabs();
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
