import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { MIN_PASSWORD_LENGTH } from './config'

/**
 * 認證
 * ------------------------------------------------------------------
 * - 密碼以 scrypt 加鹽雜湊儲存，永不明文落地
 * - 比對使用 timingSafeEqual，避免以回應時間反推密碼
 * - Session 僅存於記憶體：重啟即失效，是刻意的取捨（避免可長期重放的憑證落盤）
 */

export type Role = 'ADMIN' | 'MEMBER' | 'VIEWER'
export const ROLES: Role[] = ['ADMIN', 'MEMBER', 'VIEWER']

export interface User {
  id: string
  username: string
  displayName: string
  role: Role
  salt: string
  hash: string
  createdAt: string
  disabled?: boolean
}

const SCRYPT_KEYLEN = 64

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex') }
}

export function verifyPassword(password: string, user: Pick<User, 'salt' | 'hash'>): boolean {
  const candidate = scryptSync(password, user.salt, SCRYPT_KEYLEN)
  const expected = Buffer.from(user.hash, 'hex')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密碼長度至少需 ${MIN_PASSWORD_LENGTH} 個字元`
  }
  return null
}

export function createUser(username: string, password: string, role: Role, displayName?: string): User {
  const { salt, hash } = hashPassword(password)
  return {
    id: randomUUID(),
    username: username.toLowerCase(),
    displayName: displayName || username,
    role,
    salt,
    hash,
    createdAt: new Date().toISOString(),
  }
}

/* ─────────────── Session ─────────────── */

export interface Session {
  id: string
  userId: string
  createdAt: number
  expiresAt: number
}

export class SessionStore {
  #sessions = new Map<string, Session>()

  constructor(private readonly ttlMs: number) {}

  create(userId: string): Session {
    this.#sweep()
    const now = Date.now()
    const s: Session = { id: randomBytes(32).toString('hex'), userId, createdAt: now, expiresAt: now + this.ttlMs }
    this.#sessions.set(s.id, s)
    return s
  }

  get(id: string | undefined): Session | null {
    if (!id) return null
    const s = this.#sessions.get(id)
    if (!s) return null
    if (s.expiresAt <= Date.now()) {
      this.#sessions.delete(id)
      return null
    }
    return s
  }

  destroy(id: string | undefined): void {
    if (id) this.#sessions.delete(id)
  }

  /** 使用者停用或刪除時，一併終止其所有 session */
  destroyForUser(userId: string): void {
    for (const [id, s] of this.#sessions) if (s.userId === userId) this.#sessions.delete(id)
  }

  get size(): number {
    return this.#sessions.size
  }

  #sweep(): void {
    const now = Date.now()
    for (const [id, s] of this.#sessions) if (s.expiresAt <= now) this.#sessions.delete(id)
  }
}

/* ─────────────── 登入嘗試節流 ─────────────── */

export class LoginThrottle {
  #attempts = new Map<string, { count: number; first: number }>()

  constructor(private readonly max: number, private readonly windowMs: number) {}

  /** 回傳剩餘鎖定毫秒數；0 代表可以嘗試 */
  check(key: string): number {
    const rec = this.#attempts.get(key)
    if (!rec) return 0
    const elapsed = Date.now() - rec.first
    if (elapsed > this.windowMs) {
      this.#attempts.delete(key)
      return 0
    }
    return rec.count >= this.max ? this.windowMs - elapsed : 0
  }

  fail(key: string): void {
    const rec = this.#attempts.get(key)
    if (!rec || Date.now() - rec.first > this.windowMs) this.#attempts.set(key, { count: 1, first: Date.now() })
    else rec.count++
  }

  succeed(key: string): void {
    this.#attempts.delete(key)
  }
}
