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

const msgN = document.getElementById("m-msg-n")!;
const todoN = document.getElementById("m-todo-n")!;

function unreadCount(): number {
  try {
    const ids = JSON.parse(
      localStorage.getItem("aif_unread_msg_ids") || "[]",
    ) as string[];
    return Array.isArray(ids) ? ids.length : 0;
  } catch {
    return 0;
  }
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
}

async function todoCount(): Promise<number> {
  try {
    const rows = await invoke<TodoRow[]>("get_todos");
    return rows.filter((t) => !t.done).length;
  } catch {
    return 0;
  }
}

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
