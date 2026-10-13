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
}

interface MessageRow {
  id: string;
  title: string;
  body: string;
  url: string;
  received_at: number;
  muted?: boolean;
}

const msgN = document.getElementById("m-msg-n")!;
const todoN = document.getElementById("m-todo-n")!;
const quickN = document.getElementById("m-quick-n")!;
const card = document.getElementById("card")!;
const cTodos = document.getElementById("c-todos")!;
const cMsgs = document.getElementById("c-msgs")!;
const cTodoN = document.getElementById("c-todo-n")!;
const cMsgN = document.getElementById("c-msg-n")!;

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
  paint(unreadCount(), await todoCount());
  try {
    const entries = await invoke<{ ops: boolean; url: string; username: string }[]>(
      "account_list",
    );
    quickN.textContent = String(entries.length);
    quickN.classList.toggle("hot", entries.length > 0);
  } catch {
    quickN.textContent = "-";
  }
}

async function todoCount(): Promise<number> {
  try {
    const rows = await invoke<TodoRow[]>("get_todos");
    return rows.filter((t) => !t.done).length;
  } catch {
    return 0;
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

/** 渲染预览卡内容：待办未办结 Top3 + 本地库最新 3 条消息（未读图标变红） */
async function renderCard(): Promise<void> {
  const unread = new Set(unreadIds());
  // 待办
  try {
    const rows = (await invoke<TodoRow[]>("get_todos")).filter((t) => !t.done);
    const undone = rows.slice(0, 3);
    cTodoN.textContent = String(rows.length);
    cTodoN.classList.toggle("hot", rows.length > 0);
    cTodos.innerHTML = undone.length
      ? undone
          .map(
            (t) =>
              `<div class="c-row" data-url="${esc(t.url)}"><span class="r-ico i-todo">${ICON_TODO}</span><div class="r-title">${esc(trim(t.title, 22))}</div></div>`,
          )
          .join("")
      : `<div class="c-empty">暂无待办 🎉</div>`;
  } catch {
    cTodos.innerHTML = `<div class="c-empty">待办加载失败</div>`;
  }
  // 消息（本地轮询存档，最新在前）
  try {
    const rows = (await invoke<MessageRow[]>("get_messages")).sort(
      (a, b) => b.received_at - a.received_at,
    );
    const latest = rows.slice(0, 3);
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
}

// 悬停显隐：条身划入展示，移出条身/卡片 250ms 后收起（缓冲防抖，允许在条↔卡间移动）
let hideTimer = 0;
function showCard(): void {
  window.clearTimeout(hideTimer);
  void renderCard();
  card.classList.add("show");
  card.setAttribute("aria-hidden", "false");
}
function hideCard(): void {
  hideTimer = window.setTimeout(() => {
    card.classList.remove("show");
    card.setAttribute("aria-hidden", "true");
  }, 250);
}
document.getElementById("mini")!.addEventListener("mouseenter", showCard);
document.getElementById("mini")!.addEventListener("mouseleave", hideCard);
card.addEventListener("mouseenter", () => window.clearTimeout(hideTimer));
card.addEventListener("mouseleave", hideCard);

// 卡片行点击：携带 URL 广播，主窗唤起直达（main.ts 按 http 前缀识别）
function bindCardRows(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".c-row");
    const url = row?.dataset.url;
    if (url) void emit("mini-navigate", url);
  });
}
bindCardRows(cTodos);
bindCardRows(cMsgs);
document.getElementById("c-panel")!.addEventListener("click", () => {
  void emit("mini-navigate", "panel");
});

// 点击交互：广播 mini-navigate，主窗唤起并跳对应页（见 main.ts）
document.getElementById("m-panel")!.addEventListener("click", () => {
  void emit("mini-navigate", "panel");
});
document.getElementById("m-msg")!.addEventListener("click", () => {
  void emit("mini-navigate", "messages");
});
document.getElementById("m-todo")!.addEventListener("click", () => {
  void emit("mini-navigate", "todos");
});
// 常用入口：主窗打开切换弹窗（选账号 → 保存并登录）
document.getElementById("m-quick")!.addEventListener("click", () => {
  void emit("mini-navigate", "entries");
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
  if (e.key === "aif_unread_msg_ids") void refresh();
});
window.setInterval(() => void refresh(), 60_000);

void refresh();
