"""產生示範用假資料：模擬多個月的完整月結流程，最後一個月停在進行中。

用法（在 month-close 資料夾下）：
    python -m closeapp.demo                 # 產生到 data/demo
    python -m closeapp.demo --months 3      # 只模擬 3 個月

所有操作都透過正式的業務規則（services.py）執行，所以覆核軌跡、雜湊鏈、
退回、卡關、逾期都和真實使用時一樣。為避免誤刪，只會清除帶有示範標記的資料夾。
"""
from __future__ import annotations

import argparse
import os
import random
import shutil
import sys
from dataclasses import dataclass, replace
from datetime import date, datetime, time, timedelta
from pathlib import Path

from . import audit, services as svc
from .config import ROOT, load_settings
from .context import AppContext, load_context
from .db import open_db
from .queries import tasks_for_period
from .workdays import due_date, month_end, prev_period

MARKER = ".demo-data"
DEFAULT_DIR = ROOT / "data" / "demo"
DEFAULT_CURRENT = "2026-09"
DEFAULT_AT = datetime(2026, 10, 6, 12, 0)   # 2026-09 月結的 T+4 中午

BOTTLENECKS = {"S02", "S08", "S12", "S15"}   # 刻意設計成較常延誤的步驟
BLOCK_REASONS = {
    "S02": ["電商平台撥款明細尚未提供", "平台退貨資料與撥款對不上，待平台回覆"],
    "S04": ["銀行對帳單尚未取得"],
    "S08": ["廠商尚未回覆本月價保金額", "回饋金合約條件待業務確認"],
    "S09": ["門市盤點表尚未全部回傳"],
    "S12": ["待業務提供滯銷品清單", "新機上市，舊機型售價未定"],
    "S15": ["毛利率差異原因待業務說明"],
}
GENERIC_BLOCKS = ["等待其他部門提供資料", "系統報表跑不出來，已報修"]
REJECT_REASONS = [
    "暫估依據未附採購單，請補附",
    "調節項目金額與明細不符，請再核對",
    "差異超過門檻但未填說明",
    "附件版本不是最新，請更新",
    "請補充與上月比較的說明",
]


@dataclass
class Action:
    at: datetime
    order: int
    run: callable


class Simulator:
    def __init__(self, ctx: AppContext, conn, rng: random.Random):
        self.ctx, self.conn, self.rng = ctx, conn, rng
        self.cal = ctx.calendar
        self.manager = next(p for p in ctx.people.values() if p.is_manager)
        self.actions: list[Action] = []

    # ---------------------------------------------------------- 時間工具
    def _work(self, dt: datetime) -> datetime:
        """把時間推到上班時段（工作日 09:00–18:00）。"""
        if dt.time() >= time(18, 0):
            dt = datetime.combine(dt.date() + timedelta(days=1), time(9, self.rng.randint(0, 40)))
        while not self.cal.is_workday(dt.date()):
            dt = datetime.combine(dt.date() + timedelta(days=1), time(9, self.rng.randint(0, 40)))
        if dt.time() < time(9, 0):
            dt = datetime.combine(dt.date(), time(9, self.rng.randint(0, 40)))
        return dt

    def _later(self, dt: datetime, lo_min: int, hi_min: int) -> datetime:
        return self._work(dt + timedelta(minutes=self.rng.randint(lo_min, hi_min)))

    def _shift(self, d: date, n: int) -> date:
        if n >= 0:
            return self.cal.add_workdays(d, n)
        for _ in range(-n):
            d -= timedelta(days=1)
            while not self.cal.is_workday(d):
                d -= timedelta(days=1)
        return d

    def _on(self, d: date, h0: int, h1: int) -> datetime:
        return datetime.combine(d, time(self.rng.randint(h0, h1), self.rng.randint(0, 59)))

    def add(self, at: datetime, fn) -> None:
        self.actions.append(Action(at, len(self.actions), fn))

    # ---------------------------------------------------------- 單月排程
    def plan_period(self, period: str, age: int, forced: dict[str, dict] | None = None) -> None:
        """age：距離目前月份幾個月（越久以前延誤越多，呈現流程逐步改善的趨勢）。"""
        forced = forced or {}
        ctx, rng = self.ctx, self.rng
        gen_at = datetime.combine(self.cal.add_workdays(month_end(period), 1), time(8, 30))
        self.add(gen_at, lambda: svc.generate_period(
            self.conn, period, ctx.template, ctx.people, self.cal, self.manager,
            ctx.template_hash, now=gen_at))

        month = int(period[5:])
        steps = [s for s in ctx.template if s.applies_to(month)]
        done_at: dict[str, datetime] = {}
        drift = min(age, 8) / 8  # 0（最近）～1（最舊）
        for s in steps:
            f = forced.get(s.code, {})
            due = due_date(s, period, self.cal)
            if s.due_rule.startswith("次月"):
                delay = rng.choice([-3, -2, -2, -1, -1, 0])
            elif s.code in BOTTLENECKS:
                delay = rng.choice([0, 0, 0, 0, 1, 1, 2]) + (1 if rng.random() < drift * 0.8 else 0)
            else:
                delay = rng.choice([-1, 0, 0, 0, 0, 0, 0, 0, 0, 1]) + (1 if rng.random() < drift * 0.15 else 0)
            delay = f.get("delay", delay)
            target = self._shift(due, delay)
            preds = [done_at[p] for p in s.predecessors if p in done_at]
            ready = max(preds, default=gen_at)

            start = self._work(max(gen_at + timedelta(minutes=rng.randint(20, 90)),
                                   self._on(self._shift(target, -1), 9, 15)))
            if f.get("early_start"):
                start = self._later(gen_at, 30, 60)
            submit = self._work(max(ready + timedelta(minutes=rng.randint(20, 90)),
                                    self._on(target, 9, 13), start + timedelta(minutes=40)))

            blocked = f.get("block", rng.random() < (0.25 if s.code in BOTTLENECKS else 0.04))
            if blocked:
                block_at = self._later(start, 10, 60)
                reasons = BLOCK_REASONS.get(s.code, GENERIC_BLOCKS)
                reason = f.get("block_reason") or rng.choice(reasons)
                unblock_at = f.get("unblock_at") or self._later(block_at, 120, 900)
                submit = max(submit, self._later(unblock_at, 20, 90))
                self._act_block(period, s.code, block_at, unblock_at, reason)

            evid_at = max(start + timedelta(minutes=5), submit - timedelta(minutes=15))
            if s.needs_evidence:
                self._act_evidence(period, s, evid_at)

            self.add(start, self._op(period, s.code, "start", start))
            self.add(submit, self._op(period, s.code, "submit", submit))
            if not s.reviewer:
                done_at[s.code] = submit
                continue
            reviewer = ctx.people[s.reviewer]
            rejected = f.get("reject", rng.random() < (0.25 if s.code in BOTTLENECKS else 0.06))
            if rejected:
                reject_at = self._later(submit, 30, 120)
                reason = rng.choice(REJECT_REASONS)
                self.add(reject_at, self._op(period, s.code, "reject", reject_at, reason=reason, who=reviewer))
                submit = self._later(reject_at, *f.get("resubmit_after", (60, 240)))
                self.add(submit, self._op(period, s.code, "submit", submit))
            approve_at = self._later(submit, 20, 120)
            self.add(approve_at, self._op(period, s.code, "approve", approve_at, who=reviewer))
            done_at[s.code] = approve_at

    # ---------------------------------------------------------- 動作
    def _task(self, period: str, code: str):
        return next(t for t in tasks_for_period(self.conn, period) if t.code == code)

    def _op(self, period: str, code: str, op: str, at: datetime, reason: str = "", who=None):
        def run():
            t = self._task(period, code)
            owner = self.ctx.people[t.owner]
            if op == "start":
                svc.start(self.conn, t.id, t.version, owner, now=at)
            elif op == "submit":
                svc.submit(self.conn, t.id, t.version, owner, now=at)
            elif op == "reject":
                svc.reject(self.conn, t.id, t.version, who, reason, now=at)
            elif op == "approve":
                svc.approve(self.conn, t.id, t.version, who, now=at)
        return run

    def _act_block(self, period, code, block_at, unblock_at, reason):
        def do_block():
            t = self._task(period, code)
            svc.block(self.conn, t.id, t.version, self.ctx.people[t.owner], reason, now=block_at)

        def do_unblock():
            t = self._task(period, code)
            svc.unblock(self.conn, t.id, t.version, self.ctx.people[t.owner], "已取得資料，繼續處理", now=unblock_at)
        self.add(block_at, do_block)
        self.add(unblock_at, do_unblock)

    def _act_evidence(self, period, step, at):
        def run():
            t = self._task(period, step.code)
            owner = self.ctx.people[t.owner]
            if step.code in ("S01", "S04", "S14"):
                body = f"假資料,{period},{step.name}\n項目,金額\n示範,0\n".encode("utf-8-sig")
                svc.add_evidence_file(self.conn, t.id, owner, f"{period}_{step.code}_{step.name}.csv",
                                      body, self.ctx.settings.evidence_dir, now=at)
            else:
                svc.add_evidence_path(self.conn, t.id, owner,
                                      f"\\\\fileserver\\財務\\月結\\{period}\\{step.code}_{step.name}.xlsx", now=at)
        self.add(at, run)

    def run_until(self, until: datetime) -> int:
        n = 0
        for a in sorted(self.actions, key=lambda a: (a.at, a.order)):
            if a.at > until:
                continue
            a.run()
            n += 1
        return n


def build_demo(data_dir: Path = DEFAULT_DIR, months: int = 12, current: str = DEFAULT_CURRENT,
               at: datetime = DEFAULT_AT, seed: int = 20260930) -> dict:
    data_dir = Path(data_dir).resolve()
    real = load_settings().data_dir.resolve() if not os.environ.get("CLOSEAPP_DATA_DIR") else None
    if real and data_dir == real:
        raise SystemExit("示範資料不可寫入正式資料夾。")
    if data_dir.exists() and any(data_dir.iterdir()):
        if not (data_dir / MARKER).exists():
            raise SystemExit(f"{data_dir} 不是示範資料夾（缺少 {MARKER} 標記），為避免誤刪已停止。")
        shutil.rmtree(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / MARKER).write_text("此資料夾為示範用假資料，可隨時刪除重建。\n", encoding="utf-8")

    settings = replace(load_settings(), data_dir=data_dir)
    ctx = load_context(settings)
    periods = [current]
    for _ in range(months - 1):
        periods.insert(0, prev_period(periods[0]))

    with open_db(settings.db_path) as conn:
        sim = Simulator(ctx, conn, random.Random(seed))
        for i, p in enumerate(periods):
            forced = None
            if p == current:
                # 讓目前月份一定看得到：卡關中、被退回後待重送、逾期
                forced = {
                    "S08": {"delay": 3, "block": True, "early_start": True, "block_reason": "廠商尚未回覆本月價保金額",
                            "unblock_at": at + timedelta(days=3)},
                    "S07": {"reject": True, "delay": 0, "block": False,
                            "resubmit_after": (60 * 24 * 7, 60 * 24 * 8)},
                }
            sim.plan_period(p, age=len(periods) - 1 - i, forced=forced)
        n = sim.run_until(at)
        chain = audit.verify_chain(conn)
    return {"資料夾": str(data_dir), "月份": periods, "執行動作數": n, "雜湊鏈": chain.message}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="產生月結進度追蹤系統的示範假資料")
    ap.add_argument("--data-dir", default=str(DEFAULT_DIR), help="輸出資料夾（預設 data/demo）")
    ap.add_argument("--months", type=int, default=12, help="模擬月數（含目前月份，預設 12）")
    ap.add_argument("--current", default=DEFAULT_CURRENT, help="目前進行中的月份（預設 2026-09）")
    ap.add_argument("--at", default=DEFAULT_AT.strftime("%Y-%m-%d %H:%M"),
                    help="模擬到的時間點（預設 2026-10-06 12:00，即 9 月月結 T+4）")
    args = ap.parse_args(argv)
    result = build_demo(Path(args.data_dir), args.months, args.current,
                        datetime.strptime(args.at, "%Y-%m-%d %H:%M"))
    print("示範資料已產生：")
    for k, v in result.items():
        print(f"  {k}：{v if not isinstance(v, list) else f'{v[0]} ～ {v[-1]}（{len(v)} 個月）'}")
    print(f"\n啟動示範：CLOSEAPP_DATA_DIR={result['資料夾']} CLOSEAPP_TODAY={args.at[:10]} "
          f"streamlit run app.py")


if __name__ == "__main__":
    sys.exit(main())
