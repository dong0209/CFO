import { OBLIGATION_MAP } from '../domain/obligations'
import { ROLE_NAMES } from '../domain/areas'
import type { ChecklistItemType, Task, TaskStatus } from '../domain/types'
import { useStore } from '../state/store'
import { diffDays } from '../lib/date'
import { checklistProgress, taskHealth } from '../engine/health'
import { AreaPill, Bar, CategoryTag, HealthPill, Severity, daysLabel } from './ui'

const TYPE_LABEL: Record<ChecklistItemType, string> = {
  CONFIRM: '確認', DOC: '文件', RECONCILE: '勾稽', APPROVAL: '核准', FILING: '申報',
}

const STATUS_OPTIONS: { value: TaskStatus; label: string }[] = [
  { value: 'NOT_STARTED', label: '未開始' },
  { value: 'IN_PROGRESS', label: '進行中' },
  { value: 'IN_REVIEW', label: '覆核中' },
  { value: 'DONE', label: '已完成' },
  { value: 'NA', label: '本期不適用' },
]

export function TaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  const { state, dispatch } = useStore()
  const o = OBLIGATION_MAP[task.obligationId]
  const requiredIds = new Set(o.checklist.filter((c) => c.required).map((c) => c.id))
  const progress = checklistProgress(task, requiredIds)
  const health = taskHealth(task, state.today)
  const remaining = diffDays(task.dueDate, state.today)
  const blocked = progress.done < progress.total

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <button className="btn close" onClick={onClose}>關閉 ✕</button>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          <AreaPill area={o.area} />
          <CategoryTag c={o.category} />
          <HealthPill health={health} />
        </div>
        <h3>{o.title}</h3>
        <p className="muted small" style={{ marginTop: 0 }}>
          期間 {task.periodLabel}（{task.periodStart} ~ {task.periodEnd}）
        </p>

        <div className="grid cols-3" style={{ marginBottom: 14 }}>
          <div className="stat">
            <div className="label">到期日</div>
            <div className="value" style={{ fontSize: 18 }}>{task.dueDate}</div>
            <div className="hint">
              {daysLabel(remaining)}
              {task.dueDate !== task.statutoryDue && ` ・法定期限 ${task.statutoryDue} 遇假日順延`}
            </div>
          </div>
          <div className="stat">
            <div className="label">建議開工日</div>
            <div className="value" style={{ fontSize: 18 }}>{task.startDate}</div>
            <div className="hint">提前 {o.leadBusinessDays} 個營業日</div>
          </div>
          <div className="stat">
            <div className="label">必辦項目完成度</div>
            <div className="value" style={{ fontSize: 18 }}>{progress.done}/{progress.total}</div>
            <div className="hint"><Bar pct={progress.pct} /></div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
          <div className="field" style={{ flex: '1 1 180px', marginBottom: 0 }}>
            <label>狀態</label>
            <select
              value={task.status}
              onChange={(e) => dispatch({ type: 'SET_TASK_STATUS', taskId: task.id, status: e.target.value as TaskStatus })}
            >
              {STATUS_OPTIONS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: '1 1 180px', marginBottom: 0 }}>
            <label>承辦人</label>
            <input
              value={task.assignee ?? ''}
              placeholder={ROLE_NAMES[o.owner]}
              onChange={(e) => dispatch({ type: 'SET_TASK_FIELD', taskId: task.id, patch: { assignee: e.target.value } })}
            />
          </div>
        </div>

        {task.status === 'DONE' && blocked && (
          <div className="banner fail" style={{ marginTop: 10 }}>
            ⚠ 已標記完成，但仍有 {progress.total - progress.done} 項必辦檢核未勾選。結案前請確認，否則稽核時將構成控制未執行之證據落差。
          </div>
        )}

        <div className="card" style={{ marginTop: 14 }}>
          <h3>檢核清單<span className="sub">必辦 {progress.total} 項{o.checklist.length > progress.total && `，另有 ${o.checklist.length - progress.total} 項視情況辦理`}</span></h3>
          {o.checklist.map((def) => {
            const st = task.checklist.find((c) => c.defId === def.id)
            return (
              <label key={def.id} className={`check-item${st?.checked ? ' done' : ''}`}>
                <input
                  type="checkbox"
                  checked={!!st?.checked}
                  onChange={() => dispatch({ type: 'TOGGLE_CHECK', taskId: task.id, defId: def.id })}
                />
                <div style={{ flex: 1 }}>
                  <div className="txt">
                    {def.text}
                    {!def.required && <span className="tag" style={{ marginLeft: 6 }}>視情況</span>}
                  </div>
                  <div className="small muted">
                    <span className="tag">{TYPE_LABEL[def.type]}</span>
                    {def.control && <span className="tag">控制點 {def.control}</span>}
                    {def.hint && <span>{def.hint}</span>}
                    {st?.checked && st.checkedBy && <span>　✓ {st.checkedBy} 於 {st.checkedAt}</span>}
                  </div>
                </div>
              </label>
            )
          })}
        </div>

        <div className="card">
          <h3>權責分工</h3>
          <table>
            <tbody>
              <tr><th>主辦</th><td>{ROLE_NAMES[o.owner]}</td></tr>
              <tr><th>覆核</th><td>{ROLE_NAMES[o.reviewer]}</td></tr>
              <tr><th>核准</th><td>{ROLE_NAMES[o.approver]}</td></tr>
              <tr><th>嚴重度</th><td><Severity level={o.severity} /></td></tr>
              {o.channel && <tr><th>申報管道</th><td>{o.channel}</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>法源依據</h3>
          <ul className="legal">{o.legalBasis.map((b) => <li key={b}>{b}</li>)}</ul>
          {o.penalty && <p className="small" style={{ color: 'var(--fail)', marginBottom: 0 }}>違反效果：{o.penalty}</p>}
        </div>

        <div className="card">
          <h3>應交付成果</h3>
          <div>{o.outputs.map((x) => <span key={x} className="tag">{x}</span>)}</div>
          {o.notes && <p className="small muted" style={{ marginBottom: 0 }}>備註：{o.notes}</p>}
        </div>

        <div className="card">
          <h3>工作紀錄</h3>
          <textarea
            rows={4}
            value={task.note ?? ''}
            placeholder="記錄本期特殊事項、與會計師溝通結論、例外核准依據…"
            onChange={(e) => dispatch({ type: 'SET_TASK_FIELD', taskId: task.id, patch: { note: e.target.value } })}
          />
          {task.completedAt && <p className="small muted">完成於 {task.completedAt}　{task.completedBy}</p>}
        </div>
      </aside>
    </>
  )
}
