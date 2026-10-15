use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{ActionPerformed, NotificationExt};

use crate::auth;
use crate::db;
use crate::state::AppState;

#[derive(Clone, Serialize)]
pub struct NewMessage {
    pub id: String,
    pub title: String,
    pub body: String,
    pub url: String,
    /// 消息来源：system / personal（托盘聚合分组用）
    pub kind: String,
    /// 是否静音（勿扰时段/命中静音关键词）：true 时不弹系统通知、不响铃、不闪托盘
    pub muted: bool,
}

/// 轮询结果状态（顶栏状态点：绿=正常 / 红=异常）
#[derive(Clone, Serialize)]
pub struct PollStatus {
    pub ok: bool,
    /// 本轮轮询完成的 Unix 秒级时间戳
    pub ts: i64,
}

/// 轮询请求总超时（每请求）：心跳/消息/待办均为小 JSON，20s 绰绰有余；
/// 超时即本轮失败 → 状态点变红 / 触发重登录自愈，绝不会挂住循环
const POLL_REQ_TIMEOUT: Duration = Duration::from_secs(20);

/// 启动后台轮询。窗口隐藏也照常运行（在 Rust 异步运行时里）。
pub fn start(state: Arc<AppState>, app: AppHandle) {
    // 通知点击跳转：Windows 上 toast 在屏期内点击会上报 tap（携带通知标题）。
    // 按标题反查消息 URL（文档空间消息已由 append_article_param 带上
    // articleShowMessageBox=true）→ 置前主窗口并 emit 交前端 openUrl 打开。
    // 必须在首条通知发出前注册（先前已显示的通知不上报）。
    {
        let state = state.clone();
        let app = app.clone();
        // app.clone()：on_action 借用 &Notification 注册完即释放，闭包则拿走 AppHandle 所有权
        let _ = app.clone().notification().on_action(move |performed: &ActionPerformed| {
            if performed.action_id() != "tap" {
                return;
            }
            let title = performed
                .notification()
                .and_then(|n| n.title().map(|s| s.to_string()));
            let url = {
                let mut q = state.notify_urls.lock().unwrap();
                let idx = title
                    .as_deref()
                    .and_then(|t| q.iter().rposition(|(tt, _)| tt == t));
                match idx {
                    Some(i) => q.remove(i).unwrap().1,
                    None => return,
                }
            };
            if url.is_empty() {
                // 无跳转 URL 的通知（如每日摘要）：点击只唤起主面板
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                return;
            }
            if let Some(w) = app.get_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            let _ = app.emit("open-message-url", url);
        });
    }
    tauri::async_runtime::spawn(async move {
        loop {
            let interval = state.settings.lock().unwrap().poll_interval_secs;
            tokio::time::sleep(Duration::from_secs(interval.max(5))).await;
            poll_once(&state, &app).await;
        }
    });
}

/// 立即轮询一次（供托盘「立即检查」/ 前端按钮调用）
pub async fn poll_once(state: &Arc<AppState>, app: &AppHandle) {
    let session = match auth::load_session() {
        Some(s) if !s.is_empty() => s,
        _ => return, // 未登录则跳过
    };

    let (base, root, api_messages, api_todos) = {
        let s = state.settings.lock().unwrap();
        let root = s.app_root().to_string();
        (
            s.base_url.trim_end_matches('/').to_string(),
            root.clone(),
            s.resolve_path(&s.api_messages.clone()),
            s.resolve_path(&s.api_todos.clone()),
        )
    };

    // 1) 保活：keepAlive 照常打一拍维持会话在线状态（响应忽略）。
    //    消息通知不再依赖它的 m 队列 —— 该队列是消费型的，客户端 webview 内嵌的
    //    B/S 页面（多标签页/会话窗/浏览器里开着的 B/S）跑着同一会话自己的心跳，
    //    会把待推送消息抢先消费掉，导致轮询拿到空 m 而漏提醒。
    keepalive_ping(&state, &base, &api_messages, &session).await;
    // 2) 通知源：历史消息接口第一页（与消息页同源、按页返回不消费，无被抢问题）
    let msg_res = fetch_history_messages(&state, &base, &root, &session).await;
    let todo_res = fetch_todos(&state, &base, &root, &api_todos, &session).await;
    let msg_ok = msg_res.is_ok();
    let todo_ok = todo_res.is_ok();

    if let Ok(new) = msg_res {
        // 通知规则快照：勿扰时段 / 静音关键词（Settings 为纯数据，clone 开销可忽略）
        let settings_snap = state.settings.lock().unwrap().clone();
        let fetched = new.len();
        let mut new_list: Vec<NewMessage> = Vec::new();
        {
            let conn = state.db.lock().unwrap();
            // 通知源切换基线：首次用历史接口拉取时，已有历史消息只入库不打扰
            //（否则升级后第一轮会把最近几十条历史全部弹一遍）
            let baseline = db::kv_get(&conn, "notify_source_v2").is_none();
            for m in new {
                if let Ok(true) = db::insert_message(&conn, &m.id, &m.title, &m.body, &m.url) {
                    // 入库即留痕：这次新增链路（轮询→入库→事件/通知）此前完全无日志，
                    // 「消息收到了但没弹窗/角标没动」类问题无从排查
                    log::info!("[poll] 新消息入库：{} | {}", m.title, m.body.chars().take(40).collect::<String>());
                    if !baseline {
                        let muted = settings_snap.in_dnd_window(local_hm())
                            || settings_snap.hit_mute_keyword(&m.title, &m.body);
                        new_list.push(NewMessage {
                            id: m.id,
                            title: m.title,
                            body: m.body,
                            url: m.url,
                            kind: m.kind,
                            muted,
                        });
                    }
                }
            }
            if baseline {
                let _ = db::kv_set(&conn, "notify_source_v2", "1");
            }
        }
        log::info!(
            "[poll] 本轮消息：拉取 {fetched} 条，新增 {}（静音 {}）",
            new_list.len(),
            new_list.iter().filter(|m| m.muted).count()
        );
        // 系统通知（含同批聚合、静音过滤）；前端事件逐条发（角标逐条累加）
        notify_grouped(app, &new_list);
        for m in &new_list {
            let _ = app.emit("new-message", m.clone());
        }
        if !new_list.is_empty() {
            if new_list.iter().any(|m| !m.muted) {
                // 新消息托盘闪烁：持续闪到用户在应用内点击任意消息（tray_flash_stop）
                crate::tray::flash(app);
            }
            let _ = app.emit("messages-updated", ());
        }
    }

    // 2) 拉待办（以服务端为准覆盖本地）
    if let Ok(todos) = todo_res {
        {
            let mut conn = state.db.lock().unwrap();
            let _ = db::upsert_todos(&mut conn, &todos);
        }
        // 待办超时升级提醒（todo_escalate_days=0 关闭）：事项在本地可见超过 N 天
        // 仍未办结 → 每个事项升级提醒一次（escalated 标记防重复）
        let escalate_days = state.settings.lock().unwrap().todo_escalate_days;
        if escalate_days > 0 {
            let now = now_secs();
            let overdue = {
                let conn = state.db.lock().unwrap();
                db::detect_overdue_todos(&conn, &todos, escalate_days, now).unwrap_or_default()
            };
            for t in &overdue {
                let t_title: String = t.title.chars().take(16).collect();
                show_notification(
                    app,
                    &format!("待办超时：{t_title}"),
                    &format!("该事项已超过 {escalate_days} 天未处理，请及时办理"),
                    &t.url,
                );
            }
            if !overdue.is_empty() {
                crate::tray::flash_brief(app);
            }
        }
        // 托盘「待办速览」菜单：待办集合变化时才重建（签名比对去重）
        let sig: String = todos
            .iter()
            .map(|t| format!("{}|{}|{}", t.id, t.done as u8, t.title))
            .collect::<Vec<_>>()
            .join(";");
        {
            let conn = state.db.lock().unwrap();
            if db::kv_get(&conn, "tray_todos_sig").as_deref() != Some(sig.as_str()) {
                let _ = db::kv_set(&conn, "tray_todos_sig", &sig);
                drop(conn);
                crate::tray::refresh_menu(app);
            }
        }
        let _ = app.emit("todos-updated", ());
    }

    // 5) 每日定时摘要：到达设定时间（触发窗口内且当天未发过）推送待办/消息汇总
    check_daily_digest(state, app);

    // 3) 顶栏状态点：全部失败（会话过期/网络断开）才标记异常
    let _ = app.emit(
        "poll-status",
        PollStatus { ok: msg_ok || todo_ok, ts: now_secs() },
    );

    // 4) 双双失败 → 疑似会话失效/网络断开：节流后用保险库凭据静默重登录自愈
    if !msg_ok && !todo_ok {
        maybe_relogin(state, app).await;
    }
}

// ---------------- 心跳失败自愈（会话失效自动重登录） ----------------
// 节流策略（进程内状态）：距上次尝试 5 分钟内不重试；连续失败按 5min×2^n 退避（封顶 60min）；
// 「无法自动登录」（无凭据/需图形验证码）直接拉满退避并通知前端提醒人工登录。
static RELOGIN_LAST: AtomicI64 = AtomicI64::new(0);
static RELOGIN_STREAK: AtomicU32 = AtomicU32::new(0);

async fn maybe_relogin(state: &Arc<AppState>, app: &AppHandle) {
    let now = now_secs();
    let streak = RELOGIN_STREAK.load(Ordering::Relaxed);
    let last = RELOGIN_LAST.load(Ordering::Relaxed);
    let wait: i64 = if streak == 0 {
        300
    } else {
        (300i64 << (streak - 1).min(4)).min(3600)
    };
    if now - last < wait {
        return;
    }
    RELOGIN_LAST.store(now, Ordering::Relaxed);
    match crate::commands::silent_login(state, app).await {
        Ok(true) => {
            RELOGIN_STREAK.store(0, Ordering::Relaxed);
            log::info!("[poll] 心跳失败为会话失效，已自动重登录（logged-in 事件触发前端刷新）");
        }
        Ok(false) => {
            // 无保存凭据或需要图形验证码：自动登录走不通，拉长退避并提醒人工登录
            RELOGIN_STREAK.store(5, Ordering::Relaxed);
            let _ = app.emit(
                "relogin-failed",
                "会话已失效且无法自动登录：未保存常用入口凭据或需要图形验证码，请手动登录",
            );
        }
        Err(e) => {
            let n = RELOGIN_STREAK.fetch_add(1, Ordering::Relaxed) + 1;
            log::warn!("[poll] 自动重登录失败（连续第 {n} 次）：{e}");
            if n == 1 {
                let _ = app.emit("relogin-failed", format!("会话已失效且自动登录失败：{e}"));
            }
        }
    }
}

/// 会话保活：照常打 keepAlive 心跳（维持服务端在线状态），响应忽略。
/// 消息通知已改走历史接口（fetch_history_messages），不再依赖心跳携带的
/// m 队列 —— 该队列消费型，会被内嵌 B/S 页面自身的心跳抢先消费导致漏提醒。
async fn keepalive_ping(state: &Arc<AppState>, base: &str, path: &str, session: &str) {
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    let _ = state
        .client
        .get(&url)
        .header("Cookie", session)
        // 请求级总超时：防连接挂起卡死轮询循环（client 级只有 connect_timeout）
        .timeout(POLL_REQ_TIMEOUT)
        .send()
        .await;
}

/// 通知源：B/S 历史消息接口（POST {base}/{root}/getMessageList，curl 实证，
/// 字段说明见 commands.rs get_message_history）。取 system/personal 两来源第一页
/// （最新在前），去重交给 messages 表主键。
/// 每条字段：t=来源系统名, c=内容, mc=模块码, s=system|personal,
///   st=时间"yyyy-MM-dd HH:mm:ss", pcUrl=PC 跳转链接, si.userName=发送人
async fn fetch_history_messages(
    state: &Arc<AppState>,
    base: &str,
    root: &str,
    session: &str,
) -> anyhow::Result<Vec<RawItem>> {
    let url = format!("{}/{}/getMessageList", base.trim_end_matches('/'), root);
    let mut items = Vec::new();
    for source in ["system", "personal"] {
        let resp = state
            .client
            .post(&url)
            .header("Cookie", session)
            .timeout(POLL_REQ_TIMEOUT)
            .form(&[
                ("source", source),
                ("key", ""),
                ("pageIndex", "0"),
                ("pageSize", "20"),
            ])
            .send()
            .await?
            .error_for_status()?;
        let json: serde_json::Value = resp.json().await?;
        let arr = json
            .get("data")
            .and_then(|d| d.as_array())
            .cloned()
            .unwrap_or_default();
        for o in &arr {
            let g = |k: &str| {
                o.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
            };
            let s = g("s");
            let st = g("st");
            let content = g("c");
            let sender = o
                .get("si")
                .and_then(|si| si.get("userName"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if content.is_empty() {
                continue;
            }
            // 稳定去重键：来源|发送时间(秒)|内容|发送人 —— 不用服务端 id 字段
            //（其字段名/取值不稳定，见 commands.rs 注释），内容键跨轮询恒定
            let id = format!(
                "{:016x}",
                fnv1a(&format!("hist|{}|{}|{}|{}", s, st, content, sender))
            );
            // 标题：来源系统名 → 发送人 → 「系统消息/个人消息：内容前 20 字」
            let mut title = g("t");
            if title.is_empty() {
                title = sender.clone();
            }
            if title.is_empty() {
                let label = if s == "personal" { "个人消息" } else { "系统消息" };
                title = format!(
                    "{}：{}",
                    label,
                    content.chars().take(20).collect::<String>()
                );
            }
            let url =
                append_article_param(&g("mc"), absolute_url(base, root, &g("pcUrl")));
            items.push(RawItem { id, kind: s, title, body: content, url });
        }
    }
    Ok(items)
}

async fn fetch_todos(
    state: &Arc<AppState>,
    base: &str,
    root: &str,
    path: &str,
    session: &str,
) -> anyhow::Result<Vec<db::TodoRow>> {
    let url = format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'));
    let resp = state
        .client
        .get(&url)
        .header("Cookie", session)
        .timeout(POLL_REQ_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let json: serde_json::Value = resp.json().await?;
    Ok(extract_todos(&json, base, root))
}

/// 「文档空间」类消息（模块码含 KNOWLEDGE_ 或为 SPACE_COMMENT，对齐前端 msgTypeOf）
/// 打开页面时追加 articleShowMessageBox=true（B/S 端据此弹出文档展示框）。
/// 已带该参数或空 URL 原样返回。
pub(crate) fn append_article_param(mc: &str, url: String) -> String {
    let m = mc.to_uppercase();
    if url.is_empty() || !(m.contains("KNOWLEDGE_") || m == "SPACE_COMMENT") {
        return url;
    }
    let sep = if url.contains('?') { "&" } else { "?" };
    format!("{url}{sep}articleShowMessageBox=true")
}

#[derive(Clone)]
struct RawItem {
    id: String,
    /// 消息来源：system / personal（聚合分组用）
    kind: String,
    title: String,
    body: String,
    url: String,
}

/// 解析「我收到的事项」：[{"bid":业务id,"bname":事项名,"todo":待办数,"todo_pc_url":跳转,...}]
/// 只保留有待办（todo>0）的项作为待办面板条目。
fn extract_todos(v: &serde_json::Value, base: &str, root: &str) -> Vec<db::TodoRow> {
    let arr = v.as_array().cloned().unwrap_or_default();
    arr.iter()
        .map(|o| {
            let todo_count = o.get("todo").and_then(|x| x.as_i64()).unwrap_or(0);
            let url_raw = pick(o, &["todo_pc_url"]);
            let url = if url_raw == "NO" { String::new() } else { absolute_url(base, root, &url_raw) };
            db::TodoRow {
                id: pick(o, &["bid"]),
                title: pick(o, &["bname"]),
                url,
                done: todo_count == 0,
                count: todo_count.max(1), // 服务端 todo 字段；兜底至少 1
                updated_at: now_secs(),
            }
        })
        .filter(|t| !t.id.is_empty() && !t.done)
        .collect()
}

/// 相对路径拼接为绝对 URL（产品根随配置 AIF/DCP）：
///   完整 http(s) 链接 → 原样返回
///   以 / 开头        → {base}{path}
///   其他相对路径     → {base}/{root}/{path}（B/S 页面内相对链接相对产品根解析）
pub(crate) fn absolute_url(base: &str, root: &str, u: &str) -> String {
    if u.is_empty() || u.starts_with("http://") || u.starts_with("https://") {
        u.to_string()
    } else if u.starts_with('/') {
        format!("{}{}", base.trim_end_matches('/'), u)
    } else {
        format!("{}/{}/{}", base.trim_end_matches('/'), root, u)
    }
}

/// FNV-1a 64bit：无需额外依赖的稳定哈希（生成消息去重 id）。pub(crate)：commands::get_message_history 复用，保证两处 id 一致
pub(crate) fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

fn pick(o: &serde_json::Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = o.get(k).and_then(|x| x.as_str()) {
            return s.to_string();
        }
    }
    // 兼容数字型 id
    for k in keys {
        if let Some(n) = o.get(k).and_then(|x| x.as_i64()) {
            return n.to_string();
        }
    }
    String::new()
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 本地时区的当前时/分（勿扰时段判断用）
fn local_hm() -> (u32, u32) {
    use chrono::Timelike;
    let n = chrono::Local::now();
    (n.hour(), n.minute())
}

fn kind_label(kind: &str) -> &'static str {
    match kind {
        "system" => "系统消息",
        "personal" => "个人消息",
        _ => "消息",
    }
}

/// 桌面通知发送（含静音过滤与同批聚合）：
/// - 静音（勿扰时段/关键词命中）消息不弹系统通知，前端也据此不响铃不弹 toast；
/// - 同一来源（system/personal）同批新增 ≥3 条时合并为一条「{来源} ×N」，
///   避免 Windows 横幅轰炸（横幅同时最多 3 个，其余只进通知中心）；
/// - 合并通知点击跳转取该组最新一条的 URL（notify_urls 按标题登记）。
fn notify_grouped(app: &AppHandle, items: &[NewMessage]) {
    let mut groups: Vec<(String, Vec<&NewMessage>)> = Vec::new();
    for m in items.iter().filter(|m| !m.muted) {
        if let Some(g) = groups.iter_mut().find(|(k, _)| *k == m.kind) {
            g.1.push(m);
        } else {
            groups.push((m.kind.clone(), vec![m]));
        }
    }
    for (kind, group) in groups {
        if group.len() >= 3 {
            // 历史接口第一页最新在前，group[0] 即该组最新一条
            let latest = group[0];
            let title = format!("{} ×{}", kind_label(&kind), group.len());
            let body: String = latest.body.chars().take(80).collect();
            show_notification(app, &title, &body, &latest.url);
        } else {
            for m in group {
                show_notification(app, &m.title, &m.body, &m.url);
            }
        }
    }
}

// ---------------- 每日定时摘要 ----------------
// 每天到达设定时间后推送一条汇总：未办结待办 N 件 + 今日新消息 M 条。
// 触发窗口 = 设定时刻起至当天结束（程序在常规 60 分钟窗口内未运行时，当天启动/轮询后自动补发，
// 标题带「（补发）」；当天只发一次，kv digest_last_date 记日期）。
// 无跳转 URL，点击通知只唤起主面板（on_action 对空 URL 的处理）。
fn check_daily_digest(state: &Arc<AppState>, app: &AppHandle) {
    let settings = state.settings.lock().unwrap().clone();
    if !settings.daily_digest_enabled {
        return;
    }
    // 复用勿扰时段的时间解析规则（HH:MM）
    let parse = |s: &str| -> Option<(u32, u32)> {
        let (h, m) = s.trim().split_once(':')?;
        let h: u32 = h.trim().parse().ok()?;
        let m: u32 = m.trim().parse().ok()?;
        if h > 23 || m > 59 {
            return None;
        }
        Some((h, m))
    };
    let Some((hh, mm)) = parse(&settings.daily_digest_time) else {
        return;
    };
    let (now_h, now_m) = local_hm();
    let now_min = now_h * 60 + now_m;
    let target = hh * 60 + mm;
    // 触发窗口：到达目标时刻后当天任意时间（错过常规窗口 → 补发；当天 0 点前都允许）
    if now_min < target {
        return;
    }
    let late = now_min >= target + 60; // 超过常规 60 分钟窗口 → 标记补发
    let n = chrono::Local::now();
    let today = n.format("%Y-%m-%d").to_string();
    // 本地时区当日 0 点的 Unix 秒（今日新消息统计起点）
    let day0 = n
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|t| t.and_local_timezone(chrono::Local).single())
        .map(|t| t.timestamp())
        .unwrap_or(0);
    let (todo_cnt, msg_cnt, already) = {
        let conn = state.db.lock().unwrap();
        let already = db::kv_get(&conn, "digest_last_date").as_deref() == Some(today.as_str());
        let todo_cnt: i64 = conn
            .query_row("SELECT COUNT(1) FROM todos WHERE done=0", [], |r| r.get(0))
            .unwrap_or(0);
        let msg_cnt: i64 = conn
            .query_row(
                "SELECT COUNT(1) FROM messages WHERE received_at >= ?1",
                [day0],
                |r| r.get(0),
            )
            .unwrap_or(0);
        (todo_cnt, msg_cnt, already)
    };
    if already {
        return;
    }
    {
        let conn = state.db.lock().unwrap();
        let _ = db::kv_set(&conn, "digest_last_date", &today);
    }
    log::info!(
        "[poll] 每日摘要{}：待办 {todo_cnt} 件，今日新消息 {msg_cnt} 条",
        if late { "（补发）" } else { "" }
    );
    show_notification(
        app,
        if late { "每日摘要（补发）" } else { "每日摘要" },
        &format!("待办 {todo_cnt} 件未办结，今日新消息 {msg_cnt} 条"),
        "",
    );
    // 前端兜底：系统 toast 若被 Windows 勿扰/通知设置吞掉，应用内 toast + 托盘闪烁保底可见
    let _ = app.emit(
        "daily-digest",
        format!("每日摘要：待办 {todo_cnt} 件未办结，今日新消息 {msg_cnt} 条"),
    );
    crate::tray::flash_brief(app);
}

/// 桌面通知发送（登记 notify_urls 供点击反查）。
///
/// Windows 直发 WinRT toast（AUMID = 应用标识符）：
/// tauri-plugin-notification 在 dev（target\debug|release）下**不设置 AUMID**
///（其 desktop.rs:492 判定），notify-rust 落到 PowerShell AUMID 通道——
/// 本机实测该通道 toast 静默丢失（2026-10-13 起通知中心再无记录，而安装版 AUMID 通道已实证可达）。
/// 直发让 dev 与安装版行为一致；失败时回退插件路径兜底并留痕。
/// pub(crate)：commands::fire_snooze 复用。
pub(crate) fn show_notification(app: &AppHandle, title: &str, body: &str, url: &str) {
    // 登记标题→URL 供通知点击（tap）反查；FIFO 上限 20，防止常驻膨胀。
    // 注意类型必须是 Arc<AppState>：lib.rs manage 的就是这个类型，
    // 写 state::<AppState>() 会因 TypeId 不匹配 panic（state() called before manage()），
    // 且本函数在轮询任务内被同步调用 → panic 会带走整个轮询循环。
    {
        let st = app.state::<Arc<AppState>>();
        let mut q = st.notify_urls.lock().unwrap();
        if q.len() >= 20 {
            q.pop_front();
        }
        q.push_back((title.to_string(), url.to_string()));
    }
    #[cfg(windows)]
    {
        let aumid = app.config().identifier.clone();
        let app_t = app.clone();
        let title_t = title.to_string();
        let body_t = body.to_string();
        // 通知发送隔离到独立一次性线程（fail-isolated）：
        // 2026-10-15 实证：在 tokio worker 线程直发 WinRT toast，该调用挂死/异常会把
        // poll_once 连同整个轮询循环一起带走（症状：入库日志后 [notify] 永不打印，
        // 闪/响/emit 全无，后续轮询停止）。独立线程保证最坏只损失这一条通知。
        // 线程内先 CoInitializeEx(MTA)：tokio 线程未初始化 COM，WinRT 激活依赖它。
        let spawned = std::thread::Builder::new().name("toast-send".into()).spawn(move || {
            unsafe {
                // 0x0=COINIT_MULTITHREADED；S_FALSE(已初始化)/RPC_E_CHANGED_MODE(模式冲突) 均忽略
                windows_sys::Win32::System::Com::CoInitializeEx(
                    std::ptr::null(),
                    windows_sys::Win32::System::Com::COINIT_MULTITHREADED as u32,
                );
            }
            log::info!("[notify] toast 线程就绪，开始发送：{title_t}");
            let app_click = app_t.clone();
            let title_click = title_t.clone();
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                tauri_winrt_notification::Toast::new(&aumid)
                    .title(&title_t)
                    .text2(&body_t)
                    .on_activated(move |_| {
                        // 点击 toast：按标题反查 URL → 置前主窗并跳转（与插件 on_action tap 同语义）
                        let url = {
                            let st = app_click.state::<Arc<AppState>>();
                            let mut q = st.notify_urls.lock().unwrap();
                            match q.iter().rposition(|(t, _)| *t == title_click) {
                                Some(i) => q.remove(i).unwrap().1,
                                None => String::new(),
                            }
                        };
                        if let Some(w) = app_click.get_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                        if !url.is_empty() {
                            let _ = app_click.emit("open-message-url", url);
                        }
                        Ok(())
                    })
                    .show()
            }));
            match r {
                Ok(Ok(())) => log::info!("[notify] WinRT toast 已发送：{title_t}"),
                Ok(Err(e)) => {
                    // AUMID 未解析/通知服务异常等：留痕后走插件路径兜底
                    log::warn!("[notify] WinRT toast 直发失败（AUMID={aumid}）：{title_t} | {e}");
                    fallback_notify(&app_t, &title_t, &body_t);
                }
                Err(_) => {
                    log::warn!("[notify] WinRT toast 发送过程 panic：{title_t}");
                    fallback_notify(&app_t, &title_t, &body_t);
                }
            }
        });
        if spawned.is_err() {
            log::warn!("[notify] toast 发送线程创建失败，走插件兜底：{title}");
            fallback_notify(app, title, body);
        }
    }
    #[cfg(not(windows))]
    fallback_notify(app, title, body);
    // 提示音：弹窗 + 声音（Windows 用 MessageBeep 播系统「星号」提示音，立即返回不阻塞）
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Diagnostics::Debug::MessageBeep(0x0000_0040); // MB_ICONASTERISK
    }
}

/// 插件路径兜底（非 Windows / WinRT 直发失败时走这里）
#[cfg_attr(windows, allow(dead_code))]
fn fallback_notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        // 系统通知发送失败（如 AUMID 未注册/通知服务异常）必须留痕，否则表现为「静默无弹窗」
        log::warn!("[notify] 系统通知发送失败：{title} | {e}");
    }
}
