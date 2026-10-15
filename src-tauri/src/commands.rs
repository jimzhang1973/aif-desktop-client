use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 诊断产物落盘（debug_session.txt / roles_debug.json / quick_entry_debug.json 等）。
/// 仅 debug 构建（tauri dev）生效；release 打包完全关闭——不写会话、接口响应等调试文件。
pub(crate) fn debug_write(dir: &Path, name: &str, data: &str) {
    #[cfg(debug_assertions)]
    {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join(name), data);
    }
    #[cfg(not(debug_assertions))]
    let _ = (dir, name, data);
}


use base64::Engine;
use serde::Serialize;
use tauri::webview::{Cookie, DownloadEvent, NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Position, Rect, Runtime, Size, State, Url, Webview, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_notification::NotificationExt;

use crate::auth;
use crate::db;
use crate::poller;
use crate::state::AppState;

/// 用系统默认浏览器打开 URL（Windows: rundll32 FileProtocolHandler；macOS: open；Linux: xdg-open）。
/// B/S 页面 window.open / target=_blank 的链接由 webview on_new_window 拦截后转交这里。
fn open_in_system_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// URL path 段的最小百分号解码（下载文件名可读化）
fn percent_decode_minimal(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Some(hex) = std::str::from_utf8(&bytes[i + 1..i + 3]).ok() {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// B/S 新开页面窗口序号（label 唯一化）
static BS_PAGE_SEQ: AtomicUsize = AtomicUsize::new(1);

/// 下载处理：所有 B/S 受控窗口共用（落「下载」目录 + 完成后系统通知）
pub(crate) fn bs_download_handler<R: Runtime>(webview: Webview<R>, event: DownloadEvent) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            let dir = webview
                .app_handle()
                .path()
                .download_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            // 文件名取 URL path 末段（百分号解码），空则用时间戳兜底
            let raw = url.path().rsplit('/').next().unwrap_or("");
            let name = percent_decode_minimal(raw.split('?').next().unwrap_or(""));
            let name = if name.trim().is_empty() || name == "/" {
                format!(
                    "download-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                )
            } else {
                name
            };
            let mut p = dir.join(&name);
            // 避免覆盖已存在文件：name (1).ext、name (2).ext …
            let (stem, ext) = {
                let path = Path::new(&name);
                (
                    path.file_stem().and_then(|s| s.to_str()).unwrap_or("download").to_string(),
                    path.extension().and_then(|s| s.to_str()).map(|s| format!(".{s}")).unwrap_or_default(),
                )
            };
            let mut n = 1;
            while p.exists() {
                p = dir.join(format!("{stem} ({n}){ext}"));
                n += 1;
            }
            *destination = p;
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            if success {
                let body = match &path {
                    Some(p) => format!("已保存到：{}", p.display()),
                    None => url.as_str().to_string(),
                };
                let _ = webview
                    .app_handle()
                    .notification()
                    .builder()
                    .title("下载完成")
                    .body(body)
                    .show();
            }
            true
        }
        // non-exhaustive 枚举兜底（未来新增变体时默认放行）
        _ => true,
    }
}

/// B/S 页面在独立 webview 中没有主框架，`top.openNewTab(url, title, key)` 等
/// 框架全局函数不存在 → 点击链接 JS 直接报错、连 window.open 都不会调用
/// （表现为「点了没反应」，且 on_new_window 收不到请求）。
/// 注入兜底 shim：补齐常用打开函数并统一落到 window.open，再由新窗口策略接管。
pub(crate) const BS_WINDOW_SHIM: &str = r#"(function () {
  if (typeof window.openNewTab !== "function") {
    window.openNewTab = function (url, title, key) { return window.open(url, key || "_blank"); };
  }
  if (typeof window.openWin !== "function") {
    window.openWin = function (url, t, w, h) { return window.open(url, "_blank", "width=" + (w || 960) + ",height=" + (h || 680)); };
  }
  // window.close() 支持：WebView2 对非脚本打开的窗口不响应脚本 close，
  // 这里统一转交宿主（close_webview_self：面板隐藏 / 弹窗关闭 / 主窗隐藏）。
  // 关键：无 IPC 通道的 realm（跨域 iframe 等）绝不能走原生 close——
  // wry 对 window.close 的原生处理是 DestroyWindow(容器 HWND)（见 wry 0.57
  // webview2/mod.rs attach_handlers），完全绕过 tao/tauri 的 CloseRequested，
  // prevent_close 拦不住，会把内嵌面板/主窗连带破坏。故 fallback 一律静默忽略。
  if (!window.__aifCloseHooked) {
    window.__aifCloseHooked = true;
    var hostClose = function () {
      try {
        var t = window.__TAURI_INTERNALS__;
        if (t && typeof t.invoke === "function") {
          t.invoke("close_webview_self").catch(function (err) {
            console.error("[aif] close_webview_self 失败:", err);
          });
          return;
        }
      } catch (e) {}
    };
    try {
      // defineProperty 固化：部分页面会重写 window.close，普通赋值会被冲掉
      Object.defineProperty(window, "close", { value: hostClose, writable: false, configurable: false });
    } catch (e) {
      window.close = hostClose;
    }
  }
})();"#;

/// B/S 混合新开窗口策略（on_new_window 处理器）：
/// - 域内链接（与 bs_host 同主机）→ 自建受控 Tauri 窗口（window_features 官方 helper 保证
///   Windows 同 environment / Linux related_view / macOS configuration，会话 cookie 共享），
///   返回 `Create`；新窗口递归挂同一策略与下载处理；
/// - 外部域名 → 交给系统默认浏览器，返回 `Deny`；自建窗口失败也回退系统浏览器。
pub(crate) fn bs_new_window_strategy<R: Runtime>(
    app: &AppHandle<R>,
    url: Url,
    features: NewWindowFeatures,
    bs_host: &str,
) -> NewWindowResponse<R> {
    // B/S 页面常见 window.open('about:blank') / blob: 等无主机名弹窗：
    // 转系统浏览器会静默失败（rundll32 不认识 about:blank），表现为「点了没反应」，
    // 必须自建受控窗口把句柄交还打开方，由页面继续写入/导航内容。
    let blank = url.host_str().is_none() || url.as_str() == "about:blank";
    let same_host = url
        .host_str()
        .map(|h| h.eq_ignore_ascii_case(bs_host))
        .unwrap_or(false);
    log::info!("B/S 弹窗请求: {url}（same_host={same_host}, blank={blank}）");
    if !same_host && !blank {
        open_in_system_browser(url.as_str());
        return NewWindowResponse::Deny;
    }
    let label = format!("bs-page-{}", BS_PAGE_SEQ.fetch_add(1, Ordering::Relaxed));
    // 弹窗标题随产品品牌（运维/一表通）
    let title = app
        .try_state::<Arc<AppState>>()
        .map(|s| s.settings.lock().unwrap().product_title().to_string())
        .unwrap_or_else(|| "业务小助手".to_string());
    let app2 = app.clone();
    let host2 = bs_host.to_string();
    match WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url.clone()))
        .title(&title)
        // 显式白底：WebView2 默认底色跟随系统主题（深色模式首帧黑闪），B/S 页面为浅色
        .background_color(tauri::webview::Color(255, 255, 255, 255))
        // 点击链接打开的 webview 窗口默认最大化
        .maximized(true)
        // 补齐 B/S 框架函数（top.openNewTab 等），弹窗内页面链接才打得开；
        // 追加 window.close 捕获：IPC 可用走 tab_close_self，否则标题哨兵兜底
        .initialization_script(format!(
            "{BS_WINDOW_SHIM}\n{}",
            crate::tabs::close_capture_script(&label)
        ))
        // 位置尺寸沿用页面 window.open 特征 + 跨平台环境/会话一致性（官方 helper）
        .window_features(features)
        // 首帧防黑闪：真实 URL 弹窗先隐藏，页面加载完成（Finished 且非 about:）再显示；
        // about:blank 弹窗无加载事件可等，创建后立即显示（由打开方接管句柄写入内容）
        .visible(!blank)
        // window.close 兜底：页面自关（选人弹窗等常见）→ 标题哨兵捕获后关本窗口
        .on_document_title_changed(|wv, title| {
            if title == crate::tabs::CLOSE_SENTINEL {
                let _ = wv.close();
            }
        })
        .on_new_window(move |u, f| bs_new_window_strategy(&app2, u, f, &host2))
        .on_download(bs_download_handler)
        .on_page_load(|wv, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && !payload.url().as_str().starts_with("about:")
            {
                let _ = wv.show();
            }
        })
        .build()
    {
        Ok(w) => {
            if blank {
                let _ = w.show();
            } else {
                // 兜底：导航迟迟不提交（网络异常等）时 2s 后强制显示，避免弹窗永久空白
                let fb_app = app.clone();
                let fb_label = label.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                    if let Some(x) = fb_app.get_webview_window(&fb_label) {
                        let _ = x.show();
                    }
                });
            }
            NewWindowResponse::Create { window: w }
        }
        Err(e) => {
            log::warn!("创建 B/S 新窗口失败（{e}），转交系统浏览器: {url}");
            open_in_system_browser(url.as_str());
            NewWindowResponse::Deny
        }
    }
}

#[tauri::command]
pub fn capture_session(app: AppHandle, cookie: String) {
    // hook 每 3s 持续上报：值没变就跳过，避免高频写 keyring / 重复发事件
    if auth::load_session().as_deref() == Some(cookie.as_str()) {
        return;
    }
    let _ = auth::save_session(&cookie);
    let _ = app.emit("logged-in", ());
}

/// 登录窗探针上报的请求清单：落盘 app_data_dir/captured_requests.json，
/// 供后续确定消息/待办真实接口路径。
#[tauri::command]
pub fn report_requests(app: AppHandle, json: String) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("captured_requests.json");
        // 内容没变就不写（hook 每 3s 上报一次）
        if std::fs::read(&path).map(|old| old == json.as_bytes()).unwrap_or(false) {
            return;
        }
        let _ = std::fs::write(&path, json);
        log::info!("已捕获请求清单: {}", path.display());
    }
    let _ = app.emit("requests-captured", ());
}

/// 完全退出程序（含托盘、后台轮询）：关闭整个进程，与托盘「退出」菜单同一逻辑。
/// 设置已在保存按钮/各开关处即时持久化，退出无需额外落盘。
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    log::info!("用户在「我的」页触发退出程序");
    app.exit(0);
}

#[tauri::command]
pub fn logout(state: State<'_, Arc<AppState>>) {
    let _ = auth::clear_session();
    // 退出登录 = 强制回到登录页重新输入账号密码：
    // 同时清除记住的凭据并关闭自动登录，否则「退出 → 自动登录 → 又进面板」永远出不来
    auth::clear_credentials();
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.auto_login = false;
        s.clone()
    };
    let conn = state.db.lock().unwrap();
    let _ = db::save_settings(&conn, &snapshot);
}

#[tauri::command]
pub fn is_logged_in() -> bool {
    auth::load_session().map(|s| !s.is_empty()).unwrap_or(false)
}

#[tauri::command]
pub fn get_todos(state: State<'_, Arc<AppState>>) -> Result<Vec<db::TodoRow>, String> {
    let conn = state.db.lock().unwrap();
    db::list_todos(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mark_todo_done(
    state: State<'_, Arc<AppState>>,
    id: String,
    done: bool,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    db::set_done(&conn, &id, done).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> crate::state::Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    mut settings: crate::state::Settings,
) -> Result<(), String> {
    // 源头规范化：base_url 去尾斜杠（无论前端录入/入口切换传入时带不带 /，落库统一无尾斜杠）
    settings.base_url = settings.base_url.trim().trim_end_matches('/').to_string();
    // 心跳间隔：前端以秒录入，内部存秒。下限 30 秒、上限 60 分钟（即 B/S 原生 keepAlive 频率量级，过短无意义）
    settings.poll_interval_secs = settings.poll_interval_secs.clamp(30, 3600);
    {
        let mut s = state.settings.lock().unwrap();
        *s = settings.clone();
    }
    let conn = state.db.lock().unwrap();
    db::save_settings(&conn, &settings).map_err(|e| e.to_string())?;
    // 关闭「重启后恢复标签页」时清掉已持久化的标签会话，避免残留下次被恢复
    if !settings.tab_restore {
        let _ = db::kv_delete(&conn, "tab_session");
    }
    drop(conn);
    // 产品品牌切换后同步主窗口标题与托盘提示（运维小助手 / 一表通小助手）
    let title = settings.product_title();
    if let Some(w) = app.get_window("main") {
        let _ = w.set_title(title);
    }
    Ok(())
}

#[tauri::command]
pub fn check_now(app: AppHandle, state: State<'_, Arc<AppState>>) {
    // State<'_, T> 不能直接 move 进 async 块（借用不过 'static），
    // 先取出内部 Arc 的克隆再 move。
    let state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        poller::poll_once(&state, &app).await;
    });
}

/// 打开 B/S 登录页到 webview，人工输入账号/密码/验证码（或扫码）。
/// 登录成功跳转到落地页后，自动捕获会话 Cookie 并隐藏登录窗。
#[tauri::command]
pub async fn login_webview(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    // 必须是 async command：sync command 跑在主线程，build() 内部向主线程
    // 派发任务并阻塞等待 → 自我死锁（窗口白屏、build 永不返回）。
    log::info!("[login] command 触发");
    let (base, post, root) = {
        let s = state.settings.lock().unwrap();
        (
            s.base_url.trim_end_matches('/').to_string(),
            s.resolve_path(&s.post_login_path.clone()),
            s.app_root().to_string(),
        )
    };
    // 注意：/{root}/ 首页才是登录页（含 loginForm 表单 + 验证码图）。
    // /{root}/login/Login.htm 是表单 JS 提交目标的 POST 处理器，GET 它只会报错。
    let login_url = format!("{}/{}/", base, root);

    // 注入到登录窗的探针脚本：hook fetch/XHR 记录所有请求，每 8s 定期上报清单。
    // 注意：JSESSIONID 是 HttpOnly，document.cookie 拿不到它——cookie 一律由
    // Rust 侧通过 webview 的 cookies_for_url 捕获（见下方监控线程）。
    let hook_js = r#"
(function(){
  if (window.__aifHooked) return; window.__aifHooked = true;
  window.__aifReqs = [];
  function rec(m,u){ try{ if(String(u).indexOf('captcha')>-1) return;
    window.__aifReqs.push({m:String(m),u:String(u),t:Date.now()});
    if(window.__aifReqs.length>800) window.__aifReqs.shift(); }catch(e){} }
  try{
    var of = window.fetch;
    if (of) { window.fetch = function(input, init){ try{
      var u=(typeof input==='string')?input:((input&&input.url)||'');
      rec((init&&init.method)||'GET', u); }catch(e){} return of.apply(this, arguments); }; }
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m,u){ try{ rec(m,u); }catch(e){}
      return oo.apply(this, arguments); };
  }catch(e){}
  setInterval(function(){
    try{
      var tauri = window.__TAURI_INTERNALS__;
      if (!tauri || !window.__aifReqs.length) return;
      tauri.invoke('report_requests', {json: JSON.stringify(window.__aifReqs)});
    }catch(e){}
  }, 8000);
})();
"#;

    if let Some(w) = app.get_webview_window("login") {
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }

    let w = match WebviewWindowBuilder::new(
        &app,
        "login",
        WebviewUrl::External(Url::parse(&login_url).unwrap()),
    )
    .title(format!("登录{}", {
        let s = state.settings.lock().unwrap();
        s.product_title()
    }))
    // 显式白底：消除深色模式下 WebView2 首帧黑闪
    .background_color(tauri::webview::Color(255, 255, 255, 255))
    // 首帧防黑闪：先隐藏创建，页面开始加载再显示（见 on_page_load Started 分支）
    .visible(false)
    .inner_size(480.0, 680.0)
    .initialization_script(BS_WINDOW_SHIM)
    .on_navigation(|url| {
        log::info!("[login] 导航: {url}");
        true
    })
    .on_page_load(move |wv, payload| match payload.event() {
        tauri::webview::PageLoadEvent::Started => {
            log::info!("[login] 开始加载: {}", payload.url());
            // 页面开始加载即显示（创建时隐藏，覆盖 WebView2 首帧合成窗口期防黑闪）
            let _ = wv.show();
        }
        tauri::webview::PageLoadEvent::Finished => {
            log::info!("[login] 加载完成: {}", payload.url());
            // 页面加载完成后注入探针（hook fetch/XHR，幂等），比 initialization_script 干扰小
            let _ = wv.eval(hook_js.to_string());
        }
    })
    .build()
    {
        Ok(w) => {
            log::info!("[login] 窗口创建完成，开始监控 url");
            // 兜底：导航迟迟不提交时 2s 后强制显示，避免登录窗永久空白
            let fb_app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
                if let Some(x) = fb_app.get_webview_window("login") {
                    let _ = x.show();
                }
            });
            // 清理 webview 持久化数据，保证每次打开登录窗都是干净会话
            if let Err(e) = w.clear_all_browsing_data() {
                log::warn!("[login] 清理浏览数据失败: {e}");
            }
            w
        }
        Err(e) => {
            log::error!("[login] 窗口创建失败: {e}");
            return Err(format!("创建登录窗失败: {e}"));
        }
    };

    // 用独立线程而非 tokio：隔离 async runtime 因素，且 url() 挂起时能看清卡点。
    // 登录成功判定（双路）：
    //   a) url 落到 post_login_path（整页跳转型）
    //   b) webview cookie 出现 JSESSIONID（AJAX 登录型；HttpOnly 也能拿到）
    let probe_url = login_url.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mut n = 0u32;
        let mut errs = 0u32;
        let mut last_session = String::new();
        for _ in 0..1800 {
            // b) cookie 检测（覆盖 AJAX/SPA 登录，HttpOnly 也拿得到）
            if let Ok(probe) = Url::parse(&probe_url) {
                match w.cookies_for_url(probe) {
                    Ok(cookies) => {
                        let has_session = cookies.iter().any(|c| c.name() == "JSESSIONID");
                        if has_session {
                            let joined = cookies
                                .iter()
                                .map(|c| format!("{}={}", c.name(), c.value()))
                                .collect::<Vec<_>>()
                                .join("; ");
                            if joined != last_session {
                                last_session = joined.clone();
                                log::info!("[login] 捕获到会话 cookie（{} 条）并保存；窗口保持打开以便浏览采集接口", cookies.len());
                                let _ = auth::save_session(&joined);
                                // 调试：会话落盘一份，供外部工具带会话探测 B/S 接口（release 不写）
                                if let Ok(dir) = app2.path().app_data_dir() {
                                    debug_write(&dir, "debug_session.txt", &joined);
                                }
                                let _ = app2.emit("logged-in", ());
                                // 不隐藏窗口：用户需继续在登录窗里浏览消息/待办页面，探针才能记录接口
                            }
                        }
                    }
                    Err(e) => log::debug!("[login] cookies_for_url 暂不可用: {e}"),
                }
            }
            // a) url 落地检测（整页跳转型登录）
            match w.url() {
                Ok(u) => {
                    errs = 0;
                    if n < 15 {
                        log::info!("[login] 当前 url={u}");
                        n += 1;
                    }
                    if u.path().contains(&post) {
                        let _ = auth::load_session(); // 确保 keyring 可用（忽略结果）
                        let _ = w.hide();
                        break;
                    }
                }
                Err(_) => {
                    // 窗口被用户关闭后 url() 会持续报错，连错多次就停止监控
                    errs += 1;
                    if errs > 10 {
                        log::info!("[login] 窗口已关闭，停止监控");
                        break;
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(800));
        }
    });
    Ok(())
}

/// 打开「对话窗」：新建/聚焦一个 webview，加载 B/S 目标 URL。
/// 会话 Cookie 通过 WebView2 CookieManager（set_cookie）注入——HttpOnly 也能设置，
/// 页面即处于登录态（webview 登录路径下 WebView2 数据目录本身已含会话，同样有效）。
#[tauri::command]
pub async fn open_conversation(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    url: String,
) -> Result<(), String> {
    // 同 login_webview：async command 避免主线程死锁
    let target = Url::parse(&url).map_err(|e| format!("URL 无效: {e}"))?;
    let host = target
        .host_str()
        .unwrap_or("51yunwei.com.cn")
        .to_string();

    if let Some(w) = app.get_webview_window("conversation") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.navigate(target);
        return Ok(());
    }

    let w = WebviewWindowBuilder::new(
        &app,
        "conversation",
        // 初始 about:blank：先注入会话再 navigate(target)，避免首导航无会话被重定向到登录页
        WebviewUrl::External(Url::parse("about:blank").unwrap()),
    )
    .title({
        let s = state.settings.lock().unwrap();
        s.product_title()
    })
    // 显式白底：WebView2 默认底色跟随系统主题（深色模式首帧黑屏），B/S 页面为浅色，
    // 白底让首帧与页面底色一致，消除黑闪
    .background_color(tauri::webview::Color(255, 255, 255, 255))
    .inner_size(1100.0, 800.0)
    // 点击链接打开的 webview 窗口默认最大化
    .maximized(true)
    // 首帧防黑闪：先隐藏创建，页面开始加载（Started 且非 about:）再显示（见 on_page_load）
    .visible(false)
    // 补齐 B/S 框架函数（top.openNewTab / openWin），页面内链接才能打开新窗口
    .initialization_script(BS_WINDOW_SHIM)
    // B/S 页面 window.open / target=_blank：混合策略——
    // B/S 域内链接自建受控窗口（同环境会话/最大化/下载接管）；外部域名转系统浏览器
    .on_new_window({
        let app2 = app.clone();
        let bs_host = host.clone();
        move |url, features| bs_new_window_strategy(&app2, url, features, &bs_host)
    })
    // 页面下载（导出 / 附件下载）：落到系统「下载」目录，完成后发系统通知
    .on_download(bs_download_handler)
    .on_page_load(|wv, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Started
            && !payload.url().as_str().starts_with("about:")
        {
            let _ = wv.show();
        }
    })
    .build()
    .map_err(|e| format!("创建对话窗失败: {e}"))?;

    // 注入已保存会话（轮询确认落库后再 navigate，确保请求携带会话）
    inject_session_cookies(w.as_ref(), &host);
    let _ = w.navigate(target);
    // 兜底：导航迟迟不提交（网络异常等）时 2s 后强制显示，避免窗口永久空白
    let fb_app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        if let Some(x) = fb_app.get_webview_window("conversation") {
            let _ = x.show();
        }
    });
    Ok(())
}

/// 二维码登录：拉取登录二维码图片（base64）。
/// 注意：qrid 提取方式取决于 /AIF/nonlogin/qrlogin/code.htm 的真实返回格式，需实测后微调。
#[tauri::command]
pub async fn login_qr(state: State<'_, Arc<AppState>>) -> Result<QrPayload, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let url = format!("{}/{}/nonlogin/qrlogin/code.htm", base, root);
    let bytes = state
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    Ok(QrPayload {
        image_base64: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        qrid: String::new(),
    })
}

/// 轮询二维码登录结果。连接接口返回会话 Cookie 即视为登录成功。
#[tauri::command]
pub async fn poll_qr(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    qrid: String,
) -> Result<bool, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let url = format!(
        "{}/{}/nonlogin/qrlogin/connect.htm?qrid={}",
        base, root, qrid
    );
    let resp = state
        .client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let cookies: Vec<String> = resp
        .cookies()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect();
    if resp.status().is_success() && !cookies.is_empty() {
        let _ = auth::save_session(&cookies.join("; "));
        let _ = app.emit("logged-in", ());
        Ok(true)
    } else {
        Ok(false)
    }
}

#[derive(Serialize)]
pub struct QrPayload {
    pub image_base64: String,
    pub qrid: String,
}

// ==================== 本地登录（替代 web 登录页） ====================
// 协议（curl 实证）：
//   1) POST /AIF/nonlogin/login/captcha/isvalid.htm  body: uname → "true"/"false"
//      true = 该账号已触发验证码校验（输错 3 次后）
//   2) GET  /AIF/nonlogin/login/captcha.htm?code=<时间戳> → 验证码图片（与会话绑定）
//   3) POST /AIF/login/Login.htm  body: uname/pwd/verification/opt/vcode
//      响应空文本 = 成功；否则文本即错误消息（「账号或密码错误」「验证码输入错误！」等）
// 会话：手动管理 Cookie（auth_client 关闭 cookie store），验证码与登录须同一 JSESSIONID。

fn extract_session_cookie(resp: &reqwest::Response) -> String {
    let mut parts: Vec<String> = Vec::new();
    for v in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = v.to_str() {
            let kv = s.split(';').next().unwrap_or("").trim();
            if !kv.is_empty() {
                parts.push(kv.to_string());
            }
        }
    }
    parts.join("; ")
}

/// 确保登录流程会话存在：无会话时 GET {base}/AIF/ 捕获 JSESSIONID
async fn ensure_session(state: &Arc<AppState>) -> Result<String, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let existing = state.session.lock().unwrap().clone();
    if existing.contains("JSESSIONID") {
        return Ok(existing);
    }
    let resp = state
        .auth_client
        .get(format!("{}/{}/", base, root))
        .send()
        .await
        .map_err(|e| format!("建立会话失败: {e}"))?;
    let s = extract_session_cookie(&resp);
    if s.contains("JSESSIONID") {
        *state.session.lock().unwrap() = s.clone();
    }
    Ok(s)
}

fn millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct CaptchaPayload {
    pub image_base64: String,
}

/// 获取验证码图片（base64 data URL）。验证码与当前登录会话绑定。
#[tauri::command]
pub async fn get_captcha(state: State<'_, Arc<AppState>>) -> Result<CaptchaPayload, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let cookie = ensure_session(&state).await?;
    let url = format!(
        "{}/{}/nonlogin/login/captcha.htm?code={}",
        base,
        root,
        millis()
    );
    let bytes = state
        .auth_client
        .get(&url)
        .header("Cookie", &cookie)
        .send()
        .await
        .map_err(|e| format!("拉取验证码失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("拉取验证码失败: {e}"))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    Ok(CaptchaPayload {
        image_base64: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
    })
}

/// 判断该账号当前是否需要图形验证码（POST isvalid.htm，与 web 登录页逻辑一致）
#[tauri::command]
pub async fn check_captcha_required(
    state: State<'_, Arc<AppState>>,
    uname: String,
) -> Result<bool, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let cookie = ensure_session(&state).await?;
    let resp = state
        .auth_client
        .post(format!(
            "{}/{}/nonlogin/login/captcha/isvalid.htm",
            base, root
        ))
        .header("Cookie", &cookie)
        .form(&[("uname", uname.as_str())])
        .send()
        .await
        .map_err(|e| format!("校验验证码状态失败: {e}"))?;
    let text = resp.text().await.map_err(|e| e.to_string())?;
    Ok(text.trim().eq_ignore_ascii_case("true"))
}

/// 本地登录：提交 B/S 认证接口；成功后会话存钥匙串，凭据按用户选择保存。
#[tauri::command]
pub async fn login_local(
    state: State<'_, Arc<AppState>>,
    app: AppHandle,
    uname: String,
    pwd: String,
    verification: String,
    remember: bool,
) -> Result<(), String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let cookie = ensure_session(&state).await?;
    let resp = state
        .auth_client
        .post(format!("{}/{}/login/Login.htm", base, root))
        .header("Cookie", &cookie)
        .form(&[
            ("uname", uname.as_str()),
            ("pwd", pwd.as_str()),
            ("verification", verification.as_str()),
            ("opt", ""),
            ("vcode", ""),
        ])
        .send()
        .await
        .map_err(|e| format!("登录请求失败: {e}"))?;
    // 服务端可能在登录成功后刷新会话
    let newc = extract_session_cookie(&resp);
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        let session = if newc.contains("JSESSIONID") { newc } else { cookie };
        *state.session.lock().unwrap() = session.clone();
        let _ = auth::save_session(&session);
        // 调试双保险：本地登录的会话同样落盘，供外部 curl 逆向 B/S 接口（release 不写）
        if let Ok(dir) = app.path().app_data_dir() {
            debug_write(&dir, "debug_session.txt", &session);
        }
        if remember {
            let _ = auth::save_credentials(&uname, &pwd);
        } else {
            auth::clear_credentials();
        }
        {
            let mut s = state.settings.lock().unwrap();
            s.remember_password = remember;
            let snapshot = s.clone();
            drop(s);
            let conn = state.db.lock().unwrap();
            let _ = db::save_settings(&conn, &snapshot);
        }
        let _ = app.emit("logged-in", ());
        Ok(())
    } else {
        // 非空响应即错误消息（「账号或密码错误」/「验证码输入错误！」…）
        Err(text.trim().to_string())
    }
}

/// 登录窗预填：已保存的用户名与是否有密码。
/// 优先取保险库中「当前网址+产品」的常用入口，回退系统凭据管理器。
#[derive(Serialize)]
pub struct CredentialHint {
    pub username: String,
    pub has_password: bool,
}

#[tauri::command]
pub fn get_credential_hint(state: State<'_, Arc<AppState>>) -> CredentialHint {
    let (base, ops) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.ops_product)
    };
    if let Some((uname, _)) = vault_find_creds(&state, &base, ops) {
        return CredentialHint { username: uname, has_password: true };
    }
    let username = auth::load_username().unwrap_or_default();
    let has_password = auth::load_credentials().is_some();
    CredentialHint { username, has_password }
}

// ==================== 用户信息 / 消息列表 / 自启 ====================

#[derive(Serialize)]
pub struct UserInfo {
    pub user_name: String,
    pub role_name: String,
    pub unit_name: String,
    pub account: String,
}

/// 从 personalInfoManage.htm（服务端渲染内嵌 JSON）提取姓名/角色/单位/账号
#[tauri::command]
pub async fn get_user_info(state: State<'_, Arc<AppState>>) -> Result<UserInfo, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;
    let resp = state
        .client
        .get(format!(
            "{}/{}/user/personalInfoManage/personalInfoManage.htm",
            base, root
        ))
        .header("Cookie", &session)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    let marker = "mini.decode(";
    let start = html.find(marker).ok_or("页面结构变化，无法解析用户信息")? + marker.len();
    let end = html[start..].find(");").ok_or("页面结构变化，无法解析用户信息")? + start;
    let v: serde_json::Value =
        serde_json::from_str(&html[start..end]).map_err(|e| format!("解析用户信息失败: {e}"))?;
    let g = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    let mut role_name = g("roleName");
    // 修复：personalInfo 返回的 roleName 可能是多角色拼接（如 "平台管理员,教职工"）。
    // 与 B/S 一致只显示当前生效的一个：首页注入的 currentRoleKey 在角色清单中定位；
    // 定位失败（页面抓不到/清单拉不到）才退化为取拼接串第一段。
    if role_name.contains(|c: char| ",，、;；/".contains(c)) {
        let base_t = base.trim_end_matches('/');
        let mut resolved = false;
        if let Some(key) = fetch_current_role_key(&state, base_t, &root, &session).await {
            if let Ok(nodes) = fetch_role_nodes(&state, base_t, &root, &session, None).await {
                if let Some((_, name, _)) = nodes.iter().find(|(_, _, k)| k == &key) {
                    role_name = name.clone();
                    resolved = true;
                }
            }
        }
        if !resolved {
            role_name = role_name
                .split(|c: char| ",，、;；/".contains(c))
                .next()
                .unwrap_or("")
                .trim()
                .to_string();
        }
    }
    Ok(UserInfo {
        user_name: g("userName"),
        role_name,
        unit_name: g("unitName"),
        account: g("humanCode"),
    })
}

// ==================== 角色清单 / 角色切换 ====================

#[derive(Serialize)]
pub struct RoleOption {
    pub id: String,
    pub name: String,
    /// 角色键（SystemManager/Teacher…），用于与首页注入的 currentRoleKey 对位
    #[serde(rename = "role_key")]
    pub role_key: String,
}

/// 真实角色清单协议（两步）：
///   1. GET login/switchRolesTree.htm —— 角色树壳页，内嵌 `var userId = "..."`
///   2. GET role/switchRoles.htm?userId=<uid> —— JSON 数组，字段 id/roleName/roleKey
/// debug_dir 非空时把中间产物落盘 roles_debug.html / roles_debug.json 供校准。
/// 返回 (id, roleName, roleKey) 列表。
async fn fetch_role_nodes(
    state: &Arc<AppState>,
    base: &str,
    root: &str,
    session: &str,
    debug_dir: Option<&std::path::Path>,
) -> Result<Vec<(String, String, String)>, String> {
    // 1) 角色树壳页 → 提取 userId
    let resp = state
        .client
        .get(format!("{}/{}/login/switchRolesTree.htm", base, root))
        .header("Cookie", session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let html = resp.text().await.map_err(|e| e.to_string())?;
    if let Some(dir) = debug_dir {
        let _ = std::fs::write(dir.join("roles_debug.html"), &html);
    }
    if !status.is_success() {
        return Err(format!(
            "获取角色页失败（HTTP {}，会话可能已过期，请重新登录）",
            status.as_u16()
        ));
    }
    let user_id = regex::Regex::new(r#"var\s+userId\s*=\s*"([^"]+)""#)
        .unwrap()
        .captures(&html)
        .map(|c| c[1].to_string())
        .ok_or("角色页结构变化：未找到内嵌 userId（原始页面已存 roles_debug.html）")?;

    // 2) 角色清单 JSON
    let resp2 = state
        .client
        .get(format!("{}/{}/role/switchRoles.htm?userId={}", base, root, user_id))
        .header("Cookie", session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status2 = resp2.status();
    let body = resp2.text().await.map_err(|e| e.to_string())?;
    if let Some(dir) = debug_dir {
        debug_write(dir, "roles_debug.json", &body);
    }
    if !status2.is_success() {
        return Err(format!("获取角色清单失败（HTTP {}）", status2.as_u16()));
    }
    let v: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| format!("角色清单不是有效 JSON: {e}（原始响应已存 roles_debug.json）"))?;
    let arr = if let Some(a) = v.as_array() {
        a.clone()
    } else if let Some(a) = v.get("data").and_then(|d| d.as_array()) {
        a.clone()
    } else {
        vec![v.clone()]
    };
    let str_or_num = |o: &serde_json::Value, k: &str| -> Option<String> {
        o.get(k).map(|x| match x {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            _ => String::new(),
        })
    };
    Ok(arr
        .iter()
        .filter_map(|o| {
            let id = str_or_num(o, "id")?;
            let name = str_or_num(o, "roleName").or_else(|| str_or_num(o, "text"))?;
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let key = str_or_num(o, "roleKey").or_else(|| str_or_num(o, "rolekey")).unwrap_or_default();
            Some((id, name, key))
        })
        .collect())
}

/// 服务端首页（/index.htm、/user/index.htm）注入的当前角色 roleKey。
/// B/S 渲染实例：`var currentRoleKey = 'SystemManager';`（旧模板为 `var roleKeys = '...'`）
async fn fetch_current_role_key(
    state: &Arc<AppState>,
    base: &str,
    root: &str,
    session: &str,
) -> Option<String> {
    for path in ["/index.htm", "/user/index.htm"] {
        // 注意 root（"AIF"/"DCP"）不带前导斜杠，必须显式补 "/"，
        // 否则拼出 https://hostAIF/index.htm（host 变成 hostaif，DNS 解析失败）
        let url = format!("{}/{}/{}", base.trim_end_matches('/'), root, path.trim_start_matches('/'));
        let html = state
            .client
            .get(&url)
            .header("Cookie", session)
            .send()
            .await
            .ok()?
            .text()
            .await
            .ok()?;
        if let Some(c) = regex::Regex::new(r#"currentRoleKey\s*=\s*'([^']+)'"#)
            .unwrap()
            .captures(&html)
        {
            let k = c[1].trim().to_string();
            if !k.is_empty() {
                return Some(k);
            }
        }
        if let Some(c) = regex::Regex::new(r#"var\s+roleKeys\s*=\s*'([^']*)'"#)
            .unwrap()
            .captures(&html)
        {
            // roleKeys 可能是多值拼接，取第一段
            let k = c[1].split(',').next().unwrap_or("").trim().to_string();
            if !k.is_empty() {
                return Some(k);
            }
        }
    }
    None
}

/// 兼容解析 switchRolesTree.htm 内嵌的角色节点（旧方案，仅作兜底保留）
fn parse_roles(html: &str) -> Vec<RoleOption> {
    use regex::Regex;
    let mut out: Vec<RoleOption> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let pats = [
        Regex::new(r#""id"\s*:\s*"([^"]+)"[^{}]*?"(?:text|name)"\s*:\s*"([^"]+)""#).unwrap(),
        Regex::new(r#"\bid\s*:\s*'([^']+)'\s*,\s*(?:text|name)\s*:\s*'([^']+)'"#).unwrap(),
    ];
    for re in pats.iter() {
        for cap in re.captures_iter(html) {
            let id = cap[1].to_string();
            let name = cap[2].to_string();
            if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
                continue;
            }
            out.push(RoleOption { id, name, role_key: String::new() });
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

/// 可用角色清单：两步协议见 fetch_role_nodes。清单为空时兜底解析壳页内嵌节点。
#[tauri::command]
pub async fn get_roles(app: AppHandle, state: State<'_, Arc<AppState>>) -> Result<Vec<RoleOption>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;
    let debug_dir = app.path().app_data_dir().ok();
    if let Some(dir) = &debug_dir {
        let _ = std::fs::create_dir_all(dir);
    }
    let nodes = fetch_role_nodes(&state, &base, &root, &session, debug_dir.as_deref()).await?;
    let roles: Vec<RoleOption> = nodes
        .into_iter()
        .map(|(id, name, key)| RoleOption { id, name, role_key: key })
        .collect();
    if roles.is_empty() {
        // 兜底：树页面内嵌数据（极少数部署不走异步加载）；roles_debug.json 已在 fetch_role_nodes 落盘
        let html = std::fs::read_to_string(
            debug_dir.as_ref().map(|d| d.join("roles_debug.html")).unwrap_or_default(),
        )
        .unwrap_or_default();
        let mut fallback = parse_roles(&html);
        for r in fallback.iter_mut() {
            r.role_key = String::new();
        }
        if fallback.is_empty() {
            return Err("角色清单为空（原始响应已存 roles_debug.json，可供校准）".to_string());
        }
        return Ok(fallback);
    }
    Ok(roles)
}

/// 切换角色：POST login/updateLogin.htm {roleId}，响应 "succ"=成功、"timeout"=会话超时
#[tauri::command]
pub async fn switch_role(state: State<'_, Arc<AppState>>, role_id: String) -> Result<(), String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;
    let resp = state
        .client
        .post(format!("{}/{}/login/updateLogin.htm", base, root))
        .header("Cookie", &session)
        .form(&[("roleId", role_id.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let body = resp.text().await.map_err(|e| e.to_string())?;
    match body.trim() {
        "succ" => Ok(()),
        "timeout" => Err("登录超时，请重新登录".to_string()),
        _ => Err("角色切换失败，没有权限进行该操作".to_string()),
    }
}

// ---------------- 空间文档 / 空间列表 ----------------

#[derive(Serialize)]
pub struct DocRow {
    pub id: String,
    pub title: String,
    pub space_name: String,
    pub file_type: String,
    /// 文档类型（browse 接口返回：DOC=在线文档 / EXCEL=在线表格；附件类为空）
    pub atype: String,
    pub url: String,
    /// 最近打开/更新时间（字符串键或毫秒数字键均支持；取不到为空串）
    pub time_str: String,
    /// 最近浏览人（browse=uname）/创建人（collect 等=createName）；取不到为空串
    pub user_name: String,
}

#[derive(Serialize)]
pub struct SpaceRow {
    pub id: String,
    pub name: String,
    pub remark: String,
    pub dept: String,
    pub color: String,
    pub collected: bool,
    pub url: String,
    /// 空间分类名（原始 spaceType 为分类 id，经 findAllSystemSpaceCategory 字典映射；
    /// 取不到为空串，前端按「未分类」处理）
    pub category: String,
}

/// 从任意 JSON 值里按候选键取字符串
fn jstr(v: &serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = v.get(k).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// 从任意 JSON 值里按候选键取毫秒时间戳（数字或数字字符串；browse 实证 opdate 为毫秒数）
fn jnum(v: &serde_json::Value, keys: &[&str]) -> i64 {
    for k in keys {
        if let Some(x) = v.get(k) {
            if let Some(n) = x.as_i64() {
                if n > 0 {
                    return n;
                }
            } else if let Some(s) = x.as_str() {
                if let Ok(n) = s.parse::<i64>() {
                    if n > 0 {
                        return n;
                    }
                }
            }
        }
    }
    0
}

/// 空间文档列表（文档 Tab 三个分类）。
/// 实证协议（DCP，2026-10-11）：
/// - 最近访问：POST {root}/knowledge/article/browse/list.htm（form: pageIndex/pageSize）
///   → {data:[{aid,atitle,atype,sid,sname,fileType}]}
/// - 我的收藏：POST {root}/api/knowledge/index/findCollectArticles.htm（JSON {pageSize}）
///   → [{businessId,businessName,spaceId,spaceName,articleType,fileType}]
/// - 公共文档：POST {root}/api/knowledge/index/findHotArticlesFromCommonSpace.htm（JSON {pageSize}）
///   → [{...}]（当前账号为空数组）
/// 文档打开地址：{root}/nonlogin/knowledge/space/home.htm?id={spaceId}&nodeId={docId}&nodeType=article
#[tauri::command]
pub async fn get_docs(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    category: String,
    page_index: i64,
    page_size: i64,
) -> Result<Vec<DocRow>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;
    let client = &state.client;

    let (url, form, json): (String, Option<Vec<(&str, String)>>, Option<serde_json::Value>) =
        match category.as_str() {
            "browse" => (
                format!("{}/{}/knowledge/article/browse/list.htm", base, root),
                Some(vec![
                    ("pageIndex", page_index.to_string()),
                    ("pageSize", page_size.to_string()),
                ]),
                None,
            ),
            "collect" => (
                format!("{}/{}/api/knowledge/index/findCollectArticles.htm", base, root),
                None,
                Some(serde_json::json!({ "pageSize": page_size })),
            ),
            "hot" => (
                format!(
                    "{}/{}/api/knowledge/index/findHotArticlesFromCommonSpace.htm",
                    base, root
                ),
                None,
                Some(serde_json::json!({ "pageSize": page_size })),
            ),
            _ => return Err(format!("未知文档分类: {category}")),
        };

    let mut req = client.post(&url).header("Cookie", &session);
    if let Some(f) = &form {
        let pairs: Vec<(&str, &str)> = f.iter().map(|(k, v)| (*k, v.as_str())).collect();
        req = req.form(&pairs);
    }
    if let Some(j) = &json {
        req = req.json(j);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("接口请求失败: {e}（会话可能已过期）"))?;
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    // 原始响应落盘 docs_debug_{category}.json（确认「上次打开时间」等字段名用；release 不写）
    if let Ok(dir) = app.path().app_data_dir() {
        debug_write(&dir, &format!("docs_debug_{category}.json"), &v.to_string());
    }

    // browse 返回 {data:[...]}，collect/hot 直接返回数组
    let arr = v
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .or_else(|| v.as_array().cloned())
        .unwrap_or_default();

    Ok(arr
        .iter()
        .map(|o| {
            let id = jstr(o, &["aid", "businessId", "id"]);
            let title = jstr(o, &["atitle", "businessName", "title"]);
            let space_id = jstr(o, &["sid", "spaceId"]);
            let space_name = jstr(o, &["sname", "spaceName"]);
            let file_type = jstr(o, &["fileType"]);
            let atype = jstr(o, &["atype", "articleType"]);
            let url = if !space_id.is_empty() && !id.is_empty() {
                format!(
                    "{}/{}/nonlogin/knowledge/space/home.htm?id={}&nodeId={}&nodeType=article",
                    base, root, space_id, id
                )
            } else {
                String::new()
            };
            // 最近打开/更新时间：先试字符串键；再试毫秒数字键
            // （browse 实证 opdate=最近打开时间，毫秒数；_id.date=首次浏览记录时间，毫秒数）
            let time_keys: &[&str] = if category == "browse" {
                &["browseTime", "lastBrowseTime", "browseDate", "lastBrowseDate", "opTime", "optime", "updateDate", "lastUpdate", "updateTime", "senddate", "createTime"]
            } else {
                &["senddate", "publishTime", "pubdate", "updateTime", "updateDate", "createTime"]
            };
            let mut time_str = jstr(o, time_keys);
            if time_str.is_empty() {
                time_str = fmt_ms(jnum(o, &["opdate", "browseTime", "updateTime", "createTime", "senddate"]));
            }
            // 最近浏览人（browse）/创建人（其余）
            let user_name = jstr(o, &["uname", "createName", "cuname"]);
            DocRow { id, title, space_name, file_type, atype, url, time_str, user_name }
        })
        .filter(|d| !d.id.is_empty() && !d.title.is_empty())
        .collect())
}

/// 空间分类字典（findAllSystemSpaceCategory）：id → 分类名。失败不阻塞空间列表。
async fn space_category_map(state: &Arc<AppState>, session: &str, base: &str, root: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let url = format!("{base}/{root}/knowledge/space/category/findAllSystemSpaceCategory.htm");
    if let Ok(resp) = client_ref(state).post(&url).header("Cookie", session).send().await {
        if let Ok(v) = resp.json::<serde_json::Value>().await {
            let arr = v
                .get("data")
                .and_then(|d| d.as_array())
                .cloned()
                .unwrap_or_default();
            for c in arr {
                if let (Some(id), Some(name)) = (
                    c.get("id").and_then(|x| x.as_str()),
                    c.get("name").and_then(|x| x.as_str()),
                ) {
                    map.insert(id.to_string(), name.to_string());
                }
            }
        }
    }
    map
}

/// 空间列表（空间 Tab 两个分类）。
/// 实证协议（DCP，2026-10-11）：
/// - 我的收藏：GET {root}/knowledge/collect/findCollectListOfSpace.htm?pageSize=1000
///   → [{id(收藏记录), spaceId, spaceName, createTime, spaceColor, belongDept{deptName}}]（B/S 端 reverse 后最近收藏在前）
/// - 全部空间：POST {root}/nonlogin/knowledge/home/findAllSpace.htm（空 body）
///   → [{id, name, remark, collect(0/1), spaceColor, belongDept{deptName}, spaceType(分类id)}]
/// - 分类字典：POST {root}/knowledge/space/category/findAllSystemSpaceCategory.htm（空 body）
///   → {data:[{id(即 spaceType), name, icon, type, innerSort}]}（2026-10-15 实测 31 个分类）
/// 空间打开地址：{root}/nonlogin/knowledge/space/home.htm?id={spaceId}
#[tauri::command]
pub async fn get_spaces(state: State<'_, Arc<AppState>>, category: String) -> Result<Vec<SpaceRow>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;

    let (url, use_form) = match category.as_str() {
        "collect" => (
            format!("{}/{}/knowledge/collect/findCollectListOfSpace.htm?pageSize=1000", base, root),
            false,
        ),
        "all" => (format!("{}/{}/nonlogin/knowledge/home/findAllSpace.htm", base, root), true),
        _ => return Err(format!("未知空间分类: {category}")),
    };

    let cat_map = space_category_map(&state, &session, &base, &root).await;

    let mut req = client_ref(&state).post(&url).header("Cookie", &session);
    if use_form {
        req = req.form(&[("pageSize", "1000")]);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("接口请求失败: {e}（会话可能已过期）"))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let arr = v.as_array().cloned().unwrap_or_default();

    Ok(arr
        .iter()
        .map(|o| {
            let id = jstr(o, &["spaceId", "id"]);
            let name = jstr(o, &["spaceName", "name"]);
            let dept = o
                .get("belongDept")
                .and_then(|d| d.get("deptName"))
                .and_then(|n| n.as_str())
                .unwrap_or("")
                .to_string();
            let collected = match o.get("collect") {
                Some(serde_json::Value::String(s)) => s == "1",
                Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(0) == 1,
                _ => category == "collect",
            };
            let space_type = jstr(o, &["spaceType"]);
            SpaceRow {
                url: if !id.is_empty() {
                    format!("{}/{}/nonlogin/knowledge/space/home.htm?id={}", base, root, id)
                } else {
                    String::new()
                },
                id,
                name,
                remark: jstr(o, &["remark"]),
                dept,
                color: jstr(o, &["spaceColor"]),
                collected,
                category: cat_map.get(&space_type).cloned().unwrap_or_default(),
            }
        })
        .filter(|s| !s.id.is_empty() && !s.name.is_empty())
        .collect())
}

fn client_ref(state: &Arc<AppState>) -> &reqwest::Client {
    &state.client
}


/// 历史消息列表（消息 Tab）
#[tauri::command]
pub fn get_messages(state: State<'_, Arc<AppState>>) -> Result<Vec<db::MessageRow>, String> {
    let conn = state.db.lock().unwrap();
    db::list_messages(&conn).map_err(|e| e.to_string())
}

/// 历史消息（B/S 真实接口，curl 实证）：
///   POST {base}/AIF/getMessageList
///   form: source=system|personal, key=关键字, pageIndex, pageSize
///   响应: {total, totalPage, pageRecord, currentPage, data:[...]}
/// 每条消息字段：t=来源系统名, c=内容, mc=模块码, s=system|personal,
///   st=时间"yyyy-MM-dd HH:mm:ss", pcUrl=PC 跳转链接, si={userName=发送人}
#[derive(Serialize)]
pub struct HistoryMessage {
    pub id: String,
    pub title: String,
    pub body: String,
    pub sender: String,
    pub time_str: String,
    pub url: String,
    pub source: String,
    /// 消息模块码（mc），前端据此选择类型图标
    pub mc: String,
}

#[tauri::command]
pub async fn get_message_history(
    state: State<'_, Arc<AppState>>,
    source: String,
    key: String,
    page_index: i64,
    page_size: i64,
) -> Result<Vec<HistoryMessage>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;
    let resp = state
        .client
        .post(format!("{}/{}/getMessageList", base, root))
        .header("Cookie", &session)
        .form(&[
            ("source", source.as_str()),
            ("key", key.as_str()),
            ("pageIndex", page_index.to_string().as_str()),
            ("pageSize", page_size.to_string().as_str()),
        ])
        .send()
        .await
        .map_err(|e| format!("拉取历史消息失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("拉取历史消息失败: {e}"))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("解析历史消息失败: {e}"))?;
    let arr = v.get("data").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let out = arr
        .iter()
        .map(|o| {
            let g = |k: &str| {
                o.get(k)
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string()
            };
            let sender = o
                .get("si")
                .and_then(|si| si.get("userName"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let body = g("c");
            // 稳定去重键：来源|发送时间(秒)|内容|发送人 —— 与 poller::fetch_history_messages
            // 完全同构（此前用服务端 id/tid/bid，与轮询入库的内容哈希 id 是两套空间，
            // 导致轮询标了未读但消息页行 id 对不上、点行消不掉角标、行内未读样式失效）
            let id = format!(
                "{:016x}",
                poller::fnv1a(&format!("hist|{}|{}|{}|{}", g("s"), g("st"), body, sender))
            );
            // 标题：系统消息用来源系统名（t），个人消息用发送人；都没有则截取内容
            let mut title = g("t");
            if title.is_empty() {
                title = sender.clone();
            }
            if title.is_empty() {
                title = body.chars().take(20).collect();
            }
            HistoryMessage {
                id,
                title,
                body,
                sender,
                time_str: g("st"),
                // 文档空间类消息打开页面时带 articleShowMessageBox=true（B/S 弹文档展示框）
                url: poller::append_article_param(&g("mc"), poller::absolute_url(&base, &root, &g("pcUrl"))),
                source: g("s"),
                mc: g("mc"),
            }
        })
        .filter(|m| !m.body.is_empty())
        .collect();
    Ok(out)
}

// ==================== 我的事项（待办 Tab 数据源） ====================
// curl 实证三类接口（均为 GET，带会话 Cookie）：
//   我收到的:   GET {base}/{root}/homePage/findReceivedMatters.htm
//               → [{bid, bname, receive, todo, done, todo_pc_url, ongoing_all_pc_url, ...}]
//   我发出的填报: GET {base}/{root}/datafilling/ru/my/findListOfSendAggregationBySpace.htm
//               → [ {...} ]（聚合结构，字段容错解析）
//   我发出的流程: GET {base}/{root}/business/querySendItemList.htm?more=more
//               → {data: [{typename:"【公告】", bname, ongoing, end, draft,
//                          ongoing_pc_url, end_pc_url, draft_pc_url, ...}]}

#[derive(Serialize, Clone)]
pub struct MatterBadge {
    pub label: String,
    pub count: i64,
    /// 色调：red / green / blue / gray（前端按此着色，对齐 B/S 我的事项表）
    pub tone: String,
    /// 该统计对应的跳转 URL（参考 B/S：待办数→待办页、已办数→已办页）；空=不可点
    pub url: String,
}

#[derive(Serialize)]
pub struct MatterRow {
    /// received=我收到的 / filling=我发出的填报 / flow=我发出的流程
    pub category: String,
    pub id: String,
    pub title: String,
    /// 事项类型标签（流程审批 / 智能填报…）
    pub tag: String,
    /// 最新收到/发出时间（"yyyy-MM-dd HH:mm"）
    pub time_str: String,
    pub badges: Vec<MatterBadge>,
    pub url: String,
}

/// 毫秒时间戳 → "yyyy-MM-dd HH:mm"（UTC+8；B/S 部署即东八区，直接偏移）
fn fmt_ms(ms: i64) -> String {
    if ms <= 0 {
        return String::new();
    }
    let secs = ms.div_euclid(1000) + 8 * 3600;
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi) = (rem / 3600, (rem % 3600) / 60);
    // Howard Hinnant civil_from_days 算法
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}")
}

/// defs 项：(计数字段, 标签, 色调, 对应跳转 URL 字段候选列表)。
fn matter_badges(o: &serde_json::Value, defs: &[(&str, &str, &str, &[&str])]) -> Vec<MatterBadge> {
    defs.iter()
        .map(|(k, label, tone, url_keys)| MatterBadge {
            label: label.to_string(),
            count: o.get(k).and_then(|x| x.as_i64()).unwrap_or(0),
            tone: tone.to_string(),
            url: first_url(o, url_keys),
        })
        .collect()
}

/// 把 badge 里的相对 URL 统一转成绝对 URL
fn absolutize_badges(base: &str, root: &str, badges: &mut [MatterBadge]) {
    for b in badges.iter_mut() {
        if !b.url.is_empty() {
            b.url = poller::absolute_url(base, root, &b.url);
        }
    }
}

fn first_url(o: &serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(u) = o.get(k).and_then(|x| x.as_str()) {
            if !u.is_empty() && u != "NO" {
                return u.to_string();
            }
        }
    }
    String::new()
}

async fn get_matter_json(
    state: &Arc<AppState>,
    base: &str,
    root: &str,
    path: &str,
    session: &str,
) -> Result<serde_json::Value, String> {
    let resp = state
        .client
        .get(format!("{}{}{}", base.trim_end_matches('/'), root, path))
        .header("Cookie", session)
        .send()
        .await
        .map_err(|e| format!("拉取事项失败: {e}"))?
        .error_for_status()
        .map_err(|e| format!("拉取事项失败: {e}"))?;
    resp.json()
        .await
        .map_err(|e| format!("解析事项失败: {e}"))
}

/// 我的事项（待办 Tab）：三类并行拉取，合并返回
#[tauri::command]
pub async fn get_matters(state: State<'_, Arc<AppState>>) -> Result<Vec<MatterRow>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (
            s.base_url.trim_end_matches('/').to_string(),
            format!("/{}", s.app_root()),
        )
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;

    let (r_recv, r_fill, r_flow) = tokio::join!(
        get_matter_json(&state, &base, &root, "/homePage/findReceivedMatters.htm", &session),
        get_matter_json(&state, &base, &root, "/datafilling/ru/my/findListOfSendAggregationBySpace.htm", &session),
        get_matter_json(&state, &base, &root, "/business/querySendItemList.htm?more=more", &session),
    );

    let mut out: Vec<MatterRow> = Vec::new();

    // 我收到的
    if let Ok(v) = r_recv {
        for (i, o) in v.as_array().cloned().unwrap_or_default().iter().enumerate() {
            let todo = o.get("todo").and_then(|x| x.as_i64()).unwrap_or(0);
            let title = o.get("bname").and_then(|x| x.as_str()).unwrap_or("").to_string();
            if title.is_empty() {
                continue;
            }
            let id = o
                .get("bid")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("recv-{i}"));
            let url = if todo > 0 {
                first_url(o, &["todo_pc_url", "ongoing_all_pc_url"])
            } else {
                first_url(o, &["ongoing_all_pc_url", "todo_pc_url"])
            };
            let tag = o
                .get("typename")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("流程审批")
                .to_string();
            // 统计数字跳转：待办→待办页、已办→已办页、抄送→抄送页（缺省回退全量页）
            let mut badges = matter_badges(
                o,
                &[
                    ("todo", "待办", "red", &["todo_pc_url"]),
                    ("done", "已办", "green", &["done_pc_url", "ongoing_all_pc_url"]),
                    ("copy", "抄送", "blue", &["copy_pc_url", "ongoing_all_pc_url"]),
                ],
            );
            absolutize_badges(&base, root.trim_matches('/'), &mut badges);
            out.push(MatterRow {
                category: "received".into(),
                id,
                title,
                tag,
                time_str: o.get("tododate").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                badges,
                url: poller::absolute_url(&base, root.trim_matches('/'), &url),
            });
        }
    }

    // 我发出的填报（聚合结构未知账号场景下为空数组，容错解析）
    if let Ok(v) = r_fill {
        for (i, o) in v.as_array().cloned().unwrap_or_default().iter().enumerate() {
            let title = ["bname", "name", "spaceName"]
                .iter()
                .find_map(|k| o.get(k).and_then(|x| x.as_str()))
                .unwrap_or("")
                .to_string();
            if title.is_empty() {
                continue;
            }
            // spaceId（B/S record.id 即 spaceId，onOpenSend 用它拼 sendList 跳转）
            let space_id = o
                .get("id")
                .or_else(|| o.get("uuid"))
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("fill-{i}"));
            // 字段语义（B/S matters.htm 列头）：readyTotal=未开始 pendingTotal=进行中 endTotal=已结束
            let last_fill = o.get("lastFillingTime").and_then(|x| x.as_i64()).unwrap_or(0);
            let mut badges = matter_badges(
                o,
                &[
                    ("pendingTotal", "进行中", "red", &[] as &[&str]),
                    ("readyTotal", "未开始", "gray", &[]),
                    ("endTotal", "已结束", "green", &[]),
                ],
            );
            // 填报统计跳转（B/S matters.html onOpenSend 协议，非 *_pc_url 字段）：
            //   sendList.htm?spaceId=<spaceId>&state=<10=未开始 | 20=进行中 | 30,40=已结束/提前结束>
            let fill_url = |st: &str| {
                format!(
                    "{}/{}/datafilling/ru/my/sendList.htm?spaceId={space_id}&state={st}",
                    base.trim_end_matches('/'),
                    root.trim_matches('/'),
                )
            };
            badges[0].url = fill_url("20");
            badges[1].url = fill_url("10");
            badges[2].url = fill_url("30,40");
            // 整行跳转：对齐 B/S 名称列点击 → 进行中(20) 列表（先算好再 move space_id）
            let row_url = fill_url("20");
            out.push(MatterRow {
                category: "filling".into(),
                id: space_id,
                title,
                tag: "智能填报".into(),
                time_str: fmt_ms(last_fill),
                badges,
                url: row_url,
            });
        }
    }

    // 我发出的流程
    if let Ok(v) = r_flow {
        for (i, o) in v
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .enumerate()
        {
            let typename = o.get("typename").and_then(|x| x.as_str()).unwrap_or("");
            let bname = o.get("bname").and_then(|x| x.as_str()).unwrap_or("");
            let title = bname.to_string();
            let tag = if typename.is_empty() { "流程审批" } else { typename }.to_string();
            if title.trim().is_empty() {
                continue;
            }
            let id = o
                .get("bid")
                .and_then(|x| x.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| format!("flow-{i}"));
            let mut badges = matter_badges(
                o,
                &[
                    ("ongoing", "进行中", "red", &["ongoing_pc_url"]),
                    ("end", "已结束", "green", &["end_pc_url"]),
                    ("draft", "草稿", "blue", &["draft_pc_url"]),
                ],
            );
            absolutize_badges(&base, root.trim_matches('/'), &mut badges);
            out.push(MatterRow {
                category: "flow".into(),
                id,
                title,
                tag,
                time_str: o.get("senddate").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                badges,
                url: poller::absolute_url(
                    &base,
                    root.trim_matches('/'),
                    &first_url(o, &["ongoing_pc_url", "end_pc_url", "draft_pc_url"]),
                ),
            });
        }
    }

    Ok(out)
}

/// 应用版本号：5.0.序号 — 取 CARGO_PKG_VERSION (5.0.0) 的 major.minor + 编译次数
/// （build.rs 每次编译累加），如 5.0.12。
/// Rust 无 C 语言式 __BUILD_NUMBER__ 内建宏，业界通行做法即 build.rs 维护计数文件并经
/// cargo:rustc-env 注入（本项目 BUILD_ID），等价且可跨平台。
#[tauri::command]
pub fn get_app_version() -> String {
    let mut seg = env!("CARGO_PKG_VERSION").split('.');
    let major = seg.next().unwrap_or("5");
    let minor = seg.next().unwrap_or("0");
    format!("{}.{}.{}", major, minor, env!("BUILD_ID"))
}

/// 前端点击外部链接 → 调用系统默认浏览器打开（webview 内不承载第三方站点导航）
#[tauri::command]
pub fn open_external(url: String) {
    open_in_system_browser(&url);
}

// ==================== 运维 Tab：应用中心 ====================

#[derive(Serialize, Clone)]
pub struct OpsApp {
    pub id: String,
    pub name: String,
    /// 系统管理员姓名（B/S 卡片显示「管理员：xxx」）
    pub leader: String,
    pub unit: String,
    /// normal=正常运行 / alert=告警（currentStatus==1）
    pub status: String,
    /// 告警事件标题（仅 alert 时有值）
    pub event: String,
    /// 应用图标绝对地址（空=前端用默认图标）
    pub icon: String,
    /// 应用详情页绝对地址（点击 → 系统浏览器打开）
    pub url: String,
}

#[derive(Serialize, Clone)]
pub struct OpsAppGroup {
    /// 应用类型 id（10=平台类 20=业务系统 30=其他，以服务端 codeList 为准）
    pub id: String,
    pub name: String,
    pub apps: Vec<OpsApp>,
}

/// 从页面源码提取 JS 单引号字符串字面量（处理 \\ 转义），marker 形如 "var appList = mini.decode('"
fn extract_js_string(html: &str, marker: &str) -> Option<String> {
    let start = html.find(marker)? + marker.len();
    let bytes = html.as_bytes();
    let mut out = String::new();
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => {
                // 转义字符：保留下一字符原义（\' → '，\\ → \）
                if i + 1 < bytes.len() {
                    out.push(bytes[i + 1] as char);
                    i += 2;
                } else {
                    return None;
                }
            }
            b'\'' => break,
            _ => {
                // 多字节 UTF-8 按字符边界拷贝
                let ch_len = utf8_char_len(bytes[i]);
                out.push_str(&html[i..i + ch_len]);
                i += ch_len;
            }
        }
    }
    Some(out)
}

fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b >> 5 == 0b110 {
        2
    } else if b >> 4 == 0b1110 {
        3
    } else {
        4
    }
}

/// 运维产品（AIF）应用中心数据：GET assetsManage/portal/workbench.htm，
/// 应用清单与类型分组由服务端内嵌（var appList = mini.decode('...') / var codeList = [...]），
/// 无独立 AJAX 数据接口。原始响应落盘 ops_workbench_debug.html 供校准。
#[tauri::command]
pub async fn get_ops_apps(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<OpsAppGroup>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;

    let resp = state
        .client
        .get(format!("{}/{}/assetsManage/portal/workbench.htm", base, root))
        .header("Cookie", &session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let html = resp.text().await.map_err(|e| e.to_string())?;
    if let Some(dir) = app.path().app_data_dir().ok() {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("ops_workbench_debug.html"), &html);
    }
    if !status.is_success() {
        return Err(format!("获取应用中心失败（HTTP {}，会话可能已过期，请重新登录）", status.as_u16()));
    }
    if !html.contains("var appList") {
        return Err("未登录或会话已过期（页面未包含应用数据），请重新登录".to_string());
    }

    // 应用类型分组：var codeList = [{"name":"平台类","id":"10"},...]
    let code_json = regex::Regex::new(r"(?s)var\s+codeList\s*=\s*(\[.*?\]);")
        .unwrap()
        .captures(&html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        .unwrap_or_else(|| r#"[{"name":"平台类","id":"10"},{"name":"业务系统","id":"20"},{"name":"其他","id":"30"}]"#.to_string());
    let codes: Vec<serde_json::Value> =
        serde_json::from_str(&code_json).unwrap_or_default();

    // 应用清单：var appList = mini.decode('[...]')（JS 单引号字符串，内部 \' 转义）
    let app_json = extract_js_string(&html, "var appList = mini.decode('")
        .ok_or("页面结构变化：未找到应用清单数据（原始页面已存 ops_workbench_debug.html）")?;
    let apps: Vec<serde_json::Value> = serde_json::from_str(&app_json)
        .map_err(|e| format!("应用清单解析失败: {e}（原始页面已存 ops_workbench_debug.html）"))?;

    let gstr = |o: &serde_json::Value, k: &str| -> String {
        o.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
    };
    let detail_url = |id: &str| {
        format!(
            "{}/{}/assetsManage/platformAccount/applicationSystem/detailApplicationSystem.htm?id={}",
            base, root, id
        )
    };
    let abs_icon = |u: &str| -> String {
        if u.is_empty() {
            String::new()
        } else {
            poller::absolute_url(&base, root.trim_matches('/'), u)
        }
    };

    let mut out: Vec<OpsAppGroup> = Vec::new();
    for code in &codes {
        let gid = code.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let gname = code.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
        if gid.is_empty() {
            continue;
        }
        let mut group_apps: Vec<OpsApp> = apps
            .iter()
            .filter(|a| gstr(a, "type") == gid)
            .map(|a| {
                let id = gstr(a, "id");
                let cur = a.get("currentStatus").and_then(|x| x.as_i64()).unwrap_or(0);
                OpsApp {
                    url: detail_url(&id),
                    event: gstr(a, "eventTitle"),
                    icon: abs_icon(&gstr(a, "iconUrl")),
                    status: if cur == 1 { "alert".into() } else { "normal".into() },
                    id,
                    name: gstr(a, "appsystemName"),
                    leader: gstr(a, "systemLeaderName"),
                    unit: gstr(a, "unitName"),
                }
            })
            .collect();
        if group_apps.is_empty() {
            continue;
        }
        // displayOrder 升序（1000 视为「排最后」的默认值）
        group_apps.sort_by_key(|a| {
            apps.iter()
                .find(|o| gstr(o, "id") == a.id)
                .and_then(|o| o.get("displayOrder").and_then(|x| x.as_i64()))
                .unwrap_or(1000)
        });
        out.push(OpsAppGroup { id: gid, name: gname, apps: group_apps });
    }
    if out.is_empty() {
        return Err("应用清单为空（原始页面已存 ops_workbench_debug.html，可供校准）".to_string());
    }
    Ok(out)
}

/// 授权智能体（B/S 主页「AI 问答」入口数据源）
#[derive(Clone, Serialize)]
pub struct AiAgent {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon: String,
}

/// 智能体列表进程级缓存：1 小时 TTL（低频更新；B/S 授权变更最迟 1 小时后可见），
/// 主窗标题栏刷新按钮以 force 旁路强制拉取。
static AGENTS_CACHE: OnceLock<Mutex<Option<(Instant, Vec<AiAgent>)>>> = OnceLock::new();
const AGENTS_TTL: Duration = Duration::from_secs(3600);

/// B/S 主页 AI 问答入口：获取当前账号授权的智能体列表（[{id,name,description,icon}]），
/// 数据源先新版 persona 后旧版 agent（见函数体内注释）；前端拼
/// ai/chat/index.htm?aiAgentId=<id> 在受控 webview 中打开问答页
/// （B/S 原生行为：top.openNewTab(url, 'AI问答（name）', 'agentic_agent_'+id)）
#[tauri::command]
pub async fn get_ai_agents(
    state: State<'_, Arc<AppState>>,
    force: Option<bool>,
) -> Result<Vec<AiAgent>, String> {
    // 未过期缓存直接返回（std Mutex 不可跨 await 持有，语句结束即释放）
    if !force.unwrap_or(false) {
        if let Some((at, agents)) = AGENTS_CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .clone()
        {
            if at.elapsed() < AGENTS_TTL {
                return Ok(agents);
            }
        }
    }
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (
            s.base_url.trim_end_matches('/').to_string(),
            s.app_root().to_string(),
        )
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;

    // 数据源探测顺序（2026-10-14 与用户确认的版本语义）：
    // 1) /{产品根}/ai/persona/agent/authorized.htm —— 新版接口（AIF 部署；实测 AIF 会话 200）
    // 2) /{产品根}/ai/agent/authorized.htm —— 旧版接口（DCP 部署；实测 DCP 会话 200，18 个智能体）
    // 两产品各只部署其一：先试新版，接口不存在（404 等非成功）自动回退旧版；
    // 成功返回的数组（含空）视为权威结果，直接采用不再兜底。
    let mut last_err = String::new();
    for (src_root, path) in [
        (root.clone(), format!("/{root}/ai/persona/agent/authorized.htm")),
        (root.clone(), format!("/{root}/ai/agent/authorized.htm")),
    ] {
        let url = format!("{base}{path}");
        match state
            .client
            .post(&url)
            .header("Cookie", &session)
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let text = resp.text().await.map_err(|e| e.to_string())?;
                // mini.decode 兼容两种返回：裸 JSON 数组 / 字符串包裹的 JSON，逐层剥开
                let mut val: serde_json::Value = serde_json::from_str(text.trim())
                    .map_err(|e| format!("智能体数据解析失败: {e}"))?;
                if let serde_json::Value::String(s) = &val {
                    val = serde_json::from_str(s).map_err(|e| format!("智能体数据解析失败: {e}"))?;
                }
                if let Some(arr) = val.as_array() {
                    let gstr = |o: &serde_json::Value, k: &str| -> String {
                        o.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
                    };
                    // 图标归一化为绝对 URL：实测 B/S 返回相对路径 resources/images/...，
                    // 真实资源位于 {base}/{产品根}/resources/...（/DCP/resources/... 200 实证）。
                    // 另外兼容服务端偶发的重复版本号尾巴（?v=...?v=...），只保留第一段 query。
                    let icon_abs = |raw: &str| -> String {
                        if raw.is_empty() || raw.starts_with("http://") || raw.starts_with("https://") {
                            return raw.to_string();
                        }
                        let joined = if raw.starts_with('/') {
                            format!("{base}{raw}")
                        } else {
                            format!("{base}/{src_root}/{raw}")
                        };
                        match joined.split_once('?') {
                            Some((p, q)) => {
                                let q = q.split("?v=").next().unwrap_or(q);
                                if q.is_empty() { p.to_string() } else { format!("{p}?{q}") }
                            }
                            None => joined,
                        }
                    };
                    let agents: Vec<AiAgent> = arr
                        .iter()
                        .map(|a| AiAgent {
                            id: gstr(a, "id"),
                            name: gstr(a, "name"),
                            description: gstr(a, "description"),
                            icon: icon_abs(&gstr(a, "icon")),
                        })
                        .filter(|a| !a.id.is_empty())
                        .collect();
                    // 拿到合法数组即返回：空数组 = 账号无授权智能体，也是权威结果，不再兜底
                    *AGENTS_CACHE.get_or_init(|| Mutex::new(None)).lock().unwrap() =
                        Some((Instant::now(), agents.clone()));
                    return Ok(agents);
                } else {
                    last_err = format!("{path} 数据格式异常（非数组）");
                }
            }
            Ok(resp) => {
                last_err = format!("{path} HTTP {}", resp.status().as_u16());
            }
            Err(e) => {
                last_err = format!("{path} {e}");
            }
        }
    }
    Err(format!("获取智能体列表失败（{last_err}，会话可能已过期）"))
}

/// 关闭/隐藏「当前 webview」：B/S 页面里的 window.close() 由初始化脚本转交到这里。
/// 分流规则：
/// - 标签页（tab-N）：不走本命令——标签的 shim 会转交 tab_close_self；
/// - B/S 弹窗（bs-page-N）与对话窗（conversation）：直接关闭窗口；
/// - 主窗/登录窗：B/S 页面不可能合法地关闭应用主窗——只记日志，不做任何动作。
#[tauri::command]
pub fn close_webview_self(app: AppHandle, window: tauri::Window) {
    let label = window.label().to_string();
    log::info!("[close-self] webview 请求关闭自身: label={label}");
    if label == "main" {
        // 主窗 webview 是应用 UI 本体，B/S 页面只存在于子 webview
        // （tab-N / bs-page-N / conversation / login）。
        // 只记日志，绝不 hide/close 主窗（历史上隐藏主窗会让用户以为程序挂了）。
        log::warn!("[close-self] label=main 的关闭请求已忽略（主窗不承载 B/S 页面）");
        return;
    }
    if label == "login" {
        if let Some(w) = app.get_webview_window("login") {
            let _ = w.hide();
        }
        return;
    }
    // bs-page-N / conversation 等独立窗口：整窗关闭，并通知前端刷新当前页
    // （B/S 关闭详情/编辑页常伴随数据变更，消息/待办列表需要重取）
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
        let _ = app.emit("bs-closed", ());
    }
}

/// [自愈] 主窗口丢失时按 tauri.conf.json 同款配置重建：
/// 回默认小窗（475×640）、右下角、显示。修复「主窗被异常销毁后
/// layout/托盘全部失灵（主窗口不存在 / NOT FOUND）」后程序变砖的问题。
/// 仅在 get_webview_window("main") 为 None 时才重建，正常路径零开销。
/// [自愈] 主窗口丢失时按 tauri.conf.json 同款配置重建：小窗（475×640）、右下角、显示。
///
/// 关键教训（tauri 2.12 源码实证）：绝不能用 get_webview_window("main") 判断主窗
/// 是否存在——它内部有 is_webview_window() 过滤（窗口内一旦出现 label≠窗口名的
/// 子 webview（如 pane）即对主窗返回 None），全屏模式建了 pane 后它恒为 None，
/// 历史上「主窗口不存在 / raise NOT FOUND」皆由此误判。故改用 get_window("main")：
/// Window 句柄不受 pane 影响，且 set_position/set_size/show 等本就是 Window 方法。
pub(crate) async fn ensure_main_window(app: &AppHandle) -> Result<tauri::Window, String> {
    if let Some(w) = app.get_window("main") {
        return Ok(w);
    }
    log::warn!("[self-heal] 主窗口丢失，正在重建（小窗 + 右下角）");
    let title = app
        .try_state::<Arc<AppState>>()
        .map(|s| s.settings.lock().unwrap().product_title().to_string())
        .unwrap_or_else(|| "业务小助手".to_string());
    tauri::WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(830.0, 960.0)
        .min_inner_size(360.0, 480.0)
        .resizable(true)
        .visible(false)
        .decorations(false)
        .skip_taskbar(true)
        .shadow(true)
        .build()
        .map_err(|e| format!("重建主窗口失败: {e}"))?;
    // 布局状态随窗口一起重置；主窗重建会销毁全部子 webview，标签状态一并清空
    *MINI_RECT.lock().unwrap() = None;
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        crate::tabs::reset_all(app, &state);
    }
    let w = app.get_window("main").ok_or("重建后仍取不到主窗句柄")?;
    // 右下角落位后显示（工作区坐标，避开任务栏）
    if let Some((l, t, r, b)) = work_area_of(&w) {
        if let Ok(s) = w.outer_size() {
            let x = (r - s.width as i32 - MINI_EDGE_MARGIN).max(l);
            let y = (b - s.height as i32 - MINI_EDGE_MARGIN).max(t);
            let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    let _ = w.show();
    Ok(w)
}

// ==================== 快捷功能（B/S「快捷入口」九宫格） ====================
// 协议（ops_workbench_debug.html 源码实证，2026-10-12）：
//   GET {base}/{root}/busexpress/showpage/queryListByRole.htm（带会话 Cookie）
//   → [{busname, busurl, buspic, opentype}]
//   - {root} 跟随产品：运维=AIF / 一表通=DCP（settings.app_root()）
//   - 图标：{base}/{root}/<buspic>（B/S 原生即 '/AIF/' + buspic）
//   - 打开地址（expressurl）：opentype 0/1 → {base}/{root}/<busurl>；opentype 2/3 → busurl 原样（绝对地址）

#[derive(Serialize, Clone)]
pub struct QuickEntry {
    pub id: String,
    pub name: String,
    /// 点击打开的绝对 URL
    pub url: String,
    /// 图标绝对地址（空=前端用首字母 fallback）
    pub icon: String,
}

/// 快捷入口图标本地兜底：磁盘缓存（app_data_dir/icon_cache/<hash>.<ext>）优先，
/// 未命中则带会话下载（单图 3s 超时，上限 512KB）后落盘，返回 data URI。
/// 任何失败（未登录态过期/网络不通/非图片类型）返回空串 → 前端用首字母兜底。
/// data URI 同时规避了两类显示问题：CSP img-src 域名白名单限制 + 远程加载偶发超时。
async fn icon_data_uri(
    client: &reqwest::Client,
    session: &str,
    url: &str,
    cache_dir: &Path,
) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    if url.is_empty() {
        return String::new();
    }
    let mut h = DefaultHasher::new();
    url.hash(&mut h);
    let hash = format!("{:016x}", h.finish());

    // 扩展名 → MIME（缓存命中时反推 data URI 用）
    const MIME_BY_EXT: &[(&str, &str)] = &[
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("gif", "image/gif"),
        ("ico", "image/x-icon"),
        ("svg", "image/svg+xml"),
        ("webp", "image/webp"),
    ];
    for (ext, mime) in MIME_BY_EXT {
        let p = cache_dir.join(format!("{hash}.{ext}"));
        if let Ok(bytes) = std::fs::read(&p) {
            return format!(
                "data:{mime};base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            );
        }
    }

    // 下载：3s 超时，仅收 2xx 且非空的图片响应
    let resp = match client
        .get(url)
        .header("Cookie", session)
        .timeout(Duration::from_secs(3))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return String::new(),
    };
    let mime = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let bytes = match resp.bytes().await {
        Ok(b) if !b.is_empty() && b.len() <= 512 * 1024 => b,
        _ => return String::new(),
    };
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/x-icon" | "image/vnd.microsoft.icon" => "ico",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        _ => return String::new(), // 非图片类型不缓存不返回
    };
    let _ = std::fs::create_dir_all(cache_dir);
    let _ = std::fs::write(cache_dir.join(format!("{hash}.{ext}")), &bytes);
    format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    )
}

/// 快捷入口清单（与 B/S「快捷入口」弹层同源；路径跟随产品根：运维=AIF / 一表通=DCP）
#[tauri::command]
pub async fn get_quick_entries(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<QuickEntry>, String> {
    let (base, root) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string())
    };
    let session = auth::load_session().filter(|s| !s.is_empty()).ok_or("未登录")?;

    let resp = state
        .client
        .get(format!("{base}/{root}/busexpress/showpage/queryListByRole.htm"))
        .header("Cookie", &session)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!(
            "获取快捷入口失败（HTTP {}，会话可能已过期，请重新登录）",
            resp.status().as_u16()
        ));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    // 原始响应落盘 quick_entry_debug.json 供校准（release 不写）
    if let Ok(dir) = app.path().app_data_dir() {
        debug_write(&dir, "quick_entry_debug.json", &text);
    }
    let v: serde_json::Value =
        serde_json::from_str(text.trim()).map_err(|e| format!("快捷入口数据解析失败: {e}"))?;
    let arr = if let Some(a) = v.as_array() {
        a.clone()
    } else if let Some(a) = v.get("data").and_then(|d| d.as_array()) {
        a.clone()
    } else {
        Vec::new()
    };
    let gstr = |o: &serde_json::Value, k: &str| -> String {
        o.get(k).and_then(|x| x.as_str()).unwrap_or("").trim().to_string()
    };
    // 图标 URL 解析：与 busurl 一致，http(s) 原样、相对路径拼 /{root}/ 前缀
    let resolved_icons: Vec<String> = arr
        .iter()
        .map(|o| {
            let buspic = gstr(o, "buspic");
            if buspic.is_empty() {
                String::new()
            } else if buspic.starts_with("http://") || buspic.starts_with("https://") {
                buspic
            } else {
                format!("{base}/{root}/{buspic}")
            }
        })
        .collect();

    // 图标本地化（并发下载/读缓存）：成功 → data URI；失败 → 空串，前端首字母兜底
    let cache_dir = app
        .path()
        .app_data_dir()
        .map(|d| d.join("icon_cache"))
        .unwrap_or_else(|_| std::env::temp_dir().join("aif_icon_cache"));
    let mut uniq: Vec<String> = resolved_icons.iter().filter(|u| !u.is_empty()).cloned().collect();
    uniq.sort();
    uniq.dedup();
    let mut handles = Vec::new();
    for u in uniq {
        let client = state.client.clone();
        let session = session.clone();
        let dir = cache_dir.clone();
        handles.push((u.clone(), tauri::async_runtime::spawn(async move {
            icon_data_uri(&client, &session, &u, &dir).await
        })));
    }
    let mut icon_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (u, h) in handles {
        icon_map.insert(u, h.await.unwrap_or_default());
    }

    Ok(arr
        .iter()
        .enumerate()
        .filter_map(|(i, o)| {
            let name = gstr(o, "busname");
            let busurl = gstr(o, "busurl");
            let opentype = gstr(o, "opentype");
            if name.is_empty() || busurl.is_empty() {
                return None;
            }
            // 与 B/S expressurl 一致：0/1 拼 /{root}/ 前缀，2/3 原样
            let url = if opentype == "2" || opentype == "3" {
                busurl
            } else if busurl.starts_with("http://") || busurl.starts_with("https://") {
                busurl
            } else {
                format!("{base}/{root}/{busurl}")
            };
            let icon = resolved_icons
                .get(i)
                .and_then(|u| icon_map.get(u))
                .cloned()
                .unwrap_or_default();
            Some(QuickEntry {
                id: format!("qe-{i}"),
                name,
                url,
                icon,
            })
        })
        .collect())
}

/// 设置全局快捷键（空串=注销）。注册成功后写入 settings 并持久化。
#[tauri::command]
pub fn set_hotkey(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    hotkey: String,
) -> Result<(), String> {
    let key = hotkey.trim().to_string();
    crate::hotkey::apply(&app, &key)?;
    let snapshot = {
        let mut s = state.settings.lock().unwrap();
        s.hotkey = key;
        s.clone()
    };
    let conn = state.db.lock().unwrap();
    db::save_settings(&conn, &snapshot).map_err(|e| e.to_string())
}

/// 开机自启开关（tauri-plugin-autostart）
#[tauri::command]
pub fn set_autostart(app: AppHandle, enable: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if enable {
        al.enable().map_err(|e| e.to_string())
    } else {
        al.disable().map_err(|e| e.to_string())
    }
}

/// 启动时自动登录：已开启自动登录、已保存凭据且当前无需验证码时静默登录。
/// 需要验证码则返回 false，由前端展示登录窗（验证码必须人工输入）。
#[tauri::command]
pub async fn try_auto_login(state: State<'_, Arc<AppState>>, app: AppHandle) -> Result<bool, String> {
    {
        let s = state.settings.lock().unwrap();
        if !s.auto_login {
            return Ok(false);
        }
    }
    silent_login(&state, &app).await
}

/// 静默登录核心：保险库凭据（当前网址+产品）→ keyring 兜底，POST 登录并接管会话。
/// 供启动自动登录（try_auto_login）与运行中心跳失效自愈（poller::maybe_relogin）共用。
/// 返回：Ok(true)=登录成功；Ok(false)=无法自动登录（无凭据/需要图形验证码）；
///       Err=登录被拒（如密码错误，text 为 B/S 返回信息）。
pub(crate) async fn silent_login(state: &Arc<AppState>, app: &AppHandle) -> Result<bool, String> {
    log::info!("[silent-login] enter");
    let (base, root, ops) = {
        let s = state.settings.lock().unwrap();
        (s.base_url.trim_end_matches('/').to_string(), s.app_root().to_string(), s.ops_product)
    };
    // 凭据单一来源：优先取保险库中「当前网址+产品」匹配的常用入口；
    // 老用户尚未入库时回退系统凭据管理器（keyring），登录一次后即入库
    let (uname, pwd) = match vault_find_creds(state, &base, ops) {
        Some(c) => c,
        None => match auth::load_credentials() {
            Some(c) => c,
            None => return Ok(false),
        },
    };
    let cookie = ensure_session(state).await?;
    let resp = state
        .auth_client
        .post(format!(
            "{}/{}/nonlogin/login/captcha/isvalid.htm",
            base, root
        ))
        .header("Cookie", &cookie)
        .form(&[("uname", uname.as_str())])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let need = resp
        .text()
        .await
        .map_err(|e| e.to_string())?
        .trim()
        .eq_ignore_ascii_case("true");
    if need {
        return Ok(false);
    }
    let resp = state
        .auth_client
        .post(format!("{}/{}/login/Login.htm", base, root))
        .header("Cookie", &cookie)
        .form(&[
            ("uname", uname.as_str()),
            ("pwd", pwd.as_str()),
            ("verification", ""),
            ("opt", ""),
            ("vcode", ""),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let newc = extract_session_cookie(&resp);
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if text.trim().is_empty() {
        let session = if newc.contains("JSESSIONID") { newc } else { cookie };
        *state.session.lock().unwrap() = session.clone();
        let _ = auth::save_session(&session);
        // 调试双保险：本地登录的会话同样落盘，供外部 curl 逆向 B/S 接口（release 不写）
        if let Ok(dir) = app.path().app_data_dir() {
            debug_write(&dir, "debug_session.txt", &session);
        }
        let _ = app.emit("logged-in", ());
        Ok(true)
    } else {
        Err(text.trim().to_string())
    }
}

// ==================== 多网址账号保险库（SM4 国密加密） ====================
// 「我的」页多网址管理：产品+网址+账号+密码成组，以网址为 key；
// 密码字段用 SM4-ECB（PKCS7）加密后落盘 kv 表（key='account_vault'）。
// SM4 密钥 16 字节首次使用时随机生成，存 kv 'vault_key'（本机混淆级保护，
// 防止明文密码直接可见；数据库与密钥同机，不防本机攻击者）。

#[derive(Serialize, Clone)]
pub struct AccountEntry {
    pub ops: bool,
    pub url: String,
    pub username: String,
    pub password: String,
    /// 备注（最多 10 个汉字，用于入口分组与顶栏展示）
    pub remark: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct VaultEntry {
    ops: bool,
    url: String,
    username: String,
    /// SM4 加密后的密码（base64）
    enc: String,
    /// 备注（存量数据缺省为空串，故 default）
    #[serde(default)]
    remark: String,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct Vault {
    entries: Vec<VaultEntry>,
}

fn hex_decode_16(s: &str) -> Option<[u8; 16]> {
    let b = s.as_bytes();
    if b.len() != 32 {
        return None;
    }
    let mut out = [0u8; 16];
    for i in 0..16 {
        out[i] = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// 保险库 SM4 密钥：首次随机生成（RandomState 内部用 OS 熵）并落盘
fn vault_key(conn: &rusqlite::Connection) -> Result<[u8; 16], String> {
    if let Some(hex) = db::kv_get(conn, "vault_key") {
        if let Some(k) = hex_decode_16(&hex) {
            return Ok(k);
        }
    }
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut key = [0u8; 16];
    for chunk in key.chunks_mut(8) {
        let h = RandomState::new().build_hasher().finish();
        chunk.copy_from_slice(&h.to_le_bytes()[..chunk.len()]);
    }
    let hex: String = key.iter().map(|b| format!("{:02x}", b)).collect();
    db::kv_set(conn, "vault_key", &hex).map_err(|e| e.to_string())?;
    Ok(key)
}

fn load_vault(conn: &rusqlite::Connection) -> Result<Vault, String> {
    match db::kv_get(conn, "account_vault") {
        Some(json) => serde_json::from_str(&json).map_err(|e| format!("保险库数据损坏: {e}")),
        None => Ok(Vault::default()),
    }
}

fn save_vault(conn: &rusqlite::Connection, v: &Vault) -> Result<(), String> {
    let json = serde_json::to_string(v).map_err(|e| e.to_string())?;
    db::kv_set(conn, "account_vault", &json).map_err(|e| e.to_string())
}

/// 保存（新增或按「项目+网址+账号」覆盖）一条账号组；密码 SM4 加密落盘。
/// 主键为 (ops, url, username)：同一域名同一产品下支持多账号并存，互不覆盖。
#[tauri::command]
pub fn account_save(
    state: State<'_, Arc<AppState>>,
    ops: bool,
    url: String,
    username: String,
    password: String,
    remark: String,
) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if url.is_empty() || username.is_empty() || password.is_empty() {
        return Err("网址、账号、密码均不能为空".into());
    }
    let remark = remark.chars().take(6).collect::<String>();
    let key = {
        let conn = state.db.lock().unwrap();
        vault_key(&conn)?
    };
    let cipher = crate::sm4::encrypt_ecb(&key, password.as_bytes());
    let enc = base64::engine::general_purpose::STANDARD.encode(&cipher);
    let conn = state.db.lock().unwrap();
    let mut vault = load_vault(&conn)?;
    if let Some(e) = vault
        .entries
        .iter_mut()
        .find(|e| e.url == url && e.ops == ops && e.username == username)
    {
        e.enc = enc;
        e.remark = remark;
    } else {
        vault.entries.push(VaultEntry { ops, url, username, enc, remark });
    }
    save_vault(&conn, &vault)
}

/// 列出全部账号组（密码解密后返回明文，仅供登录表单自动填充）
#[tauri::command]
pub fn account_list(state: State<'_, Arc<AppState>>) -> Result<Vec<AccountEntry>, String> {
    let conn = state.db.lock().unwrap();
    let key = vault_key(&conn)?;
    let vault = load_vault(&conn)?;
    Ok(vault
        .entries
        .iter()
        .map(|e| {
            let password = base64::engine::general_purpose::STANDARD
                .decode(&e.enc)
                .ok()
                .and_then(|c| crate::sm4::decrypt_ecb(&key, &c).ok())
                .and_then(|p| String::from_utf8(p).ok())
                .unwrap_or_default();
            AccountEntry {
                ops: e.ops,
                url: e.url.clone(),
                username: e.username.clone(),
                password,
                remark: e.remark.clone(),
            }
        })
        .collect())
}

/// 按「项目+网址+账号」删除一条账号组（与保存主键一致）
#[tauri::command]
pub fn account_delete(
    state: State<'_, Arc<AppState>>,
    ops: bool,
    url: String,
    username: String,
) -> Result<(), String> {
    let url = url.trim().trim_end_matches('/').to_string();
    let conn = state.db.lock().unwrap();
    let mut vault = load_vault(&conn)?;
    vault
        .entries
        .retain(|e| !(e.url == url && e.ops == ops && e.username == username));
    save_vault(&conn, &vault)
}

/// 从保险库取匹配「网址+产品」的账号密码（明文，仅供自动登录/预填）。
/// 多账号场景下优先取当前已登录账号（keyring 中的 bs_username），否则取首个匹配；
/// 找不到或解密失败返回 None，调用方自行兜底。
fn vault_find_creds(state: &Arc<AppState>, base_url: &str, ops: bool) -> Option<(String, String)> {
    let url = base_url.trim().trim_end_matches('/');
    let cur = auth::load_username();
    let conn = state.db.lock().unwrap();
    let key = vault_key(&conn).ok()?;
    let vault = load_vault(&conn).ok()?;
    let e = vault
        .entries
        .iter()
        .find(|e| e.url == url && e.ops == ops && cur.as_deref() == Some(&e.username))
        .or_else(|| vault.entries.iter().find(|e| e.url == url && e.ops == ops))?;
    let pwd = base64::engine::general_purpose::STANDARD
        .decode(&e.enc)
        .ok()
        .and_then(|c| crate::sm4::decrypt_ecb(&key, &c).ok())
        .and_then(|p| String::from_utf8(p).ok())?;
    if pwd.is_empty() {
        return None;
    }
    Some((e.username.clone(), pwd))
}

// ==================== 全屏模式内嵌 Webview 面板（多 webview） ====================
// 全屏模式下主窗为三栏（导航|列表|内嵌标签页），新开 B/S 页面以 tab-N 子
// webview 加载进标签区（生命周期见 tabs.rs）；默认小屏模式下新开页面走独立
// 窗口（open_conversation）。标签区位置由前端按占位 DOM 的 rect 换算物理
// 坐标经 tab_bounds 上报，窗口 resize 时由 tabs::sync_tabs_on_resize 兜底同步。

/// 会话 Cookie 注入（与 open_conversation 一致：WebView2 cookie store，HttpOnly 可设）。
///
/// 关键点：WebView2 的 `AddOrUpdateCookie` 为异步入队，调用立即返回后未必已落库。
/// 若不等待，紧随其后的 `navigate` 请求可能仍不带会话 → B/S 判定未登录、整页重定向到
/// 登录页（即「webview 里全是登录页」的根因之一）。这里轮询确认关键会话 cookie
/// （JSESSIONID）已写入后再返回，保证随后 navigate 的请求一定携带会话。
pub(crate) fn inject_session_cookies<R: Runtime>(webview: &Webview<R>, host: &str) {
    let session = match auth::load_session() {
        Some(s) if !s.is_empty() => s,
        _ => {
            log::warn!("[cookie] 无已保存会话，跳过注入（webview 将处于未登录态）");
            return;
        }
    };
    let probe_url = Url::parse(&format!("https://{host}/"))
        .unwrap_or_else(|_| Url::parse("https://51yunwei.com.cn/").unwrap());
    let mut injected = false;
    for pair in session.split(';') {
        let p = pair.trim();
        if p.is_empty() {
            continue;
        }
        if let Ok(mut c) = Cookie::parse(p) {
            c.set_domain(host.to_string());
            c.set_path("/".to_string());
            c.set_http_only(true);
            let _ = webview.set_cookie(c);
            injected = true;
        }
    }
    if !injected {
        return;
    }
    // 轮询确认 JSESSIONID 已落库（最多约 600ms），随后 navigate 必然带会话
    for _ in 0..20 {
        if let Ok(cookies) = webview.cookies_for_url(probe_url.clone()) {
            if cookies.iter().any(|c| c.name() == "JSESSIONID") {
                log::info!("[cookie] 会话 cookie 已注入 webview（host={host}）");
                return;
            }
        }
        std::thread::sleep(Duration::from_millis(30));
    }
    log::warn!("[cookie] 会话 cookie 注入后未确认落库（host={host}），可能存在会话缺失");
}

pub(crate) fn pane_bounds_of(x: i32, y: i32, w: i32, h: i32) -> Rect {
    Rect {
        position: Position::Physical(PhysicalPosition::new(x, y)),
        size: Size::Physical(PhysicalSize::new(w.max(1) as u32, h.max(1) as u32)),
    }
}


/// 主窗 webview 重新铺满整个窗口客户区。
/// 修复 borderless + 最大化 + 高 DPI（如 1.5×）下 WebView2 控件原点滞后/错位，
/// 导致顶栏(topbar)与左侧导航栏(sidenav)被裁出可视区、只剩内容区可见的问题。
///
/// 必须在窗口尺寸已确定的时机调用（即 on_window_event 的 Resized 回调，携带真实
/// 新尺寸 `size`）。此前曾在 `win.maximize()` 调用瞬间用 `inner_size()` 读取尺寸，
/// 但此时窗口尚未真正变大，读到的是旧尺寸，反而把 webview 缩成小窗、缺失区域加大，
/// 故改为由 Resized 事件传入真实尺寸后再校正。
pub(crate) fn reflow_main_webview(window: &tauri::Window, size: tauri::PhysicalSize<u32>) {
    if let Some(wv) = window.get_webview("main") {
        let _ = wv.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, 0)),
            size: Size::Physical(PhysicalSize::new(size.width.max(1), size.height.max(1))),
        });
    }
}

// ==================== 伪最大化布局（绕开 borderless 原生 maximize 位移 bug） ====================
// 实测（Win32 + 抓屏像素双重取证）：decorations:false + resizable:false 的窗口调用
// 原生 maximize() 后，窗口 rect = 正确的最大化矩形整体位移约 (+163,+163)（正确位置
// 应为 (-11,-11)，边框悬出屏幕外、客户区对齐屏幕 (0,0)）。结果顶栏/侧栏离开屏幕
// 左上角，顶部约 73 CSS px、左侧约 33 CSS px 露出桌面。DOM、webview bounds、CSS
// 全部正常，问题纯在窗口放置。故弃用原生 maximize/minimize，由主进程显式把窗口
// 定位到所在显示器的工作区（物理像素，已排除任务栏）。

/// 小窗落位时距工作区右/下边缘的边距（物理像素）。留足余量避免贴边显得被裁切
pub(crate) const MINI_EDGE_MARGIN: i32 = 56;

/// 进入全屏前的窗口矩形（layout_mini 还原用）
static MINI_RECT: std::sync::Mutex<Option<(i32, i32, u32, u32)>> = std::sync::Mutex::new(None);

/// 窗口中心所在显示器的工作区（物理像素）。收 Window 句柄：
/// 不受 is_webview_window 过滤影响（见 ensure_main_window 注释）
#[cfg(windows)]
pub(crate) fn work_area_of(win: &tauri::Window) -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    let pt = POINT {
        x: pos.x + size.width as i32 / 2,
        y: pos.y + size.height as i32 / 2,
    };
    unsafe {
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi: MONITORINFO = std::mem::zeroed();
        mi.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(hmon, &mut mi) != 0 {
            return Some((mi.rcWork.left, mi.rcWork.top, mi.rcWork.right, mi.rcWork.bottom));
        }
    }
    None
}

/// 跨平台工作区：tauri Monitor::work_area()（物理像素），macOS/Linux 可用
/// （排除 Dock/菜单栏等系统保留区）。Windows 保留上方 Win32 精确版。
#[cfg(not(windows))]
pub(crate) fn work_area_of(win: &tauri::Window) -> Option<(i32, i32, i32, i32)> {
    let m = win.current_monitor().ok().flatten()?;
    let wa = m.work_area();
    let pos = wa.position;
    let size = wa.size;
    Some((
        pos.x,
        pos.y,
        pos.x + size.width as i32,
        pos.y + size.height as i32,
    ))
}

/// 进入全屏（伪最大化）：窗口精确铺满所在显示器工作区，不经过原生 maximize。
/// 注意：全程不做 set_resizable 临时开关——Windows 对可调窗口会附加不可见 resize
/// 边框（约 11px/侧），set_size 后再关掉 resizable 客户区会比请求值大，反复切换
/// 会逐次膨胀导致页面超出屏幕。resizable 常开（tauri.conf.json），直接 set 即可。
#[tauri::command]
pub async fn layout_full(app: AppHandle) -> Result<(), String> {
    let win = ensure_main_window(&app).await?;
    let (l, t, r, b) = work_area_of(&win).ok_or("无法获取显示器工作区")?;
    let wa_w = (r - l).max(1);
    let wa_h = (b - t).max(1);
    // 仅在当前是小窗时记录还原矩形；已处于全屏尺寸时不得覆盖（否则 mini 会还原成全屏）
    if let (Ok(p), Ok(s)) = (win.outer_position(), win.outer_size()) {
        let is_full = (s.width as i32 - wa_w).abs() < 24 && (s.height as i32 - wa_h).abs() < 24;
        if !is_full {
            *MINI_RECT.lock().unwrap() = Some((p.x, p.y, s.width, s.height));
        }
    }
    if win.is_maximized().unwrap_or(false) {
        let _ = win.unmaximize();
    }
    let _ = win.set_position(tauri::PhysicalPosition::new(l, t));
    let _ = win.set_size(tauri::PhysicalSize::new(wa_w as u32, wa_h as u32));
    Ok(())
}

/// 退出全屏：还原进入前的窗口矩形（小屏 = 进入全屏前的弹窗大小，支持手动拖拽后的尺寸）。
/// 无记录（如启动首次 mini）时恢复默认弹窗尺寸并落到屏幕右下角（工作区，避开任务栏）。
#[tauri::command]
pub async fn layout_mini(app: AppHandle) -> Result<(), String> {
    let win = ensure_main_window(&app).await?;
    let rect = *MINI_RECT.lock().unwrap();
    match rect {
        Some((x, y, w, h)) => {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            let _ = win.set_size(tauri::PhysicalSize::new(w.max(1), h.max(1)));
        }
        None => {
            // 无记录（如首次直接 mini）：恢复默认弹窗尺寸并落到屏幕右下角
            let sf = win.scale_factor().unwrap_or(1.0);
            let w = (475.0 * sf).round() as i32; // 432 × 1.1 ≈ 475（2026-10-15 小窗加宽 10%）
            let h = (640.0 * sf).round() as i32;
            if let Some((l, t, r, b)) = work_area_of(&win) {
                let x = (r - w - MINI_EDGE_MARGIN).max(l);
                let y = (b - h - MINI_EDGE_MARGIN).max(t);
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                let _ = win.set_size(tauri::PhysicalSize::new(w.max(1) as u32, h.max(1) as u32));
            } else {
                let _ = win.unmaximize();
            }
        }
    }
    Ok(())
}

/// [临时诊断] 读主窗与主 webview 的物理几何，用于确认 topbar/sidenav 缺失是否已归位
#[tauri::command]
pub fn debug_webview_rect(app: AppHandle) -> Result<String, String> {
    let mut out = String::new();
    if let Some(win) = app.get_window("main") {
        if let Ok(s) = win.inner_size() {
            out.push_str(&format!("win_inner={}x{};", s.width, s.height));
        }
        if let Some(wv) = win.get_webview("main") {
            if let Ok(b) = wv.bounds() {
                match (b.position, b.size) {
                    (Position::Physical(p), Size::Physical(sz)) => {
                        out.push_str(&format!("wv_pos={},{};wv_size={}x{}", p.x, p.y, sz.width, sz.height));
                    }
                    _ => out.push_str("wv_bounds:non-physical;"),
                }
            } else {
                out.push_str("wv_bounds:err;");
            }
        } else {
            out.push_str("wv:none;");
        }
    } else {
        out.push_str("win:none;");
    }
    Ok(out)
}

// ==================== 临时诊断（布局偏移排查，确认后可删除） ====================
/// 前端把关键 DOM / 视口几何写到临时文件，便于在无 CDP 环境下定位 topbar/sidenav 缺失根因。
#[tauri::command]
pub fn debug_dump(_app: AppHandle, tag: String, payload: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join("aif_layout.txt");
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = writeln!(f, "[{ts}][{tag}] {payload}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = (_app, tag, payload);
    Ok(())
}

/// [临时诊断] 前端 invoke 探针：每条命令的 start/ok/err 落日志，
/// 用于定位「列表骨架屏永不结束」的挂起命令。确认根因后删除。
#[tauri::command]
pub fn trace_invoke(cmd: String, phase: String) {
    log::info!("[ipc] {cmd} {phase}");
}

// ==================== P1：消息稍后提醒 + 迷你速览条 ====================

/// 稍后提醒触发：前端本地定时器到期时调用，重发一条系统通知
/// （登记 notify_urls 供点击反查跳转，链路与轮询通知完全一致）。
/// async：同步命令在主线程执行，通知插件调用不在主线程做，规避派发类挂起。
#[tauri::command]
pub async fn fire_snooze(app: AppHandle, title: String, body: String, url: String) {
    crate::poller::show_notification(&app, &title, &body, &url);
    // 前端兜底：系统 toast 可能被 Windows 勿扰/通知设置吞掉，应用内 toast 保底可见
    let _ = app.emit("snooze-fired", format!("{title}：{body}"));
}

/// 迷你速览条：屏幕右缘常置小窗（无边框 / 置顶 / 不进任务栏 / 不抢焦点）。
/// enable=true 创建（已存在则忽略）；false 关闭。数据与交互见 mini.html / src/mini.ts：
/// 未读数读共享 localStorage，待办数 invoke get_todos，点击 emit mini-navigate 交主窗处理。
/// 【必须 async】铁律（10-11 白屏死锁 / 10-13 tabOpen 卡死同族根因）：
/// 同步命令在主线程执行，WebviewWindowBuilder::build() 内部向主线程派发任务并
/// 阻塞等待 → 主线程被本命令占用无法泵消息 → 自死锁。async 命令跑在 async
/// runtime，主线程空闲可处理派发，与 login_webview / open_conversation 同模式。
/// 速览条鼠标穿透状态：JS 侧卡片显隐时同步（set_mini_card_visible），
/// 轮询线程据此决定可交互范围（卡片可见=整窗 / 隐藏=仅条身）。
static MINI_CARD_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MINI_POLLER_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static MINI_LAST_IGNORE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// JS 侧同步预览卡可见状态（showCard=true / hideCard·dismissCard=false）
#[tauri::command]
pub fn set_mini_card_visible(visible: bool) {
    MINI_CARD_SHOWN.store(visible, std::sync::atomic::Ordering::SeqCst);
}

/// 启动光标位置轮询（150ms）：动态切换 mini-bar 的鼠标穿透。
/// 根因：340×340 透明容器虽然视觉透明，OS 命中测试仍整块拦截，
/// 遮挡下层窗口的点击。空闲时整窗 set_ignore_cursor_events(true) 全穿透，
/// 光标进入条身（右缘 40 逻辑px 竖条）或卡片可见时恢复交互。
/// 线程随窗口关闭自然退出（get_webview_window 返回 None 即 break）。
fn spawn_mini_hit_test_poller(app: AppHandle) {
    use std::sync::atomic::Ordering;
    if MINI_POLLER_RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已在运行
    }
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(150));
            let Some(win) = app.get_webview_window("mini-bar") else {
                break; // 窗口已关闭
            };
            if !win.is_visible().unwrap_or(false) {
                continue;
            }
            let (Ok(cur), Ok(pos), Ok(size)) = (
                app.cursor_position(),
                win.outer_position(),
                win.outer_size(),
            ) else {
                continue;
            };
            let scale = win.scale_factor().unwrap_or(1.0);
            let left = pos.x as f64;
            let top = pos.y as f64;
            let right = left + size.width as f64;
            let bottom = top + size.height as f64;
            let inside = if MINI_CARD_SHOWN.load(Ordering::SeqCst) {
                // 卡片可见：整窗可交互（条身 + 卡片 + 8px 间隙）
                cur.x >= left && cur.x <= right && cur.y >= top && cur.y <= bottom
            } else {
                // 卡片隐藏：仅条身竖条可交互，其余透明区全部穿透
                let bar_left = right - 40.0 * scale;
                cur.x >= bar_left && cur.x <= right && cur.y >= top && cur.y <= bottom
            };
            let want_ignore = !inside;
            if MINI_LAST_IGNORE.swap(want_ignore, Ordering::SeqCst) != want_ignore {
                let _ = win.set_ignore_cursor_events(want_ignore);
                log::info!("[mini-bar] 命中测试切换: ignore={want_ignore}");
            }
        }
        MINI_POLLER_RUNNING.store(false, Ordering::SeqCst);
    });
}

#[tauri::command]
pub async fn toggle_mini_bar(app: AppHandle, enable: bool) -> Result<(), String> {
    // macOS 不提供速览条：tao 未实现 skip_taskbar，透明窗口会进 Mission Control /
    // 程序坞切换器，生态不符；设置页已隐藏开关，此处兜底 no-op。
    #[cfg(target_os = "macos")]
    {
        let _ = (&app, enable);
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let existing = app.get_webview_window("mini-bar");
    if !enable {
        if let Some(w) = existing {
            let _ = w.close();
        }
        return Ok(());
    }
    if existing.is_some() {
        return Ok(());
    }
    // 主屏右缘、垂直居中（逻辑坐标 = 物理像素 / 缩放比）。
    // 窗口 340×400 透明容器：可见条（40×auto，含面板/消息/待办/快捷/应用/助手/关闭
    // 七钮，内容高约 358 逻辑px）absolute 贴右缘，悬停预览卡向左展开；
    // 宽 340 > Windows 无边框窗口最小宽限制（~134），不会被系统放宽。
    let monitor = app.primary_monitor().ok().flatten();
    let (x, y) = match &monitor {
        Some(m) => {
            let scale = m.scale_factor();
            let w = m.size().width as f64 / scale;
            let h = m.size().height as f64 / scale;
            (w - 8.0 - 340.0, ((h - 400.0) / 2.0).max(8.0))
        }
        None => (0.0, 0.0),
    };
    tauri::WebviewWindowBuilder::new(&app, "mini-bar", WebviewUrl::App("mini.html".into()))
        .title("速览条")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .shadow(false)
        // 透明窗口：圆角外/卡片未展开区域完全透明
        .transparent(true)
        .inner_size(340.0, 400.0)
        .position(x, y)
        .build()
        .map_err(|e| format!("创建速览条失败: {e}"))?;

    // 创建后按实际窗口宽重定位：可见条贴窗口右缘（CSS right:0），令其右缘距屏幕右缘 8px
    if let Some(win) = app.get_webview_window("mini-bar") {
        let scale = win.scale_factor().unwrap_or(1.0);
        let win_w = win
            .inner_size()
            .map(|s| s.width as f64 / scale)
            .unwrap_or(340.0);
        log::info!("[mini-bar] 实际窗口 {win_w}×{} 逻辑像素（scale={scale}）",
            win.inner_size().map(|s| s.height as f64 / scale).unwrap_or(340.0));
        if let Some(m) = &monitor {
            let scale = m.scale_factor();
            let sw = m.size().width as f64 / scale;
            let sh = m.size().height as f64 / scale;
            let px = sw - 8.0 - win_w;
            let py = ((sh - 400.0) / 2.0).max(8.0);
            let _ = win.set_position(tauri::LogicalPosition::new(px, py));
        }
        // 初始整窗穿透：透明容器不拦截下层窗口点击；光标进入条身后由轮询恢复交互
        let _ = win.set_ignore_cursor_events(true);
    }
    // 启动光标轮询，按需在「穿透 ↔ 可交互」间切换
    spawn_mini_hit_test_poller(app);
        Ok(())
    }
}
