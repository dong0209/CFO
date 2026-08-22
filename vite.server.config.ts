import { defineConfig } from 'vite'

/**
 * 伺服器打包設定
 * 目的是讓部署只需要「一個 .mjs 檔 + Node」：
 * 前後端共用的領域邏輯（義務主檔、變更 reducer、期程展開）會一併打包進來，
 * 因此伺服器與瀏覽器永遠執行同一份規則，不會版本分歧。
 */
export default defineConfig({
  build: {
    ssr: 'server/index.ts',
    outDir: 'dist-server',
    emptyOutDir: true,
    target: 'node20',
    minify: false,
    rollupOptions: {
      output: { format: 'esm', entryFileNames: 'index.mjs' },
    },
  },
})
