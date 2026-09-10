import {
  buildSystemPrompt,
  buildUserMessage,
  clampInt,
  extractText,
  normalizeStyle,
  DEFAULT_MAX_TOKENS,
  MAX_INPUT_CHARS,
} from "../lib/prompt.js";

export const name = "optimize_prompt";

export const description =
  "把一段口语化、零散的基础提示词重写成结构清晰、更符合大语言模型直觉的高质量提示词。" +
  "当用户在对话里说「帮我优化这段提示词」「把这句话改成能直接喂给模型的提示词」时调用。";

export const parameters = {
  type: "object",
  properties: {
    text: {
      type: "string",
      description: "要优化的基础提示词原文。",
    },
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
};

export const sessionPermission = {
  kind: "read",
  readOnly: true,
  description:
    "调用一次宿主已配置的模型，把输入文本改写为结构化提示词；不读写任何用户文件、不改变会话或外部系统状态。",
};

export async function execute(input = {}, ctx = {}) {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (!text) throw new Error("optimize_prompt 需要提供 text。");
  if (text.length > MAX_INPUT_CHARS) {
    throw new Error(`提示词太长，上限 ${MAX_INPUT_CHARS} 字。`);
  }

  const bus = ctx?.bus;
  if (!bus || typeof bus.request !== "function") {
    throw new Error("当前环境无法调用模型（缺少 EventBus）。");
  }

  const style = normalizeStyle(input.style);
  const maxTokens = clampInt(input.maxTokens, 256, 4096, DEFAULT_MAX_TOKENS);

  const result = await bus.request("model:sample-text", {
    systemPrompt: buildSystemPrompt(style, input.extra),
    messages: [{ role: "user", content: buildUserMessage(text) }],
    temperature: 0.4,
    maxTokens,
    operation: "prompt-optimizer",
  });

  const optimized = extractText(result);
  if (!optimized) throw new Error("模型没有返回内容，请重试。");

  return {
    content: [{ type: "text", text: optimized }],
    details: {
      style,
      originalLength: text.length,
      optimizedLength: optimized.length,
    },
  };
}
