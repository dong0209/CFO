import { useMemo } from 'react'
import { ROLE_NAMES } from '../domain/areas'
import { OBLIGATION_MAP } from '../domain/obligations'
import { RULE_MAP } from '../domain/rules'
import { runAllRules } from '../engine/checkEngine'
import { CHECK_RULES } from '../domain/rules'
import { taskHealth } from '../engine/health'
import { useCheckInputs, useStore } from '../state/store'
import { AreaPill, CheckPill, Stat } from '../components/ui'
import type { PeriodKind } from '../domain/types'

const FREQ_LABEL: Record<PeriodKind, string> = {
  MONTH: '每月', BIMONTH: '每雙月', QUARTER: '每季', HALF: '每半年', YEAR: '每年', EVENT: '事件驅動',
}

function riskColor(score: number): string {
  if (score >= 15) return '#dc2626'
  if (score >= 10) return '#ea580c'
  if (score >= 6) return '#d97706'
  return '#059669'
}

export function Risks() {
  const { state } = useStore()
  const inputs = useCheckInputs()
  const checkResults = useMemo(() => {
    const rs = runAllRules(CHECK_RULES, inputs)
    return new Map(rs.map((r) => [r.ruleId, r]))
  }, [inputs])

  const rows = state.risks
    .map((r) => ({ ...r, score: r.likelihood * r.impact }))
    .sort((a, b) => b.score - a.score)

  const high = rows.filter((r) => r.score >= 15)
  const covered = rows.filter((r) => r.linkedRuleIds.length > 0 || r.linkedObligationIds.length > 0)

  // 5x5 風險矩陣
  const matrix: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0))
  for (const r of rows) matrix[5 - r.impact][r.likelihood - 1]++

  return (
    <>
      <div className="page-head">
        <h2>風險登錄簿</h2>
        <p>每一項風險都必須對應到「定期義務」或「檢核規則」— 沒有控制對應的風險，等於沒有被管理。</p>
      </div>

      <div className="grid cols-4">
        <Stat label="登錄風險數" value={rows.length} />
        <Stat label="高風險（≥15）" value={high.length} color={high.length ? 'var(--fail)' : 'var(--ok)'} hint="可能性 × 衝擊度" />
        <Stat label="已有控制對應" value={`${covered.length}/${rows.length}`} color={covered.length === rows.length ? 'var(--ok)' : 'var(--warn)'} />
        <Stat
          label="控制目前告警"
          value={rows.filter((r) => r.linkedRuleIds.some((id) => ['FAIL', 'WARN'].includes(checkResults.get(id)?.status ?? ''))).length}
          color="var(--warn)"
          hint="所連結的檢核規則出現紅／黃燈"
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>風險矩陣<span className="sub">縱軸：衝擊度（上高）／橫軸：可能性（右高）</span></h3>
          <div className="heat">
            {matrix.map((row, i) =>
              row.map((n, j) => {
                const impact = 5 - i
                const likelihood = j + 1
                const s = impact * likelihood
                return (
                  <div key={`${i}-${j}`} style={{ background: n ? riskColor(s) : 'var(--surface-2)', color: n ? '#fff' : 'var(--text-dim)' }} title={`可能性 ${likelihood} × 衝擊 ${impact} = ${s}`}>
                    {n || ''}
                  </div>
                )
              }),
            )}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>格內數字為落入該象限的風險項目數。</p>
        </div>

        <div className="card">
          <h3>風險覆核頻率</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>頻率</th><th className="num">風險項目</th><th>對應定期義務</th></tr></thead>
              <tbody>
                {(['MONTH', 'QUARTER', 'HALF', 'YEAR'] as PeriodKind[]).map((f) => {
                  const items = rows.filter((r) => r.reviewFrequency === f)
                  if (!items.length) return null
                  const obls = [...new Set(items.flatMap((r) => r.linkedObligationIds))]
                  return (
                    <tr key={f}>
                      <td>{FREQ_LABEL[f]}</td>
                      <td className="num">{items.length}</td>
                      <td className="small muted">{obls.map((id) => OBLIGATION_MAP[id]?.title).filter(Boolean).join('、') || '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>風險 → 控制對照表</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>風險</th><th>面向</th><th className="num">可能性</th><th className="num">衝擊</th><th className="num">分數</th>
                <th>因應措施</th><th>對應檢核規則（現況）</th><th>對應定期義務</th><th>負責人</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.title}</strong><div className="small muted">{r.category}</div></td>
                  <td><AreaPill area={r.area} /></td>
                  <td className="num">{r.likelihood}</td>
                  <td className="num">{r.impact}</td>
                  <td className="num"><span className="pill" style={{ background: `${riskColor(r.score)}22`, color: riskColor(r.score) }}>{r.score}</span></td>
                  <td className="small muted">{r.mitigation}</td>
                  <td className="small">
                    {r.linkedRuleIds.length === 0 ? <span className="muted">—</span> : r.linkedRuleIds.map((id) => {
                      const res = checkResults.get(id)
                      return (
                        <div key={id} style={{ marginBottom: 2 }}>
                          <span className="mono" style={{ fontSize: 11 }}>{id}</span> {RULE_MAP[id]?.name}
                          {res && <> <CheckPill status={res.status} /></>}
                        </div>
                      )
                    })}
                  </td>
                  <td className="small">
                    {r.linkedObligationIds.map((id) => {
                      const o = OBLIGATION_MAP[id]
                      if (!o) return null
                      const open = state.tasks
                        .filter((t) => t.obligationId === id && !['DONE_ON_TIME', 'DONE_LATE', 'NA'].includes(taskHealth(t, state.today)))
                        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0]
                      const overdue = open ? taskHealth(open, state.today) === 'OVERDUE' : false
                      return (
                        <div key={id} style={{ marginBottom: 2 }}>
                          {o.title}
                          {open && (
                            <span style={{ color: overdue ? 'var(--fail)' : 'var(--text-dim)' }}>
                              {' '}・{overdue ? '逾期未結' : '下次'} {open.dueDate}
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </td>
                  <td className="small nowrap">{ROLE_NAMES[r.owner]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
