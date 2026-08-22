/**
 * 董事、監察人股權成數法定檢核
 * ------------------------------------------------------------------
 * 依「公開發行公司董事、監察人股權成數及查核實施規則」，全體董事及全體監察人
 * 所持有之記名股票股份總額，應依公司「實收資本額」級距達到法定最低成數。
 * 已依證券交易法設置審計委員會者，不適用監察人成數，但全體董事之持股成數
 * 不得少於原「董事＋監察人」成數之合計。
 *
 * 成數以每次股東會停止過戶日之股東名簿為準；本檢核提供日常監控，
 * 不足時應通知內部人補足，並列入董事會報告事項。
 */

export interface HoldingTier {
  /** 實收資本額下限（元），含 */
  from: number
  /** 實收資本額上限（元），不含；Infinity 代表以上 */
  to: number
  label: string
  directorPct: number
  supervisorPct: number
}

export const HOLDING_TIERS: HoldingTier[] = [
  { from: 0, to: 3e8, label: '未滿 3 億元', directorPct: 15, supervisorPct: 1.5 },
  { from: 3e8, to: 10e8, label: '3 億元以上未滿 10 億元', directorPct: 10, supervisorPct: 1 },
  { from: 10e8, to: 20e8, label: '10 億元以上未滿 20 億元', directorPct: 7.5, supervisorPct: 0.75 },
  { from: 20e8, to: 40e8, label: '20 億元以上未滿 40 億元', directorPct: 5, supervisorPct: 0.5 },
  { from: 40e8, to: 100e8, label: '40 億元以上未滿 100 億元', directorPct: 4, supervisorPct: 0.4 },
  { from: 100e8, to: 500e8, label: '100 億元以上未滿 500 億元', directorPct: 3, supervisorPct: 0.3 },
  { from: 500e8, to: 1000e8, label: '500 億元以上未滿 1,000 億元', directorPct: 2, supervisorPct: 0.2 },
  { from: 1000e8, to: Infinity, label: '1,000 億元以上', directorPct: 1, supervisorPct: 0.1 },
]

export function tierFor(paidInCapital: number): HoldingTier {
  return HOLDING_TIERS.find((t) => paidInCapital >= t.from && paidInCapital < t.to) ?? HOLDING_TIERS[0]
}

export interface HoldingInput {
  paidInCapital: number
  /** 每股面額，台灣多為 10 元；無面額或非 10 元者請自行設定 */
  parValue: number
  hasAuditCommittee: boolean
  directorShares: number
  supervisorShares: number
}

export interface HoldingCheckLine {
  subject: '全體董事' | '全體監察人'
  requiredPct: number
  requiredShares: number
  actualShares: number
  gapShares: number
  pass: boolean
}

export interface HoldingCheckResult {
  tier: HoldingTier
  totalShares: number
  lines: HoldingCheckLine[]
  pass: boolean
  note: string
}

export function checkDirectorHolding(input: HoldingInput): HoldingCheckResult {
  const tier = tierFor(input.paidInCapital)
  const totalShares = input.parValue > 0 ? input.paidInCapital / input.parValue : 0

  const line = (
    subject: HoldingCheckLine['subject'],
    requiredPct: number,
    actualShares: number,
  ): HoldingCheckLine => {
    const requiredShares = Math.ceil((totalShares * requiredPct) / 100)
    return {
      subject,
      requiredPct,
      requiredShares,
      actualShares,
      gapShares: Math.max(0, requiredShares - actualShares),
      pass: actualShares >= requiredShares,
    }
  }

  const lines: HoldingCheckLine[] = input.hasAuditCommittee
    ? [line('全體董事', tier.directorPct + tier.supervisorPct, input.directorShares)]
    : [
        line('全體董事', tier.directorPct, input.directorShares),
        line('全體監察人', tier.supervisorPct, input.supervisorShares),
      ]

  return {
    tier,
    totalShares,
    lines,
    pass: lines.every((l) => l.pass),
    note: input.hasAuditCommittee
      ? '已設置審計委員會：不適用監察人成數，全體董事應達「董事＋監察人」成數合計。'
      : '未設置審計委員會：董事與監察人分別適用各自成數。',
  }
}
