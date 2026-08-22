import type { MetricDef } from './types'

/**
 * 指標字典
 * - 無 formula = 輸入科目（由財報/系統匯入）
 * - 有 formula = 衍生指標（由算式引擎計算，可再被其他公式引用）
 * 幣別單位：新台幣元。
 */
export const METRICS: MetricDef[] = [
  // ── 資產負債表 ──
  { id: 'cash', name: '現金及約當現金', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'stInvestments', name: '短期投資（可隨時變現）', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'restrictedCash', name: '受限制資產（質押/備償專戶）', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'ar', name: '應收帳款及票據（淨額）', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'arOver90', name: '應收帳款逾期 90 天以上金額', unit: 'AMOUNT', group: '風險明細' },
  { id: 'inventory', name: '存貨', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'inventoryOver365', name: '呆滯存貨（庫齡 365 天以上）', unit: 'AMOUNT', group: '風險明細' },
  { id: 'currentAssets', name: '流動資產合計', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'totalAssets', name: '資產總計', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'intangibles', name: '無形資產及商譽', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'ap', name: '應付帳款及票據', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'shortTermDebt', name: '短期借款及一年內到期長期負債', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'currentLiabilities', name: '流動負債合計', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'longTermDebt', name: '長期借款及公司債', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'totalLiabilities', name: '負債總計', unit: 'AMOUNT', group: '資產負債表' },
  { id: 'equity', name: '權益總計（歸屬母公司）', unit: 'AMOUNT', group: '資產負債表' },

  // ── 損益表 ──
  { id: 'revenue', name: '營業收入', unit: 'AMOUNT', group: '損益表' },
  { id: 'cogs', name: '營業成本', unit: 'AMOUNT', group: '損益表' },
  { id: 'operatingIncome', name: '營業利益', unit: 'AMOUNT', group: '損益表' },
  { id: 'depreciation', name: '折舊及攤銷', unit: 'AMOUNT', group: '損益表' },
  { id: 'interestExpense', name: '利息費用', unit: 'AMOUNT', group: '損益表' },
  {
    id: 'ltmEbitda', name: '近 12 個月 EBITDA（LTM）', unit: 'AMOUNT', group: '損益表',
    description: '淨負債為期末存量，若以單季 EBITDA 相除會低估數倍，故槓桿類約定一律採 LTM。',
  },
  { id: 'pretaxIncome', name: '稅前淨利', unit: 'AMOUNT', group: '損益表' },
  { id: 'taxExpense', name: '所得稅費用', unit: 'AMOUNT', group: '損益表' },
  { id: 'netIncome', name: '本期淨利（歸屬母公司）', unit: 'AMOUNT', group: '損益表' },

  // ── 現金流量表 ──
  { id: 'cfo', name: '營業活動淨現金流入', unit: 'AMOUNT', group: '現金流量表' },
  { id: 'capex', name: '購置不動產廠房設備', unit: 'AMOUNT', group: '現金流量表' },
  { id: 'cfEndingCash', name: '現金流量表期末現金餘額', unit: 'AMOUNT', group: '現金流量表' },

  // ── 資金與法遵部位 ──
  { id: 'bankStatementCash', name: '銀行對帳單/餘額證明合計', unit: 'AMOUNT', group: '資金部位' },
  { id: 'largestBankDeposit', name: '單一銀行最大存款餘額', unit: 'AMOUNT', group: '資金部位' },
  { id: 'unusedCreditLine', name: '未動用授信額度', unit: 'AMOUNT', group: '資金部位' },
  { id: 'monthlyOpCashNeed', name: '每月營運資金需求', unit: 'AMOUNT', group: '資金部位' },
  { id: 'endorsementBalance', name: '背書保證餘額（總額）', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'endorsementSingleMax', name: '對單一企業背書保證最大餘額', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'lendingBalance', name: '資金貸與餘額（總額）', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'derivativeUnrealizedLoss', name: '衍生性商品未實現損失（絕對值）', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'fxNetExposure', name: '外幣淨曝險（未避險部位）', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'relatedPartySales', name: '關係人銷貨金額', unit: 'AMOUNT', group: '法遵部位' },
  { id: 'largestCustomerAR', name: '單一客戶最大應收餘額', unit: 'AMOUNT', group: '風險明細' },

  // ── 政策參數（由公司設定帶入，供門檻算式引用）──
  { id: 'policyEndorsementPct', name: '政策：背書保證占淨值上限(%)', unit: 'PCT', group: '政策參數' },
  { id: 'policySingleEndorsementPct', name: '政策：單一企業背書保證占淨值上限(%)', unit: 'PCT', group: '政策參數' },
  { id: 'policyLendingPct', name: '政策：資金貸與占淨值上限(%)', unit: 'PCT', group: '政策參數' },
  { id: 'statutoryTaxRate', name: '法定營所稅率(%)', unit: 'PCT', group: '政策參數' },
  { id: 'periodDays', name: '本期天數', unit: 'DAYS', group: '政策參數' },

  // ── 前期比較值（供分析性覆核）──
  { id: 'prevDso', name: '前期應收帳款週轉天數', unit: 'DAYS', group: '前期比較' },
  { id: 'prevDio', name: '前期存貨週轉天數', unit: 'DAYS', group: '前期比較' },
  { id: 'prevGrossMargin', name: '前期毛利率(%)', unit: 'PCT', group: '前期比較' },

  // ── 衍生指標 ──
  { id: 'grossProfit', name: '營業毛利', unit: 'AMOUNT', group: '衍生指標', formula: 'revenue - cogs' },
  { id: 'grossMargin', name: '毛利率(%)', unit: 'PCT', group: '衍生指標', formula: 'grossProfit / revenue * 100' },
  { id: 'operatingMargin', name: '營業利益率(%)', unit: 'PCT', group: '衍生指標', formula: 'operatingIncome / revenue * 100' },
  { id: 'ebitda', name: 'EBITDA', unit: 'AMOUNT', group: '衍生指標', formula: 'operatingIncome + depreciation' },
  { id: 'currentRatio', name: '流動比率(%)', unit: 'PCT', group: '衍生指標', formula: 'currentAssets / currentLiabilities * 100' },
  { id: 'quickRatio', name: '速動比率(%)', unit: 'PCT', group: '衍生指標', formula: '(currentAssets - inventory) / currentLiabilities * 100' },
  { id: 'debtRatio', name: '負債比率(%)', unit: 'PCT', group: '衍生指標', formula: 'totalLiabilities / totalAssets * 100' },
  { id: 'tangibleNetWorth', name: '有形淨值', unit: 'AMOUNT', group: '衍生指標', formula: 'equity - intangibles' },
  { id: 'grossDebt', name: '有息負債總額', unit: 'AMOUNT', group: '衍生指標', formula: 'shortTermDebt + longTermDebt' },
  { id: 'netDebt', name: '淨有息負債', unit: 'AMOUNT', group: '衍生指標', formula: 'grossDebt - cash - stInvestments' },
  { id: 'netDebtToEquity', name: '淨負債/淨值(倍)', unit: 'TIMES', group: '衍生指標', formula: 'netDebt / equity' },
  {
    id: 'netDebtToEbitda', name: '淨負債/EBITDA(倍)', unit: 'TIMES', group: '衍生指標', formula: 'netDebt / ltmEbitda',
    description: '存量（淨負債）對流量（EBITDA）之比，分母須為近 12 個月數，不可使用單季數。',
  },
  { id: 'interestCoverage', name: '利息保障倍數(倍)', unit: 'TIMES', group: '衍生指標', formula: 'ebitda / interestExpense' },
  { id: 'dso', name: '應收帳款週轉天數', unit: 'DAYS', group: '衍生指標', formula: 'ar / revenue * periodDays' },
  { id: 'dio', name: '存貨週轉天數', unit: 'DAYS', group: '衍生指標', formula: 'inventory / cogs * periodDays' },
  { id: 'dpo', name: '應付帳款週轉天數', unit: 'DAYS', group: '衍生指標', formula: 'ap / cogs * periodDays' },
  { id: 'ccc', name: '現金循環週期(天)', unit: 'DAYS', group: '衍生指標', formula: 'dso + dio - dpo' },
  { id: 'cashQuality', name: '盈餘品質（營運現金流/淨利）', unit: 'TIMES', group: '衍生指標', formula: 'cfo / netIncome' },
  { id: 'freeCashFlow', name: '自由現金流量', unit: 'AMOUNT', group: '衍生指標', formula: 'cfo - capex' },
  { id: 'effectiveTaxRate', name: '有效稅率(%)', unit: 'PCT', group: '衍生指標', formula: 'taxExpense / pretaxIncome * 100' },
  { id: 'endorsementToEquity', name: '背書保證/淨值(%)', unit: 'PCT', group: '衍生指標', formula: 'endorsementBalance / equity * 100' },
  { id: 'singleEndorsementToEquity', name: '單一企業背書保證/淨值(%)', unit: 'PCT', group: '衍生指標', formula: 'endorsementSingleMax / equity * 100' },
  { id: 'lendingToEquity', name: '資金貸與/淨值(%)', unit: 'PCT', group: '衍生指標', formula: 'lendingBalance / equity * 100' },
  { id: 'fxExposureToEquity', name: '外幣淨曝險/淨值(%)', unit: 'PCT', group: '衍生指標', formula: 'fxNetExposure / equity * 100' },
  { id: 'relatedPartySalesPct', name: '關係人銷貨占比(%)', unit: 'PCT', group: '衍生指標', formula: 'relatedPartySales / revenue * 100' },
  { id: 'arOver90Pct', name: '逾期 90 天以上應收占比(%)', unit: 'PCT', group: '衍生指標', formula: 'arOver90 / ar * 100' },
  { id: 'inventoryAgingPct', name: '呆滯存貨占比(%)', unit: 'PCT', group: '衍生指標', formula: 'inventoryOver365 / inventory * 100' },
  { id: 'bankConcentration', name: '單一銀行存款集中度(%)', unit: 'PCT', group: '衍生指標', formula: 'largestBankDeposit / (cash + stInvestments) * 100' },
  { id: 'customerConcentration', name: '單一客戶應收集中度(%)', unit: 'PCT', group: '衍生指標', formula: 'largestCustomerAR / ar * 100' },
  { id: 'liquidityMonths', name: '未動用額度可支應月數', unit: 'TIMES', group: '衍生指標', formula: 'unusedCreditLine / monthlyOpCashNeed' },
  { id: 'cashDiff', name: '現金勾稽差異', unit: 'AMOUNT', group: '衍生指標', formula: 'cfEndingCash - cash' },
  { id: 'bankCashDiff', name: '銀行對帳差異', unit: 'AMOUNT', group: '衍生指標', formula: 'bankStatementCash - (cash - restrictedCash)' },
  { id: 'dsoDelta', name: 'DSO 較前期增加(天)', unit: 'DAYS', group: '衍生指標', formula: 'dso - prevDso' },
  { id: 'dioDelta', name: 'DIO 較前期增加(天)', unit: 'DAYS', group: '衍生指標', formula: 'dio - prevDio' },
  { id: 'grossMarginDelta', name: '毛利率變動(百分點)', unit: 'PCT', group: '衍生指標', formula: 'grossMargin - prevGrossMargin' },
  { id: 'etrGap', name: '有效稅率偏離法定稅率(百分點)', unit: 'PCT', group: '衍生指標', formula: 'effectiveTaxRate - statutoryTaxRate' },
]

export const METRIC_MAP: Record<string, MetricDef> = Object.fromEntries(METRICS.map((m) => [m.id, m]))
export const INPUT_METRICS = METRICS.filter((m) => !m.formula)
export const DERIVED_METRICS = METRICS.filter((m) => !!m.formula)
