// 以 MuPDF 繪製 App 圖示並輸出 512×512 PNG（electron-builder 會再轉成 .ico）。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 以 1024×1024 的 PDF 座標（原點在左下）繪製
function roundedRect(x, y, w, h, r) {
  const k = 0.5523 * r;
  return [
    `${x + r} ${y} m`, `${x + w - r} ${y} l`, `${x + w - r + k} ${y} ${x + w} ${y + r - k} ${x + w} ${y + r} c`,
    `${x + w} ${y + h - r} l`, `${x + w} ${y + h - r + k} ${x + w - r + k} ${y + h} ${x + w - r} ${y + h} c`,
    `${x + r} ${y + h} l`, `${x + r - k} ${y + h} ${x} ${y + h - r + k} ${x} ${y + h - r} c`,
    `${x} ${y + r} l`, `${x} ${y + r - k} ${x + r - k} ${y} ${x + r} ${y} c`, "h",
  ].join(" ");
}

const content = [
  // 由上到下的紅色漸層（以多條色帶近似）
  "q", roundedRect(64, 64, 896, 896, 200), "W n",
  ...Array.from({ length: 64 }, (_, i) => {
    const t = i / 63;
    const r = (0.93 - 0.21 * t).toFixed(3), g = (0.27 - 0.17 * t).toFixed(3), b = (0.22 - 0.06 * t).toFixed(3);
    return `${r} ${g} ${b} rg 64 ${960 - (i + 1) * 14} 896 15 re f`;
  }),
  "Q",
  // 紙張與摺角
  "1 1 1 rg 290 180 m 734 180 l 734 714 l 604 844 l 290 844 l h f",
  "0.85 0.85 0.85 rg 604 844 m 604 714 l 734 714 l h f",
  // 文字行
  "0.75 0.75 0.75 rg",
  roundedRect(350, 690, 300, 24, 12), "f",
  roundedRect(350, 630, 300, 24, 12), "f",
  roundedRect(350, 570, 200, 24, 12), "f",
  // PDF 字樣
  "0.8 0.15 0.18 rg BT /F1 160 Tf 356 300 Td (PDF) Tj ET",
].join("\n");

const doc = new mupdf.PDFDocument();
const font = doc.addSimpleFont(new mupdf.Font("Helvetica-Bold"));
doc.insertPage(0, doc.addPage([0, 0, 1024, 1024], 0, { Font: { F1: font } }, content));
const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, true);
mkdirSync(join(root, "build"), { recursive: true });
writeFileSync(join(root, "build", "icon.png"), pixmap.asPNG());
console.log("已產生 build/icon.png");
