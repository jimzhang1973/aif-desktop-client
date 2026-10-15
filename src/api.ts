import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface TodoRow {
  id: string;
  title: string;
  url: string;
  done: boolean;
  updated_at: number;
}

export interface MessageRow {
  id: string;
  title: string;
  body: string;
  url: string;
  received_at: number;
  /** 勿扰/静音命中的消息：不响铃不弹 toast（角标照常）；缺省视为未静音 */
  muted?: boolean;
}

export interface HistoryMessage {
  id: string;
  title: string;
  body: string;
  sender: string;
  time_str: string;
  url: string;
  source: string;
  mc: string;
}

export interface MatterBadge {
  label: string;
  count: number;
  tone: "red" | "green" | "blue" | "gray";
  /** 该统计对应跳转 URL（如 待办→待办页）；空=仅展示不可点 */
  url: string;
}

/// 多标签页视图模型（与 Rust tabs::TabInfo 对应）
export interface TabInfo {
  /// webview label（tab-N），同时作为前端 data-id
  id: string;
  title: string;
  url: string;
  active: boolean;
  /** true = webview 已休眠销毁，点击激活时按 url 重新加载 */
  hibernated: boolean;
}

export interface MatterRow {
  category: "received" | "filling" | "flow";
  id: string;
  title: string;
  tag: string;
  time_str: string;
  badges: MatterBadge[];
  url: string;
}

export interface Settings {
  base_url: string;
  api_messages: string;
  api_todos: string;
  poll_interval_secs: number;
  post_login_path: string;
  remember_password: boolean;
  auto_login: boolean;
  autostart: boolean;
  sound: string;
  ops_product: boolean;
  hotkey: string;
  /** 重启后恢复上次的标签页列表（默认 false） */
  tab_restore: boolean;
  /** 多入口切换：开启后全屏顶栏出现「切换入口」按钮（默认 false） */
  multi_entry: boolean;
  /** 勿扰时段开关（默认 false）：时段内新消息不弹窗/不响铃/不闪托盘 */
  notify_dnd_enabled: boolean;
  /** 勿扰开始 "HH:MM"（默认 22:00，支持跨午夜） */
  notify_dnd_start: string;
  /** 勿扰结束 "HH:MM"（默认 08:00） */
  notify_dnd_end: string;
  /** 静音关键词（逗号分隔）：标题/正文命中即不弹窗不响铃（角标照常） */
  notify_mute_keywords: string;
  /** 待办超时提醒阈值（天，默认 2；0=关闭） */
  todo_escalate_days: number;
  /** 每日定时摘要（默认 false）：每天固定时间推送待办/新消息汇总 */
  daily_digest_enabled: boolean;
  /** 每日摘要推送时间 "HH:MM"（默认 09:00） */
  daily_digest_time: string;
  /** 导航栏图标下显示 2 字功能名称（默认 false：只显示图标） */
  nav_show_labels: boolean;
}

export interface UserInfo {
  user_name: string;
  role_name: string;
  unit_name: string;
  account: string;
}

export interface CredentialHint {
  username: string;
  has_password: boolean;
}

export interface RoleOption {
  id: string;
  name: string;
  /** 角色键（SystemManager/Teacher…），与首页注入 currentRoleKey 对位 */
  role_key?: string;
}

export interface OpsApp {
  id: string;
  name: string;
  leader: string;
  unit: string;
  status: "normal" | "alert";
  event: string;
  icon: string;
  url: string;
}

export interface OpsAppGroup {
  id: string;
  name: string;
  apps: OpsApp[];
}

/** 授权智能体（B/S「AI 问答」入口：POST ai/persona/agent/authorized.htm） */
export interface AiAgent {
  id: string;
  name: string;
  description: string;
  icon: string;
}

/** 快捷功能（B/S「快捷入口」：GET busexpress/showpage/queryListByRole.htm） */
export interface QuickEntry {
  id: string;
  name: string;
  url: string;
  icon: string;
}

/** 常用入口（多网址账号组，密码 SM4 加密存本地；明文仅供登录表单自动填充） */
export interface AccountEntry {
  ops: boolean;
  url: string;
  username: string;
  password: string;
  /** 备注（最多 6 个汉字，用于分组与顶栏展示） */
  remark: string;
}

export interface DocRow {
  id: string;
  title: string;
  space_name: string;
  file_type: string;
  atype: string;
  url: string;
  /** 最近打开/更新时间（后端按候选键提取，取不到为空串） */
  time_str: string;
  /** 最近浏览人/创建人（browse=uname，其余=createName；取不到为空串） */
  user_name: string;
}

export interface SpaceRow {
  id: string;
  name: string;
  remark: string;
  dept: string;
  color: string;
  collected: boolean;
  url: string;
  /** 空间分类名（spaceType 经字典映射；空串=未分类） */
  category: string;
}

export const _apiRaw = {
  isLoggedIn: () => invoke<boolean>("is_logged_in"),
  logout: () => invoke("logout"),
  quitApp: () => invoke("quit_app"),
  getTodos: () => invoke<TodoRow[]>("get_todos"),
  getMessages: () => invoke<MessageRow[]>("get_messages"),
  getHistoryMessages: (source: string, key: string, pageIndex: number, pageSize: number) =>
    invoke<HistoryMessage[]>("get_message_history", { source, key, pageIndex, pageSize }),
  getMatters: () => invoke<MatterRow[]>("get_matters"),
  markTodoDone: (id: string, done: boolean) =>
    invoke("mark_todo_done", { id, done }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (s: Settings) => invoke("save_settings", { settings: s }),
  // 应用版本号：5.0.1+build-id（build-id 由编译器每次编译累加）
  getAppVersion: () => invoke<string>("get_app_version"),
  checkNow: () => invoke("check_now"),
  openConversation: (url: string) => invoke("open_conversation", { url }),
  // 本地登录
  getCredentialHint: () => invoke<CredentialHint>("get_credential_hint"),
  checkCaptchaRequired: (uname: string) =>
    invoke<boolean>("check_captcha_required", { uname }),
  getCaptcha: () => invoke<{ image_base64: string }>("get_captcha"),
  loginLocal: (uname: string, pwd: string, verification: string, remember: boolean) =>
    invoke("login_local", { uname, pwd, verification, remember }),
  tryAutoLogin: () => invoke<boolean>("try_auto_login"),
  getUserInfo: () => invoke<UserInfo>("get_user_info"),
  getRoles: () => invoke<RoleOption[]>("get_roles"),
  switchRole: (roleId: string) => invoke("switch_role", { roleId }),
  getDocs: (category: string, pageIndex = 0, pageSize = 20) =>
    invoke<DocRow[]>("get_docs", { category, pageIndex, pageSize }),
  getSpaces: (category: string) => invoke<SpaceRow[]>("get_spaces", { category }),
  // 运维产品（AIF）应用中心：按应用类型分组的应用清单
  getOpsApps: () => invoke<OpsAppGroup[]>("get_ops_apps"),
  // AI 问答：当前账号授权的智能体列表（前端拼 ai/chat/index.htm?aiAgentId=<id> 打开）
  // force=true 旁路 Rust 1h 缓存强制拉取（标题栏刷新按钮用）；平时走缓存低频更新
  getAiAgents: (force = false) => invoke<AiAgent[]>("get_ai_agents", { force }),
  // 快捷功能：B/S「快捷入口」清单（九宫格卡片）
  getQuickEntries: () => invoke<QuickEntry[]>("get_quick_entries"),
  // B/S 页面 window.close() 转交：关闭调用方 webview（面板隐藏/弹窗关闭/主窗隐藏）
  closeWebviewSelf: () => invoke("close_webview_self"),
  // 调用系统默认浏览器打开外部链接
  openExternal: (url: string) => invoke("open_external", { url }),
  setAutostart: (enable: boolean) => invoke("set_autostart", { enable }),
  // 设置/注销全局快捷键（空串=注销），成功后随设置持久化
  setHotkey: (hotkey: string) => invoke("set_hotkey", { hotkey }),
  /** 稍后提醒到期：重发一条系统通知（点击可跳回消息） */
  fireSnooze: (title: string, body: string, url: string) => invoke("fire_snooze", { title, body, url }),
  /** 迷你速览条开关：屏幕右缘常置小窗（创建 / 关闭） */
  toggleMiniBar: (enable: boolean) => invoke("toggle_mini_bar", { enable }),
  // 常用入口（多网址账号组，SM4 国密加密落盘；主键 项目+网址+账号，支持同项目多账号）
  accountList: () => invoke<AccountEntry[]>("account_list"),
  accountSave: (ops: boolean, url: string, username: string, password: string, remark: string) =>
    invoke("account_save", { ops, url, username, password, remark }),
  accountDelete: (ops: boolean, url: string, username: string) =>
    invoke("account_delete", { ops, url, username }),
  // ---- 多标签页（全屏三栏；x/y/w/h 为物理像素，窗口客户区左上原点）----
  // 打开/新建标签（url 空串 = 当前入口落地页）；达到 8 个上限时 reject
  tabOpen: (url: string, x: number, y: number, w: number, h: number) =>
    invoke<TabInfo>("tab_open", { url, x, y, w, h }),
  tabActivate: (id: string) => invoke<TabInfo[]>("tab_activate", { id }),
  tabClose: (id: string) => invoke<TabInfo[]>("tab_close", { id }),
  tabCloseOthers: (id: string) => invoke<TabInfo[]>("tab_close_others", { id }),
  tabCloseAll: () => invoke<TabInfo[]>("tab_close_all"),
  tabReload: (id: string) => invoke<TabInfo[]>("tab_reload", { id }),
  tabList: () => invoke<TabInfo[]>("tab_list_cmd"),
  // resize/折叠列表页后上报标签视口 rect
  tabBounds: (x: number, y: number, w: number, h: number) =>
    invoke("tab_bounds", { x, y, w, h }),
  // 主窗模态框（入口切换弹窗等）打开期间临时隐藏/恢复全部标签
  tabHideAll: () => invoke("tab_hide_all"),
  tabRestoreAll: () => invoke("tab_restore_all"),
  // 重启后恢复上次标签页（设置开启时由进入全屏模式触发）
  tabRestoreSession: () => invoke<TabInfo[]>("tab_restore_session"),
  // 单标签模式：在已有标签内重新加载到新 URL（更新而非新建）
  tabNavigate: (id: string, url: string) => invoke<TabInfo[]>("tab_navigate", { id, url }),
  // ---- 网盘（个人空间 + 有权限空间：目录浏览 / 批量上传 / 批量下载）----
  diskPersonalSpaceId: () => invoke<string>("disk_personal_space_id"),
  diskTree: (spaceId: string) => invoke<DiskNode[]>("disk_tree", { spaceId }),
  diskNodes: (spaceId: string, nodeId: string, nodeType: string) =>
    invoke<DiskNode[]>("disk_nodes", { spaceId, nodeId, nodeType }),
  diskUploadFiles: (spaceId: string, subjectId: string, paths: string[]) =>
    invoke<void>("disk_upload_files", { spaceId, subjectId, paths }),
  diskDownloadFiles: (items: DiskDlItem[], destDir: string, overwrite = false) =>
    invoke<void>("disk_download_files", { items, destDir, overwrite }),
  /** 递归扫描本地目录（网盘同步「本地→云端」用） */
  diskLocalScan: (dir: string) => invoke<DiskLocalFile[]>("disk_local_scan", { dir }),
  /** 本地建目录（含多级，幂等）：同步「云→本地」方向镜像云端子目录（含空目录） */
  diskLocalMkdir: (dir: string) => invoke<void>("disk_local_mkdir", { dir }),
  /** 空间写权限（B/S 空间首页 isEdited 同源判定，10 分钟缓存） */
  diskSpaceCanWrite: (spaceId: string) => invoke<boolean>("disk_space_can_write", { spaceId }),
  // 本地编辑支持：编辑暂存目录 / 文本读写（MD 编辑器）/ 同目录另存副本 / 拉起编辑器+锁监视
  diskEditDir: () => invoke<string>("disk_edit_dir"),
  diskFileText: (path: string, content?: string) =>
    invoke<string | null>("disk_file_text", { path, content: content ?? null }),
  diskFileCopy: (src: string) => invoke<string>("disk_file_copy", { src }),
  diskEditStart: (path: string, readonly: boolean) =>
    invoke<void>("disk_edit_start", { path, readonly }),
  diskDelete: (articleIds: string[], subjectIds: string[]) =>
    invoke<DiskDeleteResult>("disk_delete", { articleIds, subjectIds }),
  /** 新建目录（B/S knowledge/subject/save.htm，data=JSON 包裹） */
  diskCreateDir: (spaceId: string, parentId: string, name: string) =>
    invoke<DiskCreateDirResult>("disk_create_dir", { spaceId, parentId, name }),
  diskRegisterContextMenu: (enable: boolean) => invoke<void>("disk_register_context_menu", { enable }),
  diskContextMenuStatus: () => invoke<boolean>("disk_context_menu_status"),
};

/** 网盘目录树节点（B/S knowledge space findTree/findTreeByNodeId） */
export interface DiskNode {
  id: string;
  name: string;
  pid: string;
  /** 祖先链（尾部含自身 id） */
  pids: string;
  nodeType: "subject" | "article";
  isLeaf: boolean;
  /** article 类型：FILE / DOC / RICHTEXT / EXCEL / COLLEXCEL */
  subtype: string;
  /** FILE 型文章的扩展名 */
  subFileType: string;
  updateTime: number;
}

/** 批量下载项（relDir = 相对所选目录的子目录链，如 "2024年工作/例子"） */
export interface DiskDlItem {
  articleId: string;
  name: string;
  relDir: string;
  /** FILE=附件直下；其余=在线文档（服务端转 DOCX 导出） */
  subtype: string;
}

/** 删除结果（逐条明细，用于传输管理器 ✓✗ 结论列） */
export interface DiskDeleteItem {
  id: string;
  kind: "file" | "dir";
  ok: boolean;
  msg: string | null;
}

/** 本地目录扫描项（网盘同步「本地→云端」用） */
export interface DiskLocalFile {
  relPath: string;
  name: string;
  size: number;
  /** 本地最后修改时间（epoch 秒） */
  mtime: number;
}

/** 删除结果汇总（先删文件，后删目录；在线文档由前端调用前排除） */
export interface DiskDeleteResult {
  deletedFiles: number;
  deletedDirs: number;
  failed: string[];
  items: DiskDeleteItem[];
}

/** 新建目录结果（id=B/S 返回的目录 id，ok=false 时 msg 含原因） */
export interface DiskCreateDirResult {
  id: string;
  ok: boolean;
  msg: string | null;
}

export function on<T>(event: string, cb: (p: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload as T));
}

// [临时诊断] invoke 探针：每条命令 start/ok/err 都经 trace_invoke 落 Rust 日志，
// 用于定位「列表骨架屏永不结束」的挂起命令。确认根因后整体删除本段并把 _apiRaw 改回 api。
const _trace = (cmd: string, phase: string) => {
  try {
    invoke("trace_invoke", { cmd, phase }).catch(() => {});
  } catch {
    /* ignore */
  }
};

export const api = new Proxy(_apiRaw, {
  get(target, prop, recv) {
    const orig = Reflect.get(target, prop, recv);
    if (typeof orig !== "function") return orig;
    return (...args: unknown[]) => {
      const cmd = String(prop);
      _trace(cmd, "start");
      const r = Promise.resolve((orig as (...a: unknown[]) => unknown).apply(target, args));
      r.then(
        () => _trace(cmd, "ok"),
        (e) => {
          console.warn(`[ipc✗] ${cmd}`, e);
          _trace(cmd, "err");
        },
      );
      return r;
    };
  },
});
