import { resolve } from 'node:path'

/**
 * 伺服器設定 — 全部來自環境變數，方便以 Docker / systemd 部署，
 * 且不會把任何機敏值寫進映像檔或版控。
 */
export interface Config {
  host: string
  port: number
  dataDir: string
  staticDir: string
  sessionTtlMs: number
  cookieSecure: boolean
  trustProxy: boolean
  seedDemo: boolean
  bootstrapAdmin: { username: string; password: string; displayName: string } | null
  loginMaxAttempts: number
  loginWindowMs: number
}

const int = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const bool = (v: string | undefined, fallback: boolean) => {
  if (v === undefined || v === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const user = env.CFO_ADMIN_USER?.trim()
  const password = env.CFO_ADMIN_PASSWORD
  return {
    host: env.CFO_HOST || '0.0.0.0',
    port: int(env.CFO_PORT, 8080),
    dataDir: resolve(env.CFO_DATA_DIR || './data'),
    staticDir: resolve(env.CFO_STATIC_DIR || './dist'),
    sessionTtlMs: int(env.CFO_SESSION_TTL_HOURS, 12) * 3600_000,
    // 內網若由反向代理終結 TLS，應設 CFO_TRUST_PROXY=1 並保持 cookie Secure
    cookieSecure: bool(env.CFO_COOKIE_SECURE, bool(env.CFO_TRUST_PROXY, false)),
    trustProxy: bool(env.CFO_TRUST_PROXY, false),
    seedDemo: bool(env.CFO_SEED_DEMO, false),
    bootstrapAdmin: user && password ? { username: user, password, displayName: env.CFO_ADMIN_NAME || user } : null,
    loginMaxAttempts: int(env.CFO_LOGIN_MAX_ATTEMPTS, 8),
    loginWindowMs: int(env.CFO_LOGIN_WINDOW_MINUTES, 15) * 60_000,
  }
}

export const MIN_PASSWORD_LENGTH = 12
