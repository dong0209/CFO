import * as mupdf from "mupdf";
import { centeredOrigin, concat, inflate, invert, normalizeRect, pointsBounds, quadBounds, rectsIntersect, stampOrigin, textMatrix } from "./geometry";
import { chunk, moveItems, renderPageNumber } from "./pageRanges";
import type {
  AnnotInfo, DocInfo, ImageFormat, LinkInfo, MarkupKind, Matrix, OcrLine, OpenResult, OutlineNode,
  PageInfo, PageNumberOptions, Point, Quad, Rect, RenderResult, RGB, SaveOptions, SearchHit, ShapeKind,
  TextSelection, WatermarkOptions, WidgetInfo, WidgetKind,
} from "./types";

type OutlineItems = NonNullable<ReturnType<mupdf.PDFDocument["loadOutline"]>>;

const ROLE_KEY = "PDFEditorRole";
const STAMP_KEY = "PDFEditorStamp";
const WRAP_KEY = "PDFEditorWrap";
const A4: [number, number] = [595.28, 841.89];

interface DocEntry {
  doc: mupdf.PDFDocument;
  /** 目前已驗證的開啟密碼 */
  password: string | null;
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
    this.docs.set(id, { doc, password: null });
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

  addFreeText(id: number, pageIndex: number, at: Point, text: string, fontSize: number, color: RGB): number {
    return this.op(id, "文字方塊", () => {
      const annot = this.page(id, pageIndex).createAnnotation("FreeText");
      annot.setRect(freeTextRect(at, text, fontSize));
      annot.setDefaultAppearance("Helv", fontSize, color);
      annot.setContents(text);
      annot.setBorderWidth(0);
      annot.update();
      return annot.getObject().asIndirect();
    });
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
      const annot = this.findAnnot(this.page(id, pageIndex), annotId);
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
          if (role.isName() && role.asName() !== "ocr") {
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

  private latinFont: mupdf.Font | null = null;

  private font(): mupdf.Font {
    this.cjkFont ??= new mupdf.Font("zh-Hant");
    return this.cjkFont;
  }

  private helvetica(): mupdf.Font {
    this.latinFont ??= new mupdf.Font("Helvetica");
    return this.latinFont;
  }

  /**
   * 將文字分成英數字（Helvetica，閱讀器皆內建正確字寬）與其他字元（中文字型，每字 1em）。
   * 未內嵌的中文字型沒有個別字寬，英數字若用它會被當成全形寬度。
   */
  private textRuns(text: string): Array<{ latin: boolean; text: string; width: number }> {
    const runs: Array<{ latin: boolean; text: string; width: number }> = [];
    const helv = this.helvetica();
    for (const ch of text) {
      const code = ch.codePointAt(0) ?? 0;
      const latin = code >= 0x20 && code <= 0x7e;
      const width = latin ? helv.advanceGlyph(helv.encodeCharacter(ch)) : 1;
      const last = runs[runs.length - 1];
      if (last && last.latin === latin) {
        last.text += ch;
        last.width += width;
      } else {
        runs.push({ latin, text: ch, width });
      }
    }
    return runs;
  }

  /** 以 em 為單位的文字寬度。 */
  textWidth(text: string): number {
    return this.textRuns(text).reduce((sum, run) => sum + run.width, 0);
  }

  /** 在頁面內容最上層加入文字（位置以頁面座標的文字矩陣表示）。 */
  private appendText(
    doc: mupdf.PDFDocument,
    page: mupdf.PDFPage,
    runs: Array<{ text: string; matrix: Matrix }>,
    color: RGB,
    opacity: number,
    invisible: boolean,
    role: string,
  ) {
    const pageObj = page.getObject();
    const resources = ensureDict(doc, pageObj, "Resources", true);
    const fonts = ensureDict(doc, resources, "Font");
    if (fonts.get("PEFont").isNull()) fonts.put("PEFont", doc.addCJKFont(this.font(), "zh-Hant"));
    if (fonts.get("PEHelv").isNull()) fonts.put("PEHelv", doc.addSimpleFont(this.helvetica(), "Latin"));
    const states = ensureDict(doc, resources, "ExtGState");
    const gsName = `PEGS${Math.round(opacity * 100)}`;
    if (states.get(gsName).isNull()) states.put(gsName, { Type: doc.newName("ExtGState"), ca: opacity, CA: opacity });

    const toUser = invert(page.getTransform() as Matrix);
    const ops = [`q /${gsName} gs ${color.map(fmt).join(" ")} rg BT ${invisible ? 3 : 0} Tr`];
    for (const run of runs) {
      const m = concat(run.matrix, toUser);
      ops.push(`${m.map(fmt).join(" ")} Tm`);
      for (const part of this.textRuns(run.text)) {
        ops.push(part.latin ? `/PEHelv 1 Tf (${escapePdfString(part.text)}) Tj` : `/PEFont 1 Tf <${utf16Hex(part.text)}> Tj`);
      }
    }
    ops.push("ET Q");

    wrapContents(doc, pageObj);
    const stream = doc.addStream(ops.join("\n"), { [STAMP_KEY]: doc.newName(role) });
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

function escapePdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

function utf16Hex(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0");
  return hex;
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
