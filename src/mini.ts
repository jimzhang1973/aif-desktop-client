// 迷你速览条（mini-bar 窗口，见 commands.rs toggle_mini_bar）：
// 屏幕右缘常置小窗，显示未读消息 / 待办数量，点击交主窗处理。
// 数据来源：未读数 = 共享 localStorage（主窗 aif_unread_msg_ids，同源窗口实时可见，
// 另监听 new-message / todos-updated 事件兜底）；待办数 = invoke get_todos 过滤未办结。
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./mini.css";

interface TodoRow {
  id: string;
  title: string;
  url: string;
  done: boolean;
  /** 该事项挂着的待办条目数（角标按其合计，与主窗/B/S 口径一致） */
  count: number;
}

interface MessageRow {
  id: string;
  title: string;
  body: string;
  url: string;
  received_at: number;
  muted?: boolean;
}

interface OpsApp {
  id: string;
  name: string;
  status: "normal" | "alert";
  event: string;
  url: string;
}

interface OpsAppGroup {
  id: string;
  name: string;
  apps: OpsApp[];
}

/** 授权智能体（B/S「AI 问答」入口数据源，与主窗 get_ai_agents 同命令） */
interface AiAgent {
  id: string;
  name: string;
  description: string;
  icon: string;
}

const msgN = document.getElementById("m-msg-n")!;
const todoN = document.getElementById("m-todo-n")!;
const quickN = document.getElementById("m-quick-n")!;
const opsBtn = document.getElementById("m-ops")!;
const opsN = document.getElementById("m-ops-n")!;
const card = document.getElementById("card")!;
const cTodos = document.getElementById("c-todos")!;
const cOpsSec = document.getElementById("c-ops-sec")!;
const cOps = document.getElementById("c-ops")!;
const cOpsN = document.getElementById("c-ops-n")!;
const cMsgs = document.getElementById("c-msgs")!;
const cTodoN = document.getElementById("c-todo-n")!;
const cMsgN = document.getElementById("c-msg-n")!;
const assistBtn = document.getElementById("m-assist")!;
const sepOps = document.getElementById("m-sep-ops")!;
const cAgents = document.getElementById("c-agents")!;
const cAgentsN = document.getElementById("c-agents-n")!;

// 产品形态：AIF（运维）才显示「应用」按钮与告警节；一表通 DCP 隐藏（null = 未拉取）
let opsProduct: boolean | null = null;

/** B/S 站点根（detectOpsProduct 时顺带缓存），用于拼智能体会话 URL */
let baseUrl = "";
/** 智能体列表缓存（5 分钟 TTL，避免每次悬停都打接口） */
let agentCache: { at: number; agents: AiAgent[] } | null = null;
const AGENT_TTL = 5 * 60_000;

/** 智能体会话页（与主窗 agentChatUrl 同规则，实测 aiAgentId 参数名）：
 *  DCP=/DCP/ai/index.htm?aiAgentId=，AIF=/AIF/ai/chat/index.htm?aiAgentId= */
function agentChatUrl(id: string): string {
  const path = opsProduct ? "/AIF/ai/chat/index.htm" : "/DCP/ai/index.htm";
  return `${baseUrl}${path}?aiAgentId=${encodeURIComponent(id)}`;
}

async function fetchAgents(): Promise<AiAgent[]> {
  if (agentCache && Date.now() - agentCache.at < AGENT_TTL) return agentCache.agents;
  try {
    const agents = await invoke<AiAgent[]>("get_ai_agents");
    agentCache = { at: Date.now(), agents };
    return agents;
  } catch {
    return []; // 未登录/接口失败：静默为空，不打扰
  }
}

function unreadIds(): string[] {
  try {
    const ids = JSON.parse(
      localStorage.getItem("aif_unread_msg_ids") || "[]",
    ) as string[];
    return Array.isArray(ids) ? ids : [];
  } catch {
    return [];
  }
}

function unreadCount(): number {
  return unreadIds().length;
}

function paint(msg: number, todo: number) {
  msgN.textContent = String(msg);
  todoN.textContent = String(todo);
  // 有事亮起、无事置灰，一眼可辨
  msgN.classList.toggle("hot", msg > 0);
  todoN.classList.toggle("hot", todo > 0);
}

async function refresh() {
  // 必须先完成产品检测：alertApps 依赖 opsProduct 判定
  await detectOpsProduct();
  paint(unreadCount(), await todoCount());
  // 快捷功能数量：主窗加载列表后写入共享 localStorage（aif_quick_count）
  const qc = Number(localStorage.getItem("aif_quick_count") || "0");
  quickN.textContent = String(Number.isFinite(qc) ? qc : 0);
  quickN.classList.toggle("hot", qc > 0);
  // 应用告警数（仅 AIF）：有告警亮红，无告警置灰
  const alarms = await alertApps();
  opsN.textContent = String(alarms.length);
  opsN.classList.toggle("hot", alarms.length > 0);
}

async function todoCount(): Promise<number> {
  try {
    const rows = await invoke<TodoRow[]>("get_todos");
    // 与主窗角标同口径：各事项待办条目数合计（count 兜底 1 兼容旧快照）
    return rows.filter((t) => !t.done).reduce((s, t) => s + (t.count || 1), 0);
  } catch {
    return 0;
  }
}

/** 产品形态切换（主窗「切换入口」成功后写 aif_ops_product）：
 *  立即隐藏「应用」按钮/告警节，重新检测后按需恢复；卡片若开着则重渲染 */
function onProductSwitched(): void {
  opsProduct = null;
  opsBtn.hidden = true;
  sepOps.hidden = true; // 应用按钮隐藏时连前导分隔线一起藏，避免双线相邻
  cOpsSec.hidden = true;
  opsN.textContent = "";
  cOps.innerHTML = "";
  void refresh().then(() => {
    if (opsProduct && card.classList.contains("show")) void renderCard();
  });
}

/** 运维产品识别（仅拉取一次）：AIF 显示应用按钮/告警节，DCP 隐藏 */
async function detectOpsProduct(): Promise<void> {
  if (opsProduct !== null) return;
  try {
    const s = await invoke<{ ops_product?: boolean; base_url?: string }>("get_settings");
    opsProduct = !!s.ops_product;
    if (s.base_url) baseUrl = s.base_url.replace(/\/+$/, "");
  } catch {
    opsProduct = false;
  }
  opsBtn.hidden = !opsProduct;
  sepOps.hidden = !opsProduct;
  cOpsSec.hidden = !opsProduct;
}

/** 告警应用列表（status==="alert" 的应用，含告警事件文本） */
async function alertApps(): Promise<OpsApp[]> {
  if (!opsProduct) return [];
  try {
    const groups = await invoke<OpsAppGroup[]>("get_ops_apps");
    return groups.flatMap((g) => g.apps.filter((a) => a.status === "alert"));
  } catch {
    return []; // 未登录/接口失败：不打扰，静默为空
  }
}

// ==================== 悬停预览卡 ====================

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const now = Date.now();
  if (now - ts * 1000 < 86_400_000)
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 卡片行前置图标（16px 内联 SVG）：待办=清单、消息=信封（未读变红） */
const ICON_TODO = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><path d="m4 5.5 1 1 2-2"/><path d="m4 11.5 1 1 2-2"/><path d="m4 17.5 1 1 2-2"/></svg>`;
const ICON_MSG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 15.5z"/><path d="m4.5 7 7.5 5 7.5-5"/></svg>`;
/** 告警应用行前置图标：警示三角 */
const ICON_ALERT = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 2.8 19.5h18.4z"/><path d="M12 10v4.2"/><path d="M12 17h.01"/></svg>`;

/** 渲染预览卡内容：待办未办结 Top3 + 本地库最新 3 条消息（未读图标变红） */
async function renderCard(): Promise<void> {
  const unread = new Set(unreadIds());
  // 待办
  try {
    const rows = (await invoke<TodoRow[]>("get_todos")).filter((t) => !t.done);
    const undone = rows.slice(0, 5);
    const total = rows.reduce((s, t) => s + (t.count || 1), 0);
    cTodoN.textContent = String(total);
    cTodoN.classList.toggle("hot", total > 0);
    cTodos.innerHTML = undone.length
      ? undone
          .map(
            (t) =>
              `<div class="c-row" data-url="${esc(t.url)}"><span class="r-ico i-todo">${ICON_TODO}</span><div class="r-title">${esc(trim(t.title, 22))}</div>${(t.count || 1) > 1 ? `<span class="r-count">×${t.count}</span>` : ""}</div>`,
          )
          .join("")
      : `<div class="c-empty">暂无待办 🎉</div>`;
  } catch {
    cTodos.innerHTML = `<div class="c-empty">待办加载失败</div>`;
  }
  // 告警应用（仅 AIF）：有告警事件的应用列表，点击直达应用页
  if (opsProduct) {
    try {
      const alarms = await alertApps();
      cOpsN.textContent = String(alarms.length);
      cOps.innerHTML = alarms.length
        ? alarms
            .map(
              (a) =>
                `<div class="c-row" data-url="${esc(a.url)}"><span class="r-ico i-ops">${ICON_ALERT}</span><div class="r-title">${esc(a.name)}${a.event ? `<div class="r-event">${esc(a.event)}</div>` : ""}</div></div>`,
            )
            .join("")
        : `<div class="c-empty">暂无告警 🎉</div>`;
    } catch {
      cOps.innerHTML = `<div class="c-empty">告警加载失败</div>`;
    }
  }
  // 消息（本地轮询存档，最新在前）
  try {
    const rows = (await invoke<MessageRow[]>("get_messages")).sort(
      (a, b) => b.received_at - a.received_at,
    );
    const latest = rows.slice(0, 5);
    cMsgN.textContent = String(unread.size);
    cMsgN.classList.toggle("hot", unread.size > 0);
    cMsgs.innerHTML = latest.length
      ? latest
          .map((m) => {
            const isUnread = unread.has(m.id);
            return `<div class="c-row" data-url="${esc(m.url)}"><span class="r-ico i-msg${isUnread ? " unread" : ""}">${ICON_MSG}</span><div class="r-title">${esc(trim(m.body || m.title, 24))}</div><span class="r-meta">${esc(fmtTime(m.received_at))}</span></div>`;
          })
          .join("")
      : `<div class="c-empty">暂无消息</div>`;
  } catch {
    cMsgs.innerHTML = `<div class="c-empty">消息加载失败</div>`;
  }
  // 可用智能体（悬停「助手」按钮时整卡切换为本节，其余节由 CSS 隐藏）
  try {
    const agents = await fetchAgents();
    cAgentsN.textContent = String(agents.length);
    cAgentsN.classList.toggle("hot", agents.length > 0);
    cAgents.innerHTML = agents.length
      ? agents
          .map((a) => {
            // 图标：页面同款图标，加载失败/缺失 → 首字母色块兜底（随接口图标更新）
            const ico = a.icon
              ? `<img src="${esc(a.icon)}" alt="" /><span class="ag-fb">${esc(a.name.slice(0, 1))}</span>`
              : `<span class="ag-fb" style="display:flex">${esc(a.name.slice(0, 1))}</span>`;
            return `<div class="c-row" data-url="${esc(agentChatUrl(a.id))}"><span class="r-ico i-ag${a.icon ? "" : " no-img"}">${ico}</span><div class="r-title">${esc(a.name)}${a.description ? `<div class="r-desc">${esc(a.description)}</div>` : ""}</div></div>`;
          })
          .join("")
      : `<div class="c-empty">当前账号没有已授权的智能体</div>`;
    // 图标加载失败 → 首字母兜底（内联 onerror 被 CSP 拦截，必须用监听器）
    cAgents.querySelectorAll<HTMLElement>(".r-ico.i-ag").forEach((box) => {
      const img = box.querySelector("img");
      if (!img) return;
      img.addEventListener("error", () => box.classList.add("no-img"));
    });
  } catch {
    cAgents.innerHTML = `<div class="c-empty">智能体加载失败</div>`;
  }
}

// 悬停显隐：条身划入展示，移出条身/卡片 250ms 后收起（缓冲防抖，允许在条↔卡间移动）
// 点击任何按钮 → dismissCard 立即收起并挂起，直到鼠标离开后再次进入速览条才重新浮现
let hideTimer = 0;
let suppressCard = false;
// 智能体视图：悬停「助手」按钮时卡片整体切换为可用智能体列表
let agentMode = false;
/** 退出智能体视图：卡片恢复常规（待办/消息）内容 */
function resetAgentView(): void {
  if (!agentMode) return;
  agentMode = false;
  card.classList.remove("agents-only");
}
function showCard(): void {
  window.clearTimeout(hideTimer);
  suppressCard = false; // 重新进入速览条：解除挂起，恢复正常悬停显隐
  resetAgentView(); // 回到常规视图（智能体视图仅在悬停「助手」按钮时进入）
  void renderCard();
  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
  // 通知 Rust：卡片可见 → 命中测试扩大到整窗（见 commands.rs 轮询线程）
  void invoke("set_mini_card_visible", { visible: true });
}
function hideCard(): void {
  hideTimer = window.setTimeout(() => {
    card.classList.remove("show");
    card.setAttribute("aria-hidden", "true");
    resetAgentView(); // 卡片收起后下次展开恢复常规内容
    void invoke("set_mini_card_visible", { visible: false });
  }, 250);
}
/** 点击交互时收起预览卡：立即收起（不等 250ms），并挂起到下次进入 */
function dismissCard(): void {
  window.clearTimeout(hideTimer);
  card.classList.remove("show");
  card.setAttribute("aria-hidden", "true");
  resetAgentView();
  void invoke("set_mini_card_visible", { visible: false });
  suppressCard = true;
}
const miniEl = document.getElementById("mini")!;
miniEl.addEventListener("mouseenter", showCard);
miniEl.addEventListener("mouseleave", hideCard);
card.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
card.addEventListener("mouseleave", hideCard);

// 卡片行点击：携带 URL 广播，主窗唤起直达（main.ts 按 http 前缀识别）
function bindCardRows(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".c-row");
    const url = row?.dataset.url;
    if (url) {
      dismissCard();
      void emit("mini-navigate", url);
    }
  });
}
bindCardRows(cTodos);
bindCardRows(cOps);
bindCardRows(cMsgs);
bindCardRows(cAgents);
document.getElementById("c-panel")!.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "panel");
});

// 点击交互：广播 mini-navigate，主窗唤起并跳对应页（见 main.ts）
document.getElementById("m-panel")!.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "panel");
});
document.getElementById("m-msg")!.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "messages");
});
document.getElementById("m-todo")!.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "todos");
});
// 快捷功能：与待办按钮同链路，切到主窗「快捷功能」页
document.getElementById("m-quick")!.addEventListener("click", () => {
  dismissCard();
  console.info("[mini] 快捷功能点击 → emit mini-navigate=quick");
  void emit("mini-navigate", "quick");
});
// 应用（仅 AIF）：切到主窗「应用中心」页
opsBtn.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "ops");
});
// 助手按钮：点击打开主窗「助手」页（智能体会话可从该页或悬停卡进入）
assistBtn.addEventListener("click", () => {
  dismissCard();
  void emit("mini-navigate", "assistant");
});
// 悬停「助手」按钮：浮窗整体切换为可用智能体列表。
// 不在按钮 mouseleave 里复位——鼠标移去卡片选智能体时按钮 mouseleave 会先触发，
// 卡片会被错误切回常规视图；改为「卡片收起」或「移回条身其他按钮」时才退出智能体视图。
assistBtn.addEventListener("mouseenter", () => {
  if (suppressCard) return;
  agentMode = true;
  card.classList.add("agents-only");
  if (!card.classList.contains("show")) {
    card.classList.add("show");
    card.setAttribute("aria-hidden", "false");
    void invoke("set_mini_card_visible", { visible: true });
  }
  void renderCard();
});
// 条身内部移动：从「助手」按钮移到其他按钮/空白处 → 退出智能体视图恢复常规
// （卡片有自己的 mouseenter 保活，鼠标在卡片上时不会触发本监听）
miniEl.addEventListener("mouseover", (e) => {
  if (!agentMode) return;
  if ((e.target as HTMLElement).closest("#m-assist")) return;
  resetAgentView();
  if (card.classList.contains("show")) void renderCard();
});
// 关闭：先广播状态（主窗记 localStorage），再自关窗口
document.getElementById("m-close")!.addEventListener("click", () => {
  void emit("mini-closed").then(() =>
    setTimeout(() => void getCurrentWindow().close(), 150),
  );
});

// 事件驱动刷新 + 60s 定时兜底（覆盖主窗 localStorage 变化不触发 storage 事件的场景）
void listen("new-message", () => void refresh());
void listen("messages-updated", () => void refresh());
void listen("todos-updated", () => void refresh());
window.addEventListener("storage", (e) => {
  if (e.key === "aif_unread_msg_ids" || e.key === "aif_quick_count") void refresh();
  // 产品形态切换（AIF ↔ DCP）：同步应用按钮/告警节显隐与条身长度
  else if (e.key === "aif_ops_product") onProductSwitched();
  // 主窗标题栏刷新按钮强制刷新了智能体列表：失效本地缓存，下次悬停重新拉取
  else if (e.key === "aif_agents_bust") agentCache = null;
});
window.setInterval(() => void refresh(), 60_000);

void refresh();
