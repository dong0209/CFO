import type { IncomingMessage, ServerResponse } from 'node:http'
import { applyMutation, describeMutation, isValidMutation, requiresAdmin } from '../src/domain/mutations'
import { createWorkspace } from '../src/state/defaults'
import type { Config } from './config'
import { LoginThrottle, SessionStore, verifyPassword, type User } from './auth'
import { DataStore } from './store'
import {
  HttpError,
  SECURITY_HEADERS,
  buildCookie,
  clientIp,
  json,
  parseCookies,
  readJsonBody,
  serveStatic,
} from './http'

const COOKIE = 'cfo_session'

export interface Ctx {
  cfg: Config
  store: DataStore
  sessions: SessionStore
  throttle: LoginThrottle
}

const publicUser = (u: User) => ({ username: u.username, displayName: u.displayName, role: u.role })
const todayISO = () => new Date().toISOString().slice(0, 10)

function requireUser(ctx: Ctx, req: IncomingMessage): User {
  const sid = parseCookies(req.headers.cookie)[COOKIE]
  const session = ctx.sessions.get(sid)
  const user = session ? ctx.store.findUserById(session.userId) : null
  if (!user || user.disabled) throw new HttpError(401, '尚未登入或連線階段已逾期')
  return user
}

/**
 * 變更類請求必須帶自訂標頭。跨站的 <form> 送出無法設定自訂標頭，
 * 與 SameSite=Strict cookie 併用即可阻斷 CSRF。
 */
function requireSameOrigin(req: IncomingMessage): void {
  if (req.headers['x-requested-with'] !== 'cfo-console') {
    throw new HttpError(403, '缺少必要的請求標頭')
  }
}

async function handleApi(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/api/health' && method === 'GET') {
    return json(res, 200, { ok: true, mode: 'server', sessions: ctx.sessions.size })
  }

  if (path === '/api/auth/login' && method === 'POST') {
    requireSameOrigin(req)
    const body = (await readJsonBody(req)) as { username?: unknown; password?: unknown }
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const ip = clientIp(req, ctx.cfg.trustProxy)
    const key = `${ip}|${username}`

    const lockedMs = ctx.throttle.check(key)
    if (lockedMs > 0) {
      await ctx.store.audit({ ts: new Date().toISOString(), user: username || '(空白)', action: 'LOGIN_LOCKED', target: 'auth', detail: '嘗試次數過多，暫時鎖定', ip })
      throw new HttpError(429, `嘗試次數過多，請於 ${Math.ceil(lockedMs / 60000)} 分鐘後再試`)
    }

    const user = username ? ctx.store.findUser(username) : undefined
    // 帳號不存在時仍執行一次雜湊比對，避免以回應時間探測帳號是否存在
    const ok = user && !user.disabled ? verifyPassword(password, user) : verifyPassword(password, DUMMY_CREDENTIAL) && false

    if (!ok || !user) {
      ctx.throttle.fail(key)
      await ctx.store.audit({ ts: new Date().toISOString(), user: username || '(空白)', action: 'LOGIN_FAILED', target: 'auth', detail: '帳號或密碼錯誤', ip })
      throw new HttpError(401, '帳號或密碼錯誤')
    }

    ctx.throttle.succeed(key)
    const session = ctx.sessions.create(user.id)
    await ctx.store.audit({ ts: new Date().toISOString(), user: user.username, action: 'LOGIN', target: 'auth', detail: `登入成功（${user.role}）`, ip })
    return json(res, 200, { user: publicUser(user) }, {
      'Set-Cookie': buildCookie(COOKIE, session.id, { maxAgeMs: ctx.cfg.sessionTtlMs, secure: ctx.cfg.cookieSecure }),
    })
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    requireSameOrigin(req)
    const sid = parseCookies(req.headers.cookie)[COOKIE]
    const session = ctx.sessions.get(sid)
    if (session) {
      const u = ctx.store.findUserById(session.userId)
      await ctx.store.audit({ ts: new Date().toISOString(), user: u?.username ?? session.userId, action: 'LOGOUT', target: 'auth', detail: '登出', ip: clientIp(req, ctx.cfg.trustProxy) })
    }
    ctx.sessions.destroy(sid)
    return json(res, 200, { ok: true }, {
      'Set-Cookie': buildCookie(COOKIE, '', { maxAgeMs: 0, secure: ctx.cfg.cookieSecure }),
    })
  }

  if (path === '/api/state' && method === 'GET') {
    const user = requireUser(ctx, req)
    return json(res, 200, {
      workspace: ctx.store.workspace,
      user: publicUser(user),
      today: todayISO(),
      readOnlyReason: user.role === 'VIEWER' ? '目前以唯讀身分登入，可檢視但無法變更資料' : undefined,
    })
  }

  if (path === '/api/mutate' && method === 'POST') {
    requireSameOrigin(req)
    const user = requireUser(ctx, req)
    if (user.role === 'VIEWER') throw new HttpError(403, '唯讀身分無法變更資料')

    const body = await readJsonBody(req)
    if (!isValidMutation(body)) throw new HttpError(400, '變更內容格式不正確')
    if (requiresAdmin(body) && user.role !== 'ADMIN') throw new HttpError(403, '此項變更需要管理者權限')

    // 作業日一律由伺服器決定，用戶端時鐘不影響到期判斷與勾稽紀錄
    const next = applyMutation(ctx.store.workspace, body, { actor: user.displayName, today: todayISO() })
    await ctx.store.setWorkspace(next)

    const d = describeMutation(body)
    await ctx.store.audit({
      ts: new Date().toISOString(),
      user: user.username,
      action: body.kind,
      target: d.target,
      detail: d.detail,
      ip: clientIp(req, ctx.cfg.trustProxy),
    })
    return json(res, 200, { ok: true })
  }

  if (path === '/api/audit' && method === 'GET') {
    requireUser(ctx, req)
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
    return json(res, 200, { entries: await ctx.store.recentAudit(limit) })
  }

  if (path === '/api/workspace/reset' && method === 'POST') {
    requireSameOrigin(req)
    const user = requireUser(ctx, req)
    if (user.role !== 'ADMIN') throw new HttpError(403, '重設工作區需要管理者權限')
    const today = todayISO()
    const ws = createWorkspace({ fiscalYear: Number(today.slice(0, 4)), today, demo: ctx.cfg.seedDemo })
    await ctx.store.setWorkspace(ws)
    await ctx.store.audit({ ts: new Date().toISOString(), user: user.username, action: 'WORKSPACE_RESET', target: 'workspace', detail: '重設工作區資料', ip: clientIp(req, ctx.cfg.trustProxy) })
    return json(res, 200, { workspace: ws })
  }

  throw new HttpError(404, '找不到此 API')
}

/** 帳號不存在時用來耗費相同運算量的假憑證 */
const DUMMY_CREDENTIAL = { salt: '0'.repeat(32), hash: '0'.repeat(128) }

export function createApp(ctx: Ctx) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    try {
      if (url.pathname.startsWith('/api/')) {
        await handleApi(ctx, req, res, url)
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: '不支援的方法' })
      }
      const served = await serveStatic(res, ctx.cfg.staticDir, url.pathname, true)
      if (!served) {
        json(res, 404, { error: '找不到前端資源，請先執行 npm run build 產生 dist/' })
      }
    } catch (e) {
      if (e instanceof HttpError) return json(res, e.status, { error: e.message })
      console.error('[cfo] 未預期的錯誤', e)
      // 對外不洩漏堆疊或內部路徑
      json(res, 500, { error: '伺服器內部錯誤' })
    }
  }
}
