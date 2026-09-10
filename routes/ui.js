
export default function registerPluginUiRoutes(app, ctx) {
  app.get("/card", (c) => c.html(renderShell(c, ctx, "card")));
}

function renderShell(c, ctx, surface) {
  const hanaCss = c.req.query("hana-css") || "";
  const theme = c.req.query("hana-theme") || "inherit";
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
  ${hanaCss ? `<link rel="stylesheet" href="${escapeAttr(hanaCss)}">` : ""}
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
    .map(segment => encodeURIComponent(segment))
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
