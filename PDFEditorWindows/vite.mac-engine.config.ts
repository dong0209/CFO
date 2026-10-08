import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// macOS App 內嵌的 PDF 引擎（MuPDF），輸出到 dist-mac-engine/，由 PDFEditor/scripts/build-app.sh 複製進 App。
export default defineConfig({
  root: fileURLToPath(new URL("./src/engine/mac", import.meta.url)),
  base: "./",
  optimizeDeps: { exclude: ["mupdf"] },
  build: {
    target: "esnext",
    outDir: fileURLToPath(new URL("./dist-mac-engine", import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
});
