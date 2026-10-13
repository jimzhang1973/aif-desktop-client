//! 会话凭据存储。
//! 生产环境应存入系统钥匙串：Windows Credential Manager / macOS Keychain / Linux secret-service。
//! 这里用 `keyring` crate 直接对接，不落明文文件。
//!
//! 关键：会话 Cookie 缓存进内存（`SESSION_CACHE`）。原因——面板渲染时
//! `get_user_info`/`get_messages`/`get_todos`/`get_docs`/`get_spaces` 等命令会并发调用
//! `load_session()`，而 `login_webview` 的后台线程又在同一时刻并发 `save_session()`。
//! Windows 钥匙串（keyring crate）对同一条目的并发读写会偶发失败/读空，导致 `is_logged_in`
//! 误判未登录 → 启动渲染登录视图（无侧栏/无窗口栏/不可最小化）。内存缓存让「读取」完全
//! 不走钥匙串，只在写入与首次回填时访问，彻底消除抖动与误判。

use std::sync::Mutex;

const SERVICE: &str = "aif-desktop-client";
const SESSION_KEY: &str = "bs_session_cookie";

/// 会话内存缓存：仅保存非空有效会话。读空（钥匙串偶发失败）不入缓存，下次重试。
static SESSION_CACHE: Mutex<Option<String>> = Mutex::new(None);

/// 保存 B/S 的会话 Cookie（通常是 `JSESSIONID=...` 等，可能含多个分号分隔的键值）
pub fn save_session(cookie: &str) -> anyhow::Result<()> {
    let entry = keyring::Entry::new(SERVICE, SESSION_KEY)?;
    entry.set_password(cookie)?;
    *SESSION_CACHE.lock().unwrap() = Some(cookie.to_string());
    Ok(())
}

/// 读取已保存的会话；未登录返回 None。
/// 优先内存缓存（无钥匙串开销、无并发竞态）；缓存空时回退钥匙串并回填。
pub fn load_session() -> Option<String> {
    {
        let cache = SESSION_CACHE.lock().unwrap();
        if let Some(s) = cache.as_ref() {
            return Some(s.clone());
        }
    }
    let entry = keyring::Entry::new(SERVICE, SESSION_KEY).ok()?;
    let pw = entry.get_password().ok()?;
    if pw.is_empty() {
        return None;
    }
    *SESSION_CACHE.lock().unwrap() = Some(pw.clone());
    Some(pw)
}

/// 启动时预热：从钥匙串读一次会话填进内存缓存（首次 `is_logged_in` 不再受钥匙串抖动影响）。
pub fn warm_session() {
    let _ = load_session();
}

/// 清除会话（退出登录）
pub fn clear_session() -> anyhow::Result<()> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, SESSION_KEY) {
        let _ = entry.delete_credential();
    }
    *SESSION_CACHE.lock().unwrap() = None;
    Ok(())
}

const CRED_USER: &str = "bs_username";
const CRED_PASS: &str = "bs_password";

/// 保存登录凭据（记住密码，用户主动勾选才存）
pub fn save_credentials(user: &str, pass: &str) -> anyhow::Result<()> {
    keyring::Entry::new(SERVICE, CRED_USER)?.set_password(user)?;
    keyring::Entry::new(SERVICE, CRED_PASS)?.set_password(pass)?;
    Ok(())
}

/// 读取已保存凭据；(username, password)
pub fn load_credentials() -> Option<(String, String)> {
    let u = keyring::Entry::new(SERVICE, CRED_USER).ok()?.get_password().ok()?;
    let p = keyring::Entry::new(SERVICE, CRED_PASS).ok()?.get_password().ok()?;
    Some((u, p))
}

/// 仅读用户名（用于登录窗预填）
pub fn load_username() -> Option<String> {
    keyring::Entry::new(SERVICE, CRED_USER).ok()?.get_password().ok()
}

/// 清除保存的凭据
pub fn clear_credentials() {
    if let Ok(e) = keyring::Entry::new(SERVICE, CRED_USER) {
        let _ = e.delete_credential();
    }
    if let Ok(e) = keyring::Entry::new(SERVICE, CRED_PASS) {
        let _ = e.delete_credential();
    }
}

