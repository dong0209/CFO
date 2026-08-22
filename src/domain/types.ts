import type { BusinessDayAdjust, ISODate } from '../lib/date'

/* ─────────────── 組織與適用範圍 ─────────────── */

/** 財務長九大職能面向 */
export type FunctionAreaId =
  | 'REPORTING'   // 財務會計與財報編製
  | 'FPA'         // 預算、管理會計與績效
  | 'TREASURY'    // 資金、外匯與融資
  | 'TAX'         // 稅務
  | 'COMPLIANCE'  // 法遵、公司治理與資訊揭露
  | 'IC_AUDIT'    // 內部控制與稽核
  | 'IR_STOCK'    // 投資人關係與股務
  | 'RISK'        // 風險管理與保險
  | 'ESG'         // 永續資訊與氣候相關揭露

export interface FunctionArea {
  id: FunctionAreaId
  name: string
  shortName: string
  color: string
  mission: string
  /** 該面向的關鍵職責 */
  responsibilities: string[]
  /** 該面向失效時的典型後果 */
  failureModes: string[]
}

export type RoleId =
  | 'CFO' | 'ACCOUNTING' | 'TREASURY' | 'TAX' | 'FPA' | 'IR'
  | 'STOCK_AFFAIRS' | 'INTERNAL_AUDIT' | 'LEGAL' | 'ESG_OFFICE'
  | 'BOARD' | 'AUDIT_COMMITTEE' | 'COMP_COMMITTEE' | 'SHAREHOLDER_MEETING' | 'CPA'

/** 公司屬性：同一義務在不同板別的期限與適用性可能不同 */
export type ListingTier = 'PUBLIC' | 'EMERGING' | 'OTC' | 'LISTED'

export interface CompanyProfile {
  name: string
  taxId: string
  stockCode: string
  tier: ListingTier
  fiscalYearEndMonth: number
  /** 實收資本額（元）— 決定董監持股成數級距、多項申報門檻 */
  paidInCapital: number
  /** 是否已設置審計委員會（影響監察人相關義務） */
  hasAuditCommittee: boolean
  /** 是否編製合併財報 */
  consolidated: boolean
  industry: string
  /** 章程/內部辦法自訂上限，供檢核規則引用 */
  policyLimits: {
    endorsementToEquityPct: number  // 背書保證總額占淨值上限（%）
    lendingToEquityPct: number      // 資金貸與總額占淨值上限（%）
    singleEndorsementPct: number    // 對單一企業背書保證占淨值上限（%）
  }
}

/* ─────────────── 定期義務（Obligation）主檔 ─────────────── */

export type PeriodKind = 'MONTH' | 'BIMONTH' | 'QUARTER' | 'HALF' | 'YEAR' | 'EVENT'

/** 到期日推算規則 */
export type DueRule =
  /** 期間終了後 N 日（例：季報 45 日） */
  | { type: 'DAYS_AFTER'; days: number }
  /** 期間終了後 N 個月的第 day 日；day 省略時沿用期末日並收斂至月底（例：年報 +3 月 → 3/31） */
  | { type: 'MONTHS_AFTER'; months: number; day?: number }
  /** 期間「所屬年度內」的固定日（例：營所稅暫繳 9/30） */
  | { type: 'FIXED_IN_PERIOD'; month: number; day: number }

export type ObligationCategory =
  | 'STATUTORY'    // 法令直接規定
  | 'REGULATORY'   // 主管機關/交易所規章
  | 'CONTRACTUAL'  // 契約（聯貸、債券、承銷）
  | 'INTERNAL'     // 公司內部管理制度

export type ChecklistItemType =
  | 'CONFIRM'      // 確認事項
  | 'DOC'          // 文件產出／取得
  | 'RECONCILE'    // 帳務勾稽
  | 'APPROVAL'     // 權責核准
  | 'FILING'       // 對外申報動作

export interface ChecklistItemDef {
  id: string
  text: string
  type: ChecklistItemType
  required: boolean
  /** 對應的內控控制點編號，供內控自評與稽核抽核連結 */
  control?: string
  hint?: string
}

export interface Obligation {
  id: string
  title: string
  area: FunctionAreaId
  category: ObligationCategory
  /** 適用板別；空陣列代表全部適用 */
  tiers: ListingTier[]
  period: PeriodKind
  due: DueRule
  /** 到期日遇例假日的處理：法定申報多為順延（NEXT），內部期限多為提前（PREV） */
  adjust: BusinessDayAdjust
  /** 提前幾個營業日開工 */
  leadBusinessDays: number
  /** 到期前幾日提醒（可多段） */
  remindDaysBefore: number[]
  owner: RoleId
  reviewer: RoleId
  approver: RoleId
  /** 1=低 … 5=極高（涉及停止買賣、重大裁罰、刑責） */
  severity: 1 | 2 | 3 | 4 | 5
  legalBasis: string[]
  penalty?: string
  /** 申報／送件管道 */
  channel?: string
  outputs: string[]
  checklist: ChecklistItemDef[]
  notes?: string
}

/* ─────────────── 任務實例（Task） ─────────────── */

export type TaskStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE' | 'NA'

export interface ChecklistItemState {
  defId: string
  checked: boolean
  checkedBy?: string
  checkedAt?: string
  remark?: string
}

export interface Task {
  id: string
  obligationId: string
  /** 期間標籤：2026-03 / 2026-Q1 / 2026-H1 / 2026 */
  periodLabel: string
  periodStart: ISODate
  periodEnd: ISODate
  /** 法定/原始到期日（未做營業日調整） */
  statutoryDue: ISODate
  /** 實際到期日（營業日調整後） */
  dueDate: ISODate
  /** 建議開工日 */
  startDate: ISODate
  status: TaskStatus
  assignee?: string
  completedAt?: ISODate
  completedBy?: string
  checklist: ChecklistItemState[]
  note?: string
}

/** 由 dueDate 與 status 即時推導，不落地儲存，避免狀態不一致 */
export type TaskHealth = 'DONE_ON_TIME' | 'DONE_LATE' | 'OVERDUE' | 'DUE_TODAY' | 'AT_RISK' | 'UPCOMING' | 'FUTURE' | 'NA'

/* ─────────────── 檢核規則（Check Rule） ─────────────── */

export type RuleCategory =
  | 'COVENANT'          // 融資契約財務約定
  | 'REGULATORY_LIMIT'  // 法令/自訂上限
  | 'ANALYTICAL'        // 分析性覆核（異常波動）
  | 'RECONCILIATION'    // 帳務勾稽（差異須為零）
  | 'LIQUIDITY'         // 流動性與資金安全

export type Comparator = '>=' | '<=' | '>' | '<' | '==' | 'ABS<='

export type MetricUnit = 'RATIO' | 'PCT' | 'TIMES' | 'DAYS' | 'AMOUNT'

export interface CheckRule {
  id: string
  name: string
  area: FunctionAreaId
  category: RuleCategory
  /** 以 metric 代號組成的算式 */
  expression: string
  comparator: Comparator
  /** 紅線門檻（可為算式，以引用公司政策參數） */
  threshold: string
  /** 黃燈門檻（提早預警）；未設定則僅有紅/綠 */
  warn?: string
  unit: MetricUnit
  frequency: PeriodKind
  severity: 1 | 2 | 3 | 4 | 5
  basis: string
  /** 觸發後應採取的行動 */
  remediation: string
}

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NO_DATA'

export interface CheckResult {
  ruleId: string
  status: CheckStatus
  value: number | null
  thresholdValue: number | null
  warnValue: number | null
  /** 距離紅線的緩衝（正=安全） */
  headroom: number | null
  message: string
  missingInputs: string[]
}

/* ─────────────── 財務資料期別 ─────────────── */

export interface FinancialPeriod {
  id: string
  label: string
  periodEnd: ISODate
  kind: PeriodKind
  /** 科目代號 → 金額（新台幣元）；比率類指標由公式衍生 */
  values: Record<string, number>
}

export interface MetricDef {
  id: string
  name: string
  unit: MetricUnit
  /** 有 formula 者為衍生指標，否則為輸入科目 */
  formula?: string
  group: string
  description?: string
}

/* ─────────────── 風險登錄簿 ─────────────── */

export interface RiskItem {
  id: string
  title: string
  area: FunctionAreaId
  category: string
  likelihood: 1 | 2 | 3 | 4 | 5
  impact: 1 | 2 | 3 | 4 | 5
  owner: RoleId
  mitigation: string
  /** 對應的檢核規則與定期義務，形成「風險→控制」對照 */
  linkedRuleIds: string[]
  linkedObligationIds: string[]
  reviewFrequency: PeriodKind
}
