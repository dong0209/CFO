import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { buildCookie, parseCookies, resolveStaticPath } from './http'

const ROOT = resolve('/srv/app/dist')

describe('resolveStaticPath（路徑穿越防護）', () => {
  it('正常路徑可解析', () => {
    expect(resolveStaticPath(ROOT, '/assets/app.js')).toBe(resolve(ROOT, 'assets/app.js'))
  })

  const attacks = [
    '/../../etc/passwd',
    '/../../../../etc/shadow',
    '/assets/../../../etc/passwd',
    '/%2e%2e/%2e%2e/etc/passwd',
    '/..%2f..%2fetc%2fpasswd',
  ]
  // 安全性質：結果必須落在 root 之內（或直接拒絕）。
  // 路徑字串本身含有 etc/passwd 並不危險，被關在 root 底下就讀不到系統檔案。
  for (const a of attacks) {
    it(`阻擋 ${a}`, () => {
      const r = resolveStaticPath(ROOT, a)
      expect(r === null || r === ROOT || r.startsWith(`${ROOT}/`)).toBe(true)
      expect(r).not.toBe('/etc/passwd')
      expect(r).not.toBe('/etc/shadow')
    })
  }

  it('根路徑解析為 root 本身', () => {
    expect(resolveStaticPath(ROOT, '/')).toBe(ROOT)
  })

  it('拒絕含 NUL 位元組的路徑', () => {
    expect(resolveStaticPath(ROOT, '/app.js\0.png')).toBeNull()
  })

  it('拒絕無法解碼的百分比編碼', () => {
    expect(resolveStaticPath(ROOT, '/%E0%A4%A')).toBeNull()
  })
})

describe('cookie 處理', () => {
  it('解析多個 cookie', () => {
    expect(parseCookies('a=1; b=hello%20world; c=')).toEqual({ a: '1', b: 'hello world', c: '' })
  })

  it('沒有 cookie 標頭時回傳空物件', () => {
    expect(parseCookies(undefined)).toEqual({})
  })

  it('session cookie 帶 HttpOnly 與 SameSite=Strict', () => {
    const c = buildCookie('cfo_session', 'abc', { secure: true, maxAgeMs: 3600_000 })
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Secure')
    expect(c).toContain('Max-Age=3600')
  })

  it('未啟用 TLS 時不加 Secure（否則瀏覽器會直接丟棄 cookie）', () => {
    expect(buildCookie('cfo_session', 'abc', { secure: false })).not.toContain('Secure')
  })
})
