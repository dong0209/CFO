import * as mupdf from "mupdf";

/** 產生每頁含有「Page N」文字的測試 PDF。 */
export function makePdf(pages: number, size: [number, number] = [595, 842]): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([0, 0, size[0], size[1]], 0, { Font: { F1: font } }, `BT /F1 24 Tf 72 ${size[1] - 100} Td (Page ${i}) Tj ET`);
    doc.insertPage(-1, page);
  }
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

export function makePng(width: number, height: number): Uint8Array {
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, width, height], false);
  pixmap.clear(80);
  return pixmap.asPNG().slice();
}

/** 淺藍色底塊上有深藍色粗體標題，下方另一行一般文字。 */
export function makeStyledPdf(): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const bold = doc.addSimpleFont(new mupdf.Font("Times-Bold"));
  const plain = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  const content = [
    "0.8 0.9 1 rg 50 650 400 120 re f",
    "0 0 0.6 rg BT /F1 24 Tf 72 730 Td (Old Title Here) Tj ET",
    "0 g BT /F2 12 Tf 72 700 Td [(Second) -250 (line stays)] TJ ET",
  ].join("\n");
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: bold, F2: plain } }, content));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** 取得 MuPDF 內建字型的字型檔（用來模擬「電腦上的字型」或「下載的字型」）。 */
export function builtinFontBytes(name: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const ref = doc.addFont(new mupdf.Font(name));
  const descriptor = ref.resolve().get("DescendantFonts").get(0).resolve().get("FontDescriptor");
  for (const key of ["FontFile2", "FontFile3", "FontFile"]) {
    const file = descriptor.get(key);
    if (file.isStream()) return file.readStream().asUint8Array().slice();
  }
  throw new Error("找不到字型檔");
}

/** 以內嵌（子集化）中文字型寫出一行文字的 PDF，模擬一般由 Word 等軟體輸出的文件。 */
export function makeEmbeddedFontPdf(text: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("EmbeddedSong", builtinFontBytes("zh-Hant"));
  const ref = doc.addFont(font);
  const hex = [...text].map((ch) => font.encodeCharacter(ch).toString(16).padStart(4, "0")).join("");
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: ref } }, `BT /F1 20 Tf 72 700 Td <${hex}> Tj ET`));
  doc.subsetFonts();
  return doc.saveToBuffer("garbage=compact,compress").asUint8Array().slice();
}

/**
 * 模擬掃描檔：米色紙張上的深藍色文字「Scanned Invoice」整頁轉成影像（沒有文字層）。
 * 文字基線在頁面座標 y=142（PDF 座標 y=700），字級 36。
 */
export function makeScannedPdf(wrapInForm = false): Uint8Array {
  const source = new mupdf.PDFDocument();
  const font = source.addSimpleFont(new mupdf.Font("Helvetica"));
  source.insertPage(0, source.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, "0.95 0.93 0.85 rg 0 0 595 842 re f 0.1 0.1 0.45 rg BT /F1 36 Tf 72 700 Td (Scanned Invoice) Tj ET 0 g BT /F1 14 Tf 72 600 Td (Keep this line) Tj ET"));
  const pixmap = source.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(pixmap));
  if (wrapInForm) {
    // macOS 版 OCR 以 CoreGraphics 重畫頁面：原頁面內容成為表單 XObject
    const form = doc.addStream("q 595 0 0 842 0 0 cm /Im0 Do Q", { Type: doc.newName("XObject"), Subtype: doc.newName("Form"), BBox: [0, 0, 595, 842], Resources: { XObject: { Im0: image } } });
    doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { XObject: { Fm0: form } }, "/Fm0 Do"));
  } else {
    doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im0: image } }, "q 595 0 0 842 0 0 cm /Im0 Do Q"));
  }
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** 內嵌字型的 BaseFont 與字型檔內部名稱不同（常見於各種 PDF 產生器）。 */
export function makeRenamedFontPdf(baseFont: string, text: string): Uint8Array {
  const doc = new mupdf.PDFDocument();
  const font = new mupdf.Font("zh-Hant");
  const ref = doc.addFont(font);
  ref.resolve().put("BaseFont", doc.newName(baseFont));
  ref.resolve().get("DescendantFonts").get(0).resolve().put("BaseFont", doc.newName(baseFont));
  const hex = [...text].map((ch) => font.encodeCharacter(ch).toString(16).padStart(4, "0")).join("");
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: ref } }, `BT /F1 20 Tf 72 700 Td <${hex}> Tj ET`));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** 頁面某區域（頁面座標）渲染後的平均顏色（0–255 RGB）。 */
export function regionColor(data: Uint8Array, rect: [number, number, number, number], annotations = false): number[] {
  const doc = mupdf.Document.openDocument(data, "application/pdf");
  const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, annotations);
  const pixels = pixmap.getPixels();
  const stride = pixmap.getStride();
  const sum = [0, 0, 0];
  let count = 0;
  for (let y = Math.round(rect[1]); y < Math.round(rect[3]); y++) {
    for (let x = Math.round(rect[0]); x < Math.round(rect[2]); x++) {
      for (let c = 0; c < 3; c++) sum[c] += pixels[y * stride + x * 3 + c];
      count++;
    }
  }
  return sum.map((v) => Math.round(v / count));
}

/**
 * 模擬掃描的表格：兩個儲存格「Left cell」「Right cell」之間有一條直的格線（x=250），
 * 上下各有一條橫的格線（y=100、y=160，頁面座標）。整頁為影像，沒有文字層。
 */
export function makeScannedTablePdf(): Uint8Array {
  const source = new mupdf.PDFDocument();
  const font = source.addSimpleFont(new mupdf.Font("Helvetica"));
  const content = [
    "1 1 1 rg 0 0 595 842 re f",
    "0 0 0 RG 1.5 w 60 742 m 450 742 l S 60 682 m 450 682 l S 250 682 m 250 742 l S",
    "0 g BT /F1 24 Tf 80 700 Td (Left cell) Tj ET BT /F1 24 Tf 270 700 Td (Right cell) Tj ET",
  ].join("\n");
  source.insertPage(0, source.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, content));
  const pixmap = source.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(pixmap));
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im0: image } }, "q 595 0 0 842 0 0 cm /Im0 Do Q"));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}

/** 模擬掃描的段落：淺藍底色上三行文字，右側有一個橘色方塊（在同一個框選範圍內）。 */
export function makeScannedBlockPdf(): Uint8Array {
  const source = new mupdf.PDFDocument();
  const font = source.addSimpleFont(new mupdf.Font("Helvetica"));
  const text = [0, 1, 2].map((i) => `BT /F1 14 Tf 80 ${700 - i * 22} Td (Line ${i} text) Tj ET`).join(" ");
  const content = `0.8 0.9 1 rg 0 0 595 842 re f 1 0.6 0.1 rg 300 697 40 20 re f 0 g ${text}`;
  source.insertPage(0, source.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, content));
  const pixmap = source.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(pixmap));
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im0: image } }, "q 595 0 0 842 0 0 cm /Im0 Do Q"));
  return doc.saveToBuffer("compress").asUint8Array().slice();
}
