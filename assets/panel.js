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

function render() {
  if (!root) return;

  root.innerHTML = `
    <main class="po">
      <div class="po-top">
        <p class="po-hint">写粗糙版，优化成模型更懂的结构化提示词</p>
        <div class="po-top-actions">
          <button id="po-update" class="po-tbtn" type="button" title="从 GitHub Releases 检查新版本">
            <span class="ic" id="po-update-ic">⇧</span><span class="po-btn-tx" id="po-update-tx">更新</span>
          </button>
          <button id="po-repo" class="po-tbtn" type="button" title="打开 GitHub 仓库主页">
            <svg class="gh-ic" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15.08-.2.04-.42-.09-.57-.2-.22-.78-.71-1.54-2.04-.33-.57.11-1.06.39-1 .46.1 1.43.76 1.88 1.03.44.26 1.12.44 1.65.35.35-.05.58-.03.84.05.89.27 1.92.41 2.7.29C12.79 15 16 11.87 16 8c0-4.42-3.58-8-8-8z"/></svg>
            <span class="po-btn-tx">GitHub</span>
          </button>
        </div>
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
  const updateBtn = document.getElementById("po-update");
  const updateTx = document.getElementById("po-update-tx");
  const updateIc = document.getElementById("po-update-ic");
  const repoBtn = document.getElementById("po-repo");

  let style = "general";
  let loading = false;
  let updateBusy = false;
  let repoUrl = DEFAULT_REPO_URL;
  let updateResetTimer = null;

  const fitHeight = () => {
    const h = Math.ceil(document.body.scrollHeight || 0);
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
        toast(`发现新版本 v${data.latestVersion}（当前 v${data.currentVersion}），点 GitHub 前往下载`, "info");
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

  // 取一次本地元信息（版本 + 仓库地址），供 GitHub 按钮使用
  hana.api
    .fetch("meta")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && typeof data.repoUrl === "string" && data.repoUrl) repoUrl = data.repoUrl;
    })
    .catch(() => {
      /* 取不到就沿用默认仓库地址 */
    });
}

render();
hana.ready();
syncTheme();

// 宿主换主题时（html 的 data-theme / class / style 变化）重判亮暗与前景色。
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
