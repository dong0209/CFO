// 端對端測試：實際啟動 Electron App，操作介面並驗證存出的 PDF。
// 用法：npm run build && xvfb-run -a node e2e/app.e2e.mjs（Windows / macOS 可直接執行）
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { _electron as electron } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "e2e", "screenshots");
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "pdfeditor-e2e-"));
const electronPath = (await import("electron")).default;

// MARK: - 測試檔案

function makeSample(path) {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 1; i <= 3; i++) {
    const text = [
      `BT /F1 28 Tf 72 740 Td (Page ${i}) Tj ET`,
      `BT /F1 14 Tf 72 700 Td (The quick brown fox jumps over the lazy dog.) Tj ET`,
      `BT /F1 14 Tf 72 680 Td (Confidential account number 1234-5678.) Tj ET`,
      i === 1 ? "BT /F1 12 Tf 72 604 Td (Name:) Tj ET" : "",
    ].join("\n");
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, text));
  }
  // 第一頁加入文字表單欄位
  const page = doc.loadPage(0).getObject();
  const field = doc.addObject({
    Type: doc.newName("Annot"),
    Subtype: doc.newName("Widget"),
    FT: doc.newName("Tx"),
    T: doc.newString("name"),
    Rect: [120, 596, 400, 620],
    F: 4,
    DA: doc.newString("/Helv 12 Tf 0 g"),
    P: page,
  });
  page.put("Annots", [field]);
  const fontDict = doc.addObject({ Type: doc.newName("Font"), Subtype: doc.newName("Type1"), BaseFont: doc.newName("Helvetica") });
  doc.getTrailer().get("Root").put("AcroForm", { Fields: [field], DA: doc.newString("/Helv 12 Tf 0 g"), DR: { Font: { Helv: fontDict } } });
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
}

/** 只有圖片、沒有文字層的「掃描」頁 */
function makeScanned(path) {
  const source = new mupdf.PDFDocument();
  const font = source.addSimpleFont(new mupdf.Font("Helvetica"));
  source.insertPage(0, source.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, "BT /F1 36 Tf 72 700 Td (Scanned Invoice 2026) Tj ET"));
  const pixmap = source.loadPage(0).toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false);
  const doc = new mupdf.PDFDocument();
  const image = doc.addImage(new mupdf.Image(pixmap));
  doc.insertPage(0, doc.addPage([0, 0, 595, 842], 0, { XObject: { Im0: image } }, "q 595 0 0 842 0 0 cm /Im0 Do Q"));
  writeFileSync(path, doc.saveToBuffer("").asUint8Array());
}

const sample = join(work, "範例文件.pdf");
const scanned = join(work, "掃描檔.pdf");
makeSample(sample);
makeScanned(scanned);

function openPdf(path, password) {
  const doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf").asPDF();
  if (password) assert.ok(doc.authenticatePassword(password), "密碼應可解鎖");
  return doc;
}

// MARK: - 啟動

const app = await electron.launch({
  executablePath: electronPath,
  args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), root, sample],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1", PDFEDITOR_USER_DATA: join(work, "userdata") },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.setViewportSize({ width: 1360, height: 900 }).catch(() => {});

const menu = (command) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), command);
const mockSave = (path) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, path);
const mockMessage = (response) => app.evaluate(({ dialog }, r) => { dialog.showMessageBox = async () => ({ response: r, checkboxChecked: false }); }, response);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const step = (name) => console.log(`▸ ${name}`);

/** 回傳第 n 頁在畫面上的位置與縮放（頁面座標→螢幕座標） */
async function pageBox(n = 0) {
  const overlay = page.locator(".page-slot").nth(n).locator(".page-overlay");
  const box = await overlay.boundingBox();
  assert.ok(box, `第 ${n + 1} 頁應可見`);
  return { ...box, scale: box.width / 595, at: (x, y) => [box.x + x * (box.width / 595), box.y + y * (box.width / 595)] };
}

async function drag(from, to) {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / 8, from[1] + ((to[1] - from[1]) * i) / 8);
  await page.mouse.up();
}

const annotationCount = async () => {
  await page.locator(".sidebar-tabs button", { hasText: "註解" }).click();
  await page.waitForTimeout(300);
  return page.locator(".annot-row").count();
};

try {
  step("開啟檔案並渲染");
  await page.waitForSelector(".page-canvas", { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll(".page-loading").length === 0, null, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector(".thumb-canvas")?.width > 0, null, { timeout: 20000 });
  assert.equal(await page.locator(".tab-name").first().textContent(), "範例文件.pdf");
  assert.match(await page.locator(".statusbar").textContent(), /共 3 頁/);
  await shot("01-開啟文件");

  step("螢光筆");
  await page.keyboard.press("y");
  let box = await pageBox(0);
  // 頁面座標（y 向下）：第二行文字約在 y≈142
  await drag(box.at(70, 142), box.at(420, 142));
  await page.waitForTimeout(500);
  assert.equal(await annotationCount(), 1, "應新增一個螢光筆註解");

  step("矩形與手繪");
  await page.keyboard.press("r");
  await drag(box.at(300, 250), box.at(500, 330));
  await page.keyboard.press("p");
  await drag(box.at(80, 300), box.at(250, 380));
  await page.waitForTimeout(400);
  assert.equal(await annotationCount(), 3);

  step("中文文字方塊");
  await page.keyboard.press("b");
  await page.mouse.click(...box.at(80, 420));
  await page.locator(".dialog textarea").fill("這是中文文字方塊");
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(500);
  assert.equal(await annotationCount(), 4);

  step("直接編輯原有文字");
  await page.keyboard.press("t");
  box = await pageBox(0);
  // 標題「Page 1」基線約在 y≈102
  await page.mouse.click(...box.at(110, 94));
  const inline = page.locator(".inline-text-editor");
  await inline.waitFor();
  assert.equal(await inline.inputValue(), "Page 1");
  await shot("02a-直接編輯文字");
  await inline.fill("第一章 Chapter 1");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);

  step("填寫表單欄位");
  await page.keyboard.press("v");
  const widget = page.locator(".widget-text").first();
  await widget.click();
  await widget.fill("王小明");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);

  step("浮水印與頁碼");
  await menu("watermark");
  await page.locator(".dialog input").first().fill("機密文件");
  await page.locator(".dialog button.primary").click();
  await page.waitForTimeout(600);
  await menu("page-numbers");
  await page.locator(".dialog button.primary").click();
  await page.waitForTimeout(800);
  await shot("02-註解浮水印頁碼");
  await page.locator(".viewer").evaluate((el) => (el.scrollTop += 700));
  await page.waitForTimeout(500);
  await shot("02b-頁尾頁碼");
  await menu("first-page");
  await page.waitForTimeout(300);

  step("簽名");
  await menu("signatures");
  const pad = await page.locator(".signature-pad").boundingBox();
  await drag([pad.x + 60, pad.y + 140], [pad.x + 200, pad.y + 60]);
  await drag([pad.x + 200, pad.y + 60], [pad.x + 330, pad.y + 150]);
  await shot("03-簽名板");
  await page.locator(".dialog button.primary").click();
  await page.waitForTimeout(300);
  box = await pageBox(0);
  await page.mouse.click(...box.at(450, 380));
  await page.waitForTimeout(600);
  assert.equal(await annotationCount(), 5, "應新增簽名");

  step("搜尋");
  await menu("find");
  await page.locator(".search-box input").fill("lazy dog");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".search-result");
  assert.equal(await page.locator(".search-result").count(), 3);
  await shot("04-搜尋");

  step("頁面：旋轉、刪除、復原");
  await page.locator(".sidebar-tabs button", { hasText: "縮圖" }).click();
  await page.locator(".thumb").nth(2).click();
  await menu("rotate-right");
  await page.waitForTimeout(400);
  await menu("delete-pages");
  await page.waitForTimeout(400);
  assert.match(await page.locator(".statusbar").textContent(), /共 2 頁/);
  await menu("undo");
  await page.waitForTimeout(400);
  assert.match(await page.locator(".statusbar").textContent(), /共 3 頁/);
  await shot("05-縮圖與旋轉");

  step("儲存並驗證內容");
  const saved = join(work, "已編輯.pdf");
  await mockSave(saved);
  await menu("save-as");
  await page.waitForFunction(() => [...document.querySelectorAll(".tab.active .tab-name")].some((t) => t.textContent === "已編輯.pdf"), null, { timeout: 10000 });
  {
    const doc = openPdf(saved);
    assert.equal(doc.countPages(), 3);
    const p1 = doc.loadPage(0);
    const types = p1.getAnnotations().map((a) => a.getType()).sort();
    assert.deepEqual(types, ["FreeText", "Highlight", "Ink", "Square", "Stamp"]);
    assert.equal(p1.getWidgets()[0].getValue(), "王小明");
    const text = p1.toStructuredText("").asText();
    assert.ok(text.includes("機密文件"), "浮水印文字應存在");
    assert.ok(text.includes("第一章 Chapter 1"), "標題應已直接改寫");
    assert.ok(!text.includes("Page 1"), "原標題文字應被移除");
    assert.ok(text.includes("第 1 頁，共 3 頁"), "頁碼應存在");
    assert.equal(doc.loadPage(2).getObject().get("Rotate").asNumber(), 90, "第三頁應已旋轉");
  }

  step("塗黑遮蓋並套用");
  await menu("first-page");
  await page.waitForTimeout(400);
  box = await pageBox(0);
  await page.keyboard.press("x");
  await drag(box.at(66, 154), box.at(360, 170));
  await mockMessage(0);
  await menu("apply-redactions");
  await page.locator(".dialog button.primary").click();
  await page.waitForTimeout(800);
  await shot("06-套用遮蓋");

  step("密碼保護");
  await menu("password");
  const inputs = page.locator(".dialog input[type=password]");
  await inputs.nth(0).fill("secret");
  await inputs.nth(1).fill("secret");
  await page.locator(".dialog button.primary").click();
  const encrypted = join(work, "加密.pdf");
  await mockSave(encrypted);
  await menu("save-as");
  await page.waitForFunction(() => [...document.querySelectorAll(".tab.active .tab-name")].some((t) => t.textContent === "加密.pdf"), null, { timeout: 10000 });
  {
    const doc = mupdf.Document.openDocument(readFileSync(encrypted), "application/pdf");
    assert.ok(doc.needsPassword(), "應需要密碼");
    assert.ok(doc.authenticatePassword("secret"));
    const text = doc.loadPage(0).toStructuredText("").asText();
    assert.ok(!text.includes("1234-5678"), "遮蓋區域的文字應被移除");
    assert.ok(text.includes("lazy dog"), "其他文字應保留");
  }

  step("OCR 掃描檔");
  await app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send("open-files", [p]), scanned);
  await page.waitForFunction(() => [...document.querySelectorAll(".tab-name")].some((t) => t.textContent === "掃描檔.pdf"));
  await page.waitForTimeout(800);
  await menu("ocr");
  await page.locator(".dialog select").first().selectOption("eng");
  await page.locator(".dialog button.primary").click();
  await page.waitForSelector('.toast:has-text("文字辨識完成")', { timeout: 180000 });
  await menu("find");
  await page.locator(".search-box input").fill("invoice");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".search-result", { timeout: 10000 });
  await shot("07-OCR搜尋");

  step("深色模式截圖");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(300);
  await shot("08-深色模式");
  await page.emulateMedia({ colorScheme: "light" });

  step("關閉未儲存的分頁（選擇不儲存）");
  await mockMessage(1);
  await menu("close-tab");
  await page.waitForTimeout(400);
  assert.equal(await page.locator(".tab").count(), 1);

  step("關閉全部分頁後回到歡迎畫面");
  await menu("close-tab");
  await page.waitForSelector(".welcome", { timeout: 5000 });
  assert.ok((await page.locator(".recent-item").count()) >= 2, "最近開啟應列出檔案");
  await shot("09-歡迎畫面");

  const relevantErrors = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e));
  assert.deepEqual(relevantErrors, [], `畫面不應有錯誤：\n${relevantErrors.join("\n")}`);
  console.log("✓ 端對端測試全部通過");
} catch (error) {
  await shot("99-失敗").catch(() => {});
  console.error("✗ 失敗：", error);
  console.error("畫面錯誤：", errors);
  process.exitCode = 1;
} finally {
  await mockMessage(1).catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
