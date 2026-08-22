/**
 * 期限推算工具
 * ------------------------------------------------------------------
 * 台灣公開發行公司的申報期限多以「期間終了後 N 日 / N 個月」表達，
 * 且遇例假日原則上順延至次一營業日（內部作業期限則多提前至前一營業日）。
 * 本模組提供純函式，方便單元測試。
 */

export type ISODate = string // YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, '0')

export function toISO(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

export function parseISO(s: ISODate): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate()
}

export function addDays(s: ISODate, n: number): ISODate {
  const d = parseISO(s)
  d.setUTCDate(d.getUTCDate() + n)
  return toISO(d)
}

/**
 * 加月份。日期超過目標月份天數時，收斂至該月最後一日
 * （例：12-31 加 3 個月 → 03-31；01-31 加 1 個月 → 02-28/29）。
 */
export function addMonths(s: ISODate, n: number, forceDay?: number): ISODate {
  const d = parseISO(s)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1 + n
  const targetYear = y + Math.floor((m - 1) / 12)
  const targetMonth = ((m - 1) % 12 + 12) % 12 + 1
  const dim = daysInMonth(targetYear, targetMonth)
  const day = Math.min(forceDay ?? d.getUTCDate(), dim)
  return `${targetYear}-${pad(targetMonth)}-${pad(day)}`
}

export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(a).getTime() - parseISO(b).getTime()) / 86_400_000)
}

export function endOfMonth(year: number, month1: number): ISODate {
  return `${year}-${pad(month1)}-${pad(daysInMonth(year, month1))}`
}

export function weekday(s: ISODate): number {
  return parseISO(s).getUTCDay() // 0=日
}

/**
 * 國定假日表（不含週休二日）。
 * ⚠ 需每年依行政院人事行政總處公告更新，於「設定 → 假日維護」可調整。
 */
export const HOLIDAYS: Record<string, string> = {
  '2026-01-01': '開國紀念日',
  '2026-02-14': '春節',
  '2026-02-16': '春節',
  '2026-02-17': '春節',
  '2026-02-18': '春節',
  '2026-02-19': '春節',
  '2026-02-20': '春節',
  '2026-02-27': '和平紀念日彈性放假',
  '2026-02-28': '和平紀念日',
  '2026-04-03': '兒童節',
  '2026-04-04': '兒童節/清明節',
  '2026-04-06': '清明節補假',
  '2026-05-01': '勞動節',
  '2026-06-19': '端午節',
  '2026-09-25': '中秋節',
  '2026-10-09': '國慶日彈性放假',
  '2026-10-10': '國慶日',
  '2027-01-01': '開國紀念日',
  '2027-02-05': '春節',
  '2027-02-08': '春節',
  '2027-02-09': '春節',
  '2027-02-26': '和平紀念日補假',
  '2027-02-28': '和平紀念日',
  '2027-04-02': '兒童節/清明節',
  '2027-04-05': '清明節補假',
  '2027-05-01': '勞動節',
  '2027-06-09': '端午節',
  '2027-09-15': '中秋節',
  '2027-10-08': '國慶日彈性放假',
  '2027-10-10': '國慶日',
}

export function isBusinessDay(s: ISODate, holidays: Record<string, string> = HOLIDAYS): boolean {
  const w = weekday(s)
  if (w === 0 || w === 6) return false
  return !holidays[s]
}

export type BusinessDayAdjust = 'NONE' | 'NEXT' | 'PREV'

/** 依調整規則將日期移至營業日。NEXT=順延（法定申報期限慣例），PREV=提前（內部期限） */
export function adjustToBusinessDay(
  s: ISODate,
  mode: BusinessDayAdjust,
  holidays: Record<string, string> = HOLIDAYS,
): ISODate {
  if (mode === 'NONE') return s
  let cur = s
  for (let i = 0; i < 30; i++) {
    if (isBusinessDay(cur, holidays)) return cur
    cur = addDays(cur, mode === 'NEXT' ? 1 : -1)
  }
  return cur
}

/** 往前推 n 個營業日（用於「提前開工日」與提醒） */
export function subtractBusinessDays(
  s: ISODate,
  n: number,
  holidays: Record<string, string> = HOLIDAYS,
): ISODate {
  let cur = s
  let left = n
  while (left > 0) {
    cur = addDays(cur, -1)
    if (isBusinessDay(cur, holidays)) left--
  }
  return cur
}

export function todayISO(): ISODate {
  return toISO(new Date())
}
