import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { Workspace } from '../src/domain/workspace'
import { WORKSPACE_VERSION } from '../src/domain/workspace'
import { createWorkspace } from '../src/state/defaults'
import type { User } from './auth'

/**
 * 持久層
 * ------------------------------------------------------------------
 * 以檔案為儲存體，刻意不引入資料庫：
 *   - 這是單一組織、少數使用者、每日數十筆變更的內部系統
 *   - 內網部署最大的阻力是「還要架一台 DB」，檔案儲存讓部署只剩一個程序
 * 為了不在斷電或當機時毀損資料，寫入一律採「先寫暫存檔再 rename」的原子替換，
 * 並以 promise 鏈序列化寫入，避免同時寫入互相覆蓋。
 */

const WORKSPACE_FILE = 'workspace.json'
const USERS_FILE = 'users.json'
const AUDIT_FILE = 'audit.log'

export interface AuditEntry {
  ts: string
  user: string
  action: string
  target: string
  detail: string
  ip?: string
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export class DataStore {
  #workspace!: Workspace
  #users: User[] = []
  #writeChain: Promise<unknown> = Promise.resolve()

  private constructor(private readonly dir: string) {}

  static async open(dir: string, opts: { seedDemo: boolean }): Promise<DataStore> {
    const store = new DataStore(dir)
    await mkdir(dir, { recursive: true })

    const ws = await readJson<Workspace>(join(dir, WORKSPACE_FILE))
    if (ws && ws.version === WORKSPACE_VERSION) {
      store.#workspace = ws
    } else {
      if (ws) {
        // 版本不符：保留原檔以供人工遷移，不覆寫既有資料
        await rename(join(dir, WORKSPACE_FILE), join(dir, `${WORKSPACE_FILE}.v${ws.version ?? 'unknown'}.bak`))
      }
      const today = new Date().toISOString().slice(0, 10)
      store.#workspace = createWorkspace({ fiscalYear: Number(today.slice(0, 4)), today, demo: opts.seedDemo })
      await store.#persistWorkspace()
    }

    store.#users = (await readJson<User[]>(join(dir, USERS_FILE))) ?? []
    return store
  }

  get workspace(): Workspace {
    return this.#workspace
  }

  get users(): readonly User[] {
    return this.#users
  }

  findUser(username: string): User | undefined {
    return this.#users.find((u) => u.username === username.trim().toLowerCase())
  }

  findUserById(id: string): User | undefined {
    return this.#users.find((u) => u.id === id)
  }

  async setWorkspace(next: Workspace): Promise<void> {
    this.#workspace = next
    await this.#persistWorkspace()
  }

  async addUser(user: User): Promise<void> {
    if (this.findUser(user.username)) throw new Error(`帳號 ${user.username} 已存在`)
    this.#users = [...this.#users, user]
    await this.#serialize(() => this.#atomicWrite(USERS_FILE, JSON.stringify(this.#users, null, 2)))
  }

  async audit(entry: AuditEntry): Promise<void> {
    // 僅追加（append-only）：稽核軌跡不提供修改或刪除的介面
    await this.#serialize(() => appendFile(join(this.dir, AUDIT_FILE), `${JSON.stringify(entry)}\n`, 'utf8'))
  }

  /** 讀取最近 N 筆稽核紀錄（由檔尾回推，避免整份載入記憶體） */
  async recentAudit(limit: number): Promise<AuditEntry[]> {
    const path = join(this.dir, AUDIT_FILE)
    const buf: AuditEntry[] = []
    try {
      const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          buf.push(JSON.parse(line) as AuditEntry)
        } catch {
          // 單行毀損不應讓整個稽核頁面失效
        }
        if (buf.length > limit * 4) buf.splice(0, buf.length - limit * 2)
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    return buf.slice(-limit).reverse()
  }

  #persistWorkspace(): Promise<void> {
    return this.#serialize(() => this.#atomicWrite(WORKSPACE_FILE, JSON.stringify(this.#workspace)))
  }

  /** 序列化所有寫入，確保同一時間只有一個寫入者 */
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#writeChain.then(fn, fn)
    this.#writeChain = next.catch(() => {})
    return next
  }

  async #atomicWrite(name: string, content: string): Promise<void> {
    const target = join(this.dir, name)
    const tmp = `${target}.tmp`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, target) // 同一檔案系統上的 rename 是原子操作
  }
}
