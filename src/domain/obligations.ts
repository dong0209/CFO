import type { Obligation } from './types'
import { REPORTING_OBLIGATIONS, FPA_OBLIGATIONS, TREASURY_OBLIGATIONS } from './obligations.core'
import { TAX_OBLIGATIONS } from './obligations.tax'
import {
  COMPLIANCE_OBLIGATIONS,
  IC_OBLIGATIONS,
  IR_OBLIGATIONS,
  RISK_OBLIGATIONS,
  ESG_OBLIGATIONS,
} from './obligations.gov'

export const OBLIGATIONS: Obligation[] = [
  ...REPORTING_OBLIGATIONS,
  ...FPA_OBLIGATIONS,
  ...TREASURY_OBLIGATIONS,
  ...TAX_OBLIGATIONS,
  ...COMPLIANCE_OBLIGATIONS,
  ...IC_OBLIGATIONS,
  ...IR_OBLIGATIONS,
  ...RISK_OBLIGATIONS,
  ...ESG_OBLIGATIONS,
]

export const OBLIGATION_MAP: Record<string, Obligation> = Object.fromEntries(
  OBLIGATIONS.map((o) => [o.id, o]),
)

/** 事件驅動義務不進行事曆展開，另以常備 SOP 呈現 */
export const RECURRING_OBLIGATIONS = OBLIGATIONS.filter((o) => o.period !== 'EVENT')
export const EVENT_OBLIGATIONS = OBLIGATIONS.filter((o) => o.period === 'EVENT')
