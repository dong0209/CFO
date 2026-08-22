import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { renderAnnualTimeline, renderChecklistDetail, renderMetricTable, renderObligationTables, renderRuleTable } from './docs'

/**
 * docs/ 底下的總表由主檔渲染。
 * 平時此測試偵測「制度改了、文件沒改」的漂移；
 * 執行 `npm run docs`（UPDATE_DOCS=1）則重新產生文件。
 */

/** 產生年度時間軸所用的基準年度；期限規則本身與年度無關，此處僅為呈現 */
const REFERENCE_YEAR = 2026

const MARK_START = '<!-- GENERATED:START 由 src/domain/docs.ts 產生，請勿手動編輯此區塊 -->'
const MARK_END = '<!-- GENERATED:END -->'

const FILES: { path: string; header: string; body: () => string }[] = [
  {
    path: 'docs/02-法遵行事曆總表.md',
    header: `# 法遵行事曆總表

依九大職能面向列出全部定期義務、到期規則、權責分工與法源。
「到期規則」中的「期末」指該義務所屬期間之最後一日（曆年制公司年度期末為 12/31）。
實際到期日由 \`src/engine/schedule.ts\` 依會計年度展開並做營業日調整：
法定申報期限遇例假日順延至次一營業日，內部作業期限則提前至前一營業日。
`,
    body: renderObligationTables,
  },
  {
    path: 'docs/03-檢核規則總表.md',
    header: `# 檢核規則與指標總表

規則 = 指標算式 + 比較子 + 門檻。門檻本身可以是算式，並引用公司政策參數
（\`policyEndorsementPct\` 等由「設定」頁帶入），因此調整政策即調整門檻，無須改動程式。

- **紅線（FAIL）**：已違反，須立即依「觸發時應採行動」處理
- **黃燈（WARN）**：尚未違反但緩衝不足，屬預警
- **資料不足（NO_DATA）**：缺欄位或分母為零。此狀態一律**不得**視為通過，且在檢核總分中一樣扣分
`,
    body: renderRuleTable,
  },
  {
    path: 'docs/04-檢核清單明細.md',
    header: `# 檢核清單明細

每項定期義務的完整檢核點，可直接作為作業底稿與稽核抽核依據。
控制點編號（如 \`C-FR-01\`）供內部控制制度與稽核計畫交叉引用。
`,
    body: renderChecklistDetail,
  },
  {
    path: 'docs/05-年度關鍵期限.md',
    header: `# 年度關鍵期限（曆年制上市公司）

以 ${REFERENCE_YEAR} 會計年度為例，列出嚴重度 4 以上之法定與規章義務的**法定期限**。
表列日期為未經營業日調整之原始期限；實際到期日遇例假日順延至次一營業日，
請以系統「法遵行事曆」為準。年度期間（如年報、營所稅）之法定期限落在次年度。
`,
    body: () => renderAnnualTimeline(REFERENCE_YEAR),
  },
]

describe('文件與主檔一致性', () => {
  for (const f of FILES) {
    it(`${f.path} 與主檔一致`, () => {
      const extra = f.path.endsWith('03-檢核規則總表.md') ? `\n## 指標字典\n\n${renderMetricTable()}\n` : ''
      const content = `${f.header}\n${MARK_START}\n\n${f.body()}\n${extra}${MARK_END}\n`
      if (process.env.UPDATE_DOCS) {
        writeFileSync(f.path, content)
        return
      }
      expect(existsSync(f.path), `${f.path} 不存在，請執行 npm run docs`).toBe(true)
      expect(readFileSync(f.path, 'utf8'), `${f.path} 已過期，請執行 npm run docs`).toBe(content)
    })
  }
})
