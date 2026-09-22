// prompt-optimizer v2 App — 服务端入口
//
// v1（插件形态）到 v2（应用形态）的对应关系：
//   routes/*.js + bus.request("model:sample-text")  →  sdk.routes.register + sdk.models.utility
//   tools/optimize_prompt.js                        →  sdk.tools.register
//   manifest.configuration                          →  应用自管 config.json + 自定义设置页
//   update-apply（下载 zip 覆盖插件目录）            →  删除：v2 应用目录宿主只读，更新走「设置 → 扩展」
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { defineApp } from "./sdk/app-contract/server-client.js";
import {
  buildSystemPrompt,
  buildUserMessage,
  clampInt,
  normalizeStyle,
  stripWrapping,
  DEFAULT_MAX_TOKENS,
  MAX_INPUT_CHARS,
} from "./lib/prompt.js";
import { registerUpdateRoutes } from "./lib/update-check.js";

export const name = "prompt-optimizer";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = "youyongdemao/HanaAgent-prompt-optimizer";

/** owner/repo 形状的仓库名；不合法时返回 null，由调用方回落到默认值 */
function normalizeRepo(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[\w.-]+\/[\w.-]+$/.test(text) ? text : null;
}

function readVersion() {
  try {
    const version = JSON.parse(readFileSync(join(APP_DIR, "manifest.json"), "utf8")).version;
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** 应用自管配置：dev 期是 dataDir/config.json（宿主保证可写） */
async function readConfig(sdk) {
  try {
    const raw = await readFile(join(sdk.dataDir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeConfig(sdk, patch) {
  const current = await readConfig(sdk);
  const next = { ...current, ...patch };
  for (const key of Object.keys(next)) {
    if (next[key] === undefined || next[key] === null || next[key] === "") delete next[key];
  }
  try {
    await mkdir(sdk.dataDir, { recursive: true });
    await writeFile(join(sdk.dataDir, "config.json"), JSON.stringify(next, null, 2), "utf8");
  } catch (error) {
    await sdk.logger.warn(`config write failed: ${error?.message ?? error}`);
  }
  return next;
}

/** 一次模型改写：v2 只开 sdk.models.utility，不接受 provider/key/endpoint。 */
async function sampleOptimized(sdk, { text, style, extra, maxTokens, callToken }) {
  const { text: optimized } = await sdk.models.utility({
    requestId: randomUUID(),
    ...(callToken ? { callToken } : { scope: "app" }),
    systemPrompt: buildSystemPrompt(style, extra),
    messages: [{ role: "user", content: buildUserMessage(text) }],
    temperature: 0.4,
    maxTokens,
  });
  return typeof optimized === "string" ? stripWrapping(optimized) : "";
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("prompt-optimizer loaded");

  const ctx = {
    appDir: APP_DIR,
    dataDir: sdk.dataDir,
    logger: sdk.logger,
    network: { fetch: (input, init) => sdk.network.fetch(input, init) },
    readConfig: () => readConfig(sdk),
  };

  await sdk.routes.register((app) => {
    app.get("/health", (c) => c.json({ ok: true, app: "prompt-optimizer" }));

    // 卡片启动时取一次：当前版本 + 仓库地址（纯本地，不联网）
    app.get("/meta", async (c) => {
      const cfg = await readConfig(sdk);
      const repo = normalizeRepo(cfg.githubRepo) ?? DEFAULT_REPO;
      return c.json({ ok: true, version: readVersion(), repo, repoUrl: `https://github.com/${repo}` });
    });

    // 设置页读写配置
    app.get("/config", async (c) => c.json({ ok: true, config: await readConfig(sdk) }));
    app.post("/config", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const repo = normalizeRepo(body?.githubRepo);
      if (body?.githubRepo != null && String(body.githubRepo).trim() !== "" && !repo) {
        return c.json({ ok: false, code: "BAD_REPO", message: "仓库格式应为 owner/repo。" }, 400);
      }
      const saved = await writeConfig(sdk, { githubRepo: repo ?? undefined });
      return c.json({ ok: true, config: saved });
    });

    app.post("/optimize", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }

      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!text) {
        return c.json({ ok: false, error: "EMPTY_INPUT", message: "请先写下要优化的提示词。" }, 400);
      }
      if (text.length > MAX_INPUT_CHARS) {
        return c.json(
          { ok: false, error: "INPUT_TOO_LONG", message: `提示词太长（上限 ${MAX_INPUT_CHARS} 字）。` },
          400,
        );
      }

      const style = normalizeStyle(body?.style);
      const extra = typeof body?.extra === "string" ? body.extra : "";
      const maxTokens = clampInt(body?.maxTokens, 256, 4096, DEFAULT_MAX_TOKENS);

      let optimized = "";
      try {
        optimized = await sampleOptimized(sdk, { text, style, extra, maxTokens });
      } catch (error) {
        return c.json(
          { ok: false, error: "MODEL_FAILED", message: String(error?.message || error || "模型调用失败") },
          502,
        );
      }

      if (!optimized) {
        return c.json({ ok: false, error: "EMPTY_RESULT", message: "模型没有返回内容，换个说法再试。" }, 502);
      }

      return c.json({
        ok: true,
        optimized,
        style,
        originalLength: text.length,
        optimizedLength: optimized.length,
      });
    });

    // 检查更新：只查 GitHub 上最新的已发布版本，安装仍走「设置 → 扩展」
    registerUpdateRoutes(app, ctx);
  });

  await sdk.tools.register({
    name: "optimize_prompt",
    description:
      "把一段口语化、零散的基础提示词重写成结构清晰、更符合大语言模型直觉的高质量提示词。" +
      "当用户在对话里说「帮我优化这段提示词」「把这句话改成能直接喂给模型的提示词」时调用。",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "要优化的基础提示词原文。" },
        style: {
          type: "string",
          enum: ["general", "code", "writing", "image", "analysis", "agent"],
          description: "优化侧重的场景，默认 general（通用）。",
        },
        extra: {
          type: "string",
          description: "用户额外提出的硬性要求，例如「面向零基础」「控制在 300 字内」。",
        },
      },
      required: ["text"],
    },
    execute: async ({ text, style, extra, context } = {}) => {
      const source = typeof text === "string" ? text.trim() : "";
      if (!source) throw new Error("optimize_prompt 需要提供 text。");
      if (source.length > MAX_INPUT_CHARS) {
        throw new Error(`提示词太长，上限 ${MAX_INPUT_CHARS} 字。`);
      }

      const optimized = await sampleOptimized(sdk, {
        text: source,
        style: normalizeStyle(style),
        extra: typeof extra === "string" ? extra : "",
        maxTokens: DEFAULT_MAX_TOKENS,
        callToken: context?.callToken,
      });
      if (!optimized) throw new Error("模型没有返回内容，请重试。");

      return {
        content: [{ type: "text", text: optimized }],
        details: {
          style: normalizeStyle(style),
          originalLength: source.length,
          optimizedLength: optimized.length,
        },
      };
    },
  });

  await sdk.logger.info("prompt-optimizer ready");
});
