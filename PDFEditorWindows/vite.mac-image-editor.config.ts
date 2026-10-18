import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// macOS App 的影像編輯器（WKWebView），輸出到 dist-mac-engine/image-editor/，與 PDF 引擎一起放進 App。
export default defineConfig({
  root: fileURLToPath(new URL("./src/imageEditor/mac", import.meta.url)),
  base: "./",
  plugins: [react()],
  build: {
    target: "es2020",
    outDir: fileURLToPath(new URL("./dist-mac-engine/image-editor", import.meta.url)),
    emptyOutDir: true,
  },
});
