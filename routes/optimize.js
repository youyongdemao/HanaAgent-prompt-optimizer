import {
  buildSystemPrompt,
  buildUserMessage,
  clampInt,
  extractText,
  normalizeStyle,
  DEFAULT_MAX_TOKENS,
  MAX_INPUT_CHARS,
} from "../lib/prompt.js";

/**
 * 解析一次请求可用的 EventBus。
 * 优先用官方的 per-request context（它带着本次请求的能力授权），
 * 拿不到时退回插件级 ctx.bus。
 */
async function resolveBus(c, pluginCtx) {
  try {
    const mod = await import("@hana/plugin-runtime");
    if (mod && typeof mod.getPluginRequestContext === "function") {
      const req = mod.getPluginRequestContext(c);
      if (req && req.bus && typeof req.bus.request === "function") return req.bus;
    }
  } catch {
    // 运行时未提供该 helper 时静默退化，不算错误。
  }
  const fallback = pluginCtx && pluginCtx.bus;
  return fallback && typeof fallback.request === "function" ? fallback : null;
}

export default function registerOptimizeRoutes(app, ctx) {
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

    const bus = await resolveBus(c, ctx);
    if (!bus) {
      return c.json({ ok: false, error: "NO_BUS", message: "当前环境无法调用模型。" }, 500);
    }

    let result;
    try {
      result = await bus.request("model:sample-text", {
        systemPrompt: buildSystemPrompt(style, extra),
        messages: [{ role: "user", content: buildUserMessage(text) }],
        temperature: 0.4,
        maxTokens,
        operation: "prompt-optimizer",
      });
    } catch (err) {
      return c.json(
        { ok: false, error: "MODEL_FAILED", message: String(err?.message || err || "模型调用失败") },
        502,
      );
    }

    const optimized = extractText(result);
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
}
