import { useEffect, useMemo, useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { Calendar } from './pages/Calendar'
import { Obligations } from './pages/Obligations'
import { Checks } from './pages/Checks'
import { Governance } from './pages/Governance'
import { Risks } from './pages/Risks'
import { Settings } from './pages/Settings'
import { Login } from './pages/Login'
import { useStore } from './state/store'
import { taskHealth } from './engine/health'

type PageId = 'dashboard' | 'calendar' | 'obligations' | 'checks' | 'governance' | 'risks' | 'settings'

const PAGES: { id: PageId; icon: string; label: string }[] = [
  { id: 'dashboard', icon: '◈', label: '工作台' },
  { id: 'calendar', icon: '▤', label: '法遵行事曆' },
  { id: 'checks', icon: '⊘', label: '財務檢核' },
  { id: 'governance', icon: '⚖', label: '公司治理檢核' },
  { id: 'risks', icon: '△', label: '風險登錄簿' },
  { id: 'obligations', icon: '☰', label: '職能與義務主檔' },
  { id: 'settings', icon: '⚙', label: '設定' },
]

const PAGE_IDS = PAGES.map((p) => p.id)

function pageFromHash(): PageId {
  const h = window.location.hash.replace('#', '') as PageId
  return PAGE_IDS.includes(h) ? h : 'dashboard'
}

export default function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)
  const { phase, mode, user, workspace, tasks, today, syncError, fatalError, readOnly, readOnlyReason } = useStore()

  // 以 hash 同步頁面，讓分頁可被書籤/連結引用，瀏覽器上一頁也能運作
  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const go = (id: PageId) => {
    window.location.hash = id
    setPage(id)
  }

  const overdue = useMemo(() => tasks.filter((t) => taskHealth(t, today) === 'OVERDUE').length, [tasks, today])

  if (phase === 'loading') {
    return <div className="boot">載入中…</div>
  }
  if (phase === 'login') {
    return <Login />
  }
  if (phase === 'error') {
    return (
      <div className="boot">
        <div className="card" style={{ maxWidth: 460 }}>
          <h3>系統無法載入</h3>
          <p className="small">{fatalError}</p>
          <button className="btn" onClick={() => location.reload()}>重新載入</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          <h1>CFO 管理系統</h1>
          <p>公開發行公司財務長工作台</p>
        </div>
        <div className="nav">
          {PAGES.map((p) => (
            <button key={p.id} className={p.id === page ? 'active' : ''} onClick={() => go(p.id)}>
              <span style={{ width: 16, display: 'inline-block' }}>{p.icon}</span>
              {p.label}
              {p.id === 'dashboard' && overdue > 0 && <span className="badge">{overdue}</span>}
            </button>
          ))}
        </div>
        <div className="small muted" style={{ padding: '12px 10px 0', borderTop: '1px solid var(--border)', marginTop: 12 }}>
          {workspace.profile.name}
          <br />
          {workspace.fiscalYear} 會計年度
          <br />
          基準日 {today}
          <div style={{ marginTop: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            <span className="pill ghost">{mode === 'server' ? '伺服器模式' : '本機模式'}</span>
            {user && <span className="pill ghost">{user.displayName}</span>}
            {readOnly && <span className="pill" style={{ background: 'rgba(220,38,38,.12)', color: 'var(--fail)' }}>唯讀</span>}
          </div>
        </div>
      </nav>

      <main className="main">
        {syncError && <div className="banner fail">同步問題：{syncError}</div>}
        {readOnlyReason && <div className="banner info">{readOnlyReason}</div>}
        {page === 'dashboard' && <Dashboard />}
        {page === 'calendar' && <Calendar />}
        {page === 'checks' && <Checks />}
        {page === 'governance' && <Governance />}
        {page === 'risks' && <Risks />}
        {page === 'obligations' && <Obligations />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
