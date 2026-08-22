import {
  addDays,
  addMonths,
  adjustToBusinessDay,
  daysInMonth,
  endOfMonth,
  HOLIDAYS,
  parseISO,
  subtractBusinessDays,
  type ISODate,
} from '../lib/date'
import type { CompanyProfile, ListingTier, Obligation, PeriodKind, Task } from '../domain/types'

export interface PeriodInstance {
  label: string
  start: ISODate
  end: ISODate
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * 依會計年度切出各種期間。
 * 會計年度 Y 以 fyEndMonth 月底為結束日；多數台灣公開發行公司為曆年制（12）。
 */
export function periodsFor(kind: PeriodKind, fiscalYear: number, fyEndMonth = 12): PeriodInstance[] {
  if (kind === 'EVENT') return []
  const fyEnd = endOfMonth(fiscalYear, fyEndMonth)
  const fyStart = addDays(addMonths(fyEnd, -12), 1)
  const calendarFY = fyEndMonth === 12

  const span = { MONTH: 1, BIMONTH: 2, QUARTER: 3, HALF: 6, YEAR: 12 }[kind]
  const count = 12 / span
  const out: PeriodInstance[] = []

  for (let k = 0; k < count; k++) {
    const start = addMonths(fyStart, k * span)
    const startDate = parseISO(start)
    const lastMonthOffset = k * span + span - 1
    const lastMonthStart = addMonths(fyStart, lastMonthOffset)
    const lmd = parseISO(lastMonthStart)
    const end = endOfMonth(lmd.getUTCFullYear(), lmd.getUTCMonth() + 1)

    let label: string
    switch (kind) {
      case 'MONTH':
        label = `${startDate.getUTCFullYear()}-${pad2(startDate.getUTCMonth() + 1)}`
        break
      case 'BIMONTH':
        label = calendarFY
          ? `${fiscalYear} 年 ${startDate.getUTCMonth() + 1}-${lmd.getUTCMonth() + 1} 月期`
          : `FY${fiscalYear} 第 ${k + 1} 期`
        break
      case 'QUARTER':
        label = `${fiscalYear}Q${k + 1}`
        break
      case 'HALF':
        label = `${fiscalYear}H${k + 1}`
        break
      default:
        label = `${fiscalYear}`
    }
    out.push({ label, start, end })
  }
  return out
}

/** 依到期規則計算「法定/原始到期日」（尚未做營業日調整） */
export function computeStatutoryDue(o: Obligation, period: PeriodInstance): ISODate {
  switch (o.due.type) {
    case 'DAYS_AFTER':
      return addDays(period.end, o.due.days)
    case 'MONTHS_AFTER':
      return addMonths(period.end, o.due.months, o.due.day)
    case 'FIXED_IN_PERIOD': {
      const y0 = parseISO(period.start).getUTCFullYear()
      for (const y of [y0, y0 + 1]) {
        const d = `${y}-${pad2(o.due.month)}-${pad2(Math.min(o.due.day, daysInMonth(y, o.due.month)))}`
        if (d >= period.start && d <= period.end) return d
      }
      // 期間內找不到（例如非曆年制的邊界）→ 退回期末日
      return period.end
    }
  }
}

export function appliesTo(o: Obligation, tier: ListingTier): boolean {
  return o.tiers.length === 0 || o.tiers.includes(tier)
}

export interface GenerateOptions {
  fiscalYear: number
  profile: CompanyProfile
  holidays?: Record<string, string>
  obligations: Obligation[]
}

/** 展開為任務實例。已存在（使用者已編輯過）的任務由呼叫端合併，本函式僅產生乾淨的骨架。 */
export function generateTasks({ fiscalYear, profile, holidays = HOLIDAYS, obligations }: GenerateOptions): Task[] {
  const tasks: Task[] = []
  for (const o of obligations) {
    if (o.period === 'EVENT') continue
    if (!appliesTo(o, profile.tier)) continue

    for (const p of periodsFor(o.period, fiscalYear, profile.fiscalYearEndMonth)) {
      const statutoryDue = computeStatutoryDue(o, p)
      const dueDate = adjustToBusinessDay(statutoryDue, o.adjust, holidays)
      const startDate = subtractBusinessDays(dueDate, o.leadBusinessDays, holidays)
      tasks.push({
        id: `${o.id}::${p.label}`,
        obligationId: o.id,
        periodLabel: p.label,
        periodStart: p.start,
        periodEnd: p.end,
        statutoryDue,
        dueDate,
        startDate,
        status: 'NOT_STARTED',
        checklist: o.checklist.map((c) => ({ defId: c.id, checked: false })),
      })
    }
  }
  return tasks.sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
}
