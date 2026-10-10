// 补充要求的本机最近使用记录。仅在一次生成成功后写入，不保存输入中的草稿。
const KEY = "po-extra-history-v1";
export const MAX_EXTRA_HISTORY = 5;
const MAX_LENGTH = 2000;

export function normalizeExtraHistory(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || text.length > MAX_LENGTH || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length === MAX_EXTRA_HISTORY) break;
  }
  return result;
}

export function loadExtraHistory() {
  try {
    return normalizeExtraHistory(JSON.parse(window.localStorage.getItem(KEY) || "[]"));
  } catch {
    return [];
  }
}

export function rememberExtra(text, current) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value || value.length > MAX_LENGTH) return normalizeExtraHistory(current);
  const next = normalizeExtraHistory([value, ...(Array.isArray(current) ? current : [])]);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // 无法持久化时，本次卡片内的快捷选择仍然可用。
  }
  return next;
}
