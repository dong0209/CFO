import { chosenFontRequest, DOWNLOADABLE_FONTS, type FontRequest } from "../engine/fonts";
import type { FontData } from "../engine/pdfEngine";
import { api, type ResolvedFont } from "./api";

/** 字型選單的選擇：自動（依原字型辨識）、電腦上的字型、或可下載的開源字型。 */
export type FontChoice = { kind: "auto" } | { kind: "system" | "download"; family: string };

export const AUTO_FONT: FontChoice = { kind: "auto" };

export function choiceKey(choice: FontChoice): string {
  return choice.kind === "auto" ? "auto" : `${choice.kind}:${choice.family}`;
}

export function parseChoice(key: string): FontChoice {
  const [kind, ...rest] = key.split(":");
  if ((kind === "system" || kind === "download") && rest.length) return { kind, family: rest.join(":") };
  return AUTO_FONT;
}

let familiesPromise: Promise<Array<{ family: string; label: string }>> | null = null;

/** 電腦上已安裝的字族（只讀取一次）。 */
export function systemFamilies(): Promise<Array<{ family: string; label: string }>> {
  familiesPromise ??= api()
    .listFonts()
    .catch(() => []);
  return familiesPromise;
}

export const downloadableFamilies = DOWNLOADABLE_FONTS;

/** 依選擇找出字型檔：自動時使用 `autoRequest`（原字型辨識結果），並套用粗體／斜體。 */
export async function resolveChoice(choice: FontChoice, bold: boolean, italic: boolean, autoRequest: FontRequest | null): Promise<{ font: ResolvedFont | null; request: FontRequest | null }> {
  const weight = bold ? 700 : 400;
  let request: FontRequest | null;
  if (choice.kind === "auto") {
    request = autoRequest ? { ...autoRequest, weight: bold && autoRequest.weight < 600 ? 700 : !bold && autoRequest.weight >= 600 ? 400 : autoRequest.weight, italic } : null;
  } else {
    request = chosenFontRequest(choice.family, weight, italic, choice.kind === "download");
  }
  if (!request) return { font: null, request: null };
  const font = await api().resolveFont(request).catch(() => null);
  return { font, request };
}

/** 新文字含有中日韓文字、而字型可能缺字時，另外找一個中文備援字型。 */
export async function resolveFallback(request: FontRequest | null, text: string): Promise<ResolvedFont | null> {
  if (!request?.fallback || !/[⺀-鿿豈-﫿＀-￯]/.test(text)) return null;
  return api()
    .resolveFont({ ...request, system: request.fallback.system, downloads: request.fallback.downloads, fallback: null })
    .catch(() => null);
}

export function fontData(font: ResolvedFont | null): FontData | null {
  return font ? { data: font.data, index: font.index } : null;
}

const previewFaces = new Map<string, Promise<string | null>>();
let faceCounter = 0;

/** 讓畫面以找到的字型預覽；回傳 CSS 字族名稱（字型集合 .ttc 無法直接載入時回傳 null）。 */
export function previewFamily(font: ResolvedFont | null): Promise<string | null> {
  if (!font || font.index !== 0) return Promise.resolve(null);
  const key = `${font.name}|${font.data.byteLength}`;
  let promise = previewFaces.get(key);
  if (!promise) {
    promise = (async () => {
      try {
        const name = `PEFont${++faceCounter}`;
        const face = new FontFace(name, font.data.slice().buffer as ArrayBuffer);
        await face.load();
        document.fonts.add(face);
        return name;
      } catch {
        return null;
      }
    })();
    previewFaces.set(key, promise);
  }
  return promise;
}

export function describeFont(font: ResolvedFont): string {
  return `${font.name}（${font.source === "system" ? "電腦上的字型" : "已下載"}）`;
}
