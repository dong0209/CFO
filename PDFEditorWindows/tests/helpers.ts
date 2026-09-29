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
