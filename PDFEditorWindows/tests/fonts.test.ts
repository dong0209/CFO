import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it } from "vitest";
import { chosenFontRequest, cleanFontName, fontRequestFor, fontUrlFromCss, googleFontsCssUrl, isReliableText, ocrFontRequest, parseFontName } from "../src/engine/fonts";
import { PdfEngine } from "../src/engine/pdfEngine";
import { builtinFontBytes, makeEmbeddedFontPdf, makePdf, makeRenamedFontPdf, makeScannedBlockPdf, makeScannedPdf, makeScannedTablePdf, makeStyledPdf, regionColor } from "./helpers";

describe("字型名稱辨識", () => {
  it("解析字族、粗細與斜體", () => {
    expect(parseFontName("ABCDEF+TimesNewRomanPS-BoldItalicMT")).toMatchObject({ family: "Times New Roman", weight: 700, italic: true });
    expect(parseFontName("Roboto-Light")).toMatchObject({ family: "Roboto", weight: 300, italic: false });
    expect(parseFontName("OpenSans-SemiBold")).toMatchObject({ family: "Open Sans", weight: 600 });
    expect(parseFontName("Arial,Bold")).toMatchObject({ family: "Arial", weight: 700 });
    expect(parseFontName("HelveticaNeueLight")).toMatchObject({ family: "Helvetica Neue", weight: 300 });
    expect(parseFontName("NotoSansCJKtc-Black")).toMatchObject({ weight: 900 });
  });

  it("解碼 PDF 名稱中的中文（UTF-8、Big5、GBK）", () => {
    expect(cleanFontName("QWERTY+#E6#A8#99#E6#A5#B7#E9#AB#94")).toBe("標楷體");
    const big5 = String.fromCharCode(0xb7, 0x73, 0xb2, 0xd3, 0xa9, 0xfa, 0xc5, 0xe9);
    expect(cleanFontName(big5)).toBe("新細明體");
    expect(cleanFontName("#B7#73#B2#D3#A9#FA#C5#E9")).toBe("新細明體");
    expect(fontRequestFor(big5).downloads[0].family).toBe("Noto Serif TC");
    expect(cleanFontName(String.fromCharCode(0xcb, 0xce, 0xcc, 0xe5))).toBe("宋体");
  });

  it("不認得的字型依名稱關鍵字與文字語系找相近字型", () => {
    const ming = fontRequestFor("DFMingStd-W5", false, false, { text: "中文標題" });
    expect(ming.weight).toBe(500);
    expect(ming.downloads.map((c) => c.family)).toContain("Noto Serif TC");
    expect(ming.system.map((c) => c.family)).toContain("PMingLiU");
    expect(fontRequestFor("DFKaiShu-SB-Estd-BF").downloads.map((c) => c.family)).toContain("LXGW WenKai TC");
    expect(fontRequestFor("HYQiHei-65S", false, false, { text: "內文" }).downloads.map((c) => c.family)).toContain("Noto Sans TC");
    expect(fontRequestFor("SomeUnknownFont", false, false, { serif: true, text: "Hello" }).downloads.map((c) => c.family)).toContain("Tinos");
  });

  it("英文字型遇到中文時有中文備援字型", () => {
    expect(fontRequestFor("ArialMT").fallback?.downloads[0].family).toBe("Noto Sans TC");
    expect(fontRequestFor("TimesNewRomanPSMT").fallback?.downloads[0].family).toBe("Noto Serif TC");
    expect(fontRequestFor("PMingLiU").fallback).toBeNull();
  });

  it("OCR 文字與手動選擇的字型", () => {
    expect(ocrFontRequest("掃描文字").downloads[0].family).toBe("Noto Sans TC");
    expect(ocrFontRequest("Scanned text").downloads[0].family).toBe("Arimo");
    expect(chosenFontRequest("Roboto", 700, false, true)).toMatchObject({ system: [], downloads: [{ family: "Roboto", exact: true }], weight: 700 });
    expect(chosenFontRequest("Microsoft JhengHei", 400, false, false).system[0].family).toBe("Microsoft JhengHei");
  });

  it("商用字型改用相容的開源字型", () => {
    const times = fontRequestFor("TimesNewRomanPSMT");
    expect(times.family).toBe("Times New Roman");
    expect(times.system.map((c) => c.family)).toContain("Times New Roman");
    expect(times.downloads[0]).toEqual({ family: "Tinos", exact: false });

    expect(fontRequestFor("ArialMT").downloads[0].family).toBe("Arimo");
    expect(fontRequestFor("PMingLiU").downloads[0].family).toBe("Noto Serif TC");
    expect(fontRequestFor("#E6#A8#99#E6#A5#B7#E9#AB#94").downloads[0].family).toBe("LXGW WenKai TC");
    expect(fontRequestFor("MicrosoftJhengHei-Bold")).toMatchObject({ weight: 700 });
    expect(fontRequestFor("MicrosoftJhengHei-Bold").downloads[0]).toEqual({ family: "Noto Sans TC", exact: false });
  });

  it("開源字型直接下載同一字型", () => {
    expect(fontRequestFor("NotoSansCJKtc-Medium")).toMatchObject({ family: "Noto Sans TC", weight: 500 });
    expect(fontRequestFor("NotoSansCJKtc-Medium").downloads[0]).toEqual({ family: "Noto Sans TC", exact: true });
    expect(fontRequestFor("SourceHanSerifTC-Bold").downloads[0]).toEqual({ family: "Noto Serif TC", exact: true });
    expect(fontRequestFor("Roboto-Italic")).toMatchObject({ family: "Roboto", italic: true });
    expect(fontRequestFor("Roboto-Italic").downloads[0]).toEqual({ family: "Roboto", exact: true });
  });

  it("Google Fonts 網址與 CSS 解析", () => {
    expect(googleFontsCssUrl("Noto Sans TC", 700, false)).toBe("https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@700");
    expect(googleFontsCssUrl("Roboto", 400, true)).toBe("https://fonts.googleapis.com/css2?family=Roboto:ital,wght@1,400");
    expect(fontUrlFromCss("src: url(https://fonts.gstatic.com/s/x/v1/a.ttf) format('truetype');")).toBe("https://fonts.gstatic.com/s/x/v1/a.ttf");
    expect(fontUrlFromCss("<html>")).toBeNull();
  });

  it("偵測無法正確辨識的原文", () => {
    expect(isReliableText("正常文字 Text 123")).toBe(true);
    expect(isReliableText("亂�碼")).toBe(false);
    expect(isReliableText("")).toBe(false);
  });
});

describe("編輯文字時的字型", () => {
  let engine: PdfEngine;
  beforeEach(() => {
    engine = new PdfEngine();
  });

  /** 頁面上本程式寫入的字型都必須內嵌字型檔（避免在其他閱讀器顯示成亂碼）。 */
  function editFontsAreEmbedded(data: Uint8Array): boolean {
    const doc = mupdf.Document.openDocument(data, "application/pdf").asPDF()!;
    const fonts = (doc.loadPage(0) as mupdf.PDFPage).getObject().getInheritable("Resources").resolve().get("Font");
    let ok = true;
    let count = 0;
    fonts.forEach((value: mupdf.PDFObject, key: string | number) => {
      if (!String(key).startsWith("PEE")) return;
      count++;
      const descriptor = value.resolve().get("DescendantFonts").get(0).resolve().get("FontDescriptor");
      if (!["FontFile2", "FontFile3", "FontFile"].some((k) => descriptor.get(k).isStream())) ok = false;
    });
    return ok && count > 0;
  }

  /** 文字方塊外觀中的字型都已內嵌。 */
  function editFontsAreEmbeddedIn(data: Uint8Array): boolean {
    const doc = mupdf.Document.openDocument(data, "application/pdf").asPDF()!;
    const annot = (doc.loadPage(0) as mupdf.PDFPage).getAnnotations()[0];
    const fonts = annot.getObject().get("AP").get("N").get("Resources").get("Font");
    let count = 0;
    let ok = true;
    fonts.forEach((value: mupdf.PDFObject) => {
      count++;
      const descriptor = value.get("DescendantFonts").get(0).get("FontDescriptor");
      if (!["FontFile2", "FontFile3", "FontFile"].some((k) => descriptor.get(k).isStream())) ok = false;
    });
    return ok && count > 0;
  }

  it("中文與英文寫入後都能正確讀回，且字型已內嵌", () => {
    const { id } = engine.open(makeStyledPdf());
    engine.replaceTextLine(id, 0, 0, "繁體中文 Mixed 標題 123！");
    const saved = engine.save(id);
    const reopened = engine.open(saved).id;
    expect(engine.textLines(reopened, 0)[0].text).toBe("繁體中文 Mixed 標題 123！");
    expect(editFontsAreEmbedded(saved)).toBe(true);
    // 只嵌入用到的字形，檔案不應暴增
    expect(saved.length).toBeLessThan(200_000);
  });

  it("原檔內嵌字型包含所需字形時直接沿用", () => {
    const { id } = engine.open(makeEmbeddedFontPdf("原始文字測試"));
    const [line] = engine.textLines(id, 0);
    expect(line).toMatchObject({ text: "原始文字測試", fontName: "EmbeddedSong", embeddedFont: true, textReliable: true });
    expect(engine.replaceTextLine(id, 0, 0, "測試文字").font).toBe("embedded");
    expect(engine.textLines(id, 0)[0].text).toBe("測試文字");
  });

  it("原檔字型缺字時改用提供的字型；沒有提供時用標準字型", () => {
    const pdf = makeEmbeddedFontPdf("原始文字");
    const withFont = engine.open(pdf).id;
    const result = engine.replaceTextLine(withFont, 0, 0, "全新內容", { font: { data: builtinFontBytes("zh-Hant") } });
    expect(result.font).toBe("supplied");
    expect(engine.textLines(withFont, 0)[0].text).toBe("全新內容");

    const withoutFont = engine.open(pdf).id;
    expect(engine.replaceTextLine(withoutFont, 0, 0, "全新內容").font).toBe("standard");
    expect(engine.textLines(withoutFont, 0)[0].text).toBe("全新內容");
  });

  it("提供的字型缺字時，缺的字元以標準字型補上", () => {
    const { id } = engine.open(makeStyledPdf());
    const latinOnly = builtinFontBytes("Times-Roman");
    expect(engine.replaceTextLine(id, 0, 0, "Title 標題", { font: { data: latinOnly } }).font).toBe("mixed");
    expect(engine.textLines(id, 0)[0].text).toBe("Title 標題");
  });

  it("內嵌字型以 BaseFont 顯示名稱，並沿用原字型", () => {
    const { id } = engine.open(makeRenamedFontPdf("ABCDEF+HanWangMingMedium", "公司簡介"));
    const [line] = engine.textLines(id, 0);
    expect(line).toMatchObject({ text: "公司簡介", fontName: "HanWangMingMedium", embeddedFont: true, ocr: false });
    expect(engine.fontRequest(id, 0, 0).downloads.map((c) => c.family)).toContain("Noto Serif TC");
    expect(engine.replaceTextLine(id, 0, 0, "簡介公司").font).toBe("embedded");
  });

  it("手動選擇字型時不沿用原檔字型", () => {
    const { id } = engine.open(makeEmbeddedFontPdf("原始文字測試"));
    const result = engine.replaceTextLine(id, 0, 0, "測試文字", { font: { data: builtinFontBytes("zh-Hant") }, forceFont: true, override: { size: 30, color: [1, 0, 0] } });
    expect(result.font).toBe("supplied");
    expect(engine.textLines(id, 0)[0]).toMatchObject({ text: "測試文字", size: 30, color: [1, 0, 0] });
  });

  it("OCR 文字：辨識為掃描文字，編輯後影像中的原字真正消失", () => {
    const { id } = engine.open(makeScannedPdf());
    engine.applyOcr(id, 0, [
      { text: "Scanned Invoice", bbox: [70, 112, 345, 152] },
      { text: "Keep this line", bbox: [70, 230, 170, 246] },
    ]);
    const [line] = engine.textLines(id, 0);
    expect(line).toMatchObject({ text: "Scanned Invoice", ocr: true, fontName: "", embeddedFont: false });
    // 顏色取樣自影像中的深藍色文字
    expect(line.color[2]).toBeGreaterThan(line.color[0] + 0.15);
    expect(engine.fontRequest(id, 0, 0).originalName).toContain("OCR");

    const before = regionColor(engine.save(id), [72, 118, 340, 150]);
    engine.replaceTextLine(id, 0, 0, "");
    const saved = engine.save(id);
    const after = regionColor(saved, [72, 118, 340, 150]);
    // 原本的深色字消失，變回米色紙張
    expect(after[0]).toBeGreaterThan(before[0] + 20);
    expect(Math.abs(after[0] - 242)).toBeLessThan(8);
    const reopened = engine.open(saved).id;
    expect(engine.textLines(reopened, 0).map((l) => l.text)).toEqual(["Keep this line"]);
    // 另一行影像不受影響
    expect(regionColor(saved, [72, 232, 160, 244])[0]).toBeLessThan(200);

    engine.undo(id);
    engine.replaceTextLine(id, 0, 0, "Paid Invoice");
    const lines = engine.textLines(id, 0);
    expect(lines[0]).toMatchObject({ text: "Paid Invoice", ocr: false });
  });

  it("文字方塊使用自選字型，移動與重新開啟後外觀不變", () => {
    const { id } = engine.open(makePdf(1));
    const style = { fontSize: 20, color: [1, 0, 0] as [number, number, number], family: "Noto Sans TC", bold: true, italic: false };
    const annotId = engine.addFreeText(id, 0, [100, 300], "自選字型 Font", style, { data: builtinFontBytes("zh-Hant") });
    let info = engine.annotations(id, 0).find((a) => a.id === annotId)!;
    expect(info.textStyle).toMatchObject({ family: "Noto Sans TC", bold: true, fontSize: 20, color: [1, 0, 0] });
    const [x0, y0, x1, y1] = info.rect;
    const red = (data: Uint8Array, r: [number, number, number, number]) => {
      const c = regionColor(data, r, true);
      return c[0] - c[1];
    };
    expect(red(engine.save(id), [x0, y0, x1, y1])).toBeGreaterThan(20);

    engine.moveAnnotation(id, 0, annotId, 0, 200);
    const saved = engine.save(id);
    expect(red(saved, [x0, y0, x1, y1])).toBeLessThan(5);
    expect(red(saved, [x0, y0 + 200, x1, y1 + 200])).toBeGreaterThan(20);
    const reopened = engine.open(saved).id;
    info = engine.annotations(reopened, 0)[0];
    expect(info.rect[1]).toBeCloseTo(y0 + 200, 0);
    expect(info.contents).toBe("自選字型 Font");
    expect(editFontsAreEmbeddedIn(saved)).toBe(true);

    engine.updateFreeText(id, 0, annotId, "第一行\n第二行較長的文字", { ...style, fontSize: 12 }, null);
    info = engine.annotations(id, 0).find((a) => a.id === annotId)!;
    expect(info.contents).toBe("第一行\n第二行較長的文字");
    expect(info.rect[3] - info.rect[1]).toBeGreaterThan(28);
  });

  it("OCR 文字：掃描影像在表單 XObject 中（macOS 版 OCR）也能真正移除", () => {
    const { id } = engine.open(makeScannedPdf(true));
    engine.applyOcr(id, 0, [{ text: "Scanned Invoice", bbox: [70, 112, 345, 152] }]);
    expect(engine.textLines(id, 0)[0].ocr).toBe(true);
    engine.replaceTextLine(id, 0, 0, "");
    const saved = engine.save(id);
    expect(Math.abs(regionColor(saved, [72, 118, 340, 150])[0] - 242)).toBeLessThan(8);
    expect(regionColor(saved, [72, 232, 160, 244])[0]).toBeLessThan(200);
  });

  it("OCR 文字跨過表格格線：抹掉文字時保留格線", () => {
    const { id } = engine.open(makeScannedTablePdf());
    // OCR 把兩個儲存格辨識成同一行
    engine.applyOcr(id, 0, [{ text: "Left cell Right cell", bbox: [78, 118, 400, 148] }]);
    engine.replaceTextLine(id, 0, 0, "");
    const saved = engine.save(id);
    // 文字消失
    expect(regionColor(saved, [85, 122, 240, 145])[0]).toBeGreaterThan(245);
    expect(regionColor(saved, [262, 122, 395, 145])[0]).toBeGreaterThan(245);
    // 直的格線（x=250）與上下橫線仍在
    expect(regionColor(saved, [249, 115, 251, 150])[0]).toBeLessThan(120);
    expect(regionColor(saved, [100, 99, 230, 101])[0]).toBeLessThan(150);
    expect(regionColor(saved, [100, 159, 230, 161])[0]).toBeLessThan(150);
  });

  it("框選範圍重新辨識：改成一行可編輯的 OCR 文字", () => {
    const { id } = engine.open(makeScannedTablePdf());
    engine.applyOcr(id, 0, [{ text: "Left cell Right cell", bbox: [78, 118, 400, 148] }]);
    const png = engine.regionImage(id, 0, [70, 110, 245, 155], 144);
    const image = new mupdf.Image(png);
    expect([image.getWidth(), image.getHeight()]).toEqual([350, 90]);

    const index = engine.setOcrRegion(id, 0, [70, 110, 245, 155], [{ text: "Left cell", bbox: [78, 118, 168, 148] }]);
    const lines = engine.textLines(id, 0);
    expect(lines[index]).toMatchObject({ text: "Left cell", ocr: true });
    engine.replaceTextLine(id, 0, index, "Changed");
    const saved = engine.save(id);
    // 右邊儲存格的影像不受影響，格線仍在
    expect(regionColor(saved, [270, 122, 395, 145])[0]).toBeLessThan(235);
    expect(regionColor(saved, [249, 115, 251, 150])[0]).toBeLessThan(120);
    const text = engine.textLines(engine.open(saved).id, 0).map((l) => l.text).join("|");
    expect(text).toContain("Changed");
    expect(text).not.toContain("Left cell");
    // 範圍內有一般文字時拒絕
    const normal = engine.open(makePdf(1)).id;
    expect(() => engine.setOcrRegion(normal, 0, [60, 70, 250, 110], [])).toThrow(/一般文字/);
  });

  it("框選多行：分成多行，編輯一行只抹掉該行的字，色塊與圖案保持原樣", () => {
    const { id } = engine.open(makeScannedBlockPdf());
    const lines = [0, 1, 2].map((i) => ({ text: `Line ${i} text`, bbox: [78, 125 + i * 22, 230, 145 + i * 22] as [number, number, number, number] }));
    const index = engine.setOcrRegion(id, 0, [70, 115, 420, 200], lines);
    const all = engine.textLines(id, 0).filter((l) => l.ocr);
    expect(all.map((l) => l.text)).toEqual(["Line 0 text", "Line 1 text", "Line 2 text"]);
    expect(all[0].index).toBe(index);
    expect(all[0].bbox[3] - all[0].bbox[1]).toBeLessThan(30);
    engine.replaceTextLine(id, 0, index, "");
    const saved = engine.save(id);
    // 第一行的字被抹掉，變回淺藍底色
    const erased = regionColor(saved, [80, 128, 225, 142]);
    expect(erased[2]).toBeGreaterThan(240);
    expect(erased[0]).toBeGreaterThan(190);
    // 第二行仍在
    expect(regionColor(saved, [80, 150, 225, 164])[0]).toBeLessThan(190);
    // 同一範圍內的橘色方塊保持原樣
    const box = regionColor(saved, [302, 127, 338, 143]);
    expect(box[0]).toBeGreaterThan(220);
    expect(box[2]).toBeLessThan(80);
  });

  it("範圍過大的 OCR 行拒絕修改，避免抹掉整塊內容", () => {
    const { id } = engine.open(makeScannedBlockPdf());
    engine.applyOcr(id, 0, [{ text: "Whole block", bbox: [70, 115, 420, 260] }]);
    expect(() => engine.replaceTextLine(id, 0, 0, "x")).toThrow(/範圍太大/);
  });

  it("提供字型建議清單", () => {
    const { id } = engine.open(makeStyledPdf());
    expect(engine.fontRequest(id, 0, 0)).toMatchObject({ family: "Times New Roman", weight: 700 });
    expect(engine.fontRequest(id, 0, 0).downloads[0]).toEqual({ family: "Tinos", exact: false });
  });
});
