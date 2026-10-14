use rusqlite::Connection;
use serde::Serialize;

use crate::state::Settings;

#[derive(Clone, Serialize)]
pub struct MessageRow {
    pub id: String,
    pub title: String,
    pub body: String,
    pub url: String,
    pub received_at: i64,
}

#[derive(Clone, Serialize)]
pub struct TodoRow {
    pub id: String,
    pub title: String,
    pub url: String,
    pub done: bool,
    /// 该事项挂着的待办条目数（服务端 "todo" 字段；角标按其合计，与主窗/B/S 口径一致）
    pub count: i64,
    pub updated_at: i64,
}

/// 初始化本地库（消息去重表 / 待办表 / kv 配置表）
pub fn init(path: &std::path::Path) -> anyhow::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            title TEXT,
            body TEXT,
            url TEXT,
            received_at INTEGER,
            notified INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS todos (
            id TEXT PRIMARY KEY,
            title TEXT,
            url TEXT,
            done INTEGER DEFAULT 0,
            updated_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS kv (
            k TEXT PRIMARY KEY,
            v TEXT
        );
        CREATE TABLE IF NOT EXISTS todo_seen (
            id TEXT PRIMARY KEY,
            first_seen INTEGER,
            escalated INTEGER DEFAULT 0
        );
        "#,
    )?;
    // 迁移：老库 todos 表补 count 列（列已存在时报错忽略）
    let _ = conn.execute("ALTER TABLE todos ADD COLUMN count INTEGER DEFAULT 1", []);
    Ok(conn)
}

/// 仅插入本地尚未记录的消息，返回 true 表示「新消息」
pub fn insert_message(
    conn: &Connection,
    id: &str,
    title: &str,
    body: &str,
    url: &str,
) -> anyhow::Result<bool> {
    let exists: i64 =
        conn.query_row("SELECT COUNT(1) FROM messages WHERE id=?", [id], |r| r.get(0))?;
    if exists > 0 {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO messages (id,title,body,url,received_at,notified) VALUES (?,?,?,?,?,0)",
        (
            id,
            title,
            body,
            url,
            chrono_now(),
        ),
    )?;
    Ok(true)
}

pub fn mark_notified(conn: &Connection, id: &str) -> anyhow::Result<()> {
    conn.execute("UPDATE messages SET notified=1 WHERE id=?", [id])?;
    Ok(())
}

pub fn list_messages(conn: &Connection) -> anyhow::Result<Vec<MessageRow>> {
    let mut stmt = conn.prepare(
        "SELECT id,title,body,url,received_at FROM messages ORDER BY received_at DESC LIMIT 200",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(MessageRow {
            id: r.get(0)?,
            title: r.get(1)?,
            body: r.get(2)?,
            url: r.get(3)?,
            received_at: r.get(4)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

/// 全量覆盖待办（以服务端为准）。transaction() 需要 &mut Connection。
pub fn upsert_todos(conn: &mut Connection, todos: &[TodoRow]) -> anyhow::Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM todos", [])?;
    for t in todos {
        tx.execute(
            "INSERT INTO todos (id,title,url,done,count,updated_at) VALUES (?,?,?,?,?,?)",
            (t.id.as_str(), t.title.as_str(), t.url.as_str(), t.done as i64, t.count, t.updated_at),
        )?;
    }
    tx.commit()?;
    Ok(())
}

pub fn list_todos(conn: &Connection) -> anyhow::Result<Vec<TodoRow>> {
    let mut stmt =
        conn.prepare("SELECT id,title,url,done,count,updated_at FROM todos ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |r| {
        Ok(TodoRow {
            id: r.get(0)?,
            title: r.get(1)?,
            url: r.get(2)?,
            done: r.get::<_, i64>(3)? != 0,
            count: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn set_done(conn: &Connection, id: &str, done: bool) -> anyhow::Result<()> {
    conn.execute("UPDATE todos SET done=? WHERE id=?", (done as i64, id))?;
    Ok(())
}

/// 待办超时升级检测：todos 为本轮「未办结」事项列表。
/// - 首次出现的事项登记 first_seen；
/// - 在本地可见超过 days 天且未提醒过的 → 标记 escalated 并返回（供弹升级通知）；
/// - 顺带清理已从服务端消失的事项跟踪记录，防表膨胀。
pub fn detect_overdue_todos(
    conn: &Connection,
    todos: &[TodoRow],
    days: u64,
    now: i64,
) -> anyhow::Result<Vec<TodoRow>> {
    let threshold = (days as i64).saturating_mul(86400);
    let mut overdue = Vec::new();
    for t in todos {
        if t.id.is_empty() {
            continue;
        }
        conn.execute(
            "INSERT OR IGNORE INTO todo_seen (id,first_seen,escalated) VALUES (?,?,0)",
            [&t.id, &now.to_string()],
        )?;
        let (first_seen, escalated): (i64, i64) = conn.query_row(
            "SELECT first_seen,escalated FROM todo_seen WHERE id=?",
            [&t.id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if escalated == 0
            && first_seen > 0
            && now.saturating_sub(first_seen) >= threshold
        {
            conn.execute("UPDATE todo_seen SET escalated=1 WHERE id=?", [&t.id])?;
            overdue.push(t.clone());
        }
    }
    // 清理已消失事项的跟踪记录（服务端不再返回 = 已办结/已移除）
    let current: Vec<String> = todos.iter().map(|t| t.id.clone()).collect();
    let stale: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM todo_seen")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.flatten().collect()
    };
    for id in stale {
        if !current.contains(&id) {
            let _ = conn.execute("DELETE FROM todo_seen WHERE id=?", [&id]);
        }
    }
    Ok(overdue)
}

/// 托盘待办速览：未办结事项前 n 条（按最近更新倒序）
pub fn list_pending_todos_top(conn: &Connection, n: usize) -> anyhow::Result<Vec<TodoRow>> {
    let mut stmt = conn.prepare(
        "SELECT id,title,url,done,count,updated_at FROM todos WHERE done=0 ORDER BY updated_at DESC LIMIT ?",
    )?;
    let rows = stmt.query_map([n as i64], |r| {
        Ok(TodoRow {
            id: r.get(0)?,
            title: r.get(1)?,
            url: r.get(2)?,
            done: r.get::<_, i64>(3)? != 0,
            count: r.get(4)?,
            updated_at: r.get(5)?,
        })
    })?;
    Ok(rows.flatten().collect())
}

pub fn get_settings(conn: &Connection) -> Settings {
    let mut s = match conn.query_row("SELECT v FROM kv WHERE k='settings'", [], |r| r.get::<_, String>(0)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    // 源头规范化：base_url 不允许尾斜杠（历史上手工录入可能带 /），
    // 所有拼接点统一按「base 无尾斜杠 + 子路径自带前导斜杠」的约定工作
    s.base_url = s.base_url.trim().trim_end_matches('/').to_string();
    s
}

pub fn save_settings(conn: &Connection, s: &Settings) -> anyhow::Result<()> {
    let v = serde_json::to_string(s)?;
    conn.execute(
        "INSERT INTO kv (k,v) VALUES ('settings',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        [v],
    )?;
    Ok(())
}

/// kv 通用读取（账号保险库 / SM4 密钥等）
pub fn kv_get(conn: &Connection, k: &str) -> Option<String> {
    conn.query_row("SELECT v FROM kv WHERE k=?", [k], |r| r.get(0))
        .ok()
}

pub fn kv_set(conn: &Connection, k: &str, v: &str) -> anyhow::Result<()> {
    conn.execute(
        "INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
        [k, v],
    )?;
    Ok(())
}

pub fn kv_delete(conn: &Connection, k: &str) -> anyhow::Result<()> {
    conn.execute("DELETE FROM kv WHERE k=?", [k])?;
    Ok(())
}

fn chrono_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
