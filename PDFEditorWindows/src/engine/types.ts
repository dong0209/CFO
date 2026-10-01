/** MuPDF 頁面座標：原點在左上角、y 向下，單位為點（1/72 英吋），已套用頁面旋轉。 */
export type Point = [number, number];
export type Rect = [number, number, number, number];
export type Quad = [number, number, number, number, number, number, number, number];
export type RGB = [number, number, number];
export type Matrix = [number, number, number, number, number, number];

export interface PageInfo {
  width: number;
  height: number;
  rotation: number;
}

export interface OutlineNode {
  title: string;
  page: number | null;
  uri: string | null;
  children: OutlineNode[];
}

export interface DocInfo {
  pageCount: number;
  pages: PageInfo[];
  outline: OutlineNode[];
  canUndo: boolean;
  canRedo: boolean;
  isEncrypted: boolean;
  title: string;
}

export interface OpenResult {
  id: number;
  needsPassword: boolean;
}

export interface RenderResult {
  width: number;
  height: number;
  /** RGBA 像素 */
  pixels: Uint8ClampedArray;
}

export type AnnotKind =
  | "Text" | "FreeText" | "Highlight" | "Underline" | "StrikeOut" | "Squiggly"
  | "Ink" | "Square" | "Circle" | "Line" | "Polygon" | "PolyLine"
  | "Stamp" | "Redact" | "Caret" | "FileAttachment" | "Sound" | "Popup" | string;

export interface AnnotInfo {
  id: number;
  page: number;
  type: AnnotKind;
  rect: Rect;
  contents: string;
  color: number[];
  /** 本程式建立的註解子類別（白底遮蓋、簽名、圖片） */
  role: string;
  lineEnd?: string;
  /** 文字方塊的字型設定 */
  textStyle?: TextBoxStyle;
}

export interface TextBoxStyle {
  fontSize: number;
  color: RGB;
  /** 使用者選的字族（顯示用；字型檔另外提供） */
  family?: string;
  bold: boolean;
  italic: boolean;
}

export type WidgetKind = "text" | "checkbox" | "radio" | "combobox" | "listbox" | "button" | "signature" | "unknown";

export interface WidgetInfo {
  id: number;
  page: number;
  kind: WidgetKind;
  name: string;
  rect: Rect;
  value: string;
  options: string[];
  multiline: boolean;
  readOnly: boolean;
  checked: boolean;
}

export interface LinkInfo {
  rect: Rect;
  uri: string;
  page: number | null;
}

export interface SearchHit {
  page: number;
  quads: Quad[];
  context: string;
}

export interface TextSelection {
  quads: Quad[];
  text: string;
}

export type ShapeKind = "square" | "circle" | "line" | "arrow" | "whiteout" | "redact";
export type MarkupKind = "Highlight" | "Underline" | "StrikeOut";

export type StampPosition = "topLeft" | "topCenter" | "topRight" | "bottomLeft" | "bottomCenter" | "bottomRight";

export interface WatermarkOptions {
  text: string;
  fontSize: number;
  color: RGB;
  opacity: number;
  angle: number;
}

export interface PageNumberOptions {
  template: string;
  startAt: number;
  position: StampPosition;
  fontSize: number;
  color: RGB;
  margin: number;
}

export interface OcrLine {
  text: string;
  /** 頁面座標 */
  bbox: Rect;
}

export interface SaveOptions {
  /** 開啟密碼；空字串或未設定代表不加密 */
  userPassword?: string;
  ownerPassword?: string;
  /** 額外壓縮（清理未使用物件、壓縮串流、字型、圖片） */
  compress?: boolean;
}

export type ImageFormat = "png" | "jpeg";

/** 可直接編輯的文字行 */
export interface TextLine {
  index: number;
  text: string;
  /** 頁面座標（y 向下） */
  bbox: Rect;
  /** 基線起點（頁面座標） */
  origin: Point;
  /** PDF 使用者座標（y 向上，未旋轉；與 macOS PDFKit 相同） */
  userBBox: Rect;
  userOrigin: Point;
  fontName: string;
  size: number;
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
  color: RGB;
  /** 原字型是否內嵌在 PDF 中 */
  embeddedFont: boolean;
  /** 原文是否可正確辨識；false 時通常是 PDF 缺少字元對照表，應重新輸入整行 */
  textReliable: boolean;
  /** OCR 辨識出的隱形文字（看得見的字形在掃描影像中） */
  ocr: boolean;
}
