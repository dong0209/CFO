import { AREAS, ROLE_NAMES } from './areas'
import { OBLIGATIONS } from './obligations'
import { CHECK_RULES } from './rules'
import { METRICS } from './metrics'
import { computeStatutoryDue, periodsFor } from '../engine/schedule'
import type { DueRule, ObligationCategory, PeriodKind } from './types'

/**
 * 由主檔產生文件表格。
 * docs/ 底下的總表不手工維護 —— 由此渲染，並以 docs.test.ts 偵測漂移，
 * 避免「制度改了、文件沒改」這種最常見的內控文件缺失。
 */

const PERIOD: Record<PeriodKind, string> = {
  MONTH: '每月', BIMONTH: '每雙月', QUARTER: '每季', HALF: '每半年', YEAR: '每年', EVENT: '事件驅動',
}

const CATEGORY: Record<ObligationCategory, string> = {
  STATUTORY: '法令', REGULATORY: '規章', CONTRACTUAL: '契約', INTERNAL: '內部',
}

export function dueText(due: DueRule): string {
  switch (due.type) {
    case 'DAYS_AFTER': return due.days === 0 ? '期間終了前' : `期末後 ${due.days} 日內`
    case 'MONTHS_AFTER': return `期末後 ${due.months} 個月${due.day ? `之 ${due.day} 日` : '內'}`
    case 'FIXED_IN_PERIOD': return `期間內 ${due.month}/${due.day}`
  }
}

const esc = (s: string) => s.replace(/\|/g, '\\|')

export function renderObligationTables(): string {
  const out: string[] = []
  for (const a of AREAS) {
    const items = OBLIGATIONS.filter((o) => o.area === a.id)
    if (!items.length) continue
    out.push(`### ${a.name}（${items.length} 項）\n`)
    out.push(`> ${a.mission}\n`)
    out.push('| 義務 | 頻率 | 到期規則 | 屬性 | 適用 | 主辦 / 核准 | 嚴重度 | 檢核點 | 主要法源 |')
    out.push('|---|---|---|---|---|---|:--:|:--:|---|')
    for (const o of items) {
      out.push(
        `| ${esc(o.title)} | ${PERIOD[o.period]} | ${dueText(o.due)} | ${CATEGORY[o.category]} | ` +
          `${o.tiers.length ? o.tiers.join('/') : '全部'} | ${ROLE_NAMES[o.owner]} / ${ROLE_NAMES[o.approver]} | ` +
          `${o.severity} | ${o.checklist.length} | ${esc(o.legalBasis[0])} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

export function renderChecklistDetail(): string {
  const out: string[] = []
  for (const a of AREAS) {
    const items = OBLIGATIONS.filter((o) => o.area === a.id)
    if (!items.length) continue
    out.push(`### ${a.name}\n`)
    for (const o of items) {
      out.push(`#### ${o.title}`)
      out.push(`- 頻率：${PERIOD[o.period]}｜到期：${dueText(o.due)}｜主辦：${ROLE_NAMES[o.owner]}｜覆核：${ROLE_NAMES[o.reviewer]}｜核准：${ROLE_NAMES[o.approver]}`)
      out.push(`- 法源：${o.legalBasis.join('；')}`)
      if (o.penalty) out.push(`- 違反效果：${o.penalty}`)
      if (o.channel) out.push(`- 申報管道：${o.channel}`)
      out.push(`- 交付成果：${o.outputs.join('、')}`)
      out.push('- 檢核清單：')
      for (const c of o.checklist) {
        out.push(`  - [ ] ${c.text}${c.control ? `（控制點 ${c.control}）` : ''}${c.required ? '' : '〔視情況〕'}`)
      }
      if (o.notes) out.push(`- 備註：${o.notes}`)
      out.push('')
    }
  }
  return out.join('\n')
}

export function renderRuleTable(): string {
  const out: string[] = []
  const byCat = new Map<string, typeof CHECK_RULES>()
  for (const r of CHECK_RULES) {
    if (!byCat.has(r.category)) byCat.set(r.category, [])
    byCat.get(r.category)!.push(r)
  }
  const LABEL: Record<string, string> = {
    RECONCILIATION: '帳務勾稽（差異須為零）',
    COVENANT: '融資契約財務約定',
    REGULATORY_LIMIT: '法令與自訂上限',
    LIQUIDITY: '流動性與資金安全',
    ANALYTICAL: '分析性覆核',
  }
  for (const cat of ['RECONCILIATION', 'COVENANT', 'REGULATORY_LIMIT', 'LIQUIDITY', 'ANALYTICAL']) {
    const items = byCat.get(cat)
    if (!items) continue
    out.push(`### ${LABEL[cat]}（${items.length} 條）\n`)
    out.push('| 編號 | 規則 | 算式 | 紅線 | 黃燈 | 頻率 | 嚴重度 | 觸發時應採行動 |')
    out.push('|---|---|---|---|---|:--:|:--:|---|')
    for (const r of items) {
      out.push(
        `| ${r.id} | ${esc(r.name)} | \`${esc(r.expression)}\` | \`${r.comparator} ${esc(r.threshold)}\` | ` +
          `${r.warn ? `\`${esc(r.warn)}\`` : '—'} | ${PERIOD[r.frequency]} | ${r.severity} | ${esc(r.remediation)} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

export function renderMetricTable(): string {
  const out: string[] = ['| 代號 | 指標 | 單位 | 分類 | 公式 |', '|---|---|---|---|---|']
  for (const m of METRICS) {
    out.push(`| \`${m.id}\` | ${esc(m.name)} | ${m.unit} | ${m.group} | ${m.formula ? `\`${esc(m.formula)}\`` : '（輸入）'} |`)
  }
  return out.join('\n')
}

/**
 * 年度關鍵期限時間軸：以曆年制、上市公司為基準，
 * 列出嚴重度 4 以上的法定/規章義務之「法定期限」（未做營業日調整）。
 */
export function renderAnnualTimeline(referenceYear: number): string {
  const rows: { due: string; title: string; period: string; area: string; sev: number; basis: string }[] = []
  for (const o of OBLIGATIONS) {
    if (o.period === 'EVENT') continue
    if (o.severity < 4) continue
    if (o.category === 'INTERNAL') continue
    if (o.tiers.length && !o.tiers.includes('LISTED')) continue
    for (const p of periodsFor(o.period, referenceYear, 12)) {
      rows.push({
        due: computeStatutoryDue(o, p),
        title: o.title,
        period: p.label,
        area: AREAS.find((a) => a.id === o.area)!.shortName,
        sev: o.severity,
        basis: o.legalBasis[0],
      })
    }
  }
  rows.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))

  const out: string[] = []
  let currentMonth = ''
  for (const r of rows) {
    const m = r.due.slice(0, 7)
    if (m !== currentMonth) {
      if (currentMonth) out.push('')
      currentMonth = m
      out.push(`### ${m}\n`)
      out.push('| 法定期限 | 義務 | 期間 | 面向 | 嚴重度 | 法源 |')
      out.push('|---|---|---|---|:--:|---|')
    }
    out.push(`| ${r.due} | ${esc(r.title)} | ${r.period} | ${r.area} | ${r.sev} | ${esc(r.basis)} |`)
  }
  return out.join('\n')
}
