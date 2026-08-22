import { useMemo, useState } from 'react'
import { AREAS, ROLE_NAMES } from '../domain/areas'
import { OBLIGATION_MAP } from '../domain/obligations'
import { checklistProgress, taskHealth } from '../engine/health'
import { diffDays } from '../lib/date'
import { useStore } from '../state/store'
import { TaskDrawer } from '../components/TaskDrawer'
import { AreaPill, Bar, CategoryTag, HealthPill, Severity, daysLabel } from '../components/ui'
import type { FunctionAreaId, Task, TaskHealth } from '../domain/types'

type Filter = 'ALL' | 'OPEN' | 'OVERDUE' | 'DONE'

const MONTH_NAMES = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月']

export function Calendar() {
  const { tasks: allTasks, today, workspace, mutate } = useStore()
  const [area, setArea] = useState<FunctionAreaId | 'ALL'>('ALL')
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<Task | null>(null)

  const rows = useMemo(() => {
    return allTasks
      .map((t) => {
        const o = OBLIGATION_MAP[t.obligationId]
        const req = new Set(o.checklist.filter((c) => c.required).map((c) => c.id))
        return { task: t, o, health: taskHealth(t, today), progress: checklistProgress(t, req) }
      })
      .filter((r) => (area === 'ALL' ? true : r.o.area === area))
      .filter((r) => {
        const open: TaskHealth[] = ['OVERDUE', 'DUE_TODAY', 'AT_RISK', 'UPCOMING', 'FUTURE']
        if (filter === 'OPEN') return open.includes(r.health)
        if (filter === 'OVERDUE') return r.health === 'OVERDUE'
        if (filter === 'DONE') return r.health === 'DONE_ON_TIME' || r.health === 'DONE_LATE'
        return true
      })
      .filter((r) => (q ? (r.o.title + r.o.legalBasis.join('') + r.task.periodLabel).includes(q) : true))
  }, [allTasks, today, area, filter, q])

  const byMonth = useMemo(() => {
    const m = new Map<string, typeof rows>()
    for (const r of rows) {
      const key = r.task.dueDate.slice(0, 7)
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(r)
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  }, [rows])

  return (
    <>
      <div className="page-head">
        <h2>法遵行事曆</h2>
        <p>依 {workspace.fiscalYear} 會計年度自動展開 {allTasks.length} 項定期任務，到期日已完成營業日調整。點選任一列可展開檢核清單。</p>
      </div>

      <div className="toolbar">
        <select value={workspace.fiscalYear} onChange={(e) => mutate({ kind: 'fiscalYear', year: Number(e.target.value) })}>
          {[workspace.fiscalYear - 1, workspace.fiscalYear, workspace.fiscalYear + 1].map((y) => (
            <option key={y} value={y}>{y} 會計年度</option>
          ))}
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value as FunctionAreaId | 'ALL')}>
          <option value="ALL">全部職能面向</option>
          {AREAS.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          <option value="ALL">全部狀態</option>
          <option value="OPEN">未結案</option>
          <option value="OVERDUE">僅逾期</option>
          <option value="DONE">已完成</option>
        </select>
        <input placeholder="搜尋義務名稱或法源…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        <span className="small muted">共 {rows.length} 筆</span>
      </div>

      {byMonth.length === 0 && <div className="card"><p className="muted small" style={{ margin: 0 }}>沒有符合條件的任務。</p></div>}

      {byMonth.map(([month, items]) => {
        const [y, m] = month.split('-')
        const overdueCount = items.filter((i) => i.health === 'OVERDUE').length
        return (
          <section className="timeline-month" key={month}>
            <h4>
              {y} 年 {MONTH_NAMES[Number(m) - 1]}
              <span className="muted" style={{ fontWeight: 400 }}>　{items.length} 項到期</span>
              {overdueCount > 0 && <span className="pill" style={{ marginLeft: 8, background: 'rgba(220,38,38,.12)', color: 'var(--fail)' }}>逾期 {overdueCount}</span>}
            </h4>
            <div className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 92 }}>到期日</th>
                      <th>義務</th>
                      <th>期間</th>
                      <th>屬性</th>
                      <th>主辦</th>
                      <th>嚴重度</th>
                      <th>狀態</th>
                      <th className="num" style={{ width: 110 }}>檢核完成度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <tr key={r.task.id} style={{ cursor: 'pointer' }} onClick={() => setSelected(r.task)}>
                        <td className="nowrap mono small">
                          {r.task.dueDate.slice(5)}
                          <div className="muted" style={{ fontSize: 10 }}>{daysLabel(diffDays(r.task.dueDate, today))}</div>
                        </td>
                        <td>
                          <AreaPill area={r.o.area} /> {r.o.title}
                          {r.task.dueDate !== r.task.statutoryDue && <span className="tag" style={{ marginLeft: 6 }}>假日順延</span>}
                        </td>
                        <td className="small muted nowrap">{r.task.periodLabel}</td>
                        <td><CategoryTag c={r.o.category} /></td>
                        <td className="small muted nowrap">{ROLE_NAMES[r.o.owner]}</td>
                        <td><Severity level={r.o.severity} /></td>
                        <td><HealthPill health={r.health} /></td>
                        <td className="num">
                          <Bar pct={r.progress.pct} />
                          <span className="small muted">{r.progress.done}/{r.progress.total}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )
      })}

      {selected && <TaskDrawer task={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
