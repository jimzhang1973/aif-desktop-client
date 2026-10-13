import { defineConfig } from "vite";

// Tauri 期望一个固定的端口与关闭清屏；输出到 ./dist（项目根相对），对应 src-tauri 的 frontendDist=../dist。
export default defineConfig({
  clearScreen: false,
  // 相对路径：打包后资源（如 sounds/*.wav）在 tauri:// 协议下按相对位置加载
  base: "./",
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // 关键：排除 src-tauri（尤其 target/），否则 cargo 编译时锁定 .exe
      // 会导致 chokidar EBUSY 崩溃，进而杀死 tauri dev 的 beforeDevCommand
      ignored: ["**/src-tauri/**", "**/dist/**", "**/node_modules/**"],
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2021",
    // 多页入口：主面板 index.html + 迷你速览条 mini.html（Rust 侧 WebviewUrl::App 加载）
    rollupOptions: {
      input: {
        main: "index.html",
        mini: "mini.html",
      },
    },
  },
});
