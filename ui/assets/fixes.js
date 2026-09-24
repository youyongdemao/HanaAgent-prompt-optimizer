// assets/fixes.js — 「继续改」的方向：默认清单、候选池、本机读写
// 卡片和设置页共用这一份，避免两边各自维护一份配置。

const STORAGE_KEY = "po-fixes-v1";

/** 卡片上默认显示这六个 */
export const DEFAULT_FIXES = [
  { id: "concise", label: "更简洁", prompt: "整体再简洁一些，砍掉不必要的解释" },
  { id: "specific", label: "更具体", prompt: "把要求写得更具体、更可判断，减少模糊的形容" },
  { id: "plainer", label: "更平实", prompt: "语气再平实一些，去掉官方套话和空泛的表述" },
  { id: "antipattern", label: "加反例", prompt: "说明什么样的回答是不合格的、需要避免的" },
  { id: "steps", label: "分步骤", prompt: "把任务拆成有序步骤，每一步写清产出什么" },
  { id: "boundary", label: "加约束", prompt: "明确边界与禁止项：什么不要做、遇到说不清的情况怎么办" },
];

/** 设置页里可以随时挑回来的备选（默认那六个也在其中，靠 id 去重） */
export const PRESET_FIXES = [
  ...DEFAULT_FIXES,
  { id: "example", label: "举例", prompt: "补一个具体的输入与输出示例，把期望的样子钉住" },
  { id: "context", label: "补背景", prompt: "补充任务背景与使用场景，让模型知道这个提示词用在哪儿" },
  { id: "beginner", label: "面向新手", prompt: "改成面向完全不了解这个领域的人，专业术语都要顺带解释" },
  { id: "expert", label: "面向专家", prompt: "改成面向有专业背景的人，省略基础解释，直接讲关键" },
  { id: "output", label: "明确输出", prompt: "明确输出的格式、长度与结构" },
  { id: "role", label: "强化角色", prompt: "给模型一个更明确、更贴合任务的角色设定" },
  { id: "english", label: "转成英文", prompt: "把提示词改成英文，结构与要求保持不变" },
];

const DEFAULT_IDS = new Set(DEFAULT_FIXES.map((item) => item.id));

function sanitize(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const prompt = typeof item.prompt === "string" ? item.prompt.trim() : "";
    if (!label && !prompt) continue;
    out.push({
      id: typeof item.id === "string" && item.id ? item.id : "f" + out.length,
      label: (label || prompt).slice(0, 12),
      prompt: prompt || label,
      // 没记过勾选状态的看出厂默认：默认那几条勾上，其余备选默认不勾
      on: typeof item.on === "boolean" ? item.on : DEFAULT_IDS.has(item.id),
    });
  }
  return out.length ? out : null;
}

/** 读本机配置；没配过或读不动就用默认六个（过一遍 sanitize，把勾选状态补齐） */
export function loadFixes() {
  const fallback = () => sanitize(DEFAULT_FIXES) ?? DEFAULT_FIXES.map((item) => ({ ...item }));
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback();
    return sanitize(JSON.parse(raw)) ?? fallback();
  } catch {
    return fallback();
  }
}

export function saveFixes(list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(list) ?? []));
  } catch {
    /* 存不了也不影响这一次使用 */
  }
}

/** 卡片只用在设置页勾上的那些 */
export function loadActiveFixes() {
  return loadFixes().filter((item) => item.on !== false);
}

/** 某个预设现在是否已经在清单里 */
export function hasFix(list, id) {
  return list.some((item) => item.id === id);
}

/** 造一个新条目的 id（不用时间戳以外的东西，避免和预设撞） */
export function newFixId() {
  return "c" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}
