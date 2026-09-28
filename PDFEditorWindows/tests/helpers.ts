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
