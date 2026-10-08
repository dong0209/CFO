import { indicesFromRanges } from "../engine/pageRanges";
import type { ImageFormat, SaveOptions } from "../engine/types";
import { alertDialog, confirmDialog, hasOpenModal, prompt } from "../components/Modal";
import { api, type LoadedFile } from "../lib/api";
import { engine } from "../lib/engine";
import {
  type DocTab, type FitMode, type Layout, type Tool, TOOL_DEFAULT_COLORS,
  activeTab, getState, getTab, setState, toast, updateTab,
} from "./store";

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|tiff?|webp)$/i;
let tabCounter = 0;

export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

// MARK: - 錯誤處理

export async function guard<T>(title: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await api().message({ type: "error", message: title, detail: message });
    return undefined;
  }
}

async function withProgress<T>(title: string, total: number, fn: (step: (done: number) => void) => Promise<T>): Promise<T> {
  setState({ progress: { title, done: 0, total } });
  try {
    return await fn((done) => setState((s) => ({ progress: s.progress ? { ...s.progress, done } : null })));
  } finally {
    setState({ progress: null });
  }
}

// MARK: - 開啟與建立

export async function refreshRecent() {
  setState({ recent: await api().recent.get() });
}

export async function openDialog() {
  const files = await api().openFiles("pdf", true);
  for (const file of files) await openLoaded(file);
}

export async function openPaths(paths: string[]) {
  const images = paths.filter((p) => IMAGE_RE.test(p));
  for (const path of paths.filter((p) => !IMAGE_RE.test(p))) {
    const existing = getState().tabs.find((t) => t.path === path);
    if (existing) {
      setState({ activeKey: existing.key });
      continue;
    }
    const file = await guard("無法開啟檔案", () => api().readFile(path));
    if (file) await openLoaded(file);
  }
  if (images.length) {
    const files = await Promise.all(images.map((p) => api().readFile(p)));
    await createFromImageFiles(files);
  }
}

async function openLoaded(file: LoadedFile) {
  await guard(`無法開啟「${file.name}」`, async () => {
    const { id, needsPassword } = await engine.open(file.data);
    let security: SaveOptions | null = null;
    if (needsPassword) {
      const password = await unlockLoop(id, file.name);
      if (password === null) {
        await engine.close(id);
        return;
      }
      security = { userPassword: password };
    }
    await addTab(id, file.name, file.path, security);
    await api().recent.add(file.path);
    await refreshRecent();
  });
}

async function unlockLoop(id: number, name: string): Promise<string | null> {
  let message = `「${name}」受密碼保護，請輸入密碼：`;
  for (;;) {
    const password = await prompt({ title: "需要密碼", message, password: true, confirmText: "開啟" });
    if (password === null) return null;
    if (await engine.unlock(id, password)) return password;
    message = "密碼錯誤，請再試一次：";
  }
}

async function addTab(engineId: number, name: string, path: string | null, security: SaveOptions | null, dirty = false) {
  const info = await engine.info(engineId);
  const tab: DocTab = {
    key: `tab-${++tabCounter}`,
    engineId,
    name,
    path,
    dirty,
    info,
    revision: 1,
    currentPage: 0,
    selectedPages: [],
    zoom: 1,
    fit: "width",
    layout: "continuous",
    security,
    searchQuery: "",
    searchHits: [],
    searchIndex: 0,
    selectedAnnot: null,
    textSelection: null,
    scrollRequest: null,
  };
  setState((s) => ({ tabs: [...s.tabs, tab], activeKey: tab.key }));
}

export async function newBlank() {
  const id = await engine.createBlank();
  await addTab(id, "未命名.pdf", null, null, true);
}

export async function fromImagesDialog() {
  const files = await api().openFiles("images", true, "選擇要轉成 PDF 的圖片");
  if (files.length) await createFromImageFiles(files);
}

async function createFromImageFiles(files: LoadedFile[]) {
  await guard("無法從圖片建立 PDF", async () => {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant", { numeric: true }));
    const id = await engine.createFromImages(sorted.map((f) => f.data));
    await addTab(id, "圖片轉 PDF.pdf", null, null, true);
  });
}

export async function mergeDialog() {
  const files = await api().openFiles("pdf", true, "選擇要合併的 PDF（依選擇順序合併）");
  if (!files.length) return;
  await guard("合併失敗", async () => {
    const passwords: Array<string | null> = [];
    for (const file of files) {
      const probe = await engine.open(file.data);
      let password: string | null = null;
      if (probe.needsPassword) {
        password = await unlockLoop(probe.id, file.name);
        if (password === null) {
          await engine.close(probe.id);
          return;
        }
      }
      await engine.close(probe.id);
      passwords.push(password);
    }
    const id = await engine.merge(files.map((f) => f.data), passwords);
    await addTab(id, "合併文件.pdf", null, null, true);
  });
}

// MARK: - 分頁

export function activate(key: string) {
  setState({ activeKey: key });
}

export async function closeTab(key: string): Promise<boolean> {
  const tab = getTab(key);
  if (!tab) return true;
  if (tab.dirty) {
    setState({ activeKey: key });
    const choice = await api().message({
      type: "warning",
      message: `要儲存「${tab.name}」的變更嗎？`,
      detail: "如果不儲存，所做的變更將會遺失。",
      buttons: ["儲存", "不儲存", "取消"],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 2) return false;
    if (choice === 0 && !(await save(key))) return false;
  }
  await engine.close(tab.engineId);
  setState((s) => {
    const index = s.tabs.findIndex((t) => t.key === key);
    const tabs = s.tabs.filter((t) => t.key !== key);
    const activeKey = s.activeKey === key ? (tabs[Math.min(index, tabs.length - 1)]?.key ?? null) : s.activeKey;
    return { tabs, activeKey };
  });
  return true;
}

export async function handleCloseRequest() {
  for (const tab of [...getState().tabs]) {
    if (!(await closeTab(tab.key))) return;
  }
  await api().confirmClose();
}

// MARK: - 內容變更

/** 在引擎修改文件後更新資訊並觸發重新渲染。 */
export async function refresh(key: string, { dirty = true }: { dirty?: boolean } = {}) {
  const tab = getTab(key);
  if (!tab) return;
  const info = await engine.info(tab.engineId);
  updateTab(key, (t) => ({
    info,
    revision: t.revision + 1,
    dirty: dirty ? true : t.dirty,
    currentPage: Math.min(t.currentPage, info.pageCount - 1),
    selectedPages: t.selectedPages.filter((p) => p < info.pageCount),
    searchHits: [],
    textSelection: null,
  }));
}

/** 對目前文件執行引擎操作，完成後重新整理。 */
export async function mutate(title: string, fn: (tab: DocTab) => Promise<unknown>) {
  const tab = activeTab();
  if (!tab) return;
  const ok = await guard(title, async () => {
    await fn(tab);
    return true;
  });
  if (ok) await refresh(tab.key);
}

export async function undo() {
  const tab = activeTab();
  if (!tab?.info.canUndo) return;
  await engine.undo(tab.engineId);
  updateTab(tab.key, { selectedAnnot: null });
  await refresh(tab.key);
}

export async function redo() {
  const tab = activeTab();
  if (!tab?.info.canRedo) return;
  await engine.redo(tab.engineId);
  await refresh(tab.key);
}

// MARK: - 存檔

export async function save(key = activeTab()?.key): Promise<boolean> {
  const tab = key ? getTab(key) : null;
  if (!tab) return false;
  if (!tab.path) return saveAs(key);
  return writeTo(tab, tab.path);
}

export async function saveAs(key = activeTab()?.key): Promise<boolean> {
  const tab = key ? getTab(key) : null;
  if (!tab) return false;
  const path = await api().saveDialog("另存新檔", tab.name.endsWith(".pdf") ? tab.name : `${tab.name}.pdf`);
  if (!path) return false;
  return writeTo(tab, path);
}

async function writeTo(tab: DocTab, path: string): Promise<boolean> {
  const ok = await guard("無法儲存", async () => {
    const data = await engine.save(tab.engineId, tab.security ?? {});
    await api().writeFile(path, data);
    return true;
  });
  if (!ok) return false;
  updateTab(tab.key, { path, name: baseName(path), dirty: false });
  await refreshRecent();
  toast(`已儲存「${baseName(path)}」`);
  return true;
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function stem(tab: DocTab): string {
  return tab.name.replace(/\.pdf$/i, "");
}

export async function exportText() {
  const tab = activeTab();
  if (!tab) return;
  const path = await api().saveDialog("匯出文字", `${stem(tab)}.txt`, "text");
  if (!path) return;
  await guard("匯出失敗", async () => {
    await api().writeFile(path, await engine.exportText(tab.engineId));
    toast("已匯出文字");
  });
}

export async function exportCompressed() {
  const tab = activeTab();
  if (!tab) return;
  const path = await api().saveDialog("匯出壓縮版本", `${stem(tab)}-壓縮.pdf`);
  if (!path) return;
  await guard("壓縮失敗", async () => {
    const data = await engine.save(tab.engineId, { ...(tab.security ?? {}), compress: true });
    await api().writeFile(path, data);
    await alertDialog("壓縮完成", `已儲存至「${baseName(path)}」\n檔案大小：${formatBytes(data.length)}`);
  });
}

export async function exportImages(pages: number[], format: ImageFormat, dpi: number) {
  const tab = activeTab();
  if (!tab || !pages.length) return;
  const folder = await api().chooseFolder("選擇圖片存放資料夾");
  if (!folder) return;
  await guard("匯出失敗", () =>
    withProgress("正在匯出圖片…", pages.length, async (step) => {
      const digits = String(tab.info.pageCount).length;
      const written: string[] = [];
      for (const [i, page] of pages.entries()) {
        const data = await engine.exportPageImage(tab.engineId, page, dpi, format);
        const name = `${stem(tab)}-${String(page + 1).padStart(digits, "0")}.${format === "png" ? "png" : "jpg"}`;
        written.push(...(await api().writeFiles(folder, [{ name, data }])));
        step(i + 1);
      }
      if (written[0]) await api().showInFolder(written[0]);
    }),
  );
}

export async function extractPages(pages: number[]) {
  const tab = activeTab();
  if (!tab || !pages.length) return;
  const path = await api().saveDialog("擷取頁面", `${stem(tab)}-擷取頁面.pdf`);
  if (!path) return;
  await guard("擷取失敗", async () => {
    await api().writeFile(path, await engine.extractPages(tab.engineId, [...pages].sort((a, b) => a - b)));
    toast(`已擷取 ${pages.length} 頁`);
  });
}

export async function splitDocument(ranges: Array<[number, number]> | null, perFile: number) {
  const tab = activeTab();
  if (!tab) return;
  const folder = await api().chooseFolder("選擇分割後檔案的存放資料夾");
  if (!folder) return;
  await guard("分割失敗", async () => {
    const parts = ranges ? await engine.split(tab.engineId, ranges) : await engine.splitEvery(tab.engineId, perFile);
    const written = await api().writeFiles(folder, parts.map((data, i) => ({ name: `${stem(tab)}-${i + 1}.pdf`, data })));
    toast(`已分割為 ${written.length} 個檔案`);
    if (written[0]) await api().showInFolder(written[0]);
  });
}

export async function printDocument() {
  const tab = activeTab();
  if (!tab) return;
  await guard("列印失敗", () =>
    withProgress("正在準備列印…", tab.info.pageCount, async (step) => {
      const pages = [];
      for (let i = 0; i < tab.info.pageCount; i++) {
        pages.push({ data: await engine.exportPageImage(tab.engineId, i, 200, "png"), ...tab.info.pages[i] });
        step(i + 1);
      }
      setState({ progress: null });
      await api().print(pages);
    }),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// MARK: - 頁面

/** 頁面操作的對象：縮圖列有選取就用選取的頁面，否則用目前頁面。 */
export function targetPages(tab: DocTab | null = activeTab()): number[] {
  if (!tab) return [];
  return tab.selectedPages.length ? [...tab.selectedPages].sort((a, b) => a - b) : [tab.currentPage];
}

export const rotatePages = (pages: number[], degrees: number) =>
  mutate("無法旋轉頁面", (tab) => engine.rotatePages(tab.engineId, pages, degrees));

export async function deletePages(pages: number[]) {
  const tab = activeTab();
  if (!tab) return;
  if (pages.length >= tab.info.pageCount) {
    await alertDialog("無法刪除", "文件至少需要保留一頁。");
    return;
  }
  await mutate("無法刪除頁面", (t) => engine.deletePages(t.engineId, pages));
  updateTab(tab.key, { selectedPages: [] });
}

export async function insertBlank(after: number) {
  await mutate("無法插入頁面", (tab) => engine.insertBlankPage(tab.engineId, after + 1));
  goToPage(after + 1);
}

export async function insertFromFile(after: number) {
  const files = await api().openFiles("pdf", true, "選擇要插入的 PDF");
  let at = after + 1;
  for (const file of files) {
    await mutate(`無法插入「${file.name}」`, async (tab) => {
      at += await engine.insertDocument(tab.engineId, at, file.data);
    });
  }
}

export const duplicatePages = (pages: number[]) => mutate("無法複製頁面", (tab) => engine.duplicatePages(tab.engineId, pages));

export async function movePages(pages: number[], destination: number) {
  await mutate("無法搬移頁面", (tab) => engine.movePages(tab.engineId, pages, destination));
  const tab = activeTab();
  if (tab) updateTab(tab.key, { selectedPages: [] });
}

// MARK: - 導覽與檢視

export function goToPage(page: number, y?: number) {
  const tab = activeTab();
  if (!tab) return;
  const target = Math.max(0, Math.min(page, tab.info.pageCount - 1));
  updateTab(tab.key, { currentPage: target, scrollRequest: { page: target, y, nonce: Date.now() + Math.random() } });
}

export async function promptGoToPage() {
  const tab = activeTab();
  if (!tab) return;
  const text = await prompt({ title: "前往頁面", message: `輸入頁碼（1–${tab.info.pageCount}）：`, initial: String(tab.currentPage + 1) });
  const n = Number(text);
  if (text && Number.isInteger(n) && n >= 1 && n <= tab.info.pageCount) goToPage(n - 1);
}

export function setZoom(zoom: number, fit: FitMode = null) {
  const tab = activeTab();
  if (tab) updateTab(tab.key, { zoom: Math.max(0.1, Math.min(zoom, 8)), fit });
}

export function zoomStep(direction: 1 | -1) {
  const tab = activeTab();
  if (!tab) return;
  const next = direction > 0 ? ZOOM_STEPS.find((z) => z > tab.zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < tab.zoom - 0.001);
  setZoom(next ?? tab.zoom);
}

export function setLayout(layout: Layout) {
  const tab = activeTab();
  if (tab) updateTab(tab.key, { layout });
}

export function selectTool(tool: Tool) {
  setState((s) => ({
    tool,
    color: TOOL_DEFAULT_COLORS[tool] ?? s.color,
    pendingImage: tool === s.tool ? s.pendingImage : null,
  }));
  const tab = activeTab();
  if (tab) updateTab(tab.key, { textSelection: null });
}

// MARK: - 搜尋

export async function search(query: string) {
  const tab = activeTab();
  if (!tab) return;
  updateTab(tab.key, { searchQuery: query });
  const hits = query.trim() ? await engine.search(tab.engineId, query) : [];
  updateTab(tab.key, { searchHits: hits, searchIndex: 0 });
  if (hits[0]) goToPage(hits[0].page, hits[0].quads[0][1]);
  else if (query.trim()) toast("找不到符合的文字");
}

export function nextHit(step: 1 | -1) {
  const tab = activeTab();
  if (!tab?.searchHits.length) return;
  const index = (tab.searchIndex + step + tab.searchHits.length) % tab.searchHits.length;
  updateTab(tab.key, { searchIndex: index });
  const hit = tab.searchHits[index];
  goToPage(hit.page, hit.quads[0][1]);
}

// MARK: - 書籤、註解

export async function addBookmark() {
  const tab = activeTab();
  if (!tab) return;
  const title = await prompt({ title: "新增書籤", message: "書籤名稱：", initial: `第 ${tab.currentPage + 1} 頁` });
  if (title) await mutate("無法新增書籤", (t) => engine.addBookmark(t.engineId, title, t.currentPage));
}

export async function deleteSelectedAnnotation() {
  const tab = activeTab();
  if (!tab?.selectedAnnot) return;
  const { page, id } = tab.selectedAnnot;
  updateTab(tab.key, { selectedAnnot: null });
  await mutate("無法刪除註解", (t) => engine.deleteAnnotation(t.engineId, page, id));
}

export async function applyRedactions() {
  const tab = activeTab();
  if (!tab) return;
  const count = await engine.redactionCount(tab.engineId);
  if (!count) {
    await alertDialog("沒有待套用的遮蓋", "請先使用「塗黑遮蓋」工具框選要移除的區域。");
    return;
  }
  const ok = await confirmDialog(
    `套用 ${count} 個遮蓋？`,
    "遮蓋區域內的文字、圖片與線條會被永久移除並以黑色方塊取代，與遮蓋區域重疊的註解也會刪除。存檔後就無法再復原。",
    "套用遮蓋",
    true,
  );
  if (ok) await mutate("無法套用遮蓋", (t) => engine.applyRedactions(t.engineId));
}

export async function flatten() {
  const ok = await confirmDialog("平面化所有註解與表單？", "註解與表單欄位會固定到頁面內容中，之後無法再個別編輯（可用「復原」取消）。", "平面化");
  if (ok) await mutate("平面化失敗", (tab) => engine.flatten(tab.engineId));
}

export async function removeStamps() {
  const tab = activeTab();
  if (!tab) return;
  const count = await guard("移除失敗", () => engine.removeStamps(tab.engineId));
  if (count) {
    await refresh(tab.key);
    toast(`已移除 ${count} 個浮水印／頁碼`);
  } else if (count === 0) {
    await alertDialog("沒有可移除的項目", "只能移除以本程式加入的浮水印與頁碼。");
  }
}

// MARK: - 選單指令

type Handler = () => unknown;

export function registerCommands(extra: Record<string, Handler>) {
  Object.assign(commandHandlers, extra);
}

const needsDoc = (fn: (tab: DocTab) => unknown): Handler => () => {
  const tab = activeTab();
  if (tab) return fn(tab);
};

const commandHandlers: Record<string, Handler> = {
  new: newBlank,
  open: openDialog,
  "clear-recent": async () => {
    await api().recent.clear();
    await refreshRecent();
  },
  "from-images": fromImagesDialog,
  merge: mergeDialog,
  save: () => save(),
  "save-as": () => saveAs(),
  "export-text": exportText,
  "export-compressed": exportCompressed,
  print: printDocument,
  "close-tab": needsDoc((tab) => closeTab(tab.key)),
  undo,
  redo,
  "delete-annotation": deleteSelectedAnnotation,
  find: () => setState({ sidebar: true, sidebarTab: "search" }),
  "find-next": () => nextHit(1),
  "find-prev": () => nextHit(-1),
  "toggle-sidebar": () => setState((s) => ({ sidebar: !s.sidebar })),
  "zoom-in": () => zoomStep(1),
  "zoom-out": () => zoomStep(-1),
  "zoom-actual": () => setZoom(1),
  "fit-width": needsDoc((tab) => updateTab(tab.key, { fit: "width" })),
  "fit-page": needsDoc((tab) => updateTab(tab.key, { fit: "page" })),
  "layout-continuous": () => setLayout("continuous"),
  "layout-two": () => setLayout("twoUp"),
  "first-page": () => goToPage(0),
  "prev-page": needsDoc((tab) => goToPage(tab.currentPage - (tab.layout === "twoUp" ? 2 : 1))),
  "next-page": needsDoc((tab) => goToPage(tab.currentPage + (tab.layout === "twoUp" ? 2 : 1))),
  "last-page": needsDoc((tab) => goToPage(tab.info.pageCount - 1)),
  "goto-page": promptGoToPage,
  "rotate-right": needsDoc((tab) => rotatePages(targetPages(tab), 90)),
  "rotate-left": needsDoc((tab) => rotatePages(targetPages(tab), -90)),
  "insert-blank": needsDoc((tab) => insertBlank(Math.max(...targetPages(tab)))),
  "insert-file": needsDoc((tab) => insertFromFile(Math.max(...targetPages(tab)))),
  "duplicate-pages": needsDoc((tab) => duplicatePages(targetPages(tab))),
  "delete-pages": needsDoc((tab) => deletePages(targetPages(tab))),
  "extract-pages": needsDoc((tab) => extractPages(targetPages(tab))),
  "add-bookmark": addBookmark,
  "remove-stamps": removeStamps,
  "apply-redactions": applyRedactions,
  flatten: needsDoc(() => flatten()),
};

export async function runCommand(command: string) {
  if (hasOpenModal()) {
    // 對話框（例如影像編輯）開啟時，把選單指令交給對話框處理
    window.dispatchEvent(new CustomEvent("app-command", { detail: command }));
    return;
  }
  if (command.startsWith("tool:")) {
    selectTool(command.slice(5) as Tool);
    return;
  }
  const handler = commandHandlers[command];
  if (handler) await handler();
}

export { indicesFromRanges };
