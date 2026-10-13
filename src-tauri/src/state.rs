use std::collections::VecDeque;
use std::sync::Mutex;

use reqwest::Client;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::tabs::TabState;

/// 客户端可配置项（设置页可视化编辑）
#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    /// B/S 服务器地址（含端口，不含 /AIF），如 https://51yunwei.com.cn
    pub base_url: String,
    /// 拉取消息的接口路径（相对 base_url）
    pub api_messages: String,
    /// 拉取待办的接口路径（相对 base_url）
    pub api_todos: String,
    /// 轮询间隔（秒）
    pub poll_interval_secs: u64,
    /// 登录落地页路径，用于判断 webview 登录是否成功
    pub post_login_path: String,
    /// 记住密码（凭据存系统钥匙串）
    pub remember_password: bool,
    /// 启动时自动登录（已保存凭据且无需验证码时静默登录）
    pub auto_login: bool,
    /// 开机自启
    pub autostart: bool,
    /// 新消息提示音：ding / chime / drop
    pub sound: String,
    /// 产品类型：true=运维（路径 /AIF），false=一表通（路径 /DCP）。默认一表通。
    #[serde(default)]
    pub ops_product: bool,
    /// 全局快捷键（显示/隐藏主窗口），如 "Ctrl+Alt+B"；空串=未启用。
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    /// 重启后恢复上次的标签页列表（默认关闭；开启后进全屏模式自动恢复）
    #[serde(default)]
    pub tab_restore: bool,
    /// 多入口切换：开启后全屏模式顶栏出现「切换入口」按钮，可在「我的 → 常用入口」
    /// 保存的多个账号（同一项目+网址下多账号）间一键切换（默认关闭）
    #[serde(default)]
    pub multi_entry: bool,
}

fn default_hotkey() -> String {
    "Ctrl+Alt+B".to_string()
}

impl Settings {
    /// 产品根路径名（不含斜杠），用于拼接所有 B/S 接口与页面路径
    pub fn app_root(&self) -> &'static str {
        if self.ops_product {
            "AIF"
        } else {
            "DCP"
        }
    }

    /// 产品品牌名：运维（AIF）=「运维小助手」，一表通（DCP）=「一表通小助手」。
    /// 用于主窗口/弹窗标题、托盘提示与前端顶栏。
    pub fn product_title(&self) -> &'static str {
        if self.ops_product {
            "运维小助手"
        } else {
            "一表通小助手"
        }
    }

    /// 将相对路径适配为当前产品根：存量设置/硬编码路径带 /AIF，
    /// 切换为非运维产品后使用时自动改写为 /DCP
    pub fn resolve_path(&self, p: &str) -> String {
        p.replace("/AIF/", &format!("/{}/", self.app_root()))
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            // 约定：base_url 为站点根（不含 /AIF），所有接口/页面路径自带 /AIF 前缀
            base_url: "https://51yunwei.com.cn".to_string(),
            // 消息：B/S 原生心跳接口（60s 心跳，响应 {c:在线数, s:状态, m:[消息数组]}）
            api_messages: "/AIF/keepAlive?terminal=PC".to_string(),
            // 待办：「我收到的事项」，todo>0 即有待办，todo_pc_url 为跳转地址
            api_todos: "/AIF/homePage/findReceivedMatters.htm".to_string(),
            // 心跳间隔（秒）：默认 60 秒（与 B/S 网页原生心跳同频，兼做会话保活；30~3600）
            poll_interval_secs: 60,
            post_login_path: "/AIF/user/index.htm".to_string(),
            remember_password: false,
            auto_login: false,
            autostart: false,
            sound: "chime".to_string(),
            // 默认一表通（DCP）：开发阶段目标系统 https://51yunwei.com.cn/DCP
            ops_product: false,
            hotkey: default_hotkey(),
            tab_restore: false,
            multi_entry: false,
        }
    }
}

/// 全局共享状态。rusqlite::Connection 非 Sync，用 Mutex 包裹。
pub struct AppState {
    pub db: Mutex<Connection>,
    pub client: Client,
    /// 登录流程专用 client：关闭 cookie store，会话 Cookie 由我们手动管理
    pub auth_client: Client,
    /// 本地登录流程的会话 Cookie（JSESSIONID=...；验证码与登录共用同一会话）
    pub session: Mutex<String>,
    pub settings: Mutex<Settings>,
    /// 多标签页状态（全屏三栏内嵌面板的 tab-N 子 webview 生命周期；内部自带 Mutex）
    pub tabs: TabState,
    /// 通知点击跳转注册表：（通知标题 → 消息 URL）FIFO 队列（上限 20）。
    /// 系统通知点击（tap）按标题反查 URL 交前端打开；标题可能重复，反查取最新一条。
    pub notify_urls: Mutex<VecDeque<(String, String)>>,
}

impl AppState {
    pub fn new(db: Connection, settings: Settings) -> Self {
        // 复用 cookie store，使轮询请求自动携带登录会话
        let client = Client::builder()
            .cookie_store(true)
            .user_agent("AIF-Desktop-Client/0.1")
            .build()
            .expect("构建 reqwest client 失败");
        let auth_client = Client::builder()
            .user_agent("AIF-Desktop-Client/0.1")
            .build()
            .expect("构建登录 client 失败");
        Self {
            db: Mutex::new(db),
            client,
            auth_client,
            session: Mutex::new(String::new()),
            settings: Mutex::new(settings),
            tabs: TabState::new(),
            notify_urls: Mutex::new(VecDeque::new()),
        }
    }
}
