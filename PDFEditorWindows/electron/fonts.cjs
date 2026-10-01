// 字型尋找與下載：先找電腦上已安裝的字型，再從 Google Fonts 下載（並快取）。
const { app, net } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const FONT_EXTENSIONS = /\.(ttf|otf|ttc|otc)$/i;
const INDEX_VERSION = 2;

function fontDirectories() {
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      path.join(process.env.WINDIR || "C:\\Windows", "Fonts"),
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Microsoft", "Windows", "Fonts"),
    ];
  }
  if (process.platform === "darwin") {
    return ["/System/Library/Fonts", "/Library/Fonts", path.join(home, "Library", "Fonts")];
  }
  return ["/usr/share/fonts", "/usr/local/share/fonts", path.join(home, ".fonts"), path.join(home, ".local", "share", "fonts")];
}

const normalize = (text) => String(text || "").toLowerCase().replace(/[\s_\-,.]/g, "");

// MARK: - 讀取字型名稱（只讀需要的片段，不載入整個檔案）

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function decodeName(buffer, platform, encoding) {
  if (platform === 3 || platform === 0) {
    const chars = [];
    for (let i = 0; i + 1 < buffer.length; i += 2) chars.push(buffer.readUInt16BE(i));
    return String.fromCharCode(...chars);
  }
  if (platform === 1 && encoding === 0) return buffer.toString("latin1");
  return null;
}

async function readFace(handle, offset) {
  const header = await readAt(handle, offset, 12);
  if (header.length < 12) return null;
  const numTables = header.readUInt16BE(4);
  const directory = await readAt(handle, offset + 12, numTables * 16);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const tag = directory.toString("latin1", i * 16, i * 16 + 4);
    tables[tag] = { offset: directory.readUInt32BE(i * 16 + 8), length: directory.readUInt32BE(i * 16 + 12) };
  }
  if (!tables.name) return null;
  const nameTable = await readAt(handle, tables.name.offset, Math.min(tables.name.length, 256 * 1024));
  const count = nameTable.readUInt16BE(2);
  const stringOffset = nameTable.readUInt16BE(4);
  const names = { family: new Set(), subfamily: new Set(), full: new Set(), ps: new Set() };
  for (let i = 0; i < count; i++) {
    const record = 6 + i * 12;
    if (record + 12 > nameTable.length) break;
    const platform = nameTable.readUInt16BE(record);
    const encoding = nameTable.readUInt16BE(record + 2);
    const nameId = nameTable.readUInt16BE(record + 6);
    const length = nameTable.readUInt16BE(record + 8);
    const start = stringOffset + nameTable.readUInt16BE(record + 10);
    if (start + length > nameTable.length) continue;
    const text = decodeName(nameTable.subarray(start, start + length), platform, encoding);
    if (!text) continue;
    if (nameId === 1 || nameId === 16) names.family.add(text);
    else if (nameId === 2 || nameId === 17) names.subfamily.add(text);
    else if (nameId === 4) names.full.add(text);
    else if (nameId === 6) names.ps.add(text);
  }
  let weight = 400;
  let italic = [...names.subfamily].some((s) => /italic|oblique/i.test(s));
  if (tables["OS/2"]) {
    const os2 = await readAt(handle, tables["OS/2"].offset, 64);
    if (os2.length >= 64) {
      weight = os2.readUInt16BE(4) || 400;
      italic = italic || (os2.readUInt16BE(62) & 1) === 1;
    }
  }
  return {
    family: [...names.family],
    subfamily: [...names.subfamily],
    full: [...names.full],
    ps: [...names.ps],
    weight,
    italic,
  };
}

async function readFontFile(file) {
  const handle = await fsp.open(file, "r");
  try {
    const tag = (await readAt(handle, 0, 12));
    if (tag.toString("latin1", 0, 4) === "ttcf") {
      const numFonts = tag.readUInt32BE(8);
      const offsets = await readAt(handle, 12, numFonts * 4);
      const faces = [];
      for (let i = 0; i < numFonts; i++) {
        const face = await readFace(handle, offsets.readUInt32BE(i * 4)).catch(() => null);
        if (face) faces.push({ ...face, index: i });
      }
      return faces;
    }
    const face = await readFace(handle, 0);
    return face ? [{ ...face, index: 0 }] : [];
  } finally {
    await handle.close();
  }
}

async function listFontFiles(directory, depth = 0, out = []) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory() && depth < 4) await listFontFiles(full, depth + 1, out);
    else if (FONT_EXTENSIONS.test(entry.name)) out.push(full);
  }
  return out;
}

// MARK: - 系統字型索引（快取在使用者資料夾）

let indexPromise = null;

function indexFile() {
  return path.join(app.getPath("userData"), "font-index.json");
}

async function buildIndex() {
  let cached = {};
  try {
    const saved = JSON.parse(await fsp.readFile(indexFile(), "utf8"));
    if (saved.version === INDEX_VERSION) cached = saved.files;
  } catch {
    // 沒有快取
  }
  const files = {};
  for (const directory of fontDirectories()) {
    for (const file of await listFontFiles(directory)) {
      try {
        const stat = await fsp.stat(file);
        const previous = cached[file];
        files[file] = previous && previous.mtime === stat.mtimeMs && previous.size === stat.size
          ? previous
          : { mtime: stat.mtimeMs, size: stat.size, faces: await readFontFile(file) };
      } catch {
        // 無法讀取的字型略過
      }
    }
  }
  await fsp.mkdir(path.dirname(indexFile()), { recursive: true });
  await fsp.writeFile(indexFile(), JSON.stringify({ version: INDEX_VERSION, files })).catch(() => {});
  return Object.entries(files).flatMap(([file, entry]) => entry.faces.map((face) => ({ ...face, file })));
}

function systemFaces() {
  indexPromise ??= buildIndex().catch(() => []);
  return indexPromise;
}

/** 依名稱找電腦上的字型：PostScript／全名完全相符優先，其次依字族挑最接近的粗細與斜體。 */
async function findSystemFont(name, weight, italic) {
  const key = normalize(name);
  if (!key) return null;
  const faces = await systemFaces();
  const matches = faces
    .map((f) => {
      const exactName = f.ps.some((n) => normalize(n) === key) || f.full.some((n) => normalize(n) === key);
      const familyName = f.family.some((n) => normalize(n) === key);
      if (!exactName && !familyName) return null;
      // PostScript／全名完全相符時略為優先，但仍以粗細與斜體最接近者為準
      return { f, score: Math.abs(f.weight - weight) + (f.italic === italic ? 0 : 1000) - (exactName ? 50 : 0) };
    })
    .filter(Boolean)
    .sort((a, b) => a.score - b.score);
  return matches.length ? matches[0].f : null;
}

// MARK: - Google Fonts 下載

const failedDownloads = new Set();

function cssUrl(family, weight, italic) {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  return italic
    ? `https://fonts.googleapis.com/css2?family=${name}:ital,wght@1,${weight}`
    : `https://fonts.googleapis.com/css2?family=${name}:wght@${weight}`;
}

async function downloadGoogleFont(family, weight, italic) {
  const safe = family.replace(/[^\w\- ]/g, "").replace(/\s+/g, "-");
  const cacheDir = path.join(app.getPath("userData"), "fonts");
  const attempts = [[weight, italic], [weight, false], [400, italic], [400, false], [700, false]];
  for (const [w, i] of attempts) {
    const file = path.join(cacheDir, `${safe}-${w}${i ? "i" : ""}.ttf`);
    if (fs.existsSync(file)) return { file, weight: w, italic: i };
    const key = `${family}|${w}|${i}`;
    if (failedDownloads.has(key)) continue;
    try {
      // 非瀏覽器的 User-Agent 會取得完整的 TTF 字型檔
      const css = await net.fetch(cssUrl(family, w, i), { headers: { "User-Agent": "PDFEditor/1.0" } });
      if (!css.ok) throw new Error(`CSS ${css.status}`);
      const url = (await css.text()).match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('truetype'\)/)?.[1];
      if (!url) throw new Error("沒有 TTF");
      const response = await net.fetch(url);
      if (!response.ok) throw new Error(`字型 ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      await fsp.mkdir(cacheDir, { recursive: true });
      await fsp.writeFile(file, data);
      return { file, weight: w, italic: i };
    } catch {
      failedDownloads.add(key);
    }
  }
  return null;
}

// MARK: - 對外介面

/**
 * 依字型請求（由 PDF 引擎的 fontRequest 產生）找出字型。
 * 回傳 { data, index, name, source: "system" | "download", exact } 或 null。
 */
async function resolveFont(request) {
  // 先找同名字型（電腦上 → 下載），再找相近字型（電腦上 → 下載）
  for (const exact of [true, false]) {
    for (const candidate of (request.system || []).filter((c) => c.exact === exact)) {
      const face = await findSystemFont(candidate.family, request.weight, request.italic);
      if (face) {
        const data = await fsp.readFile(face.file);
        return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), index: face.index, name: face.full[0] || face.family[0] || candidate.family, source: "system", exact: candidate.exact };
      }
    }
    for (const candidate of (request.downloads || []).filter((c) => c.exact === exact)) {
      const downloaded = await downloadGoogleFont(candidate.family, request.weight, request.italic);
      if (downloaded) {
        const data = await fsp.readFile(downloaded.file);
        const style = downloaded.weight >= 700 ? " Bold" : downloaded.weight !== 400 ? ` ${downloaded.weight}` : "";
        return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), index: 0, name: `${candidate.family}${style}`, source: "download", exact: candidate.exact };
      }
    }
  }
  return null;
}

/**
 * 電腦上已安裝的字族（字型選單用）。回傳 [{ family, label }]：family 為英文名稱（用來尋找字型），
 * label 另外附上中文或日文名稱（例如「Microsoft JhengHei（微軟正黑體）」）。
 */
async function listFamilies() {
  const faces = await systemFaces();
  const families = new Map();
  for (const face of faces) {
    const names = face.family.filter((n) => n && !n.startsWith("."));
    if (!names.length) continue;
    const english = names.find((n) => /^[\x20-\x7e]+$/.test(n)) ?? names[0];
    const local = names.find((n) => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(n));
    const key = normalize(english);
    if (!families.has(key)) families.set(key, { family: english, label: local && local !== english ? `${english}（${local}）` : english });
  }
  return [...families.values()].sort((a, b) => a.family.localeCompare(b.family));
}

/** 啟動後在背景建立字型索引，第一次編輯文字時就不必等待。 */
function warmUp() {
  setTimeout(() => systemFaces(), 3000);
}

module.exports = { resolveFont, listFamilies, warmUp, readFontFile, findSystemFont };
