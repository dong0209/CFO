import { describe, expect, it } from 'vitest'
import { complianceScore, resolveScope, runAllRules, runRule } from './checkEngine'
import { CHECK_RULES, RULE_MAP } from '../domain/rules'
import { METRICS } from '../domain/metrics'
import { referencedIds } from '../lib/formula'

const base = {
  cash: 2_000_000_000,
  stInvestments: 500_000_000,
  restrictedCash: 100_000_000,
  ar: 3_000_000_000,
  inventory: 2_000_000_000,
  currentAssets: 8_000_000_000,
  totalAssets: 20_000_000_000,
  intangibles: 500_000_000,
  ap: 1_500_000_000,
  shortTermDebt: 2_000_000_000,
  currentLiabilities: 5_000_000_000,
  longTermDebt: 3_000_000_000,
  totalLiabilities: 10_000_000_000,
  equity: 10_000_000_000,
  revenue: 12_000_000_000,
  cogs: 9_000_000_000,
  operatingIncome: 1_500_000_000,
  depreciation: 600_000_000,
  interestExpense: 150_000_000,
  pretaxIncome: 1_400_000_000,
  taxExpense: 280_000_000,
  netIncome: 1_120_000_000,
  cfo: 1_300_000_000,
  ltmEbitda: 2_100_000_000,
  periodDays: 365,
  statutoryTaxRate: 20,
}

describe('resolveScope', () => {
  it('解出多層相依的衍生指標', () => {
    const s = resolveScope(base)
    expect(s.grossProfit).toBe(3_000_000_000)
    expect(s.ebitda).toBe(2_100_000_000)
    // netDebt 依賴 grossDebt，grossDebt 依賴輸入 → 需疊代求解
    expect(s.grossDebt).toBe(5_000_000_000)
    expect(s.netDebt).toBe(2_500_000_000)
    // 槓桿比率的分母必須是 LTM EBITDA，而非本期 EBITDA
    expect(s.netDebtToEbitda).toBeCloseTo(2_500_000_000 / 2_100_000_000, 6)
  })
  it('缺少輸入時，相依的衍生指標維持未定義', () => {
    const s = resolveScope({ revenue: 100 })
    expect(s.grossProfit).toBeUndefined()
    expect(s.currentRatio).toBeUndefined()
  })
  it('分母為零不會產生 Infinity', () => {
    const s = resolveScope({ ...base, revenue: 0 })
    expect(s.grossMargin).toBeUndefined()
  })
})

describe('runRule', () => {
  const scope = resolveScope({ ...base, policyEndorsementPct: 50, policySingleEndorsementPct: 20, policyLendingPct: 40 })

  it('通過時回傳 PASS 與正緩衝', () => {
    const r = runRule(RULE_MAP['CV-01'], scope) // 流動比率 160% >= 120
    expect(r.status).toBe('PASS')
    expect(r.value).toBeCloseTo(160, 6)
    expect(r.headroom).toBeCloseTo(40, 6)
  })

  it('介於黃燈與紅線之間回傳 WARN', () => {
    const s = resolveScope({ ...base, currentAssets: 6_250_000_000 }) // 流動比率 125%
    const r = runRule(RULE_MAP['CV-01'], s)
    expect(r.status).toBe('WARN')
  })

  it('觸及紅線回傳 FAIL 與負緩衝', () => {
    const s = resolveScope({ ...base, currentAssets: 5_000_000_000 }) // 流動比率 100%
    const r = runRule(RULE_MAP['CV-01'], s)
    expect(r.status).toBe('FAIL')
    expect(r.headroom).toBeCloseTo(-20, 6)
    expect(r.message).toContain('已觸及紅線')
  })

  it('資料不足回傳 NO_DATA 並列出缺漏欄位（不得誤判為通過）', () => {
    const r = runRule(RULE_MAP['RL-01'], resolveScope({ equity: 1000 }))
    expect(r.status).toBe('NO_DATA')
    expect(r.missingInputs).toContain('endorsementToEquity')
  })

  it('門檻可引用公司政策參數（改設定即改門檻，不需改程式）', () => {
    // 背書保證 45 億 / 淨值 100 億 = 45%：未逾 50% 紅線，但已逾黃燈 (50%*0.8=40%)
    const warn = resolveScope({ ...base, endorsementBalance: 4_500_000_000, policyEndorsementPct: 50 })
    expect(runRule(RULE_MAP['RL-01'], warn).status).toBe('WARN')

    // 同樣 45%，但公司政策上限收緊為 40% → 直接觸及紅線
    const tightened = resolveScope({ ...base, endorsementBalance: 4_500_000_000, policyEndorsementPct: 40 })
    expect(runRule(RULE_MAP['RL-01'], tightened).status).toBe('FAIL')

    // 60% 超過 50% 上限
    const fail = resolveScope({ ...base, endorsementBalance: 6_000_000_000, policyEndorsementPct: 50 })
    const r = runRule(RULE_MAP['RL-01'], fail)
    expect(r.status).toBe('FAIL')
    expect(r.headroom).toBeCloseTo(-10, 6)
  })

  it('ABS<= 比較子：正負差異都視為未通過', () => {
    const pos = runRule(RULE_MAP['RC-01'], resolveScope({ ...base, cfEndingCash: 2_000_000_001 }))
    const neg = runRule(RULE_MAP['RC-01'], resolveScope({ ...base, cfEndingCash: 1_999_999_999 }))
    expect(pos.status).toBe('FAIL')
    expect(neg.status).toBe('FAIL')
    const ok = runRule(RULE_MAP['RC-01'], resolveScope({ ...base, cfEndingCash: 2_000_000_000 }))
    expect(ok.status).toBe('PASS')
  })
})

describe('規則庫完整性', () => {
  it('規則 id 不重複', () => {
    const ids = CHECK_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('所有規則引用的指標都存在於指標字典', () => {
    const known = new Set(METRICS.map((m) => m.id))
    for (const r of CHECK_RULES) {
      for (const id of [...referencedIds(r.expression), ...referencedIds(r.threshold), ...referencedIds(r.warn ?? '0')]) {
        expect(known.has(id), `規則 ${r.id} 引用了未定義的指標 ${id}`).toBe(true)
      }
    }
  })
  it('所有衍生指標公式引用的指標都存在', () => {
    const known = new Set(METRICS.map((m) => m.id))
    for (const m of METRICS.filter((m) => m.formula)) {
      for (const id of referencedIds(m.formula!)) {
        expect(known.has(id), `指標 ${m.id} 引用了未定義的 ${id}`).toBe(true)
      }
    }
  })
  it('每條規則都有法源依據與改善措施', () => {
    for (const r of CHECK_RULES) {
      expect(r.basis.length, r.id).toBeGreaterThan(0)
      expect(r.remediation.length, r.id).toBeGreaterThan(0)
    }
  })
})

describe('complianceScore', () => {
  it('全數通過為 100 分', () => {
    const results = CHECK_RULES.map((r) => ({
      ruleId: r.id, status: 'PASS' as const, value: 1, thresholdValue: 0, warnValue: null, headroom: 1, message: '', missingInputs: [],
    }))
    expect(complianceScore(results, CHECK_RULES)).toBe(100)
  })
  it('高嚴重度失敗扣分較多', () => {
    const mk = (failId: string) =>
      CHECK_RULES.map((r) => ({
        ruleId: r.id,
        status: (r.id === failId ? 'FAIL' : 'PASS') as 'FAIL' | 'PASS',
        value: 1, thresholdValue: 0, warnValue: null, headroom: 1, message: '', missingInputs: [],
      }))
    const sev5 = complianceScore(mk('CV-01'), CHECK_RULES) // severity 5
    const sev3 = complianceScore(mk('AN-01'), CHECK_RULES) // severity 3
    expect(sev5).toBeLessThan(sev3)
  })
  it('資料不足也會扣分', () => {
    const results = CHECK_RULES.map((r) => ({
      ruleId: r.id, status: 'NO_DATA' as const, value: null, thresholdValue: null, warnValue: null, headroom: null, message: '', missingInputs: [],
    }))
    expect(complianceScore(results, CHECK_RULES)).toBeLessThan(100)
  })
})

describe('runAllRules', () => {
  it('回傳與規則數相同的結果', () => {
    const results = runAllRules(CHECK_RULES, base)
    expect(results).toHaveLength(CHECK_RULES.length)
  })
})
