//! 多标签页（browser-like tabs）：全屏三栏模式下，在内嵌面板区域叠放多个
//! 子 webview，显隐切换模拟浏览器标签页。
//!
//! 与旧「单 pane」的差异：
//! - pane 只有一个实例，pane_open 复用 navigate；tab 每个标签一个独立子 webview
//!   （label = tab-N，N 单调递增不复用，避免关闭后 label 竞态）；
//! - 非激活标签 bounds 归零隐藏（沿用 pane_hide 验证过的手法，保留实例与页面状态）；
//! - 非激活超过 HIBERNATE_AFTER_SECS 的标签由定时器销毁 webview（hibernated=true，
//!   仅保留记录），激活时按存储 URL 重建——控制常驻内存的关键；
//! - 「重启后恢复标签页」设置开启时，tab 列表（url/title/active）持久化到 kv 表，
//!   重启进全屏模式后以休眠条目恢复，激活哪个才真正加载哪个。

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Url, WebviewUrl};

use crate::commands::{bs_download_handler, bs_new_window_strategy, inject_session_cookies, pane_bounds_of, BS_WINDOW_SHIM};
use crate::db;
use crate::state::AppState;

/// 标签页数量上限（每个标签是独立渲染进程，重 JSP 页面约 200~300MB/个，不可不设上限）
pub const TAB_LIMIT: usize = 8;
/// 非激活标签超过该时长（秒）即休眠：销毁 webview 仅保留记录。默认 60 分钟。
pub const HIBERNATE_AFTER_SECS: i64 = 60 * 60;
/// 休眠扫描周期（秒）
const HIBERNATE_SCAN_SECS: u64 = 60;
/// kv 持久化键：标签页会话（仅「重启后恢复标签页」开启时写入）
const KV_TAB_SESSION: &str = "tab_session";

/// 前端标签页视图模型
#[derive(Clone, Serialize)]
pub struct TabInfo {
    /// webview label（tab-N），同时作为前端 data-id
    pub id: String,
    pub title: String,
    pub url: String,
    pub active: bool,
    /// true = webview 已休眠销毁，点击激活时按 url 重建加载
    pub hibernated: bool,
}

#[derive(Clone)]
struct TabEntry {
    id: String,
    title: String,
    url: String,
    hibernated: bool,
    /// 最近一次激活的 Unix 秒（0 = 恢复出来的休眠条目）
    last_active: i64,
}

/// 持久化的单条标签（不含 label——恢复时重新分配）
#[derive(Clone, Serialize, Deserialize, Default)]
struct StoredTab {
    url: String,
    title: String,
    active: bool,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct TabSession {
    tabs: Vec<StoredTab>,
}

struct TabInner {
    tabs: Vec<TabEntry>,
    active: Option<String>,
    /// label 计数器（单调递增，关闭后不复用）
    seq: usize,
    /// 标签区相对窗口客户区的布局（fx/fy/fw/fh），resize 时按比例同步，
    /// 替代旧 PANE_LAYOUT（最大化动画期间 DOM 防抖上报跟不上，需 Rust 侧兜底）
    rel: Option<[f64; 4]>,
}

/// 全局标签页状态（挂在 AppState 上，随 Mutex 保证并发安全）
pub struct TabState(Mutex<TabInner>);

impl TabState {
    pub fn new() -> Self {
        TabState(Mutex::new(TabInner {
            tabs: Vec::new(),
            active: None,
            seq: 1,
            rel: None,
        }))
    }
}

impl Default for TabState {
    fn default() -> Self {
        Self::new()
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ---------------- 内部工具 ----------------

/// 按相对布局 × 当前客户区尺寸算绝对物理 rect
fn rel_rect(rel: Option<[f64; 4]>, cw: f64, ch: f64) -> Option<[i32; 4]> {
    let [fx, fy, fw, fh] = rel?;
    if cw <= 1.0 || ch <= 1.0 {
        return None;
    }
    Some([
        (fx * cw).round() as i32,
        (fy * ch).round() as i32,
        (fw * cw).round() as i32,
        (fh * ch).round() as i32,
    ])
}

/// 当前标签区 rect：优先相对布局 × 主窗实时尺寸；无相对布局时退化为整窗
fn current_rect(app: &AppHandle, inner: &TabInner) -> [i32; 4] {
    if let Some(main) = app.get_window("main") {
        if let Ok(size) = main.inner_size() {
            if let Some(r) = rel_rect(inner.rel, size.width as f64, size.height as f64) {
                return r;
            }
        }
    }
    [0, 0, 800, 600]
}

/// 记录前端上报的相对布局（与旧 store_pane_layout 同逻辑）
fn store_rel(app: &AppHandle, inner: &mut TabInner, x: i32, y: i32, w: i32, h: i32) {
    if let Some(main) = app.get_window("main") {
        if let Ok(size) = main.inner_size() {
            let (cw, ch) = (size.width as f64, size.height as f64);
            if cw > 1.0 && ch > 1.0 {
                inner.rel = Some([x as f64 / cw, y as f64 / ch, w as f64 / cw, h as f64 / ch]);
                return;
            }
        }
    }
    inner.rel = None;
}

fn set_tab_bounds<R: tauri::Runtime>(wv: &tauri::Webview<R>, r: [i32; 4]) {
    let _ = wv.set_bounds(pane_bounds_of(r[0], r[1], r[2], r[3]));
}

/// URL → 临时标题（真实标题由页面内 3s 轮询上报，见 tab_extra_script）
fn title_from_url(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => {
            let host = u.host_str().unwrap_or("");
            let last = u.path().trim_end_matches('/').rsplit('/').next().unwrap_or("");
            let s = if last.is_empty() {
                host.to_string()
            } else {
                format!("{host}/{last}")
            };
            let mut out: String = s.chars().take(24).collect();
            if out.is_empty() {
                out = "新标签页".to_string();
            }
            out
        }
        Err(_) => "新标签页".to_string(),
    }
}

/// window.close 兜底哨兵：页面 JS 调 window.close() 时若 IPC 不可用，
/// 以标题哨兵上报，Rust 端 on_document_title_changed 捕获后关标签/关窗。
pub(crate) const CLOSE_SENTINEL: &str = "__aif_close__";

/// window.close 捕获脚本（标签与 B/S 弹窗共用）：
/// - IPC 可用（域在 capabilities remote 白名单）→ invoke tab_close_self；
/// - IPC 不可用（__TAURI_INTERNALS__ 未注入 / invoke 报错）→ 标题哨兵兜底。
/// 双通道确保任意部署形态（域名/IP/端口）都能捕捉页面发起的关闭。
pub(crate) fn close_capture_script(label: &str) -> String {
    format!(
        r#"
(function () {{
  var LABEL = "{label}";
  var doClose = function () {{
    var invoked = false;
    try {{
      var t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === "function") {{
        invoked = true;
        t.invoke("tab_close_self", {{ label: LABEL }}).catch(function (err) {{
          console.error("[aif] tab_close_self 失败，转标题哨兵:", err);
          try {{ document.title = "{sentinel}"; }} catch (e2) {{}}
        }});
      }}
    }} catch (e) {{
      console.error("[aif] close 调用异常:", e);
    }}
    if (!invoked) {{
      try {{ document.title = "{sentinel}"; }} catch (e2) {{}}
    }}
  }};
  try {{
    Object.defineProperty(window, "close", {{ value: doClose, writable: false, configurable: false }});
  }} catch (e) {{
    window.close = doClose;
  }}
}})();"#,
        label = label,
        sentinel = CLOSE_SENTINEL,
    )
}

/// 关闭指定标签（存在才关）：tab_close_self 命令与标题哨兵兜底共用。
fn close_tab_checked(app: &AppHandle, state: &std::sync::Arc<AppState>, label: &str) {
    let exists = {
        let inner = state.tabs.0.lock().unwrap();
        inner.tabs.iter().any(|t| t.id == label)
    };
    log::info!("[tab] window.close → label={label} exists={exists}");
    if !exists {
        // 非标签 label：B/S 弹窗（bs-page-N）经同一命令关闭自身窗口
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.close();
        }
        return;
    }
    let _ = close_tab(app, state, label);
    persist_and_emit(app, state);
    // B/S 主动关闭页面常伴随数据变更（详情/编辑页），通知前端刷新消息/待办
    let _ = app.emit("bs-closed", ());
}

/// 创建标签子 webview（调用方不得持有 TabInner 锁——on_new_window 事件线程
/// 可能同步触发 open_tab_internal 再次加锁；std Mutex 不可重入）。
/// 实际上事件在 webview 事件循环异步触发，不会与 add_child 同步重入，此处仅作约定。
fn create_tab_webview(
    app: &AppHandle,
    id: &str,
    url: &str,
    rect: [i32; 4],
) -> Result<(), String> {
    let target = Url::parse(url).map_err(|e| format!("URL 无效: {e}"))?;
    let host = target.host_str().unwrap_or("").to_string();
    let main = app.get_window("main").ok_or("主窗口不存在")?;
    let init = format!("{}\n{}", BS_WINDOW_SHIM, close_capture_script(id));
    let app2 = app.clone();
    let host2 = host.clone();
    // 页面真实标题（webview 引擎维护的 document.title）变化时，直接更新存储并广播 tab-title。
    // 比页面内 JS 轮询更可靠，且天然覆盖 MPA 导航与 SPA 路由变化。
    let title_app = app.clone();
    let title_id = id.to_string();
    // 初始 URL 用 about:blank：避免创建即触发对 B/S 的首导航（彼时尚未注入会话 cookie，
    // 会被整页重定向到登录页）。先注入会话、再在下方 navigate(target) 才是带会话的真实加载。
    let builder = WebviewBuilder::new(id, WebviewUrl::External(Url::parse("about:blank").unwrap()))
        .initialization_script(init)
        // 显式白底：WebView2 默认底色跟随系统主题（深色模式首帧黑屏），B/S 页面为浅色，
        // 白底让首帧与页面底色一致，消除黑闪
        .background_color(tauri::webview::Color(255, 255, 255, 255))
        .on_document_title_changed(move |_wv, title| {
            if title == CLOSE_SENTINEL {
                // window.close 兜底（IPC 不可用路径）：标题哨兵 → 关所属标签
                let st: tauri::State<'_, std::sync::Arc<AppState>> = title_app.state();
                let st2 = st.inner().clone();
                let app3 = title_app.clone();
                let lid = title_id.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    close_tab_checked(&app3, &st2, &lid);
                });
                return;
            }
            if title.trim().is_empty() {
                return; // about:blank 等空标题不回写，避免标题闪空
            }
            let st: tauri::State<'_, std::sync::Arc<AppState>> = title_app.state();
            let changed = {
                let mut inner = st.tabs.0.lock().unwrap();
                match inner.tabs.iter_mut().find(|t| t.id == title_id) {
                    Some(e) if e.title != title => {
                        e.title = title.clone();
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                let _ = title_app.emit(
                    "tab-title",
                    serde_json::json!({ "id": title_id, "title": title }),
                );
            }
        })
        // 标签内 window.open / target=_blank：
        // - 同域且非弹窗尺寸（无 size 特征）→ 转兄弟标签页；
        // - 弹窗（带 size，如 B/S 选人等模态小窗）/ about:blank（页面要写入句柄）/
        //   外域 → 沿用既有混合策略（受控独立窗口 / 系统浏览器）。
        .on_new_window(move |u, f| {
            let blank = u.host_str().is_none();
            let same_host = u
                .host_str()
                .map(|h| h.eq_ignore_ascii_case(&host2))
                .unwrap_or(false);
            let popup = f.size().is_some();
            if !blank && same_host && !popup {
                if let Some(st) = app2.try_state::<std::sync::Arc<AppState>>() {
                    // 本回调在主线程（WebMessageReceived 链）执行，open_tab_internal
                    // 内部的 add_child 若在此同步调用会主线程自死锁——必须 spawn 移出。
                    let app3 = app2.clone();
                    let st2 = st.inner().clone();
                    let u2 = u.to_string();
                    tauri::async_runtime::spawn(async move {
                        match open_tab_internal(&app3, &st2, &u2, true) {
                            Ok(new_id) => {
                                log::info!("[tab] 域内链接转新标签页: {u2} → {new_id}");
                            }
                            Err(e) => {
                                log::warn!("[tab] 域内链接转标签页失败: {u2}: {e}");
                                let _ = app3.emit(
                                    "relogin-failed",
                                    format!("新标签页打开失败，请手动打开: {e}"),
                                );
                            }
                        }
                    });
                    return NewWindowResponse::Deny;
                }
            }
            bs_new_window_strategy(&app2, u, f, &host2)
        })
        .on_download(bs_download_handler)
        // 首帧防黑闪：创建后先隐藏（见下方 hide），等页面加载完成（Finished 且非
        // about:）再显示——Started 时 WebView2 首次合成未完成，提前显示会闪黑底；
        // 加载期间露出的是主窗浅色底，无突兀感。
        .on_page_load(|wv, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && !payload.url().as_str().starts_with("about:")
            {
                let _ = wv.show();
            }
        });
    let wv = main
        .add_child(
            builder,
            PhysicalPosition::new(rect[0], rect[1]),
            PhysicalSize::new(rect[2].max(1) as u32, rect[3].max(1) as u32),
        )
        .map_err(|e| format!("创建标签页失败: {e}"))?;
    // 创建即隐藏：覆盖控制器初始化窗口期，防首帧黑闪
    let _ = wv.hide();
    inject_session_cookies(&wv, &host);
    wv.navigate(target).map_err(|e| e.to_string())?;
    // 兜底：导航迟迟不提交（网络异常等）时 2s 后强制显示，避免标签永久空白
    let fb_app = app.clone();
    let fb_id = id.to_string();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        if let Some(wv) = fb_app.get_webview(&fb_id) {
            let _ = wv.show();
        }
    });
    Ok(())
}

/// 当前入口落地页（「+」新建标签 / 空 url 打开时的目标）
fn landing_url(state: &std::sync::Arc<AppState>) -> String {
    let s = state.settings.lock().unwrap();
    format!("{}/{}/user/index.htm", s.base_url.trim_end_matches('/'), s.app_root())
}

/// 开一个新标签（activate=true 设为激活；false 仅创建后隐藏，供恢复用）。
/// 返回新标签 label。锁外执行 webview 创建，失败时回滚 entry。
fn open_tab_internal(
    app: &AppHandle,
    state: &std::sync::Arc<AppState>,
    url: &str,
    activate: bool,
) -> Result<String, String> {
    let (id, prev_active, rect) = {
        let mut inner = state.tabs.0.lock().unwrap();
        if inner.tabs.len() >= TAB_LIMIT {
            return Err(format!("标签页数量已达上限（{TAB_LIMIT}）"));
        }
        let id = format!("tab-{}", inner.seq);
        inner.seq += 1;
        let prev = inner.active.clone();
        let rect = current_rect(app, &inner);
        inner.tabs.push(TabEntry {
            id: id.clone(),
            title: title_from_url(url),
            url: url.to_string(),
            hibernated: false,
            last_active: now_secs(),
        });
        if activate {
            inner.active = Some(id.clone());
        }
        (id, prev, rect)
    };
    // 旧激活归零（新标签叠在同一 rect 上，必须显隐而非依赖 z-order）
    if activate {
        if let Some(p) = prev_active {
            if p != id {
                if let Some(wv) = app.get_webview(&p) {
                    set_tab_bounds(&wv, [0, 0, 0, 0]);
                }
            }
        }
    }
    if let Err(e) = create_tab_webview(app, &id, url, rect) {
        let mut inner = state.tabs.0.lock().unwrap();
        inner.tabs.retain(|t| t.id != id);
        return Err(e);
    }
    if !activate {
        if let Some(wv) = app.get_webview(&id) {
            set_tab_bounds(&wv, [0, 0, 0, 0]);
        }
    }
    persist_and_emit(app, state);
    Ok(id)
}

/// 激活指定标签（调用方已持有 TabInner 锁）。休眠条目按存储 url 重建 webview。
fn activate_locked(app: &AppHandle, inner: &mut TabInner, id: &str) -> Result<(), String> {
    let (url, hibernated) = {
        let e = inner
            .tabs
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "标签页不存在".to_string())?;
        e.last_active = now_secs();
        (e.url.clone(), e.hibernated)
    };
    let rect = current_rect(app, inner);
    let prev = inner.active.clone();
    inner.active = Some(id.to_string());
    if let Some(p) = prev {
        if p != id {
            if let Some(wv) = app.get_webview(&p) {
                set_tab_bounds(&wv, [0, 0, 0, 0]);
            }
        }
    }
    if hibernated {
        if let Some(e) = inner.tabs.iter_mut().find(|t| t.id == id) {
            e.hibernated = false;
        }
        create_tab_webview(app, id, &url, rect)?;
    } else if let Some(wv) = app.get_webview(id) {
        set_tab_bounds(&wv, rect);
    }
    Ok(())
}

/// 关闭并移除标签。仅当关闭的是当前激活标签时才让位给右侧邻居
/// （无则左侧）——关闭后台标签不影响当前激活项，与浏览器行为一致。
fn close_tab(app: &AppHandle, state: &std::sync::Arc<AppState>, id: &str) -> Result<(), String> {
    let mut inner = state.tabs.0.lock().unwrap();
    let idx = inner
        .tabs
        .iter()
        .position(|t| t.id == id)
        .ok_or_else(|| "标签页不存在".to_string())?;
    let was_active = inner.active.as_deref() == Some(id);
    inner.tabs.remove(idx);
    if let Some(wv) = app.get_webview(id) {
        let _ = wv.close();
    }
    if was_active {
        // 右侧邻居（remove 后原 idx 位置即为右邻）；无右邻取左邻
        let neighbor = inner
            .tabs
            .get(idx)
            .or_else(|| idx.checked_sub(1).and_then(|i| inner.tabs.get(i)))
            .map(|t| t.id.clone());
        match neighbor {
            Some(nid) => activate_locked(app, &mut inner, &nid)?,
            None => {
                inner.active = None;
            }
        }
    }
    if inner.tabs.is_empty() {
        if let Ok(conn) = state.db.lock() {
            let _ = db::kv_delete(&conn, KV_TAB_SESSION);
        }
    }
    Ok(())
}

/// 仅关闭不激活邻居（批量「关闭其他」用，避免每关一个都抢激活）
fn close_tab_quiet(app: &AppHandle, state: &std::sync::Arc<AppState>, id: &str) {
    let mut inner = state.tabs.0.lock().unwrap();
    inner.tabs.retain(|t| t.id != id);
    drop(inner);
    if let Some(wv) = app.get_webview(id) {
        let _ = wv.close();
    }
}

fn tab_list(state: &std::sync::Arc<AppState>) -> Vec<TabInfo> {
    let inner = state.tabs.0.lock().unwrap();
    inner
        .tabs
        .iter()
        .map(|t| TabInfo {
            id: t.id.clone(),
            title: t.title.clone(),
            url: t.url.clone(),
            active: inner.active.as_deref() == Some(t.id.as_str()),
            hibernated: t.hibernated,
        })
        .collect()
}

/// 持久化（设置开启时）+ 广播列表变化
fn persist_and_emit(app: &AppHandle, state: &std::sync::Arc<AppState>) {
    let restore = state.settings.lock().unwrap().tab_restore;
    let list = tab_list(state);
    if restore {
        let session = TabSession {
            tabs: list
                .iter()
                .map(|t| StoredTab {
                    url: t.url.clone(),
                    title: t.title.clone(),
                    active: t.active,
                })
                .collect(),
        };
        if let Ok(json) = serde_json::to_string(&session) {
            if let Ok(conn) = state.db.lock() {
                let _ = db::kv_set(&conn, KV_TAB_SESSION, &json);
            }
        }
    }
    let _ = app.emit("tabs-changed", &list);
}

// ---------------- Tauri 命令 ----------------

// 【线程模型·重要】tauri 同步命令在主线程执行（WebView2 WebMessageReceived 回调链），
// 而创建子 webview 的 add_child 内部是 run_on_main_thread + rx.recv() 阻塞等待——
// 若在主线程调用会自死锁（任务入队后无人泵消息）。因此所有 tab 命令一律 async +
// spawn_blocking 移到 worker 线程执行；webview 的 set_bounds/close/eval 等 API 内部
// 自行派发回主线程，从 worker 调用安全。

/// 全屏模式打开/新建标签。url 为空串 → 当前入口落地页。
/// x/y/w/h 为前端上报的标签视口物理 rect（同时记录为相对布局供 resize 兜底）。
#[tauri::command]
pub async fn tab_open(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    url: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<TabInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tab_open_impl(app, state, url, x, y, w, h))
        .await
        .map_err(|e| format!("标签任务执行失败: {e}"))?
}

fn tab_open_impl(
    app: AppHandle,
    state: std::sync::Arc<AppState>,
    url: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<TabInfo, String> {
    {
        let mut inner = state.tabs.0.lock().unwrap();
        store_rel(&app, &mut inner, x, y, w, h);
    }
    let target = if url.trim().is_empty() {
        landing_url(&state)
    } else {
        url.trim().to_string()
    };
    let id = open_tab_internal(&app, &state, &target, true)?;
    let inner = state.tabs.0.lock().unwrap();
    inner
        .tabs
        .iter()
        .find(|t| t.id == id)
        .map(|t| TabInfo {
            id: t.id.clone(),
            title: t.title.clone(),
            url: t.url.clone(),
            active: inner.active.as_deref() == Some(t.id.as_str()),
            hibernated: t.hibernated,
        })
        .ok_or_else(|| "标签页创建后消失".to_string())
}

/// 激活标签（休眠标签按存储 url 重新加载）
#[tauri::command]
pub async fn tab_activate(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    id: String,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        {
            let mut inner = state.tabs.0.lock().unwrap();
            if inner.active.as_deref() != Some(id.as_str()) {
                activate_locked(&app, &mut inner, &id)?;
            }
        }
        persist_and_emit(&app, &state);
        Ok(tab_list(&state))
    })
    .await
    .map_err(|e| format!("标签任务执行失败: {e}"))?
}

/// 关闭标签（激活右侧邻居）
#[tauri::command]
pub async fn tab_close(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    id: String,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        close_tab(&app, &state, &id)?;
        persist_and_emit(&app, &state);
        Ok(tab_list(&state))
    })
    .await
    .map_err(|e| format!("标签任务执行失败: {e}"))?
}

/// 关闭其他标签（保留 id）
#[tauri::command]
pub async fn tab_close_others(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    id: String,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 先把保留项设为激活，避免关闭过程中邻居被反复激活
        {
            let mut inner = state.tabs.0.lock().unwrap();
            if inner.active.as_deref() != Some(id.as_str()) {
                activate_locked(&app, &mut inner, &id)?;
            }
        }
        let victims: Vec<String> = {
            let inner = state.tabs.0.lock().unwrap();
            inner
                .tabs
                .iter()
                .filter(|t| t.id != id)
                .map(|t| t.id.clone())
                .collect()
        };
        for v in victims {
            close_tab_quiet(&app, &state, &v);
        }
        persist_and_emit(&app, &state);
        Ok(tab_list(&state))
    })
    .await
    .map_err(|e| format!("标签任务执行失败: {e}"))?
}

/// 关闭全部标签
#[tauri::command]
pub async fn tab_close_all(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<String> = {
            let inner = state.tabs.0.lock().unwrap();
            inner.tabs.iter().map(|t| t.id.clone()).collect()
        };
        for id in ids {
            if let Some(wv) = app.get_webview(&id) {
                let _ = wv.close();
            }
        }
        {
            let mut inner = state.tabs.0.lock().unwrap();
            inner.tabs.clear();
            inner.active = None;
        }
        if let Ok(conn) = state.db.lock() {
            let _ = db::kv_delete(&conn, KV_TAB_SESSION);
        }
        let _ = app.emit("tabs-changed", Vec::<TabInfo>::new());
        Ok(vec![])
    })
    .await
    .map_err(|e| format!("标签任务执行失败: {e}"))?
}

/// 刷新标签（休眠标签按存储 url 重建加载）
#[tauri::command]
pub async fn tab_reload(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    id: String,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let hibernated = {
            let inner = state.tabs.0.lock().unwrap();
            inner.tabs.iter().find(|t| t.id == id).map(|t| t.hibernated)
        };
        match hibernated {
            Some(true) => {
                let mut inner = state.tabs.0.lock().unwrap();
                activate_locked(&app, &mut inner, &id)?;
            }
            Some(false) => {
                if let Some(wv) = app.get_webview(&id) {
                    let _ = wv.reload();
                }
            }
            None => return Err("标签页不存在".to_string()),
        }
        persist_and_emit(&app, &state);
        Ok(tab_list(&state))
    })
    .await
    .map_err(|e| format!("标签任务执行失败: {e}"))?
}

/// 标签列表（前端启动时同步用）
#[tauri::command]
pub fn tab_list_cmd(state: tauri::State<'_, std::sync::Arc<AppState>>) -> Vec<TabInfo> {
    tab_list(&state)
}

/// 前端 resize/折叠列表页后上报标签视口 rect（同步绝对边界 + 记录相对布局）
#[tauri::command]
pub fn tab_bounds(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
) -> Result<(), String> {
    {
        let mut inner = state.tabs.0.lock().unwrap();
        store_rel(&app, &mut inner, x, y, w, h);
    }
    let active = {
        let inner = state.tabs.0.lock().unwrap();
        inner.active.clone()
    };
    if let Some(a) = active {
        if let Some(wv) = app.get_webview(&a) {
            set_tab_bounds(&wv, [x, y, w, h]);
        }
    }
    Ok(())
}

/// 主窗模态框（入口切换弹窗等）打开期间：全部标签临时隐藏
#[tauri::command]
pub fn tab_hide_all(app: AppHandle, state: tauri::State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    let ids: Vec<String> = {
        let inner = state.tabs.0.lock().unwrap();
        inner.tabs.iter().map(|t| t.id.clone()).collect()
    };
    for id in ids {
        if let Some(wv) = app.get_webview(&id) {
            set_tab_bounds(&wv, [0, 0, 0, 0]);
        }
    }
    Ok(())
}

/// 模态框关闭后恢复激活标签的边界
#[tauri::command]
pub fn tab_restore_all(app: AppHandle, state: tauri::State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    let active = {
        let inner = state.tabs.0.lock().unwrap();
        inner.active.clone()
    };
    if let Some(a) = active {
        if let Some(wv) = app.get_webview(&a) {
            let rect = {
                let inner = state.tabs.0.lock().unwrap();
                current_rect(&app, &inner)
            };
            set_tab_bounds(&wv, rect);
        }
    }
    Ok(())
}

/// 页面内标题上报（tab_extra_script 的 3s 轮询调用）
#[tauri::command]
pub fn tab_report_title(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    label: String,
    title: String,
) {
    let changed = {
        let mut inner = state.tabs.0.lock().unwrap();
        match inner.tabs.iter_mut().find(|t| t.id == label) {
            Some(e) if e.title != title => {
                e.title = title.clone();
                true
            }
            _ => false,
        }
    };
    if changed {
        let _ = app.emit(
            "tab-title",
            serde_json::json!({ "id": label, "title": title }),
        );
    }
}

/// B/S 页面在标签/弹窗内调用 window.close() → 关闭所属标签（tab-N）或弹窗窗口（bs-page-N）。
/// label 由注入脚本焙入，仅接受真实存在的对象（本地应用，无越权面）。
#[tauri::command]
pub async fn tab_close_self(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    label: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        close_tab_checked(&app, &state, &label);
    })
    .await;
    Ok(())
}

/// 重启后恢复上次标签页（设置开启时由前端进入全屏模式时调用）。
/// 以休眠条目恢复（不立即建 webview），激活哪个才加载哪个——控制启动开销。
#[tauri::command]
pub async fn tab_restore_session(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tab_restore_session_impl(app, state))
        .await
        .map_err(|e| format!("标签任务执行失败: {e}"))?
}

fn tab_restore_session_impl(
    app: AppHandle,
    state: std::sync::Arc<AppState>,
) -> Result<Vec<TabInfo>, String> {
    let restore = state.settings.lock().unwrap().tab_restore;
    if !restore {
        return Ok(vec![]);
    }
    let raw = state
        .db
        .lock()
        .ok()
        .and_then(|c| db::kv_get(&c, KV_TAB_SESSION))
        .unwrap_or_default();
    let session: TabSession = serde_json::from_str(&raw).unwrap_or_default();
    if session.tabs.is_empty() {
        return Ok(vec![]);
    }
    // 已有标签先全关（正常不会发生，防御性）
    let existing: Vec<String> = {
        let inner = state.tabs.0.lock().unwrap();
        inner.tabs.iter().map(|t| t.id.clone()).collect()
    };
    for id in existing {
        if let Some(wv) = app.get_webview(&id) {
            let _ = wv.close();
        }
    }
    let want_idx = session.tabs.iter().position(|t| t.active);
    {
        let mut inner = state.tabs.0.lock().unwrap();
        inner.tabs.clear();
        inner.active = None;
        for st in &session.tabs {
            if st.url.trim().is_empty() {
                continue;
            }
            let id = format!("tab-{}", inner.seq);
            inner.seq += 1;
            inner.tabs.push(TabEntry {
                id,
                title: if st.title.trim().is_empty() {
                    title_from_url(&st.url)
                } else {
                    st.title.clone()
                },
                url: st.url.clone(),
                hibernated: true,
                last_active: 0,
            });
        }
        let target = want_idx
            .and_then(|i| inner.tabs.get(i).map(|t| t.id.clone()))
            .or_else(|| inner.tabs.last().map(|t| t.id.clone()));
        if let Some(tid) = target {
            activate_locked(&app, &mut inner, &tid)?;
        }
    }
    persist_and_emit(&app, &state);
    Ok(tab_list(&state))
}

/// 在已有标签内重新加载到新 URL（单标签模式下「点击页面只更新该标签」用）。
/// 更新存储的 url/title 并将该标签设为激活；休眠条目按新 url 重建 webview。
fn tab_navigate_impl(
    app: &AppHandle,
    state: &std::sync::Arc<AppState>,
    id: &str,
    url: &str,
) -> Result<Vec<TabInfo>, String> {
    let target = if url.trim().is_empty() {
        landing_url(state)
    } else {
        url.trim().to_string()
    };
    let (rect, prev_active) = {
        let mut inner = state.tabs.0.lock().unwrap();
        let e = inner
            .tabs
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "标签页不存在".to_string())?;
        e.url = target.clone();
        e.title = title_from_url(&target);
        e.last_active = now_secs();
        e.hibernated = false;
        let prev = inner.active.clone();
        inner.active = Some(id.to_string());
        (current_rect(app, &inner), prev)
    };
    // 旧激活归零（同 tab_open：新标签叠在同一 rect 上，靠显隐而非 z-order）
    if let Some(p) = prev_active {
        if p != id {
            if let Some(wv) = app.get_webview(&p) {
                set_tab_bounds(&wv, [0, 0, 0, 0]);
            }
        }
    }
    if let Some(wv) = app.get_webview(id) {
        let _ = wv.navigate(Url::parse(&target).map_err(|e| e.to_string())?);
        set_tab_bounds(&wv, rect);
    } else {
        // 休眠/已销毁的标签：按新 url 重建 webview
        create_tab_webview(app, id, &target, rect)?;
    }
    persist_and_emit(app, state);
    Ok(tab_list(state))
}

/// 导航已有标签到新 URL（单标签模式：更新而非新建）
#[tauri::command]
pub async fn tab_navigate(
    app: AppHandle,
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    id: String,
    url: String,
) -> Result<Vec<TabInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tab_navigate_impl(&app, &state, &id, &url))
        .await
        .map_err(|e| format!("标签任务执行失败: {e}"))?
}

// ---------------- 窗口尺寸同步（lib.rs Resized 调用） ----------------

/// 主窗重建（自愈路径 ensure_main_window）时调用：关闭全部标签 webview 并清空
/// 状态——子 webview 随旧窗销毁，TabState 里的记录必须一并重置，否则激活时
/// set_bounds 打到不存在的 webview 上。
pub(crate) fn reset_all(app: &AppHandle, state: &std::sync::Arc<AppState>) {
    let ids: Vec<String> = {
        let inner = state.tabs.0.lock().unwrap();
        inner.tabs.iter().map(|t| t.id.clone()).collect()
    };
    for id in ids {
        if let Some(wv) = app.get_webview(&id) {
            let _ = wv.close();
        }
    }
    {
        let mut inner = state.tabs.0.lock().unwrap();
        inner.tabs.clear();
        inner.active = None;
    }
    if let Ok(conn) = state.db.lock() {
        let _ = db::kv_delete(&conn, KV_TAB_SESSION);
    }
}

/// 窗口尺寸变化时按相对布局同步激活标签（替代旧 sync_pane_on_resize）。
/// 前端防抖上报（120ms）跟不上最大化动画，必须由 Rust 侧按比例兜底。
pub(crate) fn sync_tabs_on_resize(window: &tauri::Window, size: &tauri::PhysicalSize<u32>) {
    let Some(state) = window.try_state::<std::sync::Arc<AppState>>() else {
        return;
    };
    let active = {
        let inner = state.tabs.0.lock().unwrap();
        inner.active.clone()
    };
    let Some(active) = active else { return };
    let rect = {
        let inner = state.tabs.0.lock().unwrap();
        rel_rect(inner.rel, size.width as f64, size.height as f64)
    };
    if let (Some(r), Some(wv)) = (rect, window.get_webview(&active)) {
        set_tab_bounds(&wv, r);
    }
}

// ---------------- 休眠定时器 ----------------

/// 启动休眠扫描：每 60s 检查一次，非激活超过 HIBERNATE_AFTER_SECS 的标签
/// 销毁 webview（保留记录），激活时按 url 重建。激活中的标签永不休眠。
pub fn start(state: std::sync::Arc<AppState>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(HIBERNATE_SCAN_SECS)).await;
            let now = now_secs();
            let mut changed = false;
            {
                let mut inner = state.tabs.0.lock().unwrap();
                let active = inner.active.clone();
                for t in inner.tabs.iter_mut() {
                    if t.hibernated || active.as_deref() == Some(t.id.as_str()) {
                        continue;
                    }
                    if now - t.last_active > HIBERNATE_AFTER_SECS {
                        t.hibernated = true;
                        changed = true;
                        log::info!("[tab] 标签休眠（超 {HIBERNATE_AFTER_SECS}s 未激活）: {}", t.id);
                        if let Some(wv) = app.get_webview(&t.id) {
                            let _ = wv.close();
                        }
                    }
                }
            }
            if changed {
                persist_and_emit(&app, &state);
            }
        }
    });
}
