// 提示词优化 · WebView 卡片前端
// 复用宿主消息协议；无构建步骤，直接跑。
// 视觉与交互（含鼠标跟踪光晕）与 Session Insight 对齐。

const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
let seq = 0;

function targetOrigin() {
  const params = new URLSearchParams(window.location.search);
  const explicit = params.get("hana-host-origin");
  if (explicit) return explicit;
  try {
    return new URL(document.referrer).origin;
  } catch {
    return "*";
  }
}

function post(message) {
  window.parent.postMessage(message, targetOrigin());
}

function event(type, payload) {
  post({ protocol: PROTOCOL, version: VERSION, kind: "event", type, payload });
}

function request(type, payload, timeoutMs = 20000) {
  const id = `hana-plugin-${Date.now()}-${++seq}`;
  const origin = targetOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener("message", onMessage);
      reject(new Error(`Host request timed out: ${type}`));
    }, timeoutMs);

    function onMessage(evt) {
      if (evt.source !== window.parent) return;
      if (origin !== "*" && evt.origin !== origin) return;
      const msg = evt.data || {};
      if (msg.protocol !== PROTOCOL || msg.version !== VERSION || msg.id !== id || msg.type !== type) return;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      if (msg.kind === "error") reject(new Error(msg.error?.message || `Host request failed: ${type}`));
      else resolve(msg.payload);
    }

    window.addEventListener("message", onMessage);
    post({ protocol: PROTOCOL, version: VERSION, id, kind: "request", type, payload });
  });
}

function currentPluginId() {
  const match = /^\/api\/plugins\/([^/]+)(?:\/|$)/.exec(window.location.pathname || "");
  if (!match) throw new Error("Plugin API helper requires a WebView route under /api/plugins/:pluginId/.");
  return decodeURIComponent(match[1]);
}

function normalizePluginApiPath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid plugin API path.");
  const trimmed = input.trim();
  if (
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed.includes("#") ||
    trimmed.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) throw new Error("Invalid plugin API path.");

  const stripped = trimmed.replace(/^\/+/, "");
  if (!stripped || stripped.startsWith("./") || stripped === "api/plugins" || stripped.startsWith("api/plugins/")) {
    throw new Error("Invalid plugin API path. Use a route path relative to the current plugin.");
  }
  const queryIndex = stripped.indexOf("?");
  const rawPath = queryIndex >= 0 ? stripped.slice(0, queryIndex) : stripped;
  const segments = rawPath.split("/");
  for (const segment of segments) {
    if (!segment) throw new Error("Invalid plugin API path.");
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) {
      throw new Error("Invalid plugin API path.");
    }
  }
  const parsed = new URL(`http://hana.local/${stripped}`);
  return `${segments.map((segment) => encodeURIComponent(decodeURIComponent(segment))).join("/")}${parsed.search}`;
}

function pluginApiUrl(path) {
  return `${window.location.origin}/api/plugins/${encodeURIComponent(currentPluginId())}/${normalizePluginApiPath(path)}`;
}

function pluginApiFetch(path, init = {}) {
  const surfaceSession = new URLSearchParams(window.location.search).get("pluginSurfaceSession");
  if (!surfaceSession) throw new Error("hana.api.fetch requires pluginSurfaceSession in the WebView URL.");
  const headers = new Headers(init.headers || {});
  headers.set("X-Hana-Plugin-Surface-Session", surfaceSession);
  return fetch(pluginApiUrl(path), { ...init, headers });
}

const hana = {
  ready: () => event("hana.ready"),
  ui: { resize: (size) => event("ui.resize", size) },
  api: { url: pluginApiUrl, fetch: pluginApiFetch },
  toast: { show: (input) => request("toast.show", input) },
  clipboard: { writeText: (text) => request("clipboard.writeText", typeof text === "string" ? { text } : text) },
  external: { open: (url) => request("external.open", typeof url === "string" ? { url } : url) },
  theme: {
    getSnapshot: () => {
      const params = new URLSearchParams(window.location.search);
      return { theme: params.get("hana-theme") || undefined, cssUrl: params.get("hana-css") || undefined };
    },
  },
};

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

const DEFAULT_REPO_URL = "https://github.com/youyongdemao/HanaAgent-prompt-optimizer";

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

const THEME_CSS_PATH = "/api/plugins/theme.css";
const AUTO_LIGHT_THEME = "warm-paper";
const AUTO_DARK_THEME = "midnight";

const darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

let currentTheme = "";
let currentThemeCss = "";

function themeCssFor(themeId) {
  return `${THEME_CSS_PATH}?theme=${encodeURIComponent(themeId)}`;
}

function applyThemeCss(theme, cssUrl) {
  const link = document.getElementById("po-theme-css");
  if (!link) return;
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

      <div class="po-foot">
        <button id="po-update" class="po-tbtn" type="button" title="从 GitHub Releases 检查新版本">
          <span class="ic" id="po-update-ic">⇧</span><span class="po-btn-tx" id="po-update-tx">更新</span>
        </button>
        <button id="po-repo" class="po-tbtn" type="button" title="打开 GitHub 仓库主页">
          <svg class="gh-ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15.08-.2.04-.42-.09-.57-.2-.22-.78-.71-1.54-2.04-.33-.57.11-1.06.39-1 .46.1 1.43.76 1.88 1.03.44.26 1.12.44 1.65.35.35-.05.58-.03.84.05.89.27 1.92.41 2.7.29C12.79 15 16 11.87 16 8c0-4.42-3.58-8-8-8z"/></svg>
          <span class="po-btn-tx">GitHub</span>
        </button>
      </div>
    </main>

    <div id="po-update-modal" class="po-modal" hidden>
      <div class="po-modal-card" role="dialog" aria-modal="true" aria-labelledby="po-update-title">
        <div id="po-update-mark" class="po-modal-mark">↻</div>
        <h3 id="po-update-title">发现新版本</h3>
        <p id="po-update-text" class="po-modal-text"></p>
        <div id="po-update-notes" class="po-modal-notes" hidden></div>
        <div class="po-modal-actions">
          <button id="po-update-later" class="po-btn" type="button"><span class="po-btn-tx">稍后</span></button>
          <button id="po-update-apply" class="po-btn po-modal-confirm" type="button"><span class="po-btn-tx" id="po-update-apply-tx">立即更新</span></button>
        </div>
      </div>
    </div>
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
  const updateBtn = document.getElementById("po-update");
  const updateTx = document.getElementById("po-update-tx");
  const updateIc = document.getElementById("po-update-ic");
  const repoBtn = document.getElementById("po-repo");

  const updateModal = document.getElementById("po-update-modal");
  const modalMark = document.getElementById("po-update-mark");
  const modalTitle = document.getElementById("po-update-title");
  const modalText = document.getElementById("po-update-text");
  const modalNotes = document.getElementById("po-update-notes");
  const modalLaterBtn = document.getElementById("po-update-later");
  const modalApplyBtn = document.getElementById("po-update-apply");
  const modalApplyTx = document.getElementById("po-update-apply-tx");

  let style = "general";
  let loading = false;
  let updateBusy = false;
  let repoUrl = DEFAULT_REPO_URL;
  let updateResetTimer = null;

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
      const resp = await hana.api.fetch("optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, style, extra: extraEl.value }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        setError(data?.message || `优化失败（${resp.status}）`);
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

  const setUpdateLabel = (text, spinning) => {
    updateTx.textContent = text;
    updateIc.textContent = spinning ? "↻" : "⇧";
    updateIc.classList.toggle("spin", Boolean(spinning));
  };

  const checkUpdate = async () => {
    if (updateBusy) return;
    updateBusy = true;
    updateBtn.disabled = true;
    if (updateResetTimer) window.clearTimeout(updateResetTimer);
    setUpdateLabel("检查中", true);
    try {
      const resp = await hana.api.fetch("update-check");
      const data = await resp.json().catch(() => ({}));
      if (data?.ok && data.updateAvailable) {
        setUpdateLabel(`发现 v${data.latestVersion}`, false);
        openUpdateModal(data);
      } else if (data?.ok) {
        setUpdateLabel("已是最新", false);
        toast(`已是最新版本 v${data.currentVersion}`, "success");
      } else {
        setUpdateLabel("更新", false);
        toast(data?.message || "检查更新失败", "warning");
      }
    } catch (err) {
      setUpdateLabel("更新", false);
      toast(String(err?.message || err), "error");
    } finally {
      updateBusy = false;
      updateBtn.disabled = false;
      updateResetTimer = window.setTimeout(() => setUpdateLabel("更新", false), 3500);
    }
  };

  // ── 更新弹窗 ──
  // 触发时机：插件启动 / 打开卡片 / 刷新都会重新跑一遍 render，
  // 自动检查统一挂在这里，没有新版本就什么都不显示。

  let pendingUpdate = null;

  // 把 Release 正文（Markdown）重排成干净的结构。
  // 不照搬编辑页里的原文：# 和 - 这些符号全部丢掉，层级交给样式表达；
  // 首行版本号跳过（弹窗标题里已经写了），--- 分隔线直接扔。
  const renderNotes = (markdown) => {
    const frag = document.createDocumentFragment();
    const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
    let list = null;
    let seenHeadingOrItem = false;

    const flushList = () => {
      if (!list) return;
      frag.appendChild(list);
      list = null;
    };

    lines.forEach((raw, index) => {
      const line = raw.trim();
      if (!line) {
        flushList();
        return;
      }
      // 分隔线、纯符号行：不要
      if (/^[-*_=~]{3,}$/.test(line)) return;
      // 首行若是纯版本号，跳过（标题已经有）
      if (index === 0 && /^v?\d+(\.\d+)*$/.test(line)) return;

      const heading = /^#{1,6}\s*(.+)$/.exec(line);
      if (heading) {
        flushList();
        const label = document.createElement("div");
        label.className = "po-note-group";
        label.textContent = heading[1].replace(/[:：]\s*$/, "").trim();
        frag.appendChild(label);
        seenHeadingOrItem = true;
        return;
      }

      const item = /^[-*+]\s+(.+)$/.exec(line);
      if (item) {
        if (!list) {
          list = document.createElement("ul");
          list.className = "po-note-list";
        }
        const li = document.createElement("li");
        li.textContent = item[1].trim();
        list.appendChild(li);
        seenHeadingOrItem = true;
        return;
      }

      flushList();
      const isMeta = /^sha256[:：]/i.test(line);
      const p = document.createElement("p");
      p.className = isMeta ? "po-note-meta" : "po-note-line";
      p.textContent = line;
      frag.appendChild(p);
      seenHeadingOrItem = true;
    });

    flushList();
    return seenHeadingOrItem ? frag : null;
  };

  const closeUpdateModal = () => {
    updateModal.classList.remove("open");
    window.setTimeout(() => {
      updateModal.hidden = true;
      pendingUpdate = null;
    }, 220);
  };

  const openUpdateModal = (info) => {
    pendingUpdate = info;
    modalMark.textContent = "↻";
    modalTitle.textContent = `发现新版本 v${info.latestVersion}`;
    modalText.textContent = `当前版本 v${info.currentVersion}，现在更新吗？更新完成后页面会自动刷新。`;
    const notes = String(info.notes || "").trim();
    const notesFrag = notes ? renderNotes(notes) : null;
    if (notesFrag) modalNotes.replaceChildren(notesFrag);
    else modalNotes.replaceChildren();
    modalNotes.hidden = !notesFrag;
    // 没挂 zip 的版本只能去 Release 页手动拿，按钮文案跟着变
    modalApplyTx.textContent = info.canAutoInstall ? "立即更新" : "去 Release 页";
    modalApplyBtn.disabled = false;
    modalApplyBtn.hidden = false;
    modalLaterBtn.hidden = false;
    updateModal.hidden = false;
    requestAnimationFrame(() => updateModal.classList.add("open"));
  };

  const applyUpdate = async () => {
    if (!pendingUpdate) return;

    if (!pendingUpdate.canAutoInstall) {
      if (pendingUpdate.url) hana.external.open({ url: pendingUpdate.url }).catch(() => {});
      return;
    }

    const target = pendingUpdate.latestVersion;
    modalApplyBtn.disabled = true;
    modalApplyTx.textContent = "更新中…";
    modalLaterBtn.hidden = true;
    modalText.textContent = `正在下载并安装 v${target}，完成后页面会自动刷新。`;

    try {
      const resp = await hana.api.fetch("update-apply", { method: "POST" });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data?.ok) {
        modalMark.textContent = "!";
        modalText.textContent = data?.message || `更新失败（${resp.status}）`;
        modalApplyTx.textContent = "重试";
        modalApplyBtn.disabled = false;
        modalLaterBtn.hidden = false;
        return;
      }
      modalMark.textContent = "✓";
      modalText.textContent = `已更新到 v${data.toVersion}，正在刷新…`;
      // 带个时间戳参数重新进卡片，免得外壳 HTML 又被缓存顶回旧版
      window.setTimeout(() => {
        const next = new URL(window.location.href);
        next.searchParams.set("po_reload", Date.now().toString(36));
        window.location.replace(next.toString());
      }, 900);
    } catch (err) {
      modalMark.textContent = "!";
      modalText.textContent = `更新失败：${String(err?.message || err)}`;
      modalApplyTx.textContent = "重试";
      modalApplyBtn.disabled = false;
      modalLaterBtn.hidden = false;
    }
  };

  const autoCheckUpdate = async () => {
    try {
      const resp = await hana.api.fetch("update-check");
      const data = await resp.json().catch(() => ({}));
      if (!data?.ok || !data.updateAvailable) return;
      openUpdateModal(data);
    } catch {
      /* 自动检查失败不打扰：网络断了、仓库改名之类都静默咽下 */
    }
  };

  modalLaterBtn.addEventListener("click", closeUpdateModal);
  updateModal.addEventListener("click", (ev) => {
    if (ev.target === updateModal) closeUpdateModal();
  });
  modalApplyBtn.addEventListener("click", applyUpdate);

  const openRepo = async () => {
    try {
      await hana.external.open({ url: repoUrl });
    } catch (err) {
      toast(`打开失败：${String(err?.message || err)}`, "error");
    }
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
  updateBtn.addEventListener("click", checkUpdate);
  repoBtn.addEventListener("click", openRepo);

  syncCount();
  requestAnimationFrame(fitHeight);

  // 取一次本地元信息（版本 + 仓库地址），供 GitHub 按钮使用。
  // 注意：hana.api.fetch 在缺 pluginSurfaceSession 时会「同步」抛错（不是返回 rejected Promise），
  // 而它正在 render() 末尾、hana.ready() 之前——一抛就会把握手一起带走，
  // 宿主则表现为 5 秒超时「加载失败」。所以这里必须包住。
  try {
    hana.api
      .fetch("meta")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && typeof data.repoUrl === "string" && data.repoUrl) repoUrl = data.repoUrl;
      })
      .catch(() => {
        /* 取不到就沿用默认仓库地址 */
      });
  } catch {
    /* 没有 surface session 时忽略，不影响主流程 */
  }

  // 启动 / 打开卡片 / 刷新都会走到这里：静默查一次更新，有新版本才弹窗
  window.setTimeout(() => {
    void autoCheckUpdate();
  }, 700);
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

// 宿主推送主题变更：这是切主题时唯一可靠的信号
window.addEventListener("message", (evt) => {
  if (evt.source !== window.parent) return;
  const msg = evt.data || {};
  if (msg.protocol !== PROTOCOL || msg.version !== VERSION) return;
  if (msg.kind !== "event" || msg.type !== "hana.theme.changed") return;
  const payload = msg.payload || {};
  applyHostTheme(payload.theme, payload.cssUrl);
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
