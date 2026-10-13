import "./styles.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { api, on, type AccountEntry, type DocRow, type HistoryMessage, type MatterBadge, type MatterRow, type MessageRow, type OpsApp, type OpsAppGroup, type QuickEntry, type RoleOption, type Settings, type SpaceRow, type TabInfo, type TodoRow, type UserInfo } from "./api";

const app = document.getElementById("app")!;
const win = getCurrentWindow();

let settings: Settings | null = null;
let userInfo: UserInfo | null = null;
let captchaRequired = false;
let currentTab: "messages" | "todos" | "ops" | "docs" | "spaces" | "quick" | "profile" = "messages";
let soundCache: Record<string, HTMLAudioElement> = {};
// 应用版本号（5.0.1+build-id），启动时取一次
let appVersion = "…";

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

/// 品牌徽标：品牌蓝渐变底 + 白色信封（替代 logo.png 位图，与头像渐变语言统一）
const LOGO_BADGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="5.2" width="17.6" height="13.6" rx="2.6"/><path d="m4.5 7.5 7.5 5.3 7.5-5.3"/></svg>`;
const logoBadgeHtml = (): string => `<span class="logo-badge">${LOGO_BADGE_SVG}</span>`;

/// 顶栏轮询状态：刷新图标 + 右下角状态角标（绿勾=正常 / 红叉=异常），悬停看上次刷新时间
interface PollStatusPayload {
  ok: boolean;
  ts: number;
}
/* 刷新箭头（lucide rotate-cw 风格，与全站线性图标统一） */
const POLL_REFRESH_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>`;
const POLL_OK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const POLL_BAD_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>`;
function setPollInfo(ok: boolean, ts: number) {
  const d = new Date(ts * 1000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const ico = document.getElementById("poll-ico");
  if (ico) {
    ico.classList.add("seen");
    ico.classList.toggle("bad", !ok);
    ico.title = ok ? `数据正常 · ${hm} 已刷新（点击立即刷新）` : `刷新失败，将自动重试 · ${hm}（点击立即刷新）`;
  }
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** AI 问答入口：两产品均有原生问答页，直开（均经 B/S 原生源码证实，会话 Cookie 共享）：
 *  - 运维（AIF）：/AIF/ai/chat/index.htm?spaceId=&questionText=
 *    （B/S 原生：顶栏搜索「AI」tab → nonlogin/knowledge/view/search.htm?showTab=ai 内嵌加载；
 *      注意 /DCP/ai/index.htm 在 AIF 会话下 401，两产品问答页互不相通）
 *  - 一表通（DCP）：/DCP/ai/index.htm?spaceId=&questionText=（同款搜索页内嵌加载）
 *  注：/AIF/ai/persona/agent/authorized.htm 当前账号实测返回 []，多智能体菜单链路弃用 */
function aiEntryUrl(): string {
  const base = (settings?.base_url || "").replace(/\/+$/, "");
  return settings?.ops_product
    ? `${base}/AIF/ai/chat/index.htm?spaceId=&questionText=`
    : `${base}/DCP/ai/index.htm?spaceId=&questionText=`;
}


/** 产品品牌名：运维（AIF）=「运维小助手」，一表通（DCP）=「一表通小助手」（与后端 Settings::product_title 对齐） */
function productTitle(): string {
  return settings?.ops_product ? "运维小助手" : "一表通小助手";
}

// ---------------- 布局模式（默认小屏 / 全屏三栏） ----------------
// mini：2 栏（左导航 + 列表），新开页面用独立 webview 窗口；
// full：3 栏（左导航 + 列表 + 内嵌 webview 面板），新开页面直接在面板内加载。
type LayoutMode = "mini" | "full";
// 每次启动一律默认小窗（右下角），不恢复上次的全屏模式；localStorage 仅记录运行期切换
let layoutMode: LayoutMode = "mini";
let listCollapsed = false; // 全屏模式下列表页是否隐藏（仅 full 模式有效，切 mini 自动复位）
// 「自动隐藏」开关：全屏模式下打开网页时自动隐藏列表页（localStorage 持久化，默认开启；兼容旧键 aif_auto_fold）
let _autoHideRaw = localStorage.getItem("aif_auto_hide");
if (_autoHideRaw === null) _autoHideRaw = localStorage.getItem("aif_auto_fold");
let autoHide = _autoHideRaw !== "0";
// 「多标签页」开关：开启时每点一个页面开一个新标签；关闭后只保留第一个标签，点击页面只更新该标签（默认开启）
let multiTab = localStorage.getItem("aif_multi_tab") !== "0";
// 多标签页状态（全屏三栏；与 Rust tabs 模块经 tabs-changed / tab-title 事件同步）
let tabs: TabInfo[] = [];
// 「切换常用入口」弹窗打开中：标签临时隐藏，resize 同步暂停，避免标签盖回弹窗
let entryDlgOpen = false;

const EXPAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`;
const CONTRACT_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/></svg>`;
/// 顶栏「关闭」图标（X）：功能不变——隐藏窗口到托盘，托盘菜单「退出」才真正退出
const CLOSE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>`;
/// 「折叠列表页」双态图标（lucide panel-left-close / panel-left-open 风格）
const FOLD_LIST_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/><path d="M16.5 9.5L14 12l2.5 2.5"/></svg>`;
const UNFOLD_LIST_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/><path d="M14 9.5l2.5 2.5L14 14.5"/></svg>`;
/// 顶栏「切换入口」图标（lucide arrow-left-right 风格）
const SWAP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3L4 7l4 4"/><path d="M4 7h16"/><path d="M16 21l4-4-4-4"/><path d="M20 17H4"/></svg>`;

/// 标签视口 DOM rect → 物理像素（tab bar 预留带下方的 #tab-viewport，
/// 窗口客户区原点，decorations:false 客户区=窗口）
function paneRect(): { x: number; y: number; w: number; h: number } | null {
  const pane = document.getElementById("tab-viewport");
  if (!pane || layoutMode !== "full") return null;
  const r = pane.getBoundingClientRect();
  const d = window.devicePixelRatio || 1;
  if (r.width < 40 || r.height < 40) return null;
  return { x: Math.round(r.left * d), y: Math.round(r.top * d), w: Math.round(r.width * d), h: Math.round(r.height * d) };
}

/** 统一打开入口：全屏模式新开标签页；默认模式开独立 webview 窗口（全屏）。
 *  标签打开失败（如达到 8 个上限）时回退独立窗口，不吞错。 */
async function openUrl(url: string): Promise<void> {
  if (layoutMode === "full") {
    // 开关开启时先隐藏列表页再取标签视口 rect：视口一步到位占满全宽，避免二次调整
    maybeAutoHide();
    const rect = paneRect();
    if (rect) {
      try {
        if (multiTab) {
          // 多标签模式：每点一个页面新开一个标签
          await api.tabOpen(url, rect.x, rect.y, rect.w, rect.h);
        } else if (tabs.length === 0) {
          // 单标签模式：首个页面开成唯一标签
          await api.tabOpen(url, rect.x, rect.y, rect.w, rect.h);
        } else {
          // 单标签模式：点击任何页面只更新第一个（唯一）标签，不新建其他标签
          await api.tabNavigate(tabs[0].id, url);
        }
        return;
      } catch (e) {
        toast("新标签页打开失败，已改用独立窗口");
        console.warn("tab_open failed:", e);
      }
    }
  }
  void api.openConversation(url);
}

/** 新建标签页（「+」/ Ctrl+T）：url 空串 = 当前入口落地页 */
async function newTab(): Promise<void> {
  if (layoutMode !== "full") return;
  await openUrl("");
}

// ---------------- 标签栏（browser-like tabs） ----------------

/// 标签栏 DOM 变化后的统一渲染：无标签时整条隐藏，露出占位提示
/// 各标签活动指示条配色（按位置循环取色，保证不同标签颜色不同）
const TAB_COLORS = [
  "#ef4444", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

function renderTabBar() {
  const bar = document.getElementById("tab-bar");
  const list = document.getElementById("tab-list");
  const hint = document.querySelector(".pane-hint");
  if (!bar || !list) return;
  const show = layoutMode === "full" && tabs.length > 0;
  bar.style.display = show ? "flex" : "none";
  if (hint) (hint as HTMLElement).style.display = show ? "none" : "flex";
  if (!show) {
    list.innerHTML = "";
    return;
  }
  list.innerHTML = tabs
    .map(
      (t, i) => `
    <div class="tab${t.active ? " active" : ""}${t.hibernated ? " hibernated" : ""}" data-id="${t.id}" style="--tab-color:${TAB_COLORS[i % TAB_COLORS.length]}" title="${t.hibernated ? "已休眠（60 分钟未激活），点击重新加载" : t.url}">
      <span class="tab-title">${esc(t.title || "新标签页")}</span>
      <button class="tab-close" data-close="${t.id}" title="关闭标签页">×</button>
    </div>`
    )
    .join("");
}

/// 标签栏事件接线（renderPanel 后调用一次；列表本身随 tabs-changed 重渲染）
function bindTabBar() {
  const list = document.getElementById("tab-list");
  if (!list) return;
  list.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    const closeBtn = t.closest("[data-close]") as HTMLElement | null;
    if (closeBtn) {
      ev.stopPropagation();
      void api.tabClose(closeBtn.dataset.close!).catch((e) => toast(String(e)));
      return;
    }
    const tab = t.closest(".tab") as HTMLElement | null;
    if (tab?.dataset.id) void api.tabActivate(tab.dataset.id).catch((e) => toast(String(e)));
  });
  // 中键点击标签 = 关闭（浏览器惯例）
  list.addEventListener("mousedown", (ev) => {
    if (ev.button !== 1) return;
    const tab = (ev.target as HTMLElement).closest(".tab") as HTMLElement | null;
    if (tab?.dataset.id) {
      ev.preventDefault();
      void api.tabClose(tab.dataset.id).catch(() => {});
    }
  });
  document.getElementById("tab-add")?.addEventListener("click", () => void newTab());
}

/** 折叠/恢复全屏三栏中的列表页：content 隐藏后 web-pane 占满剩余宽度。
 *  窗口本身未 resize、DOM 变宽也不会触发 resize 事件，故需主动同步一次面板边界。 */
function setListCollapsed(collapsed: boolean) {
  if (layoutMode !== "full") return;
  listCollapsed = collapsed;
  document.querySelector(".panel")?.classList.toggle("list-collapsed", collapsed);
  const btn = document.getElementById("btn-collapse");
  if (btn) {
    btn.title = collapsed ? "恢复列表页" : "折叠列表页";
    btn.innerHTML = `<span class="nav-ico idle">${collapsed ? UNFOLD_LIST_SVG : FOLD_LIST_SVG}</span>`;
  }
  if (tabs.length > 0) {
    window.setTimeout(() => {
      const rect = paneRect();
      if (rect) void api.tabBounds(rect.x, rect.y, rect.w, rect.h).catch(() => {});
    }, 160); // 等 CSS 过渡结束再上报，避免标签视口取到过渡中的中间尺寸
  }
}

/** 「自动隐藏」开关生效点：全屏模式 + 开关开启 + 尚未隐藏时，自动隐藏列表页 */
function maybeAutoHide() {
  if (layoutMode === "full" && autoHide && !listCollapsed) setListCollapsed(true);
}

/** 切换布局模式：full 最大化窗口出三栏；mini 还原窗口尺寸并隐藏面板。
 *  注意先执行窗口命令再切 class：命令失败（如新旧实例错配导致 Unknown command）
 *  时保持原状并弹 toast，避免出现「CSS 已是 mini 而窗口仍全屏」的劈叉状态。 */
async function setLayoutMode(mode: LayoutMode) {
  const apply = async () => {
    if (mode === "full") {
      // 伪最大化：主进程把窗口精确铺到工作区（原生 maximize 对 borderless 窗口会位移错位）
      await invoke("layout_full");
    } else {
      // 标签语义只存在于全屏三栏：切小窗即全部关闭（子 webview 随之销毁）
      try {
        await api.tabCloseAll();
      } catch {
        /* 无标签 */
      }
      tabs = [];
      renderTabBar();
      await invoke("layout_mini");
    }
  };
  try {
    await apply();
  } catch (e) {
    console.error("layout command failed:", e);
    toast(`布局切换失败（前后端版本可能不一致，请完全退出后重启）: ${e}`);
    return;
  }
  layoutMode = mode;
  localStorage.setItem("aif_layout", mode);
  document.querySelector(".panel")?.classList.toggle("mode-full", mode === "full");
  updateEntryBtn(); // 布局切换后重新评估「切换入口」按钮可见性
  // 切小窗自动取消折叠（按钮本身由 CSS 在 mini 模式隐藏）
  if (listCollapsed) {
    listCollapsed = false;
    document.querySelector(".panel")?.classList.remove("list-collapsed");
  }
  if (mode === "full") {
    // 进入全屏：先上报标签视口 rect（Rust 侧记相对布局供 resize 兜底），
    // 再按设置恢复上次标签页（休眠条目按需加载，不拖慢启动）
    const rect = paneRect();
    if (rect) void api.tabBounds(rect.x, rect.y, rect.w, rect.h).catch(() => {});
    if (multiTab && settings?.tab_restore && tabs.length === 0) {
      try {
        tabs = await api.tabRestoreSession();
        renderTabBar();
      } catch (e) {
        console.warn("tab_restore_session failed:", e);
      }
    }
  }
  const btn = document.getElementById("btn-mode");
  if (btn) {
    btn.title = mode === "full" ? "切回默认模式" : "切换全屏模式";
    btn.innerHTML = mode === "full" ? CONTRACT_SVG : EXPAND_SVG;
  }
  dumpLayout(mode === "full" ? "maximize" : "unmaximize"); // [临时诊断]
}

/// 启动/重渲染后恢复已保存的布局模式（窗口状态与 CSS 类对齐）
function applyLayoutMode() {
  void setLayoutMode(layoutMode);
}

/// 窗口尺寸变化（最大化/还原/拖拽边缘）：标签边界同步跟随占位 DOM
function bindPaneResize() {
  let timer = 0;
  window.addEventListener("resize", () => {
    dumpLayout("resize");
    if (entryDlgOpen) return; // 入口切换弹窗期间标签被临时隐藏，暂停边界同步
    if (layoutMode !== "full" || tabs.length === 0) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const rect = paneRect();
      if (rect) void api.tabBounds(rect.x, rect.y, rect.w, rect.h).catch(() => {});
    }, 120);
  });
}

/// 标签页快捷键（仅全屏模式）：Ctrl+T 新建 / Ctrl+W 关闭当前 /
/// Ctrl+Tab（或 Ctrl+PgDn/PgUp）循环切换。WebView2 若吞掉 Ctrl+Tab，
/// 仍可用 Ctrl+PageDown/PageUp 别名。
function bindTabShortcuts() {
  document.addEventListener("keydown", (e) => {
    if (layoutMode !== "full" || tabs.length === 0) return;
    const t = e.target as HTMLElement | null;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && !e.altKey && !e.metaKey && k === "t") {
      e.preventDefault();
      void newTab();
    } else if (e.ctrlKey && !e.altKey && !e.metaKey && k === "w") {
      e.preventDefault();
      const active = tabs.find((x) => x.active);
      if (active) void api.tabClose(active.id).catch((err) => toast(String(err)));
    } else if (e.ctrlKey && (k === "tab" || k === "pagedown") && !e.shiftKey) {
      e.preventDefault();
      const i = tabs.findIndex((x) => x.active);
      const next = tabs[(i + 1) % tabs.length];
      if (next) void api.tabActivate(next.id).catch(() => {});
    } else if (e.ctrlKey && ((k === "tab" && e.shiftKey) || k === "pageup")) {
      e.preventDefault();
      const i = tabs.findIndex((x) => x.active);
      const prev = tabs[(i - 1 + tabs.length) % tabs.length];
      if (prev) void api.tabActivate(prev.id).catch(() => {});
    }
  });
}

// [临时诊断] 布局偏移排查：把窗口内关键 DOM / 视口几何 + 主 webview 原生几何写到后端临时文件。
// 确认 topbar/sidenav 缺失根因后即可删除本函数及全部 dumpLayout 调用。
async function dumpLayout(tag: string) {
  try {
    const r = (sel: string) => {
      const e = document.querySelector(sel) as HTMLElement | null;
      if (!e) return `${sel}:null`;
      const b = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return `${sel}{disp:${cs.display},vis:${cs.visibility},pos:${cs.position},rect:${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.width)}x${Math.round(b.height)}${e.offsetParent ? "" : ",detached"}}`;
    };
    const vv: any = (window as any).visualViewport;
    const vvInfo = vv
      ? `vv{off:${Math.round(vv.offsetLeft)},${Math.round(vv.offsetTop)},scale:${vv.scale?.toFixed(3)},page:${Math.round(vv.pageLeft)},${Math.round(vv.pageTop)},w:${Math.round(vv.width)},h:${Math.round(vv.height)}}`
      : "vv:none";
    const payload = [
      `mode:${layoutMode},tab:${currentTab}`,
      `inner:${window.innerWidth}x${window.innerHeight},dpr:${window.devicePixelRatio}`,
      `scr:${window.screenX},${window.screenY}`, // [临时诊断] webview 自报屏幕原点（CSS px），应≈0,0
      `docClient:${document.documentElement.clientWidth}x${document.documentElement.clientHeight}`,
      `scroll:${document.scrollingElement?.scrollTop},${document.scrollingElement?.scrollLeft}`,
      vvInfo,
      r("#app"), r(".panel"), r(".topbar"), r(".sidenav"), r(".main-row"), r(".content"), r(".web-pane"),
    ].join(" | ");
    // [临时诊断] 追加主 webview 原生几何，确认 topbar/sidenav 是否已归位（应 wv_pos=0,0）
    let native = "native:?";
    try {
      native = "native:" + (await invoke("debug_webview_rect"));
    } catch {
      /* ignore */
    }
    void invoke("debug_dump", { tag, payload: payload + " | " + native });
  } catch (e) {
    console.warn("dumpLayout failed", e);
  }
}
(window as any).aifDump = (t = "manual") => dumpLayout(t);
// [临时诊断] 控制台直读/驱动布局状态：aifLayout.get() / aifLayout.set("mini"|"full")
(window as any).aifLayout = {
  get: () => layoutMode,
  set: (m: LayoutMode) => setLayoutMode(m),
};

function toast(msg: string) {
  // 全屏模式：提示框加宽加高、屏幕正中醒目展示（出错/重要提示更易察觉）
  const t = el(`<div class="toast${layoutMode === "full" ? " toast-big" : ""}" role="status">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 220);
  }, layoutMode === "full" ? 3200 : 2400);
}

/** 骨架屏占位（列表加载态，替代「加载中…」文字） */
const skels = (n = 4): string => Array.from({ length: n }, () => `<div class="skel"></div>`).join("");

/** 密码可见切换图标（线性眼睛，与全站线性图标风格一致） */
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5c1.7 0 3.2.5 4.5 1.2M21.5 12S18 18.5 12 18.5c-1.7 0-3.2-.5-4.5-1.2"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M4 20L20 4"/></svg>`;

// 输入防抖（搜索框用）
function debounce(fn: (e: Event) => void, ms: number): (e: Event) => void {
  let timer: number | undefined;
  return (e: Event) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(e), ms);
  };
}

function fmtTime(sec: number): string {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${hm}`;
}

// ---------------- 提示音 ----------------
function playSound(name: string) {
  try {
    const key = name || "chime";
    if (!soundCache[key]) soundCache[key] = new Audio(`./sounds/${key}.wav`);
    soundCache[key].currentTime = 0;
    void soundCache[key].play();
  } catch {
    /* 自动播放限制时忽略 */
  }
}

// ---------------- 登录视图 ----------------
function renderLogin(prefill = "") {
  captchaRequired = false;
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-head" data-tauri-drag-region>
        <span class="tb-spacer"></span>
        <button class="icon-btn" id="btn-hide" title="收起">─</button>
      </div>
      <div class="login-body">
        <!-- 右上角齿轮：展开/收起服务器设置 -->
        <button type="button" class="icon-btn srv-toggle" id="lg-srv-toggle" title="服务器设置"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.03 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"/></svg></button>
        <div class="login-brand">
          ${logoBadgeHtml()}
          <div>
            <div class="brand-hello">欢迎使用</div>
            <div class="brand-title">${productTitle()}</div>
          </div>
        </div>
        <div class="login-sub">登录WEB系统 · 密码连续输错 3 次将触发图形验证码</div>
        <!-- 首次使用：服务器地址与产品类型可在此直接配置（默认运维 AIF），保存后立即生效 -->
        <details class="login-srv" id="lg-srv" ${settings ? "" : "open"}>
          <summary>服务器地址 · 产品类型</summary>
          <div class="field">
            <label class="f-cap">服务器地址</label>
            <input type="text" id="lg-url" placeholder="https://host[:端口]" value="${esc(settings?.base_url || "https://51yunwei.com.cn")}" />
          </div>
          <div class="field">
            <label class="f-cap">产品类型</label>
            <div class="seg" id="lg-seg">
              <button class="seg-opt ${settings?.ops_product ? "active" : ""}" data-ops="1">运维（AIF）</button>
              <button class="seg-opt ${!settings?.ops_product ? "active" : ""}" data-ops="0">一表通（DCP）</button>
            </div>
          </div>
        </details>
        <div class="field">
          <label class="f-cap">账号</label>
          <input type="text" id="lg-user" placeholder="请输入账号" value="${esc(prefill)}" />
        </div>
        <div class="field">
          <label class="f-cap">密码</label>
          <div class="pwd-row">
            <input type="password" id="lg-pass" placeholder="请输入密码" />
            <button type="button" class="icon-btn" id="lg-eye" title="显示/隐藏密码">${EYE_SVG}</button>
          </div>
        </div>
        <div class="field" id="lg-captcha-field" style="display:none">
          <label class="f-cap">图形验证码（点击图片刷新）</label>
          <div class="captcha-row">
            <input type="text" id="lg-captcha" placeholder="验证码" />
            <img id="lg-captcha-img" class="captcha-img" alt="验证码" title="点击刷新" />
          </div>
        </div>
        <div class="error-text" id="lg-error"></div>
        <div class="login-hint">登录后，服务器地址·产品·账号密码将自动存入「我的 → 常用入口」（密码国密 SM4 加密）</div>
      </div>
      <div class="login-foot">
        <button class="btn primary block" id="lg-submit">登 录</button>
      </div>
    </div>`;

  document.getElementById("btn-hide")!.addEventListener("click", () => void win.hide());
  // 齿轮按钮：展开/收起服务器设置折叠区（summary 原生点击同样可切换）
  document.getElementById("lg-srv-toggle")!.addEventListener("click", () => {
    const d = document.getElementById("lg-srv") as HTMLDetailsElement;
    d.open = !d.open;
  });
  document.getElementById("lg-captcha-img")!.addEventListener("click", loadCaptcha);
  document.getElementById("lg-submit")!.addEventListener("click", doLogin);
  // 登录页产品单选组：点击即改 settings（登录时一并保存）
  document.querySelectorAll("#lg-seg .seg-opt").forEach((b) =>
    b.addEventListener("click", () => {
      if (!settings) return;
      settings.ops_product = (b as HTMLElement).dataset.ops === "1";
      document.querySelectorAll("#lg-seg .seg-opt").forEach((x) => x.classList.toggle("active", x === b));
    }),
  );
  document.getElementById("lg-pass")!.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void doLogin();
  });
  // 密码可见切换（眼睛按钮）
  const eye = document.getElementById("lg-eye")!;
  eye.addEventListener("click", () => {
    const inp = document.getElementById("lg-pass") as HTMLInputElement;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    eye.innerHTML = show ? EYE_OFF_SVG : EYE_SVG;
  });
}

async function loadCaptcha() {
  const img = document.getElementById("lg-captcha-img") as HTMLImageElement;
  try {
    const p = await api.getCaptcha();
    img.src = p.image_base64;
  } catch (e) {
    toast("获取验证码失败：" + String(e));
  }
}

async function showCaptcha() {
  captchaRequired = true;
  document.getElementById("lg-captcha-field")!.style.display = "";
  await loadCaptcha();
}

async function doLogin() {
  const errEl = document.getElementById("lg-error")!;
  errEl.textContent = "";
  const uname = (document.getElementById("lg-user") as HTMLInputElement).value.trim();
  const pwd = (document.getElementById("lg-pass") as HTMLInputElement).value;
  if (!uname || !pwd) {
    errEl.textContent = "请输入账号和密码";
    return;
  }
  const verification = captchaRequired
    ? (document.getElementById("lg-captcha") as HTMLInputElement).value.trim()
    : "";
  if (captchaRequired && !verification) {
    errEl.textContent = "请输入图形验证码";
    return;
  }
  const btn = document.getElementById("lg-submit") as HTMLButtonElement;
  btn.disabled = true;
  btn.innerHTML = '<span class="btn-spin"></span>登录中…';
  try {
    // 先落盘登录页上的服务器设置（首次使用正确初始化 URL / 产品路径后再登录）
    if (settings) {
      // 尾斜杠规范化：无论录入带不带 /，落库统一无尾斜杠（Rust 侧拼接按此约定）
      settings.base_url =
        ((document.getElementById("lg-url") as HTMLInputElement | null)?.value || "")
          .trim()
          .replace(/\/+$/, "") || settings.base_url;
      await api.saveSettings(settings);
    }
    // remember 已废弃（凭据统一存常用入口保险库），登录后 Rust 侧清空 keyring 凭据
    await api.loginLocal(uname, pwd, verification, false);
    // 登录成功：当前 服务器地址+产品+账号密码 一并存入常用入口（SM4 加密），失败不影响登录。
    // 若已存在同主键（项目+网址+账号）的入口，保留其原有备注，避免覆盖。
    if (settings) {
      const s = settings;
      let remark = "";
      try {
        const list = await api.accountList();
        const u = s.base_url.trim().replace(/\/+$/, "");
        remark = list.find((e) => e.ops === s.ops_product && e.url === u && e.username === uname)?.remark || "";
      } catch {
        /* 读取失败则无备注保存 */
      }
      await api.accountSave(s.ops_product, s.base_url, uname, pwd, remark).catch(() => {});
    }
    toast("登录成功");
    await bootstrap();
  } catch (e) {
    const msg = String(e).replace(/^"|"$/g, "");
    errEl.textContent = msg || "登录失败";
    // 验证码相关错误 → 显示验证码行并刷新
    if (msg.includes("验证码")) {
      await showCaptcha();
      (document.getElementById("lg-captcha") as HTMLInputElement).value = "";
    } else if (captchaRequired) {
      await loadCaptcha();
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "登 录";
  }
}

// ---------------- 面板视图 ----------------
// 底部导航：未选中 = 黑白框线图标（stroke currentColor），选中 = 彩色实底图标
const ICONS: Record<string, { active: string; idle: string }> = {
  messages: {
    active: `<svg viewBox="0 0 24 24"><path fill="#3b82f6" d="M12 3C6.9 3 3 6.4 3 10.7c0 2.3 1.1 4.3 2.9 5.7-.1 1-.6 2.2-1.6 3.2 1.9-.1 3.4-.8 4.4-1.5 1 .3 2.1.4 3.3.4 5.1 0 9-3.4 9-7.7S17.1 3 12 3z"/><circle cx="8" cy="10.8" r="1.2" fill="#fff"/><circle cx="12" cy="10.8" r="1.2" fill="#fff"/><circle cx="16" cy="10.8" r="1.2" fill="#fff"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4c-4.6 0-8 2.9-8 6.4 0 2 1 3.8 2.6 5-.1.9-.5 1.9-1.4 2.8 1.6-.1 2.9-.7 3.8-1.3.9.3 1.9.5 3 .5 4.6 0 8-2.9 8-6.5S16.6 4 12 4z"/><circle cx="8.2" cy="10.4" r="0.6" fill="currentColor" stroke="none"/><circle cx="12" cy="10.4" r="0.6" fill="currentColor" stroke="none"/><circle cx="15.8" cy="10.4" r="0.6" fill="currentColor" stroke="none"/></svg>`,
  },
  todos: {
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#f59e0b"/><path d="M7.5 12.2l3 3 6-6.4" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="4.5"/><path d="M8.5 12.2l2.5 2.5 4.7-5.1"/></svg>`,
  },
  docs: {
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#6366f1"/><path d="M8 4.5h5.5L17 8v11.5H8z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.2 4.8V8.2h3.6" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 12.5h5M10 15.5h5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 3.5h6.2L18 8.3v12.2H7z"/><path d="M13 3.8V8.3h4.8"/><path d="M10 12.5h5M10 15.5h5"/></svg>`,
  },
  spaces: {
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#06b6d4"/><path d="M3.5 8a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V8z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z"/></svg>`,
  },
  ops: {
    // 运维：服务器机架 + 心跳折线（青绿）
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#14b8a6"/><rect x="6" y="6.5" width="12" height="4.4" rx="1.2" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="8.4" cy="8.7" r="0.9" fill="#fff"/><rect x="6" y="13.1" width="12" height="4.4" rx="1.2" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="8.4" cy="15.3" r="0.9" fill="#fff"/><path d="M11 15.3h5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6.5" width="12" height="4.4" rx="1.2"/><circle cx="8.6" cy="8.7" r="0.5" fill="currentColor" stroke="none"/><rect x="6" y="13.1" width="12" height="4.4" rx="1.2"/><circle cx="8.6" cy="15.3" r="0.5" fill="currentColor" stroke="none"/><path d="M11.4 15.3h4.6"/></svg>`,
  },
  quick: {
    // 快捷功能：九宫格（紫）
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#8b5cf6"/><g fill="#fff"><rect x="6.4" y="6.4" width="3.4" height="3.4" rx="0.9"/><rect x="10.3" y="6.4" width="3.4" height="3.4" rx="0.9"/><rect x="14.2" y="6.4" width="3.4" height="3.4" rx="0.9"/><rect x="6.4" y="10.3" width="3.4" height="3.4" rx="0.9"/><rect x="10.3" y="10.3" width="3.4" height="3.4" rx="0.9"/><rect x="14.2" y="10.3" width="3.4" height="3.4" rx="0.9"/><rect x="6.4" y="14.2" width="3.4" height="3.4" rx="0.9"/><rect x="10.3" y="14.2" width="3.4" height="3.4" rx="0.9"/><rect x="14.2" y="14.2" width="3.4" height="3.4" rx="0.9"/></g></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="4" y="4" width="6.2" height="6.2" rx="1.6"/><rect x="13.8" y="4" width="6.2" height="6.2" rx="1.6"/><rect x="4" y="13.8" width="6.2" height="6.2" rx="1.6"/><rect x="13.8" y="13.8" width="6.2" height="6.2" rx="1.6"/></svg>`,
  },
  profile: {
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#10b981"/><circle cx="12" cy="9.6" r="3" fill="#fff"/><path d="M5.8 18.6c.9-2.6 3.3-4.1 6.2-4.1s5.3 1.5 6.2 4.1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.3" r="3.3"/><path d="M5.3 19.2c.9-2.9 3.5-4.6 6.7-4.6s5.8 1.7 6.7 4.6"/></svg>`,
  },
};

function renderPanel() {
  app.innerHTML = `
    <div class="panel ${layoutMode === "full" ? "mode-full" : ""}">
      <div class="topbar">
        ${logoBadgeHtml()}
        <span class="tb-title-group"><span class="title">${productTitle()}</span><span class="topbar-user" id="topbar-user" title=""></span></span>
        <span class="tb-spacer"></span>
        <span class="tb-entry-wrap" id="tb-entry-wrap"><span class="tb-entry" id="tb-entry"></span><button class="icon-btn" id="btn-entry" title="切换常用入口">${SWAP_SVG}</button></span>
        <span class="tb-spacer"></span>
        <label class="cb-wrap mtab-wrap" title="多标签页：开启时每点一个页面开一个新标签；关闭后只保留第一个标签，点击页面只更新该标签"><input type="checkbox" id="mtab-chk" ${multiTab ? "checked" : ""} /><span class="cb-text">多标签页</span></label>
        <label class="cb-wrap autohide-wrap" title="打开网页时自动折叠列表页，提供更大页面空间"><input type="checkbox" id="autohide-chk" ${autoHide ? "checked" : ""} /><span class="cb-text">自动折叠</span></label>
        <button class="icon-btn ai-btn" id="btn-ai" title="AI 问答">AI</button>
        <span class="poll-ico" id="poll-ico" role="button" title=""><span class="poll-arrow">${POLL_REFRESH_SVG}</span><span class="poll-badge"><span class="pb-ok">${POLL_OK_SVG}</span><span class="pb-bad">${POLL_BAD_SVG}</span></span></span>
        <button class="icon-btn" id="btn-mode" title="切换全屏模式">${EXPAND_SVG}</button>
        <button class="icon-btn" id="btn-hide" title="关闭窗口（隐藏到托盘）">${CLOSE_SVG}</button>
      </div>
      <div class="main-row">
        <nav class="sidenav" id="sidenav">
          <button class="nav-btn" data-tab="messages" title="消息"><span class="tab-badge" id="badge-messages"></span><span class="nav-ico idle">${ICONS.messages.idle}</span><span class="nav-ico active">${ICONS.messages.active}</span></button>
          <button class="nav-btn" data-tab="todos" title="待办"><span class="tab-badge" id="badge-todos"></span><span class="nav-ico idle">${ICONS.todos.idle}</span><span class="nav-ico active">${ICONS.todos.active}</span></button>
          ${settings?.ops_product ? `<button class="nav-btn" data-tab="ops" title="运维"><span class="nav-ico idle">${ICONS.ops.idle}</span><span class="nav-ico active">${ICONS.ops.active}</span></button>` : ""}
          <button class="nav-btn" data-tab="docs" title="文档"><span class="nav-ico idle">${ICONS.docs.idle}</span><span class="nav-ico active">${ICONS.docs.active}</span></button>
          <button class="nav-btn" data-tab="spaces" title="空间"><span class="nav-ico idle">${ICONS.spaces.idle}</span><span class="nav-ico active">${ICONS.spaces.active}</span></button>
          <button class="nav-btn" data-tab="quick" title="快捷功能"><span class="nav-ico idle">${ICONS.quick.idle}</span><span class="nav-ico active">${ICONS.quick.active}</span></button>
          <button class="nav-btn collapse-btn" id="btn-collapse" title="折叠列表页"><span class="nav-ico idle">${listCollapsed ? UNFOLD_LIST_SVG : FOLD_LIST_SVG}</span></button>
          <button class="nav-btn nav-bottom" data-tab="profile" title="我的"><span class="nav-ico idle">${ICONS.profile.idle}</span><span class="nav-ico active">${ICONS.profile.active}</span></button>
        </nav>
        <div class="content" id="content"></div>
        <div class="web-pane" id="web-pane">
          <div class="tab-bar" id="tab-bar" style="display:none">
            <div class="tab-list" id="tab-list"></div>
            <button class="tab-add" id="tab-add" title="新建标签页（Ctrl+T）">＋</button>
          </div>
          <div class="tab-viewport" id="tab-viewport"><div class="pane-hint">新打开的页面将显示在这里</div></div>
        </div>
      </div>
    </div>`;

  // 无边框窗口拖动：topbar 按下即启动系统拖拽（按钮/输入/状态图标除外）
  document.querySelector(".topbar")!.addEventListener("mousedown", (ev) => {
    const t = ev.target as HTMLElement;
    if (t.closest("button, input, select, .poll-ico, .autohide-wrap, .mtab-wrap")) return;
    void win.startDragging();
  });

  document.getElementById("btn-hide")!.addEventListener("click", () => void win.hide());
  // 全屏/默认模式切换
  document.getElementById("btn-mode")!.addEventListener("click", () => {
    void setLayoutMode(layoutMode === "full" ? "mini" : "full");
  });
  // 折叠/恢复列表页（仅全屏三栏模式；切小窗时由 setLayoutMode 自动复位）
  document.getElementById("btn-collapse")!.addEventListener("click", () => {
    setListCollapsed(!listCollapsed);
  });
  // AI 问答：直接打开当前产品的 B/S 问答页
  document.getElementById("btn-ai")!.addEventListener("click", () => void openUrl(aiEntryUrl()));
  // 「多标签页」开关：关闭后只保留第一个标签，点击页面只更新该标签（持久化，仅 full 可见）
  document.getElementById("mtab-chk")!.addEventListener("change", (e) => {
    multiTab = (e.target as HTMLInputElement).checked;
    localStorage.setItem("aif_multi_tab", multiTab ? "1" : "0");
    // 关闭时收拢为单一标签：保留第一个，其余全部关闭
    if (!multiTab && tabs.length > 1) {
      const first = tabs[0];
      void api.tabCloseOthers(first.id).catch(() => {});
    }
  });
  // 「自动隐藏」开关：全屏模式下打开网页时自动隐藏列表页（持久化，仅 full 可见）
  document.getElementById("autohide-chk")!.addEventListener("change", (e) => {
    autoHide = (e.target as HTMLInputElement).checked;
    localStorage.setItem("aif_auto_hide", autoHide ? "1" : "0");
  });
  // 顶部当前入口展示 + 切换弹窗（仅全屏可见，openEntryDialog 内再拦一道）
  document.getElementById("btn-entry")!.addEventListener("click", () => void openEntryDialog());
  void updateEntryLabel();
  // 标签栏接线 + 初始渲染（每次 renderPanel 重建 DOM 后重绑，元素是新的不会重复监听）
  bindTabBar();
  renderTabBar();
  // 状态图标兼做刷新按钮：点击 = 重新拉取当前页数据 + 触发一次服务端新消息检查
  const pollIco = document.getElementById("poll-ico")!;
  pollIco.addEventListener("click", () => {
    pollIco.classList.add("spinning");
    switchTab(currentTab);
    api.checkNow();
    toast("正在刷新数据");
    setTimeout(() => pollIco.classList.remove("spinning"), 700);
  });
  // tab 切换：仅绑 data-tab 按钮（折叠按钮无 data-tab，走自己的 handler）
  document.querySelectorAll<HTMLButtonElement>(".nav-btn[data-tab]").forEach((t) =>
    t.addEventListener("click", () => switchTab(t.dataset.tab as typeof currentTab)),
  );
  void loadUserInfo();
  switchTab(currentTab);
  // 恢复已保存布局（full 模式会最大化窗口）
  applyLayoutMode();
  // [临时诊断] 布局偏移排查：renderPanel 后立刻记录几何（确认根因后可删除）
  dumpLayout("renderPanel");
}

function switchTab(tab: typeof currentTab) {
  // 产品切回一表通时不再有运维页
  if (tab === "ops" && !settings?.ops_product) tab = "messages";
  // 全屏模式下列表页已折叠时，切换任何 tab 前先自动展开（含按钮图标复位）
  if (layoutMode === "full" && listCollapsed) setListCollapsed(false);
  currentTab = tab;
  document.querySelectorAll(".nav-btn").forEach((t) => {
    const active = (t as HTMLElement).dataset.tab === tab;
    t.classList.toggle("active", active);
  });
  const content = document.getElementById("content")!;
  content.scrollTop = 0;
  // 「我的」页改纯白行式布局（参考引导页设计），内容区挂页面级背景类
  content.classList.toggle("page-profile", tab === "profile");
  if (tab === "messages") void refreshMessages();
  else if (tab === "todos") void refreshTodos();
  else if (tab === "ops") void renderOps(content);
  else if (tab === "docs") renderDocs(content);
  else if (tab === "spaces") renderSpaces(content);
  else if (tab === "quick") void renderQuick(content);
  else renderProfile(content);
}

// ---------------- 列表搜索框（移动端风格） ----------------
function searchBar(id: string, placeholder: string, value: string): string {
  return `
    <div class="search-bar">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input type="text" id="${id}" placeholder="${placeholder}" value="${esc(value)}" />
    </div>`;
}

// ---------------- 消息 Tab ----------------
let msgSearch = "";
// 类型筛选 chip（"" = 全部）；与搜索框叠加过滤，均为本地过滤
let msgTypeFilter = "";

// 分页加载状态：列表见底继续滚动时追加下一页（system/personal 各自推进）
const MSG_PAGE_SIZE = 20;
let msgState = {
  sysPage: 0,
  perPage: 0,
  items: [] as HistoryMessage[],
  loading: false,
  done: false,
};

// ---- 未读消息跟踪 + 底部导航数字角标 ----
// 未读 = 轮询收到但尚未在「消息」页浏览过的消息 id 集合（localStorage 持久化）
let unreadIds = new Set<string>(JSON.parse(localStorage.getItem("aif_unread_msg_ids") || "[]") as string[]);
let todoBadgeCount = 0; // 「我收到的」各行「待办」计数合计

function persistUnread() {
  localStorage.setItem("aif_unread_msg_ids", JSON.stringify([...unreadIds].slice(-300)));
}

function setTabBadge(tab: "messages" | "todos", n: number) {
  const el = document.getElementById(`badge-${tab}`);
  if (!el) return;
  const txt = n > 0 ? (n > 99 ? "99+" : String(n)) : "";
  if (el.textContent === txt) return;
  el.textContent = txt;
  // 数字变化时 pop 微动效（移除类 → 强制 reflow → 再加，重启动画）
  if (txt) {
    el.classList.remove("pop");
    void el.offsetWidth;
    el.classList.add("pop");
  }
}

/// 消息页已浏览：仅记录「最后浏览时间」供下次启动回溯种子。
/// 注意：不清空 unreadIds —— 未读只随「点击该条消息」逐条消除
/// （此前进页面即全部清空，导致切走再切回时所有未读变已读，是 bug）。
function markMessagesRead() {
  localStorage.setItem("aif_last_seen_ts", String(Date.now()));
}

/// 启动/登录时补种子：把「上次浏览消息页之后」的历史消息计入未读，
/// 覆盖应用关闭期间收到的消息。首次使用（无 last_seen）只建立基线，不回溯全部历史。
async function seedUnreadFromHistory() {
  const lastSeen = Number(localStorage.getItem("aif_last_seen_ts") || 0);
  if (!lastSeen) {
    localStorage.setItem("aif_last_seen_ts", String(Date.now()));
    return;
  }
  try {
    const [sys, per] = await Promise.all([
      api.getHistoryMessages("system", "", 0, 20),
      api.getHistoryMessages("personal", "", 0, 20),
    ]);
    const ts = (s: string) => new Date(s.replace(/-/g, "/")).getTime() || 0;
    let added = false;
    for (const m of [...sys, ...per]) {
      if (ts(m.time_str) > lastSeen && !unreadIds.has(m.id)) {
        unreadIds.add(m.id);
        added = true;
      }
    }
    if (added) persistUnread();
  } catch {
    /* 未登录/网络失败：忽略 */
  }
}

/// 后台统计角标：待办 = 「我收到的」各行的「待办」数字合计；消息 = 未读集合大小。
/// 不依赖当前所在 Tab（get_matters 独立于待办页渲染）。
async function refreshBadgeCounts() {
  try {
    const matters = await api.getMatters();
    todoBadgeCount = matters
      .filter((m) => m.category === "received")
      .reduce((s, m) => s + m.badges.filter((b) => b.label === "待办").reduce((x, b) => x + b.count, 0), 0);
  } catch {
    /* 未登录/网络失败：保持现值 */
  }
  setTabBadge("todos", todoBadgeCount);
  setTabBadge("messages", unreadIds.size);
}

// 消息类型映射（对齐 B/S getMessageType 的模块码归类）。
// 图标统一风格：彩色圆角方块 + 白色线性图形（与底部导航一致的扁平风）。
const MSG_TYPE_GLYPHS: Record<string, string> = {
  office: `<path d="M8 6h8M8 12h8M8 18h5" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1" fill="#fff"/><circle cx="4.5" cy="12" r="1" fill="#fff"/><circle cx="4.5" cy="18" r="1" fill="#fff"/>`,
  notice: `<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2.5h-15L6 16z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M10 20.5a2 2 0 0 0 4 0" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  meeting: `<rect x="3" y="7" width="12" height="10" rx="2.5" stroke="#fff" stroke-width="2" fill="none"/><path d="M15 10.5l6-3v9l-6-3" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>`,
  schedule: `<rect x="4" y="5" width="16" height="15" rx="2.5" stroke="#fff" stroke-width="2" fill="none"/><path d="M4 10h16M9 3v4M15 3v4" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  docs: `<path d="M7 3h7l4 4v14H7V3z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M14 3v4h4" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>`,
  share: `<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>`,
  task: `<path d="M5 12.5l4.5 4.5L19 7.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  job: `<circle cx="12" cy="12" r="3" stroke="#fff" stroke-width="2" fill="none"/><path d="M12 4v2.5M12 17.5V20M4 12h2.5M17.5 12H20M6.3 6.3l1.8 1.8M15.9 15.9l1.8 1.8M17.7 6.3l-1.8 1.8M8.1 15.9l-1.8 1.8" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  event: `<path d="M12 4.5l8.5 15h-17l8.5-15z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="M12 10.5v4M12 17h.01" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  ai: `<path d="M12 4l1.9 5.1L19 11l-5.1 1.9L12 18l-1.9-5.1L5 11l5.1-1.9L12 4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>`,
  survey: `<path d="M5.5 20v-8M12 20V5M18.5 20v-5.5" stroke="#fff" stroke-width="2.4" stroke-linecap="round" fill="none"/>`,
  edu: `<circle cx="12" cy="12" r="8.5" stroke="#fff" stroke-width="2" fill="none"/><path d="M12 11v5M12 7.8h.01" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  system: `<path d="M3.5 10v4h4l10.5 5V5l-10.5 5h-4z" stroke="#fff" stroke-width="2" stroke-linejoin="round" fill="none"/>`,
};

// 图标风格：微软消息头像风——白色图形改用 currentColor（由容器注入类型色），
// 消息行标题首使用实色类型圆角方块 + 白色图形，见 msgCardHtml / styles.css .msg-ico
for (const k of Object.keys(MSG_TYPE_GLYPHS)) {
  MSG_TYPE_GLYPHS[k] = MSG_TYPE_GLYPHS[k].replaceAll("#fff", "currentColor");
}

// 解析 "yyyy-MM-dd HH:mm:ss" 为易读的相对时间（刚刚/N分钟前/N小时前/N天前，超一周回退月-日）
function fmtRelTime(s: string): string {
  if (!s) return "";
  const d = new Date(s.replace(/-/g, "/"));
  if (isNaN(d.getTime())) return s;
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}个月前`;
  return `${Math.floor(days / 365)}年前`;
}

function msgTypeOf(mc: string): { label: string; color: string; glyph: string; hot: boolean } {
  const t = (mc || "").toUpperCase();
  const starts = (p: string) => t.startsWith(p);
  const has = (p: string) => t.indexOf(p) !== -1;
  // 顺序与 B/S getMessageType 保持一致；hot=重要/待办类消息，卡片右侧显示红点
  if (starts("COOPERATE") || has("COOPERATION-MONITOR"))
    return { label: "办公事项", color: "#3b82f6", glyph: MSG_TYPE_GLYPHS.office, hot: true };
  if (starts("ANNOUNCEMENT"))
    return { label: "通知助手", color: "#f59e0b", glyph: MSG_TYPE_GLYPHS.notice, hot: false };
  if (t === "SURVEY")
    return { label: "调查信息", color: "#db2777", glyph: MSG_TYPE_GLYPHS.survey, hot: false };
  if (t === "MEETING" || has("MEET"))
    return { label: "会议助手", color: "#8b5cf6", glyph: MSG_TYPE_GLYPHS.meeting, hot: false };
  if (t === "SCHEDULER")
    return { label: "日程", color: "#14b8a6", glyph: MSG_TYPE_GLYPHS.schedule, hot: false };
  if (t === "NETDISK")
    return { label: "资料共享", color: "#06b6d4", glyph: MSG_TYPE_GLYPHS.share, hot: false };
  if (t === "TASK" || t === "TIMEOUT_TASK")
    return { label: "任务", color: "#10b981", glyph: MSG_TYPE_GLYPHS.task, hot: true };
  if (has("KNOWLEDGE_") || t === "SPACE_COMMENT")
    return { label: "文档空间", color: "#6366f1", glyph: MSG_TYPE_GLYPHS.docs, hot: false };
  if (t === "AUTOOPS_NOTICE")
    return { label: "作业管理", color: "#f97316", glyph: MSG_TYPE_GLYPHS.job, hot: true };
  if (starts("EVENT_CENTER"))
    return { label: "事件中心", color: "#f43f5e", glyph: MSG_TYPE_GLYPHS.event, hot: true };
  if (t === "AI_CHAT_QA_SHARE")
    return { label: "AI问答分享", color: "#7c3aed", glyph: MSG_TYPE_GLYPHS.ai, hot: false };
  // 校园服务类：实习/假条/德育/课表/失物招领/互助/预约/考试/迎新/资源/安全目标
  if (["SHIXI", "JIATIAO", "CREDIT", "TMKAOQIN", "LOSTFOUND", "INFORMATIONAUDIT", "SERVICEHALL", "ZAIXIANXUEXI", "ENROLLMENT", "RES", "SECURITY_TARGET"].some((p) => has(p)))
    return { label: "校园服务", color: "#84cc16", glyph: MSG_TYPE_GLYPHS.edu, hot: false };
  return { label: "系统消息", color: "#64748b", glyph: MSG_TYPE_GLYPHS.system, hot: false };
}

// 数据源：B/S 真实历史消息接口 POST /AIF/getMessageList（source=system|personal）。
// 两类消息并行拉取后按时间倒序合并展示；接口失败时回退本地轮询存档。
/** 静默合并最新一页消息（轮询刷新用）：不重建页面、不重置已加载分页、保留滚动位置。
 *  消息倒序（新的在前），重拉第 0 页 merge 去重后新消息自然插入列表顶部。 */
async function mergeLatestMessages() {
  if (msgState.loading) return;
  msgState.loading = true;
  try {
    const [sys, per] = await Promise.all([
      api.getHistoryMessages("system", "", 0, MSG_PAGE_SIZE),
      api.getHistoryMessages("personal", "", 0, MSG_PAGE_SIZE),
    ]);
    const seen = new Set(msgState.items.map((m) => m.id));
    let added = false;
    for (const m of [...sys, ...per]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        msgState.items.push(m);
        added = true;
      }
    }
    if (added) {
      const content = document.getElementById("content");
      const st = content?.scrollTop ?? 0;
      renderMessageList(false);
      // 正在浏览消息页 → 已阅，清空未读角标
      markMessagesRead();
      if (content) content.scrollTop = st;
    }
  } catch {
    /* 静默失败：保持现状，下轮轮询再试 */
  }
  msgState.loading = false;
}

async function refreshMessages(silent = false) {
  if (currentTab !== "messages") return;
  // 轮询触发的刷新：静默合并新数据，页面结构/分页/滚动位置全部保留
  if (silent) {
    await mergeLatestMessages();
    return;
  }
  const content = document.getElementById("content");
  if (!content) return;
  content.innerHTML =
    searchBar("search-msg", "搜索历史消息", msgSearch) +
    `<div class="type-chips" id="type-chips"></div>` +
    `<div class="list msg-list" id="list"></div><div class="list-foot" id="list-foot"></div>`;
  document.getElementById("search-msg")!.addEventListener("input", debounce((e: Event) => {
    msgSearch = (e.target as HTMLInputElement).value.trim();
    void fetchMessagePage(true);
  }, 350));
  // 滚动到接近底部 → 追加下一页（#content 元素不随 innerHTML 重建，dataset 防重复绑定）
  if (!content.dataset.msgScroll) {
    content.dataset.msgScroll = "1";
    content.addEventListener("scroll", () => {
      if (content.scrollTop + content.clientHeight >= content.scrollHeight - 80) {
        void fetchMessagePage(false);
      }
    });
  }
  await fetchMessagePage(true);
}

/// 拉取一页消息（reset=true 时从头开始；否则在已有列表后追加下一页）
async function fetchMessagePage(reset: boolean) {
  const list = document.getElementById("list");
  const foot = document.getElementById("list-foot");
  if (!list || currentTab !== "messages") return;
  if (msgState.loading) return;
  if (reset) {
    msgState = { sysPage: 0, perPage: 0, items: [], loading: false, done: false };
  } else if (msgState.done) {
    return;
  }
  msgState.loading = true;
  if (foot) foot.textContent = msgState.items.length ? "加载中…" : "";
  if (!msgState.items.length) list.innerHTML = skels();

  let failed = false;
  try {
    // 搜索不走服务端 key（仅匹配标题），改为全量分页拉取后本地过滤标题+正文
    const [sys, per] = await Promise.all([
      api.getHistoryMessages("system", "", msgState.sysPage, MSG_PAGE_SIZE),
      api.getHistoryMessages("personal", "", msgState.perPage, MSG_PAGE_SIZE),
    ]);
    // 返回满页才推进该来源的页码；未满页来源下轮重复拉同一页（按 id 去重，无副作用）
    if (sys.length >= MSG_PAGE_SIZE) msgState.sysPage++;
    if (per.length >= MSG_PAGE_SIZE) msgState.perPage++;
    if (sys.length < MSG_PAGE_SIZE && per.length < MSG_PAGE_SIZE) msgState.done = true;
    const seen = new Set(msgState.items.map((m) => m.id));
    for (const m of [...sys, ...per]) {
      if (!seen.has(m.id)) {
        seen.add(m.id);
        msgState.items.push(m);
      }
    }
  } catch {
    failed = true;
  }
  msgState.loading = false;
  renderMessageList(failed);
  // 正在浏览消息页 → 本次已阅，清空未读角标
  if (!failed && currentTab === "messages") markMessagesRead();
}

/// 渲染消息列表（分页追加后整体重排；接口失败回退本地存档）
function renderMessageList(failed: boolean) {
  const list = document.getElementById("list");
  const foot = document.getElementById("list-foot");
  if (!list || currentTab !== "messages") return;

  // 接口失败（未登录/网络问题）→ 回退本地轮询存档
  if (failed) {
    if (foot) foot.textContent = "";
    void renderLocalMessages(list);
    return;
  }

  const items = [...msgState.items];
  // "yyyy-MM-dd HH:mm:ss" → 可比较的时间戳（倒序排列用）
  const ts = (s: string) => new Date(s.replace(/-/g, "/")).getTime() || 0;
  items.sort((a, b) => ts(b.time_str) - ts(a.time_str));
  renderTypeChips(items);
  // 搜索：标题或正文命中即显示（服务端 key 只搜标题，正文过滤在本地做）
  const kw = msgSearch.toLowerCase();
  let shown = kw
    ? items.filter((m) => m.title.toLowerCase().includes(kw) || m.body.toLowerCase().includes(kw))
    : items;
  // 类型筛选 chip（本地过滤）
  if (msgTypeFilter) shown = shown.filter((m) => msgTypeOf(m.mc).label === msgTypeFilter);

  if (!shown.length) {
    list.innerHTML = `<div class="empty">${kw || msgTypeFilter ? (items.length ? "没有匹配的消息<br/><span class=\"hint\">可调整筛选条件或下拉加载更早的消息</span>" : "没有匹配的消息") : "暂无历史消息"}<br/>${kw || msgTypeFilter ? "" : '<span class="hint">新消息到达时会自动提醒</span>'}</div>`;
  } else {
    // 时间分组：按「今天 / 昨天 / 本周 / 更早」插入分组头（列表已按时间倒序）
    let html = "";
    let lastGroup = "";
    for (const m of shown) {
      const g = timeGroupKey(m.time_str);
      if (g !== lastGroup) {
        html += `<div class="group-head band">${g}</div>`;
        lastGroup = g;
      }
      html += msgCardHtml(m);
    }
    list.innerHTML = html;
    bindMessageItems(list);
  }
  if (foot) {
    foot.textContent = msgState.done
      ? items.length
        ? kw && shown.length
          ? "已加载全部消息"
          : "没有更多了"
        : ""
      : msgState.items.length
        ? "加载中…"
        : "";
  }
}

/// 「今天 / 昨天 / 本周 / 更早」分组 key（解析 yyyy-MM-dd HH:mm:ss）
function timeGroupKey(s: string): string {
  if (!s) return "更早";
  const d = new Date(s.replace(/-/g, "/"));
  if (isNaN(d.getTime())) return "更早";
  const now = new Date();
  const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = d.getTime();
  if (t >= day0) return "今天";
  if (t >= day0 - 86400000) return "昨天";
  if (t >= day0 - 6 * 86400000) return "本周";
  return "更早";
}

/// 类型筛选 chips（按已加载消息的类型计数取前 4 类 + 全部；本地过滤不重新请求）
function renderTypeChips(items: HistoryMessage[]) {
  const box = document.getElementById("type-chips");
  if (!box) return;
  const counts = new Map<string, number>();
  for (const m of items) {
    const lb = msgTypeOf(m.mc).label;
    counts.set(lb, (counts.get(lb) || 0) + 1);
  }
  const tops = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const chips: [string, string][] = [["", `全部 ${items.length}`], ...tops.map(([l]) => [l, l] as [string, string])];
  box.innerHTML = chips
    .map(([k, l]) => `<button class="type-chip${msgTypeFilter === k ? " active" : ""}" data-type="${esc(k)}">${esc(l)}</button>`)
    .join("");
  box.querySelectorAll(".type-chip").forEach((c) =>
    c.addEventListener("click", () => {
      msgTypeFilter = (c as HTMLElement).dataset.type || "";
      renderMessageList(false);
    }),
  );
}

/// 类别胶囊均衡换行：≤3 字单行；4 字 2+2；其余按每行 3 字切分（末行承接余数）
function catWrap(label: string): string {
  if (label.length <= 3) return esc(label);
  const size = label.length === 4 ? 2 : 3;
  const parts: string[] = [];
  for (let i = 0; i < label.length; i += size) parts.push(esc(label.slice(i, i + size)));
  return parts.join("<br/>");
}

/// 单条消息行（参考页行式风：左列相对时间 + 类别色胶囊，标题粗体 + 完整正文，无卡片容器）
function msgCardHtml(m: HistoryMessage): string {
  const ty = msgTypeOf(m.mc);
  // 标题/正文去重：正文与标题相同或互为前缀（B/S 常见「标题=正文开头」）时不再重复展示
  const t = m.title.trim();
  const b = m.body.trim();
  const showBody = b && b !== t && !t.startsWith(b) && !b.startsWith(t);
  // 正文以发送人名开头时隐藏发送人行（同一信息不重复出现）
  const showSender = m.sender && !b.startsWith(m.sender.trim());
  const unread = unreadIds.has(m.id);
  return `
      <div class="msg-row${unread ? " unread" : ""}" data-id="${esc(m.id)}" data-url="${esc(m.url)}" title="${esc([m.title, m.sender, m.time_str].filter(Boolean).join("　"))}">
        <div class="msg-when">
          <div class="msg-hm">${esc(fmtRelTime(m.time_str))}</div>
          <div class="msg-cat" style="color:${ty.color};background:${ty.color}14" title="${esc(ty.label)}">${catWrap(ty.label)}</div>
        </div>
        <div class="msg-main">
          <div class="li-title">${unread ? '<span class="msg-unread-dot" title="未读"></span>' : ""}<span class="msg-ico" style="background:${ty.color}" title="${esc(ty.label)}"><svg viewBox="0 0 24 24">${ty.glyph}</svg></span><span class="msg-title-text">${esc(m.title)}</span></div>
          ${showBody ? `<div class="li-sub">${esc(b)}</div>` : ""}
          ${showSender ? `<div class="msg-sender">${esc(m.sender)}</div>` : ""}
        </div>
        <span class="arrow">›</span>
      </div>`;
}

/// 本地存档回退（接口不可用时）
async function renderLocalMessages(list: HTMLElement) {
  let local: MessageRow[] = [];
  try {
    local = await api.getMessages();
  } catch {
    /* 忽略 */
  }
  if (currentTab !== "messages") return;
  const kw = msgSearch.toLowerCase();
  const hit = local.filter(
    (m) => !kw || m.title.toLowerCase().includes(kw) || m.body.toLowerCase().includes(kw),
  );
  if (!hit.length) {
    list.innerHTML = `<div class="empty">${kw ? "没有匹配的消息" : "无法获取历史消息，请先登录"}</div>`;
    return;
  }
  list.innerHTML =
    `<div class="list-note">接口不可用，以下为本地暂存消息</div>` +
    hit
      .map(
        (m) => `
          <div class="list-item" data-url="${esc(m.url)}">
            <div class="ico msg-b">✉</div>
            <div class="li-main">
              <div class="li-title">${esc(m.title)}</div>
              <div class="li-sub">${esc(m.body)}</div>
            </div>
            <div class="li-time">${fmtTime(m.received_at)}</div>
          </div>`,
      )
      .join("");
  bindMessageItems(list);
}

function bindMessageItems(root: HTMLElement) {
  root.querySelectorAll("[data-url]").forEach((item) =>
    item.addEventListener("click", () => {
      // 点击未读消息 → 该条立即转已读：本地集合、角标、行内未读样式三处同步
      const id = (item as HTMLElement).dataset.id;
      if (id && unreadIds.has(id)) {
        unreadIds.delete(id);
        persistUnread();
        setTabBadge("messages", unreadIds.size);
        item.classList.remove("unread");
        item.querySelector(".msg-unread-dot")?.remove();
      }
      const url = (item as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

// ---------------- 待办 Tab（我的事项：我收到的 / 我发出的填报 / 我发出的流程） ----------------
let todoSearch = "";
let matterSection: "received" | "filling" | "flow" = "received";
let mattersCache: MatterRow[] = [];
/** 统计卡筛选：点击待办/已办/抄送卡 → 只看对应计数 > 0 的事项；空串 = 不筛选 */
let statFilter: "red" | "green" | "blue" | "" = "";
const STAT_TONE_LABEL: Record<string, string> = { red: "待办", green: "已办", blue: "抄送" };

/** 去掉事项标签的包装括号：【流程】/[流程]/（公告）→ 流程/公告 */
const stripTag = (t: string): string => t.replace(/[【\[(（】\])）]/g, "").trim() || t;

const MATTER_SECTIONS: { key: "received" | "filling" | "flow"; label: string }[] = [
  { key: "received", label: "我收到的" },
  { key: "filling", label: "我发出的填报" },
  { key: "flow", label: "我发出的流程" },
];

/** 事项类型标签配色（流程审批=蓝 / 智能填报=绿，其余蓝） */
function matterTagColor(tag: string): string {
  if (tag.includes("填报")) return "#16a34a";
  return "#2b7fff";
}

/** 计数徽章：>99 显示 99+；色调对齐 B/S（红=待办类 绿=已办类 蓝=抄送类 灰=未开始）。
 *  有 url 的数字可点击（stopPropagation），跳转对应统计页——待办→待办页、已办→已办页 */
function badgeHtml(b: MatterBadge): string {
  const n = b.count > 99 ? "99+" : String(b.count);
  const badge = `<span class="mt-badge tone-${b.tone}">${n}</span>`;
  if (!b.url) return `<span title="${esc(b.label)} ${b.count}">${badge}</span>`;
  return `<a class="mt-badge-link" data-url="${esc(b.url)}" title="打开${esc(b.label)}页（${b.count}）">${badge}</a>`;
}

async function refreshTodos(silent = false) {
  if (currentTab !== "todos") return;
  const content = document.getElementById("content");
  if (!content) return;
  // 轮询触发的刷新：静默重拉数据重绘列表，页面结构/筛选/滚动位置全部保留
  if (silent) {
    try {
      mattersCache = await api.getMatters();
    } catch {
      return; // 静默失败：保持现状
    }
    const st = content.scrollTop;
    renderTodoSummary();
    renderMatterList();
    content.scrollTop = st;
    return;
  }
  // 与消息页同构：搜索栏置顶（sticky）+ 分类 chips（type-chip 统一样式）+ 统计卡 + 列表
  content.innerHTML =
    searchBar("search-todo", "搜索标题 / 类型", todoSearch) +
    `<div class="type-chips">${MATTER_SECTIONS.map(
      (s) => `<button class="type-chip${s.key === matterSection ? " active" : ""}" data-sec="${s.key}">${s.label}</button>`,
    ).join("")}</div>` +
    `<div class="mt-summary" id="mt-summary"></div>` +
    `<div class="list" id="list">${skels()}</div>`;
  document.querySelectorAll("#content .type-chip").forEach((b) =>
    b.addEventListener("click", () => {
      matterSection = (b as HTMLElement).dataset.sec as typeof matterSection;
      document.querySelectorAll("#content .type-chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      renderMatterList();
    }),
  );
  document.getElementById("search-todo")!.addEventListener("input", debounce((e: Event) => {
    todoSearch = (e.target as HTMLInputElement).value.trim();
    renderMatterList();
  }, 300));
  await fetchMatterList();
}

async function fetchMatterList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "todos") return;
  list.innerHTML = skels();
  try {
    mattersCache = await api.getMatters();
  } catch {
    mattersCache = [];
    const ms = document.getElementById("mt-summary");
    if (ms) ms.innerHTML = "";
    // 接口失败 → 回退本地轮询存档的待办
    let todos: TodoRow[] = [];
    try {
      todos = await api.getTodos();
    } catch {
      /* 忽略 */
    }
    if (currentTab !== "todos") return;
    const kw = todoSearch.toLowerCase();
    const hit = todos.filter((t) => !kw || t.title.toLowerCase().includes(kw));
    if (!hit.length) {
      list.innerHTML = `<div class="empty">${kw ? "没有匹配的待办" : "无法获取事项，请先登录"}</div>`;
      return;
    }
    list.innerHTML =
      `<div class="list-note">接口不可用，以下为本地暂存待办</div>` +
      hit
        .map(
          (t) => `
          <div class="list-item card">
            <div class="ico todo-b">☑</div>
            <div class="li-main">
              <div class="li-title">${esc(t.title)}</div>
            </div>
            ${t.url ? `<button class="open-btn" data-id="${esc(t.id)}">打开</button>` : ""}
          </div>`,
        )
        .join("");
    list.querySelectorAll(".open-btn").forEach((b) =>
      b.addEventListener("click", () => {
        const todo = todos.find((x) => x.id === (b as HTMLElement).dataset.id);
        if (todo?.url) void openUrl(todo.url);
      }),
    );
    return;
  }
  if (currentTab !== "todos") return;
  renderMatterList();
}

/** 顶部统计摘要条：待办/已办/抄送三格彩色数字卡，可点击筛选对应计数 > 0 的事项（再点取消） */
function renderTodoSummary() {
  const el = document.getElementById("mt-summary");
  if (!el) return;
  // 只统计「我收到的」（红色 tone 在 filling/flow 里是「进行中」，混入会与导航角标口径不一致：
  // 角标 = received 的 label==="待办" 之和，统计卡应同为 received 的待办数）
  const sum = (tone: string) =>
    mattersCache
      .filter((m) => m.category === "received")
      .reduce((n, m) => n + m.badges.filter((b) => b.tone === tone).reduce((x, b) => x + b.count, 0), 0);
  const tones: ("red" | "green" | "blue")[] = ["red", "green", "blue"];
  el.innerHTML = tones
    .map(
      (tone) =>
        `<button class="mt-stat ${tone}${statFilter === tone ? " active" : ""}" data-tone="${tone}" title="点击${
          statFilter === tone ? "取消筛选" : "只看"
        }${STAT_TONE_LABEL[tone]}计数不为 0 的事项"><div class="n">${sum(tone)}</div><div class="t">${STAT_TONE_LABEL[tone]}</div></button>`,
    )
    .join("");
  el.querySelectorAll(".mt-stat").forEach((b) =>
    b.addEventListener("click", () => {
      const tone = (b as HTMLElement).dataset.tone as typeof statFilter;
      statFilter = statFilter === tone ? "" : tone;
      // 重渲染摘要（高亮态）+ 列表（筛选生效）
      renderMatterList();
    }),
  );
}

function renderMatterList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "todos") return;
  renderTodoSummary();
  const kw = todoSearch.toLowerCase();
  const items = mattersCache.filter(
    (m) =>
      m.category === matterSection &&
      // 统计卡筛选：对应色调计数 > 0 的事项才显示
      (!statFilter || m.badges.some((b) => b.tone === statFilter && b.count > 0)) &&
      (!kw || m.title.toLowerCase().includes(kw) || m.tag.toLowerCase().includes(kw)),
  );
  if (!items.length) {
    list.innerHTML = `<div class="empty">${
      kw ? "没有匹配的事项" : statFilter ? `当前分类下没有${STAT_TONE_LABEL[statFilter]}计数不为 0 的事项` : "暂无事项"
    }<br/><span class="hint">${
      MATTER_SECTIONS.find((s) => s.key === matterSection)?.label || ""
    }显示在这里</span></div>`;
    return;
  }
  list.innerHTML = items
    .map((m) => {
      const c = matterTagColor(m.tag);
      // 含待办（红色计数 > 0）的行：左侧红色竖条强化扫读
      const hot = m.badges.some((b) => b.tone === "red" && b.count > 0);
      return `
      <div class="list-item card matter-row${hot ? " mt-hot" : ""}" data-url="${esc(m.url)}">
        <div class="mt-main">
          <div class="mt-line1">
            <span class="mt-tag" style="color:${c};background:${c}14;border:1px solid ${c}33">${esc(stripTag(m.tag))}</span>
            <span class="mt-title">${esc(m.title)}</span>
            <span class="mt-badges">${m.badges.map(badgeHtml).join("")}</span>
          </div>
          <div class="mt-line2">
            <span class="mt-time" title="${esc(m.time_str)}">${esc(fmtRelTime(m.time_str))}</span>
          </div>
        </div>
        <span class="arrow">›</span>
      </div>`;
    })
    .join("");
  // 统计数字点击 → 打开对应统计页（不触发整行跳转）
  list.querySelectorAll(".mt-badge-link").forEach((a) =>
    a.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const url = (a as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
  list.querySelectorAll(".list-item").forEach((item) =>
    item.addEventListener("click", () => {
      const url = (item as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

// ---------------- 文档 Tab（空间文档：最近访问 / 我的收藏 / 公共文档） ----------------
const DOC_SECTIONS: { key: string; label: string }[] = [
  { key: "recent", label: "最近访问" },
  { key: "starred", label: "我的收藏" },
  { key: "public", label: "公共文档" },
];
let docSection = "recent";
// 搜索关键字（本地过滤标题/空间/作者）；拉取结果缓存，输入时不重新请求
let docSearch = "";
let docsCache: DocRow[] = [];

// ---------------- 运维 Tab（仅 AIF 产品）：应用中心 ----------------
let opsCache: OpsAppGroup[] | null = null;
let opsSearch = "";                     // 搜索关键字（应用 / 管理员 / 单位）
let opsAlertOnly = false;               // 只看告警应用（摘要「告警」卡点击切换）
let opsGroup = "";                      // 分组筛选（"" = 全部）
const opsCollapsed = new Set<string>(); // 已折叠分组 id

async function renderOps(content: HTMLElement) {
  // 与消息/待办页同构：搜索栏置顶（sticky），下方列表区独立重渲染（保输入焦点）
  content.innerHTML =
    searchBar("search-ops", "搜索应用 / 管理员 / 单位", opsSearch) +
    `<div id="ops-body">${opsCache ? "" : skels(3)}</div>`;
  document.getElementById("search-ops")!.addEventListener("input", debounce((e: Event) => {
    opsSearch = (e.target as HTMLInputElement).value.trim();
    const b = document.getElementById("ops-body");
    if (b && opsCache) renderOpsList(b, opsCache, opsSearch);
  }, 250));
  const body = document.getElementById("ops-body");
  if (!body) return;
  // 有缓存先渲染，再静默刷新
  if (opsCache) renderOpsList(body, opsCache, opsSearch);
  try {
    const groups = await api.getOpsApps();
    opsCache = groups;
    renderOpsList(body, groups, opsSearch);
  } catch (e) {
    body.innerHTML = `<div class="empty">加载失败：${esc(String(e).replace(/^"|"$/g, ""))}<br/><span class="hint">请确认已登录运维（AIF）系统后重试</span></div>`;
  }
}

function renderOpsList(el: HTMLElement, groups: OpsAppGroup[], kw: string) {
  const k = kw.trim().toLowerCase();
  const hit = (name: string, leader: string, unit: string) =>
    !k || name.toLowerCase().includes(k) || leader.toLowerCase().includes(k) || unit.toLowerCase().includes(k);
  const total = groups.reduce((n, g) => n + g.apps.length, 0);
  const alertCount = groups.reduce((n, g) => n + g.apps.filter((a) => a.status === "alert").length, 0);
  const okCount = total - alertCount;
  // 每种应用类型分配一个主题色（彩色胶囊配色，循环使用调色板）
  const PALETTE = ["#3b82f6", "#14b8a6", "#8b5cf6", "#f59e0b", "#10b981", "#f43f5e", "#06b6d4", "#f97316"];
  const visGroups = opsGroup ? groups.filter((g) => g.id === opsGroup) : groups;

  // 摘要统计卡 + 健康度条（搜索时隐藏，聚焦结果视图；告警卡可点击筛选）
  const summary = k
    ? ""
    : `<div class="mt-summary ops-stats">
        <div class="mt-stat"><div class="n">${total}</div><div class="t">应用</div></div>
        <div class="mt-stat green"><div class="n">${okCount}</div><div class="t">正常</div></div>
        <button class="mt-stat red clickable${opsAlertOnly ? " active" : ""}" id="ops-alert-filter" title="${opsAlertOnly ? "点击取消筛选" : "点击只看告警应用"}"><div class="n">${alertCount}</div><div class="t">告警</div></button>
      </div>
      ${total ? `<div class="ops-health" title="健康度：${okCount}/${total} 正常"><div style="width:${Math.round((okCount / total) * 100)}%"></div></div>` : ""}`;

  // 分组导航 chips + 刷新按钮（chips 仅多组时显示；样式与待办/消息页 type-chip 统一）
  const toolbar = `<div class="type-chips ops-chips">
    ${groups.length > 1 ? `<button class="type-chip${opsGroup === "" ? " active" : ""}" data-gid="">全部 ${total}</button>${groups
      .map((g) => `<button class="type-chip${opsGroup === g.id ? " active" : ""}" data-gid="${esc(g.id)}">${esc(g.name)} ${g.apps.length}</button>`)
      .join("")}` : ""}
    <span class="tb-spacer"></span>
    <button class="icon-btn" id="ops-refresh" title="刷新应用列表">⟳</button>
  </div>`;

  const rowHtml = (gcolor: string, a: OpsApp) => {
    const alert = a.status === "alert";
    const fb = `color:${gcolor};background:${gcolor}1f`; // 字母 fallback：组色淡底 + 同色字
    return `
      <div class="list-item card ops-row${alert ? " ops-hot" : ""}" data-url="${esc(a.url)}" title="点击打开：${esc(a.name)}">
        <div class="ico app-ico">${a.icon ? `<img src="${esc(a.icon)}" alt="" /><span class="app-ico-fallback" style="display:none;${fb}">${esc(a.name.slice(0, 1))}</span>` : `<span class="app-ico-fallback" style="${fb}">${esc(a.name.slice(0, 1))}</span>`}</div>
        <div class="li-main">
          <div class="li-title">${esc(a.name)}</div>
          <div class="li-meta">管理员：${esc(a.leader || "—")}${a.unit ? ` · ${esc(a.unit)}` : ""}</div>
          ${alert && a.event ? `<div class="li-meta ops-event" title="${esc(a.event)}">${esc(a.event)}</div>` : ""}
        </div>
        <span class="ops-state ${a.status}" title="${alert ? esc(a.event || "告警") : "正常运行"}">${alert ? "告警" : "正常"}</span>
        <span class="arrow">›</span>
      </div>`;
  };

  const listHtml =
    visGroups
      .map((g) => {
        const c = PALETTE[groups.indexOf(g) % PALETTE.length];
        let apps = g.apps.filter((a) => hit(a.name, a.leader, a.unit) && (!opsAlertOnly || a.status === "alert"));
        if (!apps.length) return "";
        // 告警应用排组内最前（稳定排序，正常项相对次序不变）
        apps = [...apps].sort((a, b) => Number(b.status === "alert") - Number(a.status === "alert"));
        const collapsed = opsCollapsed.has(g.id);
        return `
      <div class="ops-group">
        <div class="ops-group-title clickable" data-gid="${esc(g.id)}" title="点击${collapsed ? "展开" : "折叠"}「${esc(g.name)}」"><span class="ops-fold${collapsed ? " folded" : ""}">▾</span><span>${esc(g.name)}</span><span class="ops-type-pill" style="color:${c};background:${c}14;border:1px solid ${c}33" title="${esc(g.name)} 共 ${g.apps.length} 个">${g.apps.length}</span></div>
        ${collapsed ? "" : apps.map((a) => rowHtml(c, a)).join("")}
      </div>`;
      })
      .join("") || `<div class="empty">${opsAlertOnly ? "没有告警应用" : k ? "没有匹配的应用" : "暂无应用"}</div>`;

  el.innerHTML = summary + toolbar + listHtml;
  // 应用图标加载失败 → 组色首字母兜底（内联 onerror 被 CSP 拦截，必须用监听器）
  el.querySelectorAll<HTMLImageElement>(".app-ico img").forEach((img) =>
    img.addEventListener("error", () => {
      img.style.display = "none";
      const fb = img.nextElementSibling as HTMLElement | null;
      if (fb) fb.style.display = "flex";
    }),
  );

  // 「告警」统计卡：切换只看告警应用
  document.getElementById("ops-alert-filter")?.addEventListener("click", () => {
    opsAlertOnly = !opsAlertOnly;
    if (opsCache) renderOpsList(el, opsCache, opsSearch);
  });
  // 分组导航 chips
  el.querySelectorAll(".ops-chips .type-chip").forEach((b) =>
    b.addEventListener("click", () => {
      opsGroup = (b as HTMLElement).dataset.gid || "";
      if (opsCache) renderOpsList(el, opsCache, opsSearch);
    }),
  );
  // 组标题点击折叠/展开
  el.querySelectorAll(".ops-group-title.clickable").forEach((t) =>
    t.addEventListener("click", () => {
      const gid = (t as HTMLElement).dataset.gid || "";
      if (opsCollapsed.has(gid)) opsCollapsed.delete(gid);
      else opsCollapsed.add(gid);
      if (opsCache) renderOpsList(el, opsCache, opsSearch);
    }),
  );
  // 刷新应用列表：重建骨架屏并重新拉取（renderOps 自带缓存渲染+静默刷新）
  document.getElementById("ops-refresh")?.addEventListener("click", () => {
    const content = el.closest(".content");
    if (content) void renderOps(content as HTMLElement);
  });
  // 点击系统卡片 → 在客户端 webview 中打开（受控窗口，B/S 域内免登录）
  el.querySelectorAll(".ops-row").forEach((c) =>
    c.addEventListener("click", () => {
      const url = (c as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

function renderDocs(content: HTMLElement) {
  content.innerHTML =
    searchBar("search-doc", "搜索标题 / 空间 / 作者", docSearch) +
    `
    <div class="type-chips" id="doc-tabs">
      ${DOC_SECTIONS.map((s) => `<button class="type-chip${s.key === docSection ? " active" : ""}" data-sec="${s.key}">${s.label}</button>`).join("")}
    </div>
    <div class="list" id="list">${skels()}</div>`;
  document.getElementById("search-doc")!.addEventListener("input", debounce((e: Event) => {
    docSearch = (e.target as HTMLInputElement).value.trim();
    renderDocList();
  }, 300));
  content.querySelectorAll("#doc-tabs .type-chip").forEach((b) =>
    b.addEventListener("click", () => {
      docSection = (b as HTMLElement).dataset.sec!;
      content.querySelectorAll("#doc-tabs .type-chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      void loadDocList();
    }),
  );
  void loadDocList();
}

/// 文档分类 key → 后端 category
const DOC_CAT: Record<string, string> = { recent: "browse", starred: "collect", public: "hot" };

/** 标准文档图标集：扩展名 → 图标族与主色（对齐微软 Office / Adobe 惯例配色） */
const DOC_TYPE_COLORS: [string[], string][] = [
  [["zip", "rar", "7z", "tar", "gz", "bz2"], "#6d28d9"], // 压缩深紫
  [["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "psd"], "#0e7490"], // 图片深青
  [["mp4", "avi", "mov", "mkv", "wmv", "flv", "webm"], "#7e22ce"], // 视频深紫
  [["mp3", "wav", "flac", "aac", "m4a"], "#b45309"], // 音频深橙
  [["txt", "log", "md", "text"], "#334155"], // 文本深灰蓝
  [["html", "htm", "url"], "#0369a1"], // 网页深蓝
];

type DocIconKind = "word" | "excel" | "ppt" | "pdf" | "generic";

/** 在线文档类型官方中文名（对齐 B/S dksel.js articleTypeNameEnum） */
const DOC_ATYPE_NAMES: Record<string, string> = {
  DOC: "电子文档",
  MARKDOWN: "MD文档",
  EXCEL: "智能表格",
  FILE: "文件",
  RICHTEXT: "文本文档",
};

function docTypeStyle(d: DocRow): { kind: DocIconKind; color: string; label: string } {
  const ft = (d.file_type || "").toLowerCase();
  const has = (exts: string[]) => exts.includes(ft);
  // 在线文档（无附件后缀）：atype 按官方枚举细分
  // DOC=电子文档(Word) / MARKDOWN=MD文档 / EXCEL=智能表格(Excel) / RICHTEXT=文本文档 / FILE=附件文件
  if (!ft) {
    if (d.atype === "EXCEL" || d.atype === "COLLEXCEL") return { kind: "excel", color: "#107c41", label: "XLS" };
    if (d.atype === "MARKDOWN") return { kind: "generic", color: "#475569", label: "MD" };
    if (d.atype === "RICHTEXT") return { kind: "generic", color: "#0369a1", label: "TXT" };
    return { kind: "word", color: "#185abd", label: "DOC" };
  }
  if (has(["doc", "docx", "wps", "docm", "rtf"])) return { kind: "word", color: "#185abd", label: "DOC" }; // Word 官方蓝
  if (has(["xls", "xlsx", "csv", "xlsm", "et"])) return { kind: "excel", color: "#107c41", label: "XLS" }; // Excel 官方绿
  if (has(["ppt", "pptx", "pps", "ppsx", "dps"])) return { kind: "ppt", color: "#c43e1c", label: "PPT" }; // PPT 官方橙红
  if (has(["pdf"])) return { kind: "pdf", color: "#b30b00", label: "PDF" }; // Adobe 深红
  const color = DOC_TYPE_COLORS.find((exts) => exts[0].includes(ft))?.[1] || "#4f46e5";
  const alias: Record<string, string> = { jpeg: "JPG", markdown: "MD" };
  const label = alias[ft] || ft.slice(0, 4).toUpperCase();
  return { kind: "generic", color, label };
}

/** 彩色文件底形（右上折角，整体填充类型色），各类型在其上叠加白色标识 */
function fileBase(color: string): string {
  return `
  <path d="M6.2 2.5h7.6l4.7 4.7V20a1.5 1.5 0 0 1-1.5 1.5H6.2A1.5 1.5 0 0 1 4.7 20V4a1.5 1.5 0 0 1 1.5-1.5z" fill="${color}" stroke="${color}" stroke-width="0.8"/>
  <path d="M13.8 2.5l4.7 4.7h-3.7a1 1 0 0 1-1-1z" fill="#fff" opacity="0.38"/>
  <path d="M8.6 5.4h4.2M8.6 7.6h5.6" stroke="#fff" opacity="0.55" stroke-width="1" stroke-linecap="round"/>`;
}

/** 彩色文件 + 左下白色圆角方块内类型色大写字母（Word=W / Excel=X / PPT=P） */
function officeGlyph(letter: string, color: string): string {
  return `
    ${fileBase(color)}
    <rect x="4" y="11" width="10" height="10" rx="1.8" fill="#fff"/>
    <text x="9" y="18.6" text-anchor="middle" font-size="7.6" font-weight="700" font-family="'Segoe UI', Arial, sans-serif" fill="${color}">${letter}</text>`;
}

/** Adobe Reader 风格：红色圆角方块 + 白色空心三角（Acrobat 回旋标） */
function pdfGlyph(color: string): string {
  return `
    <rect x="3" y="2" width="18" height="20" rx="3.2" fill="${color}"/>
    <path d="M12 6.6l5.4 10.2H6.6z" fill="none" stroke="#fff" stroke-width="2.1" stroke-linejoin="round"/>`;
}

/** 其他类型：彩色文件 + 白色标签条内类型色扩展名（资源管理器通用样式） */
function genericGlyph(color: string, label: string): string {
  const fs = label.length > 3 ? 3.9 : 4.6;
  return `
    ${fileBase(color)}
    <rect x="5.2" y="14.6" width="13.6" height="6" rx="1.4" fill="#fff" opacity="0.92"/>
    <text x="12" y="18.9" text-anchor="middle" font-size="${fs}" font-weight="700" font-family="Arial, sans-serif" fill="${color}">${esc(label)}</text>`;
}

/** 行业通用文件图标：Office（W/X/P 彩色角块）、Adobe PDF（红底白三角）、通用（彩条扩展名） */
function docFileIconHtml(d: DocRow): string {
  const { kind, color, label } = docTypeStyle(d);
  let body: string;
  if (kind === "word") body = officeGlyph("W", color);
  else if (kind === "excel") body = officeGlyph("X", color);
  else if (kind === "ppt") body = officeGlyph("P", color);
  else if (kind === "pdf") body = pdfGlyph(color);
  else body = genericGlyph(color, label);
  return `<div class="ico doc-ico"><svg viewBox="0 0 24 24">${body}</svg></div>`;
}

/** 文档卡片末行彩色胶囊（空间/作者/访问时间），各固定一种主题色便于扫读 */
function docPill(text: string, color: string, tip = ""): string {
  if (!text) return "";
  return `<span class="doc-pill" style="color:${color};background:${color}14;border:1px solid ${color}33"${tip ? ` title="${esc(tip)}"` : ""}>${esc(text)}</span>`;
}

/** 彩色胶囊固定配色：空间=蓝 / 作者=青绿 / 访问时间=橙 */
const DOC_PILL_SPACE = "#3b82f6";
const DOC_PILL_USER = "#14b8a6";
const DOC_PILL_TIME = "#f59e0b";

async function loadDocList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "docs") return;
  list.innerHTML = skels();
  const cat = DOC_CAT[docSection] || "browse";
  try {
    docsCache = await api.getDocs(cat, 0, 20);
    renderDocList();
  } catch (e) {
    if (currentTab !== "docs" || !list) return;
    list.innerHTML = `<div class="empty">获取文档失败<br/><span class="hint">${esc(String(e))}</span></div>`;
  }
}

/// 渲染文档列表（docsCache + docSearch 本地过滤；搜索输入只走这里，不重新请求、焦点不丢）
function renderDocList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "docs") return;
  const kw = docSearch.toLowerCase();
  const hit = (d: DocRow) =>
    !kw ||
    d.title.toLowerCase().includes(kw) ||
    (d.space_name || "").toLowerCase().includes(kw) ||
    (d.user_name || "").toLowerCase().includes(kw);
  const docs = docsCache.filter(hit);
  if (!docs.length) {
    list.innerHTML = `<div class="empty">${kw ? "没有匹配的文档" : `暂无${DOC_SECTIONS.find((s) => s.key === docSection)?.label || ""}文档`}</div>`;
    return;
  }
  // 「最近访问」按日期分组（今天/昨天/本周/更早），与消息页时间分组语言统一
  const grouped = docSection === "recent";
  let html = "";
  let lastGroup = "";
  for (const d of docs) {
    if (grouped) {
      const g = timeGroupKey(d.time_str);
      if (g !== lastGroup) {
        html += `<div class="group-head">${g}</div>`;
        lastGroup = g;
      }
    }
    const typeName = DOC_ATYPE_NAMES[d.atype] || "";
    const time = fmtRelTime(d.time_str);
    html += `
      <div class="list-item card doc-card" data-url="${esc(d.url)}" title="${esc([d.title, d.time_str].filter(Boolean).join("　"))}">
        ${docFileIconHtml(d)}
        <div class="li-main">
          <div class="li-title">${esc(d.title)}${d.file_type ? `<span class="doc-ext">.${esc(d.file_type)}</span>` : ""}${typeName ? `<span class="doc-type-pill">${esc(typeName)}</span>` : ""}</div>
          <div class="li-meta doc-pills">${docPill(d.space_name, DOC_PILL_SPACE)}${docPill(d.user_name, DOC_PILL_USER)}${docPill(time, DOC_PILL_TIME, d.time_str)}</div>
        </div>
        <span class="arrow">›</span>
      </div>`;
  }
  list.innerHTML = html;
  list.querySelectorAll(".list-item").forEach((item) =>
    item.addEventListener("click", () => {
      const url = (item as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

// ---------------- 空间 Tab（空间列表：我的收藏等分类） ----------------
let spaceSection = "starred";
// 搜索关键字（本地过滤名称/单位/说明）；拉取结果缓存，输入时不重新请求
let spaceSearch = "";
let spacesCache: SpaceRow[] = [];

function renderSpaces(content: HTMLElement) {
  content.innerHTML =
    searchBar("search-space", "搜索空间 / 单位 / 说明", spaceSearch) +
    `
    <div class="type-chips" id="space-tabs">
      <button class="type-chip${spaceSection === "starred" ? " active" : ""}" data-sec="starred">我的收藏</button>
      <button class="type-chip${spaceSection === "all" ? " active" : ""}" data-sec="all">全部空间</button>
    </div>
    <div class="list" id="list">${skels()}</div>`;
  document.getElementById("search-space")!.addEventListener("input", debounce((e: Event) => {
    spaceSearch = (e.target as HTMLInputElement).value.trim();
    renderSpaceList();
  }, 300));
  content.querySelectorAll("#space-tabs .type-chip").forEach((b) =>
    b.addEventListener("click", () => {
      spaceSection = (b as HTMLElement).dataset.sec!;
      content.querySelectorAll("#space-tabs .type-chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      void loadSpaceList();
    }),
  );
  void loadSpaceList();
}

/// 空间分类 key → 后端 category
const SPACE_CAT: Record<string, string> = { starred: "collect", all: "all" };

/** spaceColor（theme-blue/red/green...）→ 扁平彩色 */
function spaceColorOf(c: string): string {
  const m: Record<string, string> = {
    "theme-blue": "#3b82f6",
    "theme-red": "#f43f5e",
    "theme-green": "#10b981",
    "theme-orange": "#f59e0b",
    "theme-purple": "#8b5cf6",
    "theme-cyan": "#06b6d4",
  };
  return m[c] || "#3b82f6";
}

async function loadSpaceList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "spaces") return;
  list.innerHTML = skels();
  const cat = SPACE_CAT[spaceSection] || "collect";
  try {
    spacesCache = await api.getSpaces(cat);
    renderSpaceList();
  } catch (e) {
    if (currentTab !== "spaces" || !list) return;
    list.innerHTML = `<div class="empty">获取空间失败<br/><span class="hint">${esc(String(e))}</span></div>`;
  }
}

/// 渲染空间列表（spacesCache + spaceSearch 本地过滤；搜索输入只走这里，不重新请求、焦点不丢）
function renderSpaceList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "spaces") return;
  const kw = spaceSearch.toLowerCase();
  const hit = (s: SpaceRow) =>
    !kw ||
    s.name.toLowerCase().includes(kw) ||
    (s.dept || "").toLowerCase().includes(kw) ||
    (s.remark || "").toLowerCase().includes(kw);
  const spaces = spacesCache.filter(hit);
  if (!spaces.length) {
    list.innerHTML = `<div class="empty">${kw ? "没有匹配的空间" : spaceSection === "starred" ? "暂无收藏的空间" : "暂无可访问的空间"}</div>`;
    return;
  }
  list.innerHTML = spaces
    .map((s) => {
      const c = spaceColorOf(s.color);
      return `
      <div class="list-item card" data-url="${esc(s.url)}" title="${esc(s.remark || s.name)}">
        <div class="ico" style="color:${c};background:${c}1f"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z"/></svg></div>
        <div class="li-main">
          <div class="li-title">${esc(s.name)}${s.collected ? '<span class="star-mark" style="color:#f59e0b">★</span>' : ""}</div>
          <div class="li-sub">${esc([s.dept, s.remark].filter((x) => x && x !== "暂无说明").join(" · ") || " ")}</div>
        </div>
      </div>`;
    })
    .join("");
  list.querySelectorAll(".list-item").forEach((item) =>
    item.addEventListener("click", () => {
      const url = (item as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

// ---------------- 我的 Tab ----------------
/** 从可能的多角色拼接串（如 "平台管理员,教职工"）中取第一个作为展示名 */
function firstRoleName(s: string | undefined): string {
  return (s || "").split(/[,，、;；/]/)[0].trim();
}

async function loadUserInfo() {
  try {
    userInfo = await api.getUserInfo();
  } catch {
    userInfo = null;
  }
  // 标题栏「业务小助手」后的小号灰字：仅显示当前用户名（角色在「我的」页查看）
  const tu = document.getElementById("topbar-user");
  if (tu) {
    const t = userInfo?.user_name || "";
    tu.textContent = t;
    tu.title = t;
  }
  // 个人信息卡已从消息/待办页移除；这里仅预取数据供「我的」Tab 使用
  if (currentTab === "profile") {
    const content = document.getElementById("content");
    if (content) renderProfile(content);
  }
}

// ---------------- 快捷功能 Tab（B/S「快捷入口」九宫格卡片） ----------------
let quickCache: QuickEntry[] | null = null;
let quickSearch = "";

async function renderQuick(content: HTMLElement) {
  content.innerHTML =
    searchBar("search-quick", "搜索快捷功能", quickSearch) +
    `<div id="quick-body">${quickCache ? "" : skels(3)}</div>`;
  document.getElementById("search-quick")!.addEventListener("input", debounce((e: Event) => {
    quickSearch = (e.target as HTMLInputElement).value.trim();
    const b = document.getElementById("quick-body");
    if (b && quickCache) renderQuickGrid(b, quickCache, quickSearch);
  }, 250));
  const body = document.getElementById("quick-body");
  if (!body) return;
  // 有缓存先渲染，再静默刷新
  if (quickCache) renderQuickGrid(body, quickCache, quickSearch);
  try {
    const items = await api.getQuickEntries();
    quickCache = items;
    renderQuickGrid(body, items, quickSearch);
  } catch (e) {
    body.innerHTML = `<div class="empty">加载失败：${esc(String(e).replace(/^"|"$/g, ""))}<br/><span class="hint">请确认已登录 B/S 系统后重试</span></div>`;
  }
}

function renderQuickGrid(el: HTMLElement, items: QuickEntry[], kw: string) {
  const k = kw.trim().toLowerCase();
  const vis = items.filter((it) => !k || it.name.toLowerCase().includes(k));
  if (!vis.length) {
    el.innerHTML = `<div class="empty">${k ? "没有匹配的快捷功能" : "暂无快捷功能（B/S「快捷入口」为空）"}</div>`;
    return;
  }
  const card = (it: QuickEntry) => {
    const fb = `color:#8b5cf6;background:#8b5cf61f`; // 无图 fallback：紫淡底 + 首字母
    return `
      <button class="quick-card" data-url="${esc(it.url)}" title="点击打开：${esc(it.name)}">
        <span class="quick-ico">${it.icon ? `<img src="${esc(it.icon)}" alt="" /><span class="quick-ico-fb" style="display:none;${fb}">${esc(it.name.slice(0, 1))}</span>` : `<span class="quick-ico-fb" style="${fb}">${esc(it.name.slice(0, 1))}</span>`}</span>
        <span class="quick-name">${esc(it.name)}</span>
      </button>`;
  };
  el.innerHTML = `<div class="quick-grid">${vis.map(card).join("")}</div>`;
  // 图标加载失败 → 首字母兜底。注意不能用内联 onerror（CSP script-src 'self' 拦截内联事件处理器）
  el.querySelectorAll<HTMLImageElement>(".quick-ico img").forEach((img) =>
    img.addEventListener("error", () => {
      img.style.display = "none";
      const fb = img.nextElementSibling as HTMLElement | null;
      if (fb) fb.style.display = "flex";
    }),
  );
  // 点击卡片 → webview 打开（全屏模式进内嵌面板，默认模式开独立窗口）
  el.querySelectorAll(".quick-card").forEach((c) =>
    c.addEventListener("click", () => {
      const url = (c as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
}

function renderProfile(content: HTMLElement) {
  if (!settings) return;
  const s = settings;
  // 彩色线性小图标容器（消息页头像风：类型色 12% 淡底 + 同色线性图形）
  const ico = (color: string, path: string) =>
    `<div class="set-ico" style="color:${color};background:${color}1f"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg></div>`;
  content.innerHTML = `
    <div class="ph-hero">
      <div class="avatar avatar-lg">${esc((userInfo?.user_name || "·").slice(0, 1))}</div>
      <div class="ph-name-c">${esc(userInfo?.user_name || "未获取用户信息")}</div>
      <div class="ph-sub"><span class="ph-role" title="${esc(userInfo?.role_name || "")}">${esc(firstRoleName(userInfo?.role_name) || "—")}</span>${userInfo?.account ? `<span>·</span><span>${esc(userInfo.account)}</span>` : ""}</div>
    </div>
    <div class="set-row">
      ${ico("#3b6df0", `<circle cx="12" cy="9.3" r="3.3"/><path d="M5.3 19.2c.9-2.9 3.5-4.6 6.7-4.6s5.8 1.7 6.7 4.6"/>`)}
      <div class="set-main"><div class="set-title">当前角色</div><div class="set-desc">多角色账号可切换，切换后立即生效</div></div>
      <div class="set-side"><select id="role-select" class="role-select" title="点击切换角色"><option value="">${esc(firstRoleName(userInfo?.role_name) || "加载中…")}</option></select></div>
    </div>
    <div class="set-row">
      ${ico("#8b5cf6", `<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9v6M12 7v8M17 10v4"/>`)}
      <div class="set-main"><div class="set-title">重启后恢复标签页</div><div class="set-desc">再次打开客户端并进入全屏模式时，自动恢复上次打开的标签页（最多 8 个；休眠的标签点击后再加载）</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-tab-restore" ${s.tab_restore ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#0ea5e9", `<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>`)}
      <div class="set-main"><div class="set-title">心跳间隔</div><div class="set-desc">与 B/S 网页原生心跳同源，兼做会话保活；会话失效时自动用保存的入口凭据重登录（默认 60 秒，30 秒~60 分钟）</div></div>
      <div class="set-side interval-ctrl"><input type="number" id="set-interval" value="${s.poll_interval_secs}" min="30" max="3600" step="30" /><span class="unit">秒</span></div>
    </div>
    <div class="set-row">
      ${ico("#ec4899", `<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.5h18"/><path d="M7 15h4"/>`)}
      <div class="set-main">
        <div class="set-title">常用入口</div>
        <div class="set-desc">保存多个服务器入口（项目·网址·账号·密码成一组，主键为「项目+网址+账号」，同一项目+网址下可保存多个账号；密码国密 SM4 加密存储）。选中历史入口自动带出凭据并登录，成功后自动刷新数据</div>
        <div class="acct-head" id="acct-head">入口配置 <span class="acct-caret">▸</span></div>
        <div class="set-block acct-block" id="acct-block" style="display:none">
          <select id="acct-select" class="acct-select" title="选择历史入口或新增"></select>
          <div class="seg-row" id="acct-product">
            <button class="seg-opt" data-ops="1" type="button">运维（AIF）</button>
            <button class="seg-opt" data-ops="0" type="button">一表通（DCP）</button>
          </div>
          <input type="text" id="acct-url" placeholder="https://host[:端口]" />
          <input type="text" id="acct-user" placeholder="账号" autocomplete="off" />
          <div class="pwd-row">
            <input type="password" id="acct-pass" placeholder="密码" autocomplete="off" />
            <button type="button" class="icon-btn" id="acct-eye" title="显示/隐藏密码">${EYE_SVG}</button>
          </div>
          <input type="text" id="acct-remark" placeholder="备注（最多 10 个汉字）" maxlength="10" autocomplete="off" />
          <div class="acct-btns">
            <button class="btn" id="acct-save" type="button">保存</button>
            <button class="btn primary" id="acct-login" type="button">保存并登录</button>
            <button class="btn" id="acct-delete" type="button">删除该入口</button>
          </div>
        </div>
      </div>
    </div>
    <div class="set-row">
      ${ico("#0ea5e9", `<path d="M8 7h12M8 12h12M8 17h12"/><path d="M3.5 7h.01M3.5 12h.01M3.5 17h.01"/>`)}
      <div class="set-main"><div class="set-title">多入口切换</div><div class="set-desc">开启后，全屏模式顶栏出现「切换入口」按钮，可在「我的 → 常用入口」保存的多个账号（同项目+网址多账号）间一键切换（默认关闭）</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-multi-entry" ${s.multi_entry ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#f59e0b", `<path d="M14 4h4.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M4 12h10M10 8l4 4-4 4"/>`)}
      <div class="set-main"><div class="set-title">自动登录</div><div class="set-desc">启动时用已存凭据静默登录（需验证码时会打开登录窗）</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-autologin" ${s.auto_login ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#10b981", `<path d="M12 3v8"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/>`)}
      <div class="set-main"><div class="set-title">开机自启</div><div class="set-desc">随系统启动并在后台运行</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-autostart" ${s.autostart ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#f97316", `<path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z"/><path d="M10.3 20a2 2 0 0 0 3.4 0"/>`)}
      <div class="set-main">
        <div class="set-title">新消息提示音</div>
        <div class="set-desc">收到新消息时播放提示音</div>
        <div class="set-block"><div class="sound-row">
          <button class="sound-opt ${s.sound === "ding" ? "active" : ""}" data-sound="ding">叮</button>
          <button class="sound-opt ${s.sound === "chime" ? "active" : ""}" data-sound="chime">风铃</button>
          <button class="sound-opt ${s.sound === "drop" ? "active" : ""}" data-sound="drop">水滴</button>
        </div></div>
      </div>
    </div>
    <div class="set-row">
      ${ico("#6366f1", `<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10.2h.01M11 10.2h.01M15 10.2h.01M17.2 10.2h.01M7 14h.01M11 14h6"/>`)}
      <div class="set-main">
        <div class="set-title">快捷键</div>
        <div class="set-desc">显示 / 隐藏主窗口（系统级 HotKey）· 聚焦后按下组合键即录入（需含 Ctrl/Alt/Win），Esc 清空</div>
        <div class="set-block"><div class="hotkey-ctrl">
          <input type="text" id="set-hotkey" class="hotkey-input" readonly
            placeholder="点击后按下组合键" value="${esc(s.hotkey)}" />
          <button class="btn" id="hotkey-clear">清除</button>
        </div></div>
      </div>
    </div>
    <button class="btn-save" id="set-save">保存设置</button>
    <button class="btn-logout" id="set-logout">退出登录</button>
    <button class="btn-quit" id="set-quit">退出程序</button>
    <span class="ph-ver">V ${esc(appVersion)}</span>`;

  content.querySelectorAll(".sound-opt").forEach((b) =>
    b.addEventListener("click", () => {
      const name = (b as HTMLElement).dataset.sound!;
      content.querySelectorAll(".sound-opt").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      playSound(name);
      if (settings) settings.sound = name;
    }),
  );
  document.getElementById("set-save")!.addEventListener("click", saveSettings);
  bindHotkeyCapture();
  // 清除快捷键：立即注销系统热键并持久化（空串=注销）
  document.getElementById("hotkey-clear")!.addEventListener("click", async () => {
    const input = document.getElementById("set-hotkey") as HTMLInputElement | null;
    if (input) input.value = "";
    if (settings) settings.hotkey = "";
    try {
      await api.setHotkey("");
      toast("快捷键已清除");
    } catch (e) {
      toast("清除失败：" + String(e).replace(/^"|"$/g, ""));
    }
  });
  document.getElementById("set-logout")!.addEventListener("click", async () => {
    await api.logout();
    toast("已退出登录");
    // 清空未读与角标（换账号后不应带入旧未读）
    unreadIds.clear();
    persistUnread();
    todoBadgeCount = 0;
    setTabBadge("messages", 0);
    setTabBadge("todos", 0);
    await bootstrap();
  });
  // 退出程序：两步确认防误触（3 秒内再点一次才退出，超时自动还原）
  const quitBtn = document.getElementById("set-quit") as HTMLButtonElement;
  let quitTimer = 0;
  quitBtn.addEventListener("click", () => {
    if (quitBtn.dataset.confirm === "1") {
      void api.quitApp();
      return;
    }
    quitBtn.dataset.confirm = "1";
    quitBtn.textContent = "确认退出？再点一次";
    quitBtn.classList.add("confirming");
    window.clearTimeout(quitTimer);
    quitTimer = window.setTimeout(() => {
      quitBtn.dataset.confirm = "";
      quitBtn.textContent = "退出程序";
      quitBtn.classList.remove("confirming");
    }, 3000);
  });
  // 角色下拉：读取可用角色清单（login/switchRolesTree.htm），选择即切换（login/updateLogin.htm）
  void initRoleSelect(document.getElementById("role-select") as HTMLSelectElement);
  // 常用入口：多网址账号组（SM4 加密）+ 选中自动登录
  void initAccounts(content);
}

// ---------------- 常用入口（多网址账号组 + 自动登录） ----------------
let accountsCache: AccountEntry[] = [];

/// 顶栏当前入口标签：应用类型 · 网址（仅全屏模式展示，元素不存在时静默跳过）
/// 顶栏当前入口标签：备注-项目-账号@网址（仅全屏模式展示，元素不存在时静默跳过）
async function updateEntryLabel() {
  const el = document.getElementById("tb-entry");
  if (!el || !settings) return;
  const s = settings;
  // 刷新本地入口缓存，取当前账号对应的备注（无凭据读取失败时保留旧缓存）
  try {
    accountsCache = await api.accountList();
  } catch {
    /* 保留旧缓存 */
  }
  const proj = s.ops_product ? "运维" : "一表通";
  const acct = userInfo?.account || "";
  const u = s.base_url.trim().replace(/\/+$/, "");
  const remark = (
    accountsCache.find((e) => e.ops === s.ops_product && e.url === u && e.username === acct)?.remark || ""
  ).trim();
  el.textContent = `${remark ? remark + "-" : ""}${proj}-${acct}@${s.base_url}`;
  el.title = `当前入口${remark ? "（备注：" + remark + "）" : ""}：${proj} · ${acct}@${s.base_url}`;
  updateEntryBtn();
}

/// 顶栏「切换入口」按钮的可见性：仅「多入口切换」开启且全屏模式时才显示
function updateEntryBtn() {
  const wrap = document.getElementById("tb-entry-wrap");
  if (!wrap || !settings) return;
  wrap.classList.toggle("entry-hidden", !(settings.multi_entry && layoutMode === "full"));
}

/// 「切换常用入口」弹窗：左右布局，左列备注分组、右列同备注下的多个入口（项目+账号@网址）。
/// 点击右侧入口即自动切换并登录（仅「多入口切换」开启且全屏模式可用）。
async function openEntryDialog() {
  if (layoutMode !== "full" || !settings || !settings.multi_entry) return;
  try {
    accountsCache = await api.accountList();
  } catch (e) {
    toast("读取常用入口失败：" + String(e).replace(/^"|"$/g, ""));
    return;
  }
  const norm = (u: string) => u.trim().replace(/\/+$/, "");
  const projOf = (e: AccountEntry) => (e.ops ? "运维" : "一表通");
  const curKey = `${settings.ops_product ? "1" : "0"}|${norm(settings.base_url)}|${userInfo?.account || ""}`;
  // 按备注分组（空备注归入「未备注」）
  const groups = new Map<string, AccountEntry[]>();
  for (const e of accountsCache) {
    const k = (e.remark || "").trim() || "（未备注）";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const remarkKeys = [...groups.keys()];
  // 默认选中当前入口所在备注分组
  const curEntry = accountsCache.find(
    (e) => `${e.ops ? "1" : "0"}|${norm(e.url)}|${e.username}` === curKey,
  );
  let selRemark = curEntry
    ? (curEntry.remark || "").trim() || "（未备注）"
    : remarkKeys[0] || "（未备注）";

  // 内嵌标签是原子 webview，永远盖在主 webview DOM（含本弹窗）之上：
  // 弹窗打开期间临时隐藏全部标签（实例与页面状态保留），关闭时恢复
  const savedRect = layoutMode === "full" && tabs.length > 0 ? paneRect() : null;
  if (savedRect) {
    entryDlgOpen = true;
    void api.tabHideAll().catch(() => {});
  }
  const closeDlg = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
    entryDlgOpen = false;
    if (savedRect) void api.tabRestoreAll().catch(() => {});
  };

  const overlay = document.createElement("div");
  overlay.className = "dlg-overlay";
  const render = () => {
    const left = remarkKeys.length
      ? remarkKeys
          .map(
            (k) => `
        <div class="dlg-rm${k === selRemark ? " active" : ""}" data-r="${esc(k)}">
          <span class="dlg-rm-name">${esc(k)}</span>
          <span class="dlg-rm-count">${groups.get(k)!.length}</span>
        </div>`,
          )
          .join("")
      : `<div class="dlg-empty">暂无已保存的入口，可在「我的 → 常用入口」中添加</div>`;
    const right = (groups.get(selRemark) || [])
      .map((e) => {
        const gi = accountsCache.indexOf(e);
        const isCur = `${e.ops ? "1" : "0"}|${norm(e.url)}|${e.username}` === curKey;
        return `
          <div class="dlg-item${isCur ? " active" : ""}" data-i="${gi}">
            <div class="di-name">${projOf(e)} + ${esc(e.username)}@${esc(e.url)}</div>
            <div class="di-sub">${isCur ? "当前入口" : ""}</div>
          </div>`;
      })
      .join("");
    overlay.innerHTML = `
      <div class="dlg">
        <div class="dlg-head">切换常用入口</div>
        <div class="dlg-cols">
          <div class="dlg-left">${left}</div>
          <div class="dlg-right">${right || `<div class="dlg-empty">该备注下暂无入口</div>`}</div>
        </div>
        <div class="dlg-foot">
          <button class="btn" id="dlg-cancel" type="button">取消</button>
        </div>
      </div>`;
  };
  render();
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement;
    if (t === overlay) {
      closeDlg();
      return;
    }
    const rm = t.closest(".dlg-rm") as HTMLElement | null;
    if (rm) {
      selRemark = rm.dataset.r || selRemark;
      render();
      return;
    }
    const item = t.closest(".dlg-item") as HTMLElement | null;
    if (item) {
      const e = accountsCache[Number(item.dataset.i)];
      if (e) {
        closeDlg();
        void loginToEntry(e);
      }
      return;
    }
    if (t.id === "dlg-cancel") closeDlg();
  });
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") closeDlg();
  };
  document.addEventListener("keydown", onKey);
}

/// 切换到指定入口登录：保存当前设置 → 切 base_url/产品 → 登录 → 成功后整版刷新数据。
/// 失败时回滚服务器设置（避免轮询打到错误地址）。
async function loginToEntry(entry: { ops: boolean; url: string; username: string; password: string; remark?: string }) {
  if (!settings) return;
  if (!entry.url || !entry.username || !entry.password) {
    toast("网址、账号、密码均不能为空");
    return;
  }
  const prevUrl = settings.base_url;
  const prevOps = settings.ops_product;
  settings.base_url = entry.url;
  settings.ops_product = entry.ops;
  try {
    await api.saveSettings(settings);
    toast(`正在切换登录：${entry.url}`);
    await api.loginLocal(entry.username, entry.password, "", false);
    toast("登录成功，正在刷新数据");
    // 换环境后旧入口打开的标签全部关闭（域名/会话已变，继续挂着会串会话）
    try {
      await api.tabCloseAll();
    } catch {
      /* 无标签 */
    }
    tabs = [];
    renderTabBar();
    // 换环境后旧未读/角标不再有意义
    unreadIds.clear();
    persistUnread();
    todoBadgeCount = 0;
    setTabBadge("messages", 0);
    setTabBadge("todos", 0);
    await bootstrap();
    void api.checkNow();
    void updateEntryLabel();
  } catch (e) {
    const msg = String(e).replace(/^"|"$/g, "");
    settings.base_url = prevUrl;
    settings.ops_product = prevOps;
    await api.saveSettings(settings).catch(() => {});
    void updateEntryLabel();
    toast("自动登录失败：" + (msg || "未知错误") + (msg.includes("验证码") ? "（需回登录窗输入图形验证码）" : ""));
  }
}

/// 「常用入口」区块初始化：历史网址下拉（选中即自动登录）、保存/删除
async function initAccounts(content: HTMLElement) {
  const sel = document.getElementById("acct-select") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    accountsCache = await api.accountList();
  } catch {
    accountsCache = [];
  }
  if (currentTab !== "profile" || !document.body.contains(sel)) return;

  const segBtns = content.querySelectorAll("#acct-product .seg-opt");
  const setSeg = (ops: boolean) =>
    segBtns.forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.ops === (ops ? "1" : "0")));
  const getSeg = () =>
    [...segBtns].some((b) => (b as HTMLElement).dataset.ops === "1" && b.classList.contains("active"));
  const fields = () => ({
    url: ((document.getElementById("acct-url") as HTMLInputElement).value || "").trim().replace(/\/+$/, ""),
    username: ((document.getElementById("acct-user") as HTMLInputElement).value || "").trim(),
    remark: ((document.getElementById("acct-remark") as HTMLInputElement).value || "").trim().slice(0, 10),
    password: (document.getElementById("acct-pass") as HTMLInputElement).value,
  });
  const fill = (ops: boolean, url: string, username: string, remark: string, password: string) => {
    setSeg(ops);
    (document.getElementById("acct-url") as HTMLInputElement).value = url;
    (document.getElementById("acct-user") as HTMLInputElement).value = username;
    (document.getElementById("acct-remark") as HTMLInputElement).value = remark;
    (document.getElementById("acct-pass") as HTMLInputElement).value = password;
  };
  const acctBlock = document.getElementById("acct-block") as HTMLElement | null;
  const acctHead = document.getElementById("acct-head") as HTMLElement | null;
  // 入口配置默认折叠（acct-block 初始 display:none）；点击表头或使用时展开。
  // 展开时置空内联 display，让 CSS 的 display:flex + gap 生效（置 block 会覆盖 flex 导致行间距丢失）
  const setAcctCollapsed = (collapsed: boolean) => {
    if (acctBlock) acctBlock.style.display = collapsed ? "none" : "";
    acctHead?.classList.toggle("open", !collapsed);
  };
  acctHead?.addEventListener("click", () => {
    setAcctCollapsed(acctBlock?.style.display !== "none");
  });
  // 备注输入限制最多 6 个字符（汉字/英文/数字均按 1 计），超出截断
  document.getElementById("acct-remark")?.addEventListener("input", (e) => {
    const inp = e.target as HTMLInputElement;
    if (inp.value.length > 10) inp.value = inp.value.slice(0, 10);
  });
  // 密码可见切换（眼睛按钮，与登录表单一致）
  const acctEye = document.getElementById("acct-eye");
  acctEye?.addEventListener("click", () => {
    const inp = document.getElementById("acct-pass") as HTMLInputElement;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    if (acctEye) acctEye.innerHTML = show ? EYE_OFF_SVG : EYE_SVG;
  });
  setSeg(settings?.ops_product ?? true);
  segBtns.forEach((b) =>
    b.addEventListener("click", () => setSeg((b as HTMLElement).dataset.ops === "1")),
  );

  // 复合主键：项目+网址+账号（同项目+网址下支持多账号并存）
  const keyOf = (e: { ops: boolean; url: string; username: string }) => `${e.ops ? "1" : "0"}|${e.url}|${e.username}`;

  const rebuild = () => {
    sel.innerHTML =
      `<option value="">＋ 新增入口…</option>` +
      accountsCache
        .map(
          (e) =>
            `<option value="${esc(keyOf(e))}">${esc((e.remark ? e.remark + " · " : "") + (e.ops ? "运维" : "一表通") + " · " + e.username + "@" + e.url)}</option>`,
        )
        .join("");
  };
  rebuild();

  // 选中历史入口 → 仅带出凭据与备注回填表单（供查看/编辑），不自动切换入口；
  // 切换入口只由「保存并登录」触发。选中同时展开配置区
  sel.addEventListener("change", () => {
    const e = accountsCache.find((x) => keyOf(x) === sel.value);
    setAcctCollapsed(false);
    if (!e) {
      setSeg(settings?.ops_product ?? true);
      fill(getSeg(), "", "", "", "");
      return;
    }
    fill(e.ops, e.url, e.username, e.remark, e.password);
  });

  document.getElementById("acct-save")!.addEventListener("click", async () => {
    const f = fields();
    if (!f.url || !f.username || !f.password) {
      toast("网址、账号、密码均不能为空");
      return;
    }
    try {
      await api.accountSave(getSeg(), f.url, f.username, f.password, f.remark);
      accountsCache = await api.accountList();
      rebuild();
      sel.value = `${getSeg() ? "1" : "0"}|${f.url}|${f.username}`;
      toast("入口已保存（密码已 SM4 加密）");
    } catch (e) {
      toast("保存失败：" + String(e).replace(/^"|"$/g, ""));
    }
  });

  document.getElementById("acct-login")!.addEventListener("click", async () => {
    const f = fields();
    if (!f.url || !f.username || !f.password) {
      toast("网址、账号、密码均不能为空");
      return;
    }
    try {
      await api.accountSave(getSeg(), f.url, f.username, f.password, f.remark);
      accountsCache = await api.accountList();
      rebuild();
      sel.value = `${getSeg() ? "1" : "0"}|${f.url}|${f.username}`;
    } catch (e) {
      toast("保存失败：" + String(e).replace(/^"|"$/g, ""));
      return;
    }
    void loginToEntry({ ops: getSeg(), url: f.url, username: f.username, password: f.password, remark: f.remark });
  });

  document.getElementById("acct-delete")!.addEventListener("click", async () => {
    const f = fields();
    const cur = accountsCache.find((x) => keyOf(x) === sel.value);
    if (!cur || !f.url) {
      toast("请先在下拉中选择要删除的入口");
      return;
    }
    try {
      await api.accountDelete(cur.ops, cur.url, cur.username);
      accountsCache = accountsCache.filter((x) => keyOf(x) !== sel.value);
      rebuild();
      sel.value = "";
      fill(getSeg(), "", "", "", "");
      toast("已删除该入口");
    } catch (e) {
      toast("删除失败：" + String(e).replace(/^"|"$/g, ""));
    }
  });
}

/// 角色下拉初始化与切换逻辑。清单拉取/解析失败时退化为纯展示当前角色。
async function initRoleSelect(sel: HTMLSelectElement) {
  let roles: RoleOption[] = [];
  try {
    roles = await api.getRoles();
  } catch (e) {
    sel.innerHTML = `<option value="">${esc(firstRoleName(userInfo?.role_name) || "—")}</option>`;
    sel.disabled = true;
    sel.title = String(e).replace(/^"|"$/g, "");
    return;
  }
  if (currentTab !== "profile" || !document.body.contains(sel)) return;
  // 当前角色匹配：名称精确匹配，或当前角色串（可能多角色拼接）拆分后命中其一
  const current = userInfo?.role_name || "";
  const curNames = current.split(/[,，、;；/]/).map((s) => s.trim()).filter(Boolean);
  const selected = roles.find((r) => r.name === current || curNames.includes(r.name));
  sel.innerHTML = roles
    .map((r) => `<option value="${esc(r.id)}"${selected && r.id === selected.id ? " selected" : ""}>${esc(r.name)}</option>`)
    .join("");
  if (!selected) {
    // 当前角色不在清单里（接口返回的可能是全量角色），保留展示但标记
    sel.insertAdjacentHTML(
      "afterbegin",
      `<option value="" selected>${esc(firstRoleName(current) || "当前角色")}</option>`,
    );
  }
  sel.addEventListener("change", async () => {
    const opt = roles.find((r) => r.id === sel.value);
    const prev = sel.dataset.prev || "";
    if (!opt) return;
    try {
      sel.disabled = true;
      await api.switchRole(opt.id);
      toast(`已切换角色：${opt.name}`);
      await loadUserInfo();
      // 角色/权限变化后，消息与事项数据随之变化，切回对应 Tab 时会重新拉取
      if (settings) void api.checkNow();
    } catch (e) {
      toast("切换失败：" + String(e).replace(/^"|"$/g, ""));
      sel.value = prev;
    } finally {
      sel.disabled = false;
      sel.dataset.prev = sel.value;
    }
  });
  sel.dataset.prev = sel.value;
}

/// 快捷键录入：聚焦输入框后按键捕获（Ctrl/Alt/Win + 主键 才算有效组合），Esc 清空。
function bindHotkeyCapture() {
  const input = document.getElementById("set-hotkey") as HTMLInputElement | null;
  if (!input) return;
  const label = (e: KeyboardEvent): string => {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.shiftKey) parts.push("Shift");
    if (e.altKey) parts.push("Alt");
    if (e.metaKey) parts.push("Win");
    const k = e.key;
    if (/^[a-z]$/i.test(k)) parts.push(k.toUpperCase());
    else if (/^[0-9]$/.test(k)) parts.push(k);
    else if (/^F([1-9]|1[0-2])$/.test(k)) parts.push(k);
    else {
      const named: Record<string, string> = {
        "`": "`", "-": "-", "=": "=", "[": "[", "]": "]", "\\": "\\", ";": ";", "'": "'",
        ",": ",", ".": ".", "/": "/", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
      };
      if (!named[k]) return ""; // 不支持的特殊键
      parts.push(named[k]);
    }
    return parts.join("+");
  };
  input.addEventListener("keydown", (ev) => {
    const e = ev as KeyboardEvent;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      return;
    }
    if (e.repeat) return;
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // 只按修饰键不录入
    const combo = label(e);
    if (!combo) return;
    // 组合里必须有 Ctrl/Alt/Win（仅 Shift+字母 属于打字组合，不适合做热键）
    if (!/^(Ctrl|Alt|Win)(\+Shift)?\+/.test(combo)) return;
    input.value = combo;
    input.blur();
  });
}

async function saveSettings() {
  if (!settings) return;
  // Web 地址 / 目标系统已并入「常用入口」（loginToEntry / 登录页统一维护），此处不再编辑
  // 心跳间隔：直接以秒录入（30~3600，Rust 侧 save_settings 也会钳制一次）
  const secs = Number((document.getElementById("set-interval") as HTMLInputElement).value) || 60;
  settings.poll_interval_secs = Math.min(3600, Math.max(30, secs));
  settings.auto_login = (document.getElementById("set-autologin") as HTMLInputElement).checked;
  settings.autostart = (document.getElementById("set-autostart") as HTMLInputElement).checked;
  settings.tab_restore = (document.getElementById("set-tab-restore") as HTMLInputElement).checked;
  settings.multi_entry = (document.getElementById("set-multi-entry") as HTMLInputElement).checked;
  const oldHotkey = settings.hotkey;
  settings.hotkey = ((document.getElementById("set-hotkey") as HTMLInputElement)?.value || "").trim();
  try {
    // 快捷键先注册校验（成功后已随设置持久化），失败则提示且不覆盖旧值
    await api.setHotkey(settings.hotkey);
    await api.saveSettings(settings);
    await api.setAutostart(settings.autostart);
    toast("设置已保存");
  } catch (e) {
    settings.hotkey = oldHotkey;
    const inp = document.getElementById("set-hotkey") as HTMLInputElement | null;
    if (inp) inp.value = oldHotkey;
    toast("保存失败：" + String(e).replace(/^"|"$/g, ""));
  }
}

// ---------------- 启动 ----------------
async function bootstrap() {
  settings = await api.getSettings();
  const logged = await api.isLoggedIn();
  if (logged) {
    renderPanel();
    await loadUserInfo();
    // 默认停留在「消息」Tab（renderPanel 内 switchTab 已触发首次加载）
  } else {
    const hint = await api.getCredentialHint();
    renderLogin(hint.username);
    // 自动登录：已存凭据且无需验证码时静默登录
    if (settings.auto_login && hint.has_password) {
      try {
        const ok = await api.tryAutoLogin();
        if (ok) {
          toast("已自动登录");
          await bootstrap();
          return;
        }
      } catch {
        /* 静默失败，展示登录窗 */
      }
    }
  }
}

async function main() {
  try {
    appVersion = await api.getAppVersion();
  } catch {
    appVersion = "";
  }
  bindPaneResize();
  bindTabShortcuts();
  await bootstrap();
  // 启动即显示主窗：配置 visible:false，不再依赖托盘唤起（托盘仅作收起后的再次弹出）。
  // 面板态下 renderPanel→applyLayoutMode 已按 aif_layout 自动最大化，这里只负责「显出来」。
  try {
    await win.show();
  } catch {
    /* 个别平台 show 失败不阻塞启动 */
  }
  dumpLayout("main-show"); // [临时诊断] 显示后记录几何
  // 启动即统计底部导航角标：先回溯未读种子（应用关闭期间收到的消息），再统计待办合计
  setTabBadge("messages", unreadIds.size);
  void seedUnreadFromHistory().then(() => refreshBadgeCounts());
  on("logged-in", () => {
    void bootstrap();
    void seedUnreadFromHistory().then(() => refreshBadgeCounts());
  });
  // 心跳失效自愈失败提醒（无保存凭据/需验证码/密码已改）——引导人工登录
  on<string>("relogin-failed", (e) => {
    toast(e);
  });
  on("todos-updated", () => {
    void refreshTodos(true);
    void refreshBadgeCounts();
  });
  on("messages-updated", () => void refreshMessages(true));
  on<MessageRow>("new-message", (m) => {
    playSound(settings?.sound || "chime");
    if (m.id) {
      unreadIds.add(m.id);
      persistUnread();
      setTabBadge("messages", unreadIds.size);
    }
    void refreshMessages(true);
    toast("新消息：" + m.title);
  });
  // 系统通知点击跳转：Rust 按通知标题反查消息 URL 后置前主窗口并 emit；
  // 走 openUrl（全屏开 tab / 默认开独立 webview 窗口），文档空间消息自带 articleShowMessageBox=true
  on<string>("open-message-url", (url) => {
    void openUrl(url);
  });
  on("open-settings", () => {
    switchTab("profile");
  });
  // 标签页结构变化（开/关/切/休眠/恢复）：Rust 广播全量列表，前端重渲染标签栏
  on<TabInfo[]>("tabs-changed", (list) => {
    tabs = list;
    renderTabBar();
  });
  // 页面标题变化（标签内 3s 轮询上报）：只更新对应标签的标题文本，不整栏重渲
  on<{ id: string; title: string }>("tab-title", (e) => {
    const t = tabs.find((x) => x.id === e.id);
    if (!t || t.title === e.title) return;
    t.title = e.title;
    const node = document.querySelector(`.tab[data-id="${CSS.escape(e.id)}"] .tab-title`);
    if (node) node.textContent = e.title;
  });
  // B/S 独立窗口（bs-page-N / conversation）通过 window.close() 关闭：刷新当前 Tab 数据
  // （标签页自身关闭走 tab_close_self → 后端同样 emit bs-closed）
  on("bs-closed", () => {
    switchTab(currentTab);
  });
  // 顶栏轮询状态图标（poller 每轮 emit poll-status；悬停显示上次刷新时间）
  on<PollStatusPayload>("poll-status", (p) => setPollInfo(p.ok, p.ts));
  // 窗体显示保持当前页面：首次打开默认「消息」（初始 currentTab），
  // 之后从托盘/热键再显示时不重置，继续显示离开前的页面。
}

main();
