import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RECURRING_OBLIGATIONS } from '../domain/obligations'
import { applyMutation, requiresAdmin, type Mutation } from '../domain/mutations'
import type { Workspace } from '../domain/workspace'
import type { Task } from '../domain/types'
import { generateTasks } from '../engine/schedule'
import { applyOverrides } from '../engine/overrides'
import { todayISO } from '../lib/date'
import {
  BackendError,
  LocalBackend,
  detectBackend,
  type AuditEntry,
  type Backend,
  type BackendMode,
  type SessionUser,
} from './backend'

export type Phase = 'loading' | 'login' | 'ready' | 'error'

interface StoreValue {
  phase: Phase
  mode: BackendMode
  user: SessionUser | null
  workspace: Workspace
  tasks: Task[]
  today: string
  /** 唯讀（VIEWER 身分，或本機模式無法寫入儲存空間） */
  readOnly: boolean
  readOnlyReason?: string
  /** 最近一次同步失敗的訊息；成功後自動清除 */
  syncError?: string
  fatalError?: string
  mutate(m: Mutation): void
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>
  reset(): Promise<void>
  audit(limit: number): Promise<AuditEntry[]>
  canAdmin: boolean
}

const StoreContext = createContext<StoreValue | null>(null)

/** 尚未載入完成前提供的空殼，讓型別不需要到處判斷 null */
const EMPTY_WORKSPACE = {
  version: 1,
  profile: {
    name: '', taxId: '', stockCode: '', tier: 'LISTED', fiscalYearEndMonth: 12,
    paidInCapital: 0, hasAuditCommittee: true, consolidated: true, industry: '',
    policyLimits: { endorsementToEquityPct: 0, lendingToEquityPct: 0, singleEndorsementPct: 0 },
  },
  fiscalYear: new Date().getUTCFullYear(),
  overrides: {},
  financials: [],
  activeFinancialId: '',
  risks: [],
  holding: { parValue: 10, directorShares: 0, supervisorShares: 0, asOf: '' },
} as unknown as Workspace

export function StoreProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('loading')
  const [workspace, setWorkspace] = useState<Workspace>(EMPTY_WORKSPACE)
  const [user, setUser] = useState<SessionUser | null>(null)
  const [today, setToday] = useState(todayISO())
  const [readOnlyReason, setReadOnlyReason] = useState<string | undefined>()
  const [syncError, setSyncError] = useState<string | undefined>()
  const [fatalError, setFatalError] = useState<string | undefined>()
  const backendRef = useRef<Backend | null>(null)
  const [mode, setMode] = useState<BackendMode>('local')

  const boot = useCallback(async () => {
    setPhase('loading')
    const backend = backendRef.current ?? (await detectBackend())
    backendRef.current = backend
    setMode(backend.mode)
    try {
      const r = await backend.load()
      setWorkspace(r.workspace)
      setUser(r.user)
      setToday(r.today)
      setReadOnlyReason(r.readOnlyReason)
      if (backend instanceof LocalBackend && !backend.persist(r.workspace)) {
        setReadOnlyReason('此瀏覽器環境無法寫入本機儲存空間，關閉頁面後變更將遺失')
      }
      setPhase('ready')
    } catch (e) {
      if (e instanceof BackendError && e.status === 401) {
        setPhase('login')
        return
      }
      setFatalError(e instanceof Error ? e.message : '載入失敗')
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    void boot()
  }, [boot])

  const tasks = useMemo(() => {
    if (phase !== 'ready') return []
    const skeleton = generateTasks({
      fiscalYear: workspace.fiscalYear,
      profile: workspace.profile,
      obligations: RECURRING_OBLIGATIONS,
    })
    return applyOverrides(skeleton, workspace.overrides)
  }, [phase, workspace.fiscalYear, workspace.profile, workspace.overrides])

  const readOnly = !!readOnlyReason || user?.role === 'VIEWER'
  const canAdmin = mode === 'local' || user?.role === 'ADMIN'

  const mutate = useCallback(
    (m: Mutation) => {
      const backend = backendRef.current
      if (!backend) return
      if (user?.role === 'VIEWER') {
        setSyncError('目前為唯讀身分，無法變更資料')
        return
      }
      if (requiresAdmin(m) && mode === 'server' && user?.role !== 'ADMIN') {
        setSyncError('此項變更需要管理者權限')
        return
      }

      const actor = user?.displayName ?? '本機使用者'
      let previous: Workspace | null = null
      setWorkspace((ws) => {
        previous = ws
        return applyMutation(ws, m, { actor, today })
      })

      if (backend instanceof LocalBackend) {
        // 以 setState 之後的值寫入，避免依賴尚未更新的閉包變數
        setWorkspace((ws) => {
          if (!backend.persist(ws)) setReadOnlyReason('此瀏覽器環境無法寫入本機儲存空間，關閉頁面後變更將遺失')
          return ws
        })
        return
      }

      backend
        .send(m)
        .then(() => setSyncError(undefined))
        .catch((e: unknown) => {
          // 伺服器拒絕或斷線：回復樂觀更新，避免畫面與伺服器狀態不一致
          if (previous) setWorkspace(previous)
          if (e instanceof BackendError && e.status === 401) {
            setPhase('login')
            return
          }
          setSyncError(e instanceof Error ? e.message : '同步失敗，變更已回復')
        })
    },
    [mode, today, user],
  )

  const login = useCallback(
    async (username: string, password: string) => {
      const backend = backendRef.current
      if (!backend) throw new Error('尚未初始化')
      const u = await backend.login(username, password)
      setUser(u)
      await boot()
    },
    [boot],
  )

  const logout = useCallback(async () => {
    await backendRef.current?.logout()
    setUser(null)
    setWorkspace(EMPTY_WORKSPACE)
    setPhase('login')
  }, [])

  const reset = useCallback(async () => {
    const backend = backendRef.current
    if (!backend) return
    const ws = await backend.reset()
    setWorkspace(ws)
  }, [])

  const audit = useCallback(async (limit: number) => backendRef.current?.audit(limit) ?? [], [])

  const value = useMemo<StoreValue>(
    () => ({
      phase, mode, user, workspace, tasks, today,
      readOnly, readOnlyReason, syncError, fatalError,
      mutate, login, logout, reset, audit, canAdmin,
    }),
    [phase, mode, user, workspace, tasks, today, readOnly, readOnlyReason, syncError, fatalError, mutate, login, logout, reset, audit, canAdmin],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore 必須在 StoreProvider 內使用')
  return ctx
}

/** 目前選定財務期別 + 公司政策參數，組成檢核引擎的輸入 scope */
export function useCheckInputs(): Record<string, number> {
  const { workspace } = useStore()
  const fin = workspace.financials.find((f) => f.id === workspace.activeFinancialId) ?? workspace.financials[0]
  return useMemo(
    () => ({
      ...(fin?.values ?? {}),
      policyEndorsementPct: workspace.profile.policyLimits.endorsementToEquityPct,
      policySingleEndorsementPct: workspace.profile.policyLimits.singleEndorsementPct,
      policyLendingPct: workspace.profile.policyLimits.lendingToEquityPct,
    }),
    [fin, workspace.profile.policyLimits],
  )
}
