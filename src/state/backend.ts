import type { Mutation } from '../domain/mutations'
import { applyMutation } from '../domain/mutations'
import { WORKSPACE_VERSION, type Workspace } from '../domain/workspace'
import { todayISO } from '../lib/date'
import { createWorkspace } from './defaults'

export type BackendMode = 'server' | 'local'
export type Role = 'ADMIN' | 'MEMBER' | 'VIEWER'

export interface SessionUser {
  username: string
  displayName: string
  role: Role
}

export interface LoadResult {
  workspace: Workspace
  user: SessionUser | null
  /** 伺服器模式以伺服器時間為準，避免用戶端時鐘影響到期判斷 */
  today: string
  /** 唯讀原因（例如以 VIEWER 身分登入） */
  readOnlyReason?: string
}

export interface AuditEntry {
  ts: string
  user: string
  action: string
  target: string
  detail: string
}

export interface Backend {
  mode: BackendMode
  load(): Promise<LoadResult>
  send(m: Mutation): Promise<void>
  login(username: string, password: string): Promise<SessionUser>
  logout(): Promise<void>
  reset(): Promise<Workspace>
  audit(limit: number): Promise<AuditEntry[]>
}

export class BackendError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message)
  }
}

/* ─────────────── 本機模式（單檔 HTML / 離線） ─────────────── */

const STORAGE_KEY = 'cfo-management-system:workspace:v1'

export class LocalBackend implements Backend {
  readonly mode = 'local' as const

  async load(): Promise<LoadResult> {
    const today = todayISO()
    let workspace: Workspace | null = null
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Workspace
        if (parsed?.version === WORKSPACE_VERSION && parsed.profile && parsed.overrides) workspace = parsed
      }
    } catch {
      // 隱私模式、儲存空間不足或資料毀損：改用初始工作區，不讓整個系統開不起來
    }
    if (!workspace) {
      workspace = createWorkspace({ fiscalYear: Number(today.slice(0, 4)), today, demo: true })
      this.#save(workspace)
    }
    return { workspace, user: null, today }
  }

  async send(): Promise<void> {
    // 本機模式的實際寫入由 persist() 完成（見 store），此處無伺服器可送
  }

  persist(ws: Workspace): boolean {
    return this.#save(ws)
  }

  async login(): Promise<SessionUser> {
    throw new BackendError('本機模式不需要登入')
  }

  async logout(): Promise<void> {}

  async reset(): Promise<Workspace> {
    const today = todayISO()
    const ws = createWorkspace({ fiscalYear: Number(today.slice(0, 4)), today, demo: true })
    this.#save(ws)
    return ws
  }

  async audit(): Promise<AuditEntry[]> {
    // 本機模式沒有伺服器端稽核軌跡；需要不可竄改的軌跡請改用伺服器部署
    return []
  }

  #save(ws: Workspace): boolean {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ws))
      return true
    } catch {
      return false
    }
  }
}

/* ─────────────── 伺服器模式（內網部署、多人共用） ─────────────── */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        // 搭配 SameSite=Strict cookie 作為 CSRF 防護：跨站表單無法帶自訂標頭
        'X-Requested-With': 'cfo-console',
        ...init?.headers,
      },
    })
  } catch {
    throw new BackendError('無法連線至伺服器')
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  if (!res.ok) throw new BackendError(String(body.error ?? `伺服器錯誤 ${res.status}`), res.status)
  return body as T
}

export class ServerBackend implements Backend {
  readonly mode = 'server' as const

  async load(): Promise<LoadResult> {
    return request<LoadResult>('/api/state')
  }

  async send(m: Mutation): Promise<void> {
    await request<void>('/api/mutate', { method: 'POST', body: JSON.stringify(m) })
  }

  async login(username: string, password: string): Promise<SessionUser> {
    const r = await request<{ user: SessionUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    return r.user
  }

  async logout(): Promise<void> {
    await request<void>('/api/auth/logout', { method: 'POST' })
  }

  async reset(): Promise<Workspace> {
    const r = await request<{ workspace: Workspace }>('/api/workspace/reset', { method: 'POST' })
    return r.workspace
  }

  async audit(limit: number): Promise<AuditEntry[]> {
    const r = await request<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`)
    return r.entries
  }
}

/**
 * 判斷執行環境。以 file:// 開啟單檔版時 fetch 會直接失敗，自動落入本機模式。
 */
export async function detectBackend(): Promise<Backend> {
  if (typeof fetch !== 'function' || location.protocol === 'file:') return new LocalBackend()
  try {
    const res = await fetch('/api/health', { credentials: 'same-origin' })
    if (res.ok) return new ServerBackend()
  } catch {
    // 沒有伺服器就是單檔/靜態部署
  }
  return new LocalBackend()
}

/** 供離線與伺服器模式共用的樂觀套用 */
export { applyMutation }
