use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};

use crate::db;
use crate::poller;
use crate::state::AppState;

/// 托盘图标唯一 id（闪烁时按 id 取回 TrayIcon 实例）
const TRAY_ID: &str = "main-tray";
/// 是否正在闪烁（防重入 + 支持提前停止）
static FLASHING: AtomicBool = AtomicBool::new(false);
/// 菜单当前已应用的深色状态：0=浅色 1=深色 2=未初始化（去重，避免无谓重建）
static MENU_DARK: AtomicU8 = AtomicU8::new(2);
/// 待办速览菜单版本号：待办集合变化时 +1，与已应用版本比对决定是否重建菜单
static MENU_REV: AtomicU32 = AtomicU32::new(0);
/// 已应用到菜单的待办版本号（u32::MAX = 未初始化）
static MENU_REV_APPLIED: AtomicU32 = AtomicU32::new(u32::MAX);

fn normal_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
        .expect("加载托盘图标失败")
}

fn alert_icon() -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/icon_alert.png"))
        .expect("加载托盘告警图标失败")
}

/// 菜单项小图标（40×40 线性风，双套配色随系统深浅模式自动切换）。
/// 注意：IconMenuItem 的图标 Windows/Linux 支持，macOS 会忽略（muda 限制）。
fn menu_icon(dark: bool, light: &'static [u8], dark_bytes: &'static [u8]) -> tauri::image::Image<'static> {
    tauri::image::Image::from_bytes(if dark { dark_bytes } else { light }).expect("加载菜单图标失败")
}

/// 当前系统是否深色显示模式（取不到时按浅色处理）。
/// AppHandle 无 theme()，借主窗口查询（窗口与系统主题联动）。
fn is_dark(app: &AppHandle) -> bool {
    app.get_window("main")
        .and_then(|w| w.theme().ok())
        .map(|t| t == tauri::Theme::Dark)
        .unwrap_or(false)
}

/// 按当前主题 + 最新待办构建托盘右键菜单（浅色=墨黑图标 / 深色=近白图标）。
/// 中段为「待办速览」：未办结事项前 5 条，点击直达办理页。
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let dark = is_dark(app);
    let show = IconMenuItem::with_id(
        app,
        "show",
        "打开面板",
        true,
        Some(menu_icon(dark, include_bytes!("../icons/menu-show.png"), include_bytes!("../icons/menu-show-dark.png"))),
        None::<&str>,
    )?;
    let check = IconMenuItem::with_id(
        app,
        "check",
        "刷新数据",
        true,
        Some(menu_icon(dark, include_bytes!("../icons/menu-check.png"), include_bytes!("../icons/menu-check-dark.png"))),
        None::<&str>,
    )?;
    let settings = IconMenuItem::with_id(
        app,
        "settings",
        "设置",
        true,
        Some(menu_icon(dark, include_bytes!("../icons/menu-settings.png"), include_bytes!("../icons/menu-settings-dark.png"))),
        None::<&str>,
    )?;
    let quit = IconMenuItem::with_id(
        app,
        "quit",
        "退出",
        true,
        Some(menu_icon(dark, include_bytes!("../icons/menu-quit.png"), include_bytes!("../icons/menu-quit-dark.png"))),
        None::<&str>,
    )?;

    // ---- 待办速览（动态段）----
    let todos: Vec<db::TodoRow> = app
        .try_state::<Arc<AppState>>()
        .map(|st| {
            let conn = st.db.lock().unwrap();
            db::list_pending_todos_top(&conn, 5).unwrap_or_default()
        })
        .unwrap_or_default();
    let count = todos.len();
    let header_text = if count > 0 {
        format!("待办速览（{count} 件未办）")
    } else {
        "待办速览（暂无未办）".to_string()
    };
    let header = MenuItem::with_id(app, "todo-head", &header_text, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    // 动态待办项：id 编码跳转 URL（todo|{url}），label 截断 18 字防菜单过宽
    let mut todo_items: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for t in &todos {
        let label: String = {
            let mut s: String = t.title.chars().take(18).collect();
            if t.title.chars().count() > 18 {
                s.push('…');
            }
            if s.trim().is_empty() {
                s = "（无标题事项）".to_string();
            }
            format!("· {s}")
        };
        let id = format!("todo|{}", t.url);
        todo_items.push(MenuItem::with_id(app, &id, &label, true, None::<&str>)?);
    }

    // Menu::with_items 收 &dyn IsMenuItem 切片：把静态项与动态项统一装箱
    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&show, &check, &sep1, &header];
    for it in &todo_items {
        items.push(it);
    }
    items.push(&sep2);
    items.push(&settings);
    items.push(&quit);
    Menu::with_items(app, &items)
}

/// 主题变化 / 鼠标悬停托盘时：按当前系统主题重建菜单并套用。
/// 去重：主题没变就不重建（悬停事件高频触发时零开销）。
///
/// 关键约束：绝不能在托盘「右键 Up」事件里 set_menu —— Windows 恰好在右键 Up
/// 时弹出菜单，此刻替换菜单会把弹窗顶掉，表现为菜单不可见。所以兜底同步
/// 挂在鼠标 Enter（悬停）上，离点击有充足时间差。
fn sync_menu(app: &AppHandle) {
    let dark = is_dark(app) as u8;
    let rev = MENU_REV.load(Ordering::SeqCst);
    if MENU_DARK.load(Ordering::SeqCst) == dark && MENU_REV_APPLIED.load(Ordering::SeqCst) == rev {
        return; // 主题与待办均未变化，无需重建
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        match build_menu(app) {
            Ok(m) => {
                let _ = tray.set_menu(Some(m));
                MENU_DARK.store(dark, Ordering::SeqCst);
                MENU_REV_APPLIED.store(rev, Ordering::SeqCst);
            }
            Err(e) => log::warn!("重建托盘菜单失败: {e}"),
        }
    }
}

/// 待办集合变化时由 poller 调用：版本号 +1 并立即重建菜单（带去重）
pub fn refresh_menu(app: &AppHandle) {
    MENU_REV.fetch_add(1, Ordering::SeqCst);
    sync_menu(app);
}

/// 构建托盘图标与右键菜单，并处理菜单事件
pub fn build(app: &AppHandle) -> anyhow::Result<()> {
    let menu = build_menu(app)?;
    // 记录初始菜单主题，供 sync_menu 去重
    MENU_DARK.store(is_dark(app) as u8, Ordering::SeqCst);

    // 托盘图标：编译期嵌入 icons/icon.png。
    // 不用 resource_dir：dev 模式下它指向 target\debug\，图标并不在那，会 os error 3。
    let icon = normal_icon();

    // 托盘提示随产品品牌：运维=「运维小助手」/ 一表通=「一表通小助手」
    let tooltip = app
        .try_state::<Arc<AppState>>()
        .map(|s| s.settings.lock().unwrap().product_title().to_string())
        .unwrap_or_else(|| "业务小助手".to_string());

    let _tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip(&tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        // 左键单击：右下角弹出面板并聚焦（不自动收起；收起用面板上的最小化按钮）
        .on_tray_icon_event(|tray, event| {
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } => {
                    // 左键单击：右下角弹出面板并聚焦（不自动收起；收起用面板上的最小化按钮）
                    toggle_panel(tray.app_handle());
                }
                // 鼠标悬停托盘：主题有变则提前重建菜单（去重后零开销），
                // 兜底主窗口隐藏时 ThemeChanged 事件丢失的场景。
                // 注意：不能挂右键 Up——Windows 在右键 Up 弹菜单，此刻 set_menu 会顶掉弹窗。
                TrayIconEvent::Enter { .. } => {
                    sync_menu(tray.app_handle());
                }
                _ => {}
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_panel(app),
            "check" => {
                // State<'_, _> 借自 app，不能进 async 块；取 Arc 克隆
                let state = app.state::<Arc<AppState>>().inner().clone();
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    poller::poll_once(&state, &app2).await;
                });
            }
            "settings" => {
                show_panel(app);
                let _ = app.emit("open-settings", ());
            }
            "quit" => app.exit(0),
            // 待办速览项：弹出面板并直达办理页（todo|{url}，url 为空仅打开面板）
            id if id.starts_with("todo|") => {
                let url = id.trim_start_matches("todo|").to_string();
                show_panel(app);
                if !url.is_empty() {
                    let _ = app.emit("open-message-url", url);
                }
            }
            _ => {}
        })
        .build(app)?;

    // 系统深浅模式切换 → 重建菜单图标。主窗口隐藏时 Windows 一般仍会派发
    // ThemeChanged；万一丢失，托盘悬停（Enter）时的 sync_menu 兜底。
    if let Some(w) = app.get_window("main") {
        let app2 = app.clone();
        w.on_window_event(move |e| {
            if matches!(e, tauri::WindowEvent::ThemeChanged(_)) {
                sync_menu(&app2);
            }
        });
    }

    Ok(())
}

/// 面板显示：已可见则仅聚焦，不自动收起（窗口常驻桌面，最小化按钮才缩回托盘）。
/// 注意：打开面板**不再**停止托盘闪烁 —— 按用户约定（2026-10-15），
/// 新消息闪烁持续到「打开应用界面后点击任意消息」（前端经 tray_flash_stop 停止）。
fn toggle_panel(app: &AppHandle) {
    raise_main(app);
    let _ = app.emit("panel-shown", ());
}

/// 显示面板（定位屏幕右下角后弹出）。全局快捷键也走这里。
pub fn show_panel(app: &AppHandle) {
    raise_main(app);
    let _ = app.emit("panel-shown", ());
}

/// 弹出并抢前台。Windows 下从托盘/全局热键唤起时，本进程没有前台权限，
/// set_focus 首次会被系统拒绝 → 窗口被压在后面，看起来「点了没反应」；
/// 借助 always_on_top 强制置顶一次再还原（社区通用解法），保证第一次就到最前。
pub(crate) fn raise_main(app: &AppHandle) {
    log::info!("[raise] enter");
    // 必须用 get_window：get_webview_window("main") 在窗口含 pane 子 webview 时
    // 被 is_webview_window 过滤恒为 None（tauri 2.12 行为，历史上 NOT FOUND 的根因）
    let w = app.get_window("main");
    // [自愈] 主窗确实不存在（被异常销毁）：异步重建后重新走 raise
    if w.is_none() {
        log::warn!("[raise] 主窗口丢失，异步自愈重建");
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            if crate::commands::ensure_main_window(&app2).await.is_ok() {
                raise_main(&app2);
            }
        });
        return;
    }
    let Some(w) = w else { return };
    // 全屏窗口不做右下角定位，否则唤起时窗口被挪位：
    // - tao 语义 maximized（原生最大化）：set_position 会清 MAXIMIZED 标志（SW_RESTORE）；
    // - 伪全屏（layout_full 用 set_size 显式铺满工作区）：is_maximized() 为 false，
    //   若按整屏尺寸计算 y 会出现负偏移（顶部悬出屏幕）。
    // 两种情况统一按「窗口尺寸 ≈ 工作区」判定后跳过定位。
    let is_full = crate::commands::work_area_of(&w)
        .map(|(l, t, r, b)| {
            let s = w.outer_size().unwrap_or_default();
            (s.width as i32 - (r - l)).abs() < 24 && (s.height as i32 - (b - t)).abs() < 24
        })
        .unwrap_or(false);
    let was_maximized = w.is_maximized().unwrap_or(false);
    if !was_maximized && !is_full {
        place_bottom_right(&w);
    }
    log::info!(
        "[raise] state: visible={:?} minimized={:?} maximized={:?}",
        w.is_visible(),
        w.is_minimized(),
        w.is_maximized()
    );
    let _ = w.show();
    let _ = w.unminimize();
    #[cfg(target_os = "windows")]
    {
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        let _ = w.set_always_on_top(false);
    }
    #[cfg(not(target_os = "windows"))]
    let _ = w.set_focus();
    log::info!(
        "[raise] done: visible={:?} maximized={:?}",
        w.is_visible(),
        w.is_maximized()
    );
}

/// 新消息到达：托盘图标闪烁（常态图 ↔ 感叹号告警图，500ms 交替）。
/// **持续闪烁**直到用户在应用内点击任意消息（前端调用 tray_flash_stop）；
/// 位置稳定性：只用 set_icon（底层 NIM_MODIFY）替换图标像素，
/// (hWnd, uID) 身份不变，Explorer 不重排托盘布局（对比删除再添加的错误实现）。
pub fn flash(app: &AppHandle) {
    if FLASHING.swap(true, Ordering::SeqCst) {
        return; // 已在闪烁
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let mut i = 0u32;
            while FLASHING.load(Ordering::SeqCst) {
                let icon = if i % 2 == 0 { alert_icon() } else { normal_icon() };
                let _ = tray.set_icon(Some(icon));
                tokio::time::sleep(Duration::from_millis(500)).await;
                i += 1;
            }
            let _ = tray.set_icon(Some(normal_icon()));
        }
        FLASHING.store(false, Ordering::SeqCst);
    });
}

/// 短时闪烁（7 秒自停）：每日摘要 / 待办超时升级等「提示性」场景，
/// 没有对应的「点击消息」停止动作，不能无限闪。
pub fn flash_brief(app: &AppHandle) {
    if FLASHING.swap(true, Ordering::SeqCst) {
        return; // 已在闪烁
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            for i in 0..14 {
                if !FLASHING.load(Ordering::SeqCst) {
                    break;
                }
                let icon = if i % 2 == 0 { alert_icon() } else { normal_icon() };
                let _ = tray.set_icon(Some(icon));
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            let _ = tray.set_icon(Some(normal_icon()));
        }
        FLASHING.store(false, Ordering::SeqCst);
    });
}

/// 停止闪烁并恢复常态图标
pub fn stop_flash(app: &AppHandle) {
    FLASHING.store(false, Ordering::SeqCst);
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_icon(Some(normal_icon()));
    }
}

/// 把窗口定位到当前屏右下角（工作区坐标，已排除任务栏；边距见 MINI_EDGE_MARGIN）
fn place_bottom_right(w: &tauri::Window) {
    if let Some((l, t, r, b)) = crate::commands::work_area_of(w) {
        let wsize = w
            .outer_size()
            .unwrap_or(tauri::PhysicalSize::new(360, 640));
        let m = crate::commands::MINI_EDGE_MARGIN;
        let x = (r - wsize.width as i32 - m).max(l);
        let y = (b - wsize.height as i32 - m).max(t);
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
}
