import { useMemo, useState } from 'react'
import { AREAS, AREA_MAP } from '../domain/areas'
import { OBLIGATION_MAP } from '../domain/obligations'
import { CHECK_RULES } from '../domain/rules'
import { complianceScore, runAllRules } from '../engine/checkEngine'
import { checklistProgress, taskHealth, urgencyScore } from '../engine/health'
import { diffDays } from '../lib/date'
import { useCheckInputs, useStore } from '../state/store'
import { TaskDrawer } from '../components/TaskDrawer'
import { AreaPill, Bar, CheckPill, HealthPill, Stat, daysLabel } from '../components/ui'
import type { Task } from '../domain/types'

export function Dashboard() {
  const { state } = useStore()
  const inputs = useCheckInputs()
  const [selected, setSelected] = useState<Task | null>(null)
  const today = state.today

  const checks = useMemo(() => runAllRules(CHECK_RULES, inputs), [inputs])
  const score = complianceScore(checks, CHECK_RULES)
  const failed = checks.filter((c) => c.status === 'FAIL')
  const warned = checks.filter((c) => c.status === 'WARN')

  const enriched = useMemo(
    () =>
      state.tasks.map((t) => {
        const o = OBLIGATION_MAP[t.obligationId]
        const req = new Set(o.checklist.filter((c) => c.required).map((c) => c.id))
        return {
          task: t,
          o,
          health: taskHealth(t, today),
          progress: checklistProgress(t, req),
          urgency: urgencyScore(t, o.severity, today),
          days: diffDays(t.dueDate, today),
        }
      }),
    [state.tasks, today],
  )

  const overdue = enriched.filter((e) => e.health === 'OVERDUE')
  const dueSoon = enriched.filter((e) => e.health === 'DUE_TODAY' || e.health === 'AT_RISK')
  const upcoming = enriched.filter((e) => e.health === 'UPCOMING')
  const closed = enriched.filter((e) => e.health === 'DONE_ON_TIME' || e.health === 'DONE_LATE')
  const lateDone = enriched.filter((e) => e.health === 'DONE_LATE')
  const dueToDate = enriched.filter((e) => e.task.dueDate <= today && e.task.status !== 'NA')
  const onTimeRate = dueToDate.length
    ? Math.round((dueToDate.filter((e) => e.health === 'DONE_ON_TIME').length / dueToDate.length) * 100)
    : 100

  const actionList = [...overdue, ...dueSoon].sort((a, b) => b.urgency - a.urgency)

  const byArea = AREAS.map((a) => {
    const items = enriched.filter((e) => e.o.area === a.id)
    const open = items.filter((e) => e.health === 'OVERDUE' || e.health === 'DUE_TODAY' || e.health === 'AT_RISK')
    const areaChecks = checks.filter((c) => CHECK_RULES.find((r) => r.id === c.ruleId)?.area === a.id)
    return {
      area: a,
      total: items.length,
      overdue: items.filter((e) => e.health === 'OVERDUE').length,
      open: open.length,
      failedChecks: areaChecks.filter((c) => c.status === 'FAIL').length,
      warnChecks: areaChecks.filter((c) => c.status === 'WARN').length,
    }
  })

  return (
    <>
      <div className="page-head">
        <h2>財務長工作台</h2>
        <p>
          {state.profile.name}（{state.profile.stockCode}）・{state.fiscalYear} 會計年度・基準日 {today}
        </p>
      </div>

      {overdue.length > 0 ? (
        <div className="banner fail">
          <strong>{overdue.length} 項法定/內部義務已逾期</strong>
          {overdue.some((e) => e.o.severity >= 5) &&
            `，其中 ${overdue.filter((e) => e.o.severity >= 5).length} 項屬最高嚴重度（逾期即可能導致罰鍰或影響交易）`}
          。請優先處理下方待辦。
        </div>
      ) : (
        <div className="banner ok">目前沒有逾期義務。未來 7 日內有 {dueSoon.length} 項到期。</div>
      )}

      <div className="grid cols-4">
        <Stat label="已逾期義務" value={overdue.length} color={overdue.length ? 'var(--fail)' : 'var(--ok)'} hint="須立即處理" />
        <Stat label="7 日內到期" value={dueSoon.length} color={dueSoon.length ? 'var(--warn)' : undefined} hint={`30 日內另有 ${upcoming.length} 項`} />
        <Stat label="如期完成率" value={`${onTimeRate}%`} color={onTimeRate >= 95 ? 'var(--ok)' : 'var(--warn)'} hint={`已結案 ${closed.length} 項，逾期完成 ${lateDone.length} 項`} />
        <Stat
          label="財務檢核總分"
          value={score}
          color={score >= 90 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--fail)'}
          hint={`未通過 ${failed.length} 項、預警 ${warned.length} 項`}
        />
      </div>

      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <div className="card">
          <h3>優先處理清單<span className="sub">依嚴重度 × 緊迫度排序</span></h3>
          {actionList.length === 0 ? (
            <p className="muted small">近期無到期或逾期項目。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>義務</th><th>期間</th><th>到期</th><th>狀態</th><th className="num">完成度</th></tr>
                </thead>
                <tbody>
                  {actionList.slice(0, 12).map((e) => (
                    <tr key={e.task.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(e.task)}>
                      <td>
                        <AreaPill area={e.o.area} /> {e.o.title}
                      </td>
                      <td className="nowrap small muted">{e.task.periodLabel}</td>
                      <td className="nowrap small">{e.task.dueDate}<br /><span className="muted">{daysLabel(e.days)}</span></td>
                      <td><HealthPill health={e.health} /></td>
                      <td className="num">
                        <Bar pct={e.progress.pct} />
                        <span className="small muted">{e.progress.done}/{e.progress.total}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h3>檢核紅黃燈<span className="sub">依 {state.financials.find((f) => f.id === state.activeFinancialId)?.label}</span></h3>
          {failed.length === 0 && warned.length === 0 ? (
            <p className="muted small">所有檢核規則均通過。</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th>規則</th><th>結果</th><th>說明</th></tr></thead>
                <tbody>
                  {[...failed, ...warned].map((c) => {
                    const rule = CHECK_RULES.find((r) => r.id === c.ruleId)!
                    return (
                      <tr key={c.ruleId}>
                        <td><AreaPill area={rule.area} /> {rule.name}</td>
                        <td><CheckPill status={c.status} /></td>
                        <td className="small muted">{c.message}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {checks.some((c) => c.status === 'NO_DATA') && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              另有 {checks.filter((c) => c.status === 'NO_DATA').length} 項因資料不足無法檢核 — 於「財務檢核」頁補齊輸入科目。
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h3>九大職能面向健康度</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>面向</th><th>核心任務</th>
                <th className="num">本年度義務</th><th className="num">逾期</th><th className="num">近期待辦</th>
                <th className="num">檢核未通過</th><th className="num">檢核預警</th>
              </tr>
            </thead>
            <tbody>
              {byArea.map((r) => (
                <tr key={r.area.id}>
                  <td><AreaPill area={r.area.id} /> <strong>{r.area.name}</strong></td>
                  <td className="small muted">{r.area.mission}</td>
                  <td className="num">{r.total}</td>
                  <td className="num" style={{ color: r.overdue ? 'var(--fail)' : undefined, fontWeight: r.overdue ? 700 : 400 }}>{r.overdue}</td>
                  <td className="num">{r.open}</td>
                  <td className="num" style={{ color: r.failedChecks ? 'var(--fail)' : undefined }}>{r.failedChecks}</td>
                  <td className="num" style={{ color: r.warnChecks ? 'var(--warn)' : undefined }}>{r.warnChecks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          面向定義與職責明細請見「職能與義務主檔」；{AREA_MAP.REPORTING.name}與{AREA_MAP.COMPLIANCE.name}的逾期風險最高，建議每週固定檢視。
        </p>
      </div>

      {selected && <TaskDrawer task={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
