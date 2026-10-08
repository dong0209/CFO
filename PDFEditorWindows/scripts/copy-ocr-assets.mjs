// 將 Tesseract 的 Worker、辨識核心與語言資料複製到 public/ocr，讓 OCR 可離線使用。
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const out = join(root, "public", "ocr");
mkdirSync(join(out, "core"), { recursive: true });
mkdirSync(join(out, "lang"), { recursive: true });

const tesseractDir = dirname(require.resolve("tesseract.js/package.json"));
cpSync(join(tesseractDir, "dist", "worker.min.js"), join(out, "worker.min.js"));

const coreDir = dirname(require.resolve("tesseract.js-core/package.json"));
for (const file of readdirSync(coreDir)) {
  // 只需要 LSTM 版本（含內嵌 wasm 的 .wasm.js）
  if (/^tesseract-core(-simd|-relaxedsimd)?-lstm\.(wasm\.js|js|wasm)$/.test(file)) cpSync(join(coreDir, file), join(out, "core", file));
}

for (const lang of ["chi_tra", "chi_sim", "eng", "jpn"]) {
  const source = join(root, "node_modules", "@tesseract.js-data", lang, "4.0.0_best_int", `${lang}.traineddata.gz`);
  if (!existsSync(source)) throw new Error(`找不到語言資料：${source}`);
  cpSync(source, join(out, "lang", `${lang}.traineddata.gz`));
}
console.log("OCR 資源已複製到", out);
