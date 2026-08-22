import { useMemo } from 'react'
import { EVENT_OBLIGATIONS, OBLIGATION_MAP } from '../domain/obligations'
import { ROLE_NAMES } from '../domain/areas'
import { checkDirectorHolding, HOLDING_TIERS, tierFor } from '../engine/directorHolding'
import { taskHealth } from '../engine/health'
import { addDays, diffDays } from '../lib/date'
import { useStore } from '../state/store'
import { AreaPill, CategoryTag, Severity, Stat, daysLabel, fmtMoney } from '../components/ui'

/** 治理節點：股東會與董事會相關的關鍵前置時程，由股東常會日回推 */
const AGM_MILESTONES = [
  { offset: -60, name: '停止過戶起始日（常會前 60 日）', basis: '公司法第 165 條' },
  { offset: -30, name: '開會通知、委託書寄發（常會前 30 日）', basis: '公司法第 172 條' },
  { offset: -21, name: '議事手冊及會議補充資料上傳（常會前 21 日）', basis: '公開發行公司股東會議事手冊應行記載及遵行事項辦法' },
  { offset: -2, name: '電子投票截止（常會前 2 日）', basis: '公開發行公司出席股東會使用委託書規則／電子投票規定' },
  { offset: 0, name: '股東常會', basis: '公司法第 170 條' },
  { offset: 20, name: '議事錄分發及公告申報（會後 20 日內）', basis: '公司法第 183 條' },
]

export function Governance() {
  const { workspace, tasks, today, mutate, canAdmin } = useStore()
  const { profile, holding } = workspace

  const result = useMemo(
    () =>
      checkDirectorHolding({
        paidInCapital: profile.paidInCapital,
        parValue: holding.parValue,
        hasAuditCommittee: profile.hasAuditCommittee,
        directorShares: holding.directorShares,
        supervisorShares: holding.supervisorShares,
      }),
    [profile, holding],
  )

  const agmTask = tasks.find((t) => t.obligationId === 'CMP-AGM')
  const agmDate = agmTask?.dueDate

  return (
    <>
      <div className="page-head">
        <h2>公司治理檢核</h2>
        <p>法定成數、股東會關鍵時程與事件驅動義務 — 這三類最常在「沒有固定到期日」的縫隙中被漏掉。</p>
      </div>

      <div className="grid cols-3">
        <Stat
          label="董監持股成數"
          value={result.pass ? '符合' : '不足'}
          color={result.pass ? 'var(--ok)' : 'var(--fail)'}
          hint={`級距：實收資本額 ${result.tier.label}`}
        />
        <Stat label="實收資本額" value={`${fmtMoney(profile.paidInCapital)} 元`} hint={`發行股數 ${result.totalShares.toLocaleString('zh-TW')} 股（面額 ${holding.parValue} 元）`} />
        <Stat label="審計委員會" value={profile.hasAuditCommittee ? '已設置' : '未設置'} hint={profile.hasAuditCommittee ? '監察人成數併入董事計算' : '董事與監察人分別適用'} />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <h3>董事、監察人股權成數法定檢核<span className="sub">公開發行公司董事、監察人股權成數及查核實施規則</span></h3>

        <div className="grid cols-4" style={{ marginBottom: 12 }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>基準日（以停止過戶日股東名簿為準）</label>
            <input type="date" disabled={!canAdmin} value={holding.asOf} onChange={(e) => mutate({ kind: 'holding', patch: { asOf: e.target.value } })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>每股面額（元）</label>
            <input type="number" disabled={!canAdmin} value={holding.parValue} onChange={(e) => mutate({ kind: 'holding', patch: { parValue: Number(e.target.value) } })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>全體董事持有股數</label>
            <input type="number" disabled={!canAdmin} value={holding.directorShares} onChange={(e) => mutate({ kind: 'holding', patch: { directorShares: Number(e.target.value) } })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>全體監察人持有股數</label>
            <input
              type="number"
              value={holding.supervisorShares}
              disabled={profile.hasAuditCommittee || !canAdmin}
              onChange={(e) => mutate({ kind: 'holding', patch: { supervisorShares: Number(e.target.value) } })}
            />
          </div>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>對象</th><th className="num">法定成數</th><th className="num">應持有股數</th><th className="num">實際持有</th><th className="num">差額</th><th>結果</th></tr>
            </thead>
            <tbody>
              {result.lines.map((l) => (
                <tr key={l.subject}>
                  <td>{l.subject}</td>
                  <td className="num mono">{l.requiredPct}%</td>
                  <td className="num mono">{l.requiredShares.toLocaleString('zh-TW')}</td>
                  <td className="num mono">{l.actualShares.toLocaleString('zh-TW')}</td>
                  <td className="num mono" style={{ color: l.gapShares > 0 ? 'var(--fail)' : 'var(--ok)' }}>
                    {l.gapShares > 0 ? `不足 ${l.gapShares.toLocaleString('zh-TW')}` : '—'}
                  </td>
                  <td>
                    <span className="pill" style={{ background: l.pass ? 'rgba(5,150,105,.12)' : 'rgba(220,38,38,.12)', color: l.pass ? 'var(--ok)' : 'var(--fail)' }}>
                      {l.pass ? '符合' : '不足'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">{result.note}</p>
        {!result.pass && (
          <div className="banner fail" style={{ marginBottom: 0 }}>
            成數不足：應通知全體董事（監察人）於期限內補足，並列入董事會報告事項；持續未補足者，主管機關得依證券交易法處以罰鍰，且影響公司治理評鑑。
          </div>
        )}

        <details style={{ marginTop: 10 }}>
          <summary className="small" style={{ cursor: 'pointer' }}>法定成數級距表（現行適用者以粗體標示）</summary>
          <div className="table-wrap">
            <table>
              <thead><tr><th>實收資本額</th><th className="num">全體董事</th><th className="num">全體監察人</th></tr></thead>
              <tbody>
                {HOLDING_TIERS.map((t) => {
                  const cur = t === tierFor(profile.paidInCapital)
                  return (
                    <tr key={t.label} style={cur ? { fontWeight: 700 } : undefined}>
                      <td>{t.label}{cur && <span className="tag" style={{ marginLeft: 6 }}>本公司</span>}</td>
                      <td className="num mono">{t.directorPct}%</td>
                      <td className="num mono">{t.supervisorPct}%</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      </div>

      {agmDate && (
        <div className="card">
          <h3>股東常會關鍵時程<span className="sub">以法定最後期限 {agmDate} 回推；實際召開日確定後請以該日重算</span></h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: 100 }}>日期</th><th>節點</th><th>法源</th><th>距今</th></tr></thead>
              <tbody>
                {AGM_MILESTONES.map((m) => {
                  const iso = addDays(agmDate, m.offset)
                  const gap = diffDays(iso, today)
                  return (
                    <tr key={m.name}>
                      <td className="mono nowrap">{iso}</td>
                      <td>{m.name}</td>
                      <td className="small muted">{m.basis}</td>
                      <td className="small nowrap" style={{ color: gap < 0 ? 'var(--text-dim)' : gap <= 14 ? 'var(--warn)' : undefined }}>{daysLabel(gap)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>
            股東常會任務目前狀態：{taskHealth(agmTask!, today) === 'OVERDUE' ? '已逾期' : '尚未到期'}；
            主辦 {ROLE_NAMES[OBLIGATION_MAP['CMP-AGM'].owner]}。
          </p>
        </div>
      )}

      <div className="card">
        <h3>事件驅動義務 SOP<span className="sub">無固定到期日，改以「事實發生日」起算，須常備流程與知情人控管</span></h3>
        {EVENT_OBLIGATIONS.map((o) => (
          <div key={o.id} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 4 }}>
              <AreaPill area={o.area} />
              <strong>{o.title}</strong>
              <CategoryTag c={o.category} />
              <Severity level={o.severity} />
            </div>
            <div className="grid cols-2">
              <div>
                <ul className="legal">{o.legalBasis.map((b) => <li key={b}>{b}</li>)}</ul>
                {o.penalty && <p className="small" style={{ color: 'var(--fail)' }}>違反效果：{o.penalty}</p>}
              </div>
              <ul className="legal">{o.checklist.map((c) => <li key={c.id}>{c.text}</li>)}</ul>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
