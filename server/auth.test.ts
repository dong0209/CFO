import { describe, expect, it, vi } from 'vitest'
import { LoginThrottle, SessionStore, createUser, hashPassword, validatePassword, verifyPassword } from './auth'

describe('密碼雜湊', () => {
  it('相同密碼加不同鹽會產生不同雜湊', () => {
    const a = hashPassword('Correct-Horse-Battery-1')
    const b = hashPassword('Correct-Horse-Battery-1')
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
  })

  it('正確密碼驗證通過、錯誤密碼失敗', () => {
    const u = createUser('cfo', 'Correct-Horse-Battery-1', 'ADMIN')
    expect(verifyPassword('Correct-Horse-Battery-1', u)).toBe(true)
    expect(verifyPassword('correct-horse-battery-1', u)).toBe(false)
    expect(verifyPassword('', u)).toBe(false)
  })

  it('不會儲存明文密碼', () => {
    const u = createUser('cfo', 'Correct-Horse-Battery-1', 'ADMIN')
    expect(JSON.stringify(u)).not.toContain('Correct-Horse-Battery-1')
  })

  it('帳號一律轉小寫，避免同名不同大小寫的重複帳號', () => {
    expect(createUser('CFO', 'Correct-Horse-Battery-1', 'ADMIN').username).toBe('cfo')
  })

  it('拒絕過短的密碼', () => {
    expect(validatePassword('short')).toMatch(/至少/)
    expect(validatePassword('Correct-Horse-Battery-1')).toBeNull()
  })
})

describe('SessionStore', () => {
  it('建立的 session 可取回', () => {
    const s = new SessionStore(3600_000)
    const session = s.create('user-1')
    expect(s.get(session.id)?.userId).toBe('user-1')
  })

  it('session id 具足夠亂度且互不重複', () => {
    const s = new SessionStore(3600_000)
    const ids = new Set(Array.from({ length: 200 }, () => s.create('u').id))
    expect(ids.size).toBe(200)
    expect([...ids][0]).toHaveLength(64) // 32 bytes hex
  })

  it('逾期的 session 會被拒絕並清除', () => {
    vi.useFakeTimers()
    try {
      const s = new SessionStore(1000)
      const session = s.create('user-1')
      vi.advanceTimersByTime(1001)
      expect(s.get(session.id)).toBeNull()
      expect(s.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('登出會使 session 失效', () => {
    const s = new SessionStore(3600_000)
    const session = s.create('user-1')
    s.destroy(session.id)
    expect(s.get(session.id)).toBeNull()
  })

  it('停用使用者可一次終止其所有連線階段', () => {
    const s = new SessionStore(3600_000)
    const a = s.create('user-1')
    const b = s.create('user-1')
    const other = s.create('user-2')
    s.destroyForUser('user-1')
    expect(s.get(a.id)).toBeNull()
    expect(s.get(b.id)).toBeNull()
    expect(s.get(other.id)).not.toBeNull()
  })

  it('未帶 session id 時回傳 null', () => {
    expect(new SessionStore(1000).get(undefined)).toBeNull()
  })
})

describe('LoginThrottle', () => {
  it('達到上限後鎖定', () => {
    const t = new LoginThrottle(3, 60_000)
    const key = '10.0.0.1|cfo'
    expect(t.check(key)).toBe(0)
    t.fail(key); t.fail(key)
    expect(t.check(key)).toBe(0)
    t.fail(key)
    expect(t.check(key)).toBeGreaterThan(0)
  })

  it('登入成功會清除計數', () => {
    const t = new LoginThrottle(2, 60_000)
    t.fail('k'); t.fail('k')
    expect(t.check('k')).toBeGreaterThan(0)
    t.succeed('k')
    expect(t.check('k')).toBe(0)
  })

  it('時間窗過後自動解除', () => {
    vi.useFakeTimers()
    try {
      const t = new LoginThrottle(1, 1000)
      t.fail('k')
      expect(t.check('k')).toBeGreaterThan(0)
      vi.advanceTimersByTime(1001)
      expect(t.check('k')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('不同來源互不影響', () => {
    const t = new LoginThrottle(1, 60_000)
    t.fail('10.0.0.1|cfo')
    expect(t.check('10.0.0.2|cfo')).toBe(0)
  })
})
