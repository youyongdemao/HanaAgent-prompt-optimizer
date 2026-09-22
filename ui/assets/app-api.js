// assets/app-api.js — 应用内路由的统一入口
// v2 App 的接口都在 /api/apps/<appId>/routes/<path>，凭证走 appSurfaceSession 头。
export const APP_ID = "prompt-optimizer";

export function apiUrl(path) {
  return `${location.origin}/api/apps/${APP_ID}/routes/${path}`;
}

/**
 * 调用应用自己的后端。
 * 返回解析好的 JSON；非 2xx 抛错，并尽量把服务端给的中文 message 带出来。
 */
export async function apiFetch(path, init = {}, timeoutMs = 8000) {
  const ss = new URLSearchParams(location.search).get("appSurfaceSession") || "";
  const headers = new Headers(init.headers || {});
  if (ss) headers.set("X-Hana-App-Surface-Session", ss);
  const res = await fetch(apiUrl(path), {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const isJson = (res.headers.get("content-type") || "").includes("json");
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    const error = new Error(body?.message || `HTTP ${res.status}`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}
