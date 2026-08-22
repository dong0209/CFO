import { evaluate, FormulaError, referencedIds, type Scope } from '../lib/formula'
import { METRICS } from '../domain/metrics'
import type { CheckResult, CheckRule, CheckStatus, Comparator, MetricDef } from '../domain/types'

/**
 * 將輸入科目 + 衍生指標解析成完整 scope。
 * 衍生指標可互相引用（例：netDebt → grossDebt），因此採疊代求解，
 * 直到沒有新值產生為止；無法解出者維持 undefined（＝資料不足）。
 */
export function resolveScope(inputs: Scope, metrics: MetricDef[] = METRICS): Scope {
  const scope: Scope = { ...inputs }
  const derived = metrics.filter((m) => m.formula)
  const maxPass = derived.length + 2
  for (let pass = 0; pass < maxPass; pass++) {
    let progressed = false
    for (const m of derived) {
      if (scope[m.id] !== undefined) continue
      try {
        const v = evaluate(m.formula!, scope)
        if (v !== null) {
          scope[m.id] = v
          progressed = true
        }
      } catch {
        // 公式本身有誤 → 該指標視為無法計算，於 UI 以「資料不足/公式錯誤」呈現
      }
    }
    if (!progressed) break
  }
  return scope
}

function compare(cmp: Comparator, value: number, threshold: number): boolean {
  switch (cmp) {
    case '>=': return value >= threshold
    case '<=': return value <= threshold
    case '>': return value > threshold
    case '<': return value < threshold
    case '==': return value === threshold
    case 'ABS<=': return Math.abs(value) <= threshold
  }
}

/** 緩衝：正數代表距離門檻還有多少空間 */
function headroomOf(cmp: Comparator, value: number, threshold: number): number {
  switch (cmp) {
    case '>=':
    case '>': return value - threshold
    case '<=':
    case '<': return threshold - value
    case '==': return -Math.abs(value - threshold)
    case 'ABS<=': return threshold - Math.abs(value)
  }
}

const UNIT_SUFFIX: Record<string, string> = { PCT: '%', TIMES: ' 倍', DAYS: ' 天', RATIO: '', AMOUNT: ' 元' }

export function formatValue(v: number | null, unit: string): string {
  if (v === null || v === undefined) return '—'
  if (unit === 'AMOUNT') {
    const abs = Math.abs(v)
    if (abs >= 1e8) return `${(v / 1e8).toFixed(2)} 億元`
    if (abs >= 1e4) return `${(v / 1e4).toFixed(0)} 萬元`
    return `${Math.round(v).toLocaleString('zh-TW')} 元`
  }
  return `${v.toFixed(2)}${UNIT_SUFFIX[unit] ?? ''}`
}

export function runRule(rule: CheckRule, scope: Scope): CheckResult {
  const missing = referencedIds(rule.expression).filter((id) => scope[id] === undefined)
  let value: number | null = null
  let thresholdValue: number | null = null
  let warnValue: number | null = null

  try {
    value = evaluate(rule.expression, scope)
    thresholdValue = evaluate(rule.threshold, scope)
    warnValue = rule.warn ? evaluate(rule.warn, scope) : null
  } catch (e) {
    const msg = e instanceof FormulaError ? e.message : '算式解析失敗'
    return {
      ruleId: rule.id, status: 'NO_DATA', value: null, thresholdValue: null, warnValue: null,
      headroom: null, message: `規則設定有誤：${msg}`, missingInputs: missing,
    }
  }

  if (value === null || thresholdValue === null) {
    return {
      ruleId: rule.id, status: 'NO_DATA', value, thresholdValue, warnValue, headroom: null,
      message: missing.length ? `資料不足：缺少 ${missing.join('、')}` : '資料不足或分母為零，無法計算',
      missingInputs: missing,
    }
  }

  const passRed = compare(rule.comparator, value, thresholdValue)
  const passYellow = warnValue === null ? true : compare(rule.comparator, value, warnValue)
  const status: CheckStatus = !passRed ? 'FAIL' : !passYellow ? 'WARN' : 'PASS'
  const headroom = headroomOf(rule.comparator, value, thresholdValue)

  const vs = formatValue(value, rule.unit)
  const ts = formatValue(thresholdValue, rule.unit)
  const message =
    status === 'FAIL'
      ? `已觸及紅線：實際 ${vs}，門檻 ${rule.comparator} ${ts}`
      : status === 'WARN'
        ? `接近門檻：實際 ${vs}，紅線 ${ts}，緩衝 ${formatValue(headroom, rule.unit)}`
        : `符合：實際 ${vs}，緩衝 ${formatValue(headroom, rule.unit)}`

  return { ruleId: rule.id, status, value, thresholdValue, warnValue, headroom, message, missingInputs: [] }
}

export function runAllRules(rules: CheckRule[], inputs: Scope): CheckResult[] {
  const scope = resolveScope(inputs)
  return rules.map((r) => runRule(r, scope))
}

/**
 * 檢核總分：以未通過規則的嚴重度加權計算 0–100。
 * FAIL 全額計分、WARN 半額；NO_DATA 亦扣分（資料不完整本身即是控制缺失）。
 */
export function complianceScore(results: CheckResult[], rules: CheckRule[]): number {
  const byId = new Map(rules.map((r) => [r.id, r]))
  let weight = 0
  let lost = 0
  for (const r of results) {
    const rule = byId.get(r.ruleId)
    if (!rule) continue
    weight += rule.severity
    if (r.status === 'FAIL') lost += rule.severity
    else if (r.status === 'WARN') lost += rule.severity * 0.5
    else if (r.status === 'NO_DATA') lost += rule.severity * 0.3
  }
  if (weight === 0) return 100
  return Math.round((1 - lost / weight) * 100)
}
