/**
 * 字型辨識：由 PDF 內的字型名稱推測字族、粗細與斜體，並列出可在電腦上尋找或從 Google Fonts 下載的候選字型。
 * 商用字型（Arial、新細明體等）無法合法下載，改用字寬相容或外觀相近的開源字型。
 */

export interface FontCandidate {
  family: string;
  /** true：與原字型相同；false：相近的替代字型 */
  exact: boolean;
}

export interface FontRequest {
  /** 原字型名稱（已去除子集前綴） */
  originalName: string;
  /** 推測的字族名稱（例如 Times New Roman） */
  family: string;
  /** CSS 字重 100–900 */
  weight: number;
  italic: boolean;
  /** 依序到電腦上尋找的字族或 PostScript 名稱 */
  system: FontCandidate[];
  /** 依序嘗試從 Google Fonts 下載的字族 */
  downloads: FontCandidate[];
  /** 主要字型缺字時（例如英文字型遇到中文）使用的中文備援字型 */
  fallback: { system: FontCandidate[]; downloads: FontCandidate[] } | null;
}

/** 可從 Google Fonts 下載的常用開源字型（字型選單用）。 */
export const DOWNLOADABLE_FONTS = [
  "Noto Sans TC", "Noto Serif TC", "LXGW WenKai TC", "Noto Sans SC", "Noto Serif SC", "Noto Sans JP", "Noto Serif JP", "Noto Sans KR",
  "Roboto", "Open Sans", "Lato", "Montserrat", "Inter", "Source Sans 3", "Arimo", "Tinos", "Cousine", "Carlito", "Caladea",
  "Merriweather", "Playfair Display", "EB Garamond", "Roboto Mono", "Source Code Pro",
];

interface KnownFont {
  keys: string[];
  family: string;
  system: string[];
  /** 可下載的字型；exact 表示原字型本身即為開源字型 */
  download: FontCandidate[];
}

const KNOWN: KnownFont[] = [
  { keys: ["arial", "arialmt", "helvetica", "helveticaneue", "nimbussans", "liberationsans"], family: "Arial", system: ["Arial", "Helvetica", "Liberation Sans"], download: [{ family: "Arimo", exact: false }] },
  { keys: ["timesnewroman", "timesnewromanps", "timesnewromanpsmt", "times", "timesroman", "nimbusroman", "liberationserif"], family: "Times New Roman", system: ["Times New Roman", "Times", "Liberation Serif"], download: [{ family: "Tinos", exact: false }] },
  { keys: ["couriernew", "couriernewpsmt", "courier", "nimbusmono", "liberationmono"], family: "Courier New", system: ["Courier New", "Courier", "Liberation Mono"], download: [{ family: "Cousine", exact: false }] },
  { keys: ["calibri"], family: "Calibri", system: ["Calibri"], download: [{ family: "Carlito", exact: false }] },
  { keys: ["cambria"], family: "Cambria", system: ["Cambria"], download: [{ family: "Caladea", exact: false }] },
  { keys: ["georgia"], family: "Georgia", system: ["Georgia"], download: [{ family: "Gelasio", exact: false }] },
  { keys: ["verdana", "tahoma", "segoeui"], family: "Segoe UI", system: ["Segoe UI", "Verdana", "Tahoma"], download: [{ family: "Open Sans", exact: false }] },
  { keys: ["pmingliu", "mingliu", "pmingliuextb", "mingliuhkscs", "新細明體", "細明體", "新细明体"], family: "新細明體", system: ["PMingLiU", "MingLiU", "新細明體", "LiSong Pro", "Songti TC"], download: [{ family: "Noto Serif TC", exact: false }] },
  { keys: ["dfkaisb", "dfkaishusbestdbf", "kaiu", "biaukai", "標楷體", "标楷体", "dfkai"], family: "標楷體", system: ["DFKai-SB", "標楷體", "BiauKai", "Kaiti TC"], download: [{ family: "LXGW WenKai TC", exact: false }] },
  { keys: ["microsoftjhenghei", "microsoftjhengheiui", "微軟正黑體", "msjh", "pingfangtc", "heititc", "stheititc"], family: "微軟正黑體", system: ["Microsoft JhengHei", "微軟正黑體", "PingFang TC", "Heiti TC"], download: [{ family: "Noto Sans TC", exact: false }] },
  { keys: ["simsun", "nsimsun", "宋体", "stsong", "songtisc"], family: "宋體", system: ["SimSun", "Songti SC"], download: [{ family: "Noto Serif SC", exact: false }] },
  { keys: ["simhei", "microsoftyahei", "微软雅黑", "黑体", "pingfangsc"], family: "微軟雅黑", system: ["Microsoft YaHei", "SimHei", "PingFang SC"], download: [{ family: "Noto Sans SC", exact: false }] },
  { keys: ["msgothic", "mspgothic", "meiryo", "yugothic", "hiraginosans"], family: "MS Gothic", system: ["MS Gothic", "Meiryo", "Yu Gothic", "Hiragino Sans"], download: [{ family: "Noto Sans JP", exact: false }] },
  { keys: ["msmincho", "mspmincho", "yumincho", "hiraginomincho"], family: "MS Mincho", system: ["MS Mincho", "Yu Mincho", "Hiragino Mincho ProN"], download: [{ family: "Noto Serif JP", exact: false }] },
];

const WEIGHTS: Array<[RegExp, number]> = [
  [/(hairline|thin)/i, 100],
  [/(extra|ultra)light/i, 200],
  [/light/i, 300],
  [/(semi|demi)bold/i, 600],
  [/(extra|ultra)bold/i, 800],
  [/(black|heavy)/i, 900],
  [/medium/i, 500],
  [/bold/i, 700],
  [/w([1-9])\b/i, 0],
];

/** 去除子集前綴（ABCDEF+）與 PDF 名稱中的 #xx 編碼；Big5／GBK／Shift_JIS 編碼的中日文名稱會轉回正確文字。 */
export function cleanFontName(name: string): string {
  let result = name.replace(/^[A-Z]{6}\+/, "");
  if (/#[0-9a-f]{2}/i.test(result)) result = result.replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return decodeLegacyName(result).trim();
}

const LEGACY_ENCODINGS = ["utf-8", "big5", "gbk", "shift_jis", "euc-kr"];
/** 字型名稱常用字：同一串位元組可同時以 Big5 與 GBK 解碼時，用來判斷哪一個才對。 */
const COMMON_NAME_CHARS = new Set([..."新細细明體体標标楷宋黑圓圆仿隸隶魏書书行粗中正微軟软雅準准華华康文鼎方漢汉儀仪字型形極极特超综綜藝艺海報报娃娃少女古印篆隸金梅王蒙納纳儷俪雅正黑繁簡简ゴシック明朝丸"]);

/** PDF 名稱是位元組字串；非 ASCII 時依序嘗試常見的中日韓編碼，挑出最像字型名稱的結果。 */
export function decodeLegacyName(text: string): string {
  if (!/[\x80-\xff]/.test(text) || /[^\x00-\xff]/.test(text)) return text;
  const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
  let best: { value: string; score: number } | null = null;
  for (const [order, encoding] of LEGACY_ENCODINGS.entries()) {
    let decoded: string;
    try {
      decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    if (!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(decoded) || /[\u0000-\u001f\ufffd]/.test(decoded)) continue;
    // UTF-8 能完整解碼時幾乎一定正確；其他編碼依常用字數量評分，同分時依序優先
    const score = encoding === "utf-8" ? 1000 : [...decoded].filter((c) => COMMON_NAME_CHARS.has(c)).length * 10 - order;
    if (!best || score > best.score) best = { value: decoded, score };
  }
  return best?.value ?? text;
}

function normalizeKey(text: string): string {
  return text.toLowerCase().replace(/[\s_\-,.]/g, "");
}

/** `TimesNewRomanPS-BoldItalicMT` → 字族 Times New Roman、字重 700、斜體。 */
export function parseFontName(rawName: string, bold = false, italic = false): { family: string; weight: number; italic: boolean; key: string } {
  const name = cleanFontName(rawName);
  const [basePart, ...styleParts] = name.split(/[-,]/);
  let style = styleParts.join(" ");
  let base = basePart;
  // 部分字型把樣式直接接在名稱後面（例如 ArialBold、HelveticaNeueLight）
  const inline = base.match(/^(.*?)(Bold|Italic|Oblique|Light|Medium|Black|Heavy|Thin|Semibold|Regular)+$/);
  if (!styleParts.length && inline && inline[1].length >= 3) {
    style = base.slice(inline[1].length);
    base = inline[1];
  }
  let weight = bold ? 700 : 400;
  for (const [pattern, value] of WEIGHTS) {
    const match = style.match(pattern);
    if (match) {
      weight = value || Math.min(900, Math.max(100, Number(match[1]) * 100));
      break;
    }
  }
  const isItalic = italic || /italic|oblique/i.test(style);
  const cleaned = base.replace(/(PSMT|PS|MT|Std|Pro|OT)$/g, "");
  const family = /[⺀-鿿]/.test(cleaned)
    ? cleaned
    : cleaned
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/\s+/g, " ")
        .trim();
  return { family, weight, italic: isItalic, key: normalizeKey(base) };
}

export type FontKind = "sans" | "serif" | "mono" | "kai";
export type FontScript = "latin" | "tc" | "sc" | "jp" | "kr";

/** 各風格與文字的通用字型：Windows 與 macOS 內建字型，以及可下載的開源字型。 */
const GENERIC: Record<FontScript, Record<FontKind, { system: string[]; download: string[] }>> = {
  latin: {
    sans: { system: ["Arial", "Helvetica", "Liberation Sans"], download: ["Arimo"] },
    serif: { system: ["Times New Roman", "Times", "Liberation Serif"], download: ["Tinos"] },
    mono: { system: ["Courier New", "Courier", "Menlo", "Consolas"], download: ["Cousine"] },
    kai: { system: ["Times New Roman", "Times"], download: ["Tinos"] },
  },
  tc: {
    sans: { system: ["Microsoft JhengHei", "PingFang TC", "Heiti TC", "Noto Sans CJK TC", "Noto Sans TC"], download: ["Noto Sans TC"] },
    serif: { system: ["PMingLiU", "MingLiU", "Songti TC", "LiSong Pro", "Noto Serif CJK TC", "Noto Serif TC"], download: ["Noto Serif TC"] },
    mono: { system: ["MingLiU", "Microsoft JhengHei", "PingFang TC"], download: ["Noto Sans TC"] },
    kai: { system: ["DFKai-SB", "BiauKai", "Kaiti TC", "LXGW WenKai TC"], download: ["LXGW WenKai TC"] },
  },
  sc: {
    sans: { system: ["Microsoft YaHei", "SimHei", "PingFang SC", "Heiti SC", "Noto Sans CJK SC"], download: ["Noto Sans SC"] },
    serif: { system: ["SimSun", "Songti SC", "Noto Serif CJK SC"], download: ["Noto Serif SC"] },
    mono: { system: ["SimSun", "Microsoft YaHei", "PingFang SC"], download: ["Noto Sans SC"] },
    kai: { system: ["KaiTi", "Kaiti SC", "STKaiti"], download: ["LXGW WenKai TC"] },
  },
  jp: {
    sans: { system: ["Yu Gothic", "Meiryo", "MS Gothic", "Hiragino Sans", "Noto Sans CJK JP"], download: ["Noto Sans JP"] },
    serif: { system: ["Yu Mincho", "MS Mincho", "Hiragino Mincho ProN", "Noto Serif CJK JP"], download: ["Noto Serif JP"] },
    mono: { system: ["MS Gothic", "Osaka-Mono"], download: ["Noto Sans JP"] },
    kai: { system: ["Yu Mincho", "Hiragino Mincho ProN"], download: ["Noto Serif JP"] },
  },
  kr: {
    sans: { system: ["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR"], download: ["Noto Sans KR"] },
    serif: { system: ["Batang", "AppleMyungjo", "Noto Serif CJK KR"], download: ["Noto Serif KR"] },
    mono: { system: ["GulimChe", "Malgun Gothic"], download: ["Noto Sans KR"] },
    kai: { system: ["Batang", "AppleMyungjo"], download: ["Noto Serif KR"] },
  },
};

/** 由文字內容判斷語系（沒有中日韓文字時為 latin，漢字預設為繁體中文）。 */
export function scriptOf(text: string): FontScript {
  if (/[\u3040-\u30ff]/.test(text)) return "jp";
  if (/[\uac00-\ud7af]/.test(text)) return "kr";
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(text)) return "tc";
  return "latin";
}

/** 由字型名稱中的關鍵字判斷風格（例如華康明體、文鼎楷書、蒙納黑體）。 */
export function kindFromName(name: string): FontKind | null {
  const key = normalizeKey(name);
  if (/kai|楷|biau/.test(key)) return "kai";
  if (/mono|courier|consol|code/.test(key)) return "mono";
  if (/ming|song|明|宋|mincho|serif|batang|myungjo|roman|times|garamond|georgia|仿/.test(key)) return "serif";
  if (/hei|黑|gothic|yuan|圓|圆|sans|gulim|dotum|jhenghei|yahei|arial|helvetica|pingfang|roboto|lato|inter|montserrat|segoe|calibri|verdana|tahoma|ubuntu|arimo|futura|frutiger|myriad/.test(key)) return "sans";
  return null;
}

/** 由字型名稱判斷語系（名稱帶有 TC、SC、JP、GB、Big5 等）；`key` 為去除樣式後的名稱。 */
function scriptFromName(key: string, name: string): FontScript | null {
  if (/(tc|hk|big5|b5|cns)$|繁/.test(key)) return "tc";
  if (/(sc|gb|gbk|gb2312)$|简/.test(key)) return "sc";
  if (/(jp|jis|pron?|std)$/.test(key) && /hiragino|kozuka|mincho|gothic/.test(key)) return "jp";
  if (/(jp|jis)$|msmincho|msgothic|meiryo|yugothic|yumincho|ゴシック|明朝/.test(key)) return "jp";
  if (/(kr|ks)$|gulim|batang|dotum|malgun|myungjo|nanum/.test(key)) return "kr";
  if (/[\u3040-\u30ff]/.test(name)) return "jp";
  if (/[\u3400-\u9fff]/.test(name)) return /[简体]/.test(name) ? "sc" : "tc";
  return null;
}

function genericCandidates(kind: FontKind, script: FontScript) {
  const entry = GENERIC[script][kind];
  return { system: entry.system.map((family) => ({ family, exact: false })), downloads: entry.download.map((family) => ({ family, exact: false })) };
}

function dedupe(list: FontCandidate[]): FontCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = normalizeKey(c.family);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface FontHints {
  serif?: boolean;
  mono?: boolean;
  /** 這一行原本的文字，用來判斷語系 */
  text?: string;
}

/**
 * 依原字型名稱產生尋找／下載字型的候選清單。
 * 依序為：原字型本身 → 已知對應（商用字型的相容字型）→ 依名稱關鍵字與文字語系推測的相近字型。
 */
export function fontRequestFor(rawName: string, bold = false, italic = false, hints: FontHints = {}): FontRequest {
  const parsed = parseFontName(rawName, bold, italic);
  const originalName = cleanFontName(rawName);
  const key = parsed.key;
  const textScript = scriptOf(hints.text ?? "");
  let nameScript = scriptFromName(key, originalName);
  const kind: FontKind = kindFromName(originalName) ?? (hints.mono ? "mono" : hints.serif ? "serif" : "sans");

  let family = parsed.family;
  let system: FontCandidate[] = [{ family: originalName, exact: true }];
  let downloads: FontCandidate[] = [];
  let weight = parsed.weight;
  let isItalic = parsed.italic;

  const known = KNOWN.find((k) => k.keys.some((candidate) => key === candidate || (candidate.length >= 5 && key.startsWith(candidate))));
  const cjk = key.match(/^(?:noto|sourcehan)(sans|serif)(?:cjk)?(tc|sc|jp|kr|hk)/);
  if (known) {
    family = known.family;
    nameScript ??= scriptFromName(normalizeKey(known.family), known.family) ?? (/gothic|mincho/i.test(known.family) ? "jp" : null);
    system.push(...known.system.map((f, i) => ({ family: f, exact: i === 0 })));
    downloads = [...known.download];
  } else if (cjk) {
    // 思源／Noto CJK 系列對應 Google Fonts 上的 Noto Sans TC 等字族
    family = `Noto ${cjk[1] === "sans" ? "Sans" : "Serif"} ${cjk[2] === "hk" ? "HK" : cjk[2].toUpperCase()}`;
    system.push({ family, exact: true });
    downloads = [{ family, exact: true }];
    isItalic = false;
  } else {
    system.push({ family: parsed.family, exact: true });
    if (parsed.family.length >= 3 && /^[\x20-\x7e]+$/.test(parsed.family)) downloads.push({ family: parsed.family, exact: true });
  }

  const script = nameScript ?? textScript;
  // 找不到同名字型時，改用風格與語系相同的常見字型
  const generic = genericCandidates(kind, script);
  system = dedupe([...system, ...generic.system]);
  downloads = dedupe([...downloads, ...generic.downloads]);

  // 英文字型遇到中文時的備援：依風格挑選相近的中文字型
  const cjkScript = textScript !== "latin" ? textScript : nameScript && nameScript !== "latin" ? nameScript : "tc";
  const fallback = script === "latin" ? genericCandidates(kind === "mono" ? "sans" : kind, cjkScript) : null;
  return { originalName, family, weight, italic: isItalic, system, downloads, fallback };
}

/** OCR 辨識出的文字沒有原字型可用（字形在掃描影像中），依語系使用常見的無襯線字型。 */
export function ocrFontRequest(text: string, bold = false): FontRequest {
  const script = scriptOf(text);
  const generic = genericCandidates("sans", script);
  return {
    originalName: "掃描影像中的文字（OCR）",
    family: generic.system[0].family,
    weight: bold ? 700 : 400,
    italic: false,
    system: generic.system,
    downloads: generic.downloads,
    fallback: script === "latin" ? genericCandidates("sans", "tc") : null,
  };
}

/** 使用者手動選擇的字型。 */
export function chosenFontRequest(family: string, weight: number, italic: boolean, downloadable: boolean): FontRequest {
  const candidate = [{ family, exact: true }];
  return {
    originalName: family,
    family,
    weight,
    italic,
    system: downloadable ? [] : candidate,
    downloads: downloadable ? candidate : [],
    fallback: scriptOf(family) === "latin" && !/tc|sc|jp|kr|cjk|hei|ming|song|kai/i.test(family) ? genericCandidates("sans", "tc") : null,
  };
}

/** 原文是否可靠（無 U+FFFD、私用區或控制字元）；不可靠時通常是 PDF 缺少字元對照表。 */
export function isReliableText(text: string): boolean {
  return !/[�-\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

/** Google Fonts CSS API 網址（不帶瀏覽器 User-Agent 時回傳完整 TTF）。 */
export function googleFontsCssUrl(family: string, weight: number, italic: boolean): string {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  return italic
    ? `https://fonts.googleapis.com/css2?family=${name}:ital,wght@1,${weight}`
    : `https://fonts.googleapis.com/css2?family=${name}:wght@${weight}`;
}

/** 從 Google Fonts CSS 取出字型檔網址。 */
export function fontUrlFromCss(css: string): string | null {
  return css.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/)?.[1] ?? null;
}
