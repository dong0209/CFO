import type { CompanyProfile, TaskStatus } from './types'
import type { HoldingState, TaskOverride, Workspace } from './workspace'
import { isEmptyOverride } from './workspace'

/**
 * 變更（Mutation）— 前端與伺服器共用的唯一變更管道
 * ------------------------------------------------------------------
 * 前端樂觀套用、伺服器權威套用，兩邊呼叫**同一個 reducer**，
 * 因此不會發生「畫面顯示成功、伺服器結果不同」這種難以追查的分歧。
 * 變更是欄位級的：兩人同時操作不同任務不會互相覆蓋整份文件。
 */

export type Mutation =
  | { kind: 'check'; taskId: string; defId: string; checked: boolean }
  | { kind: 'taskStatus'; taskId: string; status: TaskStatus }
  | { kind: 'taskField'; taskId: string; patch: { note?: string; assignee?: string } }
  | { kind: 'fiscalYear'; year: number }
  | { kind: 'profile'; profile: CompanyProfile }
  | { kind: 'holding'; patch: Partial<HoldingState> }
  | { kind: 'activeFinancial'; id: string }
  | { kind: 'financialValue'; id: string; metricId: string; value: number | null }

export interface MutationContext {
  /** 執行者顯示名稱，寫入勾稽紀錄與稽核軌跡 */
  actor: string
  /** 作業日（伺服器模式由伺服器決定，避免用戶端時鐘被竄改） */
  today: string
}

/** 需要管理者權限的變更：影響全公司設定與檢核門檻 */
export const ADMIN_MUTATIONS: Mutation['kind'][] = ['profile', 'fiscalYear', 'holding']

export function requiresAdmin(m: Mutation): boolean {
  return ADMIN_MUTATIONS.includes(m.kind)
}

function withOverride(
  ws: Workspace,
  taskId: string,
  fn: (o: TaskOverride) => TaskOverride,
): Workspace {
  const next = fn(ws.overrides[taskId] ?? {})
  const overrides = { ...ws.overrides }
  if (isEmptyOverride(next)) delete overrides[taskId]
  else overrides[taskId] = next
  return { ...ws, overrides }
}

export function applyMutation(ws: Workspace, m: Mutation, ctx: MutationContext): Workspace {
  switch (m.kind) {
    case 'check':
      return withOverride(ws, m.taskId, (o) => {
        const checks = { ...(o.checks ?? {}) }
        if (m.checked) checks[m.defId] = { checked: true, by: ctx.actor, at: ctx.today }
        else delete checks[m.defId]
        return { ...o, checks }
      })

    case 'taskStatus':
      return withOverride(ws, m.taskId, (o) => ({
        ...o,
        status: m.status,
        // 重送同一變更是冪等的；但退回後重新結案會記錄新的日期，
        // 因為那才是實際結案時點（歷次變更留存於稽核軌跡）
        completedAt: m.status === 'DONE' ? (o.completedAt ?? ctx.today) : undefined,
        completedBy: m.status === 'DONE' ? (o.completedBy ?? ctx.actor) : undefined,
      }))

    case 'taskField':
      return withOverride(ws, m.taskId, (o) => {
        const next = { ...o, ...m.patch }
        if (next.note === '') delete next.note
        if (next.assignee === '') delete next.assignee
        return next
      })

    case 'fiscalYear':
      return { ...ws, fiscalYear: m.year }

    case 'profile':
      return { ...ws, profile: m.profile }

    case 'holding':
      return { ...ws, holding: { ...ws.holding, ...m.patch } }

    case 'activeFinancial':
      return ws.financials.some((f) => f.id === m.id) ? { ...ws, activeFinancialId: m.id } : ws

    case 'financialValue':
      return {
        ...ws,
        financials: ws.financials.map((f) => {
          if (f.id !== m.id) return f
          const values = { ...f.values }
          if (m.value === null || Number.isNaN(m.value)) delete values[m.metricId]
          else values[m.metricId] = m.value
          return { ...f, values }
        }),
      }
  }
}

/** 稽核軌跡的人類可讀描述 */
export function describeMutation(m: Mutation): { target: string; detail: string } {
  switch (m.kind) {
    case 'check':
      return { target: m.taskId, detail: `${m.checked ? '勾選' : '取消勾選'}檢核項目 ${m.defId}` }
    case 'taskStatus':
      return { target: m.taskId, detail: `任務狀態改為 ${m.status}` }
    case 'taskField':
      return {
        target: m.taskId,
        detail: [
          m.patch.assignee !== undefined ? `承辦人改為「${m.patch.assignee || '（清空）'}」` : '',
          m.patch.note !== undefined ? `更新工作紀錄（${m.patch.note.length} 字）` : '',
        ].filter(Boolean).join('、'),
      }
    case 'fiscalYear':
      return { target: 'workspace', detail: `會計年度切換為 ${m.year}` }
    case 'profile':
      return { target: 'profile', detail: `更新公司資料與政策上限（${m.profile.name}）` }
    case 'holding':
      return { target: 'holding', detail: `更新董監持股資料 ${JSON.stringify(m.patch)}` }
    case 'activeFinancial':
      return { target: 'financials', detail: `檢核期別切換為 ${m.id}` }
    case 'financialValue':
      return {
        target: `financials/${m.id}`,
        detail: m.value === null ? `清除科目 ${m.metricId}` : `科目 ${m.metricId} 設為 ${m.value}`,
      }
  }
}

/** 基本結構驗證：伺服器不信任用戶端送來的任何內容 */
export function isValidMutation(v: unknown): v is Mutation {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  const str = (x: unknown) => typeof x === 'string' && x.length > 0 && x.length <= 512
  switch (m.kind) {
    case 'check':
      return str(m.taskId) && str(m.defId) && typeof m.checked === 'boolean'
    case 'taskStatus':
      return str(m.taskId) && ['NOT_STARTED', 'IN_PROGRESS', 'IN_REVIEW', 'DONE', 'NA'].includes(m.status as string)
    case 'taskField': {
      const p = m.patch as Record<string, unknown> | undefined
      if (!str(m.taskId) || !p || typeof p !== 'object') return false
      if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 20000)) return false
      if (p.assignee !== undefined && (typeof p.assignee !== 'string' || p.assignee.length > 100)) return false
      return true
    }
    case 'fiscalYear':
      return typeof m.year === 'number' && Number.isInteger(m.year) && m.year >= 1990 && m.year <= 2200
    case 'profile':
      return !!m.profile && typeof m.profile === 'object'
    case 'holding':
      return !!m.patch && typeof m.patch === 'object'
    case 'activeFinancial':
      return str(m.id)
    case 'financialValue':
      return str(m.id) && str(m.metricId) && (m.value === null || typeof m.value === 'number')
    default:
      return false
  }
}
