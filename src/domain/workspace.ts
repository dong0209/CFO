import type { CompanyProfile, FinancialPeriod, RiskItem, TaskStatus } from './types'

/**
 * 工作區文件 — 單一事實來源，本機模式與伺服器模式共用同一結構。
 *
 * 關鍵設計：**不儲存完整任務，只儲存使用者覆寫（override）**。
 * 任務是由義務主檔 × 會計年度衍生出來的，屬於制度層；
 * 使用者實際產生的資料只有「狀態、承辦人、備註、勾了哪些檢核項目」。
 * 只存這些的好處：
 *   1. 主檔修法更新後，既有紀錄不會因為任務結構改變而失效或衝突
 *   2. 多人同時操作時，可用欄位級 API 更新，不必整份文件覆寫（避免互相蓋掉）
 *   3. 儲存體積小，稽核軌跡容易對應到具體欄位
 */

export const WORKSPACE_VERSION = 1

export interface CheckOverride {
  checked: boolean
  by?: string
  at?: string
}

export interface TaskOverride {
  status?: TaskStatus
  assignee?: string
  note?: string
  completedAt?: string
  completedBy?: string
  /** defId → 勾選狀態 */
  checks?: Record<string, CheckOverride>
}

export interface HoldingState {
  parValue: number
  directorShares: number
  supervisorShares: number
  asOf: string
}

export interface Workspace {
  version: number
  profile: CompanyProfile
  fiscalYear: number
  /** taskId（義務 id :: 期間標籤）→ 覆寫 */
  overrides: Record<string, TaskOverride>
  financials: FinancialPeriod[]
  activeFinancialId: string
  risks: RiskItem[]
  holding: HoldingState
}

/** 覆寫是否已無內容，可從文件中移除（避免累積空物件） */
export function isEmptyOverride(o: TaskOverride | undefined): boolean {
  if (!o) return true
  if (o.status || o.assignee || o.note || o.completedAt || o.completedBy) return false
  return !o.checks || Object.values(o.checks).every((c) => !c.checked)
}
