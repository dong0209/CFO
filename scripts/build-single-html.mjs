/**
 * 產生單一檔案的 HTML 控制介面
 * ------------------------------------------------------------------
 * 目標：使用者不必安裝 node、不必跑 build，直接用瀏覽器開啟一個 .html 就能操作系統。
 *
 * 兩項刻意的選擇：
 *  1. 輸出格式為 IIFE 而非 ES module —— 以 file:// 開啟時，某些瀏覽器對
 *     `<script type="module">` 的來源限制較嚴，傳統 script 相容性最高。
 *  2. CSS 與 JS 全部內嵌 —— 單一檔案可直接以附件寄送、放共用磁碟或存進文件管理系統。
 *
 * 用法：
 *   node scripts/build-single-html.mjs                    → cfo-console.html（完整文件）
 *   node scripts/build-single-html.mjs --body <輸出路徑>   → 僅 body 內容（供嵌入用）
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'

const OUT_DIR = 'dist-single'
const TITLE = 'CFO 管理系統｜公開發行公司財務長工作台'

/** 內嵌時必須切斷任何會提前關閉 script 區塊的字串 */
const safeForScriptTag = (js) => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')

async function main() {
  rmSync(OUT_DIR, { recursive: true, force: true })

  await build({
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      cssCodeSplit: false,
      reportCompressedSize: false,
      rollupOptions: {
        output: {
          format: 'iife',
          entryFileNames: 'app.js',
          assetFileNames: 'app[extname]',
        },
      },
    },
  })

  const jsPath = join(OUT_DIR, 'app.js')
  const cssPath = join(OUT_DIR, 'app.css')
  if (!existsSync(jsPath)) throw new Error(`找不到 ${jsPath}，vite 輸出檔名可能已變更`)

  const js = safeForScriptTag(readFileSync(jsPath, 'utf8'))
  const css = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : ''

  const bodyIndex = process.argv.indexOf('--body')
  if (bodyIndex !== -1) {
    const target = process.argv[bodyIndex + 1]
    if (!target) throw new Error('--body 需要指定輸出路徑')
    // 供 Artifact 等會自行包上 <html>/<head>/<body> 的環境使用
    writeFileSync(target, `<title>${TITLE}</title>\n<style>\n${css}\n</style>\n<div id="root"></div>\n<script>\n${js}\n</script>\n`)
    report(target)
    return
  }

  const html = `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${TITLE}</title>
<!--
  單一檔案控制介面 — 由 npm run build:html 產生，請勿直接編輯。
  修改請至 src/ 後重新產生。資料儲存於瀏覽器 localStorage，不會離開這台電腦。
-->
<style>
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>
${js}
</script>
</body>
</html>
`
  writeFileSync('cfo-console.html', html)
  report('cfo-console.html')
}

function report(path) {
  const kb = (readFileSync(path).length / 1024).toFixed(0)
  console.log(`✓ ${path}（${kb} KB，單一檔案、無外部相依）`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
