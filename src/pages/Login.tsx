import { useState, type FormEvent } from 'react'
import { useStore } from '../state/store'

export function Login() {
  const { login } = useStore()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(username, password)
    } catch (err) {
      setError(err instanceof Error ? err.message : '登入失敗')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={onSubmit}>
        <h1>CFO 管理系統</h1>
        <p className="muted small">公開發行公司財務長工作台</p>
        <div className="field">
          <label htmlFor="u">帳號</label>
          <input id="u" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="p">密碼</label>
          <input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="banner fail" style={{ marginBottom: 10 }}>{error}</div>}
        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', padding: '8px' }}>
          {busy ? '登入中…' : '登入'}
        </button>
        <p className="small muted" style={{ marginTop: 12, marginBottom: 0 }}>
          本系統含財務與法遵資料，請勿共用帳號。連線應經 HTTPS；如為內網部署，請由反向代理負責 TLS 終結。
        </p>
      </form>
    </div>
  )
}
