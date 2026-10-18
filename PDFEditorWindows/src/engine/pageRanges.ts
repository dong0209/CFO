/**
 * 解析使用者輸入的頁碼範圍，例如 `1-3, 5, 8-`。
 * 輸入以 1 起算，回傳以 0 起算的 [起, 迄]；格式錯誤或超出頁數時回傳 null。
 */
export function parsePageRanges(text: string, pageCount: number): Array<[number, number]> | null {
  const normalized = text
    .replace(/[，、]/g, ",")
    .replace(/[～~–—]/g, "-");
  const parts = normalized.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || pageCount <= 0) return null;

  const ranges: Array<[number, number]> = [];
  for (const part of parts) {
    if (part.includes("-")) {
      const bounds = part.split("-").map((b) => b.trim());
      if (bounds.length !== 2) return null;
      const lower = bounds[0] === "" ? 1 : toInt(bounds[0]);
      const upper = bounds[1] === "" ? pageCount : toInt(bounds[1]);
      if (lower === null || upper === null || lower < 1 || upper > pageCount || lower > upper) return null;
      ranges.push([lower - 1, upper - 1]);
    } else {
      const page = toInt(part);
      if (page === null || page < 1 || page > pageCount) return null;
      ranges.push([page - 1, page - 1]);
    }
  }
  return ranges;
}

function toInt(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** 將範圍展開為不重複、排序過的頁面索引。 */
export function indicesFromRanges(ranges: Array<[number, number]>): number[] {
  const set = new Set<number>();
  for (const [a, b] of ranges) for (let i = a; i <= b; i++) set.add(i);
  return [...set].sort((x, y) => x - y);
}

/** 將 `source` 中的項目搬到 `destination`（插入位置以搬移前的索引計算）。 */
export function moveItems<T>(items: T[], source: number[], destination: number): T[] {
  const sourceSet = new Set(source);
  const moving = [...sourceSet].sort((a, b) => a - b).map((i) => items[i]);
  const remaining = items.filter((_, i) => !sourceSet.has(i));
  const before = [...sourceSet].filter((i) => i < destination).length;
  const insertAt = Math.max(0, Math.min(destination - before, remaining.length));
  remaining.splice(insertAt, 0, ...moving);
  return remaining;
}

export const PAGE_NUMBER_PRESETS = ["{n}", "第 {n} 頁", "{n} / {total}", "第 {n} 頁，共 {total} 頁", "Page {n} of {total}"];

/** 頁碼樣板：`{n}` 為頁碼、`{total}` 為總頁數。 */
export function renderPageNumber(template: string, page: number, total: number): string {
  return template.replaceAll("{n}", String(page)).replaceAll("{total}", String(total));
}

export function chunk(pageCount: number, perFile: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  if (perFile <= 0) return result;
  for (let start = 0; start < pageCount; start += perFile) {
    result.push([start, Math.min(start + perFile, pageCount) - 1]);
  }
  return result;
}
