import * as mupdf from "mupdf";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanFontName, fontRequestFor, fontUrlFromCss, googleFontsCssUrl, isReliableText, parseFontName } from "../src/engine/fonts";
import { PdfEngine } from "../src/engine/pdfEngine";
import { builtinFontBytes, makeEmbeddedFontPdf, makeStyledPdf } from "./helpers";

describe("字型名稱辨識", () => {
  it("解析字族、粗細與斜體", () => {
    expect(parseFontName("ABCDEF+TimesNewRomanPS-BoldItalicMT")).toMatchObject({ family: "Times New Roman", weight: 700, italic: true });
    expect(parseFontName("Roboto-Light")).toMatchObject({ family: "Roboto", weight: 300, italic: false });
    expect(parseFontName("OpenSans-SemiBold")).toMatchObject({ family: "Open Sans", weight: 600 });
    expect(parseFontName("Arial,Bold")).toMatchObject({ family: "Arial", weight: 700 });
    expect(parseFontName("HelveticaNeueLight")).toMatchObject({ family: "Helvetica Neue", weight: 300 });
    expect(parseFontName("NotoSansCJKtc-Black")).toMatchObject({ weight: 900 });
  });

  it("解碼 PDF 名稱中的中文", () => {
    expect(cleanFontName("QWERTY+#E6#A8#99#E6#A5#B7#E9#AB#94")).toBe("標楷體");
  });

  it("商用字型改用相容的開源字型", () => {
    const times = fontRequestFor("TimesNewRomanPSMT");
    expect(times.family).toBe("Times New Roman");
    expect(times.system.map((c) => c.family)).toContain("Times New Roman");
    expect(times.downloads).toEqual([{ family: "Tinos", exact: false }]);

    expect(fontRequestFor("ArialMT").downloads[0].family).toBe("Arimo");
    expect(fontRequestFor("PMingLiU").downloads[0].family).toBe("Noto Serif TC");
    expect(fontRequestFor("#E6#A8#99#E6#A5#B7#E9#AB#94").downloads[0].family).toBe("LXGW WenKai TC");
    expect(fontRequestFor("MicrosoftJhengHei-Bold")).toMatchObject({ weight: 700, downloads: [{ family: "Noto Sans TC", exact: false }] });
  });

  it("開源字型直接下載同一字型", () => {
    expect(fontRequestFor("NotoSansCJKtc-Medium")).toMatchObject({ family: "Noto Sans TC", weight: 500, downloads: [{ family: "Noto Sans TC", exact: true }] });
    expect(fontRequestFor("SourceHanSerifTC-Bold").downloads[0]).toEqual({ family: "Noto Serif TC", exact: true });
    expect(fontRequestFor("Roboto-Italic")).toMatchObject({ family: "Roboto", italic: true, downloads: [{ family: "Roboto", exact: true }] });
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
    const result = engine.replaceTextLine(withFont, 0, 0, "全新內容", {}, { data: builtinFontBytes("zh-Hant") });
    expect(result.font).toBe("supplied");
    expect(engine.textLines(withFont, 0)[0].text).toBe("全新內容");

    const withoutFont = engine.open(pdf).id;
    expect(engine.replaceTextLine(withoutFont, 0, 0, "全新內容").font).toBe("standard");
    expect(engine.textLines(withoutFont, 0)[0].text).toBe("全新內容");
  });

  it("提供的字型缺字時，缺的字元以標準字型補上", () => {
    const { id } = engine.open(makeStyledPdf());
    const latinOnly = builtinFontBytes("Times-Roman");
    expect(engine.replaceTextLine(id, 0, 0, "Title 標題", {}, { data: latinOnly }).font).toBe("mixed");
    expect(engine.textLines(id, 0)[0].text).toBe("Title 標題");
  });

  it("提供字型建議清單", () => {
    const { id } = engine.open(makeStyledPdf());
    expect(engine.fontRequest(id, 0, 0)).toMatchObject({ family: "Times New Roman", weight: 700, downloads: [{ family: "Tinos", exact: false }] });
  });
});
