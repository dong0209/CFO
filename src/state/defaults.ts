import { RECURRING_OBLIGATIONS } from '../domain/obligations'
import { generateTasks } from '../engine/schedule'
import { WORKSPACE_VERSION, type Workspace } from '../domain/workspace'
import { DEFAULT_HOLDING, DEFAULT_PROFILE, SEED_FINANCIALS, SEED_RISKS, demoOverrides } from './seed'

/**
 * 建立初始工作區。前端（本機模式）與伺服器（首次啟動播種）共用，
 * 確保兩種部署形態的起點完全一致。
 */
export function createWorkspace(opts: { fiscalYear: number; today: string; demo: boolean }): Workspace {
  const profile = DEFAULT_PROFILE
  const overrides = opts.demo
    ? demoOverrides(
        generateTasks({ fiscalYear: opts.fiscalYear, profile, obligations: RECURRING_OBLIGATIONS }),
        opts.today,
      )
    : {}

  return {
    version: WORKSPACE_VERSION,
    profile,
    fiscalYear: opts.fiscalYear,
    overrides,
    financials: opts.demo ? SEED_FINANCIALS : SEED_FINANCIALS.map((f) => ({ ...f, values: {} })),
    activeFinancialId: SEED_FINANCIALS[0].id,
    risks: SEED_RISKS,
    holding: opts.demo ? DEFAULT_HOLDING : { ...DEFAULT_HOLDING, directorShares: 0, supervisorShares: 0 },
  }
}
