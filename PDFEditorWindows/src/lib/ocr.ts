import { createWorker, OEM } from "tesseract.js";
import type { OcrLine, Rect } from "../engine/types";
import { refresh } from "../state/actions";
import { type DocTab, setState, toast } from "../state/store";
import { api } from "./api";
import { engine } from "./engine";

export type OcrLanguage = "chi_tra" | "chi_sim" | "eng" | "jpn";

export const OCR_LANGUAGES: Array<[OcrLanguage, string]> = [
  ["chi_tra", "繁體中文＋英文"],
  ["chi_sim", "簡體中文＋英文"],
  ["eng", "英文"],
  ["jpn", "日文＋英文"],
];

const DPI = 300;

/** 語言資料與辨識核心都隨程式安裝，離線即可使用。 */
function assetUrl(path: string): string {
  return new URL(path, window.location.href).href;
}

/** Tesseract 在中日文字之間會插入空白，移除後才方便搜尋。 */
export function cleanOcrText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/([⺀-鿿豈-﫿＀-￯])\s+(?=[⺀-鿿豈-﫿＀-￯])/g, "$1")
    .trim();
}

export async function runOcr(tab: DocTab, pages: number[], language: OcrLanguage, onlyEmpty: boolean) {
  const targets: number[] = [];
  for (const page of pages) {
    if (!onlyEmpty || !(await engine.hasText(tab.engineId, page))) targets.push(page);
  }
  if (!targets.length) {
    toast("選取的頁面都已經有文字，不需要辨識");
    return;
  }

  const langs = language === "eng" ? ["eng"] : [language, "eng"];
  setState({ progress: { title: "正在載入文字辨識引擎…", done: 0, total: targets.length } });
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let lineCount = 0;
  try {
    worker = await createWorker(langs, OEM.LSTM_ONLY, {
      workerPath: assetUrl("ocr/worker.min.js"),
      corePath: assetUrl("ocr/core"),
      langPath: assetUrl("ocr/lang"),
      gzip: true,
      workerBlobURL: false,
      cacheMethod: "none",
    });
    for (const [i, page] of targets.entries()) {
      setState({ progress: { title: `正在辨識第 ${page + 1} 頁（${i + 1}/${targets.length}）…`, done: i, total: targets.length } });
      const png = await engine.exportPageImage(tab.engineId, page, DPI, "png");
      const { data } = await worker.recognize(new Blob([png as BlobPart], { type: "image/png" }), {}, { blocks: true });
      const lines: OcrLine[] = [];
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const text = cleanOcrText(line.text);
            if (!text || line.confidence < 20) continue;
            const k = 72 / DPI;
            const bbox: Rect = [line.bbox.x0 * k, line.bbox.y0 * k, line.bbox.x1 * k, line.bbox.y1 * k];
            lines.push({ text, bbox });
          }
        }
      }
      lineCount += lines.length;
      if (lines.length) await engine.applyOcr(tab.engineId, page, lines);
    }
    await refresh(tab.key);
    toast(`文字辨識完成：${targets.length} 頁，${lineCount} 行文字`);
  } catch (error) {
    await api().message({ type: "error", message: "文字辨識失敗", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    await worker?.terminate();
    setState({ progress: null });
  }
}
