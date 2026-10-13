//! 全局快捷键：注册系统级 HotKey，按下时弹出/隐藏主窗口（toggle）。
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// 归一化快捷键串：单字母 → KeyX、单数字 → DigitX。
/// global_hotkey 解析要求 keyboard_types Code 全名（如 "KeyB"/"Digit1"），
/// 修饰键与 F1~F12 等保持原样（解析端不区分大小写）。
fn normalize(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|t| {
            let t = t.trim();
            let mut chars = t.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if c.is_ascii_alphabetic() {
                    return format!("Key{}", c.to_ascii_uppercase());
                }
                if c.is_ascii_digit() {
                    return format!("Digit{c}");
                }
            }
            t.to_string()
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// 应用快捷键设置：空串注销全部，否则注销旧的并注册新的。
pub fn apply(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    if hotkey.is_empty() {
        return unregister_all(app);
    }
    let sc: Shortcut = normalize(hotkey)
        .parse()
        .map_err(|_| format!("无法识别的快捷键：{hotkey}"))?;
    let gs = app.global_shortcut();
    gs.unregister_all().map_err(|e| e.to_string())?;
    gs.register(sc)
        .map_err(|e| format!("快捷键注册失败（可能已被其他程序占用）：{e}"))
}

fn unregister_all(app: &AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())
}

/// 快捷键按下：主窗「可见且拥有焦点」→ 隐藏到托盘；否则弹出并抢前台。
/// 不用 is_visible 单独判断：Windows 下首次 show 可能只到后台（没抢到前台），
/// 此时按 is_visible=true 会误判成「隐藏」，导致看起来按了没反应。
pub fn toggle_main(app: &AppHandle) {
    // 必须用 get_window：get_webview_window 在窗口含 pane 子 webview 时恒为 None
    if let Some(w) = app.get_window("main") {
        let visible = w.is_visible().unwrap_or(false);
        let focused = w.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = w.hide();
        } else {
            crate::tray::show_panel(app);
        }
    }
}
