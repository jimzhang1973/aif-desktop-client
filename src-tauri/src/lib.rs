mod auth;
mod commands;
mod db;
mod hotkey;
mod poller;
mod sm4;
mod state;
mod tabs;
mod tray;

use std::sync::Arc;

use tauri::Manager;
use tauri_plugin_global_shortcut::ShortcutState;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_log::Builder::new().build())
        // 全局快捷键：按下即切换主窗口显示/隐藏（注册内容见 settings.hotkey）
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        hotkey::toggle_main(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 第二实例启动时聚焦已存在的待办窗（同样要抢前台）
            tray::raise_main(app);
        }))
        // 关闭窗口 ≠ 退出：主窗隐藏到托盘，托盘菜单「退出」才真正退出
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
                // 内嵌标签页跟随窗口尺寸：按相对布局直接同步（前端防抖上报有延迟，
                // 最大化/还原动画期间会出现 DOM 与标签错位的空隙）
                tauri::WindowEvent::Resized(size) => {
                    if window.label() == "main" {
                        tabs::sync_tabs_on_resize(window, size);
                        // 主 webview 重新铺满，矫正 borderless+最大化+高 DPI 下
                        // WebView2 原点错位导致顶栏/导航栏被裁出可视区。
                        // 使用 Resized 事件携带的真实新尺寸，避免 maximize() 瞬间
                        // 读到旧尺寸把 webview 缩成小窗（此前因此缺失区域加大）。
                        commands::reflow_main_webview(window, *size);
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("无法获取应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("aif_client.db");
            let conn = db::init(&db_path).expect("初始化本地数据库失败");
            let settings = db::get_settings(&conn);
            let hotkey = settings.hotkey.clone();
            let state = Arc::new(AppState::new(conn, settings));
            // 预热会话缓存：从钥匙串读一次会话填进内存，避免启动首查受钥匙串并发抖动影响
            auth::warm_session();
            app.manage(state.clone());

            // 主窗口标题按产品品牌（运维小助手 / 一表通小助手），覆盖 tauri.conf.json 静态值
            // 注意用 get_window（get_webview_window 在窗口含 pane 子 webview 时恒为 None）
            if let Some(w) = app.get_window("main") {
                let title = state.settings.lock().unwrap().product_title();
                let _ = w.set_title(title);
            }

            tray::build(&app.handle()).map_err(|e| e.to_string())?;
            poller::start(state.clone(), app.handle().clone());
            // 标签页休眠扫描（非激活超 60min 自动销毁 webview，控常驻内存）
            tabs::start(state.clone(), app.handle().clone());
            // 启动即注册已保存的全局快捷键（失败仅告警，不阻塞启动）
            if !hotkey.trim().is_empty() {
                if let Err(e) = hotkey::apply(&app.handle(), &hotkey) {
                    log::warn!("启动注册全局快捷键失败: {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_session,
            commands::report_requests,
            commands::logout,
            commands::quit_app,
            commands::is_logged_in,
            commands::get_todos,
            commands::get_messages,
            commands::get_message_history,
            commands::get_matters,
            commands::mark_todo_done,
            commands::get_settings,
            commands::save_settings,
            commands::get_app_version,
            commands::check_now,
            commands::login_webview,
            commands::open_conversation,
            commands::login_qr,
            commands::poll_qr,
            commands::get_captcha,
            commands::check_captcha_required,
            commands::login_local,
            commands::get_credential_hint,
            commands::get_user_info,
            commands::get_roles,
            commands::switch_role,
            commands::get_docs,
            commands::get_spaces,
            commands::get_ops_apps,
            commands::get_ai_agents,
            commands::get_quick_entries,
            commands::close_webview_self,
            commands::open_external,
            commands::set_autostart,
            commands::set_hotkey,
            commands::try_auto_login,
            commands::account_list,
            commands::account_save,
            commands::account_delete,
            tabs::tab_open,
            tabs::tab_activate,
            tabs::tab_close,
            tabs::tab_close_others,
            tabs::tab_close_all,
            tabs::tab_reload,
            tabs::tab_list_cmd,
            tabs::tab_bounds,
            tabs::tab_hide_all,
            tabs::tab_restore_all,
            tabs::tab_report_title,
            tabs::tab_close_self,
            tabs::tab_restore_session,
            tabs::tab_navigate,
            commands::layout_full,
            commands::layout_mini,
            commands::debug_webview_rect,
            commands::debug_dump,
            commands::trace_invoke,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
