import { describe, expect, it } from 'vitest'
import { applyMutation, describeMutation, isValidMutation, requiresAdmin, type Mutation } from './mutations'
import { createWorkspace } from '../state/defaults'
import { applyOverrides, overrideStats } from '../engine/overrides'
import { generateTasks } from '../engine/schedule'
import { RECURRING_OBLIGATIONS } from './obligations'
import type { Workspace } from './workspace'

const CTX = { actor: '王小明', today: '2026-08-22' }
const blank = (): Workspace => createWorkspace({ fiscalYear: 2026, today: CTX.today, demo: false })
const TASK = 'RPT-MONTHLY-REVENUE::2026-01'

describe('applyMutation', () => {
  it('勾選檢核項目會記錄勾稽人與日期', () => {
    const ws = applyMutation(blank(), { kind: 'check', taskId: TASK, defId: 'X#01', checked: true }, CTX)
    expect(ws.overrides[TASK].checks!['X#01']).toEqual({ checked: true, by: '王小明', at: '2026-08-22' })
  })

  it('取消勾選會移除紀錄，覆寫變空時整筆刪除（不累積空物件）', () => {
    let ws = applyMutation(blank(), { kind: 'check', taskId: TASK, defId: 'X#01', checked: true }, CTX)
    ws = applyMutation(ws, { kind: 'check', taskId: TASK, defId: 'X#01', checked: false }, CTX)
    expect(ws.overrides[TASK]).toBeUndefined()
  })

  it('標記完成會寫入完成日與完成人', () => {
    const ws = applyMutation(blank(), { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, CTX)
    expect(ws.overrides[TASK]).toMatchObject({ status: 'DONE', completedAt: '2026-08-22', completedBy: '王小明' })
  })

  it('重複標記完成不會覆蓋既有結案資訊（重送同一變更是冪等的）', () => {
    let ws = applyMutation(blank(), { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, CTX)
    ws = applyMutation(ws, { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, { actor: '李四', today: '2026-09-30' })
    expect(ws.overrides[TASK].completedAt).toBe('2026-08-22')
    expect(ws.overrides[TASK].completedBy).toBe('王小明')
  })

  it('退回後重新結案，記錄的是新的結案日（舊紀錄留在稽核軌跡）', () => {
    let ws = applyMutation(blank(), { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, CTX)
    ws = applyMutation(ws, { kind: 'taskStatus', taskId: TASK, status: 'IN_PROGRESS' }, CTX)
    ws = applyMutation(ws, { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, { actor: '李四', today: '2026-09-30' })
    expect(ws.overrides[TASK].completedAt).toBe('2026-09-30')
    expect(ws.overrides[TASK].completedBy).toBe('李四')
  })

  it('取消完成狀態會清除完成資訊', () => {
    let ws = applyMutation(blank(), { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, CTX)
    ws = applyMutation(ws, { kind: 'taskStatus', taskId: TASK, status: 'IN_PROGRESS' }, CTX)
    expect(ws.overrides[TASK].completedAt).toBeUndefined()
  })

  it('清空備註與承辦人不會留下空字串', () => {
    let ws = applyMutation(blank(), { kind: 'taskField', taskId: TASK, patch: { note: '已申報' } }, CTX)
    expect(ws.overrides[TASK].note).toBe('已申報')
    ws = applyMutation(ws, { kind: 'taskField', taskId: TASK, patch: { note: '' } }, CTX)
    expect(ws.overrides[TASK]).toBeUndefined()
  })

  it('財務科目設為 null 表示清除該欄位', () => {
    const ws0 = blank()
    const id = ws0.financials[0].id
    let ws = applyMutation(ws0, { kind: 'financialValue', id, metricId: 'cash', value: 100 }, CTX)
    expect(ws.financials[0].values.cash).toBe(100)
    ws = applyMutation(ws, { kind: 'financialValue', id, metricId: 'cash', value: null }, CTX)
    expect('cash' in ws.financials[0].values).toBe(false)
  })

  it('切換到不存在的財務期別不會產生無效狀態', () => {
    const ws = applyMutation(blank(), { kind: 'activeFinancial', id: '不存在' }, CTX)
    expect(ws.activeFinancialId).toBe(blank().activeFinancialId)
  })

  it('不會就地修改原物件（前端可安全回復樂觀更新）', () => {
    const ws = blank()
    const snapshot = JSON.stringify(ws)
    applyMutation(ws, { kind: 'check', taskId: TASK, defId: 'X#01', checked: true }, CTX)
    expect(JSON.stringify(ws)).toBe(snapshot)
  })
})

describe('權限分級', () => {
  it('公司設定、會計年度與持股資料屬管理者權限', () => {
    expect(requiresAdmin({ kind: 'fiscalYear', year: 2027 })).toBe(true)
    expect(requiresAdmin({ kind: 'holding', patch: { parValue: 10 } })).toBe(true)
    expect(requiresAdmin({ kind: 'check', taskId: TASK, defId: 'a', checked: true })).toBe(false)
  })
})

describe('isValidMutation（伺服器不信任用戶端輸入）', () => {
  const cases: [string, unknown, boolean][] = [
    ['合法的勾選', { kind: 'check', taskId: 'a', defId: 'b', checked: true }, true],
    ['未知的 kind', { kind: 'dropTable', taskId: 'a' }, false],
    ['缺少欄位', { kind: 'check', taskId: 'a' }, false],
    ['非法狀態值', { kind: 'taskStatus', taskId: 'a', status: 'HACKED' }, false],
    ['合法狀態值', { kind: 'taskStatus', taskId: 'a', status: 'DONE' }, true],
    ['年度超出範圍', { kind: 'fiscalYear', year: 99999 }, false],
    ['年度非整數', { kind: 'fiscalYear', year: 2026.5 }, false],
    ['備註過長', { kind: 'taskField', taskId: 'a', patch: { note: 'x'.repeat(20001) } }, false],
    ['null', null, false],
    ['字串', 'check', false],
  ]
  for (const [name, input, expected] of cases) {
    it(name, () => expect(isValidMutation(input)).toBe(expected))
  }
})

describe('describeMutation（稽核軌跡可讀性）', () => {
  it('每種變更都產生對象與描述', () => {
    const all: Mutation[] = [
      { kind: 'check', taskId: TASK, defId: 'X#01', checked: true },
      { kind: 'taskStatus', taskId: TASK, status: 'DONE' },
      { kind: 'taskField', taskId: TASK, patch: { assignee: '王小明' } },
      { kind: 'fiscalYear', year: 2027 },
      { kind: 'profile', profile: blank().profile },
      { kind: 'holding', patch: { parValue: 10 } },
      { kind: 'activeFinancial', id: '2026Q1' },
      { kind: 'financialValue', id: '2026Q1', metricId: 'cash', value: 1 },
    ]
    for (const m of all) {
      const d = describeMutation(m)
      expect(d.target.length, m.kind).toBeGreaterThan(0)
      expect(d.detail.length, m.kind).toBeGreaterThan(0)
    }
  })
})

describe('applyOverrides', () => {
  const skeleton = () =>
    generateTasks({ fiscalYear: 2026, profile: blank().profile, obligations: RECURRING_OBLIGATIONS })

  it('把覆寫套用回衍生任務', () => {
    let ws = blank()
    const defId = skeleton().find((t) => t.id === TASK)!.checklist[0].defId
    ws = applyMutation(ws, { kind: 'check', taskId: TASK, defId, checked: true }, CTX)
    ws = applyMutation(ws, { kind: 'taskStatus', taskId: TASK, status: 'DONE' }, CTX)

    const t = applyOverrides(skeleton(), ws.overrides).find((x) => x.id === TASK)!
    expect(t.status).toBe('DONE')
    expect(t.completedAt).toBe('2026-08-22')
    expect(t.checklist[0]).toMatchObject({ checked: true, checkedBy: '王小明', checkedAt: '2026-08-22' })
  })

  it('主檔已移除的檢核項目其覆寫會被忽略，不影響其他項目', () => {
    const ws = applyMutation(blank(), { kind: 'check', taskId: TASK, defId: '已不存在的項目', checked: true }, CTX)
    const t = applyOverrides(skeleton(), ws.overrides).find((x) => x.id === TASK)!
    expect(t.checklist.every((c) => !c.checked)).toBe(true)
  })

  it('主檔新增的檢核項目以未勾選呈現，不需資料遷移', () => {
    const ws = applyMutation(blank(), { kind: 'taskStatus', taskId: TASK, status: 'IN_PROGRESS' }, CTX)
    const tasks = applyOverrides(skeleton(), ws.overrides)
    const t = tasks.find((x) => x.id === TASK)!
    expect(t.status).toBe('IN_PROGRESS')
    expect(t.checklist.length).toBeGreaterThan(0)
    expect(t.checklist.every((c) => !c.checked)).toBe(true)
  })

  it('沒有覆寫的任務原樣通過', () => {
    const tasks = skeleton()
    expect(applyOverrides(tasks, {})).toEqual(tasks)
  })

  it('統計已累積的作業紀錄', () => {
    let ws = blank()
    const defs = skeleton().find((t) => t.id === TASK)!.checklist
    ws = applyMutation(ws, { kind: 'check', taskId: TASK, defId: defs[0].defId, checked: true }, CTX)
    ws = applyMutation(ws, { kind: 'check', taskId: TASK, defId: defs[1].defId, checked: true }, CTX)
    expect(overrideStats(ws)).toEqual({ tasks: 1, checks: 2 })
  })
})

describe('createWorkspace', () => {
  it('正式模式（demo=false）不產生任何作業紀錄與財務數據', () => {
    const ws = blank()
    expect(Object.keys(ws.overrides)).toHaveLength(0)
    expect(ws.financials.every((f) => Object.keys(f.values).length === 0)).toBe(true)
  })

  it('示範模式會產生歷史紀錄，且已到期任務多數結案', () => {
    const ws = createWorkspace({ fiscalYear: 2026, today: '2026-08-22', demo: true })
    const tasks = applyOverrides(
      generateTasks({ fiscalYear: 2026, profile: ws.profile, obligations: RECURRING_OBLIGATIONS }),
      ws.overrides,
    )
    const pastDue = tasks.filter((t) => t.dueDate < '2026-08-22')
    const done = pastDue.filter((t) => t.status === 'DONE')
    expect(pastDue.length).toBeGreaterThan(50)
    expect(done.length / pastDue.length).toBeGreaterThan(0.9)
  })
})
