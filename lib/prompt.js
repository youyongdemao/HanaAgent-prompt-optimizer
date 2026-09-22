// 提示词优化的核心逻辑：场景预设、系统提示词、迭代改写的消息装配。
// index.js（卡片用的流式端点）、Agent 工具（optimize_prompt）共用这一份，避免两处漂移。

// 场景清单的权威副本在前端（ui/assets/panel.js，带中文标签供界面渲染）；
// 这里只保留合法 id，用于后端归一化。
const STYLE_IDS = new Set(["general", "code", "writing", "image", "analysis", "agent"]);

export function normalizeStyle(style) {
  return typeof style === "string" && STYLE_IDS.has(style) ? style : "general";
}

const BASE_SYSTEM = `你是一位资深的提示词工程师，专门把用户随手写下的"基础提示词"重写成大语言模型更容易准确执行的高质量提示词。

重写原则（按重要性排序）：
1. 忠实原意。只优化表达与结构，不替换用户的目标，不添加用户没有要求的新任务。
2. 显式化隐含信息。把含糊的动词、缺失的背景、未说明的受众与场景补成明确、可执行的描述；拿不准的细节用中性表述，绝不编造具体事实或数据。
3. 结构化。按需要组织为：角色/背景 → 任务目标 → 具体要求 → 输出格式 → 约束与边界。段落之间用换行分隔，不要堆砌 markdown 标题符号。
4. 具体化。把"写得好一点""详细一些"这类空泛要求，换成可判断的标准（长度、语气、结构、必须包含或排除的内容）。
5. 保持用户使用的语言。用户用中文就用中文，用英文就用英文。
6. 篇幅克制。优化后通常比原文长，但每一句都要有信息量，不注水。

只输出优化后的提示词本身：不要任何前言、解释、总结、客套，也不要用代码围栏包起来。`;

const STYLE_HINTS = {
  general: "保持通用性，补齐任务、要求与期望的输出形态。",
  code: "侧重：技术栈与运行环境、输入输出与数据结构、边界与异常情况、性能或风格约束、是否需要测试与注释、应避免的做法。",
  writing: "侧重：体裁与用途、目标读者、篇幅与结构、语气与文风、人称或叙事视角、需要避免的套路与禁忌。",
  image: "侧重：主体与动作、场景与背景、构图与镜头、光线与色调、风格与媒介、画质与细节，并单独列出需要排除的元素。",
  analysis: "侧重：分析对象与数据来源、要回答的核心问题、关键指标的定义、方法与假设、结论应覆盖的维度以及对不确定性的说明。",
  agent: "侧重：清晰的目标与成功标准、可用的工具与限制、建议的步骤或策略、需要先澄清的前提、最终交付物的格式、以及何时停止。",
};

export function buildSystemPrompt(style, extra) {
  const hint = STYLE_HINTS[normalizeStyle(style)] || STYLE_HINTS.general;
  let prompt = `${BASE_SYSTEM}\n\n本次优化侧重：${hint}`;
  const extraText = typeof extra === "string" ? extra.trim() : "";
  if (extraText) {
    prompt += `\n\n用户补充的硬性要求（必须遵守，优先级高于上面的侧重）：\n${extraText}`;
  }
  return prompt;
}

export function buildUserMessage(text) {
  return `【基础提示词】\n${text}`;
}

/**
 * 迭代精修的 system prompt：在上一版结果上继续改，而不是从头重写。
 * 单独写一条，是因为模型拿到「原文 + 上一版 + 新要求」时很容易整篇重来，
 * 把用户没要求改的地方也一起改掉。
 */
export function buildReviseSystemPrompt(style, extra) {
  return (
    `${buildSystemPrompt(style, extra)}\n\n` +
    `【本次是修改请求】上面那条 assistant 消息是上一版结果，用户对它并不完全满意。\n` +
    `只修改用户这一次明确提到的部分，其余文字、结构与措辞保持原样。\n` +
    `不要整篇重写，也不要顺手改动没被要求的地方；改完直接输出完整的新版提示词。`
  );
}

/**
 * 校验前端回传的上一版 assistant 消息。
 * 它是从客户端来的，shapes 不符就当成没有（退回首轮模式），不把它塞进 messages。
 */
export function isRevisableAssistant(value) {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.role === "assistant" &&
    Array.isArray(value.content) &&
    value.content.length > 0 &&
    value.content.every(
      (item) =>
        !!item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        ((item.type === "text" && typeof item.text === "string") ||
          (item.type === "reasoning" && typeof item.reasoning === "string")),
    )
  );
}

/** 去掉模型偶尔套上的代码围栏与常见前缀。 */
export function stripWrapping(raw) {
  let out = String(raw ?? "").trim();
  const fence = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^(优化后的?提示词|optimized prompt)\s*[:：]\s*/i, "");
  return out.trim();
}

export function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const MAX_INPUT_CHARS = 8000;
export const DEFAULT_MAX_TOKENS = 1200;
