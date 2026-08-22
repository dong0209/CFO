import { describe, expect, it } from 'vitest'
import { checkDirectorHolding, tierFor } from './directorHolding'

describe('股權成數級距', () => {
  it('依實收資本額落入正確級距', () => {
    expect(tierFor(2e8).directorPct).toBe(15)
    expect(tierFor(5e8).directorPct).toBe(10)
    expect(tierFor(15e8).directorPct).toBe(7.5)
    expect(tierFor(30e8).directorPct).toBe(5)
    expect(tierFor(50e8).directorPct).toBe(4)
    expect(tierFor(200e8).directorPct).toBe(3)
    expect(tierFor(600e8).directorPct).toBe(2)
    expect(tierFor(2000e8).directorPct).toBe(1)
  })
  it('級距邊界採「以上、未滿」', () => {
    expect(tierFor(3e8 - 1).directorPct).toBe(15)
    expect(tierFor(3e8).directorPct).toBe(10)
  })
})

describe('checkDirectorHolding', () => {
  const capital = 5_000_000_000 // 50 億 → 董事 4%、監察人 0.4%
  const parValue = 10
  const totalShares = capital / parValue // 5 億股

  it('未設審計委員會：董事與監察人分別檢核', () => {
    const r = checkDirectorHolding({
      paidInCapital: capital, parValue, hasAuditCommittee: false,
      directorShares: 0.05 * totalShares, supervisorShares: 0.005 * totalShares,
    })
    expect(r.lines).toHaveLength(2)
    expect(r.lines[0]).toMatchObject({ subject: '全體董事', requiredPct: 4, requiredShares: 20_000_000, pass: true })
    expect(r.lines[1]).toMatchObject({ subject: '全體監察人', requiredPct: 0.4, requiredShares: 2_000_000, pass: true })
    expect(r.pass).toBe(true)
  })

  it('已設審計委員會：董事成數須達董事＋監察人合計', () => {
    const r = checkDirectorHolding({
      paidInCapital: capital, parValue, hasAuditCommittee: true,
      directorShares: 20_000_000, supervisorShares: 0,
    })
    expect(r.lines).toHaveLength(1)
    expect(r.lines[0].requiredPct).toBeCloseTo(4.4, 6)
    expect(r.lines[0].requiredShares).toBe(22_000_000)
    expect(r.lines[0].pass).toBe(false)
    expect(r.lines[0].gapShares).toBe(2_000_000)
    expect(r.pass).toBe(false)
  })

  it('不足時計算應補足股數', () => {
    const r = checkDirectorHolding({
      paidInCapital: capital, parValue, hasAuditCommittee: false,
      directorShares: 15_000_000, supervisorShares: 1_000_000,
    })
    expect(r.lines[0].gapShares).toBe(5_000_000)
    expect(r.lines[1].gapShares).toBe(1_000_000)
    expect(r.pass).toBe(false)
  })
})
