// assets/input-panel.js — 输入框上方面板的「外壳」逻辑
//
// 只干三件事：收起 / 展开、关闭、以及把诊断写进 Hana 日志。
// 卡片本体（基础提示词、场景、结果、版本链条、复制）全部由 panel.js 提供，
// 和 card.html 用的是同一份代码，所以面板与卡片的行为逐条一致。
import { hana } from "./sdk.js";
import { apiUrl, appHeaders } from "./app-api.js";

const COLLAPSED_H = 38;
const EXPANDED_H = 380;

const root = document.getElementById("poip");

/** iframe 里的 console 看不到，诊断信息借应用后端写进 Hana 日志 */
function clientLog(message) {
  try {
    void fetch(apiUrl("client-log"), {
      method: "POST",
      headers: appHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ message: String(message).slice(0, 400) }),
    }).catch(() => {});
  } catch {
    /* 记不上就算了 */
  }
}

let bound = null; // 宿主下发的面板上下文，握手前为 null
let isExpanded = false;

function applyExpanded(expanded) {
  isExpanded = Boolean(expanded);
  root.dataset.expanded = isExpanded ? "true" : "false";
}

async function setExpanded(expanded) {
  applyExpanded(expanded); // 先动，等宿主回包前界面不卡
  clientLog(`setExpanded->${expanded} bound=${bound ? "yes" : "no"}`);
  if (!bound) {
    clientLog("setPresentation 未发送：宿主还没下发面板上下文");
    return;
  }
  try {
    const res = await hana.inputPanel.setPresentation({
      expanded,
      height: EXPANDED_H,
      collapsedHeight: COLLAPSED_H,
    });
    clientLog(`setPresentation ok: ${JSON.stringify(res?.presentation || res)}`);
  } catch (err) {
    clientLog(`setPresentation FAILED: ${String(err?.message || err)}`);
  }
}

/** 关闭面板：页面自己摘不掉面板，转交应用后端走 ctx.userInteraction.dismiss */
async function closePanel() {
  const sessionId = typeof bound?.sessionId === "string" ? bound.sessionId : "";
  clientLog(`closePanel sessionId=${sessionId ? "yes" : "no"}`);
  if (!sessionId) return;
  try {
    const res = await fetch(apiUrl("close-panel"), {
      method: "POST",
      headers: appHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ sessionId }),
    });
    clientLog(`closePanel -> HTTP ${res.status}`);
  } catch (err) {
    clientLog(`closePanel FAILED: ${String(err?.message || err)}`);
  }
}

// 头部整条就是开关：收起时点它展开，展开时点它收起；
// 右上角两颗图标按钮做同一件事的更明确版本。
document.getElementById("bar").addEventListener("click", () => setExpanded(!isExpanded));
document.getElementById("toggle").addEventListener("click", (event) => {
  event.stopPropagation();
  setExpanded(!isExpanded);
});
document.getElementById("close").addEventListener("click", (event) => {
  event.stopPropagation();
  void closePanel();
});

// 宿主是 presentation 的唯一事实源：它说收起就收起
hana.inputPanel.onContextChanged((context) => {
  bound = context;
  clientLog(
    context
      ? `context: panel=${context.panelId} expanded=${context.presentation?.expanded} h=${context.presentation?.height} ch=${context.presentation?.collapsedHeight}`
      : "context: null",
  );
  applyExpanded(Boolean(context?.presentation?.expanded));
});

applyExpanded(false);

// 诊断：把这块面板实际用的主题色报一次，深浅不对时能直接看出是哪一档
window.setTimeout(() => {
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim() || "(未定义)";
    clientLog(
      `theme: hanaTheme=${document.body.dataset.hanaTheme || "(none)"} ` +
        `--bg=${v("--bg")} --bg-card=${v("--bg-card")} --bg-glass=${v("--bg-glass")} ` +
        `panelBg=${getComputedStyle(root).backgroundColor}`,
    );
  } catch {
    /* 读不到就算了 */
  }
}, 900);

// ---------------------------------------------------------------- 面板自己的自动下滚（缓入缓出）
// 卡片里的 scrollToResult() 滚的是 document，而在面板里 document 不滚（.poip-body 才是滚动容器），
// 所以它那边滑不动。这层补上：点生成类按钮后把视线带到结果区，生成期间持续跟着走。
//
// 不用 scrollTo({behavior:"smooth"})：流式生成时目标每帧都在往下走，
// 原生平滑会被一次次打断，看着卡顿。这里逐帧逼近：起步轻、中段稳、贴近目标自然收住。
const bodyEl = document.getElementById("body");
let followRaf = 0;
let followFrames = 0;
let followQuiet = 0;
let followPhase = "idle"; // idle → jump（把结果区带进画面）→ follow（跟着长）
let followBlocked = false; // 用户自己划过就把跟随关掉，直到下一次点生成

function stopFollow() {
  if (followRaf) {
    cancelAnimationFrame(followRaf);
    followRaf = 0;
  }
  followPhase = "idle";
  followFrames = 0;
  followQuiet = 0;
}

/** 用户主动滚动：立刻交还控制权，并且这一轮不再自动接管 */
function releaseToUser() {
  if (!followRaf) return;
  followBlocked = true;
  stopFollow();
}

bodyEl.addEventListener("wheel", releaseToUser, { passive: true });
bodyEl.addEventListener("touchmove", releaseToUser, { passive: true });
bodyEl.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
    releaseToUser();
  }
});

function followTick() {
  followRaf = requestAnimationFrame(followTick);
  followFrames += 1;
  if (followFrames > 12600) return stopFollow(); // 约 3.5 分钟兜底

  const wrap = document.getElementById("po-result-wrap");
  const streaming = (document.getElementById("po-run-tx")?.textContent || "").trim() === "停止";
  if (!wrap || wrap.hidden) {
    if (!streaming && ++followQuiet > 600) stopFollow();
    return;
  }

  const target = bodyEl.scrollHeight - bodyEl.clientHeight;
  const delta = target - bodyEl.scrollTop;
  // 只在跳转阶段（把结果区带进画面）或本来就贴着底部时跟；
  // 跳转阶段一旦接近尾部就转成 follow，不再主动拉距离。
  if (followPhase === "jump") {
    if (Math.abs(delta) < 4) {
      bodyEl.scrollTop = target;
      followPhase = "follow";
      return;
    }
  } else if (Math.abs(delta) > 120) {
    // 不在底部（不管是因为还在长，还是用户翻上去了）：等它自己回到范围内
    if (!streaming && ++followQuiet > 600) stopFollow();
    return;
  }

  followQuiet = 0;
  if (Math.abs(delta) < 1) return;

  // 缓入：前 ~0.5 秒推进比例从 2% 提到 7.5%；越接近目标步子越小，自然缓出
  const ramp = 0.02 + 0.055 * Math.min(1, followFrames / 30);
  bodyEl.scrollTop += delta * ramp;
}

function startFollow(force) {
  if (followBlocked && force !== true) return;
  if (force === true) followBlocked = false;
  followFrames = 0;
  followQuiet = 0;
  followPhase = "jump";
  if (followRaf) return;
  followRaf = requestAnimationFrame(followTick);
}

// 触发点有两处：
//   1. 点生成类按钮（用捕获阶段，免得卡片那边 stopPropagation 把它挡住）；
//   2. 结果区从隐藏变可见（不管走的哪条路都能兜到）。
document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const trigger = target.closest(
      "#po-run, #po-revise-left, #po-revise-right, #po-revise-picked, #po-revise-quick button",
    );
    if (!trigger) return;
    // 等卡片把新内容铺上去再开始跟；用户点生成 = 重新接管
    window.setTimeout(() => startFollow(true), 120);
  },
  true,
);

const rootEl = document.getElementById("root");
if (rootEl && typeof MutationObserver === "function") {
  new MutationObserver(() => {
    const wrap = document.getElementById("po-result-wrap");
    if (wrap && !wrap.hidden) startFollow();
  }).observe(rootEl, { subtree: true, attributes: true, attributeFilter: ["hidden"] });
}
