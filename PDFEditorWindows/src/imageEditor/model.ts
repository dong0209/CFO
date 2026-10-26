import type { ImageEditObject, RGB } from "../engine/types";

/** 字型選擇：電腦上的字型或可自動下載的開源字型。 */
export type EditorFontChoice = { kind: "system" | "download"; family: string };

/** 主程式（Windows：Electron；macOS：Swift）提供給影像編輯器的功能。 */
export interface EditorHost {
  /** 電腦上的字族與預設字型 */
  listFonts(): Promise<{ families: Array<{ family: string; label: string }>; downloadable: string[]; defaultChoice: EditorFontChoice }>;
  /** 讓畫面能以這個字型預覽，回傳 CSS font-family（找不到時回傳 null） */
  previewFont(choice: EditorFontChoice, bold: boolean, italic: boolean): Promise<string | null>;
  /** 選擇要插入的圖片（PNG／JPEG），取消時回傳 null */
  pickImage(): Promise<Uint8Array | null>;
}

export interface EditorTextObject {
  id: number;
  type: "text";
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  text: string;
  size: number;
  color: RGB;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  opacity: number;
  choice: EditorFontChoice;
}

export type EditorObject =
  | EditorTextObject
  | (Extract<ImageEditObject, { type: "rect" | "ellipse" }> & { id: number })
  | (Extract<ImageEditObject, { type: "line" | "arrow" }> & { id: number })
  | (Extract<ImageEditObject, { type: "image" }> & { id: number; url: string });

/** 編輯器完成時交給主程式的結果：文字物件帶字型選擇，由主程式找到字型檔後再寫入 PDF。 */
export interface EditorResult {
  width: number;
  height: number;
  background: Uint8Array | null;
  objects: Array<Exclude<ImageEditObject, { type: "text" }> | (Extract<ImageEditObject, { type: "text" }> & { choice: EditorFontChoice })>;
}

/** 文字的基線與行高（字級倍數），與 PDF 引擎寫入時相同。 */
export const TEXT_ASCENT = 0.88;
export const TEXT_LINE_HEIGHT = 1.25;

export function hexToRgb(hex: string): RGB {
  const value = hex.replace("#", "");
  const n = parseInt(value.length === 3 ? value.split("").map((c) => c + c).join("") : value, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(color: RGB | null | undefined): string {
  if (!color) return "#000000";
  return "#" + color.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
}

export function rgbCss(color: RGB | null | undefined): string {
  return color ? `rgb(${color.map((v) => Math.round(v * 255)).join(",")})` : "none";
}

/** 把物件座標轉到旋轉／裁切後的新頁面。 */
export function transformObject(obj: EditorObject, map: (x: number, y: number) => [number, number], rotationDelta: number): EditorObject {
  if (isLine(obj)) {
    const [x1, y1] = map(obj.x1, obj.y1);
    const [x2, y2] = map(obj.x2, obj.y2);
    return { ...obj, x1, y1, x2, y2 };
  }
  // 以中心點轉換，寬高不變；90° 旋轉時物件一起轉
  const [cx, cy] = map(obj.x + obj.w / 2, obj.y + obj.h / 2);
  return { ...obj, x: cx - obj.w / 2, y: cy - obj.h / 2, rotation: (((obj.rotation + rotationDelta) % 360) + 360) % 360 };
}

export type LineObject = Extract<EditorObject, { type: "line" | "arrow" }>;
export type BoxObject = Exclude<EditorObject, LineObject>;

export function isLine(o: EditorObject): o is LineObject {
  return o.type === "line" || o.type === "arrow";
}
