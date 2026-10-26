import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it } from "vitest";
import { PdfEngine } from "../src/engine/pdfEngine";
import type { ImageEditObject } from "../src/engine/types";
import { builtinFontBytes, makePdf, makePng, regionColor } from "./helpers";

function pageSize(data: Uint8Array): number[] {
  const bounds = mupdf.Document.openDocument(data, "application/pdf").loadPage(0).getBounds();
  return [bounds[2] - bounds[0], bounds[3] - bounds[1]];
}

describe("影像編輯模式", () => {
  let engine: PdfEngine;
  beforeEach(() => {
    engine = new PdfEngine();
  });

  it("輸出整頁影像（不含註解）", () => {
    const { id } = engine.open(makePdf(1));
    const result = engine.editorImage(id, 0, 144);
    const image = new mupdf.Image(result.png);
    expect([result.width, result.height]).toEqual([595, 842]);
    expect([image.getWidth(), image.getHeight()]).toEqual([1190, 1684]);
  });

  it("只加入物件時保留原本內容，文字可搜尋且字型內嵌", () => {
    const { id } = engine.open(makePdf(1));
    const objects: ImageEditObject[] = [
      { type: "text", x: 100, y: 300, w: 300, h: 60, rotation: 0, text: "影像編輯 Text\n第二行", size: 20, color: [0, 0, 1], bold: false, italic: false, align: "left", opacity: 1, font: { data: builtinFontBytes("zh-Hant") } },
      { type: "rect", x: 100, y: 500, w: 100, h: 50, rotation: 0, stroke: null, fill: [1, 0, 0], strokeWidth: 0, opacity: 1 },
      { type: "ellipse", x: 300, y: 500, w: 100, h: 50, rotation: 30, stroke: [0, 0.6, 0], fill: null, strokeWidth: 3, opacity: 1 },
      { type: "arrow", x1: 100, y1: 650, x2: 300, y2: 650, stroke: [0, 0, 0], strokeWidth: 2, opacity: 1 },
      { type: "image", x: 400, y: 650, w: 80, h: 40, rotation: 0, data: makePng(40, 20), opacity: 1 },
    ];
    engine.applyImageEdit(id, 0, { width: 595, height: 842, background: null, objects });
    const text = engine.pageText(id, 0);
    expect(text).toContain("Page 1");
    expect(text).toContain("影像編輯 Text");
    expect(text).toContain("第二行");
    const lines = engine.textLines(id, 0);
    const first = lines.find((l) => l.text.startsWith("影像編輯"))!;
    expect(first.origin[0]).toBeCloseTo(100, 0);
    expect(first.origin[1]).toBeCloseTo(300 + 20 * 0.88, 0);
    const saved = engine.save(id);
    const red = regionColor(saved, [110, 510, 190, 540]);
    expect(red[0]).toBeGreaterThan(240);
    expect(red[1]).toBeLessThan(20);
    // 箭頭線段
    expect(regionColor(saved, [150, 649, 250, 651])[0]).toBeLessThan(80);
    // 圖片（灰色 80）
    expect(Math.abs(regionColor(saved, [410, 655, 470, 685])[0] - 80)).toBeLessThan(10);
    engine.undo(id);
    expect(engine.pageText(id, 0)).not.toContain("影像編輯");
  });

  it("旋轉的文字以外框中心旋轉", () => {
    const { id } = engine.open(makePdf(1));
    engine.applyImageEdit(id, 0, {
      width: 595,
      height: 842,
      background: null,
      objects: [{ type: "text", x: 200, y: 400, w: 200, h: 24, rotation: 90, text: "Rotated", size: 20, color: [0, 0, 0], bold: false, italic: false, align: "center", opacity: 1 }],
    });
    expect(engine.pageText(id, 0)).toContain("Rotated");
    // 旋轉 90° 後文字直立在外框中心（x≈300）附近
    const saved = engine.save(id);
    expect(regionColor(saved, [290, 340, 312, 460])[0]).toBeLessThan(250);
    expect(regionColor(saved, [200, 405, 260, 420])[0]).toBeGreaterThan(250);
  });

  it("修改像素並裁切：整頁換成新影像、頁面大小改變、註解移除", () => {
    const { id } = engine.open(makePdf(1));
    engine.addNote(id, 0, [100, 100], "備註", [1, 1, 0]);
    const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 600, 400], false);
    pixmap.clear(200);
    engine.applyImageEdit(id, 0, {
      width: 300,
      height: 200,
      background: pixmap.asPNG(),
      objects: [{ type: "text", x: 20, y: 20, w: 200, h: 30, rotation: 0, text: "Cropped", size: 18, color: [0, 0, 0], bold: true, italic: false, align: "left", opacity: 1 }],
    });
    const saved = engine.save(id);
    expect(pageSize(saved)).toEqual([300, 200]);
    expect(engine.annotations(id, 0)).toHaveLength(0);
    expect(engine.pageText(id, 0)).toContain("Cropped");
    expect(engine.pageText(id, 0)).not.toContain("Page 1");
    expect(regionColor(saved, [200, 150, 280, 190])[0]).toBe(200);
    engine.undo(id);
    expect(pageSize(engine.save(id))).toEqual([595, 842]);
    expect(engine.annotations(id, 0)).toHaveLength(1);
  });

  it("修改像素但頁面大小不變時保留註解", () => {
    const { id } = engine.open(makePdf(1));
    engine.addNote(id, 0, [100, 100], "備註", [1, 1, 0]);
    const { png } = engine.editorImage(id, 0, 72);
    engine.applyImageEdit(id, 0, { width: 595, height: 842, background: png, objects: [] });
    expect(engine.annotations(id, 0)).toHaveLength(1);
    expect(engine.annotations(id, 0)[0].rect[0]).toBeCloseTo(90, 0);
  });
});
