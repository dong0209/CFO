import { DOWNLOADABLE_FONTS } from "../engine/fonts";
import type { ImageEditObject } from "../engine/types";
import { api } from "../lib/api";
import { fontData, previewFamily, resolveChoice, resolveFallback } from "../lib/fonts";
import type { EditorFontChoice, EditorHost, EditorResult } from "./model";

/** Windows 版（Electron）提供給影像編輯器的功能。 */
export const windowsHost: EditorHost = {
  async listFonts() {
    const families = await api().listFonts().catch(() => []);
    const preferred = ["Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC"].find((name) => families.some((f) => f.family === name));
    const defaultChoice: EditorFontChoice = preferred ? { kind: "system", family: preferred } : { kind: "download", family: "Noto Sans TC" };
    return { families, downloadable: DOWNLOADABLE_FONTS, defaultChoice };
  },
  async previewFont(choice, bold, italic) {
    if (choice.kind === "system") return choice.family;
    const { font } = await resolveChoice(choice, bold, italic, null);
    return previewFamily(font);
  },
  async pickImage() {
    const [file] = await api().openFiles("images", false, "選擇要插入的圖片");
    return file?.data ?? null;
  },
};

/** 為每個文字物件找到字型檔（含中文備援字型），轉成 PDF 引擎使用的格式。 */
export async function resolveEditorFonts(result: EditorResult): Promise<ImageEditObject[]> {
  return Promise.all(
    result.objects.map(async (obj) => {
      if (obj.type !== "text") return obj;
      const { choice, ...rest } = obj;
      const { font, request } = await resolveChoice(choice, obj.bold, obj.italic, null);
      const fallback = await resolveFallback(request, obj.text);
      return { ...rest, family: choice.family, font: fontData(font), fallbackFont: fontData(fallback) };
    }),
  );
}
