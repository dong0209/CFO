import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createApp, type Ctx } from './app'
import { LoginThrottle, SessionStore, createUser } from './auth'
import { DataStore } from './store'
import { loadConfig } from './config'

const PASSWORD = 'Very-Long-Test-Password-1'

let server: Server
let base: string
let dir: string
let store: DataStore

const call = (path: string, init: RequestInit = {}) =>
  fetch(base + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    redirect: 'manual',
  })

/** 帶上 CSRF 所需的自訂標頭 */
const csrf = (extra: Record<string, string> = {}) => ({ 'X-Requested-With': 'cfo-console', ...extra })

async function loginAs(username: string): Promise<string> {
  const res = await call('/api/auth/login', {
    method: 'POST',
    headers: csrf(),
    body: JSON.stringify({ username, password: PASSWORD }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('set-cookie')!.split(';')[0]
  return cookie
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cfo-test-'))
  store = await DataStore.open(dir, { seedDemo: false })
  await store.addUser(createUser('admin', PASSWORD, 'ADMIN', '總管理者'))
  await store.addUser(createUser('member', PASSWORD, 'MEMBER', '會計主管'))
  await store.addUser(createUser('viewer', PASSWORD, 'VIEWER', '稽核'))

  const cfg = { ...loadConfig({}), dataDir: dir, staticDir: join(dir, 'static'), cookieSecure: false }
  const ctx: Ctx = {
    cfg,
    store,
    sessions: new SessionStore(cfg.sessionTtlMs),
    throttle: new LoginThrottle(50, 60_000), // 測試期間放寬，節流本身另有單元測試
  }
  server = createServer(createApp(ctx))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await rm(dir, { recursive: true, force: true })
})

describe('健康檢查', () => {
  it('不需登入即可查詢，供負載平衡器與監控使用', async () => {
    const res = await call('/api/health')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: 'server' })
  })
})

describe('認證', () => {
  it('未登入無法讀取工作區', async () => {
    const res = await call('/api/state')
    expect(res.status).toBe(401)
  })

  it('錯誤密碼被拒絕，且不透露帳號是否存在', async () => {
    const wrongPw = await call('/api/auth/login', { method: 'POST', headers: csrf(), body: JSON.stringify({ username: 'admin', password: 'wrong-password' }) })
    const noUser = await call('/api/auth/login', { method: 'POST', headers: csrf(), body: JSON.stringify({ username: '不存在的人', password: 'wrong-password' }) })
    expect(wrongPw.status).toBe(401)
    expect(noUser.status).toBe(401)
    expect(await wrongPw.json()).toEqual(await noUser.json())
  })

  it('登入成功會發出 HttpOnly 的 session cookie', async () => {
    const res = await call('/api/auth/login', { method: 'POST', headers: csrf(), body: JSON.stringify({ username: 'admin', password: PASSWORD }) })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('set-cookie')!
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    await expect(res.json()).resolves.toMatchObject({ user: { username: 'admin', role: 'ADMIN' } })
  })

  it('帳號大小寫不影響登入', async () => {
    const res = await call('/api/auth/login', { method: 'POST', headers: csrf(), body: JSON.stringify({ username: 'ADMIN', password: PASSWORD }) })
    expect(res.status).toBe(200)
  })

  it('登出後 session 立即失效', async () => {
    const cookie = await loginAs('member')
    expect((await call('/api/state', { headers: { cookie } })).status).toBe(200)
    await call('/api/auth/logout', { method: 'POST', headers: csrf({ cookie }) })
    expect((await call('/api/state', { headers: { cookie } })).status).toBe(401)
  })

  it('偽造的 session id 無效', async () => {
    const res = await call('/api/state', { headers: { cookie: `cfo_session=${'a'.repeat(64)}` } })
    expect(res.status).toBe(401)
  })
})

describe('CSRF 防護', () => {
  it('缺少自訂標頭的變更請求被拒絕', async () => {
    const cookie = await loginAs('member')
    const res = await call('/api/mutate', {
      method: 'POST',
      headers: { cookie }, // 故意不帶 X-Requested-With
      body: JSON.stringify({ kind: 'taskStatus', taskId: 'T::1', status: 'DONE' }),
    })
    expect(res.status).toBe(403)
  })

  it('登入請求同樣需要自訂標頭', async () => {
    const res = await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) })
    expect(res.status).toBe(403)
  })
})

describe('變更與權限', () => {
  it('一般使用者可更新任務狀態，且變更確實落地', async () => {
    const cookie = await loginAs('member')
    const taskId = 'RPT-MONTHLY-REVENUE::2026-01'
    const res = await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'taskStatus', taskId, status: 'DONE' }),
    })
    expect(res.status).toBe(200)

    const state = await (await call('/api/state', { headers: { cookie } })).json()
    expect(state.workspace.overrides[taskId]).toMatchObject({ status: 'DONE', completedBy: '會計主管' })
  })

  it('勾稽紀錄署名為伺服器認定的使用者，不採信用戶端宣稱', async () => {
    const cookie = await loginAs('member')
    const taskId = 'RPT-MONTHLY-REVENUE::2026-02'
    await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'check', taskId, defId: 'X#01', checked: true, actor: '偽造的人' }),
    })
    const state = await (await call('/api/state', { headers: { cookie } })).json()
    expect(state.workspace.overrides[taskId].checks['X#01'].by).toBe('會計主管')
  })

  it('一般使用者不能修改公司設定', async () => {
    const cookie = await loginAs('member')
    const res = await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'profile', profile: { ...store.workspace.profile, name: '被竄改' } }),
    })
    expect(res.status).toBe(403)
    expect(store.workspace.profile.name).not.toBe('被竄改')
  })

  it('管理者可以修改公司設定', async () => {
    const cookie = await loginAs('admin')
    const res = await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'profile', profile: { ...store.workspace.profile, name: '新名稱股份有限公司' } }),
    })
    expect(res.status).toBe(200)
    expect(store.workspace.profile.name).toBe('新名稱股份有限公司')
  })

  it('唯讀身分無法進行任何變更', async () => {
    const cookie = await loginAs('viewer')
    const res = await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'taskStatus', taskId: 'X::1', status: 'DONE' }),
    })
    expect(res.status).toBe(403)
  })

  it('唯讀身分讀取狀態時會收到唯讀原因', async () => {
    const cookie = await loginAs('viewer')
    const state = await (await call('/api/state', { headers: { cookie } })).json()
    expect(state.readOnlyReason).toBeTruthy()
    expect(state.user.role).toBe('VIEWER')
  })

  it('格式不正確的變更被拒絕', async () => {
    const cookie = await loginAs('admin')
    for (const bad of [{ kind: 'dropDatabase' }, { kind: 'taskStatus', taskId: 'a', status: 'HACKED' }, { kind: 'fiscalYear', year: 999999 }]) {
      const res = await call('/api/mutate', { method: 'POST', headers: csrf({ cookie }), body: JSON.stringify(bad) })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
  })

  it('非 JSON 內容回傳 400 而不是 500', async () => {
    const cookie = await loginAs('admin')
    const res = await call('/api/mutate', { method: 'POST', headers: csrf({ cookie }), body: '{ 這不是 JSON' })
    expect(res.status).toBe(400)
  })
})

describe('稽核軌跡', () => {
  it('登入與變更都被記錄，且包含使用者與可讀描述', async () => {
    const cookie = await loginAs('admin')
    await call('/api/mutate', {
      method: 'POST',
      headers: csrf({ cookie }),
      body: JSON.stringify({ kind: 'fiscalYear', year: 2027 }),
    })
    const { entries } = await (await call('/api/audit?limit=50', { headers: { cookie } })).json()
    expect(entries[0]).toMatchObject({ user: 'admin', action: 'fiscalYear' })
    expect(entries[0].detail).toContain('2027')
    expect(entries.some((e: { action: string }) => e.action === 'LOGIN')).toBe(true)
    expect(entries.some((e: { action: string }) => e.action === 'LOGIN_FAILED')).toBe(true)
  })

  it('稽核紀錄以最新在前排列', async () => {
    const cookie = await loginAs('admin')
    const { entries } = await (await call('/api/audit?limit=10', { headers: { cookie } })).json()
    const ts = entries.map((e: { ts: string }) => e.ts)
    expect([...ts].sort().reverse()).toEqual(ts)
  })

  it('未登入無法讀取稽核軌跡', async () => {
    expect((await call('/api/audit')).status).toBe(401)
  })
})

describe('安全標頭', () => {
  it('每個回應都帶上安全標頭', async () => {
    const res = await call('/api/health')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
  })

  it('API 回應不得被快取', async () => {
    const res = await call('/api/health')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('持久化', () => {
  it('重新開啟資料目錄後仍讀得到先前的變更', async () => {
    const reopened = await DataStore.open(dir, { seedDemo: false })
    expect(reopened.workspace.profile.name).toBe('新名稱股份有限公司')
    expect(reopened.workspace.overrides['RPT-MONTHLY-REVENUE::2026-01'].status).toBe('DONE')
    expect(reopened.users.map((u) => u.username).sort()).toEqual(['admin', 'member', 'viewer'])
  })

  it('未知的 API 路徑回傳 404', async () => {
    expect((await call('/api/does-not-exist')).status).toBe(404)
  })
})
