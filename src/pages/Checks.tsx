import { useMemo, useState } from 'react'
import { AREAS } from '../domain/areas'
import { CHECK_RULES } from '../domain/rules'
import { INPUT_METRICS, METRIC_MAP } from '../domain/metrics'
import { complianceScore, formatValue, resolveScope, runRule } from '../engine/checkEngine'
import { useCheckInputs, useStore } from '../state/store'
import { AreaPill, CheckPill, Severity, Stat } from '../components/ui'
import type { RuleCategory } from '../domain/types'

const CATEGORY_LABEL: Record<RuleCategory, string> = {
  COVENANT: '融資契約財務約定',
  REGULATORY_LIMIT: '法令與自訂上限',
  RECONCILIATION: '帳務勾稽（差異須為零）',
  ANALYTICAL: '分析性覆核',
  LIQUIDITY: '流動性與資金安全',
}

const CATEGORY_ORDER: RuleCategory[] = ['RECONCILIATION', 'COVENANT', 'REGULATORY_LIMIT', 'LIQUIDITY', 'ANALYTICAL']

export function Checks() {
  const { workspace, mutate, readOnly } = useStore()
  const inputs = useCheckInputs()
  const [showInputs, setShowInputs] = useState(false)

  const scope = useMemo(() => resolveScope(inputs), [inputs])
  const results = useMemo(() => CHECK_RULES.map((r) => ({ rule: r, res: runRule(r, scope) })), [scope])
  const score = complianceScore(results.map((r) => r.res), CHECK_RULES)

  const counts = {
    fail: results.filter((r) => r.res.status === 'FAIL').length,
    warn: results.filter((r) => r.res.status === 'WARN').length,
    pass: results.filter((r) => r.res.status === 'PASS').length,
    nodata: results.filter((r) => r.res.status === 'NO_DATA').length,
  }

  const active = workspace.financials.find((f) => f.id === workspace.activeFinancialId) ?? workspace.financials[0]
  const groups = [...new Set(INPUT_METRICS.map((m) => m.group))]

  return (
    <>
      <div className="page-head">
        <h2>財務檢核</h2>
        <p>以指標算式對財務數據執行 {CHECK_RULES.length} 條檢核規則。門檻可引用公司政策參數，調整「設定」即全面生效，無須改動程式。</p>
      </div>

      <div className="toolbar">
        <select value={workspace.activeFinancialId} onChange={(e) => mutate({ kind: 'activeFinancial', id: e.target.value })}>
          {workspace.financials.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <button className="btn" onClick={() => setShowInputs((v) => !v)}>
          {showInputs ? '收合' : '展開'}財務數據輸入（{Object.keys(active?.values ?? {}).length}/{INPUT_METRICS.length} 項已填）
        </button>
      </div>

      <div className="grid cols-4">
        <Stat label="檢核總分" value={score} color={score >= 90 ? 'var(--ok)' : score >= 70 ? 'var(--warn)' : 'var(--fail)'} hint="以嚴重度加權，資料不足亦扣分" />
        <Stat label="未通過（紅燈）" value={counts.fail} color={counts.fail ? 'var(--fail)' : 'var(--ok)'} hint="須立即依改善措施處理" />
        <Stat label="預警（黃燈）" value={counts.warn} color={counts.warn ? 'var(--warn)' : undefined} hint="尚未違反，但緩衝不足" />
        <Stat label="資料不足" value={counts.nodata} color={counts.nodata ? 'var(--nodata)' : undefined} hint="缺漏輸入 = 控制無法執行" />
      </div>

      {showInputs && (
        <div className="card" style={{ marginTop: 14 }}>
          <h3>財務數據輸入<span className="sub">{active?.label}・單位：新台幣元。實務上由 ERP／合併報表系統匯入</span></h3>
          {groups.map((g) => (
            <details key={g} open={g === '資產負債表'}>
              <summary style={{ cursor: 'pointer', padding: '6px 0', fontWeight: 600, fontSize: 13 }}>{g}</summary>
              <div className="grid cols-3" style={{ padding: '4px 0 12px' }}>
                {INPUT_METRICS.filter((m) => m.group === g).map((m) => (
                  <div className="field" key={m.id} style={{ marginBottom: 0 }}>
                    <label htmlFor={m.id}>{m.name}</label>
                    <input
                      id={m.id}
                      type="number"
                      value={active?.values[m.id] ?? ''}
                      placeholder="未填"
                      disabled={readOnly}
                      onChange={(e) =>
                        mutate({
                          kind: 'financialValue',
                          id: active.id,
                          metricId: m.id,
                          value: e.target.value === '' ? null : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => {
        const items = results.filter((r) => r.rule.category === cat)
        if (!items.length) return null
        return (
          <div className="card" key={cat}>
            <h3>
              {CATEGORY_LABEL[cat]}
              <span className="sub">{items.length} 條規則</span>
            </h3>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>規則</th><th>面向</th><th className="num">實際值</th><th className="num">門檻</th>
                    <th className="num">緩衝</th><th>結果</th><th>嚴重度</th><th>觸發時應採行動</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(({ rule, res }) => (
                    <tr key={rule.id}>
                      <td>
                        <strong>{rule.name}</strong>
                        <div className="small muted mono">{rule.id}・{rule.expression} {rule.comparator} {rule.threshold}</div>
                        <div className="small muted">依據：{rule.basis}</div>
                      </td>
                      <td><AreaPill area={rule.area} /></td>
                      <td className="num mono">{formatValue(res.value, rule.unit)}</td>
                      <td className="num mono">{formatValue(res.thresholdValue, rule.unit)}</td>
                      <td className="num mono" style={{ color: res.headroom !== null && res.headroom < 0 ? 'var(--fail)' : undefined }}>
                        {formatValue(res.headroom, rule.unit)}
                      </td>
                      <td><CheckPill status={res.status} /></td>
                      <td><Severity level={rule.severity} /></td>
                      <td className="small muted">
                        {res.status === 'PASS' ? <span className="muted">—</span> : res.status === 'NO_DATA' ? res.message : rule.remediation}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      <div className="card">
        <h3>衍生指標一覽<span className="sub">由輸入科目自動計算，供規則引用</span></h3>
        <div className="table-wrap">
          <table>
            <thead><tr><th>指標</th><th>公式</th><th className="num">計算結果</th></tr></thead>
            <tbody>
              {Object.values(METRIC_MAP).filter((m) => m.formula).map((m) => (
                <tr key={m.id} title={m.description}>
                  <td>
                    {m.name} <span className="mono small muted">{m.id}</span>
                    {m.description && <div className="small muted">{m.description}</div>}
                  </td>
                  <td className="mono small muted">{m.formula}</td>
                  <td className="num mono">{scope[m.id] === undefined ? <span className="muted">資料不足</span> : formatValue(scope[m.id]!, m.unit)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="small muted">
        面向覆蓋：{AREAS.filter((a) => CHECK_RULES.some((r) => r.area === a.id)).map((a) => a.shortName).join('、')}。
        規則庫可依公司實際聯貸契約與內部辦法增修（<span className="mono">src/domain/rules.ts</span>）。
      </p>
    </>
  )
}
