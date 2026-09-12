import fs from "node:fs";
import path from "node:path";
import { extractAll, stripCommonRoot } from "../lib/zip.js";

// 默认仓库；可在「设置 → 插件 → 提示词优化」里用 githubRepo 覆盖。
const DEFAULT_REPO = "youyongdemao/HanaAgent-prompt-optimizer";

// 这些文件即便新版本里带了也不覆盖：属于"当前这份安装"的身份，不是代码。
const PROTECTED_FILES = new Set(["plugin.json", ".installed.json", "install.json"]);

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

/** 从 release 的资产里挑出可安装的包：优先 zip。 */
function pickArchive(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const zips = assets.filter((a) => String(a?.name || "").toLowerCase().endsWith(".zip"));
  const chosen = zips[0] || assets.find((a) => /\.(zip|tar\.gz|tgz)$/i.test(String(a?.name || "")));
  if (!chosen || typeof chosen.browser_download_url !== "string") return null;
  return {
    name: String(chosen.name || ""),
    url: chosen.browser_download_url,
    size: Number(chosen.size) || 0,
    digest: typeof chosen.digest === "string" ? chosen.digest : "",
  };
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
    notes: typeof data?.body === "string" ? data.body.slice(0, 2000) : "",
    publishedAt: typeof data?.published_at === "string" ? data.published_at : "",
    archive: pickArchive(data),
  };
}

/** 判断某个相对路径是否落在插件目录内（挡掉 ../ 之类）。 */
function isInsidePluginDir(pluginDir, relativePath) {
  const target = path.resolve(pluginDir, relativePath);
  const root = path.resolve(pluginDir);
  return target === root || target.startsWith(root + path.sep);
}

/**
 * 把 ctx.network.fetch 的响应读成 Buffer。
 * 正常情况是 Response 形态（有 arrayBuffer），但不同宿主版本细节有差，
 * 这里做一层兜底，免得下载环节挂着看不出来为什么。
 */
async function readBinary(res) {
  if (typeof res?.arrayBuffer === "function") return Buffer.from(await res.arrayBuffer());
  if (Buffer.isBuffer(res?.body)) return res.body;
  if (res?.body instanceof Uint8Array) return Buffer.from(res.body);
  throw new Error("宿主返回的响应无法读成二进制");
}

/** 更新前把当前这份插件整目录复制到插件私有数据目录，出事能翻回来。 */
function backupCurrent(ctx, version) {
  const base = typeof ctx?.dataDir === "string" && ctx.dataDir ? ctx.dataDir : path.join(ctx.pluginDir, ".backup");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(base, "backups", `${normalizeVersion(version) || "unknown"}-${stamp}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(ctx.pluginDir, dest, { recursive: true, force: true });
  return dest;
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
      notes: release.notes,
      publishedAt: release.publishedAt,
      // 有更新但没挂 zip 时，前端只给"去 Release 页"这一个选择
      canAutoInstall: Boolean(release.archive),
      archiveName: release.archive?.name || "",
      archiveSize: release.archive?.size || 0,
    });
  });

  // 真的更新：下载 Release 里的 zip → 解压 → 覆盖插件目录。
  app.post("/update-apply", async (c) => {
    const version = currentVersion(ctx);
    const repo = await resolveRepo(ctx);

    let release;
    try {
      release = await latestRelease(ctx, repo);
    } catch (error) {
      return c.json(
        { ok: false, code: "CHECK_FAILED", message: `检查更新失败：${String(error?.message || error)}` },
        502,
      );
    }

    if (release.missing) {
      return c.json({ ok: false, code: "NO_RELEASE", message: "仓库或 Release 尚未发布" }, 404);
    }
    if (compareVersions(release.version, version) <= 0) {
      return c.json({ ok: false, code: "UP_TO_DATE", message: `当前已是最新版本 v${version}` }, 409);
    }
    if (!release.archive) {
      return c.json(
        {
          ok: false,
          code: "NO_ARCHIVE",
          message: "这个版本没有附带可安装的 zip，请到 Release 页面手动下载",
          url: release.url,
        },
        409,
      );
    }

    // 1. 下载
    let raw;
    try {
      const res = await ctx.network.fetch(release.archive.url, {
        headers: { "User-Agent": "hana-plugin-prompt-optimizer" },
        timeoutMs: 30000,
      });
      if (!res.ok) {
        return c.json(
          { ok: false, code: "DOWNLOAD_FAILED", message: `下载失败：HTTP ${res.status}` },
          502,
        );
      }
      raw = await readBinary(res);
    } catch (error) {
      return c.json(
        { ok: false, code: "DOWNLOAD_FAILED", message: `下载失败：${String(error?.message || error)}` },
        502,
      );
    }

    // 2. 解压 + 结构校验
    let files;
    try {
      files = stripCommonRoot(extractAll(raw));
    } catch (error) {
      return c.json(
        { ok: false, code: "UNZIP_FAILED", message: `解压失败：${String(error?.message || error)}` },
        502,
      );
    }

    const manifestRaw = files.get("manifest.json");
    if (!manifestRaw) {
      return c.json(
        { ok: false, code: "BAD_PACKAGE", message: "包里没有 manifest.json，不是有效的插件包" },
        422,
      );
    }

    let packed = {};
    try {
      packed = JSON.parse(manifestRaw.toString("utf8"));
    } catch {
      return c.json({ ok: false, code: "BAD_PACKAGE", message: "包里的 manifest.json 无法解析" }, 422);
    }
    if (typeof packed.version !== "string" || compareVersions(packed.version, release.version) !== 0) {
      return c.json(
        {
          ok: false,
          code: "VERSION_MISMATCH",
          message: `包内版本（${packed.version || "未知"}）与 Release 版本（${release.version}）不一致，已中止`,
        },
        422,
      );
    }

    // 3. 先备份，再落盘
    let backupPath = "";
    try {
      backupPath = backupCurrent(ctx, version);
    } catch (error) {
      return c.json(
        { ok: false, code: "BACKUP_FAILED", message: `备份失败，已中止更新：${String(error?.message || error)}` },
        500,
      );
    }

    const written = [];
    const failed = [];
    for (const [relative, content] of files) {
      if (PROTECTED_FILES.has(relative)) continue;
      if (!isInsidePluginDir(ctx.pluginDir, relative)) {
        failed.push(`${relative}（越界）`);
        continue;
      }
      try {
        const target = path.join(ctx.pluginDir, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
        written.push(relative);
      } catch (error) {
        failed.push(`${relative}（${String(error?.message || error)}）`);
      }
    }

    if (!written.length) {
      return c.json(
        {
          ok: false,
          code: "WRITE_FAILED",
          message: `一个文件都没能写入，插件目录可能不可写。备份在 ${backupPath}`,
          failed,
        },
        500,
      );
    }

    return c.json({
      ok: true,
      fromVersion: version,
      toVersion: release.version,
      written: written.length,
      failed,
      backupPath,
      restartRequired: true,
      message:
        `已更新到 v${release.version}（写入 ${written.length} 个文件）。` +
        "重启插件后完全生效；界面上的新样式刷新卡片即可看到。",
    });
  });
}
