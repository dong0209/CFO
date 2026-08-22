import { diffDays, type ISODate } from '../lib/date'
import type { Task, TaskHealth } from '../domain/types'

/** 到期前幾天內視為「即將到期」 */
export const AT_RISK_WINDOW = 7
export const UPCOMING_WINDOW = 30

export function taskHealth(task: Task, today: ISODate): TaskHealth {
  if (task.status === 'NA') return 'NA'
  if (task.status === 'DONE') {
    const done = task.completedAt ?? today
    return done <= task.dueDate ? 'DONE_ON_TIME' : 'DONE_LATE'
  }
  const d = diffDays(task.dueDate, today) // 正數 = 還有幾天
  if (d < 0) return 'OVERDUE'
  if (d === 0) return 'DUE_TODAY'
  if (d <= AT_RISK_WINDOW) return 'AT_RISK'
  if (d <= UPCOMING_WINDOW) return 'UPCOMING'
  return 'FUTURE'
}

export const HEALTH_LABEL: Record<TaskHealth, string> = {
  OVERDUE: '已逾期',
  DUE_TODAY: '今日到期',
  AT_RISK: '即將到期',
  UPCOMING: '近期待辦',
  FUTURE: '未來期間',
  DONE_ON_TIME: '已如期完成',
  DONE_LATE: '逾期完成',
  NA: '不適用',
}

export const HEALTH_COLOR: Record<TaskHealth, string> = {
  OVERDUE: '#dc2626',
  DUE_TODAY: '#ea580c',
  AT_RISK: '#d97706',
  UPCOMING: '#2563eb',
  FUTURE: '#64748b',
  DONE_ON_TIME: '#059669',
  DONE_LATE: '#9333ea',
  NA: '#94a3b8',
}

/** 任務完成度：必填檢核項目的完成比率 */
export function checklistProgress(task: Task, requiredIds: Set<string>): { done: number; total: number; pct: number } {
  const items = task.checklist.filter((c) => requiredIds.has(c.defId))
  const total = items.length
  const done = items.filter((c) => c.checked).length
  return { done, total, pct: total === 0 ? 100 : Math.round((done / total) * 100) }
}

/**
 * 逾期風險指數：以嚴重度 × 逾期天數/緊迫度 加總，供儀表板排序。
 */
export function urgencyScore(task: Task, severity: number, today: ISODate): number {
  const h = taskHealth(task, today)
  if (h === 'DONE_ON_TIME' || h === 'NA') return 0
  if (h === 'DONE_LATE') return severity
  const d = diffDays(task.dueDate, today)
  if (d < 0) return severity * (10 + Math.min(-d, 30))
  return severity * Math.max(0, 10 - Math.min(d, 10))
}
