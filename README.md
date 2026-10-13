# 巨鹏软件客户端（aif-desktop-client）

基于 **Tauri 2** 的跨平台桌面消息提醒客户端，用于对接巨鹏 **AIF 运维平台**（`51yunwei.com.cn/AIF`）。以系统托盘常驻方式运行，轮询平台消息与待办，收到新消息时弹窗 + 系统通知提醒，并内置多标签页浏览器内核加载 B/S 业务页面，点击消息可直接跳转到对应业务界面。

> 显示名称：巨鹏软件客户端 ｜ 窗口标题：业务小助手 ｜ Bundle Identifier：`cn.aif.desktopclient` ｜ 厂商：JPSOFT Co. 2026

---

## 功能特性

- **托盘常驻**：最小化到系统托盘，支持开机自启动（autostart 插件）、全局快捷键、单实例防重复启动。
- **消息 / 待办提醒**：轮询 B/S 平台拉取消息与待办，新消息桌面弹窗 + 系统通知；通知点击可跳转对应业务 URL。
- **内置多标签页浏览器**：WebView 内核加载运维 / B/S 页面，会话自动注入（携带 `JSESSIONID`），支持多标签页、休眠与重启恢复。
- **常用入口管理**：维护项目 / 网址 / 账号 / 密码，支持静默自动登录（保险库凭据 → keyring 兜底）。
- **凭据安全存储**：Windows 凭证管理器 / macOS Keychain（keyring 按平台拆分后端）。
- **AI 问答入口**：内置 AIF 与 DCP 两套产品的 AI 问答页（会话隔离）。

---

## 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Tauri 2（Rust 后端 + WebView 前端） |
| 前端 | TypeScript + Vite（**零 CDN**，纯本地资源） |
| 后端 | Rust（tokio 异步运行时） |
| 打包 | Windows → MSI + NSIS；macOS → DMG（universal） |

关键依赖：

- `tauri`（features：`tray-icon` / `image-png` / `unstable`）
- 插件：`tauri-plugin-notification` / `single-instance` / `autostart` / `global-shortcut` / `log`
- `reqwest`（HTTP + cookie 会话）、`rusqlite`（本地 SQLite，bundled）、`serde`、`keyring`（凭据保险库）、`dirs`、`anyhow`、`base64`、`regex`

---

## 环境要求

- **Node.js** ≥ 18（建议 22 LTS）
- **Rust** ≥ 1.77（edition 2021），并安装对应平台编译目标
- **Windows**：Visual Studio Build Tools（“使用 C++ 的桌面开发” workload）或对应 MSVC 工具链
- **macOS**：Xcode Command Line Tools（`xcode-select --install`）

---

## 快速开始（开发）

```bash
cd aif-desktop-client
npm install
npm run dev         # 启动 Vite 开发服务器（http://localhost:5173）
npm run tauri dev   # 启动 Tauri 开发模式（含 Rust 编译，首次较慢）
```

> Dev 模式保留控制台窗口便于看日志；Release 模式（打包）自动隐藏 Windows 控制台黑窗。

---

## 构建与打包

前端先由 `beforeBuildCommand`（`node scripts/sync-version.mjs && npm run build`）构建到 `dist/`，再由 Tauri 打包。

### Windows（x64）

```bash
npm install
npm run tauri build --target x86_64-pc-windows-msvc
# 产物：src-tauri/target/x86_64-pc-windows-msvc/release/bundle/{msi,nsis}/
```

### Windows（arm64）

```bash
npm run tauri build --target aarch64-pc-windows-msvc
```

### macOS（通过 GitHub Actions，推荐）

仓库已内置 `.github/workflows/release-macos.yml`，在 `macos-latest` runner 上自动构建 **universal（Apple Silicon + Intel 合一）**包并发布到 Releases：

```bash
git tag v5.1.0 && git push origin v5.1.0   # 推送 v* 标签即触发自动构建
# 或：GitHub → Actions → Release macOS → Run workflow（手动触发）
```

- 未签名的产物在他人的 Mac 上会被 Gatekeeper 拦截，自用可 `xattr -cr /Applications/巨鹏软件客户端.app` 绕过；正式分发请配置 Apple 签名 / 公证 Secrets（见工作流注释）。
- 本地 macOS 打包（需 Mac 真机）：`npm run tauri build --target universal-apple-darwin`。

---

## 版本号规则

显示版本 = `<Cargo.toml 的 major.minor>.<BUILD_ID>`（例如 `V 5.1.231`）：

- `BUILD_ID` 由 `src-tauri/build.rs` 维护，源码 / 配置有变化触发重编译时自增，计数存于 `src-tauri/.build-id`。
- 安装包文件名版本由 `scripts/sync-version.mjs`（挂在 `beforeBuildCommand` 最前）自动同步为同一编码，**无需手工改** `tauri.conf.json` 的 `version`。
- 重大版本升级只需改 `Cargo.toml` 的 `major.minor`。

---

## 项目结构（关键文件）

```
aif-desktop-client/
├── src/                      # 前端（TypeScript + Vite）
├── index.html
├── vite.config.ts
├── scripts/
│   └── sync-version.mjs      # 打包前版本同步
├── .github/workflows/
│   └── release-macos.yml     # macOS 自动构建 CI
└── src-tauri/                # Rust 后端
    ├── src/
    │   ├── lib.rs / main.rs  # 入口；release 隐藏 Windows 控制台
    │   ├── commands.rs       # Tauri 命令（消息/待办/标签页/登录，含平台分支）
    │   ├── poller.rs         # 消息/待办轮询与去重
    │   ├── tray.rs           # 系统托盘
    │   ├── auth.rs           # 凭据与自动登录（keyring）
    │   ├── tabs.rs           # 多标签页 WebView 管理
    │   ├── db.rs             # 本地 SQLite（rusqlite）
    │   └── hotkey.rs / sm4.rs
    ├── build.rs              # BUILD_ID 自增与版本同步
    ├── tauri.conf.json       # Tauri 配置（productName / identifier / bundle / CSP）
    └── Cargo.toml            # 依赖（keyring 按平台拆分）
```

---

## 配置与接口

- **平台地址**：`https://51yunwei.com.cn`（CSP 已放行该域名及 `*.51yunwei.com.cn`）。
- **登录**：提交 `/AIF/login/Login.htm`；二维码登录 `/AIF/nonlogin/qrlogin/...`（客户端推荐登录方式）；会话为 `JSESSIONID` cookie。B/S 图形验证码在连续输错 3 次后触发，客户端不自动识别，需人工处理。
- **AI 问答入口**（两套会话隔离）：
  - AIF（运维）：`/AIF/ai/chat/index.htm?spaceId=&questionText=`
  - DCP（一表通）：`/DCP/ai/index.htm?spaceId=&questionText=`

---

## 注意事项

- `identifier` 固定为 `cn.aif.desktopclient`，**请勿修改**（本地 appdata 路径依赖它）。
- 应用类项目建议提交 `src-tauri/Cargo.lock` 以保证可复现构建（当前 `.gitignore` 已忽略，可自行调整）。
- 本机若 `npx tauri` 解析异常，可改用 `node node_modules/@tauri-apps/cli/tauri.js` 直接调用 CLI。

---

## 许可证

内部产品，版权归 JPSOFT Co. 2026 所有。
