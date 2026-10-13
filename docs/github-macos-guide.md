# 上传到 GitHub + 打包 macOS 应用 指南

适用范围：本项目 `aif-desktop-client`（Tauri 2 桌面客户端，巨鹏软件客户端）。
配套文件：`.github/workflows/release-macos.yml`（自动出 macOS 包）。

---

## 一、把项目上传到 GitHub

> 建议以 `aif-desktop-client/` 目录作为仓库根（里面已有 `.gitignore`，已忽略 `node_modules/`、`dist/`、`src-tauri/target/`、`*.db`、`*.log`）。
> 注意：不要在更上层的 `2026-10-11-09-08-27/` 初始化，否则会把 `.workbuddy/` 等无关目录一起提交。

### 1. 初始化并提交（在 `aif-desktop-client/` 内执行）

```bash
cd aif-desktop-client
git init
git branch -M main

# 应用类项目应提交 Cargo.lock 保证可复现构建。
# 当前 .gitignore 忽略了 src-tauri/Cargo.lock，二选一：
#   A. 编辑 .gitignore，删除/注释掉 `src-tauri/Cargo.lock` 那一行（推荐）
#   B. 或直接强制加入：git add -f src-tauri/Cargo.lock

git add .
git commit -m "chore: 初始化巨鹏软件客户端 Tauri 项目"
```

### 2. 在 GitHub 建仓库并推送

1. 打开 GitHub → New repository。
2. 仓库名建议 `aif-desktop-client`；**不要**勾选 "Initialize with README / .gitignore / LICENSE"（本地已有）。
3. 复制仓库地址（HTTPS 或 SSH）。

```bash
git remote add origin https://github.com/<你的用户名>/aif-desktop-client.git
git push -u origin main
```

### 3. 上传清单（确认不会提交敏感/体积文件）

- 已忽略（正确）：`node_modules/`、`dist/`、`src-tauri/target/`、`.db`、`.log`、`.DS_Store`。
- 需手动确认**不要**提交：任何明文 token、`.env`、密钥、`.workbuddy/`。
- 建议**提交**：`src-tauri/Cargo.lock`（见上）、`src-tauri/icons/icon.icns`（macOS 图标，已在仓库内）。

---

## 二、打包 macOS 应用

### 现实前提（很重要）

- **macOS 的 `.app`/`.dmg` 无法在 Windows 上直接产出**——打包、代码签名（`codesign`）、生成 DMG（`hdiutil`/`create-dmg`）都是 macOS 专属工具。
- 你当前是 Windows（Surface ARM64），有两条路：
  - **A. 真机打包**：在一台 Mac（或云 Mac）上本地执行命令。
  - **B. GitHub Actions 自动构建（推荐）**：用 `macos-latest` runner 出包并自动发 Release，和你“上传到 GitHub”正好衔接，无需自己有 Mac。
- 以下本地命令默认在 **macOS 环境**（真机或 CI runner）执行。

### 跨平台代码修正（必做，否则行为/链接可能异常）

`src-tauri/Cargo.toml` 当前把 keyring 的 Windows 后端写在通用 `[dependencies]` 下：

```toml
keyring = { version = "3", features = ["windows-native"] }   # ← 通用段
```

keyring 的 `windows-native` 虽被 `cfg(windows)` 屏蔽、不会在 macOS 上硬崩，但规范做法是**按平台拆分**，让 macOS 明确走 Keychain 后端（与项目里 `windows-sys` 已做的 `cfg(windows)` 拆分保持一致）：

```toml
[dependencies]
keyring = "3"
# ... 其余依赖保持不变 ...

[target.'cfg(windows)'.dependencies]
keyring = { version = "3", features = ["windows-native"] }
windows-sys = { version = "0.59", features = ["Win32_Foundation", "Win32_Graphics_Gdi"] }

[target.'cfg(target_os = "macos")'.dependencies]
keyring = { version = "3", features = ["apple-native"] }
```

> 已确认：项目其余代码对平台分支处理到位——`commands.rs`、`tray.rs` 都用 `cfg(target_os = "macos")` / `cfg(windows)` 做了分支；`main.rs` 的 `windows_subsystem = "windows"` 仅 Windows 生效，macOS 不受影响。所以上面这一处是主要的跨平台收尾。

`tauri.conf.json` 已自带 macOS 段，无需补：

```json
"macOS": { "minimumSystemVersion": "10.15", "dmg": {} }
```

图标 `src-tauri/icons/icon.icns` 已存在，DMG/APP 图标可直接用。

### A. 在 Mac 上本地打包

前置：

```bash
xcode-select --install                 # Xcode Command Line Tools（必装）
# 安装 Rust（若未装）
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Node 建议 LTS（22）
```

构建：

```bash
cd aif-desktop-client
npm install
npm run tauri build
```

产物路径：

- `src-tauri/target/release/bundle/macos/巨鹏软件客户端.app`
- `src-tauri/target/release/bundle/dmg/巨鹏软件客户端_<版本>.dmg`

### B. Apple 签名与公证（分发到其他 Mac 必需）

- 未签名/未公证的 `.app`，在别人的 Mac 上会被 Gatekeeper 拦截（“无法验证开发者”）。
- 自用/测试绕过（不推荐长期）：右键 → 打开；或 `xattr -cr /Applications/巨鹏软件客户端.app`。
- 正规分发流程：
  1. 加入 Apple Developer Program（$99/年）。
  2. 导出 **Developer ID Application** 证书到钥匙串。
  3. 设置环境变量（Tauri 2 会自动 codesign + notarize）：

     ```bash
     export APPLE_SIGNING_IDENTITY="Developer ID Application: JPSOFT Co. (TEAMID)"
     export APPLE_ID="you@example.com"
     export APPLE_PASSWORD="<app-specific-password>"
     export APPLE_TEAM_ID="TEAMID"
     ```
  4. 重新 `npm run tauri build`，自动完成签名与公证。

### C. 通用二进制（Apple Silicon + Intel 二合一）

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

产物 `.app`/`.dmg` 同时兼容 M 系列与 Intel Mac。

---

## 三、推荐：用 GitHub Actions 自动出 macOS 包

已附 `.github/workflows/release-macos.yml`：在 `macos-latest` runner 上自动 `npm install` + `tauri build --target universal-apple-darwin`，并把产物上传到 GitHub Release。

- 触发：推送 `v*` 标签，或仓库 Actions 页手动 `Run workflow`。
- 不公证也能出包（去掉签名 env 即可）；要公证则在仓库 **Settings → Secrets** 配置：
  `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`，并取消 YAML 中对应行的注释。
- 该 workflow 会执行 `beforeBuildCommand`（`node scripts/sync-version.mjs && npm run build`），版本号自动同步为 `major.minor.BUILD_ID`，与 Windows 打包逻辑一致。

发布示例：

```bash
git add .
git commit -m "ci: 添加 macOS 自动构建"
git push -u origin main
git tag v5.1.0 && git push origin v5.1.0   # 触发 macOS 构建并出 Release
```
