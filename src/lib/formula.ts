/**
 * 極小型算式解析／求值器（Shunting-yard → RPN）
 * ------------------------------------------------------------------
 * 檢核規則的門檻與衍生指標以字串公式設定（例："currentAssets / currentLiabilities"），
 * 由財會人員自行維護，因此「不得」使用 eval / Function：
 *   1. 避免任意程式碼執行
 *   2. 錯誤可被攔截並回報給使用者，而非讓畫面整個崩掉
 * 支援：+ - * / ( ) 一元負號、數字、識別字、函式 MIN/MAX/ABS/IF
 */

export type Scope = Record<string, number | undefined>

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' }

export class FormulaError extends Error {}

const FUNCS: Record<string, { arity: number; fn: (...a: number[]) => number }> = {
  MIN: { arity: 2, fn: (a, b) => Math.min(a, b) },
  MAX: { arity: 2, fn: (a, b) => Math.max(a, b) },
  ABS: { arity: 1, fn: (a) => Math.abs(a) },
  IF: { arity: 3, fn: (c, a, b) => (c !== 0 ? a : b) },
}

const PREC: Record<string, number> = { 'u-': 4, '*': 3, '/': 3, '+': 2, '-': 2 }

export function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < src.length && /[0-9._]/.test(src[j])) j++
      const raw = src.slice(i, j).replace(/_/g, '')
      const v = Number(raw)
      if (!Number.isFinite(v)) throw new FormulaError(`無法解析的數值：${raw}`)
      out.push({ t: 'num', v })
      i = j
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j])) j++
      out.push({ t: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    if (c === '(') { out.push({ t: 'lp' }); i++; continue }
    if (c === ')') { out.push({ t: 'rp' }); i++; continue }
    if (c === ',') { out.push({ t: 'comma' }); i++; continue }
    if ('+-*/'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue }
    throw new FormulaError(`不支援的字元：「${c}」`)
  }
  return out
}

/** 轉為逆波蘭式 */
export function toRPN(tokens: Tok[]): Tok[] {
  const out: Tok[] = []
  const stack: Tok[] = []
  let prev: Tok | undefined
  for (const tk of tokens) {
    if (tk.t === 'num') { out.push(tk); prev = tk; continue }
    if (tk.t === 'id') {
      if (FUNCS[tk.v]) stack.push(tk)
      else out.push(tk)
      prev = tk
      continue
    }
    if (tk.t === 'comma') {
      while (stack.length && stack[stack.length - 1].t !== 'lp') out.push(stack.pop()!)
      if (!stack.length) throw new FormulaError('括號不對稱（逗號位置錯誤）')
      prev = tk
      continue
    }
    if (tk.t === 'op') {
      const unary = tk.v === '-' && (!prev || prev.t === 'op' || prev.t === 'lp' || prev.t === 'comma')
      const op = unary ? 'u-' : tk.v
      while (stack.length) {
        const top = stack[stack.length - 1]
        const topOp = top.t === 'op' ? top.v : top.t === 'id' ? 'fn' : undefined
        if (topOp === undefined) break
        const topPrec = topOp === 'fn' ? 9 : PREC[topOp]
        if (topPrec >= PREC[op] && op !== 'u-') out.push(stack.pop()!)
        else break
      }
      stack.push({ t: 'op', v: op })
      prev = tk
      continue
    }
    if (tk.t === 'lp') { stack.push(tk); prev = tk; continue }
    if (tk.t === 'rp') {
      while (stack.length && stack[stack.length - 1].t !== 'lp') out.push(stack.pop()!)
      if (!stack.length) throw new FormulaError('括號不對稱')
      stack.pop()
      const top = stack[stack.length - 1]
      if (top && top.t === 'id' && FUNCS[top.v]) out.push(stack.pop()!)
      prev = tk
      continue
    }
  }
  while (stack.length) {
    const t = stack.pop()!
    if (t.t === 'lp') throw new FormulaError('括號不對稱')
    out.push(t)
  }
  return out
}

/**
 * 求值。缺漏的識別字回傳 null（代表「資料不足，無法檢核」），
 * 這在財務檢核上必須與「檢核未通過」明確區分。
 */
export function evaluate(expr: string, scope: Scope): number | null {
  const rpn = toRPN(tokenize(expr))
  const st: number[] = []
  for (const tk of rpn) {
    if (tk.t === 'num') { st.push(tk.v); continue }
    if (tk.t === 'id') {
      const f = FUNCS[tk.v]
      if (f) {
        if (st.length < f.arity) throw new FormulaError(`函式 ${tk.v} 引數不足`)
        const args = st.splice(st.length - f.arity, f.arity)
        st.push(f.fn(...args))
        continue
      }
      const v = scope[tk.v]
      if (v === undefined || v === null || Number.isNaN(v)) return null
      st.push(v)
      continue
    }
    if (tk.t === 'op') {
      if (tk.v === 'u-') {
        if (!st.length) throw new FormulaError('一元負號缺少運算元')
        st.push(-st.pop()!)
        continue
      }
      if (st.length < 2) throw new FormulaError(`運算子 ${tk.v} 運算元不足`)
      const b = st.pop()!
      const a = st.pop()!
      switch (tk.v) {
        case '+': st.push(a + b); break
        case '-': st.push(a - b); break
        case '*': st.push(a * b); break
        case '/':
          if (b === 0) return null // 除以零 → 視為無法計算，而非 Infinity
          st.push(a / b)
          break
        default: throw new FormulaError(`不支援的運算子 ${tk.v}`)
      }
      continue
    }
    throw new FormulaError('算式結構錯誤')
  }
  if (st.length !== 1) throw new FormulaError('算式結構錯誤')
  const r = st[0]
  return Number.isFinite(r) ? r : null
}

/** 取出公式中引用到的識別字（排除函式名），供相依性分析／缺漏欄位提示 */
export function referencedIds(expr: string): string[] {
  return [...new Set(tokenize(expr).filter((t) => t.t === 'id' && !FUNCS[(t as any).v]).map((t) => (t as any).v as string))]
}
