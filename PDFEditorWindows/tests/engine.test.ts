import { beforeEach, describe, expect, it } from "vitest";
import { PdfEngine } from "../src/engine/pdfEngine";
import { makePdf, makePng } from "./helpers";

const texts = (engine: PdfEngine, id: number) =>
  Array.from({ length: engine.info(id).pageCount }, (_, i) => engine.pageText(id, i).trim());

let engine: PdfEngine;

beforeEach(() => {
  engine = new PdfEngine();
});

describe("開啟與資訊", () => {
  it("讀取頁數、尺寸與文字", () => {
    const { id, needsPassword } = engine.open(makePdf(3, [612, 792]));
    expect(needsPassword).toBe(false);
    const info = engine.info(id);
    expect(info.pageCount).toBe(3);
    expect(info.pages[0]).toEqual({ width: 612, height: 792, rotation: 0 });
    expect(texts(engine, id)).toEqual(["Page 1", "Page 2", "Page 3"]);
  });

  it("渲染頁面為 RGBA", () => {
    const { id } = engine.open(makePdf(1, [100, 200]));
    const result = engine.render(id, 0, 2);
    expect(result.width).toBe(200);
    expect(result.height).toBe(400);
    expect(result.pixels.length).toBe(200 * 400 * 4);
  });

  it("建立空白文件與從圖片建立", () => {
    const blank = engine.createBlank();
    expect(engine.info(blank).pageCount).toBe(1);
    const fromImages = engine.createFromImages([makePng(96, 48), makePng(10, 10)]);
    const info = engine.info(fromImages);
    expect(info.pageCount).toBe(2);
    expect(info.pages[0].width).toBeCloseTo(72);
    expect(info.pages[0].height).toBeCloseTo(36);
  });
});

describe("頁面操作", () => {
  it("旋轉、刪除、插入、搬移、複製並可復原", () => {
    const { id } = engine.open(makePdf(4));
    engine.rotatePages(id, [0], 90);
    expect(engine.info(id).pages[0].rotation).toBe(90);
    expect(engine.info(id).pages[0].width).toBe(842);

    engine.movePages(id, [0], 3);
    expect(texts(engine, id)).toEqual(["Page 2", "Page 3", "Page 1", "Page 4"]);

    engine.deletePages(id, [1]);
    expect(texts(engine, id)).toEqual(["Page 2", "Page 1", "Page 4"]);

    engine.duplicatePages(id, [0]);
    expect(texts(engine, id)).toEqual(["Page 2", "Page 2", "Page 1", "Page 4"]);

    engine.insertBlankPage(id, 1);
    expect(engine.info(id).pageCount).toBe(5);
    expect(texts(engine, id)[1]).toBe("");

    engine.undo(id);
    engine.undo(id);
    engine.undo(id);
    expect(texts(engine, id)).toEqual(["Page 2", "Page 3", "Page 1", "Page 4"]);
    engine.redo(id);
    expect(texts(engine, id)).toEqual(["Page 2", "Page 1", "Page 4"]);
  });

  it("不能刪除所有頁面", () => {
    const { id } = engine.open(makePdf(2));
    expect(() => engine.deletePages(id, [0, 1])).toThrow("至少");
  });

  it("插入其他文件、合併、擷取與分割", () => {
    const { id } = engine.open(makePdf(2));
    engine.insertDocument(id, 1, makePdf(3));
    expect(texts(engine, id)).toEqual(["Page 1", "Page 1", "Page 2", "Page 3", "Page 2"]);

    const merged = engine.merge([makePdf(1), makePdf(2)]);
    expect(texts(engine, merged)).toEqual(["Page 1", "Page 1", "Page 2"]);

    const extracted = engine.open(engine.extractPages(id, [2, 3])).id;
    expect(texts(engine, extracted)).toEqual(["Page 2", "Page 3"]);

    const parts = engine.splitEvery(id, 2).map((data) => engine.info(engine.open(data).id).pageCount);
    expect(parts).toEqual([2, 2, 1]);
  });
});

describe("註解", () => {
  it("新增、移動、編輯、刪除註解並可復原", () => {
    const { id } = engine.open(makePdf(1));
    const selection = engine.selectText(id, 0, [60, 80], [250, 105]);
    expect(selection.text.trim()).toBe("Page 1");
    engine.addMarkup(id, 0, "Highlight", selection.quads, [1, 1, 0], selection.text);
    const note = engine.addNote(id, 0, [300, 300], "備註內容", [1, 0.8, 0]);
    const text = engine.addFreeText(id, 0, [100, 400], "中文文字方塊", 14, [0, 0, 0]);
    engine.addInk(id, 0, [[[10, 10], [50, 60], [90, 20]]], [1, 0, 0], 2);
    engine.addShape(id, 0, "arrow", [100, 100], [200, 150], [0, 0, 1], 2, false);
    engine.addShape(id, 0, "whiteout", [300, 500], [400, 540], [0, 0, 0], 1, false);
    engine.addImage(id, 0, [50, 600, 150, 650], makePng(40, 20), true);

    let annots = engine.annotations(id, 0);
    expect(annots.map((a) => a.type)).toEqual(["Highlight", "Text", "FreeText", "Ink", "Line", "Square", "Stamp"]);
    expect(annots.find((a) => a.type === "Square")?.role).toBe("whiteout");
    expect(annots.find((a) => a.type === "Stamp")?.role).toBe("signature");
    expect(annots.find((a) => a.type === "Line")?.lineEnd).toBe("OpenArrow");

    engine.setContents(id, 0, note, "新的備註");
    engine.moveAnnotation(id, 0, text, 20, 30);
    annots = engine.annotations(id, 0);
    expect(annots.find((a) => a.id === note)?.contents).toBe("新的備註");
    expect(annots.find((a) => a.id === text)?.rect[0]).toBeCloseTo(120, 0);

    engine.deleteAnnotation(id, 0, note);
    expect(engine.annotations(id, 0)).toHaveLength(6);
    engine.undo(id);
    expect(engine.annotations(id, 0)).toHaveLength(7);

    // 存檔後重新開啟，註解仍在
    const reopened = engine.open(engine.save(id)).id;
    expect(engine.annotations(reopened, 0)).toHaveLength(7);
  });

  it("套用遮蓋會移除底下的文字與重疊的註解", () => {
    const { id } = engine.open(makePdf(1));
    const selection = engine.selectText(id, 0, [60, 80], [250, 105]);
    engine.addMarkup(id, 0, "Highlight", selection.quads, [1, 1, 0]);
    engine.addNote(id, 0, [400, 400], "保留", [1, 1, 0]);
    engine.addShape(id, 0, "redact", [60, 70], [250, 110], [0, 0, 0], 1, false);
    expect(engine.redactionCount(id)).toBe(1);
    expect(engine.applyRedactions(id)).toBe(1);
    expect(engine.pageText(id, 0).trim()).toBe("");
    expect(engine.redactionCount(id)).toBe(0);
    expect(engine.annotations(id, 0).map((a) => a.type)).toEqual(["Text"]);
  });

  it("平面化後註解消失但外觀保留", () => {
    const { id } = engine.open(makePdf(1));
    engine.addShape(id, 0, "square", [10, 10], [100, 100], [1, 0, 0], 3, false);
    engine.flatten(id);
    expect(engine.annotations(id, 0)).toHaveLength(0);
    const { pixels, width } = engine.render(id, 0, 1);
    const offset = (50 * width + 10) * 4;
    expect(pixels[offset]).toBeGreaterThan(200);
    expect(pixels[offset + 1]).toBeLessThan(80);
  });
});

describe("浮水印、頁碼與 OCR 文字層", () => {
  it("加入可搜尋的中文浮水印與頁碼，並可移除", () => {
    const { id } = engine.open(makePdf(2));
    engine.addWatermark(id, [0, 1], { text: "機密文件", fontSize: 60, color: [1, 0, 0], opacity: 0.3, angle: 45 });
    engine.addPageNumbers(id, [0, 1], { template: "第 {n} 頁，共 {total} 頁", startAt: 1, position: "bottomCenter", fontSize: 10, color: [0, 0, 0], margin: 30 });
    expect(engine.pageText(id, 0)).toContain("機密文件");
    expect(engine.pageText(id, 1)).toContain("第 2 頁，共 2 頁");
    expect(engine.search(id, "機密").map((h) => h.page)).toEqual([0, 1]);

    // 頁碼位於頁面下方
    const hit = engine.search(id, "共 2 頁")[0];
    expect(hit.quads[0][1]).toBeGreaterThan(780);

    const reopened = engine.open(engine.save(id)).id;
    expect(engine.removeStamps(reopened)).toBe(4);
    expect(engine.pageText(reopened, 0).trim()).toBe("Page 1");
  });

  it("旋轉頁面上的頁碼仍在畫面下方", () => {
    const { id } = engine.open(makePdf(1));
    engine.rotatePages(id, [0], 90);
    engine.addPageNumbers(id, [0], { template: "{n}", startAt: 1, position: "bottomRight", fontSize: 12, color: [0, 0, 0], margin: 20 });
    const [hit] = engine.search(id, "1").filter((h) => h.context.trim() === "1");
    expect(hit).toBeDefined();
    const info = engine.info(id).pages[0];
    expect(hit.quads[0][0]).toBeGreaterThan(info.width - 60);
    expect(hit.quads[0][1]).toBeGreaterThan(info.height - 60);
  });

  it("英數字與中文混排時，搜尋位置與辨識框一致", () => {
    const { id } = engine.open(makePdf(1));
    engine.applyOcr(id, 0, [{ text: "Hello World", bbox: [100, 300, 400, 330] }]);
    const [hit] = engine.search(id, "world");
    const expectedStart = 100 + (300 * engine.textWidth("Hello ")) / engine.textWidth("Hello World");
    expect(hit.quads[0][0]).toBeCloseTo(expectedStart, -1);
    expect(hit.quads[0][2]).toBeCloseTo(400, -1);

    engine.applyOcr(id, 0, [{ text: "發票 Invoice 2026", bbox: [100, 400, 500, 430] }]);
    const [mixed] = engine.search(id, "2026");
    expect(mixed.quads[0][2]).toBeCloseTo(500, -1);
  });

  it("OCR 隱形文字可搜尋", () => {
    const { id } = engine.open(makePdf(1));
    engine.applyOcr(id, 0, [{ text: "掃描文字 Scanned", bbox: [100, 300, 400, 330] }]);
    const [hit] = engine.search(id, "scanned");
    expect(hit.page).toBe(0);
    expect(hit.quads[0][0]).toBeGreaterThan(180);
    expect(engine.removeStamps(id)).toBe(0);
  });
});

describe("搜尋、書籤、表單與存檔", () => {
  it("不分大小寫搜尋並提供前後文", () => {
    const { id } = engine.open(makePdf(3));
    const hits = engine.search(id, "page 2");
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(1);
    expect(hits[0].context).toContain("Page 2");
  });

  it("新增、重新命名、刪除書籤", () => {
    const { id } = engine.open(makePdf(3));
    engine.addBookmark(id, "第一章", 0);
    engine.addBookmark(id, "第二章", 2);
    let outline = engine.info(id).outline;
    expect(outline.map((o) => [o.title, o.page])).toEqual([["第一章", 0], ["第二章", 2]]);
    engine.renameBookmark(id, [1], "附錄");
    engine.deleteBookmark(id, [0]);
    outline = engine.info(id).outline;
    expect(outline.map((o) => o.title)).toEqual(["附錄"]);
  });

  it("加密、解鎖與移除密碼", () => {
    const { id } = engine.open(makePdf(2));
    const encrypted = engine.save(id, { userPassword: "1234" });
    const opened = engine.open(encrypted);
    expect(opened.needsPassword).toBe(true);
    expect(engine.unlock(opened.id, "wrong")).toBe(false);
    expect(engine.unlock(opened.id, "1234")).toBe(true);
    expect(engine.info(opened.id).isEncrypted).toBe(true);
    expect(texts(engine, opened.id)).toEqual(["Page 1", "Page 2"]);

    const plain = engine.open(engine.save(opened.id));
    expect(plain.needsPassword).toBe(false);
    expect(engine.info(plain.id).isEncrypted).toBe(false);
  });

  it("匯出圖片與文字", () => {
    const { id } = engine.open(makePdf(2, [72, 72]));
    const png = engine.exportPageImage(id, 0, 144, "png");
    expect([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join("")).toBe("PNG");
    const jpeg = engine.exportPageImage(id, 0, 72, "jpeg");
    expect(jpeg[0]).toBe(0xff);
    expect(engine.exportText(id)).toContain("--- 第 2 頁 ---");
  });

  it("壓縮存檔仍可開啟", () => {
    const { id } = engine.open(makePdf(3));
    const reopened = engine.open(engine.save(id, { compress: true })).id;
    expect(engine.info(reopened).pageCount).toBe(3);
  });
});
