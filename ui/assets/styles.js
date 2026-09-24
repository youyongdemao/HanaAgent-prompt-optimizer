// assets/styles.js — 优化场景：内置六个 + 用户自己加的那份
// 卡片和设置页共用这一份，避免两边各自维护一份清单。
//
// 自定义场景由用户起名 + 写一句「取向说明」。说明是给模型看的，不是给界面看的：
// 场景最终要落成系统提示里的一句话，只有名字的场景点下去等于没点。

import { apiUrl, appHeaders } from "./app-api.js";

const STORAGE_KEY = "po-styles-v1";

/** 内置场景（只用于界面渲染与顺序；给模型看的说明在后端 lib/prompt.js 里） */
export const BUILTIN_STYLES = [
  { id: "general", label: "通用" },
  { id: "code", label: "编程" },
  { id: "writing", label: "写作" },
  { id: "image", label: "图像" },
  { id: "analysis", label: "分析" },
  { id: "agent", label: "Agent" },
];

const BUILTIN_IDS = new Set(BUILTIN_STYLES.map((s) => s.id));

/** 名字与说明的长度上限（与设置页输入框的 maxlength 对齐） */
export const STYLE_LABEL_MAX = 6;
export const STYLE_HINT_MAX = 120;

/** 洗净一份自定义场景：没有 id、没有说明的一律丢掉 */
export function sanitizeStyles(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const hint = typeof item.hint === "string" ? item.hint.trim() : "";
    if (!id || BUILTIN_IDS.has(id) || seen.has(id)) continue;
    if (!label || !hint) continue;
    seen.add(id);
    out.push({ id, label: label.slice(0, STYLE_LABEL_MAX), hint: hint.slice(0, STYLE_HINT_MAX) });
  }
  return out;
}

export function newStyleId() {
  return "u" + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36);
}

/** 内置在前、自定义在后；自定义那份已经在设置页里排好序，这里不再动 */
export function allStyles(custom) {
  return [...BUILTIN_STYLES, ...sanitizeStyles(custom)];
}

/** 读本机缓存（拿不到就当作没有自定义） */
export function loadCustomStyles() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? sanitizeStyles(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

function saveLocal(list) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeStyles(list)));
  } catch {
    /* 存不了也不影响这一次使用 */
  }
}

/** 从 App 那一侧取自定义场景；拿不到返回 null，调用方留着本地那份先跑 */
export async function pullStyles() {
  try {
    const res = await fetch(apiUrl("styles"), { headers: appHeaders() });
    if (!res.ok) {
      console.warn("[prompt-optimizer] 读取场景失败", res.status);
      return null;
    }
    const body = await res.json().catch(() => null);
    if (!body || body.items === null) return null;
    return sanitizeStyles(body.items);
  } catch (err) {
    console.warn("[prompt-optimizer] 读取场景异常", err);
    return null;
  }
}

/** 把自定义场景存到 App 那一侧（本地同时留一份缓存） */
export async function pushStyles(list) {
  const clean = sanitizeStyles(list);
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
