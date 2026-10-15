//! 网盘（个人空间 + 有权限空间）轻量传输：目录浏览、批量上传/下载、
//! 资源管理器右键「上传到个人空间」注册（HKCU 静态 verb，MVP 路线 A）。
//!
//! B/S 接口（knowledge 知识库子系统，2026-10-14 起于 DCP 实测；DCP/AIF 同源同一框架，
//! 接口完全一致，仅 {root} 前缀不同——见下方各接口的 {root} 占位，无需产品分支）：
//! - 个人空间 spaceId：GET knowledge/personal/view.htm 页面注入 `var spaceId = 'PERSONAL_SPACE_<租户ID>'`
//! - 目录树：POST nonlogin/knowledge/space/findTree.htm（spaceId）
//! - 子树扁平列表：POST nonlogin/knowledge/space/findTreeByNodeId.htm（id/type/spaceId）
//!   返回扁平节点，article 节点带 pid/pids（祖先链）/subtype(FILE|DOC|RICHTEXT|EXCEL…)/subFileType(扩展名)
//! - 文章元数据：POST knowledge/article/findById.htm（id）→ JSON（type/filepath/fileSize…）
//! - 上传（两阶段）：① POST fileupload/uploadfile.htm?savePath=/knowledge/space&secret=false
//!   multipart 字段 Filedata → 响应为 URL-encode 的 JSON（id/originalFileName/fileType/
//!   fileSize/downloadUrl/mimeType）；② POST editorask/knowledge/article/fileSave.htm
//!   data={files:[{annexId,annexName,annexType,annexSize,annexPath,annexMimeType}],spaceId,subjectId}，
//!   单次落库 ≤20 个文件
//! - 下载：GET nonlogin/{article.filepath}&mode=download（流式，实测 71MB 可下）
//! - 单文件上限 100MB（B/S 上传窗口配置 size:100）

use serde::Deserialize;
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::auth;
use crate::state::AppState;

/// 上传单文件上限（B/S 上传窗口 size:100，单位 MB）
const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
/// fileSave 单次落库文件数上限（knowledge.js fileNum:20）
const FILESAVE_BATCH: usize = 20;
/// 右键菜单注册键
const REG_KEY: &str = r"Software\Classes\*\shell\AifUpload";

// ---------- 数据结构 ----------

/// 目录树节点（findTree / findTreeByNodeId 统一形态）
#[derive(Clone, serde::Serialize)]
pub struct DiskNode {
    pub id: String,
    pub name: String,
    pub pid: String,
    /// 祖先链（尾部含自身 id），用于子树过滤与相对路径构建
    pub pids: String,
    /// subject | article
    #[serde(rename = "nodeType")]
    pub node_type: String,
    #[serde(rename = "isLeaf")]
    pub is_leaf: bool,
    /// article 的文章类型：FILE / DOC / RICHTEXT / EXCEL / COLLEXCEL
    pub subtype: String,
    /// FILE 型文章的扩展名（如 docx）
    #[serde(rename = "subFileType")]
    pub sub_file_type: String,
    /// epoch 毫秒
    #[serde(rename = "updateTime")]
    pub update_time: i64,
}

/// FILE 型文章元数据（findById.htm）
#[derive(Clone, serde::Serialize)]
pub struct DiskArticleMeta {
    pub id: String,
    pub title: String,
    pub subtype: String,
    /// 相对下载路径（含 ?id=…&path=…&name=…），拼 {base}/{root}/nonlogin/ 前缀 + &mode=download
    pub filepath: String,
}

/// 下载任务项（前端从树数据构建：rel_dir 为相对所选目录的子目录链）
#[derive(Deserialize)]
pub struct DiskDlItem {
    #[serde(rename = "articleId")]
    pub article_id: String,
    pub name: String,
    #[serde(rename = "relDir", default)]
    pub rel_dir: String,
    /// 文章类型：FILE=附件（findById→filepath 直下）；其余=在线文档（transfer/download.htm 导出 DOCX）
    #[serde(default)]
    pub subtype: String,
}

/// 进度事件负载（emit "disk-progress"）
#[derive(Clone, serde::Serialize)]
struct DiskProgress {
    kind: String, // upload | download
    file: String,
    done: u32,
    total: u32,
    ok: bool,
    msg: String,
}

// ---------- 内部工具 ----------

fn base_root(state: &State<'_, std::sync::Arc<AppState>>) -> (String, String) {
    let s = state.settings.lock().unwrap();
    (
        s.base_url.trim_end_matches('/').to_string(),
        s.app_root().to_string(),
    )
}

fn session_of(_state: &State<'_, std::sync::Arc<AppState>>) -> Result<String, String> {
    auth::load_session()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "未登录或会话已过期，请先登录".to_string())
}

/// mini.decode 兼容：响应可能是裸 JSON / URL-encode / 字符串包裹的 JSON，逐层剥开
fn decode_flex(text: &str) -> Result<serde_json::Value, String> {
    let mut t = text.trim().to_string();
    if t.starts_with('%') || t.contains("%22") {
        t = percent_decode(&t);
    }
    let mut val: serde_json::Value =
        serde_json::from_str(t.trim()).map_err(|e| format!("B/S 响应解析失败: {e}"))?;
    if let serde_json::Value::String(s) = &val {
        val = serde_json::from_str(s).map_err(|e| format!("B/S 响应解析失败: {e}"))?;
    }
    Ok(val)
}

/// 最小 percent-decode（B/S 上传响应是 URL-encode 的 JSON）
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let hex = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    };
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Windows 文件名消毒：替换非法字符
fn sanitize_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

/// 树接口防御：若 B/S 用 {data:[...]} 包裹数组则解包
fn unwrap_data(val: serde_json::Value) -> serde_json::Value {
    if val.get("data").map(|d| d.is_array()).unwrap_or(false) {
        val["data"].clone()
    } else {
        val
    }
}

/// 解析 B/S 树节点 JSON 数组 → DiskNode 列表
fn parse_nodes(val: &serde_json::Value) -> Vec<DiskNode> {
    let arr = match val.as_array() {
        Some(a) => a.clone(),
        None => return Vec::new(),
    };
    let gstr = |o: &serde_json::Value, keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = o.get(*k).and_then(|x| x.as_str()) {
                return s.trim().to_string();
            }
        }
        String::new()
    };
    arr.iter()
        .map(|o| DiskNode {
            id: gstr(o, &["id"]),
            name: gstr(o, &["name", "menuName"]),
            pid: gstr(o, &["pid", "parentId"]),
            pids: gstr(o, &["pids"]),
            node_type: gstr(o, &["type"]),
            is_leaf: o.get("isLeaf").and_then(|x| x.as_bool()).unwrap_or(false),
            subtype: gstr(o, &["subtype", "type"]),
            sub_file_type: gstr(o, &["subFileType"]),
            update_time: o.get("updateTime").and_then(|x| x.as_i64()).unwrap_or(0),
        })
        .filter(|n| !n.id.is_empty())
        .collect()
}

async fn post_form(
    client: &reqwest::Client,
    url: String,
    session: &str,
    form: &[(&str, &str)],
) -> Result<serde_json::Value, String> {
    // 注意：RequestBuilder.form() 是整体替换而非追加——必须一次传全参数。
    // 逐对循环调用会导致 body 只剩最后一对（findTreeByNodeId 只发了 spaceId，
    // id/type 丢失 → B/S 返回空数组 → 树永远没有文件）。
    let resp = client
        .post(&url)
        .header("Cookie", session)
        .form(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("请求失败（HTTP {}）", resp.status().as_u16()));
    }
    decode_flex(&resp.text().await.map_err(|e| e.to_string())?)
}

/// 从 findById 响应取 filepath（兼容 {code,data} 包裹与裸对象）
fn filepath_of(val: &serde_json::Value) -> String {
    let obj = if val.get("data").map(|d| d.is_object()).unwrap_or(false) {
        &val["data"]
    } else {
        val
    };
    obj.get("filepath")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

// ---------- 目录浏览 ----------

static SPACE_ID_CACHE: std::sync::OnceLock<Mutex<HashMap<String, String>>> = std::sync::OnceLock::new();

fn space_cache() -> &'static Mutex<HashMap<String, String>> {
    SPACE_ID_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 个人空间 spaceId：从 knowledge/personal/view.htm 页面注入的 JS 变量提取（按产品根缓存）
#[tauri::command]
pub async fn disk_personal_space_id(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<String, String> {
    let (base, root) = base_root(&state);
    if let Some(id) = space_cache().lock().unwrap().get(&root) {
        return Ok(id.clone());
    }
    let session = session_of(&state)?;
    let html = state
        .client
        .get(format!("{base}/{root}/knowledge/personal/view.htm"))
        .header("Cookie", &session)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("打开个人空间失败: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let id = regex::Regex::new(r"var spaceId = '([^']+)'")
        .unwrap()
        .captures(&html)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
        .ok_or_else(|| "未在个人空间页面找到 spaceId（页面结构可能已变化）".to_string())?;
    SPACE_ID_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock().unwrap().insert(root, id.clone());
    Ok(id)
}

/// 目录树根节点（subject 列表）
#[tauri::command]
pub async fn disk_tree(
    state: State<'_, std::sync::Arc<AppState>>,
    space_id: String,
) -> Result<Vec<DiskNode>, String> {
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let val = post_form(
        &state.client,
        format!("{base}/{root}/nonlogin/knowledge/space/findTree.htm"),
        &session,
        &[("spaceId", space_id.as_str())],
    )
    .await?;
    Ok(parse_nodes(&unwrap_data(val)))
}

/// 子树扁平节点列表（subject + article 混排；article 带 pid/pids/subtype）
#[tauri::command]
pub async fn disk_nodes(
    state: State<'_, std::sync::Arc<AppState>>,
    space_id: String,
    node_id: String,
    node_type: String,
) -> Result<Vec<DiskNode>, String> {
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let val = post_form(
        &state.client,
        format!("{base}/{root}/nonlogin/knowledge/space/findTreeByNodeId.htm"),
        &session,
        &[
            ("id", node_id.as_str()),
            ("type", node_type.as_str()),
            ("spaceId", space_id.as_str()),
        ],
    )
    .await?;
    Ok(parse_nodes(&unwrap_data(val)))
}

/// FILE 型文章元数据（下载需要 filepath）
#[tauri::command]
pub async fn disk_article_meta(
    state: State<'_, std::sync::Arc<AppState>>,
    article_id: String,
) -> Result<DiskArticleMeta, String> {
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let val = post_form(
        &state.client,
        format!("{base}/{root}/knowledge/article/findById.htm"),
        &session,
        &[("id", article_id.as_str())],
    )
    .await?;
    let obj = if val.get("data").map(|d| d.is_object()).unwrap_or(false) {
        val["data"].clone()
    } else {
        val
    };
    let gstr = |keys: &[&str]| -> String {
        for k in keys {
            if let Some(s) = obj.get(*k).and_then(|x| x.as_str()) {
                return s.trim().to_string();
            }
        }
        String::new()
    };
    Ok(DiskArticleMeta {
        subtype: gstr(&["type", "subtype"]),
        filepath: gstr(&["filepath"]),
        title: gstr(&["title"]),
        id: gstr(&["id"]),
    })
}

// ---------- 下载 ----------

/// 生成不冲突的目标路径（已存在则追加 (1)、(2)…）
fn nonconflict_path(dir: &Path, name: &str) -> PathBuf {
    let mut p = dir.join(name);
    if !p.exists() {
        return p;
    }
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file")
        .to_string();
    let ext = Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();
    for n in 1..1000u32 {
        p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
    }
    dir.join(format!("{stem}-{}{ext}", chrono::Utc::now().timestamp_millis()))
}

/// 流式写盘
async fn download_to(
    client: &reqwest::Client,
    session: &str,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    let mut resp = client
        .get(url)
        .header("Cookie", session)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut f = std::fs::File::create(path).map_err(|e| e.to_string())?;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        f.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    f.flush().map_err(|e| e.to_string())?;
    Ok(())
}

/// 批量下载文章到本地目录（FILE 附件直下原始文件；在线文档经 B/S 导出接口转 DOCX；
/// 逐文件流式，进度 emit "disk-progress"）
#[tauri::command]
pub fn disk_download_files(
    app: AppHandle,
    state: State<'_, std::sync::Arc<AppState>>,
    items: Vec<DiskDlItem>,
    dest_dir: String,
    // 网盘同步传 true：同名文件直接覆盖写（手动下载保持 false 走防冲突重命名）
    overwrite: Option<bool>,
) -> Result<(), String> {
    let overwrite = overwrite.unwrap_or(false);
    if items.is_empty() {
        return Err("没有可下载的文件".into());
    }
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let client = state.client.clone();
    let dest = PathBuf::from(&dest_dir);
    if !dest.is_dir() {
        return Err(format!("目标目录不存在: {dest_dir}"));
    }
    tauri::async_runtime::spawn(async move {
        let total = items.len() as u32;
        for (i, item) in items.into_iter().enumerate() {
            let done = (i + 1) as u32;
            let name = sanitize_name(&item.name);
            let fail = |msg: String| DiskProgress {
                kind: "download".into(),
                file: name.clone(),
                done,
                total,
                ok: false,
                msg,
            };
            // 1) 解析下载 URL：
            //    FILE 附件 → findById 拿 filepath，直下原始文件；
            //    在线文档（DOC/MARKDOWN/EXCEL/RICHTEXT…）→ B/S 官方导出接口，服务端转 DOCX
            //    （detail.htm onExport 实测链路：nonlogin/knowledge/transfer/download.htm?id=&type=0&exportType=DOCX）
            let is_file = item.subtype == "FILE";
            let url = if is_file {
                let meta = match post_form(
                    &client,
                    format!("{base}/{root}/knowledge/article/findById.htm"),
                    &session,
                    &[("id", item.article_id.as_str())],
                )
                .await
                {
                    Ok(v) => filepath_of(&v),
                    Err(e) => {
                        let _ = app.emit("disk-progress", fail(format!("获取文件信息失败: {e}")));
                        continue;
                    }
                };
                if meta.is_empty() {
                    let _ = app.emit(
                        "disk-progress",
                        fail("附件下载路径为空（该文章可能无附件）".into()),
                    );
                    continue;
                }
                format!("{base}/{root}/nonlogin/{meta}&mode=download")
            } else {
                // 在线文档导出（B/S 官方 transfer/download.htm 链路，2026-10-14 实测矩阵）：
                // - MARKDOWN → MD（保留 UTF-8 原文，exportType=MD 返回纯文本）
                // - DOC / RICHTEXT → DOCX（富文本 DOCX 导出可用）
                // - EXCEL / COLLEXCEL → EXCEL（返回 PK zip=原 xlsx，响应后缀误为 .EXCEL，
                //   本地已用 .xlsx 命名，见 diskFileDisplay / DiskDlItem.name）
                let export_type = match item.subtype.as_str() {
                    "MARKDOWN" => "MD",
                    "EXCEL" | "COLLEXCEL" => "EXCEL",
                    _ => "DOCX",
                };
                format!(
                    "{base}/{root}/nonlogin/knowledge/transfer/download.htm?id={}&type=0&exportType={export_type}",
                    item.article_id
                )
            };
            // 2) 流式下载（导出接口无权限/异常时会返回 HTML 错误页，按 Content-Type 识别拦截）
            match client.get(&url).header("Cookie", &session).send().await {
                Ok(resp) if resp.status().is_success() => {
                    let ct = resp
                        .headers()
                        .get(reqwest::header::CONTENT_TYPE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    if ct.contains("text/html") {
                        let _ = app.emit(
                            "disk-progress",
                            fail("服务端返回错误页（可能无下载/导出权限）".into()),
                        );
                        continue;
                    }
                    let dir = if item.rel_dir.is_empty() {
                        dest.clone()
                    } else {
                        dest.join(sanitize_name(&item.rel_dir))
                    };
                    if std::fs::create_dir_all(&dir).is_err() {
                        let _ = app.emit("disk-progress", fail("创建本地子目录失败".into()));
                        continue;
                    }
                    let path = if overwrite {
                        dir.join(&name)
                    } else {
                        nonconflict_path(&dir, &name)
                    };
                    match download_to(&client, &session, &url, &path).await {
                        Ok(()) => {
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "download".into(),
                                    file: name,
                                    done,
                                    total,
                                    ok: true,
                                    msg: path.to_string_lossy().into_owned(),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = app.emit("disk-progress", fail(format!("下载失败: {e}")));
                        }
                    }
                }
                Ok(resp) => {
                    let _ = app.emit(
                        "disk-progress",
                        fail(format!("HTTP {}", resp.status().as_u16())),
                    );
                }
                Err(e) => {
                    let _ = app.emit("disk-progress", fail(e.to_string()));
                }
            }
        }
        // 批量下载完成：emit 完成事件，前端据此把任务状态从「进行中」置为 完成/部分失败
        let _ = app.emit(
            "disk-progress",
            DiskProgress {
                kind: "download".into(),
                file: "全部完成".into(),
                done: total,
                total,
                ok: true,
                msg: String::new(),
            },
        );
    });
    Ok(())
}

// ---------- 上传 ----------

/// 上传响应（URL-encode JSON 解码后）
#[derive(serde::Deserialize)]
struct UploadResp {
    id: String,
    #[serde(rename = "originalFileName", default)]
    original_file_name: String,
    #[serde(rename = "fileType", default)]
    file_type: String,
    #[serde(rename = "fileSize", default)]
    file_size: f64,
    #[serde(rename = "downloadUrl", default)]
    download_url: String,
    #[serde(rename = "mimeType", default)]
    mime_type: String,
}

/// 上传类型白名单（小写后缀；不在名单内的文件在上传前即拦截，不再发起请求）。
/// 注意：按用户给定清单收录，其中 "xt" 疑似 "txt" 之误，已同时放行 "txt"。
const UPLOAD_EXT_WHITELIST: &[&str] = &[
    "xt", "txt", "mp4", "png", "jpg", "jpeg", "gif", "doc", "docx", "wps", "wpt", "xls", "xlsx",
    "ppt", "pptx", "pdf", "zip", "rar", "7z", "json", "xml", "guac", "picture", "emf", "x-wmf",
    "none", "svg", "sh", "gz", "tar.gz", "md", "mdj", "html",
];

fn upload_ext_allowed(fname: &str) -> bool {
    let lower = fname.to_lowercase();
    if lower.ends_with(".tar.gz") {
        return true; // 双段后缀优先判定
    }
    match lower.rsplit('.').next() {
        Some(ext) => UPLOAD_EXT_WHITELIST.contains(&ext),
        None => false, // 无后缀 → 拦截
    }
}

/// 批量上传本地文件到指定空间/目录（两阶段：先传文件再落库，20 个/批）。
/// 同名处理：目标目录下已存在同名 FILE 型附件时走 fileReplace（保文章 id 替换文件），
/// 否则按新建 fileSave 落库——不产生重复附件。
#[tauri::command]
pub fn disk_upload_files(
    app: AppHandle,
    state: State<'_, std::sync::Arc<AppState>>,
    space_id: String,
    subject_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    if paths.is_empty() {
        return Err("没有要上传的文件".into());
    }
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let client = state.client.clone();
    tauri::async_runtime::spawn(async move {
        // 预查目标目录现有 FILE 附件（name → article id），用于同名替换判定
        let mut existing: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        let tree_url = format!("{base}/{root}/nonlogin/knowledge/space/findTreeByNodeId.htm");
        if let Ok(val) = post_form(
            &client,
            tree_url,
            &session,
            &[
                ("id", subject_id.as_str()),
                ("type", "subject"),
                ("spaceId", space_id.as_str()),
            ],
        )
        .await
        {
            for n in parse_nodes(&unwrap_data(val)) {
                if n.node_type == "article" && n.subtype == "FILE" {
                    let name = n.name.trim().to_lowercase();
                    let id = n.id.clone();
                    existing.entry(name.clone()).or_insert(id.clone());
                    // 前端展示名可能带扩展名（name.ext），两种命名约定都登记，
                    // 否则上传文件名与文章原始名不一致时同名替换失效、误建新文件
                    let ext = n.sub_file_type.trim().trim_start_matches('.').to_lowercase();
                    if !ext.is_empty() && !name.ends_with(&format!(".{ext}")) {
                        existing.entry(format!("{name}.{ext}")).or_insert(id);
                    }
                }
            }
        }

        let total = paths.len() as u32;
        // (上传引用, 同名待替换的文章 id)
        let mut refs: Vec<(UploadResp, Option<String>)> = Vec::new();
        for (i, p) in paths.iter().enumerate() {
            let done = (i + 1) as u32;
            let path = PathBuf::from(p);
            let fname = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let fail = |msg: String| DiskProgress {
                kind: "upload".into(),
                file: fname.clone(),
                done,
                total,
                ok: false,
                msg,
            };
            if fname.is_empty() || !path.is_file() {
                let _ = app.emit("disk-progress", fail("文件不存在".into()));
                continue;
            }
            if !upload_ext_allowed(&fname) {
                let _ = app.emit("disk-progress", fail("非白名单类型，已拦截".into()));
                continue;
            }
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() > MAX_UPLOAD_BYTES {
                    let _ = app.emit(
                        "disk-progress",
                        fail("超过单文件 100MB 上限（B/S 限制）".into()),
                    );
                    continue;
                }
            }
            let replace_id = existing.get(&fname.trim().to_lowercase()).cloned();
            let url = format!(
                "{base}/{root}/fileupload/uploadfile.htm?savePath=/knowledge/space&secret=false"
            );
            let part = match reqwest::multipart::Part::file(&path).await {
                Ok(part) => part.file_name(fname.clone()),
                Err(e) => {
                    let _ = app.emit("disk-progress", fail(format!("读取文件失败: {e}")));
                    continue;
                }
            };
            let form = reqwest::multipart::Form::new().part("Filedata", part);
            match client
                .post(&url)
                .header("Cookie", &session)
                .multipart(form)
                .send()
                .await
            {
                Ok(resp) if resp.status().is_success() => {
                    let text = resp.text().await.unwrap_or_default();
                    match decode_flex(&text).and_then(|v| {
                        serde_json::from_value::<UploadResp>(v).map_err(|e| e.to_string())
                    }) {
                        Ok(up) => {
                            let note = if replace_id.is_some() {
                                "已上传，同名将替换"
                            } else {
                                "已上传，待登记"
                            };
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "upload".into(),
                                    file: fname,
                                    done,
                                    total,
                                    ok: true,
                                    msg: note.into(),
                                },
                            );
                            refs.push((up, replace_id));
                        }
                        Err(e) => {
                            let _ =
                                app.emit("disk-progress", fail(format!("上传响应解析失败: {e}")));
                        }
                    }
                }
                Ok(resp) => {
                    let _ = app.emit(
                        "disk-progress",
                        fail(format!("HTTP {}", resp.status().as_u16())),
                    );
                }
                Err(e) => {
                    let _ = app.emit("disk-progress", fail(e.to_string()));
                }
            }
        }
        // 第二阶段落库：同名 → fileReplace（保 id 替换，逐个）；其余 → fileSave 分批（≤20/批）
        let mut fresh: Vec<UploadResp> = Vec::new();
        for (r, replace_id) in refs {
            match replace_id {
                Some(aid) => {
                    let files = serde_json::json!([{
                        "annexId": r.id,
                        "annexName": r.original_file_name,
                        "annexType": r.file_type,
                        "annexSize": r.file_size,
                        "annexPath": r.download_url,
                        "annexMimeType": r.mime_type,
                    }]);
                    let payload = serde_json::json!({ "files": files });
                    let data_str = payload.to_string();
                    let url = format!("{base}/{root}/editorask/knowledge/article/fileReplace.htm");
                    match client
                        .post(&url)
                        .header("Cookie", &session)
                        .form(&[
                            ("id", aid.as_str()),
                            ("data", data_str.as_str()),
                        ])
                        .send()
                        .await
                    {
                        Ok(resp) if resp.status().is_success() => {
                            let text = resp.text().await.unwrap_or_default();
                            let code = decode_flex(&text)
                                .ok()
                                .and_then(|v| v.get("code").and_then(|c| c.as_i64()))
                                .unwrap_or(0);
                            if code != 200 {
                                let msg = decode_flex(&text)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("msg").and_then(|m| m.as_str()).map(String::from)
                                    })
                                    .unwrap_or_else(|| "替换失败".into());
                                let _ = app.emit(
                                    "disk-progress",
                                    DiskProgress {
                                        kind: "upload".into(),
                                        file: r.original_file_name,
                                        done: total,
                                        total,
                                        ok: false,
                                        msg,
                                    },
                                );
                            }
                        }
                        Ok(resp) => {
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "upload".into(),
                                    file: r.original_file_name,
                                    done: total,
                                    total,
                                    ok: false,
                                    msg: format!("替换 HTTP {}", resp.status().as_u16()),
                                },
                            );
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "upload".into(),
                                    file: r.original_file_name,
                                    done: total,
                                    total,
                                    ok: false,
                                    msg: e.to_string(),
                                },
                            );
                        }
                    }
                }
                None => fresh.push(r),
            }
        }
        for chunk in fresh.chunks(FILESAVE_BATCH) {
            let files: Vec<serde_json::Value> = chunk
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "annexId": r.id,
                        "annexName": r.original_file_name,
                        "annexType": r.file_type,
                        "annexSize": r.file_size,
                        "annexPath": r.download_url,
                        "annexMimeType": r.mime_type,
                    })
                })
                .collect();
            let payload = serde_json::json!({
                "files": files,
                "spaceId": space_id,
                "subjectId": subject_id,
            });
            let url = format!("{base}/{root}/editorask/knowledge/article/fileSave.htm");
            if let Ok(resp) = client
                .post(&url)
                .header("Cookie", &session)
                .form(&[("data", payload.to_string())])
                .send()
                .await
            {
                if let Ok(text) = resp.text().await {
                    if let Ok(v) = decode_flex(&text) {
                        let code = v.get("code").and_then(|x| x.as_i64()).unwrap_or(0);
                        if code != 200 {
                            let msg =
                                v.get("msg").and_then(|x| x.as_str()).unwrap_or("落库失败");
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "upload".into(),
                                    file: format!("{} 个文件登记", chunk.len()),
                                    done: total,
                                    total,
                                    ok: false,
                                    msg: msg.to_string(),
                                },
                            );
                        }
                    }
                }
            }
        }
        let _ = app.emit(
            "disk-progress",
            DiskProgress {
                kind: "upload".into(),
                file: "全部完成".into(),
                done: total,
                total,
                ok: true,
                msg: String::new(),
            },
        );
    });
    Ok(())
}

// ---------- 本地目录扫描（网盘同步用） ----------

/// 本地文件扫描项（相对路径 + 大小 + 修改时间，供同步指纹比对）
#[derive(Clone, serde::Serialize)]
pub struct DiskLocalFile {
    /// 相对扫描根目录的路径（/ 分隔，含文件名）
    #[serde(rename = "relPath")]
    pub rel_path: String,
    pub name: String,
    pub size: u64,
    /// 本地最后修改时间（epoch 秒；「本地最后一次上传时间」指纹的比对基准）
    pub mtime: i64,
}

/// 递归扫描本地目录：返回全部普通文件（relPath 以 / 分隔）。
/// 防护：跳过 .开头 / $开头（隐藏、office 临时文件）、深度 ≤8 层、上限 5000 个文件，
/// 防止误选盘根导致超长扫描。排序保证输出稳定（按相对路径）。
#[tauri::command]
pub fn disk_local_scan(dir: String) -> Result<Vec<DiskLocalFile>, String> {
    const MAX_FILES: usize = 5000;
    const MAX_DEPTH: usize = 8;
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err(format!("目录不存在: {dir}"));
    }
    fn walk(cur: &Path, rel: &str, out: &mut Vec<DiskLocalFile>, depth: usize) {
        if depth > MAX_DEPTH || out.len() >= MAX_FILES {
            return;
        }
        let Ok(rd) = std::fs::read_dir(cur) else {
            return;
        };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            if out.len() >= MAX_FILES {
                return;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.starts_with("~$") || name.starts_with('$') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            let rrel = if rel.is_empty() {
                name.clone()
            } else {
                format!("{rel}/{name}")
            };
            if ft.is_dir() {
                walk(&e.path(), &rrel, out, depth + 1);
            } else if ft.is_file() {
                if let Ok(md) = e.metadata() {
                    let mtime = md
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64)
                        .unwrap_or(0);
                    out.push(DiskLocalFile {
                        rel_path: rrel,
                        name,
                        size: md.len(),
                        mtime,
                    });
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(&root, "", &mut out, 0);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(out)
}

// ---------- 删除 ----------

/// 删除结果汇总
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDeleteItem {
    pub id: String,
    pub kind: String, // "file" | "dir"
    pub ok: bool,
    pub msg: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDeleteResult {
    pub deleted_files: u32,
    pub deleted_dirs: u32,
    pub failed: Vec<String>,
    pub items: Vec<DiskDeleteItem>,
}

/// 新建目录结果：成功时 id 为 B/S 返回的目录 id，ok=true；
/// 业务级失败（code!=200 / 解析失败）写进 ok=false + msg，不抛 Err，便于前端统一处理。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskCreateDirResult {
    pub id: String,
    pub ok: bool,
    pub msg: Option<String>,
}

/// 删除选中的文件（文章）与目录（subject）：先删文件，再删目录。
/// 在线文档（非 FILE 文章）由前端在调用前排除，本命令只接收可删除的 id。
///
/// B/S 删除端点（2026-10-15 实测确认）：
///   文章（附件 FILE）：{root}/knowledge/article/delete.htm   （raw 表单 id=）
///   目录（subject）：  {root}/knowledge/subject/delete.htm   （raw 表单 id=）
/// 注：早期误用的 knowledge/space/deleteSubject.htm 在 DCP 下为 404，已废弃。
/// 若实际端点不同，仅改下方两个常量即可；命令会记录原始响应（截断）便于核对。
#[tauri::command]
pub async fn disk_delete(
    state: State<'_, std::sync::Arc<AppState>>,
    article_ids: Vec<String>,
    subject_ids: Vec<String>,
) -> Result<DiskDeleteResult, String> {
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let client = state.client.clone();
    let article_del = format!("{base}/{root}/knowledge/article/delete.htm");
    let subject_del = format!("{base}/{root}/knowledge/subject/delete.htm");

    let mut res = DiskDeleteResult {
        deleted_files: 0,
        deleted_dirs: 0,
        failed: Vec::new(),
        items: Vec::new(),
    };

    // 1) 先删文件（文章）：逐 id POST，检查响应 code==200
    for id in &article_ids {
        let k = "file".to_string();
        let url = format!("{article_del}");
        match client
            .post(&url)
            .header("Cookie", &session)
            .form(&[("id", id.as_str())])
            .send()
            .await
        {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let m = format!("HTTP {}", resp.status().as_u16());
                    res.failed.push(format!("文件 {id}: {m}"));
                    res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
                    continue;
                }
                let text = resp.text().await.unwrap_or_default();
                match decode_flex(&text) {
                    Ok(v) => {
                        let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(200);
                        if code == 200 {
                            res.deleted_files += 1;
                            res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: true, msg: None });
                        } else {
                            let msg = v
                                .get("msg")
                                .and_then(|m| m.as_str())
                                .unwrap_or("未知错误")
                                .to_string();
                            res.failed.push(format!("文件 {id}: {msg}"));
                            res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(msg) });
                        }
                    }
                    Err(_) => {
                        let t = text.chars().take(120).collect::<String>();
                        let m = format!("响应解析失败（可能端点不对）: {t}");
                        res.failed.push(format!("文件 {id}: {m}"));
                        res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
                    }
                }
            }
            Err(e) => {
                let m = e.to_string();
                res.failed.push(format!("文件 {id}: {m}"));
                res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
            }
        }
    }

    // 2) 再删目录（subject）
    for id in &subject_ids {
        let k = "dir".to_string();
        let url = format!("{subject_del}");
        match client
            .post(&url)
            .header("Cookie", &session)
            .form(&[("id", id.as_str())])
            .send()
            .await
        {
            Ok(resp) => {
                if !resp.status().is_success() {
                    let m = format!("HTTP {}", resp.status().as_u16());
                    res.failed.push(format!("目录 {id}: {m}"));
                    res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
                    continue;
                }
                let text = resp.text().await.unwrap_or_default();
                match decode_flex(&text) {
                    Ok(v) => {
                        let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(200);
                        if code == 200 {
                            res.deleted_dirs += 1;
                            res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: true, msg: None });
                        } else {
                            let msg = v
                                .get("msg")
                                .and_then(|m| m.as_str())
                                .unwrap_or("未知错误")
                                .to_string();
                            res.failed.push(format!("目录 {id}: {msg}"));
                            res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(msg) });
                        }
                    }
                    Err(_) => {
                        let t = text.chars().take(120).collect::<String>();
                        let m = format!("响应解析失败（可能端点不对）: {t}");
                        res.failed.push(format!("目录 {id}: {m}"));
                        res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
                    }
                }
            }
            Err(e) => {
                let m = e.to_string();
                res.failed.push(format!("目录 {id}: {m}"));
                res.items.push(DiskDeleteItem { id: id.clone(), kind: k, ok: false, msg: Some(m) });
            }
        }
    }

    Ok(res)
}

/// 在指定空间/目录下新建目录（subject）。
///
/// B/S 端点（2026-10-15 实测确认）：POST {root}/knowledge/subject/save.htm
/// 请求体为 `data=` + URL 编码的 JSON（B/S 用 JSONUtil.readValueAsObject 解析 data，非表单）：
///   {"id":"", "name":<目录名>, "parentId":<父目录id|"0">, "spaceId":<空间id>,
///    "opDisabled":false, "remark":"", "anonymousAccess":false}
/// 成功响应：{"code":200,"msg":"success","data":"<新建目录id>"}
///
/// 入参：
///   space_id  目标空间 id（如个人空间 PERSONAL_SPACE_…）
///   parent_id 父目录 id；根目录传 "0"
///   name      新目录名
///
/// 注意：与删除不同，保存接口走 `data=` JSON 包裹，不能用 raw 表单字段（否则 500）。
#[tauri::command]
pub async fn disk_create_dir(
    state: State<'_, std::sync::Arc<AppState>>,
    space_id: String,
    parent_id: String, // "0" = 根目录
    name: String,
) -> Result<DiskCreateDirResult, String> {
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let client = state.client.clone();
    let url = format!("{base}/{root}/knowledge/subject/save.htm");

    let payload = serde_json::json!({
        "id": "",
        "name": name,
        "parentId": parent_id,
        "spaceId": space_id,
        "opDisabled": false,
        "remark": "",
        "anonymousAccess": false,
    });

    match client
        .post(&url)
        .header("Cookie", &session)
        .form(&[("data", payload.to_string())])
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                return Ok(DiskCreateDirResult {
                    id: "".into(),
                    ok: false,
                    msg: Some(format!("HTTP {}", resp.status().as_u16())),
                });
            }
            let text = resp.text().await.unwrap_or_default();
            match decode_flex(&text) {
                Ok(v) => {
                    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
                    if code == 200 {
                        let id = v
                            .get("data")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string();
                        Ok(DiskCreateDirResult {
                            id,
                            ok: true,
                            msg: None,
                        })
                    } else {
                        let msg = v
                            .get("msg")
                            .and_then(|m| m.as_str())
                            .unwrap_or("未知错误")
                            .to_string();
                        Ok(DiskCreateDirResult {
                            id: "".into(),
                            ok: false,
                            msg: Some(msg),
                        })
                    }
                }
                Err(_) => {
                    let t = text.chars().take(120).collect::<String>();
                    Ok(DiskCreateDirResult {
                        id: "".into(),
                        ok: false,
                        msg: Some(format!("响应解析失败: {t}")),
                    })
                }
            }
        }
        Err(e) => Ok(DiskCreateDirResult {
            id: "".into(),
            ok: false,
            msg: Some(e.to_string()),
        }),
    }
}

// ---------- 资源管理器右键菜单（HKCU 静态 verb，MVP 路线 A） ----------

/// 查询右键菜单注册状态
#[tauri::command]
pub fn disk_context_menu_status() -> bool {
    #[cfg(windows)]
    {
        reg_run(&["query", &format!(r"HKCU\{REG_KEY}"), "/ve"])
            .map(|_| true)
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 注册/注销资源管理器右键「上传到协作空间」（HKCU，免管理员；多选文件逐个调用 "%1"）
#[tauri::command]
pub fn disk_register_context_menu(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enable {
            let exe = std::env::current_exe()
                .map_err(|e| format!("获取程序路径失败: {e}"))?
                .to_string_lossy()
                .into_owned();
            reg_run(&[
                "add",
                &format!(r"HKCU\{REG_KEY}"),
                "/ve",
                "/d",
                "上传到协作空间",
                "/f",
            ])?;
            reg_run(&[
                "add",
                &format!(r"HKCU\{REG_KEY}"),
                "/v",
                "Icon",
                "/d",
                &exe,
                "/f",
            ])?;
            reg_run(&[
                "add",
                &format!(r"HKCU\{REG_KEY}"),
                "/v",
                "MultiSelectModel",
                "/d",
                "Single",
                "/f",
            ])?;
            // 命令模板："<exe>" --upload "%1"
            // 采用 Single 模式：资源管理器对「每个选中文件」各调用一次本命令（%1 = 该文件），
            // 不再依赖 %* 展开；这样即便 Win11 部分环境下 %* 不展开，也能保证 N 个文件全部进入上传队列
            reg_run(&[
                "add",
                &format!(r"HKCU\{REG_KEY}\command"),
                "/ve",
                "/d",
                &format!(r#""{exe}" --upload "%1""#),
                "/f",
            ])?;
            Ok(())
        } else {
            reg_run(&["delete", &format!(r"HKCU\{REG_KEY}"), "/f"]).map(|_| ())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("仅支持 Windows".into())
    }
}

#[cfg(windows)]
fn reg_run(args: &[&str]) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("reg")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text)
    } else {
        Err(text)
    }
}

/// 解析第二实例 argv：--upload 之后的全部文件路径（去重；Single 模式下逐个文件回调，每次仅一个路径）
pub fn extract_upload_paths(argv: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut iter = argv.iter().skip(1);
    while let Some(a) = iter.next() {
        if a == "--upload" {
            for p in iter.by_ref() {
                if p != "--upload" && !out.contains(p) && !p.is_empty() {
                    out.push(p.clone());
                }
            }
            break;
        }
    }
    out
}

// ---------- 本地编辑（下载→拉起编辑器→锁释放/超时监视→回传） ----------

/// 编辑完成事件（Rust 监视线程 → 前端）：changed=文件 mtime 相对下载时变化；
/// timed_out=超过监视上限（2 小时）强制收线。前端据此做冲突检查并回传/放弃。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskEditDone {
    pub path: String,
    pub changed: bool,
    pub timed_out: bool,
}

/// 编辑监视上限（2 小时）：超时后停止监视并告知前端
const EDIT_WATCH_MAX: std::time::Duration = std::time::Duration::from_secs(2 * 3600);
/// 编辑器拉起宽限：Office/WPS 打开文档需要数秒，期间锁未建立会造成误判"已释放"
const EDIT_GRACE: std::time::Duration = std::time::Duration::from_secs(10);
/// 锁轮询间隔
const EDIT_POLL: std::time::Duration = std::time::Duration::from_secs(2);

/// 用系统关联程序打开文件（Windows: cmd start；macOS: open；Linux: xdg-open）
fn shell_open(path: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

/// 编辑暂存目录：app_data/edit（下载的待编辑文件、MD 编辑副本都放这里）
#[tauri::command]
pub fn disk_edit_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("edit");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 读/写文本文件：content=None 读（返回 Some(text)）；Some(c) 写（返回 None）。
/// 供内置 MD 编辑器取稿与回写。
#[tauri::command]
pub fn disk_file_text(path: String, content: Option<String>) -> Result<Option<String>, String> {
    match content {
        Some(c) => std::fs::write(&path, c.as_bytes())
            .map(|_| None)
            .map_err(|e| e.to_string()),
        None => std::fs::read_to_string(&path)
            .map(Some)
            .map_err(|e| e.to_string()),
    }
}

/// 同目录另存副本：「name.ext」→「name_副本_HHMMSS.ext」，返回新路径（冲突回传"另存副本"用）
#[tauri::command]
pub fn disk_file_copy(src: String) -> Result<String, String> {
    let p = PathBuf::from(&src);
    let dir = p.parent().ok_or("文件无父目录")?;
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let h = (secs / 3600) % 24;
    let m = (secs / 60) % 60;
    let s = secs % 60;
    let name = if ext.is_empty() {
        format!("{stem}_副本_{h:02}{m:02}{s:02}")
    } else {
        format!("{stem}_副本_{h:02}{m:02}{s:02}.{ext}")
    };
    let dest = dir.join(name);
    std::fs::copy(&p, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// 设置只读属性并拉起系统关联编辑器；readonly=false 时启动监视线程：
/// 句柄占用探测 + Office「~$」锁文件监听，释放后比对 mtime，emit disk-edit-done。
/// 上传回传由前端完成（需会话与冲突检查）。只读查看不监视、不回传。
#[tauri::command]
pub fn disk_edit_start(app: AppHandle, path: String, readonly: bool) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("文件不存在".into());
    }
    {
        let perm = std::fs::metadata(&p).map_err(|e| e.to_string())?.permissions();
        let mut perm = perm;
        perm.set_readonly(readonly);
        std::fs::set_permissions(&p, perm).map_err(|e| e.to_string())?;
    }
    shell_open(&path)?;
    if readonly {
        return Ok(()); // 只读查看：不监视
    }
    let app2 = app.clone();
    let path2 = path.clone();
    std::thread::spawn(move || {
        let p = PathBuf::from(&path2);
        let init_mtime = std::fs::metadata(&p).and_then(|m| m.modified()).ok();
        // Office 锁文件：同目录「~$文件名」（Word/Excel/PPT/WPS 均会生成，关闭即消失）
        let fname = p
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let lockfile = p.with_file_name(format!("~${fname}"));
        std::thread::sleep(EDIT_GRACE);
        let deadline = std::time::Instant::now() + EDIT_WATCH_MAX;
        let mut released = false;
        while std::time::Instant::now() < deadline {
            // 释放判定：无 ~$ 锁文件 且 文件可写方式打开（编辑器独占锁已消失）
            let lock_gone = !lockfile.exists();
            let can_write = std::fs::OpenOptions::new().write(true).open(&p).is_ok();
            if lock_gone && can_write {
                released = true;
                break;
            }
            std::thread::sleep(EDIT_POLL);
        }
        let changed = match (
            std::fs::metadata(&p).and_then(|m| m.modified()).ok(),
            init_mtime,
        ) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        };
        let _ = app2.emit(
            "disk-edit-done",
            DiskEditDone {
                path: path2,
                changed,
                timed_out: !released,
            },
        );
    });
    Ok(())
}

/// 本地建目录（含多级，幂等）：网盘同步「云→本地」方向，
/// 为云端嵌套子目录（含空目录）在本地建立镜像。
#[tauri::command]
pub fn disk_local_mkdir(dir: String) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Err("目录路径为空".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

// ---------- 空间写权限（上传/同步推送前置检查） ----------

/// 写权限缓存：space_id → (canWrite, 时刻)，TTL 10 分钟
static CAN_WRITE_CACHE: std::sync::OnceLock<Mutex<HashMap<String, (bool, std::time::Instant)>>> =
    std::sync::OnceLock::new();
const CAN_WRITE_TTL: std::time::Duration = std::time::Duration::from_secs(600);

/// 空间写权限检查（与 B/S 同源）：空间首页 nonlogin/knowledge/space/home.htm?id=<spaceId>
/// 服务端按当前用户渲染内嵌变量 `var isEdited = 'true'|'false'`，B/S 前端即以此控制
/// 上传/新建/右键菜单的显隐——取该字面量作为写权限结论（2026-10-15 实测：个人空间 true）。
#[tauri::command]
pub async fn disk_space_can_write(
    state: State<'_, std::sync::Arc<AppState>>,
    space_id: String,
) -> Result<bool, String> {
    if space_id.trim().is_empty() {
        return Err("spaceId 为空".into());
    }
    let cache = CAN_WRITE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(map) = cache.lock() {
        if let Some((v, at)) = map.get(&space_id) {
            if at.elapsed() < CAN_WRITE_TTL {
                return Ok(*v);
            }
        }
    }
    let (base, root) = base_root(&state);
    let session = session_of(&state)?;
    let client = state.client.clone();
    let url = format!("{base}/{root}/nonlogin/knowledge/space/home.htm?id={space_id}");
    let resp = client
        .get(&url)
        .header("Cookie", &session)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| format!("空间首页请求失败: {e}（会话可能已过期）"))?;
    let html = resp.text().await.map_err(|e| e.to_string())?;
    // var isEdited = 'true' || 'false' —— 服务端把真实值渲染在第一个引号字面量里
    let mut can = false;
    if let Some(i) = html.find("isEdited") {
        let rest = &html[i..];
        if let Some(q1) = rest.find('\'') {
            if let Some(q2) = rest[q1 + 1..].find('\'') {
                can = &rest[q1 + 1..q1 + 1 + q2] == "true";
            }
        }
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(space_id.clone(), (can, std::time::Instant::now()));
    }
    Ok(can)
}
