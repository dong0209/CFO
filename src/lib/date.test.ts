import { describe, expect, it } from 'vitest'
import { addDays, addMonths, adjustToBusinessDay, endOfMonth, isBusinessDay, subtractBusinessDays } from './date'

describe('addMonths', () => {
  it('年報：會計年度終了後 3 個月 → 3/31', () => {
    expect(addMonths('2026-12-31', 3)).toBe('2027-03-31')
  })
  it('營所稅：年度終了後 5 個月 → 5/31', () => {
    expect(addMonths('2026-12-31', 5)).toBe('2027-05-31')
  })
  it('股東常會：年度終了後 6 個月 → 6/30（收斂至月底）', () => {
    expect(addMonths('2026-12-31', 6)).toBe('2027-06-30')
  })
  it('月營收：期末後 1 個月的 10 日', () => {
    expect(addMonths('2026-01-31', 1, 10)).toBe('2026-02-10')
  })
  it('閏年二月收斂', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
  })
})

describe('addDays', () => {
  it('季報：Q1 期末 +45 日 → 5/15', () => {
    expect(addDays('2026-03-31', 45)).toBe('2026-05-15')
  })
  it('Q3 期末 +45 日 → 11/14', () => {
    expect(addDays('2026-09-30', 45)).toBe('2026-11-14')
  })
})

describe('營業日調整', () => {
  it('週末不是營業日', () => {
    expect(isBusinessDay('2026-05-16')).toBe(false) // 週六
    expect(isBusinessDay('2026-05-15')).toBe(true)  // 週五
  })
  it('國定假日不是營業日', () => {
    expect(isBusinessDay('2026-10-10')).toBe(false)
  })
  it('NEXT 會順延到下一個營業日', () => {
    expect(adjustToBusinessDay('2026-05-16', 'NEXT')).toBe('2026-05-18')
  })
  it('PREV 會提前到前一個營業日', () => {
    expect(adjustToBusinessDay('2026-05-16', 'PREV')).toBe('2026-05-15')
  })
  it('NONE 不調整', () => {
    expect(adjustToBusinessDay('2026-05-16', 'NONE')).toBe('2026-05-16')
  })
})

describe('subtractBusinessDays', () => {
  it('跳過週末計算開工日', () => {
    // 2026-05-15 為週五，往前 5 個營業日 → 5/8（週五）
    expect(subtractBusinessDays('2026-05-15', 5)).toBe('2026-05-08')
  })
})

describe('endOfMonth', () => {
  it('取得月底日期', () => {
    expect(endOfMonth(2026, 2)).toBe('2026-02-28')
    expect(endOfMonth(2028, 2)).toBe('2028-02-29')
    expect(endOfMonth(2026, 11)).toBe('2026-11-30')
  })
})
