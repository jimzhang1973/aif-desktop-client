// 打包前版本同步：安装包文件名版本 = 程序内实际显示版本
//
// 程序版本编码（get_app_version，commands.rs）：
//   <Cargo.toml 的 major.minor>.<BUILD_ID>
//   BUILD_ID 唯一事实源 = 本脚本（beforeBuildCommand 第一步）：读 .build-id = n
//   → +1 写回文件 + 写 tauri.conf.json version 为 <major.minor>.<n+1>。
//   build.rs 只读 .build-id 注入 rustc-env，不自增——无论打包期间 build.rs
//   重跑多少次，二进制内 BUILD_ID 恒等于文件名版本（曾因编译期自增漂移错位）。
// （重大版本升级只改 Cargo.toml 的 major.minor，conf patch 位由本脚本自动维护。）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cargoToml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
const m = cargoToml.match(/^version\s*=\s*"(\d+)\.(\d+)\./m);
if (!m) {
  console.error("[sync-version] Cargo.toml 中未找到 version，跳过同步");
  process.exit(1);
}
const major = m[1];
const minor = m[2];

const idFile = join(root, "src-tauri/.build-id");
const n = existsSync(idFile) ? parseInt(readFileSync(idFile, "utf8").trim(), 10) || 0 : 0;
const next = n + 1;
// 版本推进的唯一事实源在这里（build.rs 只读不自增）：写回文件让
// build.rs 的 rustc-env=BUILD_ID 拿到同一值，包名 == 程序内显示版本
writeFileSync(idFile, String(next));
const ver = `${major}.${minor}.${next}`;

const confPath = join(root, "src-tauri/tauri.conf.json");
const conf = readFileSync(confPath, "utf8");
if (!/"version"\s*:/.test(conf)) {
  console.error("[sync-version] tauri.conf.json 中未找到 version 字段，跳过同步");
  process.exit(1);
}
const updated = conf.replace(/("version"\s*:\s*")[^"]*(")/, `$1${ver}$2`);
writeFileSync(confPath, updated, "utf8");
console.log(`[sync-version] 安装包版本同步为 ${ver}（build-id ${n} -> ${next}）`);
