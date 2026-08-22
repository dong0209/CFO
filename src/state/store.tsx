import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import type { CompanyProfile, FinancialPeriod, RiskItem, Task, TaskStatus } from '../domain/types'
import { RECURRING_OBLIGATIONS } from '../domain/obligations'
import { generateTasks, mergeTasks } from '../engine/schedule'
import { todayISO, type ISODate } from '../lib/date'
import { applyDemoProgress, DEFAULT_HOLDING, DEFAULT_PROFILE, SEED_FINANCIALS, SEED_RISKS, type HoldingState } from './seed'

const STORAGE_KEY = 'cfo-management-system:v1'

export interface AppState {
  profile: CompanyProfile
  fiscalYear: number
  tasks: Task[]
  financials: FinancialPeriod[]
  activeFinancialId: string
  risks: RiskItem[]
  holding: HoldingState
  /** 可覆寫「今天」，便於情境演練與教育訓練 */
  today: ISODate
  currentUser: string
}

type Action =
  | { type: 'TOGGLE_CHECK'; taskId: string; defId: string }
  | { type: 'SET_TASK_STATUS'; taskId: string; status: TaskStatus }
  | { type: 'SET_TASK_FIELD'; taskId: string; patch: Partial<Pick<Task, 'note' | 'assignee'>> }
  | { type: 'SET_FISCAL_YEAR'; year: number }
  | { type: 'SET_PROFILE'; profile: CompanyProfile }
  | { type: 'SET_TODAY'; today: ISODate }
  | { type: 'SET_USER'; user: string }
  | { type: 'SET_ACTIVE_FINANCIAL'; id: string }
  | { type: 'SET_HOLDING'; patch: Partial<HoldingState> }
  | { type: 'SET_FINANCIAL_VALUE'; id: string; metricId: string; value: number | undefined }
  | { type: 'REGENERATE' }
  | { type: 'RESET' }

function buildTasks(fiscalYear: number, profile: CompanyProfile, existing: Task[] = []): Task[] {
  const generated = generateTasks({ fiscalYear, profile, obligations: RECURRING_OBLIGATIONS })
  return existing.length ? mergeTasks(existing, generated, RECURRING_OBLIGATIONS) : generated
}

function initialState(): AppState {
  const today = todayISO()
  const fiscalYear = Number(today.slice(0, 4))
  const profile = DEFAULT_PROFILE
  return {
    profile,
    fiscalYear,
    tasks: applyDemoProgress(buildTasks(fiscalYear, profile), today),
    financials: SEED_FINANCIALS,
    activeFinancialId: SEED_FINANCIALS[0].id,
    risks: SEED_RISKS,
    holding: DEFAULT_HOLDING,
    today,
    currentUser: '財務長',
  }
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'TOGGLE_CHECK':
      return {
        ...state,
        tasks: state.tasks.map((t) => {
          if (t.id !== action.taskId) return t
          const checklist = t.checklist.map((c) =>
            c.defId === action.defId
              ? c.checked
                ? { defId: c.defId, checked: false, remark: c.remark }
                : { ...c, checked: true, checkedBy: state.currentUser, checkedAt: state.today }
              : c,
          )
          return { ...t, checklist }
        }),
      }

    case 'SET_TASK_STATUS':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.taskId
            ? {
                ...t,
                status: action.status,
                completedAt: action.status === 'DONE' ? (t.completedAt ?? state.today) : undefined,
                completedBy: action.status === 'DONE' ? (t.completedBy ?? state.currentUser) : undefined,
              }
            : t,
        ),
      }

    case 'SET_TASK_FIELD':
      return { ...state, tasks: state.tasks.map((t) => (t.id === action.taskId ? { ...t, ...action.patch } : t)) }

    case 'SET_FISCAL_YEAR':
      return { ...state, fiscalYear: action.year, tasks: buildTasks(action.year, state.profile, state.tasks) }

    case 'SET_PROFILE':
      return { ...state, profile: action.profile, tasks: buildTasks(state.fiscalYear, action.profile, state.tasks) }

    case 'SET_TODAY':
      return { ...state, today: action.today }

    case 'SET_USER':
      return { ...state, currentUser: action.user }

    case 'SET_ACTIVE_FINANCIAL':
      return { ...state, activeFinancialId: action.id }

    case 'SET_HOLDING':
      return { ...state, holding: { ...state.holding, ...action.patch } }

    case 'SET_FINANCIAL_VALUE':
      return {
        ...state,
        financials: state.financials.map((f) => {
          if (f.id !== action.id) return f
          const values = { ...f.values }
          if (action.value === undefined || Number.isNaN(action.value)) delete values[action.metricId]
          else values[action.metricId] = action.value
          return { ...f, values }
        }),
      }

    case 'REGENERATE':
      return { ...state, tasks: buildTasks(state.fiscalYear, state.profile, state.tasks) }

    case 'RESET':
      return initialState()
  }
}

function load(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialState()
    const parsed = JSON.parse(raw) as AppState
    // 主檔可能已更新（新增義務/檢核項目），載入時重新展開並合併使用者狀態
    return { ...initialState(), ...parsed, tasks: buildTasks(parsed.fiscalYear, parsed.profile, parsed.tasks ?? []) }
  } catch {
    return initialState()
  }
}

interface Ctx {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const StoreContext = createContext<Ctx | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, load)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // 儲存空間不足或隱私模式：僅影響持久化，不影響當次操作
    }
  }, [state])

  const value = useMemo(() => ({ state, dispatch }), [state])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): Ctx {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore 必須在 StoreProvider 內使用')
  return ctx
}

/** 目前選定財務期別 + 公司政策參數，組成檢核引擎的輸入 scope */
export function useCheckInputs(): Record<string, number> {
  const { state } = useStore()
  const fin = state.financials.find((f) => f.id === state.activeFinancialId) ?? state.financials[0]
  return useMemo(
    () => ({
      ...(fin?.values ?? {}),
      policyEndorsementPct: state.profile.policyLimits.endorsementToEquityPct,
      policySingleEndorsementPct: state.profile.policyLimits.singleEndorsementPct,
      policyLendingPct: state.profile.policyLimits.lendingToEquityPct,
    }),
    [fin, state.profile.policyLimits],
  )
}
