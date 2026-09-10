// 卡片外壳。
//
// 主题这块有两个坑，都踩过：
//
// 1) 宿主注入的 ?hana-css 在少数情况下会是 theme.css?theme=auto（服务端没有
//    themes/auto.css，只回 21 字节的 /* theme not found */），所以不能盲信，
//    拿到 auto 就自己按亮暗兜底。
// 2) 更关键：宿主渲染插件 iframe 的 useMemo 依赖里没有 theme，换主题时不会重算
//    地址，iframe 也不会重载。所以「换主题卡片不跟着变」不是样式问题，
//    而是要听宿主推来的 hana.theme.changed 事件（见 assets/panel.js）。
//
// 这里只负责把初始状态给准：一个可被 JS 替换的链接 + body 上的初始值。

const THEME_CSS_PATH = "/api/plugins/theme.css";
const AUTO_LIGHT_THEME = "warm-paper";
const AUTO_DARK_THEME = "midnight";

export default function registerPluginUiRoutes(app, ctx) {
  app.get("/card", (c) => c.html(renderShell(c, ctx, "card")));
}

/** 把宿主给的主题地址里的 theme 参数校正成指定主题（保留 token 等其它参数）。 */
function themeCssUrl(baseCss, themeId) {
  const raw = String(baseCss || "").trim();
  const fallback = `${THEME_CSS_PATH}?theme=${encodeURIComponent(themeId)}`;
  if (!raw) return fallback;
  try {
    const url = new URL(raw, "http://hana.local");
    url.searchParams.set("theme", themeId);
    return /^https?:\/\//i.test(raw) ? url.toString() : `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

function renderShell(c, ctx, surface) {
  const theme = String(c.req.query("hana-theme") || "").trim();
  const hostCss = c.req.query("hana-css") || "";
  const isConcrete = Boolean(theme) && theme !== "auto";

  // 具体主题：直接用宿主地址；auto/未知：先按浅色兜底，前端再按系统亮暗纠正
  const initialHref = isConcrete
    ? themeCssUrl(hostCss, theme)
    : themeCssUrl(hostCss, AUTO_LIGHT_THEME);

  const assetBase = c.req.query("hana-asset-base") || `/api/plugins/${encodeURIComponent(ctx.pluginId)}/assets`;
  const panelCssUrl = pluginAssetUrl(assetBase, "panel.css");
  const panelJsUrl = pluginAssetUrl(assetBase, "panel.js");
  const title = "提示词优化";

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <link id="po-theme-css" rel="stylesheet" href="${escapeAttr(initialHref)}">
  <link rel="stylesheet" href="${escapeAttr(panelCssUrl)}">
</head>
<body data-hana-theme="${escapeAttr(theme)}" data-surface="${surface}">
  <div id="root" data-surface="${surface}"></div>
  <script type="module" src="${escapeAttr(panelJsUrl)}"></script>
</body>
</html>`;
}

function pluginAssetUrl(assetBase, assetPath) {
  const rawBase = String(assetBase || "");
  const encodedPath = String(assetPath)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  try {
    const parsed = new URL(rawBase, "http://hana.local");
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${encodedPath}`;
    if (/^https?:\/\//i.test(rawBase)) return parsed.toString();
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    const fallbackBase = rawBase.replace(/\/+$/, "");
    return `${fallbackBase}/${encodedPath}`;
  }
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeHtml(value) {
  return escapeAttr(value).replace(/>/g, "&gt;");
}
