import { describe, expect, it } from 'vitest'
import { evaluate, FormulaError, referencedIds } from './formula'

describe('evaluate', () => {
  it('四則運算與優先序', () => {
    expect(evaluate('1 + 2 * 3', {})).toBe(7)
    expect(evaluate('(1 + 2) * 3', {})).toBe(9)
    expect(evaluate('10 / 4', {})).toBe(2.5)
  })
  it('一元負號', () => {
    expect(evaluate('-5 + 3', {})).toBe(-2)
    expect(evaluate('2 * -3', {})).toBe(-6)
  })
  it('引用指標', () => {
    expect(evaluate('currentAssets / currentLiabilities * 100', { currentAssets: 300, currentLiabilities: 200 })).toBe(150)
  })
  it('函式', () => {
    expect(evaluate('MAX(3, 7)', {})).toBe(7)
    expect(evaluate('MIN(3, 7)', {})).toBe(3)
    expect(evaluate('ABS(0 - 8)', {})).toBe(8)
    expect(evaluate('IF(1, 10, 20)', {})).toBe(10)
    expect(evaluate('IF(0, 10, 20)', {})).toBe(20)
  })
  it('缺少資料回傳 null（而非 0，避免誤判為通過）', () => {
    expect(evaluate('equity * 0.5', {})).toBeNull()
    expect(evaluate('a + b', { a: 1 })).toBeNull()
  })
  it('除以零回傳 null 而非 Infinity', () => {
    expect(evaluate('netIncome / cfo', { netIncome: 100, cfo: 0 })).toBeNull()
  })
  it('政策參數可用於門檻算式', () => {
    expect(evaluate('policyEndorsementPct * 0.8', { policyEndorsementPct: 50 })).toBe(40)
  })
  it('拒絕不支援的字元（不使用 eval）', () => {
    expect(() => evaluate('process.exit(1)%', {})).toThrow(FormulaError)
    expect(() => evaluate('1 ; 2', {})).toThrow(FormulaError)
  })
  it('括號不對稱會報錯', () => {
    expect(() => evaluate('(1 + 2', {})).toThrow(FormulaError)
  })
})

describe('referencedIds', () => {
  it('取出引用的指標、排除函式名', () => {
    expect(referencedIds('MAX(ar, inventory) / revenue').sort()).toEqual(['ar', 'inventory', 'revenue'])
  })
})
