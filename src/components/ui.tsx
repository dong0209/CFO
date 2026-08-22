import type { ReactNode } from 'react'
import { AREA_MAP } from '../domain/areas'
import type { CheckStatus, FunctionAreaId, ObligationCategory, TaskHealth } from '../domain/types'
import { HEALTH_COLOR, HEALTH_LABEL } from '../engine/health'

export function Stat({ label, value, hint, color }: { label: string; value: ReactNode; hint?: string; color?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Card({ title, sub, children, actions }: { title?: string; sub?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="card">
      {title && (
        <h3>
          {title}
          {sub && <span className="sub">{sub}</span>}
          {actions && <span style={{ marginLeft: 'auto' }}>{actions}</span>}
        </h3>
      )}
      {children}
    </div>
  )
}

export function AreaPill({ area }: { area: FunctionAreaId }) {
  const a = AREA_MAP[area]
  return <span className="pill" style={{ background: `${a.color}1f`, color: a.color }}>{a.shortName}</span>
}

export function HealthPill({ health }: { health: TaskHealth }) {
  const c = HEALTH_COLOR[health]
  return <span className="pill" style={{ background: `${c}1f`, color: c }}>{HEALTH_LABEL[health]}</span>
}

const CHECK_COLOR: Record<CheckStatus, string> = {
  PASS: 'var(--ok)', WARN: 'var(--warn)', FAIL: 'var(--fail)', NO_DATA: 'var(--nodata)',
}
const CHECK_LABEL: Record<CheckStatus, string> = {
  PASS: '通過', WARN: '預警', FAIL: '未通過', NO_DATA: '資料不足',
}

export function CheckPill({ status }: { status: CheckStatus }) {
  const c = CHECK_COLOR[status]
  return <span className="pill" style={{ background: `color-mix(in srgb, ${c} 14%, transparent)`, color: c }}>{CHECK_LABEL[status]}</span>
}

export function Bar({ pct, color }: { pct: number; color?: string }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="bar" title={`${clamped}%`}>
      <span style={{ width: `${clamped}%`, background: color ?? (clamped === 100 ? 'var(--ok)' : 'var(--accent)') }} />
    </div>
  )
}

export function Severity({ level }: { level: number }) {
  return (
    <span title={`嚴重度 ${level}/5`} className="mono small muted">
      {'●'.repeat(level)}<span style={{ opacity: 0.25 }}>{'●'.repeat(5 - level)}</span>
    </span>
  )
}

export const CATEGORY_LABEL: Record<ObligationCategory, string> = {
  STATUTORY: '法令規定',
  REGULATORY: '主管機關/交易所規章',
  CONTRACTUAL: '契約義務',
  INTERNAL: '內部管理',
}

export function CategoryTag({ c }: { c: ObligationCategory }) {
  const color = c === 'STATUTORY' ? 'var(--fail)' : c === 'REGULATORY' ? 'var(--warn)' : c === 'CONTRACTUAL' ? 'var(--accent)' : 'var(--text-dim)'
  return <span className="pill" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>{CATEGORY_LABEL[c]}</span>
}

export function fmtMoney(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)} 億`
  if (abs >= 1e4) return `${(n / 1e4).toLocaleString('zh-TW', { maximumFractionDigits: 0 })} 萬`
  return n.toLocaleString('zh-TW')
}

export function daysLabel(d: number): string {
  if (d === 0) return '今天到期'
  return d > 0 ? `還有 ${d} 天` : `逾期 ${-d} 天`
}
