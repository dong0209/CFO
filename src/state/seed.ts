import type { CompanyProfile, FinancialPeriod, RiskItem, Task } from '../domain/types'
import { diffDays, type ISODate } from '../lib/date'

export const DEFAULT_PROFILE: CompanyProfile = {
  name: '範例精密工業股份有限公司',
  taxId: '12345678',
  stockCode: '9999',
  tier: 'LISTED',
  fiscalYearEndMonth: 12,
  paidInCapital: 5_000_000_000,
  hasAuditCommittee: true,
  consolidated: true,
  industry: '電子零組件製造',
  policyLimits: {
    endorsementToEquityPct: 50,
    lendingToEquityPct: 40,
    singleEndorsementPct: 20,
  },
}

export interface HoldingState {
  parValue: number
  directorShares: number
  supervisorShares: number
  asOf: string
}

export const DEFAULT_HOLDING: HoldingState = {
  parValue: 10,
  directorShares: 21_000_000,
  supervisorShares: 0,
  asOf: '2026-06-30',
}

/** 示範財務資料（新台幣元）。實務上由 ERP/合併報表系統匯入。 */
export const SEED_FINANCIALS: FinancialPeriod[] = [
  {
    id: '2026Q1',
    label: '2026 年第 1 季（合併）',
    periodEnd: '2026-03-31',
    kind: 'QUARTER',
    values: {
      cash: 1_850_000_000, stInvestments: 450_000_000, restrictedCash: 120_000_000,
      ar: 3_250_000_000, arOver90: 98_000_000, largestCustomerAR: 720_000_000,
      inventory: 2_400_000_000, inventoryOver365: 190_000_000,
      currentAssets: 8_200_000_000, totalAssets: 20_500_000_000, intangibles: 520_000_000,
      ap: 1_620_000_000, shortTermDebt: 2_300_000_000, currentLiabilities: 5_400_000_000,
      longTermDebt: 3_100_000_000, totalLiabilities: 10_600_000_000, equity: 9_900_000_000,
      revenue: 2_950_000_000, cogs: 2_240_000_000, operatingIncome: 330_000_000,
      depreciation: 152_000_000, interestExpense: 38_000_000, ltmEbitda: 2_130_000_000,
      pretaxIncome: 305_000_000, taxExpense: 67_000_000, netIncome: 238_000_000,
      cfo: 205_000_000, capex: 260_000_000, cfEndingCash: 1_850_000_000,
      bankStatementCash: 1_730_000_000, largestBankDeposit: 620_000_000,
      unusedCreditLine: 2_800_000_000, monthlyOpCashNeed: 780_000_000,
      endorsementBalance: 3_900_000_000, endorsementSingleMax: 1_750_000_000,
      lendingBalance: 3_600_000_000, derivativeUnrealizedLoss: 140_000_000,
      fxNetExposure: 820_000_000, relatedPartySales: 640_000_000,
      periodDays: 90, statutoryTaxRate: 20,
      prevDso: 92, prevDio: 88, prevGrossMargin: 25.4,
    },
  },
  {
    id: '2025FY',
    label: '2025 年度（合併，已查核）',
    periodEnd: '2025-12-31',
    kind: 'YEAR',
    values: {
      cash: 2_050_000_000, stInvestments: 500_000_000, restrictedCash: 100_000_000,
      ar: 3_020_000_000, arOver90: 62_000_000, largestCustomerAR: 610_000_000,
      inventory: 2_180_000_000, inventoryOver365: 145_000_000,
      currentAssets: 8_050_000_000, totalAssets: 20_100_000_000, intangibles: 500_000_000,
      ap: 1_540_000_000, shortTermDebt: 2_050_000_000, currentLiabilities: 5_050_000_000,
      longTermDebt: 3_000_000_000, totalLiabilities: 10_150_000_000, equity: 9_950_000_000,
      revenue: 12_000_000_000, cogs: 8_950_000_000, operatingIncome: 1_520_000_000,
      depreciation: 600_000_000, interestExpense: 148_000_000, ltmEbitda: 2_120_000_000,
      pretaxIncome: 1_405_000_000, taxExpense: 281_000_000, netIncome: 1_124_000_000,
      cfo: 1_310_000_000, capex: 980_000_000, cfEndingCash: 2_050_000_000,
      bankStatementCash: 1_950_000_000, largestBankDeposit: 560_000_000,
      unusedCreditLine: 3_200_000_000, monthlyOpCashNeed: 750_000_000,
      endorsementBalance: 3_400_000_000, endorsementSingleMax: 1_500_000_000,
      lendingBalance: 3_100_000_000, derivativeUnrealizedLoss: 65_000_000,
      fxNetExposure: 700_000_000, relatedPartySales: 2_400_000_000,
      periodDays: 365, statutoryTaxRate: 20,
      prevDso: 88, prevDio: 84, prevGrossMargin: 24.8,
    },
  },
]

export const SEED_RISKS: RiskItem[] = [
  {
    id: 'R-01', title: '主要客戶集中，單一客戶應收占比偏高', area: 'RISK', category: '信用風險',
    likelihood: 3, impact: 5, owner: 'TREASURY',
    mitigation: '投保輸出保險、要求縮短帳期或提供擔保；每月追蹤集中度與帳齡。',
    linkedRuleIds: ['RK-01', 'RK-02'], linkedObligationIds: ['RSK-AR-AGING'], reviewFrequency: 'MONTH',
  },
  {
    id: 'R-02', title: '聯貸財務約定緩衝縮小，恐觸發違約', area: 'TREASURY', category: '流動性/契約風險',
    likelihood: 2, impact: 5, owner: 'CFO',
    mitigation: '每季提前試算比率、控管新增借款與股利發放；緩衝低於 10% 時啟動與管理行溝通。',
    linkedRuleIds: ['CV-01', 'CV-02', 'CV-03', 'CV-04', 'CV-05'], linkedObligationIds: ['TRE-COVENANT'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-03', title: '背書保證與資金貸與逼近內部上限', area: 'TREASURY', category: '法遵風險',
    likelihood: 3, impact: 4, owner: 'TREASURY',
    mitigation: '每月申報前先行試算比率；超過 80% 上限即停止新增並排定回收。',
    linkedRuleIds: ['RL-01', 'RL-02', 'RL-03'], linkedObligationIds: ['TRE-LENDING-ENDORSE-FILING'], reviewFrequency: 'MONTH',
  },
  {
    id: 'R-04', title: '匯率大幅波動造成業外損失', area: 'RISK', category: '市場風險',
    likelihood: 4, impact: 3, owner: 'TREASURY',
    mitigation: '維持避險比率於政策區間、自然避險配對；未實現損失達淨值 1% 即檢討停損。',
    linkedRuleIds: ['RL-04', 'RL-05'], linkedObligationIds: ['TRE-FX-HEDGE'], reviewFrequency: 'MONTH',
  },
  {
    id: 'R-05', title: '財報申報逾期或重編', area: 'REPORTING', category: '法遵風險',
    likelihood: 1, impact: 5, owner: 'ACCOUNTING',
    mitigation: '結帳時程前置、關鍵勾稽自動化檢核、會計師期中預查；重大估計提前與會計師取得共識。',
    linkedRuleIds: ['RC-01', 'AN-04'], linkedObligationIds: ['RPT-Q-FS', 'RPT-ANNUAL-FS', 'RPT-MONTH-CLOSE'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-06', title: '重大訊息判斷或發布時點失誤', area: 'COMPLIANCE', category: '法遵風險',
    likelihood: 2, impact: 5, owner: 'LEGAL',
    mitigation: '建立重訊判斷檢核表與知情人名單；重大事項採事前法務會簽制。',
    linkedRuleIds: [], linkedObligationIds: ['CMP-MATERIAL-INFO', 'CMP-ASSET-TXN'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-07', title: '存貨呆滯與跌價損失提列不足', area: 'REPORTING', category: '評價風險',
    likelihood: 3, impact: 3, owner: 'ACCOUNTING',
    mitigation: '每季庫齡分析與呆滯提列政策；DIO 異常增加即啟動專案檢討。',
    linkedRuleIds: ['AN-02', 'RK-03'], linkedObligationIds: ['RPT-Q-FS'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-08', title: '移轉訂價遭稅局調整補稅', area: 'TAX', category: '稅務風險',
    likelihood: 2, impact: 4, owner: 'TAX',
    mitigation: '年度更新常規交易區間、期末前檢視利潤率並適時調整；三層文據如期備妥。',
    linkedRuleIds: ['AN-06'], linkedObligationIds: ['TAX-TP-DOC', 'TAX-CIT-ANNUAL'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-09', title: '內部控制重大缺失未於年度終了前改善', area: 'IC_AUDIT', category: '治理風險',
    likelihood: 2, impact: 4, owner: 'INTERNAL_AUDIT',
    mitigation: '缺失改善採期限管理並每月追蹤；重大缺失即時通報審計委員會。',
    linkedRuleIds: [], linkedObligationIds: ['IC-STATEMENT', 'IC-SELF-ASSESS', 'IC-AUDIT-REPORT'], reviewFrequency: 'QUARTER',
  },
  {
    id: 'R-10', title: '永續資訊揭露與財報數據不一致', area: 'ESG', category: '揭露風險',
    likelihood: 3, impact: 3, owner: 'ESG_OFFICE',
    mitigation: '永續數據納入內控循環、與財報共用同一資料來源並執行交叉勾稽。',
    linkedRuleIds: [], linkedObligationIds: ['ESG-REPORT', 'ESG-GHG'], reviewFrequency: 'HALF',
  },
]

/**
 * 示範進度
 * ------------------------------------------------------------------
 * 全新系統的每一筆歷史任務都會顯示為「逾期」，那只是「還沒有人結案」，
 * 對展示與教育訓練沒有參考價值。此函式以決定性規則補上合理的歷史狀態：
 *   - 已到期者原則上結案（完成日＝到期日）
 *   - 刻意保留少數近期項目未結案，用以呈現逾期告警與優先處理清單
 *   - 14 日內到期者標為進行中，並勾選部分檢核項目
 * 僅在初始化時套用；使用者自行編輯後的狀態由 mergeTasks 保留。
 */
const DEMO_OPEN_OBLIGATIONS = ['RSK-AR-AGING', 'TRE-FX-HEDGE', 'IC-AUDIT-REPORT']

export function applyDemoProgress(tasks: Task[], today: ISODate): Task[] {
  const partial = (t: Task, ratio: number): Task['checklist'] => {
    const n = Math.floor(t.checklist.length * ratio)
    return t.checklist.map((c, i) => (i < n ? { ...c, checked: true, checkedBy: '示範資料', checkedAt: today } : c))
  }

  return tasks.map((t) => {
    const gap = diffDays(t.dueDate, today) // 正數 = 尚未到期
    if (gap < 0) {
      const recent = -gap <= 45
      if (recent && DEMO_OPEN_OBLIGATIONS.includes(t.obligationId)) {
        return { ...t, status: 'IN_PROGRESS', checklist: partial(t, 0.5) }
      }
      return {
        ...t,
        status: 'DONE',
        completedAt: t.dueDate,
        completedBy: '示範資料',
        checklist: t.checklist.map((c) => ({ ...c, checked: true, checkedBy: '示範資料', checkedAt: t.dueDate })),
      }
    }
    if (gap <= 14) return { ...t, status: 'IN_PROGRESS', checklist: partial(t, 0.4) }
    return t
  })
}
