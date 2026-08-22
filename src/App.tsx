import { useEffect, useMemo, useState } from 'react'
import { Dashboard } from './pages/Dashboard'
import { Calendar } from './pages/Calendar'
import { Obligations } from './pages/Obligations'
import { Checks } from './pages/Checks'
import { Governance } from './pages/Governance'
import { Risks } from './pages/Risks'
import { Settings } from './pages/Settings'
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
  const { state } = useStore()

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

  const overdue = useMemo(
    () => state.tasks.filter((t) => taskHealth(t, state.today) === 'OVERDUE').length,
    [state.tasks, state.today],
  )

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
        <p className="small muted" style={{ padding: '12px 10px 0', borderTop: '1px solid var(--border)', marginTop: 12 }}>
          {state.profile.name}
          <br />
          {state.fiscalYear} 會計年度
          <br />
          基準日 {state.today}
        </p>
      </nav>

      <main className="main">
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
