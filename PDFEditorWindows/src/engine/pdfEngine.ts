import * as mupdf from "mupdf";
import { centeredOrigin, concat, inflate, invert, normalizeRect, pointsBounds, quadBounds, rectContains, rectsIntersect, stampOrigin, textMatrix, transformPoint } from "./geometry";
import { cleanFontName, type FontRequest, fontRequestFor, isReliableText, ocrFontRequest } from "./fonts";
import { chunk, moveItems, renderPageNumber } from "./pageRanges";
import type {
  AnnotInfo, DocInfo, ImageFormat, LinkInfo, MarkupKind, Matrix, OcrLine, OpenResult, OutlineNode,
  PageInfo, PageNumberOptions, Point, Quad, Rect, RenderResult, RGB, SaveOptions, SearchHit, ShapeKind,
  TextBoxStyle, TextLine, TextSelection, WatermarkOptions, WidgetInfo, WidgetKind,
} from "./types";

type OutlineItems = NonNullable<ReturnType<mupdf.PDFDocument["loadOutline"]>>;

const ROLE_KEY = "PDFEditorRole";
const STAMP_KEY = "PDFEditorStamp";
const WRAP_KEY = "PDFEditorWrap";
const FONT_KEY = "PDFEditorFont";
const FONT_STYLE_KEY = "PDFEditorFontStyle";
/** 外觀由本程式以自選字型產生；移動時只平移外框，不可讓 MuPDF 重新產生外觀 */
const CUSTOM_AP_KEY = "PDFEditorCustomAP";
const A4: [number, number] = [595.28, 841.89];

interface DocEntry {
  doc: mupdf.PDFDocument;
  /** 目前已驗證的開啟密碼 */
  password: string | null;
  /** 字型字典（物件編號）載入後在 MuPDF 中的名稱 */
  fontNames: Map<number, string | null>;
}

/**
 * PDF 引擎：以 MuPDF 處理所有讀寫。所有修改都包在 journal operation 中，因此可以復原／重做。
 * 在 Web Worker 中執行，也可在 Node 中直接測試。
 */
export class PdfEngine {
  private docs = new Map<number, DocEntry>();
  private nextId = 1;
  private cjkFont: mupdf.Font | null = null;
  private loadedPages: mupdf.PDFPage[] = [];
  private depth = 0;

  constructor() {
    // 每次呼叫結束時釋放期間載入的頁面。MuPDF 會快取已載入頁面的註解清單，
    // 若不釋放，平面化、復原等修改頁面字典的操作之後會讀到過時的註解。
    const self = this as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(PdfEngine.prototype)) {
      const method = self[name];
      if (["constructor", "load", "releasePages"].includes(name) || typeof method !== "function") continue;
      self[name] = (...args: unknown[]) => {
        this.depth++;
        try {
          return (method as (...a: unknown[]) => unknown).apply(this, args);
        } finally {
          if (--this.depth === 0) this.releasePages();
        }
      };
    }
  }

  private load(doc: mupdf.PDFDocument, index: number): mupdf.PDFPage {
    const page = doc.loadPage(index);
    this.loadedPages.push(page);
    return page;
  }

  private releasePages() {
    for (const page of this.loadedPages) {
      for (const annot of page._annots ?? []) annot.destroy();
      for (const widget of page._widgets ?? []) widget.destroy();
      page.destroy();
    }
    this.loadedPages = [];
  }

  // MARK: - 開啟與建立

  open(data: Uint8Array): OpenResult {
    const doc = mupdf.Document.openDocument(data, "application/pdf").asPDF();
    if (!doc) throw new Error("不是有效的 PDF 檔案");
    const id = this.register(doc);
    return { id, needsPassword: doc.needsPassword() };
  }

  unlock(id: number, password: string): boolean {
    const entry = this.entry(id);
    const ok = entry.doc.authenticatePassword(password) !== 0;
    if (ok) {
      entry.password = password;
      this.ensureJournal(entry.doc);
    }
    return ok;
  }

  createBlank(size: [number, number] = A4): number {
    const doc = new mupdf.PDFDocument();
    doc.insertPage(0, doc.addPage([0, 0, size[0], size[1]], 0, {}, ""));
    return this.register(doc);
  }

  /** 每張圖片一頁，頁面大小依圖片解析度（無解析度資訊時以 96 dpi 計算）。 */
  createFromImages(images: Uint8Array[]): number {
    const doc = new mupdf.PDFDocument();
    for (const data of images) {
      const image = new mupdf.Image(data);
      const xres = image.getXResolution() || 96;
      const yres = image.getYResolution() || 96;
      const width = (image.getWidth() * 72) / xres;
      const height = (image.getHeight() * 72) / yres;
      const ref = doc.addImage(image);
      const resources = { XObject: { Im0: ref } };
      const contents = `q ${fmt(width)} 0 0 ${fmt(height)} 0 0 cm /Im0 Do Q`;
      doc.insertPage(-1, doc.addPage([0, 0, width, height], 0, resources, contents));
    }
    if (doc.countPages() === 0) throw new Error("沒有可讀取的圖片");
    return this.register(doc);
  }

  merge(datas: Uint8Array[], passwords: Array<string | null> = []): number {
    const target = new mupdf.PDFDocument();
    datas.forEach((data, index) => {
      const source = mupdf.Document.openDocument(data, "application/pdf").asPDF();
      if (!source) throw new Error("不是有效的 PDF 檔案");
      if (source.needsPassword() && !source.authenticatePassword(passwords[index] ?? "")) throw new Error("需要密碼");
      graftAll(target, source, target.countPages());
    });
    return this.register(target);
  }

  close(id: number): void {
    this.docs.get(id)?.doc.destroy();
    this.docs.delete(id);
  }

  private register(doc: mupdf.PDFDocument): number {
    const id = this.nextId++;
    this.docs.set(id, { doc, password: null, fontNames: new Map() });
    if (!doc.needsPassword()) this.ensureJournal(doc);
    return id;
  }

  private ensureJournal(doc: mupdf.PDFDocument) {
    try {
      doc.enableJournal();
    } catch {
      // 已啟用
    }
  }

  private entry(id: number): DocEntry {
    const entry = this.docs.get(id);
    if (!entry) throw new Error(`找不到文件 ${id}`);
    return entry;
  }

  private doc(id: number): mupdf.PDFDocument {
    return this.entry(id).doc;
  }

  private page(id: number, index: number): mupdf.PDFPage {
    const doc = this.doc(id);
    if (index < 0 || index >= doc.countPages()) throw new Error(`頁碼超出範圍：${index + 1}`);
    return this.load(doc, index);
  }

  /** 以可復原的 journal operation 執行修改。 */
  private op<T>(id: number, name: string, fn: (doc: mupdf.PDFDocument) => T): T {
    const doc = this.doc(id);
    doc.beginOperation(name);
    try {
      const result = fn(doc);
      doc.endOperation();
      return result;
    } catch (error) {
      doc.abandonOperation();
      throw error;
    }
  }

  // MARK: - 資訊

  info(id: number): DocInfo {
    const doc = this.doc(id);
    const pages: PageInfo[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = this.load(doc, i);
      const [x0, y0, x1, y1] = page.getBounds();
      const rotate = page.getObject().getInheritable("Rotate");
      pages.push({ width: x1 - x0, height: y1 - y0, rotation: rotate.isNumber() ? normalizeRotation(rotate.asNumber()) : 0 });
    }
    return {
      pageCount: pages.length,
      pages,
      outline: this.outline(id),
      canUndo: doc.canUndo(),
      canRedo: doc.canRedo(),
      isEncrypted: (doc.getMetaData("encryption") ?? "None") !== "None",
      title: doc.getMetaData("info:Title") ?? "",
    };
  }

  private outline(id: number): OutlineNode[] {
    const doc = this.doc(id);
    const convert = (items: OutlineItems | undefined): OutlineNode[] =>
      (items ?? []).map((item) => ({
        title: item.title ?? "",
        page: typeof item.page === "number" && item.page >= 0 ? item.page : item.uri ? safeResolve(doc, item.uri) : null,
        uri: item.uri ?? null,
        children: convert(item.down),
      }));
    try {
      return convert(doc.loadOutline() ?? []);
    } catch {
      return [];
    }
  }

  // MARK: - 渲染與文字

  render(id: number, pageIndex: number, scale: number, withAnnotations = true): RenderResult {
    const page = this.page(id, pageIndex);
    const matrix = mupdf.Matrix.scale(scale, scale);
    let pixmap: mupdf.Pixmap;
    if (withAnnotations) {
      pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false, true);
    } else {
      const bbox = mupdf.Rect.transform(page.getBounds(), matrix);
      pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, bbox, false);
      pixmap.clear(255);
      const device = new mupdf.DrawDevice(matrix, pixmap);
      page.runPageContents(device, mupdf.Matrix.identity);
      device.close();
    }
    const result = { width: pixmap.getWidth(), height: pixmap.getHeight(), pixels: rgbToRgba(pixmap.getPixels(), pixmap.getWidth(), pixmap.getHeight(), pixmap.getStride()) };
    pixmap.destroy();
    return result;
  }

  pageText(id: number, pageIndex: number): string {
    return this.page(id, pageIndex).toStructuredText("preserve-whitespace").asText();
  }

  selectText(id: number, pageIndex: number, from: Point, to: Point): TextSelection {
    const stext = this.page(id, pageIndex).toStructuredText("preserve-whitespace");
    return { quads: stext.highlight(from, to, 1000) as Quad[], text: stext.copy(from, to) };
  }

  search(id: number, query: string): SearchHit[] {
    const doc = this.doc(id);
    const needle = query.trim();
    if (!needle) return [];
    const hits: SearchHit[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      const page = this.load(doc, i);
      const stext = page.toStructuredText("preserve-whitespace");
      for (const quads of stext.search(needle, "ignore-case")) {
        const [x0, y0, x1, y1] = quadBounds(quads[0] as Quad);
        const midY = (y0 + y1) / 2;
        const context = stext.copy([Math.max(0, x0 - 160), midY], [x1 + 200, midY]).replace(/\s+/g, " ").trim();
        hits.push({ page: i, quads: quads as Quad[], context: context || needle });
      }
      if (hits.length >= 2000) break;
    }
    return hits;
  }

  links(id: number, pageIndex: number): LinkInfo[] {
    const doc = this.doc(id);
    return this.page(id, pageIndex).getLinks().map((link) => {
      const uri = link.getURI();
      return { rect: link.getBounds() as Rect, uri, page: link.isExternal() ? null : safeResolve(doc, uri) };
    });
  }

  // MARK: - 註解

  annotations(id: number, pageIndex: number): AnnotInfo[] {
    return this.page(id, pageIndex).getAnnotations()
      .filter((a) => a.getType() !== "Popup")
      .map((a) => annotInfo(a, pageIndex));
  }

  allAnnotations(id: number): AnnotInfo[] {
    const doc = this.doc(id);
    const result: AnnotInfo[] = [];
    for (let i = 0; i < doc.countPages(); i++) result.push(...this.annotations(id, i));
    return result;
  }

  private findAnnot(page: mupdf.PDFPage, annotId: number): mupdf.PDFAnnotation {
    const annot = page.getAnnotations().find((a) => a.getObject().asIndirect() === annotId);
    if (!annot) throw new Error("找不到註解");
    return annot;
  }

  addMarkup(id: number, pageIndex: number, kind: MarkupKind, quads: Quad[], color: RGB, text = ""): number {
    if (quads.length === 0) throw new Error("沒有選取文字");
    return this.op(id, kind, () => {
      const annot = this.page(id, pageIndex).createAnnotation(kind);
      annot.setColor(color);
      annot.setQuadPoints(quads);
      if (kind === "Highlight") annot.setOpacity(0.5);
      if (text) annot.setContents(text);
      annot.update();
      return annot.getObject().asIndirect();
    });
  }

  addNote(id: number, pageIndex: number, at: Point, text: string, color: RGB): number {
    return this.op(id, "便利貼", () => {
      const annot = this.page(id, pageIndex).createAnnotation("Text");
      annot.setRect([at[0] - 10, at[1] - 10, at[0] + 10, at[1] + 10]);
      annot.setContents(text);
      annot.setColor(color);
      annot.setIcon("Note");
      annot.update();
      return annot.getObject().asIndirect();
    });
  }

  /**
   * 文字方塊：以使用者選的字型（`font`，缺字時用 `fallbackFont`）產生外觀並內嵌字型，
   * 在任何 PDF 閱讀器中看起來都一樣。沒有提供字型時使用標準字型。
   */
  addFreeText(id: number, pageIndex: number, at: Point, text: string, style: TextBoxStyle, font: FontData | null = null, fallbackFont: FontData | null = null): number {
    return this.op(id, "文字方塊", (doc) => {
      const annot = this.page(id, pageIndex).createAnnotation("FreeText");
      this.writeFreeText(doc, annot, at, text, style, font, fallbackFont);
      return annot.getObject().asIndirect();
    });
  }

  /** 修改文字方塊的文字與字型（位置不變）。 */
  updateFreeText(id: number, pageIndex: number, annotId: number, text: string, style: TextBoxStyle, font: FontData | null = null, fallbackFont: FontData | null = null): void {
    this.op(id, "編輯文字", (doc) => {
      const annot = this.findAnnot(this.page(id, pageIndex), annotId);
      const [x0, y0] = annot.getRect();
      this.writeFreeText(doc, annot, [x0, y0], text, style, font, fallbackFont);
    });
  }

  private writeFreeText(doc: mupdf.PDFDocument, annot: mupdf.PDFAnnotation, at: Point, text: string, style: TextBoxStyle, font: FontData | null, fallbackFont: FontData | null) {
    const primary = [font, fallbackFont].map((f, i) => (f ? loadFont(i === 0 ? "TextBox" : "Fallback", f.data, f.index ?? 0) : null)).filter((f): f is mupdf.Font => f !== null);
    const chain = this.fontChain({ bold: style.bold, italic: style.italic, serif: false, mono: false }, primary);
    const size = style.fontSize;
    const pad = 2;
    const lineHeight = size * 1.25;
    const lines = text.split("\n").map((line) => this.glyphRuns(line, chain));
    const width = Math.max(size, ...lines.map((runs) => runs.reduce((sum, run) => sum + run.width, 0) * size)) + pad * 2;
    const height = lines.length * lineHeight + pad * 2;

    annot.setRect([at[0], at[1], at[0] + width, at[1] + height]);
    annot.setDefaultAppearance("Helv", size, style.color);
    annot.setContents(text);
    annot.setBorderWidth(0);
    annot.update();

    const fonts = doc.newDictionary();
    const used = new Map<mupdf.Font, Set<number>>();
    for (const run of lines.flat()) {
      const set = used.get(run.font) ?? new Set<number>();
      run.gids.forEach((g) => set.add(g));
      used.set(run.font, set);
    }
    const names = new Map<mupdf.Font, string>();
    for (const [f, gids] of used) names.set(f, this.embedFont(doc, fonts, f, gids));
    const ops = [`${style.color.map(fmt).join(" ")} rg BT`];
    lines.forEach((runs, i) => {
      ops.push(`1 0 0 1 ${fmt(pad)} ${fmt(height - pad - size * 0.9 - i * lineHeight)} Tm`);
      for (const run of runs) ops.push(`/${names.get(run.font)} ${fmt(size)} Tf <${run.gids.map((g) => g.toString(16).padStart(4, "0")).join("")}> Tj`);
    });
    ops.push("ET");
    annot.setAppearance(null, null, mupdf.Matrix.identity, [0, 0, width, height], { Font: fonts }, ops.join("\n"));
    const obj = annot.getObject();
    obj.put(FONT_KEY, doc.newString(style.family ?? ""));
    obj.put(FONT_STYLE_KEY, doc.newString(`${style.bold ? "bold" : ""} ${style.italic ? "italic" : ""}`.trim()));
    obj.put(CUSTOM_AP_KEY, true);
  }

  addInk(id: number, pageIndex: number, strokes: Point[][], color: RGB, width: number): number {
    const valid = strokes.filter((s) => s.length > 0).map((s) => (s.length === 1 ? [s[0], [s[0][0] + 0.5, s[0][1] + 0.5] as Point] : s));
    if (valid.length === 0) throw new Error("沒有筆畫");
    return this.op(id, "手繪", () => {
      const annot = this.page(id, pageIndex).createAnnotation("Ink");
      annot.setInkList(valid);
      annot.setColor(color);
      annot.setBorderWidth(width);
      annot.update();
      return annot.getObject().asIndirect();
    });
  }

  addShape(id: number, pageIndex: number, kind: ShapeKind, from: Point, to: Point, color: RGB, width: number, fill: boolean): number {
    return this.op(id, "圖形", () => {
      const page = this.page(id, pageIndex);
      const rect = normalizeRect(from, to);
      let annot: mupdf.PDFAnnotation;
      switch (kind) {
        case "line":
        case "arrow":
          annot = page.createAnnotation("Line");
          annot.setLine(from, to);
          annot.setLineEndingStyles("None", kind === "arrow" ? "OpenArrow" : "None");
          annot.setColor(color);
          annot.setBorderWidth(width);
          break;
        case "whiteout":
          annot = page.createAnnotation("Square");
          annot.setRect(rect);
          annot.setColor([1, 1, 1]);
          annot.setInteriorColor([1, 1, 1]);
          annot.setBorderWidth(0);
          annot.setContents("白底遮蓋");
          annot.getObject().put(ROLE_KEY, "whiteout");
          break;
        case "redact":
          annot = page.createAnnotation("Redact");
          annot.setRect(rect);
          annot.setContents("待套用遮蓋");
          break;
        default:
          annot = page.createAnnotation(kind === "circle" ? "Circle" : "Square");
          annot.setRect(rect);
          annot.setColor(color);
          annot.setBorderWidth(width);
          if (fill) {
            annot.setInteriorColor(color);
            annot.setOpacity(0.35);
          }
      }
      annot.update();
      return annot.getObject().asIndirect();
    });
  }

  /** 圖片或簽名：以 Stamp 註解保存，可在其他 PDF 閱讀器中正常顯示。 */
  addImage(id: number, pageIndex: number, rect: Rect, image: Uint8Array, isSignature: boolean): number {
    return this.op(id, isSignature ? "簽名" : "插入圖片", () => {
      const annot = this.page(id, pageIndex).createAnnotation("Stamp");
      annot.setRect(rect);
      annot.setStampImage(new mupdf.Image(image));
      annot.setContents(isSignature ? "簽名" : "圖片");
      annot.getObject().put(ROLE_KEY, isSignature ? "signature" : "image");
      annot.update();
      return annot.getObject().asIndirect();
    });
  }

  imageSize(image: Uint8Array): [number, number] {
    const img = new mupdf.Image(image);
    return [img.getWidth(), img.getHeight()];
  }

  setContents(id: number, pageIndex: number, annotId: number, text: string): void {
    this.op(id, "編輯文字", () => {
      const annot = this.findAnnot(this.page(id, pageIndex), annotId);
      annot.setContents(text);
      if (annot.getType() === "FreeText") {
        const [x0, y0] = annot.getRect();
        annot.setRect(freeTextRect([x0, y0], text, annot.getDefaultAppearance().size || 12));
      }
      annot.update();
    });
  }

  moveAnnotation(id: number, pageIndex: number, annotId: number, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    this.op(id, "移動註解", () => {
      const page = this.page(id, pageIndex);
      const annot = this.findAnnot(page, annotId);
      const shift = ([x, y]: Point): Point => [x + dx, y + dy];
      if (annot.hasInkList()) {
        annot.setInkList(annot.getInkList().map((stroke) => stroke.map(shift)));
      } else if (annot.hasLine()) {
        const [a, b] = annot.getLine();
        annot.setLine(shift(a), shift(b));
      } else if (annot.hasQuadPoints()) {
        annot.setQuadPoints(annot.getQuadPoints().map((q) => q.map((v, i) => v + (i % 2 === 0 ? dx : dy)) as Quad));
      } else if (annot.hasVertices()) {
        annot.setVertices(annot.getVertices().map(shift));
      } else if (annot.getObject().get(CUSTOM_AP_KEY).isBoolean() && annot.getObject().get(CUSTOM_AP_KEY).asBoolean()) {
        // 自訂外觀：直接平移 PDF 座標中的外框，保留原本的外觀串流
        const [a, b, c, d] = invert(page.getTransform() as Matrix);
        const ux = dx * a + dy * c;
        const uy = dx * b + dy * d;
        const rect = annot.getObject().get("Rect");
        const values = [0, 1, 2, 3].map((i) => rect.get(i).asNumber());
        annot.getObject().put("Rect", [values[0] + ux, values[1] + uy, values[2] + ux, values[3] + uy]);
        return;
      } else {
        const [x0, y0, x1, y1] = annot.getRect();
        annot.setRect([x0 + dx, y0 + dy, x1 + dx, y1 + dy]);
      }
      annot.update();
    });
  }

  deleteAnnotation(id: number, pageIndex: number, annotId: number): void {
    this.op(id, "刪除註解", () => {
      const page = this.page(id, pageIndex);
      page.deleteAnnotation(this.findAnnot(page, annotId));
    });
  }

  // MARK: - 表單

  widgets(id: number, pageIndex: number): WidgetInfo[] {
    return this.page(id, pageIndex).getWidgets().map((w) => {
      const kind = widgetKind(w);
      let options: string[] = [];
      if (kind === "combobox" || kind === "listbox") {
        try {
          options = w.getOptions();
        } catch {
          options = [];
        }
      }
      const value = safe(() => w.getValue(), "");
      return {
        id: w.getObject().asIndirect(),
        page: pageIndex,
        kind,
        name: safe(() => w.getName(), ""),
        rect: w.getRect() as Rect,
        value,
        options,
        multiline: kind === "text" && safe(() => w.isMultiline(), false),
        readOnly: safe(() => w.isReadOnly(), false),
        checked: (kind === "checkbox" || kind === "radio") && value !== "" && value !== "Off",
      };
    });
  }

  setWidgetValue(id: number, pageIndex: number, widgetId: number, value: string | null): void {
    this.op(id, "填寫表單", () => {
      const widget = this.page(id, pageIndex).getWidgets().find((w) => w.getObject().asIndirect() === widgetId);
      if (!widget) throw new Error("找不到表單欄位");
      if (value === null) widget.toggle();
      else if (widget.isChoice()) widget.setChoiceValue(value);
      else widget.setTextValue(value);
      widget.update();
    });
  }

  // MARK: - 頁面

  rotatePages(id: number, indices: number[], degrees: number): void {
    this.op(id, "旋轉頁面", (doc) => {
      for (const index of indices) {
        const obj = this.load(doc, index).getObject();
        const current = obj.getInheritable("Rotate");
        obj.put("Rotate", normalizeRotation((current.isNumber() ? current.asNumber() : 0) + degrees));
      }
    });
  }

  deletePages(id: number, indices: number[]): void {
    const doc = this.doc(id);
    const remove = new Set(indices);
    if (remove.size >= doc.countPages()) throw new Error("文件至少需要保留一頁");
    this.op(id, "刪除頁面", () => {
      [...remove].sort((a, b) => b - a).forEach((i) => doc.deletePage(i));
    });
  }

  insertBlankPage(id: number, at: number, size?: [number, number]): void {
    this.op(id, "插入空白頁", (doc) => {
      const reference = doc.countPages() > 0 ? this.load(doc, Math.min(Math.max(at - 1, 0), doc.countPages() - 1)) : null;
      const [x0, y0, x1, y1] = reference ? reference.getBounds() : [0, 0, ...A4];
      const [w, h] = size ?? [x1 - x0, y1 - y0];
      doc.insertPage(at, doc.addPage([0, 0, w, h], 0, {}, ""));
    });
  }

  insertDocument(id: number, at: number, data: Uint8Array, password: string | null = null): number {
    const source = mupdf.Document.openDocument(data, "application/pdf").asPDF();
    if (!source) throw new Error("不是有效的 PDF 檔案");
    if (source.needsPassword() && !source.authenticatePassword(password ?? "")) throw new Error("需要密碼");
    const count = source.countPages();
    this.op(id, "插入頁面", (doc) => graftAll(doc, source, at));
    return count;
  }

  movePages(id: number, source: number[], destination: number): void {
    const doc = this.doc(id);
    const order = moveItems([...Array(doc.countPages()).keys()], source, destination);
    this.op(id, "搬移頁面", () => doc.rearrangePages(order));
  }

  /** 在每個選取頁面後方插入複本。 */
  duplicatePages(id: number, indices: number[]): void {
    const doc = this.doc(id);
    const selected = new Set(indices);
    const order: number[] = [];
    for (let i = 0; i < doc.countPages(); i++) {
      order.push(i);
      if (selected.has(i)) order.push(i);
    }
    this.op(id, "複製頁面", () => doc.rearrangePages(order));
  }

  extractPages(id: number, indices: number[]): Uint8Array {
    const source = this.doc(id);
    const target = new mupdf.PDFDocument();
    const graft = target.newGraftMap();
    for (const index of indices) graft.graftPage(-1, source, index);
    return target.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
  }

  split(id: number, ranges: Array<[number, number]>): Uint8Array[] {
    return ranges.map(([a, b]) => this.extractPages(id, Array.from({ length: b - a + 1 }, (_, i) => a + i)));
  }

  splitEvery(id: number, perFile: number): Uint8Array[] {
    return this.split(id, chunk(this.doc(id).countPages(), perFile));
  }

  // MARK: - 浮水印、頁碼、OCR 文字層

  addWatermark(id: number, pages: number[], options: WatermarkOptions): void {
    this.op(id, "浮水印", (doc) => {
      for (const index of pages) {
        const page = this.load(doc, index);
        const [x0, y0, x1, y1] = page.getBounds();
        const width = this.textWidth(options.text) * options.fontSize;
        const origin = centeredOrigin([(x0 + x1) / 2, (y0 + y1) / 2], width, options.fontSize, options.angle);
        this.appendText(doc, page, [{ text: options.text, matrix: textMatrix(origin, options.fontSize, options.angle) }], options.color, options.opacity, false, "watermark");
      }
    });
  }

  addPageNumbers(id: number, pages: number[], options: PageNumberOptions): void {
    this.op(id, "頁碼", (doc) => {
      const total = doc.countPages() + options.startAt - 1;
      for (const index of pages) {
        const page = this.load(doc, index);
        const [x0, y0, x1, y1] = page.getBounds();
        const text = renderPageNumber(options.template, index + options.startAt, total);
        const width = this.textWidth(text) * options.fontSize;
        const origin = stampOrigin(options.position, width, options.fontSize, { width: x1 - x0, height: y1 - y0 }, options.margin);
        this.appendText(doc, page, [{ text, matrix: textMatrix(origin, options.fontSize) }], options.color, 1, false, "pagenumber");
      }
    });
  }

  /** 移除本程式加入的浮水印與頁碼（存檔後重新開啟也能移除）。 */
  removeStamps(id: number): number {
    return this.op(id, "移除浮水印與頁碼", (doc) => {
      let removed = 0;
      for (let i = 0; i < doc.countPages(); i++) {
        const obj = this.load(doc, i).getObject();
        const contents = obj.get("Contents");
        if (!contents.isArray()) continue;
        for (let k = contents.length - 1; k >= 0; k--) {
          const role = contents.get(k).get(STAMP_KEY);
          if (role.isName() && role.asName() !== "ocr" && role.asName() !== "edit") {
            contents.delete(k);
            removed++;
          }
        }
      }
      return removed;
    });
  }

  /** OCR：以隱形文字（render mode 3）加入辨識結果，頁面外觀不變但可搜尋、選取。 */
  applyOcr(id: number, pageIndex: number, lines: OcrLine[]): void {
    this.op(id, "文字辨識", (doc) => {
      const page = this.load(doc, pageIndex);
      const runs = lines
        .filter((line) => line.text.trim() !== "")
        .map((line) => {
          const [x0, y0, x1, y1] = line.bbox;
          const height = Math.max(y1 - y0, 1);
          const size = height * 0.85;
          const natural = this.textWidth(line.text) * size;
          const scale = natural > 0 ? (x1 - x0) / natural : 1;
          return { text: line.text, matrix: textMatrix([x0, y1 - height * 0.15], size, 0, scale) };
        });
      if (runs.length) this.appendText(doc, page, runs, [0, 0, 0], 1, true, "ocr");
    });
  }

  private latinFonts = new Map<string, mupdf.Font>();

  /** MuPDF 內建的中文字型（Droid Sans Fallback），作為最後的備援。 */
  private font(): mupdf.Font {
    this.cjkFont ??= new mupdf.Font("zh-Hant");
    return this.cjkFont;
  }

  private latin(name: LatinFont): mupdf.Font {
    let font = this.latinFonts.get(name);
    if (!font) {
      font = new mupdf.Font(name);
      this.latinFonts.set(name, font);
    }
    return font;
  }

  /** 字型鏈：每個字元使用鏈中第一個具有該字形的字型；最後以標準英文字型與中文字型備援。 */
  private fontChain(style: StyleFlags = PLAIN_STYLE, primary: mupdf.Font[] = []): mupdf.Font[] {
    return [...primary, this.latin(latinFontFor(style)), this.font()];
  }

  private glyphRuns(text: string, chain: mupdf.Font[]): GlyphRun[] {
    const runs: GlyphRun[] = [];
    for (const ch of text) {
      let font: mupdf.Font | undefined;
      let gid = 0;
      for (const candidate of chain) {
        gid = candidate.encodeCharacter(ch);
        if (gid > 0) {
          font = candidate;
          break;
        }
      }
      if (!font) continue; // 所有字型都沒有的字元（例如部分表情符號）略過
      const width = font.advanceGlyph(gid);
      const last = runs[runs.length - 1];
      if (last && last.font === font) {
        last.gids.push(gid);
        last.text += ch;
        last.width += width;
      } else {
        runs.push({ font, gids: [gid], text: ch, width });
      }
    }
    return runs;
  }

  /** 以 em 為單位的文字寬度。 */
  textWidth(text: string): number {
    return this.glyphRuns(text, this.fontChain()).reduce((sum, run) => sum + run.width, 0);
  }

  /**
   * 將字型嵌入文件（只保留用到的字形），回傳資源名稱。
   * 嵌入真正的字型後，任何閱讀器都能正確顯示，不會因缺字型而出現亂碼。
   */
  private embedFont(doc: mupdf.PDFDocument, fonts: mupdf.PDFObject, font: mupdf.Font, gids: Set<number>): string {
    const temp = new mupdf.PDFDocument();
    const ref = temp.addFont(font);
    const hex = [...gids].map((g) => g.toString(16).padStart(4, "0")).join("");
    temp.insertPage(0, temp.addPage([0, 0, 100, 100], 0, { Font: { F: ref } }, `BT /F 1 Tf <${hex}> Tj ET`));
    try {
      temp.subsetFonts();
    } catch {
      // 無法子集化的字型直接完整嵌入
    }
    const grafted = doc.graftObject(ref);
    const name = `PEE${grafted.asIndirect()}`;
    fonts.put(name, grafted);
    return name;
  }

  /** 在頁面內容最上層加入文字（位置以頁面座標的文字矩陣表示），字型一律嵌入。 */
  private appendText(
    doc: mupdf.PDFDocument,
    page: mupdf.PDFPage,
    runs: Array<{ text: string; matrix: Matrix }>,
    color: RGB,
    opacity: number,
    invisible: boolean,
    role: string,
    chain: mupdf.Font[] = this.fontChain(),
  ) {
    const shaped = runs.map((run) => ({ matrix: run.matrix, glyphs: this.glyphRuns(run.text, chain) }));
    const used = new Map<mupdf.Font, Set<number>>();
    for (const run of shaped) {
      for (const glyph of run.glyphs) {
        const set = used.get(glyph.font) ?? new Set<number>();
        glyph.gids.forEach((g) => set.add(g));
        used.set(glyph.font, set);
      }
    }
    if (used.size === 0) return;

    const pageObj = page.getObject();
    const resources = ensureDict(doc, pageObj, "Resources", true);
    const fonts = ensureDict(doc, resources, "Font");
    const names = new Map<mupdf.Font, string>();
    for (const [font, gids] of used) names.set(font, this.embedFont(doc, fonts, font, gids));
    const states = ensureDict(doc, resources, "ExtGState");
    const gsName = `PEGS${Math.round(opacity * 100)}`;
    if (states.get(gsName).isNull()) states.put(gsName, { Type: doc.newName("ExtGState"), ca: opacity, CA: opacity });

    const toUser = invert(page.getTransform() as Matrix);
    const ops = [`q /${gsName} gs ${color.map(fmt).join(" ")} rg BT ${invisible ? 3 : 0} Tr`];
    for (const run of shaped) {
      if (!run.glyphs.length) continue;
      ops.push(`${concat(run.matrix, toUser).map(fmt).join(" ")} Tm`);
      for (const glyph of run.glyphs) {
        ops.push(`/${names.get(glyph.font)} 1 Tf <${glyph.gids.map((g) => g.toString(16).padStart(4, "0")).join("")}> Tj`);
      }
    }
    ops.push("ET Q");

    wrapContents(doc, pageObj);
    const stream = doc.addStream(ops.join("\n"), { [STAMP_KEY]: doc.newName(role) });
    const contents = pageObj.get("Contents");
    if (contents.isArray()) contents.push(stream);
    else pageObj.put("Contents", [contents, stream]);
  }

  /** 以原字型資源與原字碼寫入文字（沿用原文件的字型，不另外嵌入）。 */
  private appendEncodedText(doc: mupdf.PDFDocument, page: mupdf.PDFPage, matrix: Matrix, color: RGB, fontRef: mupdf.PDFObject, hex: string, role: string) {
    const pageObj = page.getObject();
    const resources = ensureDict(doc, pageObj, "Resources", true);
    const fonts = ensureDict(doc, resources, "Font");
    const name = `PEO${fontRef.isIndirect() ? fontRef.asIndirect() : Date.now()}`;
    if (fonts.get(name).isNull()) fonts.put(name, fontRef);
    const toUser = invert(page.getTransform() as Matrix);
    const ops = [
      `q ${color.map(fmt).join(" ")} rg BT 0 Tr`,
      `${concat(matrix, toUser).map(fmt).join(" ")} Tm`,
      `/${name} 1 Tf <${hex}> Tj`,
      "ET Q",
    ];
    wrapContents(doc, pageObj);
    const stream = doc.addStream(ops.join("\n"), { [STAMP_KEY]: doc.newName(role) });
    const contents = pageObj.get("Contents");
    if (contents.isArray()) contents.push(stream);
    else pageObj.put("Contents", [contents, stream]);
  }

  // MARK: - 直接編輯文字

  /** 頁面上的水平文字行，含字型、字級、顏色與基線位置。 */
  textLines(id: number, pageIndex: number): TextLine[] {
    return this.analyzeLines(id, pageIndex).map(({ dict: _dict, ...line }) => line);
  }

  /** 分析頁面文字行，並找出每一行使用的 PDF 字型字典。 */
  private analyzeLines(id: number, pageIndex: number): AnalyzedLine[] {
    const entry = this.entry(id);
    const page = this.page(id, pageIndex);
    const toUser = invert(page.getTransform() as Matrix);
    const raw: Array<{ bbox: Rect; horizontal: boolean; chars: Array<{ c: string; origin: Point; font: mupdf.Font; size: number; color: number[] }> }> = [];
    page.toStructuredText("preserve-whitespace").walk({
      beginLine(bbox, _wmode, direction) {
        raw.push({ bbox: bbox as Rect, horizontal: Math.abs(direction[1]) < 0.01 && direction[0] > 0, chars: [] });
      },
      onChar(c, origin, font, size, _quad, color) {
        raw[raw.length - 1]?.chars.push({ c, origin: origin as Point, font, size, color: color as number[] });
      },
    });
    const { invisible } = scanPage(page, false);
    const fonts = pageFonts(page);
    const fontCache = new Map<string, mupdf.PDFObject | null>();
    let rendered: mupdf.Pixmap | null = null;
    const lines: AnalyzedLine[] = [];
    for (const line of raw) {
      const text = line.chars.map((ch) => ch.c).join("");
      if (!line.horizontal || !text.trim()) continue;
      const visibleChars = line.chars.filter((ch) => ch.c.trim());
      const first = visibleChars[0] ?? line.chars[0];
      const hidden = visibleChars.filter((ch) => invisible.has(pointKey(ch.origin))).length;
      const ocr = hidden > 0 && hidden >= visibleChars.length / 2;
      const internalName = first.font.getName();
      const cacheKey = `${internalName}\u0000${text}`;
      if (!fontCache.has(cacheKey)) fontCache.set(cacheKey, this.matchFontDict(entry, fonts, internalName, text));
      const dict = fontCache.get(cacheKey) ?? null;
      const base = dict?.resolve().get("BaseFont");
      const name = base?.isName() ? base.asName() : internalName;
      const bold = first.font.isBold() || /bold|black|heavy|semibold|demi|w[6-9]/i.test(name);
      const italic = first.font.isItalic() || /italic|oblique/i.test(name);
      // 未內嵌的字型在 MuPDF 中會以替代字型顯示，其襯線／等寬屬性不可靠，改看字型描述的旗標與名稱
      const flags = dict ? descriptorFlags(dict) : null;
      const embedded = dict !== null && fontFileOf(dict.resolve()) !== null;
      const nameMono = /courier|mono|consol/i.test(name);
      const nameSerif = /times|serif|roman|georgia|garamond|song|ming|明|宋|kai|楷|mincho/i.test(name) && !/sans/i.test(name);
      const mono = nameMono || (flags !== null ? (flags & 1) !== 0 : embedded && first.font.isMono());
      const serif = !mono && (nameSerif || (!/sans|gothic|hei|黑/i.test(name) && (flags !== null ? (flags & 2) !== 0 : embedded && first.font.isSerif())));
      const origin = line.chars[0].origin;
      let color = toRgb(first.color);
      if (ocr) {
        // 隱形文字沒有顏色：改從頁面畫面取樣掃描影像中的文字顏色
        rendered ??= page.toPixmap(mupdf.Matrix.scale(SAMPLE_SCALE, SAMPLE_SCALE), mupdf.ColorSpace.DeviceRGB, false, false);
        color = sampleColors(rendered, line.bbox, SAMPLE_SCALE).text;
      }
      lines.push({
        index: lines.length,
        text: text.replace(/\s+$/, ""),
        bbox: line.bbox,
        origin,
        userBBox: transformRect(line.bbox, toUser),
        userOrigin: transformPoint(origin, toUser),
        fontName: ocr ? "" : cleanFontName(name),
        size: Math.round(first.size * 100) / 100,
        bold: ocr ? false : bold,
        italic: ocr ? false : italic,
        serif: ocr ? false : serif,
        mono: ocr ? false : mono,
        color,
        embeddedFont: !ocr && embedded,
        textReliable: isReliableText(text),
        ocr,
        dict: ocr ? null : dict,
      });
    }
    // 依版面位置排序（由上而下、由左而右），不受內容串流順序影響
    lines.sort((a, b) => (Math.abs(a.origin[1] - b.origin[1]) > 2 ? a.origin[1] - b.origin[1] : a.origin[0] - b.origin[0]));
    lines.forEach((line, i) => (line.index = i));
    rendered?.destroy();
    return lines;
  }

  /**
   * 找出文字使用的字型字典。未內嵌的字型以 BaseFont 比對；內嵌字型在 MuPDF 中會回報字型檔內部的名稱，
   * 因此改把每個字型字典單獨載入一次，比對載入後的名稱。同名時優先挑對照表涵蓋這行文字的字型。
   */
  private matchFontDict(entry: DocEntry, fonts: mupdf.PDFObject[], internalName: string, text: string): mupdf.PDFObject | null {
    const target = cleanFontName(internalName).toLowerCase();
    const matches = fonts.filter((ref) => {
      const base = ref.resolve().get("BaseFont");
      if (base.isName() && cleanFontName(base.asName()).toLowerCase() === target) return true;
      return this.loadedFontName(entry, ref) === internalName;
    });
    if (matches.length <= 1) return matches[0] ?? null;
    const chars = [...text].filter((c) => c.trim());
    return (
      matches.find((ref) => {
        const encoder = originalFontEncoder(ref.resolve());
        return encoder !== null && chars.every((c) => encoder.has(c));
      }) ?? matches[0]
    );
  }

  /** MuPDF 載入某個字型字典後回報的字型名稱（快取）。 */
  private loadedFontName(entry: DocEntry, ref: mupdf.PDFObject): string | null {
    const key = ref.isIndirect() ? ref.asIndirect() : -1;
    if (key > 0 && entry.fontNames.has(key)) return entry.fontNames.get(key) ?? null;
    let name: string | null = null;
    try {
      const dict = ref.resolve();
      const subtype = dict.get("Subtype").isName() ? dict.get("Subtype").asName() : "";
      if (subtype !== "Type3") {
        const temp = new mupdf.PDFDocument();
        const copy = temp.graftObject(ref);
        temp.insertPage(0, temp.addPage([0, 0, 100, 100], 0, { Font: { F: copy } }, `BT /F 12 Tf 10 10 Td <${subtype === "Type0" ? "0001" : "41"}> Tj ET`));
        const page = temp.loadPage(0);
        page.toStructuredText("").walk({
          onChar(_c, _o, font) {
            name ??= font.getName();
          },
        });
        page.destroy();
        temp.destroy();
      }
    } catch {
      name = null;
    }
    if (key > 0) entry.fontNames.set(key, name);
    return name;
  }

  /** 找出包含頁面座標（y 向下）某點的文字行。 */
  textLineAt(id: number, pageIndex: number, point: Point): TextLine | null {
    const lines = this.textLines(id, pageIndex);
    const hit = lines.find((l) => rectContains(inflate(l.bbox, 2), point));
    return hit ?? null;
  }

  /** 以 PDF 使用者座標（原點在左下，與 macOS PDFKit 相同）找出文字行。 */
  textLineAtUserPoint(id: number, pageIndex: number, point: Point): TextLine | null {
    const page = this.page(id, pageIndex);
    return this.textLineAt(id, pageIndex, transformPoint(point, page.getTransform() as Matrix));
  }

  /** 辨識某行文字的字型，回傳要在電腦上尋找或下載的候選字型。 */
  fontRequest(id: number, pageIndex: number, lineIndex: number): FontRequest {
    const line = this.textLines(id, pageIndex)[lineIndex];
    if (!line) throw new Error("找不到要編輯的文字行");
    if (line.ocr) return ocrFontRequest(line.text);
    return fontRequestFor(line.fontName, line.bold, line.italic, { serif: line.serif, mono: line.mono, text: line.text });
  }

  /**
   * 直接修改一行文字：真正移除原本的字形（背景、圖片與線條保留），再寫入新文字。
   * 字型優先順序：原檔內嵌字型（包含所有需要的字形時）→ `font`（電腦上的或下載的字型）→ `fallbackFont`（缺字時）→ 標準字型。
   * `forceFont` 為 true 時（使用者自選字型）不沿用原檔字型。
   * OCR 辨識出的文字：字形在掃描影像中，會把影像中那一行的像素改成周圍的背景色，再寫入看得見的新文字。
   * `newText` 為空字串時等於刪除這一行。
   */
  replaceTextLine(id: number, pageIndex: number, lineIndex: number, newText: string, options: ReplaceOptions = {}): ReplaceResult {
    const line = this.analyzeLines(id, pageIndex)[lineIndex];
    if (!line) throw new Error("找不到要編輯的文字行");
    const style = { ...line, ...options.override };
    const font = options.font ?? null;
    const text = newText.replace(/\s+$/, "");
    return this.op(id, "編輯文字", (doc) => {
      const page = this.load(doc, pageIndex);
      let fontUsed: ReplaceResult["font"] = "standard";
      const [x0, y0, x1, y1] = line.bbox;
      const originalDict = options.forceFont ? null : line.dict?.resolve() ?? null;
      // 1. 直接沿用原字型資源（字形、字寬與原文完全相同）
      const sameStyle = !options.override || ["bold", "italic", "serif", "mono"].every((k) => options.override?.[k as keyof StyleFlags] === undefined || options.override[k as keyof StyleFlags] === line[k as keyof StyleFlags]);
      const encoder = originalDict && sameStyle ? originalFontEncoder(originalDict) : null;
      const codes = encoder ? encodeWith(encoder, text) : null;
      // 2. 原字型檔（含字元對照）重新嵌入；3. 提供的字型；4. 標準字型
      const primary: mupdf.Font[] = [];
      if (!codes) {
        const embeddedData = originalDict && sameStyle ? fontFileOf(originalDict) : null;
        const embedded = embeddedData ? loadFont(line.fontName, embeddedData) : null;
        if (embedded && coversText(embedded, text)) {
          primary.push(embedded);
          fontUsed = "embedded";
        } else if (font) {
          const supplied = loadFont(line.fontName || "Font", font.data, font.index ?? 0);
          if (supplied) {
            primary.push(supplied);
            fontUsed = coversText(supplied, text) ? "supplied" : "mixed";
          }
        }
        if (fontUsed !== "embedded" && fontUsed !== "supplied" && options.fallbackFont) {
          const fallback = loadFont("Fallback", options.fallbackFont.data, options.fallbackFont.index ?? 0);
          if (fallback) {
            primary.push(fallback);
            if (fontUsed === "standard") fontUsed = "mixed";
          }
        }
      }

      if (line.ocr) {
        // 隱形的 OCR 文字整行移除；看得見的字形在掃描影像中，改掉影像中那一行的像素
        const redact = page.createAnnotation("Redact");
        redact.setRect(inflate(line.bbox, 1));
        redact.update();
        redact.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
        const pad = (y1 - y0) * 0.12;
        const area: Rect = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
        if (!this.eraseInImages(doc, page, area)) this.paintBackground(doc, page, area);
      } else {
        const inset = (y1 - y0) * 0.2;
        const redact = page.createAnnotation("Redact");
        redact.setRect([x0, y0 + inset, x1, y1 - inset]);
        redact.update();
        redact.applyRedaction(0, mupdf.PDFPage.REDACT_IMAGE_NONE, mupdf.PDFPage.REDACT_LINE_ART_NONE, mupdf.PDFPage.REDACT_TEXT_REMOVE);
      }
      if (text && codes && originalDict && line.dict) {
        this.appendEncodedText(doc, page, textMatrix(line.origin, style.size), style.color, line.dict, codes, "edit");
        fontUsed = "embedded";
      } else if (text) {
        this.appendText(doc, page, [{ text, matrix: textMatrix(line.origin, style.size) }], style.color, 1, false, "edit", this.fontChain(style, primary));
      }
      return { font: fontUsed };
    });
  }

  /**
   * 把頁面上掃描影像中某個區域（頁面座標）的像素改成周圍的背景色。
   * 會建立新的影像物件並只替換本頁的資源，其他共用同一張影像的頁面不受影響。
   */
  private eraseInImages(doc: mupdf.PDFDocument, page: mupdf.PDFPage, area: Rect): boolean {
    const { images } = scanPage(page, true);
    const pageObj = page.getObject();
    let changed = false;
    for (const placed of images) {
      const bounds = transformRect([0, 0, 1, 1], placed.ctm);
      if (!rectsIntersect(bounds, area)) continue;
      const w = placed.image.getWidth();
      const h = placed.image.getHeight();
      const pageResources = resolved(pageObj.getInheritable("Resources"));
      const found = findImageXObject(pageResources, w, h, 0);
      if (!found) continue;
      let pixmap = placed.image.toPixmap();
      const cs = pixmap.getColorSpace();
      if (!cs || !(cs.isRGB() || cs.isGray()) || pixmap.getAlpha()) {
        const converted = pixmap.convertToColorSpace(mupdf.ColorSpace.DeviceRGB, false);
        pixmap.destroy();
        pixmap = converted;
      }
      // 頁面座標 → 影像像素（影像空間為單位正方形，像素第 0 列在上方）
      const inv = invert(placed.ctm);
      const [u0, v0, u1, v1] = transformRect(area, inv);
      const px = [Math.floor(Math.max(0, u0) * w), Math.floor(Math.max(0, v0) * h), Math.ceil(Math.min(1, u1) * w), Math.ceil(Math.min(1, v1) * h)] as Rect;
      if (px[2] <= px[0] || px[3] <= px[1]) {
        pixmap.destroy();
        continue;
      }
      fillWithBackground(pixmap, px);
      const ref = doc.addImage(new mupdf.Image(pixmap));
      pixmap.destroy();
      const oldImage = found.xobjects.get(found.name);
      for (const key of ["SMask", "Mask", "Interpolate"]) {
        const value = oldImage.get(key);
        if (!value.isNull()) ref.put(key, value);
      }
      if (found.depth === 0) {
        // 本頁使用自己的資源複本，其他共用同一張影像的頁面不受影響
        const ownResources = doc.addObject(cloneDict(doc, pageResources));
        const ownXObjects = cloneDict(doc, found.xobjects);
        ownXObjects.put(found.name, ref);
        ownResources.put("XObject", ownXObjects);
        pageObj.put("Resources", ownResources);
      } else {
        // 影像在表單 XObject 中（例如 macOS 版 OCR 產生的頁面），直接替換表單資源中的影像
        found.xobjects.put(found.name, ref);
      }
      changed = true;
    }
    return changed;
  }

  /** 找不到掃描影像時：以周圍的背景色蓋住該區域（例如 OCR 文字位於向量圖形上）。 */
  private paintBackground(doc: mupdf.PDFDocument, page: mupdf.PDFPage, area: Rect) {
    const rendered = page.toPixmap(mupdf.Matrix.scale(SAMPLE_SCALE, SAMPLE_SCALE), mupdf.ColorSpace.DeviceRGB, false, false);
    const { background } = sampleColors(rendered, area, SAMPLE_SCALE);
    rendered.destroy();
    const pageObj = page.getObject();
    const [x0, y0, x1, y1] = transformRect(area, invert(page.getTransform() as Matrix));
    wrapContents(doc, pageObj);
    const stream = doc.addStream(`q ${background.map(fmt).join(" ")} rg ${fmt(x0)} ${fmt(y0)} ${fmt(x1 - x0)} ${fmt(y1 - y0)} re f Q`, { [STAMP_KEY]: doc.newName("edit") });
    const contents = pageObj.get("Contents");
    if (contents.isArray()) contents.push(stream);
    else pageObj.put("Contents", [contents, stream]);
  }

  // MARK: - 遮蓋、平面化

  redactionCount(id: number): number {
    const doc = this.doc(id);
    let count = 0;
    for (let i = 0; i < doc.countPages(); i++) count += this.load(doc, i).getAnnotations().filter((a) => a.getType() === "Redact").length;
    return count;
  }

  /** 套用所有遮蓋：永久移除底下的文字、圖片像素與線條，並以黑色方塊覆蓋。 */
  applyRedactions(id: number): number {
    return this.op(id, "套用遮蓋", (doc) => {
      let pages = 0;
      for (let i = 0; i < doc.countPages(); i++) {
        const page = this.load(doc, i);
        const rects = page.getAnnotations().filter((a) => a.getType() === "Redact").map((a) => a.getRect() as Rect);
        if (!rects.length) continue;
        // 與遮蓋區域重疊的其他註解一併刪除，避免洩漏內容。
        for (const annot of page.getAnnotations()) {
          if (annot.getType() !== "Redact" && rects.some((r) => rectsIntersect(r, annot.getBounds() as Rect))) page.deleteAnnotation(annot);
        }
        page.applyRedactions(true, mupdf.PDFPage.REDACT_IMAGE_PIXELS, mupdf.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, mupdf.PDFPage.REDACT_TEXT_REMOVE);
        pages++;
      }
      return pages;
    });
  }

  /** 將所有註解與表單欄位固定到頁面內容中。 */
  flatten(id: number): void {
    this.op(id, "平面化", (doc) => doc.bake(true, true));
  }

  // MARK: - 書籤

  addBookmark(id: number, title: string, pageIndex: number): void {
    this.op(id, "新增書籤", (doc) => {
      const iterator = doc.outlineIterator();
      if (iterator.item() !== null) {
        while (iterator.next() === mupdf.OutlineIterator.ITERATOR_AT_ITEM) {
          // 移到最上層的最後面
        }
      }
      iterator.insert({ title, uri: pageUri(doc, pageIndex), open: true });
    });
  }

  renameBookmark(id: number, path: number[], title: string): void {
    this.op(id, "重新命名書籤", (doc) => {
      const iterator = seekOutline(doc, path);
      const item = iterator.item();
      if (!item) throw new Error("找不到書籤");
      iterator.update({ ...item, title });
    });
  }

  deleteBookmark(id: number, path: number[]): void {
    this.op(id, "刪除書籤", (doc) => {
      seekOutline(doc, path).delete();
    });
  }

  // MARK: - 復原

  undo(id: number): void {
    const doc = this.doc(id);
    if (doc.canUndo()) doc.undo();
  }

  redo(id: number): void {
    const doc = this.doc(id);
    if (doc.canRedo()) doc.redo();
  }

  // MARK: - 存檔與匯出

  save(id: number, options: SaveOptions = {}): Uint8Array {
    const doc = this.doc(id);
    const flags = options.compress
      ? ["garbage=deduplicate", "compress", "compress-images", "compress-fonts", "clean"]
      : ["garbage=compact", "compress"];
    if (options.userPassword || options.ownerPassword) {
      flags.push("encrypt=aes-256");
      if (options.userPassword) flags.push(`user-password=${escapeOption(options.userPassword)}`);
      flags.push(`owner-password=${escapeOption(options.ownerPassword || options.userPassword || "")}`);
    } else {
      flags.push("encrypt=none");
    }
    return doc.saveToBuffer(flags.join(",")).asUint8Array().slice();
  }

  exportPageImage(id: number, pageIndex: number, dpi: number, format: ImageFormat, quality = 90): Uint8Array {
    const page = this.page(id, pageIndex);
    const scale = dpi / 72;
    const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
    const data = format === "png" ? pixmap.asPNG() : pixmap.asJPEG(quality);
    const copy = data.slice();
    pixmap.destroy();
    return copy;
  }

  exportText(id: number): string {
    const doc = this.doc(id);
    const parts: string[] = [];
    for (let i = 0; i < doc.countPages(); i++) parts.push(`--- 第 ${i + 1} 頁 ---\n${this.pageText(id, i).trim()}`);
    return parts.join("\n\n");
  }

  hasText(id: number, pageIndex: number): boolean {
    return this.pageText(id, pageIndex).trim().length > 0;
  }
}

// MARK: - 輔助函式

interface StyleFlags {
  bold: boolean;
  italic: boolean;
  serif: boolean;
  mono: boolean;
}

const PLAIN_STYLE: StyleFlags = { bold: false, italic: false, serif: false, mono: false };

interface GlyphRun {
  font: mupdf.Font;
  gids: number[];
  text: string;
  width: number;
}

export interface ReplaceOptions {
  /** 改變字級、顏色或樣式 */
  override?: Partial<Pick<TextLine, "size" | "color" | "bold" | "italic" | "serif" | "mono">>;
  /** 電腦上的或下載的字型檔 */
  font?: FontData | null;
  /** 主要字型缺字時使用的字型（例如英文字型遇到中文） */
  fallbackFont?: FontData | null;
  /** 使用者自選字型：不沿用原檔字型 */
  forceFont?: boolean;
}

export interface FontData {
  data: Uint8Array;
  /** 字型集合（.ttc）中的第幾個字型 */
  index?: number;
}

type AnalyzedLine = TextLine & { dict: mupdf.PDFObject | null };

/** 取樣顏色時的渲染倍率。 */
const SAMPLE_SCALE = 2;

/** 解析間接參照；null 物件直接回傳（MuPDF 的 null 物件無法 resolve）。 */
function resolved(obj: mupdf.PDFObject): mupdf.PDFObject {
  return obj.isNull() ? obj : obj.resolve();
}

function pointKey([x, y]: Point): string {
  return `${Math.round(x * 10)},${Math.round(y * 10)}`;
}

/** 掃描頁面內容：隱形文字（render mode 3，例如 OCR 文字層）的字形位置，以及頁面上的影像。 */
function scanPage(page: mupdf.PDFPage, wantImages: boolean): { invisible: Set<string>; images: Array<{ image: mupdf.Image; ctm: Matrix }> } {
  const invisible = new Set<string>();
  const images: Array<{ image: mupdf.Image; ctm: Matrix }> = [];
  const device = new mupdf.Device({
    ignoreText(text, ctm) {
      text.walk({
        showGlyph(_font, trm) {
          invisible.add(pointKey(transformPoint([trm[4], trm[5]], ctm as Matrix)));
        },
      });
    },
    fillImage(image, ctm) {
      if (wantImages) images.push({ image, ctm: ctm as Matrix });
    },
  });
  try {
    page.runPageContents(device, mupdf.Matrix.identity);
  } finally {
    device.close();
  }
  return { invisible, images };
}

/** 在資源（含巢狀表單 XObject）中找出指定像素大小的影像 XObject。 */
function findImageXObject(resources: mupdf.PDFObject, w: number, h: number, depth: number): { xobjects: mupdf.PDFObject; name: string; depth: number } | null {
  if (!resources.isDictionary()) return null;
  const xobjects = resolved(resources.get("XObject"));
  if (!xobjects.isDictionary()) return null;
  let found: { xobjects: mupdf.PDFObject; name: string; depth: number } | null = null;
  const forms: mupdf.PDFObject[] = [];
  // 注意：不可對串流物件呼叫 resolve()（MuPDF.js 會讓之後存檔的串流損壞）；get() 會自動解析間接參照
  xobjects.forEach((value, key) => {
    if (found) return;
    const subtype = value.get("Subtype");
    if (!subtype.isName()) return;
    if (subtype.asName() === "Image" && value.get("Width").asNumber() === w && value.get("Height").asNumber() === h) found = { xobjects, name: String(key), depth };
    else if (subtype.asName() === "Form") forms.push(value);
  });
  if (found || depth >= 3) return found;
  for (const form of forms) {
    const inner = form.get("Resources");
    const result = inner.isNull() ? null : findImageXObject(resolved(inner), w, h, depth + 1);
    if (result) return result;
  }
  return null;
}

/** 頁面（含表單 XObject）資源中的所有字型字典。 */
function pageFonts(page: mupdf.PDFPage): mupdf.PDFObject[] {
  const found: mupdf.PDFObject[] = [];
  const seen = new Set<number>();
  const visit = (resources: mupdf.PDFObject, depth: number) => {
    if (!resources.isDictionary()) return;
    const fonts = resolved(resources.get("Font"));
    if (fonts.isDictionary()) {
      fonts.forEach((value) => {
        const key = value.isIndirect() ? value.asIndirect() : -1;
        if (key > 0 && seen.has(key)) return;
        if (key > 0) seen.add(key);
        if (value.resolve().isDictionary()) found.push(value);
      });
    }
    const xobjects = resolved(resources.get("XObject"));
    if (depth < 3 && xobjects.isDictionary()) {
      // 注意：不可對串流物件呼叫 resolve()（MuPDF.js 會讓之後存檔的串流損壞）；get() 會自動解析間接參照
      xobjects.forEach((value) => {
        const subtype = value.get("Subtype");
        if (!subtype.isName() || subtype.asName() !== "Form") return;
        const inner = value.get("Resources");
        if (!inner.isNull()) visit(inner.resolve(), depth + 1);
      });
    }
  };
  const resources = page.getObject().getInheritable("Resources");
  if (!resources.isNull()) visit(resources.resolve(), 0);
  return found;
}

function channelMedian(values: number[]): number {
  if (!values.length) return 255;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** 取樣像素區域 `px` 外圍一圈的背景色（各色版的中位數）。 */
function ringColor(pixels: Uint8ClampedArray, width: number, height: number, stride: number, n: number, [x0, y0, x1, y1]: Rect, ring: number): number[] {
  const channels: number[][] = Array.from({ length: n }, () => []);
  const add = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = y * stride + x * n;
    for (let c = 0; c < n; c++) channels[c].push(pixels[i + c]);
  };
  const step = Math.max(1, Math.floor((x1 - x0 + y1 - y0) / 400));
  for (let r = 1; r <= ring; r++) {
    for (let x = x0 - r; x < x1 + r; x += step) {
      add(x, y0 - r);
      add(x, y1 - 1 + r);
    }
    for (let y = y0 - r; y < y1 + r; y += step) {
      add(x0 - r, y);
      add(x1 - 1 + r, y);
    }
  }
  return channels.map(channelMedian);
}

/** 由渲染後的頁面取樣某區域（頁面座標）的背景色與文字顏色（0–1 RGB）。 */
function sampleColors(pixmap: mupdf.Pixmap, area: Rect, scale: number): { background: RGB; text: RGB } {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const n = pixmap.getNumberOfComponents();
  const pixels = pixmap.getPixels();
  const px = area.map((v, i) => (i < 2 ? Math.floor(v * scale) : Math.ceil(v * scale))) as Rect;
  const x0 = Math.max(0, px[0]);
  const y0 = Math.max(0, px[1]);
  const x1 = Math.min(width, px[2]);
  const y1 = Math.min(height, px[3]);
  const bg = ringColor(pixels, width, height, stride, n, [x0, y0, x1, y1], 3).slice(0, 3);
  // 與背景差異最大的像素即為文字筆畫
  const ink: Array<[number, number, number, number]> = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * stride + x * n;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      const d = Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]);
      if (d > 90) ink.push([d, r, g, b]);
    }
  }
  const background = bg.map((v) => v / 255) as RGB;
  if (ink.length < 4) return { background, text: [0, 0, 0] };
  ink.sort((a, b) => b[0] - a[0]);
  const top = ink.slice(0, Math.max(4, Math.floor(ink.length * 0.3)));
  const text = [1, 2, 3].map((c) => top.reduce((sum, p) => sum + p[c], 0) / top.length / 255) as RGB;
  // 接近黑色的掃描文字直接當作黑色
  return { background, text: text.every((v) => v < 0.25) ? [0, 0, 0] : text.map((v) => Math.round(v * 100) / 100) as RGB };
}

/** 把像素區域填成外圍的背景色（每一列依左右兩側的顏色漸變，讓紙張色澤較自然）。 */
function fillWithBackground(pixmap: mupdf.Pixmap, [x0, y0, x1, y1]: Rect) {
  const width = pixmap.getWidth();
  const height = pixmap.getHeight();
  const stride = pixmap.getStride();
  const n = pixmap.getNumberOfComponents();
  const pixels = pixmap.getPixels();
  const ring = Math.max(2, Math.round((y1 - y0) * 0.15));
  const whole = ringColor(pixels, width, height, stride, n, [x0, y0, x1, y1], ring);
  const band = Math.max(1, Math.floor((y1 - y0) / 4));
  const side = (x: number, y: number) => ringColor(pixels, width, height, stride, n, [x, Math.max(0, y - band), x + 1, Math.min(height, y + band + 1)], ring);
  const rows: Array<[number[], number[]]> = [];
  for (let y = y0; y < y1; y++) {
    const left = x0 > 0 ? side(x0 - 1 - ring, y) : whole;
    const right = x1 < width ? side(x1 + ring, y) : whole;
    // 左右差太多（例如旁邊是圖案）時改用整圈的中位數
    const far = (c: number[]) => c.some((v, i) => Math.abs(v - whole[i]) > 40);
    rows.push([far(left) ? whole : left, far(right) ? whole : right]);
  }
  for (let y = y0; y < y1; y++) {
    const [left, right] = rows[y - y0];
    for (let x = x0; x < x1; x++) {
      const t = x1 - x0 > 1 ? (x - x0) / (x1 - x0 - 1) : 0;
      const i = y * stride + x * n;
      for (let c = 0; c < n; c++) pixels[i + c] = Math.round(left[c] * (1 - t) + right[c] * t);
    }
  }
}

export interface ReplaceResult {
  /** embedded：沿用原檔字型；supplied：使用提供的字型；mixed：提供的字型缺字，部分字元用標準字型；standard：標準字型 */
  font: "embedded" | "supplied" | "mixed" | "standard";
}

/** 載入字型檔；失敗時回傳 null。 */
function loadFont(name: string, data: Uint8Array, index = 0): mupdf.Font | null {
  try {
    return new mupdf.Font(name, data, index);
  } catch {
    return null;
  }
}

/** 字型描述（FontDescriptor）的 Flags：1 等寬、2 襯線；沒有時回傳 null。 */
function descriptorFlags(ref: mupdf.PDFObject): number | null {
  const dict = ref.resolve();
  let descriptor = dict.get("FontDescriptor");
  if (descriptor.isNull()) {
    const descendants = dict.get("DescendantFonts");
    if (descendants.isArray() && descendants.length > 0) descriptor = descendants.get(0).get("FontDescriptor");
  }
  const flags = descriptor.isDictionary() ? descriptor.get("Flags") : null;
  return flags?.isNumber() ? flags.asNumber() : null;
}

/** 字型字典的內嵌字型檔。 */
function fontFileOf(dict: mupdf.PDFObject): Uint8Array | null {
  let descriptor = dict.get("FontDescriptor");
  if (descriptor.isNull()) {
    const descendants = dict.get("DescendantFonts");
    if (!descendants.isArray() || descendants.length === 0) return null;
    descriptor = descendants.get(0).resolve().get("FontDescriptor");
  }
  if (!descriptor.isDictionary()) return null;
  for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
    const file = descriptor.get(key);
    if (file.isStream()) {
      try {
        return file.readStream().asUint8Array().slice();
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 由字型的 ToUnicode 對照表反查「字元 → 字碼」，用來直接沿用原字型寫入新文字。
 * 只支援單位元組簡單字型與 Identity-H 的雙位元組 CID 字型；無法使用時回傳 null。
 */
export function originalFontEncoder(dict: mupdf.PDFObject): Map<string, string> | null {
  const subtype = dict.get("Subtype").isName() ? dict.get("Subtype").asName() : "";
  const encoding = dict.get("Encoding");
  let bytes: number;
  if (subtype === "Type0") {
    if (!encoding.isName() || encoding.asName() !== "Identity-H") return null;
    bytes = 2;
  } else if (["Type1", "TrueType", "MMType1"].includes(subtype)) {
    bytes = 1;
  } else {
    return null;
  }
  const toUnicode = dict.get("ToUnicode");
  if (!toUnicode.isStream()) return null;
  let cmap: string;
  try {
    cmap = new TextDecoder("latin1").decode(toUnicode.readStream().asUint8Array());
  } catch {
    return null;
  }
  // 確認字碼對應的字形確實存在（子集化後的字型可能只剩部分字形）
  let hasGlyph: (code: number) => boolean;
  if (bytes === 2) {
    const file = fontFileOf(dict);
    const descendant = dict.get("DescendantFonts").get(0).resolve();
    const identityMap = !descendant.get("CIDToGIDMap").isStream();
    const checker = file && identityMap ? trueTypeGlyphChecker(file) : null;
    if (!checker) return null;
    hasGlyph = checker;
  } else {
    const widths = dict.get("Widths");
    const first = dict.get("FirstChar").isNumber() ? dict.get("FirstChar").asNumber() : 0;
    hasGlyph = (code) => {
      if (!widths.isArray()) return true;
      const w = widths.get(code - first);
      return w.isNumber() && w.asNumber() > 0;
    };
  }
  const map = parseToUnicode(cmap);
  const result = new Map<string, string>();
  for (const [code, unicode] of map) {
    if (code.length !== bytes * 2 || [...unicode].length !== 1) continue;
    if (unicode.trim() && !hasGlyph(parseInt(code, 16))) continue;
    if (!result.has(unicode)) result.set(unicode, code);
  }
  return result.size ? result : null;
}

/** 讀取 TrueType 字型的 loca 表，判斷某個字形是否有輪廓資料。非 TrueType 時回傳 null。 */
export function trueTypeGlyphChecker(data: Uint8Array): ((gid: number) => boolean) | null {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tag = view.getUint32(0);
    if (tag !== 0x00010000 && tag !== 0x74727565) return null; // 只處理 TrueType 輪廓
    const tables = new Map<string, number>();
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const record = 12 + i * 16;
      const name = String.fromCharCode(data[record], data[record + 1], data[record + 2], data[record + 3]);
      tables.set(name, view.getUint32(record + 8));
    }
    const head = tables.get("head");
    const loca = tables.get("loca");
    const maxp = tables.get("maxp");
    if (head === undefined || loca === undefined || maxp === undefined) return null;
    const longFormat = view.getInt16(head + 50) === 1;
    const numGlyphs = view.getUint16(maxp + 4);
    const offset = (gid: number) => (longFormat ? view.getUint32(loca + gid * 4) : view.getUint16(loca + gid * 2) * 2);
    return (gid) => gid > 0 && gid < numGlyphs && offset(gid + 1) > offset(gid);
  } catch {
    return null;
  }
}

function hexToString(hex: string): string {
  let text = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  if (hex.length === 2) text = String.fromCharCode(parseInt(hex, 16));
  return text;
}

/** 解析 ToUnicode CMap（bfchar／bfrange），回傳 字碼（十六進位，大寫）→ 字元。 */
export function parseToUnicode(cmap: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const [, src, dst] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(src.toUpperCase(), hexToString(dst));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(\[[^\]]*\]|<[0-9a-fA-F]+>)/g)) {
      const start = parseInt(lo, 16);
      const end = parseInt(hi, 16);
      if (end - start > 0xffff) continue;
      if (rest.startsWith("[")) {
        [...rest.matchAll(/<([0-9a-fA-F]+)>/g)].forEach(([, dst], i) => {
          if (start + i <= end) map.set((start + i).toString(16).toUpperCase().padStart(lo.length, "0"), hexToString(dst));
        });
      } else {
        const dstHex = rest.slice(1, -1);
        const base = parseInt(dstHex.slice(-4), 16);
        const prefix = hexToString(dstHex.slice(0, -4));
        for (let code = start; code <= end; code++) {
          map.set(code.toString(16).toUpperCase().padStart(lo.length, "0"), prefix + String.fromCharCode(base + code - start));
        }
      }
    }
  }
  return map;
}

/** 以原字型的字碼表編碼文字；有任何字元沒有對應字碼時回傳 null。 */
function encodeWith(encoder: Map<string, string>, text: string): string | null {
  let hex = "";
  for (const ch of text) {
    const code = encoder.get(ch);
    if (!code) return null;
    hex += code;
  }
  return hex || null;
}

function coversText(font: mupdf.Font, text: string): boolean {
  for (const ch of text) {
    if (ch.trim() && font.encodeCharacter(ch) <= 0) return false;
  }
  return true;
}

type LatinFont =
  | "Helvetica" | "Helvetica-Bold" | "Helvetica-Oblique" | "Helvetica-BoldOblique"
  | "Times-Roman" | "Times-Bold" | "Times-Italic" | "Times-BoldItalic"
  | "Courier" | "Courier-Bold" | "Courier-Oblique" | "Courier-BoldOblique";

/** 依原字型特徵挑選最接近的標準字型。 */
export function latinFontFor({ bold, italic, serif, mono }: { bold: boolean; italic: boolean; serif: boolean; mono: boolean }): LatinFont {
  if (mono) return bold ? (italic ? "Courier-BoldOblique" : "Courier-Bold") : italic ? "Courier-Oblique" : "Courier";
  if (serif) return bold ? (italic ? "Times-BoldItalic" : "Times-Bold") : italic ? "Times-Italic" : "Times-Roman";
  return bold ? (italic ? "Helvetica-BoldOblique" : "Helvetica-Bold") : italic ? "Helvetica-Oblique" : "Helvetica";
}

function toRgb(color: number[]): RGB {
  if (color.length >= 4) {
    const [c, m, y, k] = color;
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  if (color.length === 3) return [color[0], color[1], color[2]];
  if (color.length === 1) return [color[0], color[0], color[0]];
  return [0, 0, 0];
}

function transformRect([x0, y0, x1, y1]: Rect, m: Matrix): Rect {
  const points = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map((p) => transformPoint(p as Point, m));
  return pointsBounds(points);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** MuPDF RGB 像素（可能有列尾補齊）轉為 canvas 使用的 RGBA。 */
function rgbToRgba(rgb: Uint8ClampedArray, width: number, height: number, stride: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let src = y * stride;
    let dst = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[dst] = rgb[src];
      out[dst + 1] = rgb[src + 1];
      out[dst + 2] = rgb[src + 2];
      out[dst + 3] = 255;
      src += 3;
      dst += 4;
    }
  }
  return out;
}

function normalizeRotation(degrees: number): number {
  return (((Math.round(degrees / 90) * 90) % 360) + 360) % 360;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function safeResolve(doc: mupdf.PDFDocument, uri: string): number | null {
  try {
    const page = doc.resolveLink(uri);
    return page >= 0 ? page : null;
  } catch {
    return null;
  }
}

function pageUri(doc: mupdf.PDFDocument, pageIndex: number): string {
  try {
    return doc.formatLinkURI({ type: "Fit", chapter: 0, page: pageIndex, x: 0, y: 0, width: 0, height: 0, zoom: 0 });
  } catch {
    return `#page=${pageIndex + 1}`;
  }
}

function seekOutline(doc: mupdf.PDFDocument, path: number[]): mupdf.OutlineIterator {
  const iterator = doc.outlineIterator();
  path.forEach((index, depth) => {
    if (depth > 0 && iterator.down() !== mupdf.OutlineIterator.ITERATOR_AT_ITEM) throw new Error("找不到書籤");
    for (let i = 0; i < index; i++) {
      if (iterator.next() !== mupdf.OutlineIterator.ITERATOR_AT_ITEM) throw new Error("找不到書籤");
    }
  });
  return iterator;
}

function graftAll(target: mupdf.PDFDocument, source: mupdf.PDFDocument, at: number) {
  const graft = target.newGraftMap();
  const count = source.countPages();
  for (let i = 0; i < count; i++) graft.graftPage(at + i, source, i);
}

function annotInfo(annot: mupdf.PDFAnnotation, page: number): AnnotInfo {
  const role = annot.getObject().get(ROLE_KEY);
  const type = annot.getType();
  let rect = annot.getBounds() as Rect;
  if (annot.hasInkList() || annot.hasLine()) rect = inflate(rect, 2);
  return {
    id: annot.getObject().asIndirect(),
    page,
    type,
    rect,
    contents: safe(() => annot.getContents(), ""),
    color: safe(() => annot.getColor() as number[], []),
    role: role.isName() ? role.asName() : role.isString() ? role.asString() : "",
    lineEnd: annot.hasLineEndingStyles() ? annot.getLineEndingStyles().end : undefined,
    textStyle: type === "FreeText" ? freeTextStyle(annot) : undefined,
  };
}

function freeTextStyle(annot: mupdf.PDFAnnotation): TextBoxStyle {
  const obj = annot.getObject();
  const da = safe(() => annot.getDefaultAppearance(), { font: "Helv", size: 12, color: [0, 0, 0] as number[] });
  const family = obj.get(FONT_KEY);
  const flags = obj.get(FONT_STYLE_KEY);
  const styleText = flags.isString() ? flags.asString() : "";
  const color = (da.color?.length === 3 ? da.color : da.color?.length === 1 ? [da.color[0], da.color[0], da.color[0]] : [0, 0, 0]) as RGB;
  return {
    fontSize: da.size || 12,
    color,
    family: family.isString() && family.asString() ? family.asString() : undefined,
    bold: /bold/.test(styleText),
    italic: /italic/.test(styleText),
  };
}

function widgetKind(widget: mupdf.PDFWidget): WidgetKind {
  const type = safe(() => widget.getFieldType(), "");
  switch (type) {
    case "text": return "text";
    case "checkbox": return "checkbox";
    case "radiobutton": return "radio";
    case "combobox": return "combobox";
    case "listbox": return "listbox";
    case "button": return "button";
    case "signature": return "signature";
    default: return "unknown";
  }
}

/** 依文字內容估算 FreeText 註解的外框。中日韓字元寬 1em，其他約 0.55em。 */
export function freeTextRect(at: Point, text: string, fontSize: number): Rect {
  const lines = text.split("\n");
  const widthEm = Math.max(1, ...lines.map((line) => [...line].reduce((sum, ch) => sum + (/[⺀-￯]/.test(ch) ? 1 : 0.58), 0)));
  const width = widthEm * fontSize + 10;
  const height = lines.length * fontSize * 1.3 + 8;
  return [at[0], at[1], at[0] + width, at[1] + height];
}

function escapeOption(value: string): string {
  if (/[,=]/.test(value)) throw new Error("密碼不可包含逗號或等號");
  return value;
}

function ensureDict(doc: mupdf.PDFDocument, parent: mupdf.PDFObject, key: string, inheritable = false): mupdf.PDFObject {
  let value = inheritable ? parent.getInheritable(key) : parent.get(key);
  if (value.isNull()) {
    value = doc.addObject(doc.newDictionary());
    parent.put(key, value);
  } else if (inheritable && parent.get(key).isNull()) {
    // 繼承自上層的資源：複製一份到本頁，避免影響其他頁面
    const copy = doc.addObject(cloneDict(doc, value.resolve()));
    parent.put(key, copy);
    value = copy;
  }
  return value;
}

function cloneDict(doc: mupdf.PDFDocument, source: mupdf.PDFObject): mupdf.PDFObject {
  const copy = doc.newDictionary();
  source.forEach((val, key) => {
    copy.put(key, val);
  });
  return copy;
}

/** 以 q/Q 包住原有內容，避免原本未恢復的繪圖狀態影響新加入的文字。只做一次。 */
function wrapContents(doc: mupdf.PDFDocument, pageObj: mupdf.PDFObject) {
  const contents = pageObj.get("Contents");
  if (contents.isArray() && contents.length > 0 && !contents.get(0).get(WRAP_KEY).isNull()) return;
  const open = doc.addStream("q", { [WRAP_KEY]: true });
  const close = doc.addStream("Q", { [WRAP_KEY]: true });
  const items: mupdf.PDFObject[] = [];
  if (contents.isArray()) contents.forEach((item) => items.push(item));
  else if (!contents.isNull()) items.push(contents);
  pageObj.put("Contents", [open, ...items, close]);
}

export { pointsBounds, quadBounds };
