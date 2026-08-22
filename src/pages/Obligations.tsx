import { useState } from 'react'
import { AREAS, ROLE_NAMES } from '../domain/areas'
import { EVENT_OBLIGATIONS, OBLIGATIONS } from '../domain/obligations'
import { AreaPill, CategoryTag, Severity } from '../components/ui'
import type { DueRule, FunctionAreaId, PeriodKind } from '../domain/types'

const PERIOD_LABEL: Record<PeriodKind, string> = {
  MONTH: '每月', BIMONTH: '每 2 個月', QUARTER: '每季', HALF: '每半年', YEAR: '每年', EVENT: '事件驅動',
}

function dueText(due: DueRule): string {
  switch (due.type) {
    case 'DAYS_AFTER': return due.days === 0 ? '期間終了前' : `期間終了後 ${due.days} 日內`
    case 'MONTHS_AFTER': return `期間終了後 ${due.months} 個月${due.day ? `之 ${due.day} 日` : '內'}`
    case 'FIXED_IN_PERIOD': return `期間內 ${due.month}/${due.day}`
  }
}

export function Obligations() {
  const [area, setArea] = useState<FunctionAreaId>('REPORTING')
  const a = AREAS.find((x) => x.id === area)!
  const items = OBLIGATIONS.filter((o) => o.area === area)

  return (
    <>
      <div className="page-head">
        <h2>職能與義務主檔</h2>
        <p>財務長九大職能面向，共 {OBLIGATIONS.length} 項義務、{OBLIGATIONS.reduce((n, o) => n + o.checklist.length, 0)} 個檢核點。此處為制度層，行事曆的任務由此自動展開。</p>
      </div>

      <div className="toolbar">
        {AREAS.map((x) => (
          <button key={x.id} className={`btn${x.id === area ? ' primary' : ''}`} onClick={() => setArea(x.id)}>
            {x.shortName}
            <span style={{ opacity: 0.7 }}>（{OBLIGATIONS.filter((o) => o.area === x.id).length}）</span>
          </button>
        ))}
      </div>

      <div className="card">
        <h3><AreaPill area={a.id} /> {a.name}</h3>
        <p className="small" style={{ marginTop: 0 }}>{a.mission}</p>
        <div className="grid cols-2">
          <div>
            <strong className="small">關鍵職責</strong>
            <ul className="legal" style={{ fontSize: 12 }}>{a.responsibilities.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
          <div>
            <strong className="small" style={{ color: 'var(--fail)' }}>失效時的典型後果</strong>
            <ul className="legal" style={{ fontSize: 12 }}>{a.failureModes.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        </div>
      </div>

      {items.map((o) => (
        <div className="card" key={o.id}>
          <h3>
            {o.title}
            <span className="sub">{PERIOD_LABEL[o.period]}・{dueText(o.due)}</span>
          </h3>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <CategoryTag c={o.category} />
            <span className="tag">主辦 {ROLE_NAMES[o.owner]}</span>
            <span className="tag">覆核 {ROLE_NAMES[o.reviewer]}</span>
            <span className="tag">核准 {ROLE_NAMES[o.approver]}</span>
            {o.tiers.length > 0 && <span className="tag">僅適用 {o.tiers.join('/')}</span>}
            {o.channel && <span className="tag">管道：{o.channel}</span>}
            <Severity level={o.severity} />
          </div>
          <div className="grid cols-2">
            <div>
              <strong className="small">法源依據</strong>
              <ul className="legal">{o.legalBasis.map((b) => <li key={b}>{b}</li>)}</ul>
              {o.penalty && <p className="small" style={{ color: 'var(--fail)' }}>違反效果：{o.penalty}</p>}
              <strong className="small">應交付成果</strong>
              <div>{o.outputs.map((x) => <span key={x} className="tag">{x}</span>)}</div>
              {o.notes && <p className="small muted">備註：{o.notes}</p>}
            </div>
            <div>
              <strong className="small">檢核點（{o.checklist.length}）</strong>
              <ul className="legal">
                {o.checklist.map((c) => (
                  <li key={c.id}>
                    {c.text}
                    {c.control && <span className="tag" style={{ marginLeft: 4 }}>{c.control}</span>}
                    {!c.required && <span className="tag">視情況</span>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      ))}

      {EVENT_OBLIGATIONS.some((o) => o.area === area) && (
        <div className="banner info">
          此面向包含事件驅動義務（不排入行事曆，改以常備 SOP 管理）：{EVENT_OBLIGATIONS.filter((o) => o.area === area).map((o) => o.title).join('、')}
        </div>
      )}
    </>
  )
}
