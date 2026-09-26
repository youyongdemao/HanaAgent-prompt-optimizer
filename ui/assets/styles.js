// assets/styles.js — 优化场景清单
// 与「快捷候选提示词」同构：一份清单，每条带一个开关，开关决定它上不上卡片的场景胶囊。
// 默认六个内置场景，用户可以改名、改取向说明、增删；删光了还能「恢复默认」。
//
// 取向说明是给模型看的那一句：场景最终要落成系统提示里的一句话，
// 只有名字的场景点下去等于没点，所以名字和说明都不允许空着。

import { apiUrl, appHeaders } from "./app-api.js";

/** 当前格式（带 on 开关的完整清单） */
const STORAGE_KEY = "po-styles-v2";
/** 上一版只存「自定义那几条」的格式，读到就并到默认六个后面，别让用户配置丢 */
const LEGACY_KEY = "po-styles-v1";

/** 名字与说明的长度上限（与设置页输入框的 maxlength 对齐） */
export const STYLE_LABEL_MAX = 6;
export const STYLE_HINT_MAX = 120;

/** 出场默认：六个内置场景，全部开着 */
export const DEFAULT_STYLES = [
  { id: "general", label: "通用", hint: "保持通用性，补齐任务、要求与期望的输出形态。" },
  {
    id: "code",
    label: "编程",
    hint: "侧重：技术栈与运行环境、输入输出与数据结构、边界与异常情况、性能或风格约束、是否需要测试与注释、应避免的做法。",
  },
  {
    id: "writing",
    label: "写作",
    hint: "侧重：体裁与用途、目标读者、篇幅与结构、语气与文风、人称或叙事视角、需要避免的套路与禁忌。",
  },
  {
    id: "image",
    label: "图像",
    hint: "侧重：主体与动作、场景与背景、构图与镜头、光线与色调、风格与媒介、画质与细节，并单独列出需要排除的元素。",
  },
  {
    id: "analysis",
    label: "分析",
    hint: "侧重：分析对象与数据来源、要回答的核心问题、关键指标的定义、方法与假设、结论应覆盖的维度以及对不确定性的说明。",
  },
  {
    id: "agent",
    label: "Agent",
    hint: "侧重：清晰的目标与成功标准、可用的工具与限制、建议的步骤或策略、需要先澄清的前提、最终交付物的格式、以及何时停止。",
  },
];

/** 「通用」是兜底场景，卡片上必须有，所以不给删除入口 */
export const FALLBACK_ID = "general";

export function defaultStyles() {
  return DEFAULT_STYLES.map((item) => ({ ...item, on: true }));
}

/** 洗净一份清单：id、名字、说明缺一不可，重复 id 只留第一条；形状不对返回 null */
export function sanitizeStyles(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const hint = typeof item.hint === "string" ? item.hint.trim() : "";
    if (!id || !label || !hint || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: label.slice(0, STYLE_LABEL_MAX),
      hint: hint.slice(0, STYLE_HINT_MAX),
      on: item.on !== false,
    });
  }
  return out;
}

export function newStyleId() {
  return "u" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/** 卡片上摆哪些：清单里开着的那几条，按清单顺序 */
export function allStyles(list) {
  const clean = sanitizeStyles(list) ?? defaultStyles();
  return clean.filter((item) => item.on !== false).map(({ id, label, hint }) => ({ id, label, hint }));
}

/** 旧的「只有自定义几条」那份配置：并到默认六个后面，缺的字段补齐 */
function migrateLegacy(rawList) {
  const legacy = sanitizeStyles(rawList) ?? [];
  const base = defaultStyles();
  const seen = new Set(base.map((item) => item.id));
  for (const item of legacy) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    base.push(item);
  }
  return base;
}

/** 读本机缓存；没配过或读不动就用默认六个 */
export function loadStyles() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const clean = sanitizeStyles(JSON.parse(raw));
      // 缓存里是空清单也当没配过：默认六个不该凭空消失
      if (clean && clean.length) return clean;
    }
    const old = window.localStorage.getItem(LEGACY_KEY);
    if (old) return migrateLegacy(JSON.parse(old));
  } catch {
    /* 读不动就当没配过 */
  }
  return defaultStyles();
}

function saveLocal(list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeStyles(list) ?? []));
  } catch {
    /* 存不了也不影响这一次使用 */
  }
}

/** 从 App 那一侧取场景清单；拿不到返回 null，调用方留着本地那份先跑 */
export async function pullStyles() {
  try {
    const res = await fetch(apiUrl("styles"), { headers: appHeaders() });
    if (!res.ok) {
      console.warn("[prompt-optimizer] 读取场景失败", res.status);
      return null;
    }
    const body = await res.json().catch(() => null);
    if (!body || body.items === null) return null;
    const list = sanitizeStyles(body.items);
    // App 那一侧是空清单（旧格式存过空的自定义场景）也当没配过，保留本地这份
    return list && list.length ? list : null;
  } catch (err) {
    console.warn("[prompt-optimizer] 读取场景异常", err);
    return null;
  }
}

/** 把场景清单存到 App 那一侧（本地同时留一份缓存） */
export async function pushStyles(list) {
  const clean = sanitizeStyles(list) ?? [];
  saveLocal(clean);
  try {
    const res = await fetch(apiUrl("styles"), {
      method: "POST",
      headers: appHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ items: clean }),
    });
    if (!res.ok) console.warn("[prompt-optimizer] 保存场景失败", res.status, await res.text().catch(() => ""));
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.warn("[prompt-optimizer] 保存场景异常", err);
    return { ok: false, status: 0 };
  }
}
