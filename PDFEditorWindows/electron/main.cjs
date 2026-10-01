// Electron 主程序：視窗、選單、檔案存取、列印、簽名與最近開啟檔案。
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { buildMenu } = require("./menu.cjs");
const fonts = require("./fonts.cjs");

const APP_TITLE = "PDF 編輯器";
const DIST = path.join(__dirname, "..", "dist");
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".gz": "application/gzip",
  ".woff2": "font/woff2",
};

// 測試時可指定獨立的使用者資料夾
if (process.env.PDFEDITOR_USER_DATA) app.setPath("userData", process.env.PDFEDITOR_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** @type {BrowserWindow | null} */
let mainWindow = null;
let allowClose = false;
/** 程式啟動前（或視窗載入前）收到要開啟的檔案 */
let pendingFiles = pdfArgs(process.argv);

// 只允許一個執行個體；再次開啟檔案時交給現有視窗處理。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const files = pdfArgs(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send("open-files", files);
    }
  });
}

function pdfArgs(argv) {
  return argv.slice(1).filter((arg) => !arg.startsWith("-") && /\.(pdf|png|jpe?g|gif|bmp|tiff?|webp)$/i.test(arg) && fs.existsSync(arg)).map((arg) => path.resolve(arg));
}

// MARK: - 設定檔（最近開啟、簽名）

const userDir = () => app.getPath("userData");
const recentFile = () => path.join(userDir(), "recent.json");
const signatureDir = () => path.join(userDir(), "signatures");

function readRecent() {
  try {
    return JSON.parse(fs.readFileSync(recentFile(), "utf8")).filter((p) => fs.existsSync(p));
  } catch {
    return [];
  }
}

function writeRecent(list) {
  fs.mkdirSync(userDir(), { recursive: true });
  fs.writeFileSync(recentFile(), JSON.stringify(list.slice(0, 10)));
  refreshMenu();
}

function addRecent(filePath) {
  writeRecent([filePath, ...readRecent().filter((p) => p !== filePath)]);
  app.addRecentDocument(filePath);
}

function refreshMenu() {
  Menu.setApplicationMenu(buildMenu({ send: sendCommand, recent: readRecent(), openRecent: (p) => mainWindow?.webContents.send("open-files", [p]) }));
}

function sendCommand(command) {
  mainWindow?.webContents.send("menu", command);
}

// MARK: - 視窗

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: APP_TITLE,
    backgroundColor: "#f3f3f3",
    show: false,
    icon: path.join(__dirname, "..", "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (allowClose) return;
    event.preventDefault();
    mainWindow?.webContents.send("close-request");
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // 外部連結以系統瀏覽器開啟，避免在 App 內導覽
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://") && !(DEV_URL && url.startsWith(DEV_URL))) {
      event.preventDefault();
      openExternalSafe(url);
    }
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadURL("app://bundle/index.html");
}

function openExternalSafe(url) {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
}

async function serveApp(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  const file = path.normalize(path.join(DIST, relative));
  if (!file.startsWith(DIST)) return new Response("Forbidden", { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, { headers: { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream" } });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// MARK: - IPC

async function readDocument(filePath) {
  const data = await fsp.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "bmp", "tif", "tiff", "webp"];

function registerIpc() {
  ipcMain.handle("dialog:open", async (_e, { kind, multiple, title }) => {
    const filters = kind === "images"
      ? [{ name: "圖片", extensions: IMAGE_EXTENSIONS }]
      : [{ name: "PDF 文件", extensions: ["pdf"] }];
    const result = await dialog.showOpenDialog(mainWindow, {
      title: title ?? (kind === "images" ? "選擇圖片" : "開啟 PDF"),
      filters,
      properties: ["openFile", ...(multiple ? ["multiSelections"] : [])],
    });
    if (result.canceled) return [];
    return Promise.all(result.filePaths.map(readDocument));
  });

  ipcMain.handle("file:read", (_e, filePath) => readDocument(filePath));

  ipcMain.handle("dialog:save", async (_e, { title, defaultName, kind }) => {
    const filters = kind === "text"
      ? [{ name: "文字檔", extensions: ["txt"] }]
      : [{ name: "PDF 文件", extensions: ["pdf"] }];
    const result = await dialog.showSaveDialog(mainWindow, { title, defaultPath: defaultName, filters });
    return result.canceled ? null : result.filePath;
  });

  ipcMain.handle("dialog:folder", async (_e, title) => {
    const result = await dialog.showOpenDialog(mainWindow, { title, properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0];
  });

  // 先寫入暫存檔再取代，避免寫到一半失敗時損毀原檔
  ipcMain.handle("file:write", async (_e, filePath, data) => {
    const temp = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, filePath);
    if (filePath.toLowerCase().endsWith(".pdf")) addRecent(filePath);
  });

  ipcMain.handle("file:write-many", async (_e, folder, files) => {
    const written = [];
    for (const file of files) {
      const target = path.join(folder, path.basename(file.name));
      await fsp.writeFile(target, file.data);
      written.push(target);
    }
    return written;
  });

  ipcMain.handle("shell:show", (_e, filePath) => shell.showItemInFolder(filePath));
  ipcMain.handle("shell:open-external", (_e, url) => openExternalSafe(url));

  ipcMain.handle("message", async (_e, options) => {
    const result = await dialog.showMessageBox(mainWindow, { noLink: true, title: APP_TITLE, ...options });
    return result.response;
  });

  ipcMain.handle("recent:get", () => readRecent());
  ipcMain.handle("recent:add", (_e, filePath) => addRecent(filePath));
  ipcMain.handle("recent:clear", () => writeRecent([]));

  ipcMain.handle("signatures:list", async () => {
    try {
      const names = (await fsp.readdir(signatureDir())).filter((n) => n.endsWith(".png")).sort();
      return Promise.all(names.map(async (name) => ({ id: name, data: new Uint8Array(await fsp.readFile(path.join(signatureDir(), name))) })));
    } catch {
      return [];
    }
  });
  ipcMain.handle("signatures:add", async (_e, data) => {
    await fsp.mkdir(signatureDir(), { recursive: true });
    await fsp.writeFile(path.join(signatureDir(), `signature-${Date.now()}.png`), data);
  });
  ipcMain.handle("signatures:remove", async (_e, id) => {
    await fsp.rm(path.join(signatureDir(), path.basename(id)), { force: true });
  });

  ipcMain.handle("window:set-title", (_e, title) => mainWindow?.setTitle(title ? `${title} - ${APP_TITLE}` : APP_TITLE));
  ipcMain.handle("window:initial-files", () => {
    const files = pendingFiles;
    pendingFiles = [];
    return files;
  });
  ipcMain.handle("window:confirm-close", () => {
    allowClose = true;
    mainWindow?.close();
  });

  ipcMain.handle("print", (_e, pages) => printPages(pages));
  ipcMain.handle("fonts:resolve", (_e, request) => fonts.resolveFont(request));
  ipcMain.handle("fonts:list", () => fonts.listFamilies());
}

/** 以隱藏視窗載入每頁的圖片後呼叫系統列印對話框。 */
async function printPages(pages) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0; }
    html, body { margin: 0; padding: 0; }
    .page { page-break-after: always; break-after: page; width: 100%; height: 100vh; display: flex; align-items: center; justify-content: center; }
    .page:last-child { page-break-after: auto; break-after: auto; }
    img { max-width: 100%; max-height: 100vh; }
  </style></head><body>${pages
    .map((p) => `<div class="page"><img src="data:image/png;base64,${Buffer.from(p.data).toString("base64")}"></div>`)
    .join("")}</body></html>`;
  const file = path.join(app.getPath("temp"), `pdfeditor-print-${Date.now()}.html`);
  await fsp.writeFile(file, html);
  const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await printWindow.loadFile(file);
    const landscape = pages.length > 0 && pages[0].width > pages[0].height;
    await new Promise((resolve, reject) => {
      printWindow.webContents.print({ silent: false, printBackground: true, landscape }, (success, reason) => {
        if (success || reason === "cancelled") resolve();
        else reject(new Error(reason));
      });
    });
  } finally {
    printWindow.destroy();
    fsp.rm(file, { force: true }).catch(() => {});
  }
}

app.whenReady().then(() => {
  protocol.handle("app", serveApp);
  registerIpc();
  refreshMenu();
  createWindow();
  fonts.warmUp();
});

app.on("window-all-closed", () => app.quit());
