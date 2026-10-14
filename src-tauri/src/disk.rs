//! 网盘（个人空间 + 有权限空间）轻量传输：目录浏览、批量上传/下载、
//! 资源管理器右键「上传到个人空间」注册（HKCU 静态 verb，MVP 路线 A）。
//!
//! B/S 接口（2026-10-14 双产品实测，详见 docs/网盘个人空间同步-技术业务分析.md）：
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
use tauri::{AppHandle, Emitter, State};

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
) -> Result<(), String> {
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
                format!(
                    "{base}/{root}/nonlogin/knowledge/transfer/download.htm?id={}&type=0&exportType=DOCX",
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
                    let path = nonconflict_path(&dir, &name);
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

/// 批量上传本地文件到指定空间/目录（两阶段：先传文件再 fileSave 落库，20 个/批）
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
        let total = paths.len() as u32;
        let mut refs: Vec<UploadResp> = Vec::new();
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
            if let Ok(meta) = std::fs::metadata(&path) {
                if meta.len() > MAX_UPLOAD_BYTES {
                    let _ = app.emit(
                        "disk-progress",
                        fail("超过单文件 100MB 上限（B/S 限制）".into()),
                    );
                    continue;
                }
            }
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
                            let _ = app.emit(
                                "disk-progress",
                                DiskProgress {
                                    kind: "upload".into(),
                                    file: fname,
                                    done,
                                    total,
                                    ok: true,
                                    msg: "已上传，待登记".into(),
                                },
                            );
                            refs.push(up);
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
        // 第二阶段：fileSave 分批落库（≤20/批）
        for chunk in refs.chunks(FILESAVE_BATCH) {
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

/// 注册/注销资源管理器右键「上传到个人空间」（HKCU，免管理员；多选文件走 "%1" %*）
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
                "上传到巨鹏个人空间",
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
                "Player",
                "/f",
            ])?;
            // 命令模板："<exe>" --upload "%1" %* —— %1 与 %* 会使首路径重复，启动时去重
            reg_run(&[
                "add",
                &format!(r"HKCU\{REG_KEY}\command"),
                "/ve",
                "/d",
                &format!(r#""{exe}" --upload "%1" %*"#),
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

/// 解析第二实例 argv：--upload 之后的全部文件路径（去重；"%1" %* 会使首路径重复）
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
