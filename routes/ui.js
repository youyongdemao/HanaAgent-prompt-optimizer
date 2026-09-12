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
  // 卡片 HTML 一律不缓存。改了前端却看到旧界面，多是这一层被缓存了：
  // 资源地址本身带 v= 版本戳，但拿到旧 HTML 就等于拿到旧戳。
  const noStore = (c) => {
    try {
      c.header("Cache-Control", "no-store, no-cache, must-revalidate");
      c.header("Pragma", "no-cache");
    } catch {
      /* 宿主若换了响应 API，忽略即可 */
    }
    return c;
  };
  app.get("/card", (c) => noStore(c).html(renderShell(c, ctx, "card")));
  // legacy：0.450.x 一类旧宿主不认 contributes.cards，只认 widget/page
  app.get("/widget", (c) => noStore(c).html(renderShell(c, ctx, "widget")));
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
  // 资源地址必须带上宿主的 token。
  // 桌面端主窗口是 loadFile 出来的，父页面 origin 不透明，宿主那个
  // hana_plugin_assets_* cookie（SameSite=Strict）逃不进这种文档；
  // 少了 token，panel.js 会 403，函数不执行、hana.ready 发不出去，
  // 宿主 5 秒粻底判为「加载失败」。session-insight 就是靠改地址带 token 才稳的。
  const token = String(c.req.query("token") || "");
  const withToken = (url) =>
    token ? `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : url;
  // 资源版本戳：宿主会对 /assets/* 做缓存，不带这个参数时改了 css/js 也刷不出来。
  // 每次改动前端资源顺手改一次这个值。
  const ASSET_VERSION = "0.2.1";
  const withVersion = (url) => `${url}${url.includes("?") ? "&" : "?"}v=${ASSET_VERSION}`;
  const panelCssUrl = withVersion(withToken(pluginAssetUrl(assetBase, "panel.css")));
  const panelJsUrl = withVersion(withToken(pluginAssetUrl(assetBase, "panel.js")));
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
  <script>
    // 兜底：脚本若未执行就报错，至少把失败摆到界面上，方便定位
    window.addEventListener("error", function (e) {
      var root = document.getElementById("root");
      if (root && !root.innerHTML) {
        root.textContent = "面板加载失败：" + ((e && e.message) || "脚本错误");
      }
    });
  </script>
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
