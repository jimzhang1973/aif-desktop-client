import "./styles.css";
import { basicSetup, EditorView } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import MarkdownIt from "markdown-it";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { api, on, type AccountEntry, type AiAgent, type DiskDlItem, type DiskNode, type DocRow, type HistoryMessage, type MatterBadge, type MatterRow, type MessageRow, type OpsApp, type OpsAppGroup, type QuickEntry, type RoleOption, type Settings, type SpaceRow, type TabInfo, type TodoRow, type UserInfo } from "./api";

const app = document.getElementById("app")!;
const win = getCurrentWindow();

let settings: Settings | null = null;
let userInfo: UserInfo | null = null;
let captchaRequired = false;
let currentTab: "messages" | "todos" | "ops" | "docs" | "spaces" | "disk" | "quick" | "assistant" | "calendar" | "profile" = "messages";
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
/// 帮助（内置使用手册）图标（lucide help-circle 风格），放置在「折叠」与「我的」之间
const HELP_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M9.2 9.2a2.8 2.8 0 0 1 5.4 1c0 1.9-2.7 2.5-2.7 4.3"/><circle cx="12" cy="17.2" r=".7" fill="currentColor" stroke="none"/></svg>`;
/// 内置使用手册地址：与前端同域（生产 tauri://localhost，开发 http://localhost:5173），随包分发的 public/manual.html
const HELP_URL = `${location.origin}/manual.html`;
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
      diskDrawerPlace(); // 列表折叠改变内容列位置，抽屉跟随
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
    diskDrawerPlace(); // 全屏模式抽屉打开期间跟随内容列位置
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

// ---------------- Ctrl+K 全局命令面板 ----------------
// 任意界面 Ctrl+K 唤起，一站直达：功能动作 / 待办 / 消息 / 常用入口四类源。
// 主页面获得焦点时生效（标签页内嵌 webview 聚焦时按键归网页，属预期行为）。
type PaletteItem = { label: string; hint: string; run: () => void };
let paletteEl: HTMLElement | null = null;
let paletteInput: HTMLInputElement | null = null;
let paletteList: HTMLElement | null = null;
let paletteHits: PaletteItem[] = [];
let paletteIdx = 0;
let paletteTodoCache: PaletteItem[] = [];

/// 待办源异步进面板（拉取后缓存；面板开着时到货即重渲）
async function loadPaletteTodos() {
  try {
    const rows = (await api.getTodos()).filter((t) => !t.done).slice(0, 30);
    paletteTodoCache = rows.map((t) => ({
      label: t.title,
      hint: "待办",
      run: () => (t.url ? void openUrl(t.url) : switchTab("todos")),
    }));
    if (paletteEl) renderPalette(paletteInput?.value || "");
  } catch {
    /* 未登录/接口失败：待办源留空 */
  }
}

function paletteItems(): PaletteItem[] {
  const acts: PaletteItem[] = [
    { label: "打开：消息", hint: "功能", run: () => switchTab("messages") },
    { label: "打开：待办", hint: "功能", run: () => switchTab("todos") },
    { label: "打开：文档", hint: "功能", run: () => switchTab("docs") },
    { label: "打开：空间", hint: "功能", run: () => switchTab("spaces") },
    { label: "打开：快捷功能", hint: "功能", run: () => switchTab("quick") },
    { label: "打开：我的 / 设置", hint: "功能", run: () => switchTab("profile") },
    { label: "切换常用入口", hint: "功能", run: () => void openEntryDialog() },
    { label: "切换全屏 / 面板模式", hint: "功能", run: () => void setLayoutMode(layoutMode === "full" ? "mini" : "full") },
    { label: "新建标签页", hint: "功能", run: () => void newTab() },
    { label: "刷新数据", hint: "功能", run: () => { switchTab(currentTab); void api.checkNow(); toast("正在刷新数据"); } },
    { label: "AI 问答", hint: "功能", run: () => void openUrl(aiEntryUrl()) },
    { label: "隐藏到托盘", hint: "功能", run: () => void win.hide() },
  ];
  // 消息源：当前已加载的历史消息（点击直达，与列表点击行为一致）
  for (const m of msgState.items.slice(0, 40)) {
    acts.push({ label: m.title, hint: "消息", run: () => void openUrl(m.url) });
  }
  // 常用入口源：打开切换弹窗（带凭据一键登录，不在面板里直接跳裸 URL）
  for (const a of accountsCache) {
    acts.push({
      label: `${a.remark || a.username}（${a.username}@${a.url}）`,
      hint: "入口",
      run: () => void openEntryDialog(),
    });
  }
  return [...acts, ...paletteTodoCache];
}

function renderPalette(query: string) {
  if (!paletteList) return;
  const kw = query.trim().toLowerCase();
  const all = paletteItems();
  paletteHits = (kw
    ? all.filter((i) => i.label.toLowerCase().includes(kw) || i.hint.toLowerCase().includes(kw))
    : all
  ).slice(0, 12);
  if (paletteIdx >= paletteHits.length) paletteIdx = Math.max(0, paletteHits.length - 1);
  if (!paletteHits.length) {
    paletteList.innerHTML = `<div class="pi-empty">没有匹配的结果</div>`;
    return;
  }
  paletteList.innerHTML = paletteHits
    .map(
      (i, n) =>
        `<div class="pi${n === paletteIdx ? " active" : ""}" data-n="${n}"><span class="pi-label">${esc(i.label)}</span><span class="pi-hint">${esc(i.hint)}</span></div>`,
    )
    .join("");
  paletteList.querySelectorAll<HTMLElement>(".pi").forEach((n) => {
    n.addEventListener("click", () => runPaletteItem(Number(n.dataset.n)));
    n.addEventListener("mousemove", () => {
      const i = Number(n.dataset.n);
      if (i !== paletteIdx) {
        paletteIdx = i;
        renderPalette(paletteInput?.value || "");
      }
    });
  });
  paletteList.querySelector(".pi.active")?.scrollIntoView({ block: "nearest" });
}

function runPaletteItem(n: number) {
  const item = paletteHits[n];
  closePalette();
  if (item) item.run();
}

function openPalette() {
  if (paletteEl) return;
  paletteEl = document.createElement("div");
  paletteEl.className = "palette-mask";
  paletteEl.innerHTML = `
    <div class="palette">
      <input class="palette-input" placeholder="搜索：功能 / 待办 / 消息 / 常用入口…" />
      <div class="palette-list"></div>
      <div class="palette-foot">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
    </div>`;
  document.body.appendChild(paletteEl);
  paletteInput = paletteEl.querySelector<HTMLInputElement>(".palette-input");
  paletteList = paletteEl.querySelector<HTMLElement>(".palette-list");
  paletteIdx = 0;
  void loadPaletteTodos();
  renderPalette("");
  paletteInput!.focus();
  paletteInput!.addEventListener("input", () => {
    paletteIdx = 0;
    renderPalette(paletteInput!.value);
  });
  paletteInput!.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteIdx = Math.min(paletteIdx + 1, paletteHits.length - 1);
      renderPalette(paletteInput!.value);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteIdx = Math.max(paletteIdx - 1, 0);
      renderPalette(paletteInput!.value);
    } else if (e.key === "Enter") {
      e.preventDefault();
      runPaletteItem(paletteIdx);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    }
  });
  paletteEl.addEventListener("mousedown", (e) => {
    if (e.target === paletteEl) closePalette();
  });
}

function closePalette() {
  paletteEl?.remove();
  paletteEl = null;
  paletteInput = null;
  paletteList = null;
  paletteHits = [];
}

function togglePalette() {
  if (paletteEl) closePalette();
  else openPalette();
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
  assistant: {
    // 助手：AI 智能体（靛蓝，机器人造型）
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#6366f1"/><g fill="#fff"><rect x="6.8" y="9" width="10.4" height="8" rx="2.4"/><circle cx="12" cy="5.4" r="1.1"/><rect x="11.3" y="6" width="1.4" height="2.2" rx="0.7"/></g><circle cx="9.9" cy="13" r="1.05" fill="#6366f1"/><circle cx="14.1" cy="13" r="1.05" fill="#6366f1"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="8.5" width="14" height="10" rx="3"/><path d="M12 8.5V5.6"/><circle cx="12" cy="4.4" r="1.1"/><path d="M9.3 13.5h.01M14.7 13.5h.01"/></svg>`,
  },
  disk: {
    // 网盘：云朵 + 上传箭头（天蓝）
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#0ea5e9"/><path d="M7.5 15.5a3.3 3.3 0 0 1-.3-6.6 4.4 4.4 0 0 1 8.5-.9 3.4 3.4 0 0 1 1.4 6.5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 17.5v-5.2M9.8 14.3l2.2-2.2 2.2 2.2" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 15.5a3.3 3.3 0 0 1-.3-6.6 4.4 4.4 0 0 1 8.5-.9 3.4 3.4 0 0 1 1.4 6.5"/><path d="M12 17.5v-5.2M9.8 14.3l2.2-2.2 2.2 2.2"/></svg>`,
  },
  profile: {
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#10b981"/><circle cx="12" cy="9.6" r="3" fill="#fff"/><path d="M5.8 18.6c.9-2.6 3.3-4.1 6.2-4.1s5.3 1.5 6.2 4.1" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9.3" r="3.3"/><path d="M5.3 19.2c.9-2.9 3.5-4.6 6.7-4.6s5.8 1.7 6.7 4.6"/></svg>`,
  },
  calendar: {
    // 日历视图：日历牌（橙）
    active: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#f97316"/><rect x="6" y="7" width="12" height="11" rx="2" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M6 10.5h12" stroke="#fff" stroke-width="1.8"/><g fill="#fff"><rect x="8.6" y="12.4" width="2" height="2" rx="0.5"/><rect x="11" y="12.4" width="2" height="2" rx="0.5"/><rect x="13.4" y="12.4" width="2" height="2" rx="0.5"/></g><path d="M9 5v2.6M15 5v2.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>`,
    idle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2.5"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>`,
  },
};

// ---------- 「日历视图」：历史消息按 日/周/月 查看，点击明细用 webview 打开原文 ----------

type CalView = "month" | "week" | "day";
let calView: CalView = "month";
let calAnchor = new Date(); // 月=锚点月；周/日=锚点日
let calSel = ""; // 明细选中的日期 yyyy-mm-dd（空=跟随今天）

function calKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function calParse(s: string): Date | null {
  const d = new Date((s || "").replace(/-/g, "/"));
  return isNaN(d.getTime()) ? null : d;
}

async function renderCalendar(content: HTMLElement) {
  content.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-head">
        <button class="disk-btn ghost" id="cal-prev" title="上一${calView === "month" ? "月" : calView === "week" ? "周" : "日"}">‹</button>
        <span class="cal-title" id="cal-title"></span>
        <button class="disk-btn ghost" id="cal-next" title="下一${calView === "month" ? "月" : calView === "week" ? "周" : "日"}">›</button>
        <span class="tb-spacer"></span>
        <div class="cal-tabs">
          <button class="sync-tab${calView === "month" ? " on" : ""}" data-v="month">月</button>
          <button class="sync-tab${calView === "week" ? " on" : ""}" data-v="week">周</button>
          <button class="sync-tab${calView === "day" ? " on" : ""}" data-v="day">日</button>
        </div>
      </div>
      <div class="cal-grid" id="cal-grid"><div class="empty">正在加载历史消息…</div></div>
      <div class="cal-detail" id="cal-detail"></div>
    </div>`;
  // 一次拉两个来源最近各 200 条，按 time_str 归日（够用且避免翻页）
  let msgs: HistoryMessage[] = [];
  try {
    const [sys, per] = await Promise.all([
      api.getHistoryMessages("system", "", 0, 200),
      api.getHistoryMessages("personal", "", 0, 200),
    ]);
    msgs = [...sys, ...per]
      .filter((m) => calParse(m.time_str))
      .sort((a, b) => calParse(b.time_str)!.getTime() - calParse(a.time_str)!.getTime());
  } catch {
    /* 拉取失败 → 空日历 + 提示 */
  }
  calMsgCache = msgs;
  if (!calSel) calSel = calKey(new Date());
  document.getElementById("cal-prev")!.addEventListener("click", () => {
    calAnchor = calShift(calAnchor, -1);
    drawCal();
  });
  document.getElementById("cal-next")!.addEventListener("click", () => {
    calAnchor = calShift(calAnchor, 1);
    drawCal();
  });
  document.querySelectorAll<HTMLButtonElement>(".cal-tabs .sync-tab").forEach((b) =>
    b.addEventListener("click", () => {
      calView = (b.dataset.v as CalView) || "month";
      renderCalendar(content);
    }),
  );
  drawCal();
}

let calMsgCache: HistoryMessage[] = [];

function calShift(d: Date, dir: number): Date {
  const n = new Date(d);
  n.setHours(12, 0, 0, 0);
  if (calView === "month") n.setMonth(n.getMonth() + dir);
  else if (calView === "week") n.setDate(n.getDate() + dir * 7);
  else n.setDate(n.getDate() + dir);
  return n;
}

function drawCal(): void {
  const grid = document.getElementById("cal-grid");
  const title = document.getElementById("cal-title");
  if (!grid || !title) return;
  const counts = new Map<string, number>();
  for (const m of calMsgCache) {
    const d = calParse(m.time_str)!;
    const k = calKey(d);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const todayK = calKey(new Date());
  let html = "";
  if (calView === "month") {
    const y = calAnchor.getFullYear();
    const mo = calAnchor.getMonth();
    const total = calMsgCache.filter((m) => {
      const d = calParse(m.time_str)!;
      return d.getFullYear() === y && d.getMonth() === mo;
    }).length;
    title.textContent = `${y} 年 ${mo + 1} 月 · ${total} 条`;
    const first = new Date(y, mo, 1);
    const start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7)); // 周一开头
    html = ["一", "二", "三", "四", "五", "六", "日"].map((d) => `<div class="cal-dow">${d}</div>`).join("");
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const k = calKey(d);
      const out = d.getMonth() !== mo ? " out" : "";
      const c = counts.get(k);
      html += `<button class="cal-cell${out}${k === calSel ? " sel" : ""}${k === todayK ? " today" : ""}" data-k="${k}">
        <span class="cal-day">${d.getDate()}</span>${c ? `<span class="cal-count">${c}</span>` : ""}</button>`;
    }
  } else if (calView === "week") {
    const base = new Date(calAnchor);
    base.setHours(12, 0, 0, 0);
    base.setDate(base.getDate() - ((base.getDay() + 6) % 7));
    const end = new Date(base);
    end.setDate(base.getDate() + 6);
    let total = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      total += counts.get(calKey(d)) || 0;
    }
    title.textContent = `${calKey(base)} ~ ${calKey(end)} · ${total} 条`;
    for (let i = 0; i < 7; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const k = calKey(d);
      const c = counts.get(k) || 0;
      html += `<button class="cal-cell cal-wk${k === calSel ? " sel" : ""}${k === todayK ? " today" : ""}" data-k="${k}">
        <span class="cal-day">${d.getMonth() + 1}/${d.getDate()} ${"日一二三四五六"[d.getDay()]}</span>
        <span class="cal-count${c ? "" : " zero"}">${c}</span></button>`;
    }
  } else {
    const k = calKey(calAnchor);
    calSel = k;
    title.textContent = `${k} · ${counts.get(k) || 0} 条`;
    html = `<div class="cal-daycard${counts.get(k) ? " has" : ""}" data-k="${k}">
      <span class="cal-day">${calAnchor.getDate()} 日</span>
      <span class="cal-count${counts.get(k) ? "" : " zero"}">${counts.get(k) || 0}</span></div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll<HTMLElement>("[data-k]").forEach((el) =>
    el.addEventListener("click", () => {
      calSel = el.dataset.k || calSel;
      drawCal();
    }),
  );
  calDrawDetail();
}

function calDrawDetail(): void {
  const box = document.getElementById("cal-detail");
  if (!box) return;
  // 明细按时间先后（升序）排列——三种视图通用
  const items = calMsgCache
    .filter((m) => calKey(calParse(m.time_str)!) === calSel)
    .sort((a, b) => calParse(a.time_str)!.getTime() - calParse(b.time_str)!.getTime());
  const d = calParse(calSel);
  const head = d
    ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 明细（${items.length}）`
    : "明细";
  box.innerHTML =
    `<div class="cal-dt-head">${head}</div>` +
    (items.length
      ? items
          .map((m) => {
            const ty = msgTypeOf(m.mc);
            const hm = (calParse(m.time_str) || new Date()).toTimeString().slice(0, 5);
            return `<button class="cal-item" data-url="${esc(m.url)}" title="点击打开原文">
              <span class="cal-hm">${hm}</span>
              <span class="msg-cat" style="color:${ty.color};background:${ty.color}14">${esc(ty.label)}</span>
              <span class="cal-title2">${esc(m.title)}</span>
              ${m.sender ? `<span class="cal-sender">${esc(m.sender)}</span>` : ""}
            </button>`;
          })
          .join("")
      : `<div class="empty">该日无历史消息</div>`);
  box.querySelectorAll<HTMLButtonElement>(".cal-item").forEach((b) =>
    b.addEventListener("click", () => {
      if (b.dataset.url) void openUrl(b.dataset.url);
    }),
  );
}

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
          <button class="nav-btn" data-tab="messages" title="消息"><span class="tab-badge" id="badge-messages"></span><span class="nav-ico idle">${ICONS.messages.idle}</span><span class="nav-ico active">${ICONS.messages.active}</span><span class="nav-label">消息</span></button>
          <button class="nav-btn" data-tab="todos" title="待办"><span class="tab-badge" id="badge-todos"></span><span class="nav-ico idle">${ICONS.todos.idle}</span><span class="nav-ico active">${ICONS.todos.active}</span><span class="nav-label">待办</span></button>
          ${settings?.ops_product ? `<button class="nav-btn" data-tab="ops" title="运维"><span class="nav-ico idle">${ICONS.ops.idle}</span><span class="nav-ico active">${ICONS.ops.active}</span><span class="nav-label">运维</span></button>` : ""}
          <button class="nav-btn" data-tab="docs" title="文档"><span class="nav-ico idle">${ICONS.docs.idle}</span><span class="nav-ico active">${ICONS.docs.active}</span><span class="nav-label">文档</span></button>
          <button class="nav-btn" data-tab="spaces" title="空间"><span class="nav-ico idle">${ICONS.spaces.idle}</span><span class="nav-ico active">${ICONS.spaces.active}</span><span class="nav-label">空间</span></button>
          <button class="nav-btn" data-tab="disk" title="网盘"><span class="nav-ico idle">${ICONS.disk.idle}</span><span class="nav-ico active">${ICONS.disk.active}</span><span class="nav-label">网盘</span></button>
          <button class="nav-btn" data-tab="quick" title="快捷功能"><span class="nav-ico idle">${ICONS.quick.idle}</span><span class="nav-ico active">${ICONS.quick.active}</span><span class="nav-label">快捷</span></button>
          <button class="nav-btn" data-tab="assistant" title="助手"><span class="nav-ico idle">${ICONS.assistant.idle}</span><span class="nav-ico active">${ICONS.assistant.active}</span><span class="nav-label">助手</span></button>
          <button class="nav-btn" data-tab="calendar" title="日历视图（历史消息按日期查看）"><span class="nav-ico idle">${ICONS.calendar.idle}</span><span class="nav-ico active">${ICONS.calendar.active}</span><span class="nav-label">日历</span></button>
          <button class="nav-btn collapse-btn" id="btn-collapse" title="折叠列表页"><span class="nav-ico idle">${listCollapsed ? UNFOLD_LIST_SVG : FOLD_LIST_SVG}</span></button>
          <button class="nav-btn nav-help" id="btn-help" title="帮助（使用手册）"><span class="nav-ico idle">${HELP_SVG}</span><span class="nav-label">帮助</span></button>
          <button class="nav-btn nav-bottom" data-tab="profile" title="我的"><span class="nav-ico idle">${ICONS.profile.idle}</span><span class="nav-ico active">${ICONS.profile.active}</span><span class="nav-label">我的</span></button>
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

  // 导航栏功能名称显隐（「我的 → 显示导航栏名称」，默认关闭）
  applyNavLabels();

  document.getElementById("btn-hide")!.addEventListener("click", () => void win.hide());
  // 全屏/默认模式切换
  document.getElementById("btn-mode")!.addEventListener("click", () => {
    void setLayoutMode(layoutMode === "full" ? "mini" : "full");
  });
  // 折叠/恢复列表页（仅全屏三栏模式；切小窗时由 setLayoutMode 自动复位）
  document.getElementById("btn-collapse")!.addEventListener("click", () => {
    setListCollapsed(!listCollapsed);
  });
  // 帮助：以 webview 方式打开内置使用手册（manual.html，随包分发；生产 tauri://localhost，开发同 origin）
  document.getElementById("btn-help")!.addEventListener("click", () => void openUrl(HELP_URL));
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
    // 智能体列表强制刷新（旁路 1h 缓存）：助手页开着则重渲染；
    // 写 aif_agents_bust 广播迷你条失效其本地缓存
    api.getAiAgents(true)
      .then(() => {
        localStorage.setItem("aif_agents_bust", String(Date.now()));
        if (currentTab === "assistant") switchTab("assistant");
      })
      .catch(() => {});
    toast("正在刷新数据");
    setTimeout(() => pollIco.classList.remove("spinning"), 700);
  });
  // 智能体列表低频预热：1 小时一次（授权变更最迟 1 小时后可见；刷新按钮可即时强制）
  setInterval(() => {
    void api.getAiAgents().catch(() => {});
  }, 3_600_000);
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
  else if (tab === "disk") void renderDisk(content);
  else if (tab === "assistant") void renderAssistant(content);
  else if (tab === "calendar") void renderCalendar(content);
  else renderProfile(content);
}

/** 导航栏功能名称显隐：sidenav 挂 .hide-labels 时隐藏全部 nav-label（图标尺寸不变） */
function applyNavLabels(): void {
  document.getElementById("sidenav")?.classList.toggle("hide-labels", !settings?.nav_show_labels);
}

/** 智能体会话页：实测 2026-10-14（curl 登录态验证）——
 *  - DCP：/DCP/ai/index.htm?aiAgentId=<id> 服务端注入 let agentId="<id>"，进入即专用智能体问答；
 *  - AIF：/AIF/ai/chat/index.htm?aiAgentId=<id>（B/S 原生 top.openNewTab 行为）。
 *  注意参数名是 aiAgentId（agentId 不生效）；图标由 Rust 侧归一化为绝对 URL */
function agentChatUrl(id: string): string {
  const base = (settings?.base_url || "").replace(/\/+$/, "");
  return settings?.ops_product
    ? `${base}/AIF/ai/chat/index.htm?aiAgentId=${encodeURIComponent(id)}`
    : `${base}/DCP/ai/index.htm?aiAgentId=${encodeURIComponent(id)}`;
}

/** 「助手」页：当前账号授权的 AI 智能体列表，点击在受控 webview 打开会话。
 *  force=true 旁路 Rust 1h 缓存（页内刷新按钮/标题栏强制刷新用） */
async function renderAssistant(content: HTMLElement, force = false) {
  const PALETTE = ["#6366f1", "#14b8a6", "#8b5cf6", "#f59e0b", "#10b981", "#f43f5e", "#06b6d4", "#3b82f6"];
  content.innerHTML = `
    <div class="type-chips"><span class="type-chip active">可用智能体</span><span class="tb-spacer"></span>
      <button class="icon-btn" id="asst-refresh" title="刷新智能体列表">⟳</button></div>
    <div id="asst-list"><div class="empty">正在加载…</div></div>`;
  const list = document.getElementById("asst-list")!;
  const draw = (agents: AiAgent[]) => {
    if (!agents.length) {
      list.innerHTML = `<div class="empty">当前账号没有已授权的智能体</div>`;
      return;
    }
    list.innerHTML = agents
      .map((a, i) => {
        const c = PALETTE[i % PALETTE.length];
        const fb = `color:${c};background:${c}1f`; // 字母 fallback：主题色淡底 + 同色字
        return `
      <div class="list-item card asst-row" data-id="${esc(a.id)}" title="点击开始会话：${esc(a.name)}">
        <div class="ico app-ico">${a.icon ? `<img src="${esc(a.icon)}" alt="" /><span class="app-ico-fallback" style="display:none;${fb}">${esc(a.name.slice(0, 1))}</span>` : `<span class="app-ico-fallback" style="${fb}">${esc(a.name.slice(0, 1))}</span>`}</div>
        <div class="li-main">
          <div class="li-title">${esc(a.name)}</div>
          ${a.description ? `<div class="li-meta" title="${esc(a.description)}">${esc(a.description)}</div>` : ""}
        </div>
        <span class="arrow">›</span>
      </div>`;
      })
      .join("");
    // 图标加载失败 → 首字母兜底（内联 onerror 被 CSP 拦截，必须用监听器）
    list.querySelectorAll<HTMLImageElement>(".app-ico img").forEach((img) =>
      img.addEventListener("error", () => {
        img.style.display = "none";
        const fb = img.nextElementSibling as HTMLElement | null;
        if (fb) fb.style.display = "";
      }),
    );
    list.querySelectorAll<HTMLElement>(".asst-row").forEach((row) =>
      row.addEventListener("click", () => void openUrl(agentChatUrl(row.dataset.id || ""))),
    );
  };
  try {
    const agents = await api.getAiAgents(force);
    draw(agents);
  } catch (e) {
    list.innerHTML = `<div class="empty">智能体列表加载失败：${esc(String(e).replace(/^"|"$/g, ""))}</div>`;
  }
  document.getElementById("asst-refresh")!.addEventListener("click", () => {
    void renderAssistant(content, true);
  });
}

// ==================== 网盘（个人空间 + 有权限空间） ====================

/** 网盘页状态（跨渲染保留，右键菜单流程依赖它） */
const diskSt = {
  spaceId: "",
  spaces: [] as { id: string; name: string; cat: string }[],
  roots: [] as DiskNode[],
  loaded: new Set<string>(), // 已拉过子节点的 subjectId
  children: new Map<string, DiskNode[]>(), // subjectId → 直接子节点
  flat: new Map<string, DiskNode>(), // id → 节点（diskNodes 返回整树扁平列表，一次灌满）
  expanded: new Set<string>(),
  checked: new Set<string>(), // 勾选的节点 id（目录 + FILE 文件；勾目录级联其子树文件）
  unchecked: new Set<string>(), // 在勾选祖先下被显式取消的节点（下载收集时剪枝，保勾选/取消语义一致）
  pending: [] as string[], // 资源管理器右键带入的待上传文件
};

/** 正在上传的目标目录 id（上传完成后刷新该目录子树） */
let diskUploadSubjectId = "";

// ---------------- 传输管理器（右侧抽屉：进行中 + 历史可回看） ----------------
type TransferItem = { name: string; ok: boolean; msg: string; muted?: boolean };
type TransferMeta = { raw?: DiskDlItem[]; dest?: string; subjectId?: string };
type TransferTask = {
  id: string;
  kind: "upload" | "download" | "delete";
  target: string; // 下载=本地目录；上传/删除=目标目录名/项数
  total: number;
  done: number;
  status: "running" | "done" | "failed" | "partial";
  startedAt: number;
  items: TransferItem[]; // 逐文件结果
  meta: TransferMeta;
  silent?: boolean; // 自动同步任务：只做统计载体，不进传输日志/徽标/持久化
};
let diskTransfers: TransferTask[] = [];
const diskSilentTasks: TransferTask[] = []; // 自动同步专用任务（内存态，不入传输日志）
const diskActiveTask: Record<"upload" | "download" | "delete", string> = { upload: "", download: "", delete: "" };

/** 当前入口键（与常用入口主键同口径：产品|网址|账号）；登录就绪前为空串（走 legacy 键） */
let diskCurEntryKey = "";
function entryKey(): string {
  const u = (settings?.base_url || "").replace(/\/+$/, "");
  return `${settings?.ops_product ? 1 : 0}|${u}|${userInfo?.account || ""}`;
}
function transferStoreKey(): string {
  return diskCurEntryKey ? `aif_disk_transfers__${diskCurEntryKey}` : "aif_disk_transfers";
}

/** 传输日志保留 7 天（读写双侧过滤，与同步日志同策略） */
const TRANSFER_TTL = 7 * 24 * 3600 * 1000;

function diskTransferLoad(): void {
  try {
    const raw = JSON.parse(localStorage.getItem(transferStoreKey()) || "[]") as TransferTask[];
    for (const t of raw) if (t.status === "running") t.status = "failed"; // 重载后残留的运行态视为中断
    const floor = Date.now() - TRANSFER_TTL;
    diskTransfers = raw.filter((t) => t && t.startedAt >= floor).slice(0, 50); // 7 天过期剔除
  } catch {
    diskTransfers = [];
  }
}
function diskTransferPersist(): void {
  try {
    const floor = Date.now() - TRANSFER_TTL;
    localStorage.setItem(
      transferStoreKey(),
      JSON.stringify(diskTransfers.filter((t) => t.startedAt >= floor).slice(0, 50)),
    );
  } catch {
    /* 忽略持久化失败 */
  }
}

/** 登录就绪（bootstrap 后调用）：按当前入口装载传输历史与同步配置。
 *  历史数据迁移：老版本只有全局键 aif_disk_transfers，首次按入口装载时一次性搬入当前入口键下。 */
function diskOnEntryReady(): void {
  const key = entryKey();
  if (key !== diskCurEntryKey) {
    diskCurEntryKey = key;
    const tk = `aif_disk_transfers__${key}`;
    if (!localStorage.getItem(tk)) {
      const legacy = localStorage.getItem("aif_disk_transfers");
      if (legacy) {
        try {
          localStorage.setItem(tk, legacy);
        } catch {
          /* 迁移失败不阻塞 */
        }
      }
    }
    diskTransferLoad();
    diskTransferBadge();
    diskTransferRender();
  }
  diskSyncArm(); // 装载本入口同步配置 + 计算第一个可执行时间点
}
function diskTransferStart(kind: "upload" | "download" | "delete", target: string, total: number, meta: TransferMeta = {}, silent = false): TransferTask {
  const task: TransferTask = { id: `tf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, kind, target, total, done: 0, status: "running", startedAt: Date.now(), items: [], meta, silent };
  if (silent) {
    diskSilentTasks.unshift(task); // 自动同步：不进传输日志/徽标/持久化，仅供逐文件统计
  } else {
    diskTransfers.unshift(task);
    diskTransferBadge();
    diskTransferRender();
    diskTransferPersist();
  }
  diskActiveTask[kind] = task.id;
  return task;
}
function diskTransferFind(kind: "upload" | "download" | "delete"): TransferTask | undefined {
  const id = diskActiveTask[kind];
  return id ? diskTransfers.find((t) => t.id === id) ?? diskSilentTasks.find((t) => t.id === id) : undefined;
}
function diskTransferItem(kind: "upload" | "download" | "delete", name: string, ok: boolean, msg: string, done?: number, total?: number): void {
  const t = diskTransferFind(kind);
  if (!t) return;
  const ex = t.items.find((i) => i.name === name);
  if (ex) {
    ex.ok = ok;
    ex.msg = msg;
  } else {
    t.items.push({ name, ok, msg });
  }
  if (typeof done === "number") t.done = done;
  if (typeof total === "number") t.total = total;
  diskTransferBadge();
  diskTransferRender();
}
function diskTransferFinish(kind: "upload" | "download" | "delete", total: number): void {
  const t = diskTransferFind(kind);
  diskActiveTask[kind] = "";
  if (!t) return;
  if (t.silent) {
    const i = diskSilentTasks.indexOf(t);
    if (i >= 0) diskSilentTasks.splice(i, 1); // 自动同步任务收尾即销毁，不留痕
    return;
  }
  t.total = total || t.total;
  t.done = t.total;
  const failed = t.items.filter((i) => !i.ok && !i.muted).length;
  t.status = failed === 0 ? "done" : failed >= t.items.filter((i) => !i.muted).length ? "failed" : "partial";
  if (!t.items.length) t.status = "failed"; // 从未收到逐文件事件（启动即失败）归为失败
  diskTransferBadge();
  diskTransferRender();
  const label = t.kind === "download" ? "下载" : t.kind === "upload" ? "上传" : "删除";
  if (failed > 0) toast(`「${label}」完成，${failed} 个失败`);
  diskTransferPersist();
}
function diskTransferFailStart(id: string, err: string): void {
  const t = diskTransfers.find((x) => x.id === id) ?? diskSilentTasks.find((x) => x.id === id);
  if (!t) return;
  t.status = "failed";
  t.items.push({ name: "启动失败", ok: false, msg: err.replace(/^"|"$/g, "") });
  if (t.silent) return; // 自动同步任务：失败统计由 diskTaskStats 读取，不打扰传输日志
  diskTransferBadge();
  diskTransferRender();
  diskTransferPersist();
}
function diskTransferBadge(): void {
  const el = document.getElementById("disk-transfer-badge");
  if (!el) return;
  const n = diskTransfers.filter((t) => t.status === "running" || t.status === "failed" || t.status === "partial").length;
  el.textContent = n ? String(n) : "";
  el.style.display = n ? "" : "none";
}
/** 全屏模式下把日志/同步抽屉锚定到内容列（网盘面板）右缘：
 *  fixed+right:0 会落在 web-pane（原生 webview 领空）被盖住，
 *  故按 #content 的视口 rect 设置 left/top/height；mini 模式清除回退窗口右缘。 */
function diskDrawerPlace(): void {
  for (const id of ["disk-drawer", "disk-sync-drawer"]) {
    const drawer = document.getElementById(id);
    if (!drawer || !drawer.classList.contains("open")) continue;
    const content = document.getElementById("content");
    if (layoutMode === "full" && content) {
      const r = content.getBoundingClientRect();
      if (r.width >= 40 && r.height >= 40) {
        drawer.style.left = `${Math.round(r.left)}px`;
        drawer.style.top = `${Math.round(r.top)}px`;
        drawer.style.height = `${Math.round(r.height)}px`;
        continue;
      }
    }
    drawer.style.left = "";
    drawer.style.top = "";
    drawer.style.height = "";
  }
}

function diskTransferRender(): void {
  const el = document.getElementById("disk-transfer-list");
  if (!el) return;
  if (!diskTransfers.length) {
    el.innerHTML = `<div class="empty">暂无传输记录</div>`;
    return;
  }
  el.innerHTML = diskTransfers
    .map((t) => {
      const failed = t.items.filter((i) => !i.ok);
      const okCnt = t.items.length - failed.length;
      const pct = t.total ? Math.round((t.done / t.total) * 100) : t.status === "running" ? 0 : 100;
      const statusTxt =
        t.status === "done"
          ? "全部成功"
          : t.status === "partial"
            ? `部分完成（${okCnt} 成功 / ${failed.length} 失败）`
            : t.status === "failed"
              ? "失败"
              : "进行中…";
      const arrow = t.kind === "download" ? "↓" : t.kind === "upload" ? "↑" : "🗑";
      const target =
        t.kind === "download" ? `下载到 ${t.target}` : t.kind === "upload" ? `上传到 ${t.target}` : `删除 ${t.target}`;
      const itemsHtml = t.items
        .map((i) => {
          const cls = i.muted ? "muted" : i.ok ? "ok" : "bad";
          const conc = i.muted ? "—" : i.ok ? "✓" : "✗";
          const title = i.muted ? "已排除" : i.ok ? "成功" : "失败";
          const msgHtml = !i.muted && i.msg && !i.ok ? `<span class="tf-msg">：${esc(i.msg)}</span>` : "";
          return `<li class="${cls}"><span class="tf-name">${esc(i.name)}</span>${msgHtml}<span class="tf-conc" title="${title}">${conc}</span></li>`;
        })
        .join("");
      const retryBtn =
        t.kind === "download" && t.meta.raw && failed.length
          ? `<button class="tf-retry" data-id="${t.id}">重试 ${failed.length} 个失败项</button>`
          : "";
      return `<div class="tf-task st-${t.status}">
        <div class="tf-head"><span class="tf-arrow">${arrow}</span><span class="tf-target" title="${esc(target)}">${esc(target)}</span><span class="tf-status">${statusTxt}</span></div>
        <div class="tf-bar"><div class="tf-fill" style="width:${pct}%"></div></div>
        <ul class="tf-items">${itemsHtml || `<li class="muted">（暂无逐文件明细）</li>`}</ul>
        ${retryBtn}
      </div>`;
    })
    .join("");
  el.querySelectorAll<HTMLButtonElement>(".tf-retry").forEach((b) =>
    b.addEventListener("click", () => void diskRetryDownload(b.dataset.id!)),
  );
}
async function diskRetryDownload(id: string): Promise<void> {
  const t = diskTransfers.find((x) => x.id === id);
  if (!t || !t.meta.raw || !t.meta.dest) return toast("缺少重试信息");
  const failedNames = new Set(t.items.filter((i) => !i.ok).map((i) => i.name));
  const items = t.meta.raw.filter((r) => failedNames.has(r.name));
  if (!items.length) return toast("没有可重试的失败项");
  await diskDownloadItems(items, t.meta.dest);
}
diskTransferLoad(); // 恢复本地持久化的传输历史

interface DiskProgressEvt {
  kind: "upload" | "download";
  file: string;
  done: number;
  total: number;
  ok: boolean;
  msg: string;
}

/** 当前用户个人空间 id（diskPersonalSpaceId 结果缓存；个人空间写权限免检） */
let diskPersonalId = "";
/** 空间写权限统一入口：个人空间特例——当前用户对自己的个人空间永远可写（免网络检查）；
 *  其他空间走 B/S isEdited 判定（10 分钟缓存），检查失败不阻塞、交由服务端兜底 */
async function diskCanWrite(spaceId: string): Promise<boolean> {
  if (diskPersonalId && spaceId === diskPersonalId) return true;
  try {
    return await api.diskSpaceCanWrite(spaceId);
  } catch {
    return true;
  }
}

/** 上传目标记忆键（按产品隔离：AIF/DCP 会话与个人空间数据不互通） */
function diskTargetKey(): string {
  return `disk_last_target_${settings?.ops_product ? "aif" : "dcp"}`;
}
function diskLastTarget(): { spaceId: string; subjectId: string; name: string } | null {
  try {
    return JSON.parse(localStorage.getItem(diskTargetKey()) || "null");
  } catch {
    return null;
  }
}

function diskLog(line: string, ok: boolean): void {
  const el = document.getElementById("disk-log");
  if (!el) return;
  const row = document.createElement("div");
  row.className = `disk-log-row ${ok ? "ok" : "bad"}`;
  row.textContent = line;
  el.prepend(row);
  while (el.children.length > 8) el.lastChild?.remove();
}

// 进度事件：上传/下载统一打到底部日志（页面不存在时忽略）
void on<DiskProgressEvt>("disk-progress", (p) => {
  const tag = p.kind === "upload" ? "上传" : "下载";
  // 完成事件：Rust 以 file="全部完成"、msg="" 标记（非逐文件事件），据此触发目录刷新
  if (p.file === "全部完成") {
    diskLog(`${tag}：全部完成（${p.total} 个）`, true);
    diskTransferFinish(p.kind, p.total);
    // 网盘同步等待方：该批任务收尾，放行同步引擎下一步
    const ws = (p.kind === "upload" ? diskJobWaiters.upload : diskJobWaiters.download).splice(0);
    for (const w of ws) w();
    // 上传完成 → 展开并重拉目标目录子树，使刚上传的文件立即可见
    if (p.kind === "upload" && diskUploadSubjectId) {
      const node = diskSt.flat.get(diskUploadSubjectId);
      if (node) {
        diskSt.expanded.add(node.id);
        diskSt.loaded.delete(node.id);
        void diskReloadSubtree(node);
      }
    }
    return;
  }
  // 逐文件事件：写入传输管理器（与底部轻量日志并存）
  if (p.file) diskTransferItem(p.kind, p.file, p.ok, p.msg || "", p.done, p.total);
  if (!p.ok && p.msg) diskLog(`${tag} ✗ ${p.file}：${p.msg}`, false);
  else if (p.msg) diskLog(`${tag} ✓ ${p.file}（${p.done}/${p.total}）`, true);
});

// 资源管理器右键「上传到个人空间」：第二实例转发文件路径。
// 有记忆目标（且与当前产品个人空间一致）→ 直接上传；否则切到网盘页等用户勾选目录
void on<string[]>("disk-upload-request", (paths) => {
  void (async () => {
    if (!paths?.length) return;
    // 多选逐个文件回调时累加，避免后者覆盖前者（Single 模式每次仅一个路径）
    diskSt.pending = Array.from(new Set([...diskSt.pending, ...paths]));
    const last = diskLastTarget();
    const pid = await api.diskPersonalSpaceId().catch(() => "");
    if (pid) diskPersonalId = pid;
    if (last && pid && last.spaceId === pid) {
      // 写权限前置检查（个人空间永远可写，diskCanWrite 内部免检）
      if (!(await diskCanWrite(last.spaceId))) {
        toast("个人空间无写权限，已取消自动上传");
        return;
      }
      toast(`开始上传 ${paths.length} 个文件到「${last.name}」`);
      try {
        await api.diskUploadFiles(last.spaceId, last.subjectId, paths);
        return;
      } catch {
        /* 直接上传失败（如未登录）→ 落到下面引导流程 */
      }
    }
    switchTab("disk");
    toast(`已就绪：请在网盘树上勾选目标目录后点「上传」（${paths.length} 个文件）`);
  })();
});

// ---------------- 网盘同步（按入口保存配置 + 后台定时双向同步） ----------------
// 语义约定：
// - 仅同步普通附件（FILE 型文章）；在线文档（DOC/MARKDOWN/RICHTEXT/EXCEL…）不支持同步，
//   配置页顶部有醒目警示，云端清单构建时直接排除。
// - 双向增量：云→本地下传本地缺失/指纹过期的文件；本地→云上传云端缺失/本地更新的文件。
//   双方都不删除文件（绝不因同步丢数据）。
// - 同步指纹（按入口持久化）：dl[相对路径]=云端 updateTime（上次下载时的云端版本）、
//   up[相对路径]=本地上传时的文件 mtime（「本地最后一次上传时间」）。命中指纹即跳过，减少重复传输。
// - 后台节拍：前端每 1 分钟 tick，且仅在 5 的整数倍分钟判定；
//   nextRunAt = 上次完成时间 + 频率（最小 5 分钟）。
//   作业单飞：上一次未结束时本次自动跳过，结束后按节拍继续。

/** 彩色分类固定色板（空间 Tab 胶囊 / 下拉分类头共用，按名称稳定取色） */
const CAT_COLORS = ["#3b82f6", "#f43f5e", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16"];
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function catColorOf(name: string): string {
  return CAT_COLORS[hashStr(name) % CAT_COLORS.length];
}

type SyncRule = {
  id: string;
  localDir: string;
  spaceId: string;
  spaceName: string;
  subjectId: string;
  /** 展示用：空间名/子目录链 */
  subjectPath: string;
  enabled: boolean;
};
type SyncCfg = {
  enabled: boolean;
  /** 同步频率（分钟）：5/15/30/60，默认 30 */
  freqMin: number;
  rules: SyncRule[];
  /** 上次同步作业完成时间（epoch ms） */
  lastRun: number;
};
/** 同步指纹（按规则分桶） */
type SyncFp = { up: Record<string, number>; dl: Record<string, number> };

let syncCfg: SyncCfg | null = null;
let syncNextRunAt = 0;
let syncBusy = false;
let syncPickRuleId = ""; // 云端目录选择器当前服务的规则 id（空=关闭）
let syncPickSpaceId = "";
let syncPickNodes: DiskNode[] | null = null;
let syncEditing = ""; // 正在编辑的规则 id（空=列表态）
let syncTab: "cfg" | "log" = "cfg"; // 同步抽屉当前页签

const SYNC_FREQS = [5, 15, 30, 60];

function syncStoreKey(): string {
  return `aif_disk_sync__${diskCurEntryKey || entryKey()}`;
}
function syncFpStoreKey(): string {
  return `aif_disk_sync_fp__${diskCurEntryKey || entryKey()}`;
}
function syncCfgLoad(): SyncCfg {
  try {
    const raw = JSON.parse(localStorage.getItem(syncStoreKey()) || "");
    if (raw && typeof raw === "object") {
      return {
        enabled: !!raw.enabled,
        freqMin: SYNC_FREQS.includes(raw.freqMin) ? raw.freqMin : 30,
        rules: Array.isArray(raw.rules) ? raw.rules : [],
        lastRun: Number(raw.lastRun) || 0,
      };
    }
  } catch {
    /* 无配置/解析失败 → 默认 */
  }
  return { enabled: false, freqMin: 30, rules: [], lastRun: 0 };
}
function syncCfgPersist(): void {
  try {
    localStorage.setItem(syncStoreKey(), JSON.stringify(syncCfg));
  } catch {
    /* 忽略持久化失败 */
  }
}
function syncFpLoad(): Record<string, SyncFp> {
  try {
    return JSON.parse(localStorage.getItem(syncFpStoreKey()) || "{}") || {};
  } catch {
    return {};
  }
}
function syncFpPersist(fp: Record<string, SyncFp>): void {
  try {
    localStorage.setItem(syncFpStoreKey(), JSON.stringify(fp));
  } catch {
    /* 忽略持久化失败 */
  }
}

// ---------- 同步日志（7 天留痕，按入口分存；读取/写入时均做 7 天过期过滤） ----------
const SYNC_LOG_TTL = 7 * 24 * 3600 * 1000;
type SyncFailItem = { name: string; msg: string };
type SyncLogEntry = {
  ts: number; // 作业时间
  rule: string; // 同步目录（网盘侧路径）
  localDir: string; // 本地目录
  dlOk: number;
  dlFail: number;
  dlFails: SyncFailItem[]; // 失败文件名 + 原因
  upOk: number;
  upFail: number;
  upFails: SyncFailItem[];
  upSkip?: number; // 同名在线文档跳过数（非失败：本地有改动但云端为在线文档，登记指纹后不再重复提示）
  skippedNoDir: number; // 云端无同名目录被跳过的本地文件数
  errors: string[]; // 规则级错误（如目录树拉取失败）
};
function syncLogStoreKey(): string {
  return `aif_disk_sync_logs__${diskCurEntryKey || entryKey()}`;
}
function syncLogLoad(): SyncLogEntry[] {
  try {
    const raw = JSON.parse(localStorage.getItem(syncLogStoreKey()) || "[]");
    if (!Array.isArray(raw)) return [];
    const floor = Date.now() - SYNC_LOG_TTL;
    return (raw as SyncLogEntry[]).filter((e) => e && e.ts >= floor); // 过期条目读取时即剔除
  } catch {
    return [];
  }
}
function syncLogPush(e: SyncLogEntry): void {
  try {
    const logs = syncLogLoad();
    logs.unshift(e);
    const floor = Date.now() - SYNC_LOG_TTL;
    localStorage.setItem(
      syncLogStoreKey(),
      JSON.stringify(logs.filter((x) => x.ts >= floor).slice(0, 300)),
    );
  } catch {
    /* 忽略持久化失败 */
  }
}
function syncLogClear(): void {
  try {
    localStorage.removeItem(syncLogStoreKey());
  } catch {
    /* 忽略 */
  }
}
/** 从传输任务读取逐文件统计（含白名单拦截/启动失败等项）；自动同步的静默任务同样可查 */
function diskTaskStats(taskId: string): { ok: number; fail: number; fails: SyncFailItem[] } {
  const t = diskTransfers.find((x) => x.id === taskId) ?? diskSilentTasks.find((x) => x.id === taskId);
  if (!t) return { ok: 0, fail: 0, fails: [] };
  const fails = t.items.filter((i) => !i.ok);
  return {
    ok: t.items.length - fails.length,
    fail: fails.length,
    fails: fails.map((i) => ({ name: i.name, msg: i.msg || "" })),
  };
}

/** 登录/切入口后装载本入口同步配置，并求「第一个可执行时间点」：
 *  从未跑过 → 立即可执行；跑过 → 上次完成 + 频率（早已过期同样立即）。 */
function diskSyncArm(): void {
  syncCfg = syncCfgLoad();
  syncEditing = "";
  syncPickRuleId = "";
  syncNextRunAt = syncCfg.lastRun > 0 ? syncCfg.lastRun + syncCfg.freqMin * 60_000 : 0;
  diskSyncRefreshDot();
  if (document.getElementById("disk-sync-body")) diskSyncRender();
}

function diskSyncRefreshDot(): void {
  const dot = document.getElementById("disk-sync-dot");
  if (dot) dot.hidden = !(syncCfg?.enabled && syncCfg.rules.some((r) => r.enabled && r.subjectId && r.localDir));
}

/** 后台节拍：每 1 分钟检查一次；未到 5 的整数倍分钟继续等待，
 *  到点后再判频率条件（nextRunAt = 上次完成 + 频率）。作业单飞：未结束自动跳过 */
function diskSyncTick(): void {
  if (!syncCfg || !syncCfg.enabled || syncBusy) return; // 作业未结束 → 下一次自动取消
  if (!syncCfg.rules.some((r) => r.enabled && r.localDir && r.subjectId)) return;
  if (new Date().getMinutes() % 5 !== 0) return; // 未到 5 的整数倍分钟 → 继续等待
  if (Date.now() < syncNextRunAt) return;
  void diskSyncRun();
}

/** 同步作业单飞等待器：Rust 上传/下载为异步队列，靠「全部完成」事件收尾放行 */
const diskJobWaiters: { upload: (() => void)[]; download: (() => void)[] } = { upload: [], download: [] };
/** 执行一个 Rust 批任务并等待其完成事件；启动即失败/30 分钟兜底超时返回 false */
function runDiskJob(kind: "upload" | "download", fn: () => Promise<unknown>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => finish(false), 30 * 60_000);
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const i = diskJobWaiters[kind].indexOf(waiter);
      if (i >= 0) diskJobWaiters[kind].splice(i, 1);
      resolve(ok);
    };
    const waiter = () => finish(true);
    diskJobWaiters[kind].push(waiter);
    void (async () => {
      try {
        await fn();
      } catch {
        finish(false); // 启动失败：不会再有完成事件，直接放行
      }
    })();
  });
}

async function diskSyncRun(): Promise<void> {
  if (!syncCfg) return;
  syncBusy = true;
  const rules = syncCfg.rules.filter((r) => r.enabled && r.localDir && r.subjectId && r.spaceId);
  try {
    for (const r of rules) {
      try {
        syncLogPush(await diskSyncRule(r));
      } catch (e) {
        const msg = String(e).replace(/^"|"$/g, "");
        diskLog(`同步 ✗ 「${r.subjectPath}」：${msg}`, false);
        syncLogPush({
          ts: Date.now(),
          rule: r.subjectPath,
          localDir: r.localDir,
          dlOk: 0,
          dlFail: 0,
          dlFails: [],
          upOk: 0,
          upFail: 0,
          upFails: [],
          skippedNoDir: 0,
          errors: [msg],
        });
      }
    }
  } finally {
    syncBusy = false;
    syncCfg.lastRun = Date.now();
    syncCfgPersist();
    syncNextRunAt = Date.now() + syncCfg.freqMin * 60_000;
    diskSyncRefreshDot();
    if (document.getElementById("disk-sync-body")) diskSyncRender();
  }
}

/** 云端规则目录子树清单：可下载文件（FILE 附件 + 在线文档，含相对路径与实际保存名）+ 目录映射。
 *  在线文档只参与「云→本地」下载（按类型导出）；「本地→云」方向禁止上传/替换在线文档。 */
function diskSyncCloudScan(tree: DiskNode[], subjectId: string): {
  files: { node: DiskNode; relDir: string; subtype: string; name: string }[];
  dirs: Map<string, string>; // relDir(小写) → subjectId
  dirRels: string[]; // 云端全部子目录（实际大小写相对路径，不含根）
} {
  const byId = new Map(tree.map((n) => [n.id, n]));
  const childrenOf = new Map<string, DiskNode[]>();
  for (const n of tree) {
    const p = diskParentId(n);
    if (!p || !byId.has(p)) continue;
    const arr = childrenOf.get(p) || [];
    arr.push(n);
    childrenOf.set(p, arr);
  }
  const files: { node: DiskNode; relDir: string; subtype: string; name: string }[] = [];
  const dirRels: string[] = [];
  const dirList: { id: string; relDir: string }[] = [{ id: subjectId, relDir: "" }];
  const walk = (id: string, rel: string) => {
    for (const c of childrenOf.get(id) || []) {
      if (c.nodeType === "subject") {
        const rrel = rel ? `${rel}/${c.name}` : c.name;
        dirRels.push(rrel);
        dirList.push({ id: c.id, relDir: rrel });
        walk(c.id, rrel);
      } else {
        const st = c.subtype;
        // FILE 附件直下；在线文档仅收录可导出类型（DOC/MARKDOWN/EXCEL/RICHTEXT/COLLEXCEL）
        if (st !== "FILE" && !DISK_SUBTYPE_EXT[st]) continue;
        const name = st === "FILE" ? diskFileName(c) : diskFileDisplay(c).name;
        files.push({ node: c, relDir: rel, subtype: st, name });
      }
    }
  };
  walk(subjectId, "");
  const dirs = new Map(dirList.map((d) => [d.relDir.toLowerCase(), d.id]));
  return { files, dirs, dirRels };
}

function syncLocalAbs(localDir: string, relPath: string): string {
  return `${localDir.replace(/[\\/]+$/, "")}\\${relPath.replace(/\//g, "\\")}`;
}

/** 执行单条规则的同步：云→本地下传 + 本地→云上传（指纹去重，均不删除）；返回本规则日志条目 */
async function diskSyncRule(r: SyncRule): Promise<SyncLogEntry> {
  const entry: SyncLogEntry = {
    ts: Date.now(),
    rule: r.subjectPath,
    localDir: r.localDir,
    dlOk: 0,
    dlFail: 0,
    dlFails: [],
    upOk: 0,
    upFail: 0,
    upFails: [],
    skippedNoDir: 0,
    errors: [],
  };
  // 关键：diskTree 只回根目录清单（扫描恒为空 → 同步数全 0 的根因）；
  // findTreeByNodeId(规则目录) 返回「全部 subject + 该目录子树下的文件」，一次调用即全子树
  const tree = await api.diskNodes(r.spaceId, r.subjectId, "subject");
  const { files, dirs, dirRels } = diskSyncCloudScan(tree, r.subjectId);
  const fpAll = syncFpLoad();
  const fp: SyncFp = fpAll[r.id] || { up: {}, dl: {} };
  const logTag = `同步「${r.subjectPath}」`;

  // ---------- 云 → 本地 ----------
  // 云端嵌套子目录（含空目录）在本地镜像建立（幂等，多级自动创建）
  for (const rel of dirRels) {
    try {
      await api.diskLocalMkdir(syncLocalAbs(r.localDir, rel));
    } catch {
      /* 单个目录建立失败不阻塞（后续文件下载仍会 create_dir_all） */
    }
  }
  const locals0 = await api.diskLocalScan(r.localDir);
  const localMap = new Map(locals0.map((f) => [f.relPath.toLowerCase(), f]));
  const dlItems: DiskDlItem[] = [];
  const dlMarks: { rel: string; updateTime: number }[] = [];
  for (const { node, relDir, subtype, name } of files) {
    if (diskEditing.has(node.id)) continue; // 编辑中：同步跳过，避免与本地编辑回传抢写时序
    const rel = relDir ? `${relDir}/${name}` : name;
    const key = rel.toLowerCase();
    const local = localMap.get(key);
    if (local) {
      // 指纹命中：上次下载后云端未变，或本文件正是本地上传的新版本 → 跳过
      if (fp.dl[key] === node.updateTime || (fp.up[key] || 0) >= node.updateTime) continue;
      // 云端比本地新（且非本地上传的版本）→ 重新下载覆盖
      if (local.mtime * 1000 >= node.updateTime) continue;
    }
    dlItems.push({ articleId: node.id, name, relDir, subtype });
    dlMarks.push({ rel: key, updateTime: node.updateTime });
  }
  if (dlItems.length) {
    // 自动同步任务 silent=true：不写传输日志，仅作逐文件统计载体
    const task = diskTransferStart("download", `同步 ↓ ${r.subjectPath}`, dlItems.length, {}, true);
    diskLog(`${logTag}：云→本地下传 ${dlItems.length} 个文件`, true);
    const ok = await runDiskJob("download", () => api.diskDownloadFiles(dlItems, r.localDir, true));
    if (ok) for (const m of dlMarks) fp.dl[m.rel] = m.updateTime;
    else diskTransferFailStart(task.id, "同步下载未正常收尾");
    const st = diskTaskStats(task.id);
    entry.dlOk = st.ok;
    entry.dlFail = st.fail;
    entry.dlFails = st.fails;
  }

  // ---------- 本地 → 云 ----------
  // 写权限前置检查：无写权限 → 整段跳过上传（云→本地下载为只读，不受影响）
  let canWrite = true;
  canWrite = await diskCanWrite(r.spaceId);
  if (!canWrite) {
    entry.errors.push("空间无写权限：本轮跳过「本地→云」上传（云→本地下载不受影响）");
    diskLog(`${logTag}：空间无写权限，跳过上传（下载不受影响）`, false);
    fpAll[r.id] = fp;
    syncFpPersist(fpAll);
    if (!dlItems.length) diskLog(`${logTag}：无变更`, true);
    return entry;
  }
  const locals = await api.diskLocalScan(r.localDir);
  // 同名登记：FILE 用真实文件名；在线文档同时登记「带导出后缀名」与「原始名」，
  // 命中在线文档的一律禁止上传/替换（在线文档只下载，云端只能在线上创建和编辑）
  const cloudMap = new Map<string, DiskNode>();
  for (const { node, relDir, name } of files) {
    const rel = relDir ? `${relDir}/${name}` : name;
    cloudMap.set(rel.toLowerCase(), node);
    if (node.subtype !== "FILE") {
      const raw = relDir ? `${relDir}/${sanitizeDiskName(node.name)}` : sanitizeDiskName(node.name);
      cloudMap.set(raw.toLowerCase(), node);
    }
  }
  // 云端目录映射副本（含同步过程中新建的目录）：relDir(小写) → subjectId
  const ensuredDirs = new Map(dirs);
  let createdDirs = 0;
  const dirErrors: string[] = [];
  /** 逐级确保云端目录存在（已存在直接命中；缺失逐级创建，命中失败返回 null） */
  const ensureCloudDir = async (segments: string[]): Promise<string | null> => {
    let rel = "";
    let parentId = r.subjectId;
    for (const seg of segments) {
      const nm = sanitizeDiskName(seg);
      rel = rel ? `${rel}/${nm}` : nm;
      const k = rel.toLowerCase();
      const known = ensuredDirs.get(k);
      if (known) {
        parentId = known;
        continue;
      }
      try {
        const res = await api.diskCreateDir(r.spaceId, parentId, nm);
        if (!res.ok || !res.id) {
          dirErrors.push(`云端目录「${rel}」创建失败：${res.msg || "未知错误"}`);
          return null;
        }
        createdDirs++;
        ensuredDirs.set(k, res.id);
        parentId = res.id;
      } catch (e) {
        dirErrors.push(`云端目录「${rel}」创建失败：${String(e).replace(/^"|"$/g, "")}`);
        return null;
      }
    }
    return parentId;
  };
  const upByDir = new Map<string, { path: string; rel: string; mtime: number }[]>();
  let skippedNoDir = 0;
  for (const f of locals) {
    const key = f.relPath.toLowerCase();
    const rawRelDir = f.relPath.includes("/") ? f.relPath.slice(0, f.relPath.lastIndexOf("/")) : "";
    // 本地目录名做云端合法性净化（非法字符替换为 _），分组与建目录均用净化后路径
    const relDir = rawRelDir ? rawRelDir.split("/").map(sanitizeDiskName).join("/") : "";
    if ((fp.up[key] || 0) === f.mtime) continue; // 指纹命中：上传后本地未改（含同名在线文档已登记）→ 静默跳过
    const cloud = cloudMap.get(key);
    if (cloud && cloud.subtype !== "FILE") {
      // 同名在线文档：不支持上传/替换。计为「跳过」而非失败，并登记指纹——
      // 文件不再修改就不再重复提示；本地改动后提示一次并刷新指纹
      entry.upSkip = (entry.upSkip || 0) + 1;
      fp.up[key] = f.mtime;
      continue;
    }
    if (cloud && diskEditing.has(cloud.id)) continue; // 该云端文件正被本地编辑：跳过
    if (cloud) {
      if (cloud.updateTime >= f.mtime * 1000) continue; // 云端同版本或更新
    }
    if (!relDir) {
      // 根级文件直接归属规则目录
      const arr = upByDir.get("") || [];
      arr.push({ path: syncLocalAbs(r.localDir, f.relPath), rel: key, mtime: f.mtime });
      upByDir.set("", arr);
      continue;
    }
    const subjectId = ensuredDirs.get(relDir.toLowerCase()) ?? (await ensureCloudDir(relDir.split("/")));
    if (!subjectId) {
      skippedNoDir++; // 云端目录创建失败 → 该文件本轮跳过
      continue;
    }
    const arr = upByDir.get(relDir) || [];
    arr.push({ path: syncLocalAbs(r.localDir, f.relPath), rel: key, mtime: f.mtime });
    upByDir.set(relDir, arr);
  }
  for (const [relDir, batch] of upByDir) {
    const subjectId = relDir ? ensuredDirs.get(relDir.toLowerCase())! : r.subjectId;
    // 自动同步任务 silent=true：不写传输日志，仅作逐文件统计载体
    const task = diskTransferStart("upload", `同步 ↑ ${r.subjectPath}${relDir ? "/" + relDir : ""}`, batch.length, {}, true);
    diskLog(`${logTag}：本→云上传 ${batch.length} 个文件${relDir ? `（${relDir}）` : ""}`, true);
    const ok = await runDiskJob("upload", () => api.diskUploadFiles(r.spaceId, subjectId, batch.map((b) => b.path)));
    if (ok) for (const b of batch) fp.up[b.rel] = b.mtime;
    else diskTransferFailStart(task.id, "同步上传未正常收尾");
    const st = diskTaskStats(task.id);
    entry.upOk += st.ok;
    entry.upFail += st.fail;
    entry.upFails.push(...st.fails);
  }
  if (createdDirs) diskLog(`${logTag}：云端新建目录 ${createdDirs} 个`, true);
  if (dirErrors.length) entry.errors.push(...dirErrors);
  entry.skippedNoDir = skippedNoDir;
  if (skippedNoDir) diskLog(`${logTag}：${skippedNoDir} 个本地文件跳过（云端目录创建失败）`, false);

  fpAll[r.id] = fp;
  syncFpPersist(fpAll);
  if (!dlItems.length && !upByDir.size) diskLog(`${logTag}：无变更`, true);
  return entry;
}

// ---------- 网盘同步配置页（抽屉） ----------

function syncFmtTime(ts: number): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function diskSyncRender(): void {
  const body = document.getElementById("disk-sync-body");
  if (!body || !syncCfg) return;
  // 页签：同步配置 / 同步日志（7 天）
  const tabs = `
    <div class="sync-tabs">
      <button class="sync-tab${syncTab === "cfg" ? " on" : ""}" data-tab="cfg">同步配置</button>
      <button class="sync-tab${syncTab === "log" ? " on" : ""}" data-tab="log">同步日志（7天）</button>
    </div>`;
  if (syncTab === "log") {
    const logs = syncLogLoad();
    const failList = (items: SyncFailItem[]) =>
      items.length
        ? `<div class="sl-fails">${items
            .map((f) => `<div class="sl-fail" title="${esc(f.msg)}">✗ ${esc(f.name)}${f.msg ? `：${esc(f.msg)}` : ""}</div>`)
            .join("")}</div>`
        : "";
    body.innerHTML =
      tabs +
      `<div class="sync-sec"><span class="sr-cap">同步日志 · 近7天（${logs.length}）</span><button class="disk-btn ghost" id="sync-log-clear">清空</button></div>
      <div class="sync-rules">${logs
        .map(
          (e) => `
        <div class="sync-rule">
          <div class="sl-head"><span class="sl-time">${syncFmtTime(e.ts)}</span><span class="sr-path" title="${esc(e.rule)}">☁ ${esc(e.rule)}</span></div>
          <div class="sr-line sr-local" title="${esc(e.localDir)}">📁 ${esc(e.localDir || "—")}</div>
          <div class="sl-stats">
            <span class="sl-ok">↓ 成功 ${e.dlOk}</span><span class="${e.dlFail ? "sl-bad" : "sl-dim"}">失败 ${e.dlFail}</span>
            <span class="sl-ok">↑ 成功 ${e.upOk}</span><span class="${e.upFail ? "sl-bad" : "sl-dim"}">失败 ${e.upFail}</span>
            ${e.upSkip ? `<span class="sl-dim" title="云端存在同名在线文档，不支持上传/替换；已登记，文件不再改动不会重复提示">跳过（同名在线文档）${e.upSkip}</span>` : ""}
            ${e.skippedNoDir ? `<span class="sl-dim">跳过（云端目录创建失败）${e.skippedNoDir}</span>` : ""}
          </div>
          ${failList(e.dlFails)}${failList(e.upFails)}
          ${e.errors.length ? `<div class="sl-fails">${e.errors.map((m) => `<div class="sl-fail">✗ ${esc(m)}</div>`).join("")}</div>` : ""}
        </div>`,
        )
        .join("") || `<div class="dd-empty">暂无同步记录：开启同步后，每次作业的时间、同步目录、成功/失败统计、失败文件名与原因都会在此留痕</div>`}</div>`;
    body.querySelector("#sync-log-clear")!.addEventListener("click", () => {
      syncLogClear();
      diskSyncRender();
    });
    body.querySelectorAll<HTMLButtonElement>(".sync-tab").forEach((b) =>
      b.addEventListener("click", () => {
        syncTab = (b.dataset.tab as "cfg" | "log") || "cfg";
        diskSyncRender();
      }),
    );
    return;
  }
  const ruleCard = (r: SyncRule) => `
    <div class="sync-rule${r.enabled ? " on" : ""}" data-id="${esc(r.id)}">
      <div class="sr-line">
        <label class="sr-en"><input type="checkbox" data-act="ren" ${r.enabled ? "checked" : ""}/>启用</label>
        <span class="sr-path" title="${esc(r.subjectPath || "未选择网盘目录")}">☁ ${esc(r.subjectPath || "未选择网盘目录")}</span>
      </div>
      <div class="sr-line sr-local" title="${esc(r.localDir || "未选择本地目录")}">📁 ${esc(r.localDir || "未选择本地目录")}</div>
      <div class="sr-btns">
        <button class="disk-btn ghost sr-del" data-act="del">删除同步关系</button>
        <span class="sr-note">删除不影响已同步的文件；如需改绑目录，请删除后用工具栏「＋同步」重新建立</span>
      </div>
    </div>`;
  const nextTxt = syncBusy
    ? "同步进行中…"
    : syncCfg.enabled
      ? (syncCfg.rules.some((x) => x.enabled && x.localDir && x.subjectId)
          ? `下次同步 ${syncFmtTime(syncNextRunAt || Date.now())}`
          : "暂无启用的规则")
      : "网盘同步暂停";
  body.innerHTML = tabs + `
    <div class="sync-warn" title="在线文档（DOC/MARKDOWN/RICHTEXT/EXCEL 等）仅参与「云→本地」下载（按类型导出），不支持上传创建/替换">
      <span class="sw-ico">⚠</span>仅同步网盘文件，在线文档只支持下载，在线文档可在线上创建和编辑
    </div>
    <div class="sync-row">
      <label class="switch">
        <input type="checkbox" id="sync-enable" ${syncCfg.enabled ? "checked" : ""}/>
        <span class="sw-track"><span class="sw-thumb"></span></span>
      </label>
      <span class="sync-state">${nextTxt}</span>
    </div>
    <div class="sync-row">
      <span class="sr-cap">同步频率</span>
      <select id="sync-freq" class="sync-freq">
        ${SYNC_FREQS.map((m) => `<option value="${m}"${m === syncCfg!.freqMin ? " selected" : ""}>${m} 分钟</option>`).join("")}
      </select>
    </div>
    <div class="sync-sec">
      <span class="sr-cap">同步规则（${syncCfg.rules.length}，用工具栏「＋同步」建立）</span>
    </div>
    <div class="sync-rules">
      ${syncCfg.rules.map(ruleCard).join("") || `<div class="dd-empty">暂无同步规则：在树上勾选一个云端目录后，点工具栏「＋同步」并选择本地目录即可建立</div>`}
    </div>
    <div class="sync-foot">上次同步：${syncFmtTime(syncCfg.lastRun)}　·　配置按当前入口独立保存</div>
    <div class="sync-picker" id="sync-picker" hidden>
      <div class="sp-head">
        <select id="sp-space" class="disk-select"></select>
        <button class="tf-close" id="sp-close" title="关闭">×</button>
      </div>
      <div class="sp-tree" id="sp-tree"><div class="dd-empty">正在加载目录…</div></div>
    </div>`;
  // 事件绑定
  body.querySelector("#sync-enable")!.addEventListener("change", (e) => {
    syncCfg!.enabled = (e.target as HTMLInputElement).checked;
    syncCfgPersist();
    // 开启 → 立即可执行第一个时间点；关闭 → 停止调度（配置内容保留）
    syncNextRunAt = syncCfg!.enabled ? 0 : Number.MAX_SAFE_INTEGER;
    diskSyncRefreshDot();
    diskSyncRender();
  });
  body.querySelector("#sync-freq")!.addEventListener("change", (e) => {
    const v = Number((e.target as HTMLSelectElement).value);
    syncCfg!.freqMin = SYNC_FREQS.includes(v) ? v : 30;
    syncCfgPersist();
    if (syncCfg!.lastRun > 0) syncNextRunAt = syncCfg!.lastRun + syncCfg!.freqMin * 60_000;
    diskSyncRender();
  });
  body.querySelectorAll<HTMLElement>(".sync-rule").forEach((card) => {
    const rule = syncCfg!.rules.find((x) => x.id === card.dataset.id);
    if (!rule) return;
    // 按钮动作（启用/停用走下方 checkbox 的 change，避免双重触发）
    card.querySelectorAll<HTMLElement>("button[data-act]").forEach((elm) =>
      elm.addEventListener("click", () => void diskSyncRuleAct(rule, (elm as HTMLElement).dataset.act!)),
    );
    const chk = card.querySelector<HTMLInputElement>("input[data-act=ren]");
    if (chk)
      chk.addEventListener("change", () => {
        rule.enabled = chk.checked;
        syncCfgPersist();
        diskSyncRefreshDot();
        diskSyncRender();
      });
  });
  // 云端目录选择器
  const picker = body.querySelector("#sync-picker") as HTMLElement;
  body.querySelector<HTMLButtonElement>("#sp-close")!.addEventListener("click", () => {
    picker.hidden = true;
    syncPickRuleId = "";
  });
  if (syncPickRuleId) {
    picker.hidden = false;
    const spSel = body.querySelector("#sp-space") as HTMLSelectElement;
    spSel.innerHTML = diskSt.spaces
      .map((s) => `<option value="${esc(s.id)}"${s.id === syncPickSpaceId ? " selected" : ""}>${esc(s.name)}</option>`)
      .join("");
    spSel.addEventListener("change", () => void syncPickerLoad(spSel.value));
    if (!syncPickSpaceId) syncPickSpaceId = diskSt.spaces[0]?.id || "";
    if (!syncPickNodes) void syncPickerLoad(syncPickSpaceId);
    else syncPickerRender();
  } else {
    syncPickNodes = null;
    syncPickSpaceId = "";
  }
  body.querySelectorAll<HTMLButtonElement>(".sync-tab").forEach((b) =>
    b.addEventListener("click", () => {
      syncTab = (b.dataset.tab as "cfg" | "log") || "cfg";
      diskSyncRender();
    }),
  );
}

/** 配置页规则行动作：选本地目录 / 选网盘目录 / 删除 */
async function diskSyncRuleAct(rule: SyncRule, act: string): Promise<void> {
  if (act === "local") {
    try {
      const dir = await diskPickDir();
      if (!dir) return;
      rule.localDir = dir;
    } catch {
      return; // 用户取消
    }
  } else if (act === "cloud") {
    syncPickRuleId = rule.id;
    syncPickSpaceId = rule.spaceId || diskSt.spaces[0]?.id || "";
    syncPickNodes = null;
  } else if (act === "del") {
    const ok = await diskConfirm("删除同步关系", `确定删除同步关系「${rule.subjectPath || rule.localDir || "未配置"}」？已同步的文件不受影响；如需改绑目录，删除后用工具栏「＋同步」重新建立。`);
    if (!ok) return;
    syncCfg!.rules = syncCfg!.rules.filter((x) => x.id !== rule.id);
    if (syncPickRuleId === rule.id) syncPickRuleId = "";
  }
  syncCfgPersist();
  diskSyncRefreshDot();
  diskSyncRender();
}

/** 云端目录选择器：加载空间目录树（仅 subject 目录参与选择）。
 *  findTree 只回根目录清单；子树逐根 findTreeByNodeId（每次返回全部 subject + 该根子树文件），按 id 去重合并。 */
async function syncPickerLoad(spaceId: string): Promise<void> {
  syncPickSpaceId = spaceId;
  syncPickNodes = null;
  const treeEl = document.getElementById("sp-tree");
  if (treeEl) treeEl.innerHTML = `<div class="dd-empty">正在加载目录…</div>`;
  try {
    const roots = await api.diskTree(spaceId);
    const map = new Map<string, DiskNode>();
    for (const n of roots) map.set(n.id, n);
    await Promise.all(
      roots.map(async (r) => {
        try {
          for (const n of await api.diskNodes(spaceId, r.id, "subject")) if (!map.has(n.id)) map.set(n.id, n);
        } catch {
          /* 单根拉取失败不阻塞选择器 */
        }
      }),
    );
    syncPickNodes = [...map.values()];
  } catch (e) {
    if (treeEl) treeEl.innerHTML = `<div class="dd-empty">目录加载失败：${esc(String(e).replace(/^"|"$/g, ""))}</div>`;
    return;
  }
  syncPickerRender();
}

function syncPickerRender(): void {
  const treeEl = document.getElementById("sp-tree");
  if (!treeEl || !syncPickNodes) return;
  const spaceName = diskSt.spaces.find((s) => s.id === syncPickSpaceId)?.name || "";
  const known = new Set(syncPickNodes.map((n) => n.id));
  const childrenOf = new Map<string, DiskNode[]>();
  const roots: DiskNode[] = [];
  for (const n of syncPickNodes) {
    if (n.nodeType !== "subject") continue;
    const p = diskParentId(n);
    if (!p || !known.has(p)) {
      roots.push(n);
      continue;
    }
    const arr = childrenOf.get(p) || [];
    arr.push(n);
    childrenOf.set(p, arr);
  }
  const render = (nodes: DiskNode[], rel: string, depth: number): string =>
    nodes
      .map((n) => {
        const rrel = rel ? `${rel}/${n.name}` : n.name;
        const kids = childrenOf.get(n.id) || [];
        return `
        <div class="sp-node" style="padding-left:${depth * 14}px">
          <span class="sp-dir">📁 ${esc(n.name)}</span>
          <button class="disk-btn sp-pick" data-id="${esc(n.id)}" data-path="${esc(rrel)}">选此目录</button>
        </div>
        ${kids.length ? render(kids, rrel, depth + 1) : ""}`;
      })
      .join("");
  treeEl.innerHTML = render(roots, "", 0) || `<div class="dd-empty">该空间暂无目录</div>`;
  treeEl.querySelectorAll<HTMLButtonElement>(".sp-pick").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      const rule = syncCfg?.rules.find((x) => x.id === syncPickRuleId);
      if (!rule) return;
      rule.spaceId = syncPickSpaceId;
      rule.spaceName = spaceName;
      rule.subjectId = b.dataset.id!;
      rule.subjectPath = `${spaceName}/${b.dataset.path || ""}`.replace(/\/$/, "");
      syncCfgPersist();
      syncPickRuleId = "";
      diskSyncRefreshDot();
      diskSyncRender();
    }),
  );
}


/** 「网盘」页：单栏全量目录树（目录+文件都在树上，勾选/级联在树上完成）+ 顶部工具条 + 底部日志 */
async function renderDisk(content: HTMLElement) {
  content.innerHTML = `
    <div class="disk-wrap">
      <div class="disk-bar">
        <button class="disk-btn" id="disk-up" title="先在树上勾选一个目标目录" disabled><span class="db-ico up">↑</span>上传</button>
        <button class="disk-btn" id="disk-dl" title="下载勾选的文件" disabled><span class="db-ico down">↓</span>下载</button>
        <button class="disk-btn danger" id="disk-del" title="删除选中的文件与目录（在线文档除外）" disabled>🗑</button>
        <button class="disk-btn ghost" id="disk-refresh" title="刷新">⟳</button>
        <button class="disk-btn" id="disk-sync-bind" title="将当前唯一勾选的云端目录与本地目录建立同步">＋同步</button>
        <span class="tb-spacer"></span>
        <button class="disk-btn ghost" id="disk-sync" title="网盘同步规则">⇄ 规则<span class="sync-dot" id="disk-sync-dot" hidden title="自动同步已开启"></span></button>
        <button class="disk-btn ghost" id="disk-transfer" title="传输日志">⇅ 日志<span class="badge" id="disk-transfer-badge"></span></button>
      </div>
      <div class="disk-spacerow">
        <select id="disk-space" class="disk-select" title="选择空间"></select>
        <span class="disk-hint" id="disk-hint"></span>
      </div>
      <div class="disk-tree" id="disk-tree"><div class="empty">正在加载…</div></div>
      <div class="disk-log" id="disk-log"></div>
      <div class="disk-confirm" id="disk-confirm" hidden>
        <div class="dc-box">
          <div class="dc-title" id="dc-title"></div>
          <div class="dc-msg" id="dc-msg"></div>
          <div class="dc-actions">
            <button class="disk-btn danger" id="dc-ok">删除</button>
            <button class="disk-btn ghost" id="dc-cancel">取消</button>
          </div>
        </div>
      </div>
      <div class="disk-drawer" id="disk-drawer">
        <div class="tf-header">传输日志<button class="tf-close" id="disk-drawer-close" title="关闭">×</button></div>
        <div class="tf-list" id="disk-transfer-list"></div>
      </div>
      <div class="disk-drawer sync" id="disk-sync-drawer">
        <div class="tf-header">网盘同步<button class="tf-close" id="disk-sync-close" title="关闭">×</button></div>
        <div class="tf-list" id="disk-sync-body"></div>
      </div>
    </div>`;
  // 空间清单：个人空间 + 有权限的空间
  const spaces: { id: string; name: string; cat: string }[] = [];
  try {
    const pid = await api.diskPersonalSpaceId();
    diskPersonalId = pid; // 缓存：个人空间写权限免检
    spaces.push({ id: pid, name: "个人空间", cat: "" });
  } catch (e) {
    document.getElementById("disk-tree")!.innerHTML =
      `<div class="empty">${esc(String(e).replace(/^"|"$/g, ""))}</div>`;
    return;
  }
  try {
    const rows = await api.getSpaces("all");
    for (const r of rows) if (r.id && r.id !== spaces[0].id) spaces.push({ id: r.id, name: r.name || "未命名空间", cat: r.category || "" });
  } catch {
    /* 空间列表拉取失败不阻塞：个人空间仍可用 */
  }
  diskSt.spaces = spaces;
  // 原生 select + optgroup 按分类分组（个人空间置顶不分组）
  const sel = document.getElementById("disk-space") as HTMLSelectElement;
  {
    const groups: { name: string; opts: { id: string; name: string }[] }[] = [];
    for (const s of spaces) {
      if (!s.cat) continue;
      let g = groups.find((x) => x.name === s.cat);
      if (!g) {
        g = { name: s.cat, opts: [] };
        groups.push(g);
      }
      g.opts.push({ id: s.id, name: s.name });
    }
    const plain = spaces
      .filter((s) => !s.cat)
      .map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`)
      .join("");
    sel.innerHTML =
      plain +
      groups
        .map(
          (g) =>
            `<optgroup label="${esc(g.name)}">${g.opts.map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join("")}</optgroup>`,
        )
        .join("");
  }
  // 恢复上次目标所在空间，否则个人空间
  const last = diskLastTarget();
  sel.value = last && spaces.some((s) => s.id === last.spaceId) ? last.spaceId : spaces[0].id;
  sel.addEventListener("change", () => void diskLoadSpace(sel.value));
  document.getElementById("disk-refresh")!.addEventListener("click", () => void diskLoadSpace(sel.value));
  // 传输/日志管理器抽屉
  const drawer = document.getElementById("disk-drawer")!;
  document.getElementById("disk-transfer")!.addEventListener("click", (e) => {
    e.stopPropagation(); // 不触发页面点击关闭，避免与本按钮的开关冲突
    drawer.classList.toggle("open");
    if (drawer.classList.contains("open")) {
      diskDrawerPlace(); // 全屏模式先按内容列定位，再渲染
      diskTransferRender();
    }
  });
  document.getElementById("disk-drawer-close")!.addEventListener("click", () =>
    drawer.classList.remove("open"),
  );
  // 网盘同步配置抽屉
  const syncDrawer = document.getElementById("disk-sync-drawer")!;
  document.getElementById("disk-sync")!.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!syncCfg) diskSyncArm(); // 登录就绪前直接打开：先装载配置
    syncDrawer.classList.toggle("open");
    if (syncDrawer.classList.contains("open")) {
      diskDrawerPlace();
      diskSyncRender();
    }
  });
  document.getElementById("disk-sync-close")!.addEventListener("click", () =>
    syncDrawer.classList.remove("open"),
  );
  // 点击主窗体页面（抽屉外任意区域）自动关闭。
  // 用 composedPath 而非 contains：抽屉内控件点击会触发 innerHTML 重建，目标节点随即脱离 DOM，
  // contains(脱离节点)=false 会把"抽屉内操作"误判为"点外部"而关闭抽屉（页签/开关一点就没的根因）。
  content.addEventListener("click", (e) => {
    const path = e.composedPath();
    if (drawer.classList.contains("open") && !path.includes(drawer)) drawer.classList.remove("open");
    if (syncDrawer.classList.contains("open") && !path.includes(syncDrawer)) syncDrawer.classList.remove("open");
  });
  diskTransferBadge();
  diskTransferRender();
  diskSyncRefreshDot();
  if (!syncCfg) diskSyncArm(); // 未登录就绪前直接打开网盘页：先装载同步配置
  document.getElementById("disk-up")!.addEventListener("click", () => {
    const d = diskFirstCheckedDir();
    if (!d) return toast("请先在树上勾选一个目标目录");
    void diskUploadTo(d);
  });
  document.getElementById("disk-dl")!.addEventListener("click", () => {
    void (async () => {
      const items = diskCheckedDlItems();
      if (!items.length) {
        return toast(
          diskSt.checked.size > 0
            ? "您勾选的是在线文档，请在详情页面中下载"
            : "请先在树上勾选要下载的文件或目录",
        );
      }
      await diskDownload(items);
    })();
  });
  document.getElementById("disk-del")!.addEventListener("click", () => void diskDeleteSelected());
  document.getElementById("disk-sync-bind")!.addEventListener("click", () => void diskSyncBindSelected());
  await diskLoadSpace(sel.value);
}

/** 工具栏「＋同步」：将树上唯一勾选的云端目录与 OS 弹窗选中的本地目录建立同步规则（归属当前入口）。
 *  规则建好后只能在「⇄ 网盘同步-同步配置」中启用/停用或删除，不支持改绑目录（需删除后重新建立）。 */
async function diskSyncBindSelected(): Promise<void> {
  if (!syncCfg) diskSyncArm();
  if (!syncCfg) return;
  // 只允许当前层级勾选一个目录：级联勾进来的下级目录/文件不算（其父级已被勾选）；
  // 跨目录勾选（如 A 目录 + B 目录的子目录）一律拒绝——即使父链缺失也要能识别
  const checkedDirs = [...diskSt.checked]
    .map((id) => diskSt.flat.get(id))
    .filter((n): n is DiskNode => !!n && n.nodeType === "subject");
  const topDirs = checkedDirs.filter((n) => !diskSt.checked.has(diskParentId(n)));
  if (topDirs.length > 1) return toast("跨目录勾选：请只保留一个目录的勾选（不同目录及其子目录不可同时勾选）");
  if (topDirs.length === 0) return toast("请在当前层级只勾选一个目录");
  const node = topDirs[0];
  // 兜底校验：任何位于该目录子树之外的勾选目录（父链异常导致的漏排除）同样拒绝
  const underIds = new Set(diskCollectUnder(node.id).map((k) => k.id));
  if (checkedDirs.some((n) => n.id !== node.id && !underIds.has(n.id))) {
    return toast("跨目录勾选：请先取消其他目录的勾选");
  }
  let localDir = "";
  try {
    localDir = await diskPickDir();
  } catch {
    return; // 用户取消
  }
  if (!localDir) return;
  const spaceId = (document.getElementById("disk-space") as HTMLSelectElement)?.value || "";
  const spaceName = diskSt.spaces.find((s) => s.id === spaceId)?.name || "";
  // 沿父链拼云端目录路径（父级不在树清单或非目录即停）
  let rel = node.name;
  let cur = node;
  for (;;) {
    const pid = diskParentId(cur);
    const p = pid ? diskSt.flat.get(pid) : undefined;
    if (!p || p.nodeType !== "subject" || p.id === spaceId) break;
    rel = `${p.name}/${rel}`;
    cur = p;
  }
  const rule: SyncRule = {
    id: `sr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    localDir,
    spaceId,
    spaceName,
    subjectId: node.id,
    subjectPath: rel ? `${spaceName}/${rel}` : spaceName,
    enabled: true,
  };
  syncCfg.rules.push(rule);
  syncCfgPersist();
  diskSyncRefreshDot();
  diskLog(`已建立同步关系：「${rule.subjectPath}」 ⇄ ${localDir}（当前入口）`, true);
  toast("同步关系已建立，可在「⇄ 网盘同步-同步配置」中查看或删除");
}

function diskFileName(n: DiskNode): string {
  const base = sanitizeDiskName(n.name);
  const ext = (n.subFileType || "").replace(/^\./, "");
  if (!ext || base.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return base;
  return `${base}.${ext}`;
}

function sanitizeDiskName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** 加载空间：全量拉取目录树。实测 findTreeByNodeId(id=某根目录) 返回「全部 subject 节点 +
 *  仅该根目录子树下的文件」——目录结构任一次调用都全量返回，文件只随所查目录返回，
 *  故对每个根各发一次请求（并行）即得完整目录树；某根失败不标 loaded，
 *  展开/级联时动态补拉兜底（见 diskFetchChildren）。查看/级联命中内存时零请求。 */
async function diskLoadSpace(spaceId: string): Promise<void> {
  diskSt.spaceId = spaceId;
  diskSt.loaded.clear();
  diskSt.children.clear();
  diskSt.flat.clear();
  diskSt.expanded.clear();
  diskSt.checked.clear();
  diskSt.unchecked.clear();
  diskSt.roots = [];
  // 重载空间时清掉上一轮的失败日志（成功日志保留），避免陈旧错误在刷新成功后仍残留
  const logEl = document.getElementById("disk-log");
  if (logEl) logEl.querySelectorAll(".disk-log-row.bad").forEach((r) => r.remove());
  try {
    diskSt.roots = await api.diskTree(spaceId);
  } catch (e) {
    document.getElementById("disk-tree")!.innerHTML =
      `<div class="empty">${esc(String(e).replace(/^"|"$/g, ""))}</div>`;
    return;
  }
  for (const n of diskSt.roots) diskSt.flat.set(n.id, n);
  await Promise.all(
    diskSt.roots.map(async (r) => {
      try {
        diskIndexAll(await api.diskNodes(spaceId, r.id, "subject"));
      } catch (e) {
        diskLog(`拉取「${r.name}」子树失败：${esc(String(e).replace(/^"|"$/g, ""))}`, false);
      }
    }),
  );
  diskMarkLoadedFromIndex();
  // 默认全部折叠：用户点目录名逐级展开
  diskRenderTree();
  diskUpdateButtons();
}

/** 把扁平节点列表灌入 flat 并按 pid/pids 挂到 children（幂等去重） */
function diskIndexAll(all: DiskNode[]): void {
  for (const n of all) diskSt.flat.set(n.id, n);
  for (const n of all) {
    if (diskSt.roots.some((r) => r.id === n.id)) continue;
    const pid = diskParentId(n);
    if (!pid) continue;
    const arr = diskSt.children.get(pid) || [];
    if (!arr.some((k) => k.id === n.id)) arr.push(n);
    diskSt.children.set(pid, arr);
  }
}

/** 凡 children 索引里有挂载项的目录都视为已加载（其子节点已在响应中见过）。
 *  无挂载项的目录（空目录/子树未返回）保持未加载，展开时补拉——
 *  这是「不能展开只显示第一层」的关键防御：绝不给没见过子节点的目录标 loaded */
function diskMarkLoadedFromIndex(): void {
  for (const [pid, kids] of diskSt.children) {
    if (kids.length && diskSt.flat.get(pid)?.nodeType === "subject") diskSt.loaded.add(pid);
  }
}

/** 节点父 id：优先 pid；否则 pids 祖先链（尾部含自身）取倒数第二个 */
function diskParentId(n: DiskNode): string {
  if (n.pid) return n.pid;
  const chain = (n.pids || "")
    .split(",")
    .map((s) => s.trim())
    .filter((id) => id && id !== n.id);
  return chain.length ? chain[chain.length - 1] : "";
}

/** 动态拉取目录子列表：全量索引缺失时兜底请求（展开/级联选中触发），走统一索引挂载 */
async function diskFetchChildren(subjectId: string): Promise<DiskNode[]> {
  if (diskSt.loaded.has(subjectId)) return diskSt.children.get(subjectId) || [];
  const all = await api.diskNodes(diskSt.spaceId, subjectId, "subject");
  diskIndexAll(all);
  diskMarkLoadedFromIndex();
  diskSt.loaded.add(subjectId); // 该目录子列表已确认（空目录也标记，避免重复请求）
  return diskSt.children.get(subjectId) || [];
}

/** 确保目录子列表可用（内存命中或动态拉取） */
async function diskEnsureLoaded(node: DiskNode): Promise<void> {
  if (!diskSt.loaded.has(node.id)) {
    try {
      await diskFetchChildren(node.id);
    } catch (e) {
      diskLog(`读取目录「${node.name}」失败：${esc(String(e).replace(/^"|"$/g, ""))}`, false);
    }
  }
}

/** 重新拉取目录子树并替换旧挂载（上传完成后刷新用） */
async function diskReloadSubtree(node: DiskNode): Promise<void> {
  try {
    const all = await api.diskNodes(diskSt.spaceId, node.id, "subject");
    diskDropSubtree(node.id);
    diskIndexAll(all);
    diskMarkLoadedFromIndex();
    diskSt.loaded.add(node.id);
  } catch (e) {
    diskLog(`刷新「${node.name}」失败：${esc(String(e).replace(/^"|"$/g, ""))}`, false);
  }
  diskRenderTree();
}

/** 删除目录的旧子树挂载（children + flat；节点自身保留） */
function diskDropSubtree(id: string): void {
  for (const k of diskSt.children.get(id) || []) {
    if (k.nodeType === "subject") diskDropSubtree(k.id);
    diskSt.flat.delete(k.id);
  }
  diskSt.children.delete(id);
}

/** 递归确保子树已在内存（级联选中前调用；全量命中时零请求） */
async function diskEnsureSubtree(root: DiskNode): Promise<void> {
  await diskFetchChildren(root.id);
  for (const n of diskSt.children.get(root.id) || []) {
    if (n.nodeType === "subject") await diskEnsureSubtree(n);
  }
}

/** 渲染目录树：目录 + 最末级文件叶子，节点带 checkbox */
/** 在线文档类型 → 展示/下载后缀（B/S 文章本身无后缀，按官方类型枚举映射虚拟扩展名）。
 *  富文本(RICHTEXT)导出为 DOCX、在线 Excel(EXCEL/COLLEXCEL)导出为 XLSX、MARKDOWN 保留 .md 原文、
 *  DOC 导出为 .docx —— 与后端 disk_download_files 的 transfer/download.htm exportType 矩阵对齐。 */
const DISK_SUBTYPE_EXT: Record<string, string> = {
  DOC: "docx",
  MARKDOWN: "md",
  EXCEL: "xlsx",
  COLLEXCEL: "xlsx",
  RICHTEXT: "docx",
};

/** 文件行展示名与后缀：FILE 用真实 subFileType；在线文档用类型映射的虚拟后缀 */
function diskFileDisplay(n: DiskNode): { name: string; ext: string } {
  const ext = (n.subtype === "FILE" ? n.subFileType || "" : DISK_SUBTYPE_EXT[n.subtype] || "")
    .replace(/^\./, "")
    .toLowerCase();
  return { name: ext ? `${n.name}.${ext}` : n.name, ext };
}

/** 文件行类型图标：复用文档列表的 docTypeStyle 图标体系（W/X/P/PDF/通用彩条扩展名） */
function diskFileIconHtml(n: DiskNode): string {
  const { ext } = diskFileDisplay(n);
  // docTypeStyle 只读 file_type/atype，用磁盘节点字段伪造行即可
  const style = docTypeStyle({ file_type: ext, atype: n.subtype } as DocRow);
  let body: string;
  if (n.subtype === "FILE" && !ext) body = genericGlyph("#4f46e5", "FILE");
  else if (style.kind === "word") body = officeGlyph("W", style.color);
  else if (style.kind === "excel") body = officeGlyph("X", style.color);
  else if (style.kind === "ppt") body = officeGlyph("P", style.color);
  else if (style.kind === "pdf") body = pdfGlyph(style.color);
  else body = genericGlyph(style.color, style.label);
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

/** 文档查看页 URL：B/S 官方 detail 页，DOC/MARKDOWN/FILE(docx/txt…) 实测通用（2026-10-14 探测） */
function diskArticleUrl(n: DiskNode): string {
  const base = (settings?.base_url || "").replace(/\/+$/, "");
  const root = settings?.ops_product ? "AIF" : "DCP";
  return `${base}/${root}/knowledge/article/detail.htm?id=${encodeURIComponent(n.id)}`;
}

// ---------- 网盘文件点击菜单 / 内置 MD 编辑器 / 本地 Office 编辑回传 ----------

/** 编辑中登记（articleId → 编辑上下文）：定时同步作业跳过这些云端文件，避免与回传抢写时序 */
type DiskEditingEnt = {
  articleId: string;
  spaceId: string;
  subjectId: string;
  path: string;
  name: string;
  cloudUpdateTime: number;
  startedAt: number;
};
const diskEditing = new Map<string, DiskEditingEnt>();

const DISK_OFFICE_EXTS = ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "wps"];

/** 小菜单按钮图标（stroke=currentColor，随配色着色） */
const DFM_ICONS = {
  open: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 13v6H5V5h6"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1.2-4.2L16 5l3 3L8.2 18.8 4 20z"/></svg>`,
  upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6"/><path d="m6 11 6-6 6 6"/><path d="M5 21h14"/></svg>`,
};

/** 点击文件行弹出的屏幕小菜单（fixed 定位，点击外部/Esc 关闭）：
 *  在线文档 → 在线打开；FILE 附件 → 在线查看（+MD 编辑 / Office 只读与编辑回传）；
 *  按钮彩色（图标 + 左侧色条 + hover 染色）；标题行带类型胶囊（网盘附件/在线文档） */
let dfmOpenEvent: Event | null = null; // 打开菜单的那次点击事件：全局关闭器对它放行，避免「开完即关」
function diskFileMenu(node: DiskNode, x: number, y: number, openEvent?: Event): void {
  diskFileMenuClose();
  const disp = diskFileDisplay(node);
  const isFile = node.nodeType === "article" && node.subtype === "FILE";
  const isMd = isFile && (disp.ext === "md" || disp.ext === "markdown");
  const isOffice = isFile && DISK_OFFICE_EXTS.includes(disp.ext);
  const btns: { act: string; label: string; title: string; icon: string; color: string }[] = [];
  if (!isFile) {
    btns.push({ act: "open", label: "在线文档，点击打开", title: "通过 webview 打开 B/S 在线查看页", icon: DFM_ICONS.open, color: "#8b5cf6" });
  } else {
    btns.push({ act: "open", label: "在线查看", title: "通过 webview 打开 B/S 详情页", icon: DFM_ICONS.open, color: "#0ea5e9" });
    if (isMd) btns.push({ act: "md", label: "编辑MarkDown文件", title: "内置本地 MD 编辑器，改完上传网盘替换", icon: DFM_ICONS.pencil, color: "#10b981" });
    if (isOffice) {
      btns.push({ act: "ro", label: "本地只读查看", title: "下载到本地并设只读，用本机关联程序打开（不回传）", icon: DFM_ICONS.eye, color: "#64748b" });
      btns.push({ act: "edit", label: "本地编辑后上传", title: "下载后用本机关联程序编辑；关闭后自动比对 mtime 回传", icon: DFM_ICONS.upload, color: "#f59e0b" });
    }
  }
  const menu = document.createElement("div");
  menu.id = "disk-file-menu";
  const tag = isFile
    ? `<span class="dfm-tag" style="--tc:#0ea5e9">网盘附件</span>`
    : `<span class="dfm-tag" style="--tc:#8b5cf6">在线文档</span>`;
  menu.innerHTML =
    `<div class="dfm-title"><span class="dfm-name" title="${esc(disp.name)}">${esc(disp.name)}</span>${tag}</div>` +
    btns
      .map(
        (b) =>
          `<button class="dfm-btn" data-act="${b.act}" style="--mc:${b.color}" title="${b.title}"><span class="dfm-ico" style="color:${b.color}">${b.icon}</span>${esc(b.label)}</button>`,
      )
      .join("");
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - r.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - r.height - 8))}px`;
  dfmOpenEvent = openEvent ?? null;
  menu.querySelectorAll<HTMLButtonElement>(".dfm-btn").forEach((b) =>
    b.addEventListener("click", () => {
      diskFileMenuClose();
      const act = b.dataset.act;
      if (act === "open") void openUrl(diskArticleUrl(node));
      else if (act === "md") void diskMdEdit(node);
      else if (act === "ro") void diskOfficeOpen(node, true);
      else if (act === "edit") void diskOfficeOpen(node, false);
    }),
  );
}
function diskFileMenuClose(): void {
  dfmOpenEvent = null;
  document.getElementById("disk-file-menu")?.remove();
}
// 全局关闭器（模块加载即注册一次，替代旧的 once 监听）：
// 旧实现的缺陷——once 监听在冒泡末段触发，而文件行 handler 先执行并重建了菜单，
// 导致「点文件2 → 旧菜单关 + 新菜单被同一次点击的关闭器杀掉」，且每次重建都会再挂一个
// 新 once 监听，形成「永远差一拍」的死循环。现在：打开菜单的那次点击直接放行，其余点击关闭。
document.addEventListener("click", (ev) => {
  const menu = document.getElementById("disk-file-menu");
  if (!menu) return;
  if (ev === dfmOpenEvent) return; // 本次点击就是打开菜单的动作
  if (ev.composedPath().includes(menu)) return; // 点在菜单内部，由按钮自身处理
  diskFileMenuClose();
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") diskFileMenuClose();
});

/** 下载 FILE 附件到编辑暂存目录（覆盖写），返回本地路径；失败抛错 */
async function diskEditDownload(node: DiskNode, name: string): Promise<string> {
  const editDir = await api.diskEditDir();
  const ok = await runDiskJob(
    "download",
    () => api.diskDownloadFiles([{ articleId: node.id, name, relDir: "", subtype: "FILE" }], editDir, true),
  );
  if (!ok) throw new Error("下载未完成");
  return `${editDir.replace(/[\\/]+$/, "")}/${name}`;
}

/** 本地只读查看 / 本地编辑后上传（Office 系）：Rust 设只读属性 + 拉起关联程序；
 *  编辑模式由 Rust 监视句柄占用 + ~$ 锁文件，释放后 emit disk-edit-done 回前端回传 */
async function diskOfficeOpen(node: DiskNode, readonly: boolean): Promise<void> {
  const disp = diskFileDisplay(node);
  try {
    const path = await diskEditDownload(node, disp.name);
    if (readonly) {
      await api.diskEditStart(path, true);
      toast("已下载并以只读方式打开（不回传）");
      return;
    }
    diskEditing.set(node.id, {
      articleId: node.id,
      spaceId: diskSt.spaceId,
      subjectId: diskParentId(node),
      path,
      name: disp.name,
      cloudUpdateTime: node.updateTime,
      startedAt: Date.now(),
    });
    await api.diskEditStart(path, false);
    diskLog(`编辑中：「${disp.name}」——本机关闭后自动比对回传（监视 2 小时内有效）`, true);
    toast("已下载并打开编辑；关闭编辑器后自动比对上传");
  } catch (e) {
    toast(`本地打开失败：${String(e).replace(/^"|"$/g, "")}`);
  }
}

/** 内置本地 MD 编辑器入口：下载 → 读文本 → 模态编辑 */
async function diskMdEdit(node: DiskNode): Promise<void> {
  const disp = diskFileDisplay(node);
  try {
    const path = await diskEditDownload(node, disp.name);
    const text = (await api.diskFileText(path)) ?? "";
    diskEditing.set(node.id, {
      articleId: node.id,
      spaceId: diskSt.spaceId,
      subjectId: diskParentId(node),
      path,
      name: disp.name,
      cloudUpdateTime: node.updateTime,
      startedAt: Date.now(),
    });
    diskMdEditorShow(node.id, disp.name, path, text);
  } catch (e) {
    toast(`打开失败：${String(e).replace(/^"|"$/g, "")}`);
  }
}

/** MD 预览渲染：markdown-it（完整 GFM：表格/代码块/任务列表/删除线/自动链接），本地打包无 CDN */
const mdit = new MarkdownIt({ html: false, linkify: true, breaks: true });
function mdToHtml(src: string): string {
  return mdit.render(src);
}

/** MD 编辑模态层（全屏、左右分栏：左编辑右实时预览）：
 *  编辑区 CodeMirror 6，预览 markdown-it；底部「保存上传/取消编辑」彩色按钮。 */
let mdPreviewTimer = 0;
const cmTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "transparent", color: "inherit" },
  ".cm-scroller": { fontFamily: 'Consolas, "Courier New", monospace', lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "var(--text-3, #999)" },
  ".cm-activeLine": { backgroundColor: "rgba(127, 127, 127, .08)" },
  ".cm-activeLineGutter": { backgroundColor: "rgba(127, 127, 127, .08)" },
  "&.cm-focused": { outline: "none" },
});

function diskMdEditorShow(articleId: string, name: string, path: string, text: string): void {
  document.getElementById("md-edit-ov")?.remove();
  const ov = document.createElement("div");
  ov.id = "md-edit-ov";
  ov.innerHTML = `
    <div class="md-edit">
      <div class="me-head">
        <span class="me-title" title="${esc(name)}">MD 编辑 · ${esc(name)}</span>
        <span class="me-mode">左侧编辑 · 右侧实时预览</span>
      </div>
      <div class="me-split">
        <div id="me-editor" class="me-editor"></div>
        <div id="me-view" class="me-view"></div>
      </div>
      <div class="me-foot">
        <button class="disk-btn me-btn" id="me-upload" style="--mc:#10b981" title="上传前会做云端冲突检查">保存上传</button>
        <button class="disk-btn me-btn" id="me-cancel" style="--mc:#64748b" title="放弃修改，不上传">取消编辑</button>
        <span class="me-hint">云端被他人更新时会询问「覆盖 / 另存副本」</span>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const edHost = ov.querySelector<HTMLElement>("#me-editor")!;
  const view = ov.querySelector<HTMLElement>("#me-view")!;
  view.innerHTML = mdToHtml(text); // 初始即渲染右侧预览
  const cm = new EditorView({
    doc: text,
    parent: edHost,
    extensions: [
      basicSetup,
      markdown({ codeLanguages: languages }), // 代码块内嵌语言高亮（js/py/sql 等）
      EditorView.lineWrapping,
      cmTheme,
      // 输入实时刷新右侧预览（300ms 防抖，避免每个按键都整段重渲染）
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        window.clearTimeout(mdPreviewTimer);
        mdPreviewTimer = window.setTimeout(() => {
          const el = document.getElementById("me-view");
          if (el) el.innerHTML = mdToHtml(u.state.doc.toString());
        }, 300);
      }),
    ],
  });
  ov.querySelector("#me-cancel")!.addEventListener("click", () => {
    diskEditing.delete(articleId);
    ov.remove();
    toast("已取消修改，不回传");
  });
  ov.querySelector("#me-upload")!.addEventListener("click", () => {
    void (async () => {
      const btn = ov.querySelector<HTMLButtonElement>("#me-upload")!;
      btn.disabled = true;
      try {
        await api.diskFileText(path, cm.state.doc.toString()); // 回写暂存文件
        await diskEditUploadAfterCheck(articleId, name, path);
        ov.remove();
      } catch (e) {
        btn.disabled = false;
        toast(`上传失败：${String(e).replace(/^"|"$/g, "")}（可稍后在传输日志重试）`);
      }
    })();
  });
}

/** 上传前冲突检查：重新拉一次该文章 updateTime；云端被更新 → 弹窗选「覆盖/另存副本」。
 *  上传失败（含会话过期）由 disk_upload_files 逐文件失败事件进传输日志失败列表。 */
async function diskEditUploadAfterCheck(articleId: string, name: string, path: string): Promise<void> {
  const ent = diskEditing.get(articleId);
  const spaceId = ent?.spaceId || diskSt.spaceId;
  const subjectId = ent?.subjectId || diskParentId(diskSt.flat.get(articleId)!);
  // 写权限前置检查：无写权限不能回传（编辑状态保留，用户可取消修改）；个人空间永远可写
  if (!(await diskCanWrite(spaceId))) {
    toast("该空间无写权限，不能回传编辑内容");
    return;
  }
  // 冲突检查：编辑期间的云端版本 vs 下载时版本
  let latest = 0;
  try {
    const tree = await api.diskTree(spaceId);
    latest = tree.find((x) => x.id === articleId)?.updateTime || 0;
  } catch {
    /* 拉不到按无冲突处理：真冲突会被同名替换掩盖，属可接受兜底 */
  }
  let uploadPath = path;
  let note = "";
  if (latest > (ent?.cloudUpdateTime || 0)) {
    const choice = await diskEditConflict(name);
    if (choice === "cancel") {
      diskEditing.delete(articleId);
      toast("已取消回传");
      return;
    }
    if (choice === "copy") {
      uploadPath = await api.diskFileCopy(path); // 副本改名 → 上传为新建文件，不覆盖
      note = "（另存副本）";
    }
  }
  await api.diskUploadFiles(spaceId, subjectId, [uploadPath]);
  diskEditing.delete(articleId);
  diskLog(`编辑回传：「${name}」${note}——上传完成${note ? "" : "，同名自动替换"}`, true);
  toast("编辑内容已上传网盘");
}

/** 编辑冲突三选弹窗：覆盖云端 / 另存副本 / 取消 */
function diskEditConflict(name: string): Promise<"overwrite" | "copy" | "cancel"> {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.id = "disk-conflict-ov";
    ov.innerHTML = `
      <div class="dc-box">
        <div class="dc-title">编辑冲突</div>
        <div class="dc-msg">「${esc(name)}」在您编辑期间已被他人在云端更新。如何处理您的修改？</div>
        <div class="dc-actions">
          <button class="disk-btn" id="cf-overwrite">覆盖云端</button>
          <button class="disk-btn" id="cf-copy">另存副本</button>
          <button class="disk-btn ghost" id="cf-cancel">取消</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const done = (v: "overwrite" | "copy" | "cancel") => {
      ov.remove();
      resolve(v);
    };
    ov.querySelector("#cf-overwrite")!.addEventListener("click", () => done("overwrite"));
    ov.querySelector("#cf-copy")!.addEventListener("click", () => done("copy"));
    ov.querySelector("#cf-cancel")!.addEventListener("click", () => done("cancel"));
  });
}

function diskRenderTree(): void {
  const tree = document.getElementById("disk-tree");
  if (!tree) return;
  const parts: string[] = [];
  const walk = (nodes: DiskNode[], depth: number) => {
    for (const n of nodes) {
      if (n.nodeType === "subject") {
        const kids = diskSt.children.get(n.id);
        const hasKids = diskSt.loaded.has(n.id) ? !!kids?.length : !n.isLeaf;
        // 展开箭头只在子节点实际渲染时才指向下方；已展开但子列表未拉取时保持 ▸
        const open = diskSt.expanded.has(n.id) && !!kids?.length;
        const chk = diskSt.checked.has(n.id) ? " checked" : "";
        parts.push(
          `<div class="disk-tree-item" data-id="${esc(n.id)}" style="padding-left:${8 + depth * 14}px" title="${esc(n.name)}">` +
            `<span class="tw">${hasKids ? (open ? "▾" : "▸") : ""}</span>` +
            `<input type="checkbox" class="d-chk" data-id="${esc(n.id)}"${chk} title="勾选目录（级联包含下级全部文件）" />` +
            `<span class="d-ico">📁</span><span class="tname">${esc(n.name)}</span></div>`,
        );
        if (open && kids) walk(kids, depth + 1);
      } else {
        // 最末级文件直接作为树叶子展示；全部文件行带勾选框（在线文档可勾选，但下载仅 FILE 附件）
        const disp = diskFileDisplay(n);
        const chk = diskSt.checked.has(n.id) ? " checked" : "";
        parts.push(
          `<div class="disk-tree-item is-file" data-id="${esc(n.id)}" style="padding-left:${8 + depth * 14}px" title="${esc(disp.name)}">` +
            `<span class="tw"></span>` +
            `<input type="checkbox" class="d-chk" data-id="${esc(n.id)}"${chk} title="勾选文件" />` +
            `<span class="d-ico">${diskFileIconHtml(n)}</span><span class="tname">${esc(disp.name)}</span></div>`,
        );
      }
    }
  };
  walk(diskSt.roots, 0);
  tree.innerHTML = parts.join("") || `<div class="empty">没有目录</div>`;
  tree.querySelectorAll<HTMLElement>(".disk-tree-item").forEach((el) => {
    const id = el.dataset.id || "";
    el.querySelector<HTMLInputElement>(".d-chk")?.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void diskToggleCheck(id, (ev.target as HTMLInputElement).checked);
    });
    el.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).tagName === "INPUT") return;
      const node = diskSt.flat.get(id);
      if (!node) return;
      if (node.nodeType === "subject") {
        // 目录行单击：
        // 子列表未加载（findTreeByNodeId 的文件只随所查目录返回，未点过的目录是空的）
        // → 无论当前展开与否，点击一律=拉取子列表并展开，绝不收起；
        // 已加载 → 正常切换展开/收起。
        if (!diskSt.loaded.has(id)) {
          diskSt.expanded.add(id);
          void diskExpand(node, true);
        } else {
          const opening = !diskSt.expanded.has(id);
          if (opening) diskSt.expanded.add(id);
          else diskSt.expanded.delete(id);
          void diskExpand(node, opening);
        }
      } else {
        // 点文件行 = 屏幕小菜单（在线文档打开 / 在线查看 / MD 编辑 / Office 本地只读与编辑回传）；勾选只走 checkbox 自身事件
        diskFileMenu(node, ev.clientX, ev.clientY, ev);
      }
    });
  });
}

/** 展开/收起目录：展开时确保子列表已加载（未覆盖的目录自动补拉），随后重绘树 */
async function diskExpand(node: DiskNode, opening: boolean): Promise<void> {
  if (opening) await diskEnsureLoaded(node);
  diskRenderTree();
}

/** 勾选/取消勾选一个节点：目录级联其子树（勾=全部 FILE；取消=清空子树勾选）。
 *  在勾选祖先下手动取消的子目录/文件记入 unchecked，下载收集时剪枝 */
async function diskToggleCheck(id: string, on: boolean): Promise<void> {
  const node = diskSt.flat.get(id);
  if (!node) return;
  if (on) {
    diskSt.checked.add(id);
    diskSt.unchecked.delete(id);
  } else {
    diskSt.checked.delete(id);
    diskSt.unchecked.add(id);
  }
  diskUpdateButtons();
  if (node.nodeType !== "subject") {
    diskRenderTree();
    return;
  }
  if (on) {
    // 右键上传待选目标（diskSt.pending 有值）时，仅勾选该目录本身，不级联下级
    // （此时是在「选上传目标」，勾选下级会造成误选、与下载语义冲突）
    if (diskSt.pending.length === 0) {
      // 级联前先确保子树已加载（未展开的目录也要拉全），并清除子树的显式取消记录
      try {
        await diskEnsureSubtree(node);
      } catch (e) {
        diskLog(`级联读取「${node.name}」失败：${esc(String(e).replace(/^"|"$/g, ""))}`, false);
      }
      const under = diskCollectUnder(node.id);
      for (const k of under) diskSt.unchecked.delete(k.id);
      // 级联勾选：父目录下的全部子目录与文档（含在线文档）一并选中；
      // 在线文档是否可下载由 diskCheckedDlItems 的 dlType 白名单决定（不可下者给出详情页提示）
      for (const k of under) {
        if (k.nodeType === "subject" || k.nodeType === "article") diskSt.checked.add(k.id);
      }
    }
  } else {
    for (const k of diskCollectUnder(node.id)) diskSt.checked.delete(k.id);
  }
  diskRenderTree();
  diskUpdateButtons();
}

/** 收集 rootId 目录下已加载的全部子孙节点（依据 children 映射逐层递归）。
 *  prune=true 时跳过 unchecked 的子目录分支（及其子树） */
function diskCollectUnder(rootId: string, prune = false): DiskNode[] {
  const out: DiskNode[] = [];
  const walk = (pid: string) => {
    for (const k of diskSt.children.get(pid) || []) {
      if (prune && k.nodeType === "subject" && diskSt.unchecked.has(k.id)) continue;
      out.push(k);
      if (k.nodeType === "subject") walk(k.id);
    }
  };
  walk(rootId);
  return out;
}

/** 第一个勾选的目录（作为上传目标） */
function diskFirstCheckedDir(): DiskNode | null {
  for (const id of diskSt.checked) {
    const n = diskSt.flat.get(id);
    if (n && n.nodeType === "subject") return n;
  }
  return null;
}

/** 按勾选状态点亮/灰置上传、下载按钮 */
function diskUpdateButtons(): void {
  const up = document.getElementById("disk-up") as HTMLButtonElement | null;
  const dl = document.getElementById("disk-dl") as HTMLButtonElement | null;
  const dir = diskFirstCheckedDir();
  if (up) {
    up.disabled = !dir;
    up.title = dir ? `上传文件到「${dir.name}」` : "先在树上勾选一个目标目录";
  }
  if (dl) {
    dl.disabled = diskSt.checked.size === 0;
    dl.title = "下载勾选的文件（附件直下原始文件；在线文档 DOC/RICHTEXT→docx、MD→md 原文、Excel→xlsx）";
  }
  const del = document.getElementById("disk-del") as HTMLButtonElement | null;
  if (del) {
    del.disabled = diskSt.checked.size === 0;
    del.title = "删除选中的文件与目录（在线文档不允许删除）";
  }
  const hint = document.getElementById("disk-hint");
  if (hint) {
    const nFiles = [...diskSt.checked].filter((id) => diskSt.flat.get(id)?.nodeType === "article").length;
    hint.textContent = dir
      ? `上传目标：「${dir.name}」｜已选 ${nFiles} 个文件`
      : nFiles
        ? `已选 ${nFiles} 个文件`
        : "";
  }
}

/** 汇总勾选 → 下载任务列表。
 *  可下载：FILE 附件（原始文件）+ 在线文档 DOC→.docx / MARKDOWN→.md 原文 /
 *  RICHTEXT→.docx / EXCEL·COLLEXCEL→.xlsx（均经 B/S 官方 transfer/download.htm 导出接口）。
 *  勾选目录展开为其子树可下载文件（unchecked 剪枝），
 *  且仅当文件的最远勾选祖先就是该目录时归属它（避免与子目录重复/冲突） */
function diskCheckedDlItems(): DiskDlItem[] {
  const out: DiskDlItem[] = [];
  const seen = new Set<string>();
  const dlType = new Set(["FILE", "DOC", "MARKDOWN", "RICHTEXT", "EXCEL", "COLLEXCEL"]);
  const add = (n: DiskNode) => {
    if (n.nodeType !== "article" || !dlType.has(n.subtype) || seen.has(n.id)) return;
    seen.add(n.id);
    out.push({
      articleId: n.id,
      name: n.subtype === "FILE" ? diskFileName(n) : diskFileDisplay(n).name,
      relDir: diskRelDir(n),
      subtype: n.subtype,
    });
  };
  for (const id of diskSt.checked) {
    const n = diskSt.flat.get(id);
    if (!n) continue;
    if (n.nodeType === "article") {
      add(n);
      continue;
    }
    for (const k of diskCollectUnder(id, true)) {
      if (k.nodeType === "article" && !diskSt.unchecked.has(k.id) && diskTopCheckedAncestor(k) === id) add(k);
    }
  }
  return out;
}

/** 文件祖先链（pid 逐级上溯，自底向上）中最远的已勾选目录 id；无则 null */
function diskTopCheckedAncestor(n: DiskNode): string | null {
  const chain: string[] = [];
  let cur = n.pid;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const p = diskSt.flat.get(cur);
    if (!p || p.nodeType !== "subject") break;
    chain.push(p.id);
    cur = p.pid;
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    if (diskSt.checked.has(chain[i])) return chain[i];
  }
  return null;
}

/** 相对路径：文件祖先链（自底向上）中距其最远的勾选目录以下的目录名串 */
function diskRelDir(n: DiskNode): string {
  const chain: string[] = [];
  let cur = n.pid;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const p = diskSt.flat.get(cur);
    if (!p || p.nodeType !== "subject") break;
    chain.push(p.id);
    cur = p.pid;
  }
  let cut = -1;
  for (let i = chain.length - 1; i >= 0; i--) {
    if (diskSt.checked.has(chain[i])) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return "";
  return chain
    .slice(0, cut)
    .reverse()
    .map((id) => diskSt.flat.get(id)?.name || "")
    .filter(Boolean)
    .map(sanitizeDiskName)
    .join("/");
}

async function diskPickFiles(): Promise<string[]> {
  if (diskSt.pending.length) {
    const p = diskSt.pending;
    diskSt.pending = [];
    return p;
  }
  const picked = await invoke<string[] | null>("plugin:dialog|open", {
    options: { multiple: true, title: "选择要上传的文件" },
  });
  return Array.isArray(picked) ? picked : [];
}

async function diskPickDir(): Promise<string> {
  const dir = await invoke<string | null>("plugin:dialog|open", {
    options: { directory: true, title: "选择保存位置" },
  });
  return typeof dir === "string" ? dir : "";
}

/** 上传到勾选的目标目录（记忆为该空间的默认目标；文件来源：右键带入 / 文件对话框） */
async function diskUploadTo(subject: DiskNode): Promise<void> {
  // 写权限前置检查：无写权限直接拦截（个人空间永远可写；检查失败不阻塞，交由服务端兜底）
  if (!(await diskCanWrite(diskSt.spaceId))) {
    return toast("该空间无写权限，不能上传文件");
  }
  const paths = await diskPickFiles();
  if (!paths.length) return;
  diskUploadSubjectId = subject.id;
  localStorage.setItem(
    diskTargetKey(),
    JSON.stringify({ spaceId: diskSt.spaceId, subjectId: subject.id, name: subject.name }),
  );
  const task = diskTransferStart("upload", subject.name, paths.length, { subjectId: subject.id });
  toast(`开始上传 ${paths.length} 个文件到「${subject.name}」`);
  try {
    await api.diskUploadFiles(diskSt.spaceId, subject.id, paths);
  } catch (e) {
    diskTransferFailStart(task.id, String(e));
    toast(`上传启动失败：${esc(String(e).replace(/^"|"$/g, ""))}`);
  }
}

/** 批量下载：选目标目录 → 调 Rust 队列（进度走 disk-progress 事件） */
async function diskDownload(items: DiskDlItem[]): Promise<void> {
  let dest: string;
  try {
    dest = await diskPickDir();
  } catch {
    return;
  }
  if (!dest) return;
  await diskDownloadItems(items, dest);
}

/** 执行下载（内部/重试复用）：登记传输任务 → 调 Rust 队列 */
async function diskDownloadItems(items: DiskDlItem[], dest: string): Promise<void> {
  const task = diskTransferStart("download", dest, items.length, { raw: items, dest });
  try {
    await api.diskDownloadFiles(items, dest);
    toast(`开始下载 ${items.length} 个文件`);
  } catch (e) {
    diskTransferFailStart(task.id, String(e));
    toast(`下载启动失败：${esc(String(e).replace(/^"|"$/g, ""))}`);
  }
}

/** 删除：收集勾选项 → 排除在线文档（写入日志「在线文档不允许删除」）→ 二次确认 →
 *  先删文件后删目录 → 刷新树。在线文档由前端调用前排除，绝不进删除请求。 */
async function diskDeleteSelected(): Promise<void> {
  const files: DiskNode[] = [];
  const onlineDocs: DiskNode[] = [];
  const dirs: DiskNode[] = [];
  for (const id of diskSt.checked) {
    const n = diskSt.flat.get(id);
    if (!n) continue;
    if (n.nodeType === "subject") dirs.push(n);
    else if (n.subtype === "FILE") files.push(n);
    else onlineDocs.push(n); // 在线文档（DOC/MARKDOWN/RICHTEXT/EXCEL/COLLEXCEL…）
  }
  if (onlineDocs.length) {
    diskLog(`在线文档不允许删除：${onlineDocs.map((o) => o.name).join("、")}`, false);
  }
  if (!files.length && !dirs.length) {
    toast(onlineDocs.length ? "您勾选的是在线文档，不允许删除" : "请先勾选要删除的文件或目录");
    return;
  }
  const ok = await diskConfirm(
    "删除确认",
    `将删除 ${files.length} 个文件、${dirs.length} 个目录（在线文档 ${onlineDocs.length} 个已排除，不删除）。此操作不可恢复，确定继续？`,
  );
  if (!ok) return;
  // 登记传输管理器任务（删除=一次性同步，无逐文件进度事件，结束后直接结算）
  const total = files.length + dirs.length + onlineDocs.length;
  const task = diskTransferStart("delete", `${files.length + dirs.length} 项`, total, {});
  // 删除前先捕获 id→名称映射：删除+刷新树后 diskSt.flat 里已无这些节点，届时再查只会拿到 id
  const nameById = new Map<string, string>();
  for (const n of [...files, ...dirs, ...onlineDocs]) nameById.set(n.id, n.name);
  try {
    const res = await api.diskDelete(
      files.map((f) => f.id),
      dirs.map((d) => d.id),
    );
    // 刷新树（被删节点消失）；刷新发生在记录结果之前，故下方日志不会被清掉
    await diskLoadSpace(diskSt.spaceId);
    // 逐条结论（文件/目录成功 ✓ / 失败 ✗），名称用删除前捕获的映射
    for (const it of res.items) task.items.push({ name: nameById.get(it.id) ?? it.id, ok: it.ok, msg: it.msg ?? "" });
    // 在线文档：标记「已排除」（muted，不计入失败）
    for (const o of onlineDocs) task.items.push({ name: nameById.get(o.id) ?? o.name, ok: false, msg: "在线文档(已排除)", muted: true });
    diskTransferFinish("delete", task.items.length);
    if (onlineDocs.length) diskLog(`在线文档不允许删除：${onlineDocs.map((o) => o.name).join("、")}`, false);
    if (res.failed.length) diskLog(`删除部分失败：${res.failed.join("；")}`, false);
    diskLog(`删除完成：文件 ${res.deletedFiles} 个、目录 ${res.deletedDirs} 个`, true);
    toast(
      `删除完成（文件 ${res.deletedFiles}、目录 ${res.deletedDirs}${res.failed.length ? `，${res.failed.length} 个失败` : ""}）`,
    );
  } catch (e) {
    diskTransferFailStart(task.id, String(e));
    diskLog(`删除失败：${esc(String(e).replace(/^"|"$/g, ""))}`, false);
    toast("删除失败，详见日志");
  }
}

/** 网盘内轻量确认弹窗（不依赖外部 dialog 插件，保证可用） */
function diskConfirm(title: string, msg: string): Promise<boolean> {
  return new Promise((resolve) => {
    const box = document.getElementById("disk-confirm");
    if (!box) return resolve(false);
    (document.getElementById("dc-title") as HTMLElement).textContent = title;
    (document.getElementById("dc-msg") as HTMLElement).textContent = msg;
    box.hidden = false;
    const ok = document.getElementById("dc-ok")!;
    const cancel = document.getElementById("dc-cancel")!;
    const done = (v: boolean) => {
      box.hidden = true;
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      resolve(v);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
  });
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
// id 统一为内容哈希（16位hex）；旧版存过服务端 id（32位hex），永远匹配不到行，一次性过滤防角标虚高
let unreadIds = new Set<string>(
  (JSON.parse(localStorage.getItem("aif_unread_msg_ids") || "[]") as string[]).filter((id) =>
    /^[0-9a-f]{16}$/.test(id),
  ),
);
let todoBadgeCount = 0; // 「我收到的」各行「待办」计数合计

function persistUnread() {
  localStorage.setItem("aif_unread_msg_ids", JSON.stringify([...unreadIds].slice(-300)));
}

/// 单条未读 → 已读：内存集合、localStorage、底部导航角标、页面行内未读样式四处同步。
/// 所有「点击某条未读消息」的路径（消息列表点击 / 系统通知跳转 / 弹窗跳转）统一走这里，
/// 保证角标随点击动作即时增减。返回是否确有未读被消除。
function markOneRead(id: string): boolean {
  if (!id || !unreadIds.has(id)) return false;
  unreadIds.delete(id);
  persistUnread();
  setTabBadge("messages", unreadIds.size);
  // 行内样式同步：列表可能处于任一渲染态（当前页 / 本地回退），全量清理兜底
  document.querySelectorAll(`.msg-row[data-id="${CSS.escape(id)}"]`).forEach((row) => {
    row.classList.remove("unread");
    row.querySelector(".msg-unread-dot")?.remove();
  });
  return true;
}

/// 按消息 URL 反查并转已读（系统通知 / 弹窗点击跳转路径，此时手里只有 URL 没有 id）。
/// 先查当前已加载的历史分页，未命中再查本地轮询存档。
async function markReadByUrl(url: string) {
  if (!url) return;
  const hit = msgState.items.find((m) => m.url === url);
  if (hit) {
    markOneRead(hit.id);
    return;
  }
  try {
    const local = await api.getMessages();
    const m = local.find((x) => x.url === url);
    if (m) markOneRead(m.id);
  } catch {
    /* 本地存档不可用：忽略，未读状态保持 */
  }
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

/// 由 matters 数据计算待办角标并上屏（所有成功拉到 matters 的路径都调用，
/// 保证角标与待办页数字同源同帧，页面更新了角标必然跟着更新）
function applyTodoBadge(matters: MatterRow[]) {
  todoBadgeCount = matters
    .filter((m) => m.category === "received")
    .reduce((s, m) => s + m.badges.filter((b) => b.label === "待办").reduce((x, b) => x + b.count, 0), 0);
  setTabBadge("todos", todoBadgeCount);
}

/// 后台统计角标：待办 = 「我收到的」各行的「待办」数字合计；消息 = 未读集合大小。
/// 不依赖当前所在 Tab（get_matters 独立于待办页渲染）。
async function refreshBadgeCounts() {
  try {
    applyTodoBadge(await api.getMatters());
  } catch {
    /* 未登录/网络失败：保持现值 */
  }
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
      <div class="msg-row${unread ? " unread" : ""}" data-id="${esc(m.id)}" data-url="${esc(m.url)}" data-title="${esc(m.title)}" data-body="${esc(b)}" title="${esc([m.title, m.sender, m.time_str].filter(Boolean).join("　"))}">
        <div class="msg-when">
          <div class="msg-hm">${esc(fmtRelTime(m.time_str))}</div>
          <div class="msg-cat" style="color:${ty.color};background:${ty.color}14" title="${esc(ty.label)}">${catWrap(ty.label)}</div>
          <button class="snooze-btn" data-snooze type="button" title="30 分钟后提醒我">稍后</button>
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
          <div class="list-item" data-id="${esc(m.id)}" data-url="${esc(m.url)}">
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
      // 点击未读消息 → 该条立即转已读（集合/角标/行内样式统一在 markOneRead 内同步）
      const id = (item as HTMLElement).dataset.id;
      markOneRead(id || "");
      const url = (item as HTMLElement).dataset.url;
      if (url) void openUrl(url);
    }),
  );
  // 「稍后」按钮：30 分钟后重发系统通知（不打开消息，阻止冒泡避免触发行点击跳转）
  root.querySelectorAll<HTMLElement>("[data-snooze]").forEach((btn) =>
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const row = btn.closest("[data-id]") as HTMLElement | null;
      if (!row) return;
      snoozeMessage(
        row.dataset.id || "",
        row.dataset.title || "消息提醒",
        (row.dataset.body || "").slice(0, 120),
        row.dataset.url || "",
      );
    }),
  );
}

// ---------------- 稍后提醒（消息行「稍后」按钮） ----------------
// 到期后经 Rust fire_snooze 重发系统通知（点击可跳回消息并转已读）。
// 计划持久化在 localStorage（重启后恢复）；休眠/长期关机导致超期 24h 的提醒直接丢弃。
interface SnoozeItem {
  id: string;
  title: string;
  body: string;
  url: string;
  /** 到期时刻（Unix 毫秒） */
  at: number;
}
const SNOOZE_MS = 30 * 60 * 1000;
let snoozes: SnoozeItem[] = JSON.parse(
  localStorage.getItem("aif_snoozes") || "[]",
) as SnoozeItem[];

function persistSnoozes() {
  localStorage.setItem("aif_snoozes", JSON.stringify(snoozes.slice(-100)));
}

function snoozeMessage(id: string, title: string, body: string, url: string) {
  // 同一条消息重复点「稍后」→ 顺延而非叠加
  snoozes = snoozes.filter((s) => s.id !== id);
  snoozes.push({ id, title, body, url, at: Date.now() + SNOOZE_MS });
  persistSnoozes();
  toast("已设置 30 分钟后提醒");
}

async function fireDueSnoozes() {
  if (!snoozes.length) return;
  const now = Date.now();
  const due = snoozes.filter((s) => s.at <= now);
  if (!due.length) return;
  snoozes = snoozes.filter((s) => s.at > now);
  persistSnoozes();
  for (const s of due) {
    if (now - s.at > 24 * 3600 * 1000) continue; // 超期 24h 丢弃
    try {
      await api.fireSnooze(s.title, s.body, s.url);
    } catch {
      /* 通知失败忽略 */
    }
  }
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
    applyTodoBadge(mattersCache); // 同一份数据同步刷导航角标（省一次 getMatters）
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
    applyTodoBadge(mattersCache); // 进入待办页拿到新数据即同步角标（此前角标只靠轮询路径，页面数据从不回写角标）
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
// 搜索关键字（本地过滤名称/单位/说明）；拉取结果缓存，输入时不重新请求、焦点不丢
let spaceSearch = "";
let spacesCache: SpaceRow[] = [];
// 分类折叠状态（分类名 → 折叠）；spaceGroupsCache 为最近一次分节渲染的分类名清单
const spaceCollapsed = new Set<string>();
let spaceGroupsCache: string[] = [];

function renderSpaces(content: HTMLElement) {
  content.innerHTML =
    searchBar("search-space", "搜索空间 / 单位 / 说明", spaceSearch) +
    `
    <div class="type-chips" id="space-tabs">
      <button class="type-chip${spaceSection === "starred" ? " active" : ""}" data-sec="starred">我的收藏</button>
      <button class="type-chip${spaceSection === "all" ? " active" : ""}" data-sec="all">全部空间</button>
      <span class="tb-spacer"></span>
      <button class="type-chip plain" id="space-fold" title="折叠全部分类（仅全部空间、无搜索时可用）">折叠</button>
      <button class="type-chip plain" id="space-expand" title="展开全部分类">展开</button>
    </div>
    <div class="list" id="list">${skels()}</div>`;
  document.getElementById("search-space")!.addEventListener("input", debounce((e: Event) => {
    spaceSearch = (e.target as HTMLInputElement).value.trim();
    renderSpaceList();
  }, 300));
  content.querySelectorAll<HTMLElement>("#space-tabs .type-chip[data-sec]").forEach((b) =>
    b.addEventListener("click", () => {
      spaceSection = b.dataset.sec!;
      content.querySelectorAll("#space-tabs .type-chip[data-sec]").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      void loadSpaceList();
    }),
  );
  // 分类折叠/展开（仅「全部空间」且无搜索时分节展示，其他视图给提示）
  const foldAll = () => {
    if (spaceSection !== "all" || spaceSearch) return toast("仅「全部空间」且无搜索时支持按分类折叠");
    for (const g of spaceGroupsCache) spaceCollapsed.add(g);
    renderSpaceList();
  };
  const expandAll = () => {
    if (spaceSection !== "all" || spaceSearch) return toast("仅「全部空间」且无搜索时支持按分类展开");
    spaceCollapsed.clear();
    renderSpaceList();
  };
  document.getElementById("space-fold")!.addEventListener("click", foldAll);
  document.getElementById("space-expand")!.addEventListener("click", expandAll);
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

/// 人工固定置顶项：我的空间（点击跳转个人空间知识库页面 /knowledge/personal/view.htm）
function mySpaceRow(): SpaceRow {
  const base = (settings?.base_url || "").replace(/\/+$/, "");
  const root = settings?.ops_product ? "AIF" : "DCP";
  return {
    id: "__my_space__",
    name: "我的空间",
    remark: "个人文件 · 知识库",
    dept: "",
    color: "#0ea5e9",
    collected: true,
    url: `${base}/${root}/knowledge/personal/view.htm`,
    category: "",
  };
}
const MY_SPACE_ICON = `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="5.5" fill="#0ea5e9"/><path d="M5 11.4 12 5l7 6.4" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M6.6 10.2V18h10.8v-7.8" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 18v-4.6h4V18" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/// 渲染空间列表（spacesCache + spaceSearch 本地过滤；搜索输入只走这里，不重新请求、焦点不丢）。
/// 「全部空间」无关键字时按分类分节（B/S spaceType 经 findAllSystemSpaceCategory 字典映射）；
/// 有关键字时平铺（可按分类名搜索）。
function renderSpaceList() {
  const list = document.getElementById("list");
  if (!list || currentTab !== "spaces") return;
  const kw = spaceSearch.toLowerCase();
  const hit = (s: SpaceRow) =>
    !kw ||
    s.name.toLowerCase().includes(kw) ||
    (s.dept || "").toLowerCase().includes(kw) ||
    (s.remark || "").toLowerCase().includes(kw) ||
    (s.category || "").toLowerCase().includes(kw);
  // 「我的收藏」分类：人工置顶「我的空间」固定项（始终排最前；同样受搜索过滤）
  const withMy = spaceSection === "starred" ? [mySpaceRow(), ...spacesCache] : spacesCache;
  const spaces = withMy.filter(hit);
  if (!spaces.length) {
    list.innerHTML = `<div class="empty">${kw ? "没有匹配的空间" : spaceSection === "starred" ? "暂无收藏的空间" : "暂无可访问的空间"}</div>`;
    return;
  }
  const card = (s: SpaceRow) => {
    const c = spaceColorOf(s.color);
    const ico =
      s.id === "__my_space__"
        ? MY_SPACE_ICON
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2V16a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7.5z"/></svg>`;
    return `
      <div class="list-item card" data-url="${esc(s.url)}" title="${esc(s.remark || s.name)}">
        <div class="ico" style="color:${c};background:${c}1f">${ico}</div>
        <div class="li-main">
          <div class="li-title">${esc(s.name)}${s.collected ? '<span class="star-mark" style="color:#f59e0b">★</span>' : ""}</div>
          <div class="li-sub">${esc([s.dept, s.remark].filter((x) => x && x !== "暂无说明").join(" · ")) || " "}${s.category ? `<span class="cat-badge">${esc(s.category)}</span>` : ""}</div>
        </div>
      </div>`;
  };
  // 全部空间 + 无关键字 → 按分类分节（保持接口出现顺序，未分类排最后）；
  // 分类标题行可点击折叠/展开，右上「折叠/展开」按钮批量操作
  if (spaceSection === "all" && !kw) {
    const groups: { name: string; rows: SpaceRow[] }[] = [];
    for (const s of spaces) {
      const g = s.category || "未分类";
      let bucket = groups.find((x) => x.name === g);
      if (!bucket) {
        bucket = { name: g, rows: [] };
        groups.push(bucket);
      }
      bucket.rows.push(s);
    }
    groups.sort((a, b) => (a.name === "未分类" ? 1 : b.name === "未分类" ? -1 : 0));
    spaceGroupsCache = groups.map((g) => g.name);
    list.innerHTML = groups
      .map(
        (g, gi) => {
          const c = g.name === "未分类" ? "#94a3b8" : CAT_COLORS[gi % CAT_COLORS.length];
          const folded = spaceCollapsed.has(g.name);
          return (
            `<div class="space-group toggle" data-cat="${esc(g.name)}" title="${folded ? "展开" : "折叠"}该分类">${folded ? "▸" : "▾"} ${esc(g.name)}<span class="sg-count" style="color:${c};background:${c}1f;border:1px solid ${c}44">${g.rows.length}</span></div>` +
            (folded ? "" : g.rows.map(card).join(""))
          );
        },
      )
      .join("");
  } else {
    spaceGroupsCache = [];
    list.innerHTML = spaces.map(card).join("");
  }
  list.querySelectorAll<HTMLElement>(".space-group.toggle").forEach((h) =>
    h.addEventListener("click", () => {
      const cat = h.dataset.cat!;
      if (spaceCollapsed.has(cat)) spaceCollapsed.delete(cat);
      else spaceCollapsed.add(cat);
      renderSpaceList();
    }),
  );
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
/** macOS：速览条功能不提供（窗口层级/托盘生态差异大，隐藏设置开关且不创建窗口） */
const IS_MAC = /Mac/i.test(navigator.userAgent);
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
      <div class="set-main"><div class="set-title">重启后恢复标签页</div><div class="set-desc">再次打开客户端并进入全屏模式时，自动恢复上次打开的标签页；多个入口（项目）各自记忆各自的，互不串扰（最多 8 个；休眠的标签点击后再加载）</div></div>
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
      ${ico("#f97316", `<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 9.5h16"/><path d="M9 9.5V21"/>`)}
      <div class="set-main"><div class="set-title">显示导航栏名称</div><div class="set-desc">左侧导航栏图标下方显示 2 字功能名称（默认关闭：只显示图标）</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-nav-labels" ${s.nav_show_labels ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#0ea5e9", `<path d="M7.5 15.5a3.3 3.3 0 0 1-.3-6.6 4.4 4.4 0 0 1 8.5-.9 3.4 3.4 0 0 1 1.4 6.5"/><path d="M12 17.5v-5.2M9.8 14.3l2.2-2.2 2.2 2.2"/>`)}
      <div class="set-main">
        <div class="set-title">资源管理器右键上传菜单</div>
        <div class="set-desc">在文件右键菜单加入「上传到协作空间」，支持多选文件（逐个文件透传，保证全部进入上传队列）；上传目标为网盘页上次使用的目录（Windows 11 位于"显示更多选项"二级菜单）</div>
      </div>
      <label class="switch set-side"><input type="checkbox" id="set-ctxmenu" /><span class="track"></span><span class="thumb"></span></label>
    </div>
    <div class="set-row">
      ${ico("#f43f5e", `<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>`)}
      <div class="set-main">
        <div class="set-title">勿扰时段</div>
        <div class="set-desc">时段内新消息只计未读角标：不弹窗、不响铃、不闪托盘（支持跨午夜，如 22:00 ~ 08:00）</div>
        <div class="set-block rule-row">
          <label class="switch set-side"><input type="checkbox" id="set-dnd" ${s.notify_dnd_enabled ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
          <input type="time" id="set-dnd-start" value="${esc(s.notify_dnd_start)}" />
          <span class="rule-sep">~</span>
          <input type="time" id="set-dnd-end" value="${esc(s.notify_dnd_end)}" />
        </div>
      </div>
    </div>
    <div class="set-row">
      ${ico("#8b5cf6", `<path d="M12 3l1.9 5.8H20l-4.9 3.6 1.9 5.8-5-3.6-5 3.6 1.9-5.8L4 8.8h6.1z"/>`)}
      <div class="set-main">
        <div class="set-title">消息静音关键词</div>
        <div class="set-desc">标题或正文命中任一关键词的消息不弹窗、不响铃（未读角标照常）。多个关键词用逗号分隔，留空不启用</div>
        <div class="set-block"><input type="text" id="set-mute-kw" class="rule-input" placeholder="如：公告,周报,会议通知" value="${esc(s.notify_mute_keywords)}" autocomplete="off" /></div>
      </div>
    </div>
    <div class="set-row">
      ${ico("#f59e0b", `<circle cx="12" cy="13" r="7"/><path d="M12 10v3l2 2"/><path d="M9 2h6"/>`)}
      <div class="set-main">
        <div class="set-title">待办超时提醒</div>
        <div class="set-desc">事项在本地可见超过设定天数仍未办结时，弹一次升级提醒并闪托盘（每个事项只提醒一次）</div>
        <div class="set-block rule-row">
          <span class="rule-sep">超过</span>
          <input type="number" id="set-escalate" class="rule-input" style="width:70px" min="0" max="365" value="${s.todo_escalate_days}" />
          <span class="rule-sep">天未处理（0 = 关闭）</span>
        </div>
      </div>
    </div>
    <div class="set-row">
      ${ico("#10b981", `<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M8 2v4M16 2v4"/><path d="m9 15 2 2 4-4"/>`)}
      <div class="set-main">
        <div class="set-title">每日定时摘要</div>
        <div class="set-desc">每天固定时间推送一条汇总：待办 N 件未办结 + 今日新消息 M 条，帮你形成每天看一眼的习惯锚点</div>
        <div class="set-block rule-row">
          <label class="switch set-side"><input type="checkbox" id="set-digest" ${s.daily_digest_enabled ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
          <span class="rule-sep">每天</span>
          <input type="time" id="set-digest-time" value="${esc(s.daily_digest_time)}" />
          <span class="rule-sep">推送</span>
        </div>
      </div>
    </div>
    ${IS_MAC ? "" : `<div class="set-row">
      ${ico("#0ea5e9", `<rect x="2" y="3" width="5" height="18" rx="1.5"/><rect x="9" y="3" width="5" height="18" rx="1.5"/><path d="M17 8h4M17 12h4M17 16h4"/>`)}
      <div class="set-main"><div class="set-title">迷你速览条</div><div class="set-desc">屏幕右缘常置一条小窗，悬停即可看到未读消息与待办数量，点击直达对应页面（不动主窗口）</div></div>
      <label class="switch set-side"><input type="checkbox" id="set-minibar" ${localStorage.getItem("aif_mini_bar") === "1" ? "checked" : ""} /><span class="track"></span><span class="thumb"></span></label>
    </div>`}
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
  // 「多入口切换」拨动即生效：全屏模式顶栏立刻出现/隐藏「入口信息 + 切换入口」，
  // 并立即持久化（不等「保存设置」），避免开关状态与顶栏实际表现不一致
  document.getElementById("set-multi-entry")!.addEventListener("change", (e) => {
    if (!settings) return;
    settings.multi_entry = (e.target as HTMLInputElement).checked;
    void updateEntryLabel(); // 内部联动 updateEntryBtn 控制顶栏显隐
    void api.saveSettings(settings).catch(() =>
      toast("多入口切换状态保存失败，请点击「保存设置」重试"),
    );
  });
  // 「显示导航栏名称」拨动即生效：导航栏功能名称立刻显隐并持久化（不等「保存设置」）
  document.getElementById("set-nav-labels")!.addEventListener("change", (e) => {
    if (!settings) return;
    settings.nav_show_labels = (e.target as HTMLInputElement).checked;
    applyNavLabels();
    void api.saveSettings(settings).catch(() =>
      toast("导航栏名称设置保存失败，请点击「保存设置」重试"),
    );
  });
  // 「资源管理器右键上传菜单」开关：状态从注册表读，切换即注册/注销（HKCU，免管理员）
  void api.diskContextMenuStatus().then((ok) => {
    const el = document.getElementById("set-ctxmenu") as HTMLInputElement | null;
    if (el) el.checked = !!ok;
  });
  document.getElementById("set-ctxmenu")!.addEventListener("change", (e) => {
    const enable = (e.target as HTMLInputElement).checked;
    void api.diskRegisterContextMenu(enable).then(
      () => toast(enable ? "已注册右键上传菜单（新开的右键菜单生效）" : "已移除右键上传菜单"),
      () => {
        toast("右键菜单设置失败（仅支持 Windows）");
        (e.target as HTMLInputElement).checked = !enable;
      },
    );
  });
  // 「迷你速览条」拨动即生效：创建/关闭右缘常置小窗，状态存 localStorage（重启恢复）
  document.getElementById("set-minibar")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    localStorage.setItem("aif_mini_bar", on ? "1" : "0");
    void api.toggleMiniBar(on).catch(() => toast("速览条切换失败，请重试"));
  });
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
    // 广播产品形态给速览条（mini 窗口 storage 监听 → 重新检测 ops_product，
    // 同步隐藏/显示「应用」按钮与「告警应用」节，条身高度自适应）
    localStorage.setItem("aif_ops_product", settings.ops_product ? "1" : "0");
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
  settings.nav_show_labels = (document.getElementById("set-nav-labels") as HTMLInputElement).checked;
  // 提醒规则：勿扰时段 / 静音关键词 / 待办超时提醒
  settings.notify_dnd_enabled = (document.getElementById("set-dnd") as HTMLInputElement).checked;
  settings.notify_dnd_start = (document.getElementById("set-dnd-start") as HTMLInputElement).value || "22:00";
  settings.notify_dnd_end = (document.getElementById("set-dnd-end") as HTMLInputElement).value || "08:00";
  settings.notify_mute_keywords = ((document.getElementById("set-mute-kw") as HTMLInputElement).value || "").trim();
  settings.todo_escalate_days = Math.max(
    0,
    Math.min(365, Number((document.getElementById("set-escalate") as HTMLInputElement).value) || 0),
  );
  // 每日定时摘要：开关 + 推送时间（HH:MM，Rust 侧解析失败按不触发处理）
  settings.daily_digest_enabled = (document.getElementById("set-digest") as HTMLInputElement).checked;
  settings.daily_digest_time =
    (document.getElementById("set-digest-time") as HTMLInputElement).value || "09:00";
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
    diskOnEntryReady(); // 按入口装载传输历史 + 网盘同步配置（入口切换/自动登录共用此入口）
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
  // Ctrl+K 全局命令面板（主页面聚焦时生效；标签页内嵌 webview 聚焦时按键归网页）
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      togglePalette();
    }
  });
  // 稍后提醒：启动即补发超期提醒，之后每 30 秒轮检一次
  void fireDueSnoozes();
  window.setInterval(() => void fireDueSnoozes(), 30_000);
  // 网盘同步后台节拍：每 1 分钟巡检；仅在 5 的整数倍分钟判定频率条件（nextRunAt），作业单飞
  window.setInterval(() => void diskSyncTick(), 60_000);
  // 本地编辑监视事件：编辑器释放（或 2h 超时）后按 mtime 决定是否回传
  on<{ path: string; changed: boolean; timedOut: boolean }>("disk-edit-done", (p) => {
    const hit = [...diskEditing.entries()].find(([, v]) => v.path === p.path);
    if (!hit) return;
    const [id, ent] = hit;
    if (p.timedOut) {
      diskEditing.delete(id);
      diskLog(`编辑监视超时：「${ent.name}」超过 2 小时未关闭，已停止监视；请在文件菜单重新操作`, false);
      toast("编辑监视超时，已停止");
      return;
    }
    if (!p.changed) {
      diskEditing.delete(id);
      diskLog(`编辑结束：「${ent.name}」内容未变化，不回传`, true);
      return;
    }
    void diskEditUploadAfterCheck(id, ent.name, p.path).catch((e) => {
      diskEditing.delete(id);
      diskLog(`编辑回传失败：「${ent.name}」${String(e).replace(/^"|"$/g, "")}（详见传输日志失败列表）`, false);
    });
  });
  // 迷你速览条恢复（上次开启过则随启动重建；macOS 不提供该功能）
  if (!IS_MAC && localStorage.getItem("aif_mini_bar") === "1") {
    void api.toggleMiniBar(true).catch(() => {});
  }
  // 速览条交互：点击计数/面板按钮/卡片行 → 主窗唤起并跳对应页；关闭 → 记住状态
  on<string>("mini-navigate", (target) => {
    console.info("[mini-navigate] 主窗收到:", target);
    void win.show();
    void win.unminimize();
    void win.setFocus();
    if (target === "messages" || target === "todos") switchTab(target as typeof currentTab);
    // 速览条「快捷功能」按钮：切到主窗快捷功能页
    else if (target === "quick") switchTab("quick");
    // 速览条「应用」按钮（仅 AIF）：切到主窗应用中心
    else if (target === "ops") switchTab("ops");
    // 速览条「助手」按钮：切到主窗助手（智能体）页
    else if (target === "assistant") switchTab("assistant");
    // 卡片行带 URL：直达对应页面（消息/待办办理页，走 openUrl 统一开 tab）
    else if (/^https?:/i.test(target)) void openUrl(target);
    else console.warn("[mini-navigate] 未识别的目标:", target);
  });
  on("mini-closed", () => {
    localStorage.setItem("aif_mini_bar", "0");
  });
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
  // 每日摘要前端兜底：系统 toast 被 Windows 吞掉时应用内保底可见
  on<string>("daily-digest", (text) => {
    toast(text);
  });
  // 稍后提醒到期兜底：同上（fire_snooze 系统通知旁路的应用内提示）
  on<string>("snooze-fired", (text) => {
    toast("稍后提醒：" + text);
  });
  on("todos-updated", () => {
    // 待办页开着：refreshTodos(true) 内部拉 matters 后经 applyTodoBadge 同步角标（省一次重复请求）；
    // 其它页面：单独刷角标
    if (currentTab === "todos") void refreshTodos(true);
    else void refreshBadgeCounts();
  });
  on("messages-updated", () => void refreshMessages(true));
  on<MessageRow>("new-message", (m) => {
    if (m.id) {
      unreadIds.add(m.id);
      persistUnread();
      setTabBadge("messages", unreadIds.size);
    }
    void refreshMessages(true);
    // 勿扰时段/静音关键词命中的消息：只计未读角标，不响铃不弹 toast
    if (m.muted) return;
    playSound(settings?.sound || "chime");
    toast("新消息：" + m.title);
  });
  // 系统通知点击跳转：Rust 按通知标题反查消息 URL 后置前主窗口并 emit；
  // 走 openUrl（全屏开 tab / 默认开独立 webview 窗口），文档空间消息自带 articleShowMessageBox=true。
  // 点击即视为已读：按 URL 反查消息并消除未读角标（与消息列表点击行为一致）
  on<string>("open-message-url", (url) => {
    void markReadByUrl(url);
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
