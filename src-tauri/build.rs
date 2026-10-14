fn main() {
    // tauri 2.x ACL 规则：remote 来源的 invoke 一律要过 ACL（webview/mod.rs:
    // 「remote content can never reach custom commands unless an explicit remote
    // capability has been configured」），app 自定义命令只有在此用 AppManifest
    // 注册、生成 allow-$command 权限并被 capabilities 引用后，才进 allowed_commands。
    // 注意：一旦注册 AppManifest，本地 invoke 也走 ACL——所以清单必须覆盖全部命令。
    // 【维护约定】lib.rs invoke_handler 新增命令时，此数组与 capabilities/default.json
    // 的 permissions（allow-<kebab-case>）两处都要同步追加，否则该命令全上下文被拒。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
                "account_delete",
                "account_list",
                "account_save",
                "capture_session",
                "check_captcha_required",
                "check_now",
                "close_webview_self",
                "debug_dump",
                "debug_webview_rect",
                "fire_snooze",
                "get_ai_agents",
                "get_app_version",
                "get_captcha",
                "get_credential_hint",
                "get_docs",
                "get_matters",
                "get_message_history",
                "get_messages",
                "get_ops_apps",
                "get_quick_entries",
                "get_roles",
                "get_settings",
                "get_spaces",
                "get_todos",
                "get_user_info",
                "is_logged_in",
                "layout_full",
                "layout_mini",
                "login_local",
                "login_qr",
                "login_webview",
                "logout",
                "mark_todo_done",
                "open_conversation",
                "open_external",
                "poll_qr",
                "quit_app",
                "reflow_main_webview",
                "report_requests",
                "save_settings",
                "set_autostart",
                "set_hotkey",
                "set_mini_card_visible",
                "switch_role",
                "toggle_mini_bar",
                "trace_invoke",
                "try_auto_login",
                "start",
                "sync_tabs_on_resize",
                "tab_activate",
                "tab_bounds",
                "tab_close",
                "tab_close_all",
                "tab_close_others",
                "tab_close_self",
                "tab_hide_all",
                "tab_list_cmd",
                "tab_navigate",
                "tab_open",
                "tab_reload",
                "tab_report_title",
                "tab_restore_all",
                "tab_restore_session",
        ])),
    )
    .expect("failed to run tauri-build");

    // 关键：tauri_build::build() 输出了自己的 cargo:rerun-if-changed（conf/icons 等），
    // 一旦存在任何 rerun-if 指令，cargo 便不再「包内有变化就重跑 build script」——
    // 必须显式声明要跟踪的路径，否则 src/ 改动不会触发本脚本，BUILD_ID 永远不动。
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    // 前端目录也在跟踪范围（cargo 对目录递归扫描 mtime）：
    // 前端改动同样计入 build-id，避免「只改前端版本号永远不动」。
    // dev 模式下 vite 热更新不触发 cargo，计数在下次 tauri dev 启动/打包时 +1。
    println!("cargo:rerun-if-changed=../src");
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../vite.config.ts");

    // build-id：每次编译（源码有变化触发 build script 重跑）自增 1，
    // 通过 cargo:rustc-env 注入，代码里用 env!("BUILD_ID") 读取。
    // 计数文件放在 src-tauri/.build-id（随源码目录走，不入产物）。
    let counter = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".build-id");
    let n: u64 = std::fs::read_to_string(&counter)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
        + 1;
    std::fs::write(&counter, n.to_string()).ok();
    println!("cargo:rustc-env=BUILD_ID={n}");
}
