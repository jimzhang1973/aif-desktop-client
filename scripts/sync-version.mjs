// 打包前版本同步：安装包文件名版本 = 程序内实际显示版本
//
// 程序版本编码（get_app_version，commands.rs）：
//   <Cargo.toml 的 major.minor>.<BUILD_ID>
//   BUILD_ID 由 src-tauri/build.rs 维护：源码/配置有变化触发重编译时自增 1（存 src-tauri/.build-id）
//
// 本脚本在 tauri build 的 beforeBuildCommand 中最先执行：
//   读 .build-id = n → 把 tauri.conf.json 的 version 写为 <major.minor>.<n+1>
// 时序保证一致：改 conf 本身会触发 build.rs 重跑（rerun-if-changed），本次编译
// BUILD_ID 恰为 n+1 —— 安装包名与「我的」页显示的 V x.y.z 恒相同。
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
