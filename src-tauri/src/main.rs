// 预编译二进制入口；逻辑在 lib.rs 的 run()。
// release 构建隐藏 Windows 控制台黑窗；debug（tauri dev）保留控制台便于看日志。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    aif_desktop_client_lib::run();
}
