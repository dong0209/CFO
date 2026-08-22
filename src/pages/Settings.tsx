import { useEffect, useState } from 'react'
import { HOLIDAYS } from '../lib/date'
import { OBLIGATIONS, RECURRING_OBLIGATIONS } from '../domain/obligations'
import { CHECK_RULES } from '../domain/rules'
import { METRICS } from '../domain/metrics'
import { overrideStats } from '../engine/overrides'
import { useStore } from '../state/store'
import type { AuditEntry } from '../state/backend'
import type { CompanyProfile, ListingTier } from '../domain/types'

const TIER_LABEL: Record<ListingTier, string> = {
  PUBLIC: '公開發行（非上市櫃）',
  EMERGING: '興櫃',
  OTC: '上櫃',
  LISTED: '上市',
}

const ROLE_LABEL: Record<string, string> = {
  ADMIN: '管理者（可修改公司設定與政策門檻）',
  MEMBER: '一般使用者（可執行與勾稽任務）',
  VIEWER: '唯讀',
}

export function Settings() {
  const { workspace, mutate, mode, user, logout, reset, audit, canAdmin, readOnly, readOnlyReason } = useStore()
  const p = workspace.profile
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [loadingAudit, setLoadingAudit] = useState(false)

  const set = (patch: Partial<CompanyProfile>) => mutate({ kind: 'profile', profile: { ...p, ...patch } })
  const setLimit = (patch: Partial<CompanyProfile['policyLimits']>) =>
    mutate({ kind: 'profile', profile: { ...p, policyLimits: { ...p.policyLimits, ...patch } } })

  useEffect(() => {
    if (mode !== 'server') return
    setLoadingAudit(true)
    audit(100).then(setEntries).catch(() => setEntries([])).finally(() => setLoadingAudit(false))
  }, [mode, audit])

  const stats = overrideStats(workspace)

  return (
    <>
      <div className="page-head">
        <h2>設定</h2>
        <p>公司屬性會直接影響義務適用範圍與到期日推算；政策上限會直接成為檢核規則的門檻。</p>
      </div>

      <div className="card">
        <h3>執行模式</h3>
        <div className="grid cols-4">
          <div className="stat">
            <div className="label">部署形態</div>
            <div className="value" style={{ fontSize: 20 }}>{mode === 'server' ? '伺服器' : '本機單機'}</div>
            <div className="hint">
              {mode === 'server' ? '資料存於伺服器，多人共用並記錄稽核軌跡' : '資料僅存於此瀏覽器，不會離開這台電腦'}
            </div>
          </div>
          <div className="stat">
            <div className="label">目前使用者</div>
            <div className="value" style={{ fontSize: 20 }}>{user ? user.displayName : '（未登入）'}</div>
            <div className="hint">{user ? ROLE_LABEL[user.role] : '本機模式不需登入'}</div>
          </div>
          <div className="stat">
            <div className="label">累積作業紀錄</div>
            <div className="value" style={{ fontSize: 20 }}>{stats.tasks}</div>
            <div className="hint">已有紀錄的任務數，含 {stats.checks} 個已勾稽檢核項目</div>
          </div>
          <div className="stat">
            <div className="label">寫入權限</div>
            <div className="value" style={{ fontSize: 20, color: readOnly ? 'var(--fail)' : 'var(--ok)' }}>
              {readOnly ? '唯讀' : '可編輯'}
            </div>
            <div className="hint">{readOnlyReason ?? (canAdmin ? '含管理者權限' : '一般作業權限')}</div>
          </div>
        </div>
        {mode === 'server' && (
          <div style={{ marginTop: 10 }}>
            <button className="btn" onClick={() => void logout()}>登出</button>
          </div>
        )}
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>公司基本資料{!canAdmin && <span className="sub">需管理者權限</span>}</h3>
          <fieldset disabled={!canAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="field"><label>公司名稱</label><input value={p.name} onChange={(e) => set({ name: e.target.value })} /></div>
            <div className="grid cols-2">
              <div className="field"><label>股票代號</label><input value={p.stockCode} onChange={(e) => set({ stockCode: e.target.value })} /></div>
              <div className="field"><label>統一編號</label><input value={p.taxId} onChange={(e) => set({ taxId: e.target.value })} /></div>
            </div>
            <div className="field">
              <label>板別（決定哪些義務適用）</label>
              <select value={p.tier} onChange={(e) => set({ tier: e.target.value as ListingTier })}>
                {(Object.keys(TIER_LABEL) as ListingTier[]).map((t) => <option key={t} value={t}>{TIER_LABEL[t]}</option>)}
              </select>
            </div>
            <div className="grid cols-2">
              <div className="field">
                <label>會計年度結束月份</label>
                <select value={p.fiscalYearEndMonth} onChange={(e) => set({ fiscalYearEndMonth: Number(e.target.value) })}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{m} 月</option>)}
                </select>
              </div>
              <div className="field"><label>實收資本額（元）</label><input type="number" value={p.paidInCapital} onChange={(e) => set({ paidInCapital: Number(e.target.value) })} /></div>
            </div>
            <div className="field">
              <label>
                <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={p.hasAuditCommittee} onChange={(e) => set({ hasAuditCommittee: e.target.checked })} />
                已設置審計委員會（不適用監察人成數，董事成數併計）
              </label>
            </div>
            <div className="field"><label>產業</label><input value={p.industry} onChange={(e) => set({ industry: e.target.value })} /></div>
          </fieldset>
        </div>

        <div className="card">
          <h3>政策上限<span className="sub">供檢核規則 RL-01 ~ RL-03 引用</span></h3>
          <fieldset disabled={!canAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="field">
              <label>背書保證總額占淨值上限（%）</label>
              <input type="number" value={p.policyLimits.endorsementToEquityPct} onChange={(e) => setLimit({ endorsementToEquityPct: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label>對單一企業背書保證占淨值上限（%）</label>
              <input type="number" value={p.policyLimits.singleEndorsementPct} onChange={(e) => setLimit({ singleEndorsementPct: Number(e.target.value) })} />
            </div>
            <div className="field">
              <label>資金貸與總額占淨值上限（%）</label>
              <input type="number" value={p.policyLimits.lendingToEquityPct} onChange={(e) => setLimit({ lendingToEquityPct: Number(e.target.value) })} />
            </div>
          </fieldset>
          <p className="small muted">
            上限應與董事會通過之「資金貸與作業程序」及「背書保證作業程序」一致。修改後檢核結果即時重算。
          </p>
          <button
            className="btn danger"
            disabled={!canAdmin}
            onClick={() => {
              if (confirm('將清除所有作業紀錄與輸入資料，回復為初始示範資料。此動作無法復原，確定嗎？')) void reset()
            }}
          >
            重設工作區資料
          </button>
        </div>
      </div>

      {mode === 'server' && (
        <div className="card">
          <h3>稽核軌跡<span className="sub">伺服器端逐筆記錄，僅追加不可修改</span></h3>
          {loadingAudit && <p className="muted small">載入中…</p>}
          {entries && entries.length === 0 && !loadingAudit && <p className="muted small">尚無紀錄。</p>}
          {entries && entries.length > 0 && (
            <div className="table-wrap" style={{ maxHeight: 400, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>時間</th><th>使用者</th><th>動作</th><th>對象</th><th>內容</th></tr></thead>
                <tbody>
                  {entries.map((e, i) => (
                    <tr key={i}>
                      <td className="mono small nowrap">{e.ts.replace('T', ' ').slice(0, 19)}</td>
                      <td className="small nowrap">{e.user}</td>
                      <td className="small nowrap">{e.action}</td>
                      <td className="mono small">{e.target}</td>
                      <td className="small muted">{e.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginBottom: 0 }}>
            顯示最近 100 筆。完整軌跡以 JSON Lines 儲存於伺服器資料目錄的 <span className="mono">audit.log</span>，可匯入 SIEM 或提供稽核調閱。
          </p>
        </div>
      )}

      <div className="card">
        <h3>制度規模</h3>
        <div className="grid cols-4">
          <div className="stat"><div className="label">職能面向</div><div className="value">9</div></div>
          <div className="stat"><div className="label">義務項目</div><div className="value">{OBLIGATIONS.length}</div><div className="hint">其中 {OBLIGATIONS.length - RECURRING_OBLIGATIONS.length} 項為事件驅動</div></div>
          <div className="stat"><div className="label">檢核點</div><div className="value">{OBLIGATIONS.reduce((n, o) => n + o.checklist.length, 0)}</div></div>
          <div className="stat"><div className="label">檢核規則 / 指標</div><div className="value">{CHECK_RULES.length} / {METRICS.length}</div></div>
        </div>
      </div>

      <div className="card">
        <h3>國定假日表<span className="sub">影響到期日的順延／提前計算，每年須依人事行政總處公告更新</span></h3>
        <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
          <table>
            <thead><tr><th>日期</th><th>名稱</th></tr></thead>
            <tbody>
              {Object.entries(HOLIDAYS).map(([d, n]) => (
                <tr key={d}><td className="mono">{d}</td><td>{n}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          維護位置：<span className="mono">src/lib/date.ts</span> 的 <span className="mono">HOLIDAYS</span>。
          法定申報期限遇例假日順延至次一營業日（<span className="mono">adjust: 'NEXT'</span>）；內部作業期限則提前至前一營業日（<span className="mono">'PREV'</span>）。
        </p>
      </div>

      <div className="banner info">
        <strong>免責說明：</strong>本系統之法源引用、期限與門檻為依一般公開發行公司情形所建置的範本，
        個別公司仍須依主管機關最新函令、所屬產業別規定、公司章程及實際契約條款覆核調整，
        並不構成法律或稅務意見。
      </div>
    </>
  )
}
