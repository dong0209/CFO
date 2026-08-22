import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const MAX_BODY_BYTES = 1_000_000

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  })
  res.end(payload)
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, '請求內容過大')
    chunks.push(chunk as Buffer)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '請求內容不是合法的 JSON')
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

export function buildCookie(
  name: string,
  value: string,
  opts: { maxAgeMs?: number; secure: boolean; path?: string },
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    'HttpOnly',
    // Strict：跨站請求完全不帶 cookie，配合自訂標頭即可擋下 CSRF
    'SameSite=Strict',
  ]
  if (opts.secure) parts.push('Secure')
  if (opts.maxAgeMs !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`)
  return parts.join('; ')
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for']
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]
    if (first?.trim()) return first.trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}

/* ─────────────── 靜態檔案 ─────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 解析靜態檔路徑，並確保結果仍位於 root 之內。
 * 直接把 URL 接到路徑上會被 `..` 或編碼過的路徑穿越攻擊讀走伺服器上的任意檔案。
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const rel = normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = resolve(join(root, rel))
  const rootResolved = resolve(root)
  if (full !== rootResolved && !full.startsWith(rootResolved + sep)) return null
  return full
}

export async function serveStatic(
  res: ServerResponse,
  root: string,
  urlPath: string,
  fallbackToIndex: boolean,
): Promise<boolean> {
  let file = resolveStaticPath(root, urlPath === '/' ? '/index.html' : urlPath)
  if (!file) {
    json(res, 400, { error: '路徑不合法' })
    return true
  }

  let info = await stat(file).catch(() => null)
  if (info?.isDirectory()) {
    file = join(file, 'index.html')
    info = await stat(file).catch(() => null)
  }
  if (!info?.isFile()) {
    if (!fallbackToIndex) return false
    file = join(root, 'index.html')
    info = await stat(file).catch(() => null)
    if (!info?.isFile()) return false
  }

  const ext = extname(file).toLowerCase()
  const isEntry = file.endsWith('index.html')
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // 帶雜湊檔名的資產可長期快取；入口 HTML 必須每次重新驗證，否則改版不會生效
    'Cache-Control': isEntry ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(file).pipe(res)
  return true
}

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // React 以 style 屬性套用行內樣式，因此 style-src 需要 unsafe-inline；
  // script 一律為同源外部檔案，不允許行內腳本
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
}
