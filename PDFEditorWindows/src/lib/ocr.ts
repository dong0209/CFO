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
const LANGUAGE_KEY = "pdfeditor.ocr.language";

/** 上次文字辨識使用的語言（框選範圍重新辨識時沿用）。 */
export function lastOcrLanguage(): OcrLanguage {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (OCR_LANGUAGES.some(([value]) => value === saved)) return saved as OcrLanguage;
  } catch {
    // 沒有紀錄
  }
  return "chi_tra";
}

function rememberLanguage(language: OcrLanguage) {
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    // 無法儲存時略過
  }
}

function createOcrWorker(language: OcrLanguage) {
  const langs = language === "eng" ? ["eng"] : [language, "eng"];
  return createWorker(langs, OEM.LSTM_ONLY, {
    workerPath: assetUrl("ocr/worker.min.js"),
    corePath: assetUrl("ocr/core"),
    langPath: assetUrl("ocr/lang"),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: "none",
  });
}

let regionWorker: { language: OcrLanguage; worker: ReturnType<typeof createOcrWorker> } | null = null;

/**
 * 重新辨識頁面上框選的範圍（頁面座標）：回傳辨識出的文字（多行以空白連接）與文字實際所在的外框。
 * 辨識引擎載入後會保留，下次框選時不必重新載入。
 */
export async function recognizeRegion(engineId: number, pageIndex: number, rect: Rect): Promise<{ text: string; box: Rect | null }> {
  const language = lastOcrLanguage();
  if (regionWorker?.language !== language) {
    const previous = regionWorker;
    regionWorker = { language, worker: createOcrWorker(language) };
    previous?.worker.then((w) => w.terminate()).catch(() => {});
  }
  let worker: Awaited<ReturnType<typeof createOcrWorker>>;
  try {
    worker = await regionWorker.worker;
  } catch (error) {
    regionWorker = null;
    throw error;
  }
  const png = await engine.regionImage(engineId, pageIndex, rect, DPI);
  const { data } = await worker.recognize(new Blob([png as BlobPart], { type: "image/png" }), {}, { blocks: true });
  const k = 72 / DPI;
  const x0 = Math.min(rect[0], rect[2]);
  const y0 = Math.min(rect[1], rect[3]);
  const texts: string[] = [];
  let box: Rect | null = null;
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        const text = cleanOcrText(line.text);
        if (!text || line.confidence < 10) continue;
        texts.push(text);
        const b: Rect = [x0 + line.bbox.x0 * k, y0 + line.bbox.y0 * k, x0 + line.bbox.x1 * k, y0 + line.bbox.y1 * k];
        box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
      }
    }
  }
  return { text: cleanOcrText(texts.join(" ")), box };
}

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

  rememberLanguage(language);
  setState({ progress: { title: "正在載入文字辨識引擎…", done: 0, total: targets.length } });
  let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
  let lineCount = 0;
  try {
    worker = await createOcrWorker(language);
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
