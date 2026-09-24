// prompt-optimizer v2 App — 服务端入口
//
// v1（插件形态）到 v2（应用形态）的对应关系：
//   routes/*.js + bus.request("model:sample-text")  →  sdk.routes.register + sdk.models.utility
//   tools/optimize_prompt.js                        →  sdk.tools.register
//   manifest.configuration                          →  应用自管 config.json + 自定义设置页
//   update-apply（下载 zip 覆盖插件目录）            →  删除：v2 应用目录宿主只读，更新走「设置 → 扩展」
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { defineApp } from "./sdk/app-contract/server-client.js";
import {
  buildSystemPrompt,
  buildReviseSystemPrompt,
  buildUserMessage,
  clampInt,
  normalizeStyle,
  isRevisableAssistant,
  stripWrapping,
  DEFAULT_MAX_TOKENS,
  MAX_INPUT_CHARS,
} from "./lib/prompt.js";
import { registerUpdateRoutes } from "./lib/update-check.js";

export const name = "prompt-optimizer";

const APP_DIR = dirname(fileURLToPath(import.meta.url));
// 仓库地址写死在这里：用户不需要知道、也不该改它
const DEFAULT_REPO = "youyongdemao/HanaAgent-prompt-optimizer";

function readVersion() {
  try {
    const version = JSON.parse(readFileSync(join(APP_DIR, "manifest.json"), "utf8")).version;
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
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

/** 问模型：这条提示词还能往哪些方向改。只输出 JSON 数组。 */
const SUGGEST_SYSTEM = [
  "你在帮用户想一条提示词还能往哪些方向改。",
  "读完用户给的提示词，给 4 到 6 个贴合它内容与用途的改进方向。",
  "方向要具体到这条例子上，别给放之四海而皆准的套话。",
  '只输出 JSON 数组，每项形如 {"label":"短标签","prompt":"一句具体做法"}，不要任何别的文字。',
].join("\n");

/** 从模型输出里抠出 JSON 数组（模型偶尔会裹一层解释或代码块） */
function parseSuggestedFixes(raw) {
  const text = typeof raw === "string" ? raw : "";
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const list = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const label = String(item.label ?? "").trim().slice(0, 12);
      const prompt = String(item.prompt ?? "").trim().slice(0, 120);
      if (!label || !prompt) continue;
      out.push({ id: "s" + out.length, label, prompt });
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("prompt-optimizer loaded");

  const ctx = {
    appDir: APP_DIR,
    logger: sdk.logger,
    network: { fetch: (input, init) => sdk.network.fetch(input, init) },
  };

  await sdk.routes.register((app) => {
    app.get("/health", (c) => c.json({ ok: true, app: "prompt-optimizer" }));

    // 设置页 / 卡片取一次：当前版本 + 仓库地址（纯本地，不联网）
    app.get("/meta", (c) =>
      c.json({
        ok: true,
        version: readVersion(),
        repo: DEFAULT_REPO,
        repoUrl: `https://github.com/${DEFAULT_REPO}`,
      }),
    );

    // 根据基础提示词的内容，给几条「这条适合往哪改」的方向。
    // 卡片在输入停下来后调一次；建议只是建议，拿不到就让卡片用默认清单。
    app.post("/suggest-fixes", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const text = typeof body?.text === "string" ? body.text.trim() : "";
      if (text.length < 8) return c.json({ ok: false, error: "TOO_SHORT" }, 400);
      try {
        const { text: raw } = await sdk.models.utility({
          requestId: randomUUID(),
          scope: "app",
          systemPrompt: SUGGEST_SYSTEM,
          messages: [{ role: "user", content: text.slice(0, 2000) }],
          temperature: 0.5,
          maxTokens: 400,
        });
        return c.json({ ok: true, items: parseSuggestedFixes(raw) });
      } catch (err) {
        return c.json({ ok: false, error: "MODEL_FAILED", message: String(err?.message || err) }, 502);
      }
    });

    // 清单存在 App 这一侧：卡片和设置页跑在各自的 iframe 里，浏览器存储不互通，
    // 只有走 App 自己的存储，两边才看得到同一份。
    app.get("/fixes", async (c) => {
      try {
        const items = await sdk.storage.global.get("fixes", null);
        return c.json({ ok: true, items: Array.isArray(items) ? items : null });
      } catch (err) {
        return c.json({ ok: false, error: "READ_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    app.put("/fixes", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const items = Array.isArray(body?.items) ? body.items : null;
      if (!items) return c.json({ ok: false, error: "BAD_BODY" }, 400);
      try {
        await sdk.storage.global.set("fixes", items);
        return c.json({ ok: true, count: items.length });
      } catch (err) {
        return c.json({ ok: false, error: "WRITE_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    // 流式改写：结果边生成边推给卡片。模型用宿主当前焦点模型（流式必须显式指定
    // provider/model，不能像 utility 那样省）。事件按 NDJSON 一行一个往下发。
    app.post("/optimize-stream", async (c) => {
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

      let provider = "";
      let modelId = "";
      try {
        const catalog = await sdk.models.listAvailable();
        const list = catalog?.models ?? [];
        const current = list.find((m) => m?.isCurrent) ?? list[0];
        if (!current?.provider || !current?.id) throw new Error("宿主里没有可用的模型");
        provider = current.provider;
        modelId = current.id;
      } catch (error) {
        return c.json(
          { ok: false, error: "NO_MODEL", message: `取不到可用模型：${String(error?.message || error)}` },
          503,
        );
      }

      // 迭代精修：带上一版结果继续改。形状不对就当首轮处理，不把来路不明的内容塞进 messages。
      const revise = typeof body?.revise === "string" ? body.revise.trim() : "";
      const prior = isRevisableAssistant(body?.priorAssistant) ? body.priorAssistant : null;
      const revising = Boolean(revise && prior);

      const systemPrompt = revising ? buildReviseSystemPrompt(style, extra) : buildSystemPrompt(style, extra);
      const messages = [{ role: "user", content: buildUserMessage(text) }];
      if (revising) {
        messages.push(prior);
        messages.push({ role: "user", content: revise });
      }

      const requestId = randomUUID();
      const encoder = new TextEncoder();
      const abort = new AbortController();
      // 卡片点「停止」或连接断开时，把模型流一起掐掉，不白烧 token
      c.req.raw?.signal?.addEventListener("abort", () => abort.abort(), { once: true });

      const stream = new ReadableStream({
        async start(controller) {
          const push = (payload) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
            } catch {
              /* 客户端已断开，后续事件丢弃 */
            }
          };
          let finished = false;
          let accumulated = "";
          // 先报一个 start，前端据此确认流已建立
          push({ requestId, type: "start" });
          try {
            for await (const event of sdk.models.streamEvents(
              {
                requestId,
                provider,
                model: modelId,
                messages,
                systemPrompt,
                temperature: 0.4,
                maxTokens,
              },
              { signal: abort.signal },
            )) {
              if (event.type === "text-delta") {
                accumulated += event.delta;
                push({ requestId, type: "text-delta", delta: event.delta });
              } else if (event.type === "done") {
                finished = true;
                push({
                  requestId,
                  type: "done",
                  stopReason: event.stopReason,
                  // 完整可回放的 assistant 消息：卡片要把它原样带回做迭代精修
                  assistant: event.assistant,
                  // 清洗过的成品，省得前端自己猜围栏剥完没有
                  optimized: stripWrapping(accumulated),
                  style,
                  provider,
                  model: modelId,
                });
              }
            }
            if (!finished) {
              push({ requestId, type: "error", code: "EMPTY_RESULT", message: "模型没有返回内容，换个说法再试。" });
            }
          } catch (error) {
            push({ requestId, type: "error", code: "STREAM_FAILED", message: String(error?.message || error) });
          } finally {
            try {
              controller.close();
            } catch {
              /* 已关闭 */
            }
          }
        },
        cancel() {
          abort.abort();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
        },
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
