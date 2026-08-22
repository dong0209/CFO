import type { Task } from '../domain/types'
import type { TaskOverride, Workspace } from '../domain/workspace'

/**
 * 將使用者覆寫套用到衍生出來的任務骨架上。
 * 覆寫中若含有主檔已不存在的檢核項目（例如檢核清單改版後被刪除的項目），
 * 會自動忽略；主檔新增的項目則以未勾選呈現。兩者皆不需要資料遷移。
 */
export function applyOverrides(tasks: Task[], overrides: Record<string, TaskOverride>): Task[] {
  return tasks.map((t) => {
    const o = overrides[t.id]
    if (!o) return t
    return {
      ...t,
      status: o.status ?? t.status,
      assignee: o.assignee ?? t.assignee,
      note: o.note ?? t.note,
      completedAt: o.completedAt,
      completedBy: o.completedBy,
      checklist: t.checklist.map((c) => {
        const ov = o.checks?.[c.defId]
        return ov?.checked ? { ...c, checked: true, checkedBy: ov.by, checkedAt: ov.at } : c
      }),
    }
  })
}

/** 統計覆寫涵蓋率，供設定頁顯示「這個工作區累積了多少實際作業紀錄」 */
export function overrideStats(ws: Pick<Workspace, 'overrides'>): { tasks: number; checks: number } {
  const entries = Object.values(ws.overrides)
  return {
    tasks: entries.length,
    checks: entries.reduce((n, o) => n + Object.values(o.checks ?? {}).filter((c) => c.checked).length, 0),
  }
}
