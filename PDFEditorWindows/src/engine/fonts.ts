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
}

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

/** 去除子集前綴（ABCDEF+）與 PDF 名稱中的 #xx 編碼。 */
export function cleanFontName(name: string): string {
  let result = name.replace(/^[A-Z]{6}\+/, "");
  if (/#[0-9a-f]{2}/i.test(result)) {
    try {
      const bytes = result.replace(/#([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
      result = new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0)));
    } catch {
      // 保留原字串
    }
  }
  return result.trim();
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

/** 依原字型名稱產生尋找／下載字型的候選清單。 */
export function fontRequestFor(rawName: string, bold = false, italic = false): FontRequest {
  const parsed = parseFontName(rawName, bold, italic);
  const originalName = cleanFontName(rawName);
  const key = parsed.key;
  const known = KNOWN.find((k) => k.keys.some((candidate) => key === candidate || (candidate.length >= 5 && key.startsWith(candidate))));
  if (known) {
    return {
      originalName,
      family: known.family,
      weight: parsed.weight,
      italic: parsed.italic,
      system: [{ family: originalName, exact: true }, ...known.system.map((family, i) => ({ family, exact: i === 0 }))],
      downloads: known.download,
    };
  }

  // 思源／Noto CJK 系列對應 Google Fonts 上的 Noto Sans TC 等字族
  const cjk = key.match(/^(?:noto|sourcehan)(sans|serif)(?:cjk)?(tc|sc|jp|kr|hk)/);
  if (cjk) {
    const family = `Noto ${cjk[1] === "sans" ? "Sans" : "Serif"} ${cjk[2].toUpperCase()}`;
    return {
      originalName,
      family,
      weight: parsed.weight,
      italic: false,
      system: [{ family: originalName, exact: true }, { family, exact: true }],
      downloads: [{ family, exact: true }],
    };
  }

  return {
    originalName,
    family: parsed.family,
    weight: parsed.weight,
    italic: parsed.italic,
    system: [{ family: originalName, exact: true }, { family: parsed.family, exact: true }],
    downloads: parsed.family.length >= 3 && /^[\x20-\x7e]+$/.test(parsed.family) ? [{ family: parsed.family, exact: true }] : [],
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
