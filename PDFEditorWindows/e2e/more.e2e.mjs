// 端對端測試（第二部分）：頁面管理、合併／擷取、加密檔開啟、書籤、匯出、復原與影像編輯的裁切與旋轉。
// 用法：npm run build && xvfb-run -a node e2e/more.e2e.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as mupdf from "mupdf";
import { _electron as electron } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const shots = join(root, "e2e", "screenshots");
mkdirSync(shots, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "pdfeditor-e2e2-"));
const electronPath = (await import("electron")).default;

function makeDoc(path, label, pages, options = "") {
  const doc = new mupdf.PDFDocument();
  const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
  for (let i = 1; i <= pages; i++) {
    doc.insertPage(-1, doc.addPage([0, 0, 595, 842], 0, { Font: { F1: font } }, `BT /F1 28 Tf 72 740 Td (${label} ${i}) Tj ET BT /F1 14 Tf 72 700 Td (Body text for ${label} page ${i}.) Tj ET`));
  }
  writeFileSync(path, doc.saveToBuffer(options).asUint8Array());
}

function pdfTexts(path, password) {
  const doc = mupdf.Document.openDocument(readFileSync(path), "application/pdf");
  if (password) assert.ok(doc.authenticatePassword(password));
  return Array.from({ length: doc.countPages() }, (_, i) => doc.loadPage(i).toStructuredText("").asText().trim());
}

const alpha = join(work, "Alpha.pdf");
const beta = join(work, "Beta.pdf");
const locked = join(work, "Locked.pdf");
const picture = join(work, "picture.png");
makeDoc(alpha, "Alpha", 3);
makeDoc(beta, "Beta", 2);
makeDoc(locked, "Locked", 1, "encrypt=aes-256,user-password=secret,owner-password=secret");
{
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 120, 60], false);
  pixmap.clear(60);
  writeFileSync(picture, pixmap.asPNG());
}

const app = await electron.launch({
  executablePath: electronPath,
  args: [...(process.platform === "linux" ? ["--no-sandbox"] : []), root, alpha],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1", PDFEDITOR_USER_DATA: join(work, "userdata") },
});
const page = await app.firstWindow();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.setViewportSize({ width: 1360, height: 900 }).catch(() => {});

const menu = (command) => app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send("menu", c), command);
const openFiles = (paths) => app.evaluate(({ BrowserWindow }, p) => BrowserWindow.getAllWindows()[0].webContents.send("open-files", p), paths);
const mockSave = (path) => app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, path);
const mockOpen = (paths) => app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: p }); }, paths);
const mockMessage = (response) => app.evaluate(({ dialog }, r) => { dialog.showMessageBox = async () => ({ response: r, checkboxChecked: false }); }, response);
const shot = (name) => page.screenshot({ path: join(shots, `${name}.png`) });
const step = (name) => console.log(`▸ ${name}`);
const activeName = () => page.locator(".tab.active .tab-name").textContent();
const waitTabName = (name) => page.waitForFunction((n) => document.querySelector(".tab.active .tab-name")?.textContent === n, name, { timeout: 15000 });
const pageCountText = () => page.locator(".statusbar, .status-bar").first().textContent();

async function drag(from, to, steps = 8) {
  await page.mouse.move(...from);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
  await page.mouse.up();
}

async function pageBox(n = 0) {
  const box = await page.locator(".page-slot").nth(n).locator(".page-overlay").boundingBox();
  assert.ok(box, `第 ${n + 1} 頁應可見`);
  return { at: (x, y) => [box.x + (x * box.width) / 595, box.y + (y * box.width) / 595] };
}

async function saveAs(path) {
  await mockSave(path);
  await menu("save-as");
  await waitTabName(path.split(/[\\/]/).pop());
  await page.waitForTimeout(300);
}

try {
  await waitTabName("Alpha.pdf");
  await page.waitForSelector(".page-canvas", { timeout: 30000 });

  step("縮圖右鍵選單：複製頁面");
  await page.locator(".thumb").nth(0).click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "複製頁面" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".thumb").length === 4);

  step("縮圖拖曳排序：把第 3 頁（Alpha 2）拖到最前面");
  {
    await page.locator(".thumb").nth(0).scrollIntoViewIfNeeded();
    const first = await page.locator(".thumb").nth(0).boundingBox();
    await page.locator(".thumb").nth(2).dragTo(page.locator(".thumb").nth(0), { targetPosition: { x: first.width / 2, y: 5 } });
    await page.waitForTimeout(800);
  }
  const reordered = join(work, "Alpha 排序.pdf");
  await saveAs(reordered);
  {
    const texts = pdfTexts(reordered);
    assert.equal(texts.length, 4);
    assert.deepEqual(texts.map((t) => t.split("\n")[0]), ["Alpha 2", "Alpha 1", "Alpha 1", "Alpha 3"]);
  }

  step("存檔後仍可復原");
  await menu("undo");
  await page.waitForTimeout(500);
  await page.waitForFunction(() => document.querySelector(".tab.active")?.textContent?.includes("●"), null, { timeout: 5000 }).catch(() => {});
  const undone = join(work, "Alpha 復原.pdf");
  await saveAs(undone);
  {
    const texts = pdfTexts(undone);
    assert.equal(texts.length, 4, "復原排序後仍是 4 頁");
    assert.ok(texts[0].includes("Alpha 1"), `復原後第一頁應回到 Alpha 1：${texts[0].split("\n")[0]}`);
  }

  step("書籤：新增、重新命名、刪除");
  await page.locator(".sidebar-tabs button", { hasText: "書籤" }).click();
  await menu("add-bookmark");
  await page.locator(".dialog input").fill("第一章");
  await page.keyboard.press("Enter");
  await page.waitForSelector(".outline-row", { timeout: 5000 });
  await page.locator(".outline-row").first().click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "重新命名" }).click();
  await page.locator(".dialog input").fill("序章");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".outline-row")?.textContent?.includes("序章"));
  await page.locator(".outline-row").first().click({ button: "right" });
  await page.locator(".context-menu button", { hasText: "刪除" }).click();
  await page.waitForFunction(() => !document.querySelector(".outline-row"));

  step("匯出文字");
  const textOut = join(work, "Alpha.txt");
  await mockSave(textOut);
  await menu("export-text");
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("已匯出文字"), null, { timeout: 10000 });
  assert.ok(readFileSync(textOut, "utf8").includes("Body text for Alpha page 2"), "匯出的文字應包含內容");

  step("擷取頁面");
  const extracted = join(work, "擷取.pdf");
  await mockSave(extracted);
  await page.locator(".sidebar-tabs button", { hasText: "縮圖" }).click();
  await page.locator(".thumb").nth(1).click();
  await page.locator(".thumb").nth(2).click({ modifiers: ["Shift"] });
  await menu("extract-pages");
  await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("已擷取 2 頁"), null, { timeout: 10000 });
  assert.equal(pdfTexts(extracted).length, 2);

  step("插入圖片註解並拖曳移動");
  await page.locator(".thumb").nth(0).click();
  await mockOpen([picture]);
  await page.keyboard.press("Escape");
  await page.locator('.toolbar button[title^="插入圖片"], .toolbar button[data-tool="image"]').first().click().catch(async () => {
    await menu("tool:image");
  });
  let box = await pageBox(0);
  await page.mouse.click(...box.at(300, 400));
  await page.waitForTimeout(800);
  await page.keyboard.press("v");
  box = await pageBox(0);
  await drag(box.at(300, 400), box.at(300, 500));
  await page.waitForTimeout(800);
  await page.locator(".sidebar-tabs button", { hasText: "註解" }).click();
  await page.waitForSelector(".annot-row", { timeout: 5000 });
  assert.equal(await page.locator(".annot-row").count(), 1);

  step("選取文字並複製");
  await page.keyboard.press("v");
  box = await pageBox(0);
  await drag(box.at(70, 130), box.at(330, 146));
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(300);
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.ok(/Body text/.test(clip), `剪貼簿應有選取的文字：${JSON.stringify(clip)}`);

  step("開啟受密碼保護的檔案（先輸入錯誤密碼）");
  await openFiles([locked]);
  await page.locator(".dialog input[type=password]").waitFor({ timeout: 10000 });
  await page.locator(".dialog input[type=password]").fill("wrong");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".dialog")?.textContent?.includes("密碼錯誤"), null, { timeout: 5000 });
  await page.locator(".dialog input[type=password]").fill("secret");
  await page.keyboard.press("Enter");
  await waitTabName("Locked.pdf");
  await page.waitForSelector(".page-canvas", { timeout: 15000 });

  step("加密檔編輯後存檔仍需密碼");
  await menu("insert-blank");
  await page.waitForTimeout(500);
  const lockedOut = join(work, "Locked 編輯.pdf");
  await saveAs(lockedOut);
  {
    const doc = mupdf.Document.openDocument(readFileSync(lockedOut), "application/pdf");
    assert.ok(doc.needsPassword(), "仍需密碼");
    assert.ok(doc.authenticatePassword("secret"));
    assert.equal(doc.countPages(), 2);
  }

  step("移除密碼與限制：另存沒有密碼的版本");
  const unlocked = join(work, "Locked 無密碼.pdf");
  await mockSave(unlocked);
  await menu("remove-security");
  await page.locator(".dialog .primary", { hasText: "確定" }).click({ timeout: 10000 });
  await page.waitForTimeout(300);
  {
    const doc = mupdf.Document.openDocument(readFileSync(unlocked), "application/pdf");
    assert.ok(!doc.needsPassword(), "移除密碼後不應再需要密碼");
    assert.equal(doc.countPages(), 2);
  }

  step("壓縮檔案大小：另存且可開啟");
  const compressed = join(work, "壓縮輸出.pdf");
  await mockSave(compressed);
  await menu("compress");
  await page.locator(".dialog").waitFor();
  await page.locator('.dialog input[type=checkbox]').uncheck().catch(() => {});
  await page.locator('.dialog input[type=radio]').nth(2).check();
  await page.locator(".dialog .primary", { hasText: "壓縮並另存" }).click();
  await page.locator(".dialog .primary", { hasText: "確定" }).click({ timeout: 10000 });
  await page.waitForTimeout(300);
  {
    const doc = mupdf.Document.openDocument(readFileSync(compressed), "application/pdf");
    assert.ok(!doc.needsPassword(), "壓縮後（未保留密碼）不應需要密碼");
    assert.equal(doc.countPages(), 2);
  }

  step("合併多個 PDF");
  await mockOpen([alpha, beta]);
  await menu("merge");
  await waitTabName("合併文件.pdf");
  const merged = join(work, "合併.pdf");
  await saveAs(merged);
  {
    const texts = pdfTexts(merged);
    assert.equal(texts.length, 5);
    assert.ok(texts[3].includes("Beta 1"));
  }

  step("影像編輯：裁切、旋轉、筆刷與亮度");
  await menu("image-edit");
  await page.locator(".ie-root").waitFor();
  await page.waitForSelector(".ie-loading", { state: "detached", timeout: 30000 });
  await page.waitForTimeout(300);
  const ebox = await page.locator(".ie-overlay").boundingBox();
  const ie = (x, y) => [ebox.x + (x * ebox.width) / 595, ebox.y + (y * ebox.width) / 595];
  await page.keyboard.press("b");
  await drag(ie(100, 300), ie(400, 320));
  await page.keyboard.press("j");
  await drag(ie(72, 110), ie(200, 110));
  await page.keyboard.press("c");
  await drag(ie(50, 50), ie(545, 450));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.locator(".ie-panel button", { hasText: "↻ 90°" }).click();
  await page.locator('.ie-panel input[type=range]').nth(1).fill("130");
  await page.locator(".ie-panel button", { hasText: "套用調整" }).click();
  await shot("12-影像編輯裁切旋轉");
  await page.locator(".ie-top .ie-primary").click();
  await page.waitForSelector(".ie-root", { state: "detached", timeout: 60000 });
  const edited = join(work, "影像編輯2.pdf");
  await saveAs(edited);
  {
    const doc = mupdf.Document.openDocument(readFileSync(edited), "application/pdf");
    const [x0, y0, x1, y1] = doc.loadPage(0).getBounds();
    assert.ok(Math.abs(x1 - x0 - 400) < 3 && Math.abs(y1 - y0 - 495) < 3, `裁切後旋轉 90° 頁面應為 400×495：${x1 - x0}×${y1 - y0}`);
    assert.equal(doc.countPages(), 5);
  }

  step("影像編輯：未按「套用調整」的亮度也會套用；可貼上剪貼簿中的圖片");
  const luminance = (file) => {
    const doc = mupdf.Document.openDocument(readFileSync(file), "application/pdf");
    const pixmap = doc.loadPage(0).toPixmap(mupdf.Matrix.scale(0.25, 0.25), mupdf.ColorSpace.DeviceGray, false, true);
    const pixels = pixmap.getPixels();
    return pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
  };
  await menu("image-edit");
  await page.locator(".ie-root").waitFor();
  await page.waitForSelector(".ie-loading", { state: "detached", timeout: 30000 });
  await page.waitForTimeout(300);
  await page.locator('.ie-panel input[type=range]').nth(1).fill("50");
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 40;
    canvas.height = 40;
    const c = canvas.getContext("2d");
    c.fillStyle = "#ff0000";
    c.fillRect(0, 0, 40, 40);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const data = new DataTransfer();
    data.items.add(new File([blob], "clip.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
  });
  await page.waitForSelector(".ie-overlay image", { timeout: 5000 });
  await page.locator(".ie-top .ie-primary").click();
  await page.waitForSelector(".ie-root", { state: "detached", timeout: 60000 });
  const darker = join(work, "影像編輯3.pdf");
  await saveAs(darker);
  {
    const before = luminance(edited);
    const after = luminance(darker);
    assert.ok(after < before * 0.75, `亮度調整應已套用：${before.toFixed(1)} → ${after.toFixed(1)}`);
  }

  step("關閉有未儲存變更的分頁：選擇取消");
  await menu("insert-blank");
  await page.waitForTimeout(300);
  await mockMessage(2);
  const tabsBefore = await page.locator(".tab").count();
  await menu("close-tab");
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".tab").count(), tabsBefore, "取消時分頁不應關閉");

  const relevantErrors = errors.filter((e) => !/Autofill|DevTools|Electron Security Warning/.test(e));
  assert.deepEqual(relevantErrors, [], `畫面不應有錯誤：\n${relevantErrors.join("\n")}`);
  console.log("✓ 第二部分端對端測試全部通過");
} catch (error) {
  await shot("99-失敗-2").catch(() => {});
  console.error("✗ 失敗：", error);
  console.error("畫面錯誤：", errors);
  process.exitCode = 1;
} finally {
  await mockMessage(1).catch(() => {});
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
}
void existsSync;
void pageCountText;
void activeName;
