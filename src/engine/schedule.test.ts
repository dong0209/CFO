import { describe, expect, it } from 'vitest'
import { computeStatutoryDue, generateTasks, mergeTasks, periodsFor } from './schedule'
import { OBLIGATION_MAP, RECURRING_OBLIGATIONS } from '../domain/obligations'
import type { CompanyProfile, Obligation } from '../domain/types'

const profile: CompanyProfile = {
  name: '測試股份有限公司',
  taxId: '00000000',
  stockCode: '9999',
  tier: 'LISTED',
  fiscalYearEndMonth: 12,
  paidInCapital: 5_000_000_000,
  hasAuditCommittee: true,
  consolidated: true,
  industry: '電子零組件',
  policyLimits: { endorsementToEquityPct: 50, lendingToEquityPct: 40, singleEndorsementPct: 20 },
}

const dueOf = (obligationId: string, periodLabel: string) => {
  const o = OBLIGATION_MAP[obligationId]
  const p = periodsFor(o.period, 2026, 12).find((x) => x.label === periodLabel)!
  return computeStatutoryDue(o, p)
}

describe('periodsFor', () => {
  it('曆年制月份期間共 12 期', () => {
    const ps = periodsFor('MONTH', 2026)
    expect(ps).toHaveLength(12)
    expect(ps[0]).toMatchObject({ label: '2026-01', start: '2026-01-01', end: '2026-01-31' })
    expect(ps[11]).toMatchObject({ label: '2026-12', start: '2026-12-01', end: '2026-12-31' })
  })
  it('雙月期共 6 期，第 1 期為 1-2 月', () => {
    const ps = periodsFor('BIMONTH', 2026)
    expect(ps).toHaveLength(6)
    expect(ps[0]).toMatchObject({ start: '2026-01-01', end: '2026-02-28' })
    expect(ps[5]).toMatchObject({ start: '2026-11-01', end: '2026-12-31' })
  })
  it('季度期間', () => {
    const ps = periodsFor('QUARTER', 2026)
    expect(ps.map((p) => p.end)).toEqual(['2026-03-31', '2026-06-30', '2026-09-30', '2026-12-31'])
  })
  it('年度期間', () => {
    expect(periodsFor('YEAR', 2026)).toEqual([{ label: '2026', start: '2026-01-01', end: '2026-12-31' }])
  })
  it('非曆年制（6 月結）會計年度切法正確', () => {
    const ps = periodsFor('QUARTER', 2026, 6)
    expect(ps[0]).toMatchObject({ start: '2025-07-01', end: '2025-09-30' })
    expect(ps[3]).toMatchObject({ start: '2026-04-01', end: '2026-06-30' })
  })
  it('事件驅動義務不展開期間', () => {
    expect(periodsFor('EVENT', 2026)).toEqual([])
  })
})

describe('法定到期日推算', () => {
  it('月營收：次月 10 日', () => {
    expect(dueOf('RPT-MONTHLY-REVENUE', '2026-01')).toBe('2026-02-10')
    expect(dueOf('RPT-MONTHLY-REVENUE', '2026-12')).toBe('2027-01-10')
  })
  it('季報：季後 45 日', () => {
    expect(dueOf('RPT-Q-FS', '2026Q1')).toBe('2026-05-15')
    expect(dueOf('RPT-Q-FS', '2026Q2')).toBe('2026-08-14')
    expect(dueOf('RPT-Q-FS', '2026Q3')).toBe('2026-11-14')
  })
  it('年度財報：年度終了後 3 個月', () => {
    expect(dueOf('RPT-ANNUAL-FS', '2026')).toBe('2027-03-31')
  })
  it('內控聲明書：年度終了後 3 個月', () => {
    expect(dueOf('IC-STATEMENT', '2026')).toBe('2027-03-31')
  })
  it('稽核計畫執行情形：年度終了後 2 個月', () => {
    expect(dueOf('IC-AUDIT-PLAN-FILING', '2026')).toBe('2027-02-28')
  })
  it('內控缺失改善情形：年度終了後 5 個月', () => {
    expect(dueOf('IC-DEFICIENCY-FILING', '2026')).toBe('2027-05-31')
  })
  it('營所稅結算申報：年度終了後 5 個月', () => {
    expect(dueOf('TAX-CIT-ANNUAL', '2026')).toBe('2027-05-31')
  })
  it('營所稅暫繳：當年度 9/30（期間內固定日）', () => {
    expect(dueOf('TAX-CIT-PROVISIONAL', '2026')).toBe('2026-09-30')
  })
  it('營業稅：雙月期次期開始 15 日內', () => {
    const ps = periodsFor('BIMONTH', 2026)
    const o = OBLIGATION_MAP['TAX-VAT']
    expect(ps.map((p) => computeStatutoryDue(o, p))).toEqual([
      '2026-03-15', '2026-05-15', '2026-07-15', '2026-09-15', '2026-11-15', '2027-01-15',
    ])
  })
  it('股東常會：年度終了後 6 個月', () => {
    expect(dueOf('CMP-AGM', '2026')).toBe('2027-06-30')
  })
  it('扣繳憑單申報：次年 1/31', () => {
    expect(dueOf('TAX-WHT-ANNUAL', '2026')).toBe('2027-01-31')
  })
  it('永續報告書：年度終了後 8 個月', () => {
    expect(dueOf('ESG-REPORT', '2026')).toBe('2027-08-31')
  })
})

describe('generateTasks', () => {
  const tasks = generateTasks({ fiscalYear: 2026, profile, obligations: RECURRING_OBLIGATIONS })

  it('產生的任務依到期日排序', () => {
    const dues = tasks.map((t) => t.dueDate)
    expect([...dues].sort()).toEqual(dues)
  })
  it('每月義務產生 12 筆', () => {
    expect(tasks.filter((t) => t.obligationId === 'RPT-MONTHLY-REVENUE')).toHaveLength(12)
  })
  it('法定到期日遇假日順延至次一營業日', () => {
    // 2026-01 月營收法定期限 2/10（週二，非假日）→ 不調整
    const jan = tasks.find((t) => t.id === 'RPT-MONTHLY-REVENUE::2026-01')!
    expect(jan.statutoryDue).toBe('2026-02-10')
    expect(jan.dueDate).toBe('2026-02-10')
    // 2026-04 月營收法定期限 5/10（週日）→ 順延至 5/11
    const apr = tasks.find((t) => t.id === 'RPT-MONTHLY-REVENUE::2026-04')!
    expect(apr.statutoryDue).toBe('2026-05-10')
    expect(apr.dueDate).toBe('2026-05-11')
  })
  it('開工日早於到期日', () => {
    for (const t of tasks) expect(t.startDate <= t.dueDate).toBe(true)
  })
  it('檢核項目數與義務主檔一致', () => {
    const t = tasks.find((t) => t.obligationId === 'RPT-Q-FS')!
    expect(t.checklist).toHaveLength(OBLIGATION_MAP['RPT-Q-FS'].checklist.length)
    expect(t.checklist.every((c) => !c.checked)).toBe(true)
  })
  it('依板別過濾：僅公開發行公司不產生法說會與永續報告書任務', () => {
    const publicOnly = generateTasks({
      fiscalYear: 2026,
      profile: { ...profile, tier: 'PUBLIC' },
      obligations: RECURRING_OBLIGATIONS,
    })
    expect(publicOnly.some((t) => t.obligationId === 'IR-EARNINGS-CALL')).toBe(false)
    expect(publicOnly.some((t) => t.obligationId === 'ESG-REPORT')).toBe(false)
    expect(publicOnly.some((t) => t.obligationId === 'RPT-MONTHLY-REVENUE')).toBe(true)
  })
})

describe('mergeTasks', () => {
  it('重新展開時保留使用者填寫的狀態', () => {
    const gen = generateTasks({ fiscalYear: 2026, profile, obligations: RECURRING_OBLIGATIONS })
    const edited = gen.map((t) =>
      t.id === 'RPT-MONTHLY-REVENUE::2026-01'
        ? { ...t, status: 'DONE' as const, completedAt: '2026-02-09', note: '已申報', checklist: t.checklist.map((c, i) => (i === 0 ? { ...c, checked: true } : c)) }
        : t,
    )
    const merged = mergeTasks(edited, gen, RECURRING_OBLIGATIONS)
    const t = merged.find((x) => x.id === 'RPT-MONTHLY-REVENUE::2026-01')!
    expect(t.status).toBe('DONE')
    expect(t.completedAt).toBe('2026-02-09')
    expect(t.checklist[0].checked).toBe(true)
  })

  it('主檔新增檢核項目時，既有任務會補上新項目且保留舊勾選', () => {
    const gen = generateTasks({ fiscalYear: 2026, profile, obligations: RECURRING_OBLIGATIONS })
    const edited = gen.map((t) =>
      t.obligationId === 'RPT-MONTHLY-REVENUE' ? { ...t, checklist: t.checklist.map((c) => ({ ...c, checked: true })) } : t,
    )
    const base = OBLIGATION_MAP['RPT-MONTHLY-REVENUE']
    const extended: Obligation = {
      ...base,
      checklist: [...base.checklist, { id: 'NEW-01', text: '新增檢核', type: 'CONFIRM', required: true }],
    }
    const obligations = RECURRING_OBLIGATIONS.map((o) => (o.id === base.id ? extended : o))
    const merged = mergeTasks(edited, generateTasks({ fiscalYear: 2026, profile, obligations }), obligations)
    const t = merged.find((x) => x.id === 'RPT-MONTHLY-REVENUE::2026-01')!
    expect(t.checklist).toHaveLength(base.checklist.length + 1)
    expect(t.checklist.at(-1)).toEqual({ defId: 'NEW-01', checked: false })
    expect(t.checklist[0].checked).toBe(true)
  })
})

describe('主檔完整性', () => {
  it('義務 id 不重複', () => {
    const ids = RECURRING_OBLIGATIONS.map((o) => o.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('每個義務都有法源、負責人與至少一項檢核', () => {
    for (const o of RECURRING_OBLIGATIONS) {
      expect(o.legalBasis.length, o.id).toBeGreaterThan(0)
      expect(o.checklist.length, o.id).toBeGreaterThan(0)
      expect(o.owner, o.id).toBeTruthy()
    }
  })
  it('檢核項目 id 全域唯一', () => {
    const ids = RECURRING_OBLIGATIONS.flatMap((o) => o.checklist.map((c) => c.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
