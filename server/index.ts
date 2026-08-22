import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { loadConfig, type Config } from './config'
import { LoginThrottle, ROLES, SessionStore, createUser, validatePassword, type Role } from './auth'
import { DataStore } from './store'
import { createApp, type Ctx } from './app'

/**
 * 啟動與 CLI
 * 與 app.ts 分離，讓測試可以直接掛載應用程式而不會啟動實際的伺服器程序。
 */

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve))
  rl.close()
  return answer
}

async function addUserCli(cfg: Config, args: string[]): Promise<void> {
  const [username, roleArg, ...nameParts] = args
  const role = (roleArg?.toUpperCase() ?? 'MEMBER') as Role
  if (!username || !ROLES.includes(role)) {
    console.error('用法：node index.mjs user:add <帳號> <ADMIN|MEMBER|VIEWER> [顯示名稱]')
    console.error('密碼可由環境變數 CFO_NEW_PASSWORD 提供，或於提示時輸入。')
    process.exit(2)
  }
  const password = process.env.CFO_NEW_PASSWORD || (await promptHidden(`請輸入 ${username} 的密碼：`))
  const err = validatePassword(password)
  if (err) {
    console.error(`✗ ${err}`)
    process.exit(2)
  }
  const store = await DataStore.open(cfg.dataDir, { seedDemo: cfg.seedDemo })
  await store.addUser(createUser(username, password, role, nameParts.join(' ') || undefined))
  console.log(`✓ 已建立帳號 ${username}（${role}）`)
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  const [command, ...args] = process.argv.slice(2)

  if (command === 'user:add') return addUserCli(cfg, args)

  const store = await DataStore.open(cfg.dataDir, { seedDemo: cfg.seedDemo })

  if (store.users.length === 0) {
    if (!cfg.bootstrapAdmin) {
      console.error(
        [
          '✗ 尚未建立任何使用者，且未提供初始管理者。',
          '  請設定環境變數 CFO_ADMIN_USER 與 CFO_ADMIN_PASSWORD 後重新啟動，',
          '  或執行：node index.mjs user:add <帳號> ADMIN',
        ].join('\n'),
      )
      process.exit(2)
    }
    const err = validatePassword(cfg.bootstrapAdmin.password)
    if (err) {
      console.error(`✗ 初始管理者密碼不符要求：${err}`)
      process.exit(2)
    }
    await store.addUser(
      createUser(cfg.bootstrapAdmin.username, cfg.bootstrapAdmin.password, 'ADMIN', cfg.bootstrapAdmin.displayName),
    )
    console.log(`✓ 已建立初始管理者 ${cfg.bootstrapAdmin.username}`)
  }

  const ctx: Ctx = {
    cfg,
    store,
    sessions: new SessionStore(cfg.sessionTtlMs),
    throttle: new LoginThrottle(cfg.loginMaxAttempts, cfg.loginWindowMs),
  }

  const server = createServer(createApp(ctx))
  server.listen(cfg.port, cfg.host, () => {
    console.log(`CFO 管理系統已啟動：http://${cfg.host}:${cfg.port}`)
    console.log(`  資料目錄：${cfg.dataDir}`)
    console.log(`  前端資源：${cfg.staticDir}`)
    console.log(`  Cookie Secure：${cfg.cookieSecure ? '開啟' : '關閉（僅適用於已由代理終結 TLS 或純測試環境）'}`)
    if (!cfg.cookieSecure) {
      console.warn('  ⚠ 正式環境請以 HTTPS 提供服務，並設定 CFO_TRUST_PROXY=1')
    }
  })

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      console.log(`\n收到 ${sig}，正在關閉…`)
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 5000).unref()
    })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
