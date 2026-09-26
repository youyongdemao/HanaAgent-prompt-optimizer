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
  sanitizeStyles,
  builtinStyles,
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

/**
 * 把应用存储里那份场景配置发成一份完整清单。
 * 旧格式（只存了自定义那几条的数组）补上内置六个；空的一律当成没配过（null），
 * 让前端拿回默认六个——默认场景不该被一份空配置凭空盖掉。
 */
function normalizeStoredStyles(raw) {
  if (raw == null) return null;
  // 新格式：{ version: 2, items: [...] }
  if (!Array.isArray(raw) && Array.isArray(raw?.items)) {
    const clean = sanitizeStyles(raw.items);
    return clean.length ? clean : null;
  }
  // 旧格式：数组里只有自定义那几条
  if (Array.isArray(raw)) {
    const legacy = sanitizeStyles(raw);
    if (!legacy.length) return null;
    const base = builtinStyles();
    const seen = new Set(base.map((s) => s.id));
    for (const item of legacy) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      base.push(item);
    }
    return base;
  }
  return null;
}

/** 用户的场景清单存在应用存储里；读不到就当作空（后端按内置那套兜底） */
async function readStyles(sdk) {
  try {
    return normalizeStoredStyles(await sdk.storage.global.get("styles", null)) ?? [];
  } catch {
    return [];
  }
}

/** 一次模型改写：v2 只开 sdk.models.utility，不接受 provider/key/endpoint。 */
async function sampleOptimized(sdk, { text, style, extra, maxTokens, callToken, customStyles }) {
  const { text: optimized } = await sdk.models.utility({
    requestId: randomUUID(),
    ...(callToken ? { callToken } : { scope: "app" }),
    systemPrompt: buildSystemPrompt(style, extra, customStyles),
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

  // ── 输入框上方的常驻面板（app/input.panels）─────────────────────────────
  // 两条事实决定了入口怎么挂：
  //   1. ctx.userInteraction.show 只认「稳定 sessionId」（manifest 库里那条 sess_xxx），
  //      而 hooks 推来的 session.sessionId 是会话 jsonl 文件的内部 id，两套 id 对不上。
  //   2. 输入栏按钮点下去时，宿主在工具的 context 里给的是稳定 sessionId。
  // 所以：以输入栏按钮为入口拿稳定 id，顺手把 sessionPath -> 稳定 id 记下来，
  // 之后 hooks 再推同一个会话就能自动挂了。
  const PANEL_ID = "optimizer";
  const panelShown = new Set();
  const stableIdByPath = new Map();
  const seenPaths = new Set();

  /** 点击上下文里拿到稳定 id 后，把 path -> id 记下来，供 hooks 复用 */
  function rememberSession(context) {
    const sessionId = typeof context?.sessionId === "string" ? context.sessionId : "";
    const sessionPath = typeof context?.sessionPath === "string" ? context.sessionPath : "";
    if (sessionId && sessionPath) stableIdByPath.set(sessionPath, sessionId);
    return sessionId;
  }

  async function showPanel(sessionId) {
    if (!sessionId) return false;
    try {
      await sdk.userInteraction.show({
        sessionId,
        id: PANEL_ID,
        title: "提示词优化",
        contentFrame: { route: "/input-panel.html" },
        // 默认收成一条窄栏，点一下才展开，不占输入区的视觉重量
        presentation: { height: 380, collapsedHeight: 38, expanded: false },
      });
      return true;
    } catch (err) {
      await sdk.logger.warn(
        `提示词面板展示失败：${String(err?.code || err?.name || "error")} ${String(err?.message || err)}`,
      );
      return false;
    }
  }

  /** 每个会话只自动挂一次；用户手动关掉后不会下一轮又冒出来 */
  async function ensurePanel(session) {
    const sessionPath = typeof session?.sessionPath === "string" ? session.sessionPath : "";
    // hooks 给的 sessionId 用不了（见上面那段注释），只拿 path 去查已知映射
    const sessionId = sessionPath ? stableIdByPath.get(sessionPath) : null;
    if (!sessionId) {
      if (sessionPath && !seenPaths.has(sessionPath)) {
        seenPaths.add(sessionPath);
        await sdk.logger.info("提示词面板：这个会话还没点过入口按钮，跳过自动挂载");
      }
      return;
    }
    if (panelShown.has(sessionId)) return;
    if (await showPanel(sessionId)) {
      panelShown.add(sessionId);
      await sdk.logger.info(`提示词面板已挂到输入框上方：${sessionId}`);
    }
  }

  try {
    await sdk.hooks.on("agent/session-start", (event) => ensurePanel(event?.session));
    await sdk.hooks.on("agent/settled", (event) => ensurePanel(event?.session));
  } catch (err) {
    await sdk.logger.warn(`提示词面板钩子注册失败：${String(err?.message || err)}`);
  }

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
        const items = parseSuggestedFixes(raw);
        // 这条路由曾经因为客户端多写了一个斜杠而一直 404，没人看得到它到底跑没跑。
        // 留一行日志：出问题时能直接分清是路由没打到、还是模型没给出可解析的 JSON。
        await sdk.logger.info(`suggest-fixes: ${items ? items.length : 0} 条（输入 ${text.length} 字）`);
        return c.json({ ok: true, items });
      } catch (err) {
        await sdk.logger.info(`suggest-fixes 失败: ${String(err?.message || err)}`);
        return c.json({ ok: false, error: "MODEL_FAILED", message: String(err?.message || err) }, 502);
      }
    });

    // 配置（提示词清单 + 「根据内容主题推荐」开关）存在 App 这一侧：卡片和设置页跑在各自的
    // iframe 里，浏览器存储不互通，只有走 App 自己的存储，两边才看得到同一份。
    app.get("/fixes", async (c) => {
      try {
        const items = await sdk.storage.global.get("fixes", null);
        const suggest = await sdk.storage.global.get("suggest", false);
        return c.json({
          ok: true,
          items: Array.isArray(items) ? items : null,
          suggest: suggest === true,
        });
      } catch (err) {
        return c.json({ ok: false, error: "READ_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    app.post("/fixes", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      // 两块都可选：设置页那个「根据内容主题推荐」开关不带清单单独发过来（即改即生效，
      // 不等「保存修改」），清单那份照旧带 items；两块都不给才算坏请求。
      const items = Array.isArray(body?.items) ? body.items : null;
      const suggest = typeof body?.suggest === "boolean" ? body.suggest : null;
      if (!items && suggest === null) return c.json({ ok: false, error: "BAD_BODY" }, 400);
      try {
        // 给了哪块写哪块，没给的不动，免得把另一块洗掉
        if (items) await sdk.storage.global.set("fixes", items);
        if (suggest !== null) await sdk.storage.global.set("suggest", suggest);
        return c.json({ ok: true, count: items ? items.length : null });
      } catch (err) {
        return c.json({ ok: false, error: "WRITE_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    // 场景清单（名字 + 一句取向说明 + 开关）。和提示词清单同理：存在 App 这一侧，
    // 卡片与设置页跑在各自的 iframe 里，只有走这里两边才看得到同一份。
    app.get("/styles", async (c) => {
      try {
        const raw = await sdk.storage.global.get("styles", null);
        return c.json({ ok: true, items: normalizeStoredStyles(raw) });
      } catch (err) {
        return c.json({ ok: false, error: "READ_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    app.post("/styles", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      if (!Array.isArray(body?.items)) return c.json({ ok: false, error: "BAD_BODY" }, 400);
      try {
        const clean = sanitizeStyles(body.items);
        // 存成带版本号的形状：以后再读到裸数组，就知道该走迁移
        await sdk.storage.global.set("styles", { version: 2, items: clean });
        return c.json({ ok: true, count: clean.length });
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

      const customStyles = await readStyles(sdk);
      const style = normalizeStyle(body?.style, customStyles);
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

      const systemPrompt = revising
        ? buildReviseSystemPrompt(style, extra, customStyles)
        : buildSystemPrompt(style, extra, customStyles);
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

    // 面板页右上角的「关闭」：页面自己摘不掉面板，只能请应用后端走 dismiss。
    // 只允许关掉本应用展示过的那个会话的面板。
    app.post("/close-panel", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId || !panelShown.has(sessionId)) return c.json({ ok: false, error: "NOT_SHOWN" }, 400);
      try {
        await sdk.userInteraction.dismiss({ sessionId, id: PANEL_ID });
        panelShown.delete(sessionId);
        return c.json({ ok: true });
      } catch (err) {
        await sdk.logger.warn(`关闭提示词面板失败：${String(err?.message || err)}`);
        return c.json({ ok: false, error: "DISMISS_FAILED", message: String(err?.message || err) }, 500);
      }
    });

    // 面板页面的诊断回传：iframe 里的 console 看不到，只能借应用后端写进 Hana 日志
    app.post("/client-log", async (c) => {
      let body = {};
      try {
        body = await c.req.json();
      } catch {
        body = {};
      }
      const message = typeof body?.message === "string" ? body.message.slice(0, 500) : "";
      if (message) await sdk.logger.info(`[panel] ${message}`);
      return c.json({ ok: true });
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
          description:
            "优化侧重的场景：内置 general / code / writing / image / analysis / agent，" +
            "或用户在设置页自定义的场景 id。认不出的一律走 general。",
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

      const customStyles = await readStyles(sdk);
      const styleId = normalizeStyle(style, customStyles);
      const optimized = await sampleOptimized(sdk, {
        text: source,
        style: styleId,
        extra: typeof extra === "string" ? extra : "",
        maxTokens: DEFAULT_MAX_TOKENS,
        callToken: context?.callToken,
        customStyles,
      });
      if (!optimized) throw new Error("模型没有返回内容，请重试。");

      return {
        content: [{ type: "text", text: optimized }],
        details: {
          style: styleId,
          originalLength: source.length,
          optimizedLength: optimized.length,
        },
      };
    },
  });

  // 输入栏按钮的目标：把面板挂到当前会话。宿主在 ui-actions 触发的工具调用里
  // 给的是稳定 sessionId（这正是 show 唯一收的那种），所以不需要任何跨会话读取权限。
  await sdk.tools.register({
    name: "open_optimizer_panel",
    description: "在当前会话的输入框上方打开「提示词优化」面板。由输入栏那颗按钮调用，不面向对话。",
    parameters: { type: "object", properties: {} },
    execute: async ({ context } = {}) => {
      const sessionId = rememberSession(context);
      if (!sessionId) {
        const keys = context ? Object.keys(context).join(",") : "无";
        await sdk.logger.warn(`open_optimizer_panel：上下文里没有稳定 sessionId（字段：${keys}）`);
        throw new Error("拿不到稳定会话标识，面板无法挂载。");
      }
      const ok = await showPanel(sessionId);
      if (!ok) throw new Error("面板打开失败，请查看 Hana 日志。");
      panelShown.add(sessionId);
      await sdk.logger.info(`提示词面板已挂到输入框上方：${sessionId}`);
      return { content: [{ type: "text", text: "提示词优化面板已打开（输入框上方）。" }] };
    },
  });

  await sdk.logger.info("prompt-optimizer ready");
});
