// 提示词优化的核心逻辑：场景预设、系统提示词、迭代改写的消息装配。
// index.js（卡片用的流式端点）、Agent 工具（optimize_prompt）共用这一份，避免两处漂移。

// 场景清单的权威副本在前端（ui/assets/styles.js，带中文标签供界面渲染）。
// 用户能在设置页里改名、改取向说明、关掉、增删，整份清单随请求带进来（见 sanitizeStyles）。
// 下面的 STYLE_HINTS 只是兜底：清单里找不到（或没带）时按内置那几个说明走。
const STYLE_IDS = new Set(["general", "code", "writing", "image", "analysis", "agent"]);

/**
 * 洗净一份场景清单：id、名字、取向说明缺一不可，重复 id 只留第一条。
 * 内置那几个的 id 也在清单里（用户可以改名改说明、可以关掉），所以不再按 id 排除。
 */
export function sanitizeStyles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const hint = typeof item.hint === "string" ? item.hint.trim() : "";
    if (!id || seen.has(id) || !label || !hint) continue;
    seen.add(id);
    out.push({ id, label: label.slice(0, 12), hint: hint.slice(0, 200), on: item.on !== false });
  }
  return out;
}

/** 清单里某个场景的取向说明（干净的）；找不到返回空串。关着的也算——关只是不上卡片 */
function sceneHint(style, list) {
  const arr = Array.isArray(list) ? list : [];
  const hit = arr.find((s) => s && s.id === style);
  return typeof hit?.hint === "string" ? hit.hint.trim() : "";
}

/** 清单里有说明的 id 放行，内置 id 兜底放行；其余一律退回通用 */
export function normalizeStyle(style, list) {
  if (typeof style !== "string") return "general";
  if (STYLE_IDS.has(style)) return style;
  return sceneHint(style, list) ? style : "general";
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

/** 内置场景的界面名（前端 ui/assets/styles.js 里也有一份，这里只在迁移旧配置时用） */
const STYLE_LABELS = {
  general: "通用",
  code: "编程",
  writing: "写作",
  image: "图像",
  analysis: "分析",
  agent: "Agent",
};

/** 出厂默认的场景清单：旧格式配置（只存了自定义那几条）迁移时用来补齐内置六个 */
export function builtinStyles() {
  return Object.entries(STYLE_LABELS).map(([id, label]) => ({ id, label, hint: STYLE_HINTS[id], on: true }));
}

export function buildSystemPrompt(style, extra, list) {
  const resolved = normalizeStyle(style, list);
  // 清单里那份说明优先：用户在设置页改过某个场景的说明，就该按改过的走
  const hint = sceneHint(resolved, list) || STYLE_HINTS[resolved] || STYLE_HINTS.general;
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
export function buildReviseSystemPrompt(style, extra, list) {
  return (
    `${buildSystemPrompt(style, extra, list)}\n\n` +
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
