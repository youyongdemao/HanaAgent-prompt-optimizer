import fs from "node:fs";
import path from "node:path";

// 默认仓库；可在「设置 → 插件 → 提示词优化」里用 githubRepo 覆盖。
const DEFAULT_REPO = "youyongdemao/HanaAgent-prompt-optimizer";

function readManifest(ctx) {
  try {
    const raw = fs.readFileSync(path.join(ctx.pluginDir, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function currentVersion(ctx) {
  const v = readManifest(ctx).version;
  return typeof v === "string" && v.trim() ? v.trim() : "0.0.0";
}

async function resolveRepo(ctx) {
  try {
    const value = await ctx?.config?.get?.("githubRepo");
    if (typeof value === "string" && /^[\w.-]+\/[\w.-]+$/.test(value.trim())) return value.trim();
  } catch {
    /* 配置不可用或格式不对时回落到默认仓库 */
  }
  return DEFAULT_REPO;
}

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/i, "");
}

function parseVersion(value) {
  const parts = normalizeVersion(value)
    .split(/[.+-]/)
    .map((piece) => Number.parseInt(piece, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** a > b → 1；a < b → -1；相等 → 0 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

async function latestRelease(ctx, repo) {
  const res = await ctx.network.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hana-plugin-prompt-optimizer",
    },
    timeoutMs: 12000,
  });
  if (res.status === 404) {
    return { missing: true };
  }
  if (!res.ok) {
    throw new Error(`GitHub 返回 ${res.status}`);
  }
  const data = await res.json();
  return {
    missing: false,
    version: normalizeVersion(data?.tag_name || data?.name || ""),
    url: typeof data?.html_url === "string" ? data.html_url : `https://github.com/${repo}/releases`,
  };
}

export default function registerUpdateRoutes(app, ctx) {
  // 卡片启动时取一次：当前版本 + 仓库地址（纯本地，不联网）
  app.get("/meta", async (c) => {
    const repo = await resolveRepo(ctx);
    return c.json({
      ok: true,
      version: currentVersion(ctx),
      repo,
      repoUrl: `https://github.com/${repo}`,
    });
  });

  app.get("/update-check", async (c) => {
    const version = currentVersion(ctx);
    const repo = await resolveRepo(ctx);
    const repoUrl = `https://github.com/${repo}`;

    let release;
    try {
      release = await latestRelease(ctx, repo);
    } catch (error) {
      return c.json({
        ok: false,
        code: "CHECK_FAILED",
        message: `检查更新失败：${String(error?.message || error)}`,
        currentVersion: version,
        repoUrl,
      });
    }

    if (release.missing) {
      return c.json({
        ok: false,
        code: "NO_RELEASE",
        message: "仓库或 Release 尚未发布",
        currentVersion: version,
        repoUrl,
      });
    }

    const updateAvailable = compareVersions(release.version, version) > 0;
    return c.json({
      ok: true,
      currentVersion: version,
      latestVersion: release.version,
      updateAvailable,
      url: release.url,
      repoUrl,
    });
  });
}
