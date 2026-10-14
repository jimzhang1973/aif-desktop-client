fn main() {
    // tauri 2.x ACL 规则：remote 来源的 invoke 一律要过 ACL（webview/mod.rs:
    // 「remote content can never reach custom commands unless an explicit remote
    // capability has been configured」），而 app 自定义命令只有在 build 时用
    // AppManifest 注册、生成 allow-$command 权限、并被 capabilities 引用后，
    // 才会进入 allowed_commands。因此远程 B/S 页面要调的命令必须在此登记，
    // 并在 capabilities/default.json 的 permissions 里加 "allow-$command"。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "close_webview_self", // BS_WINDOW_SHIM：window.close → 宿主关闭/隐藏
            "tab_close_self",     // close_capture_script：window.close → 关标签/弹窗
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
