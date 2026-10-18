"""讀取用的查詢：任務清單（含「等待中」「逾期」等顯示狀態）、軌跡、佐證、待辦。"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from datetime import date

from . import clock


@dataclass
class TaskView:
    id: int
    period: str
    code: str
    seq: int
    name: str
    owner: str
    reviewer: str | None
    due_rule: str
    due_date: date
    predecessors: list[str]
    needs_evidence: bool
    is_milestone: bool
    note: str
    status: str
    blocked: bool
    blocked_reason: str | None
    blocked_at: str | None
    blocked_by: str | None
    started_at: str | None
    submitted_at: str | None
    completed_at: str | None
    return_count: int
    cancelled: bool
    cancel_reason: str | None
    version: int
    updated_at: str
    updated_by: str
    # 以下為計算欄位
    waiting_on: list[str]
    evidence_count: int
    today: date

    @property
    def display_status(self) -> str:
        """畫面顯示的狀態：未開始且前置未完成者顯示「等待中」。"""
        if self.cancelled:
            return "已取消"
        if self.status == "未開始" and self.waiting_on:
            return "等待中"
        return self.status

    @property
    def is_done(self) -> bool:
        return self.status == "完成" or self.cancelled

    @property
    def completed_date(self) -> date | None:
        return date.fromisoformat(self.completed_at[:10]) if self.completed_at else None

    @property
    def is_overdue(self) -> bool:
        """尚未完成且已超過預計完成日。"""
        return not self.is_done and self.today > self.due_date

    @property
    def completed_late(self) -> bool:
        return self.status == "完成" and self.completed_date is not None and self.completed_date > self.due_date


def tasks_for_period(conn: sqlite3.Connection, period: str, today: date | None = None) -> list[TaskView]:
    today = today or clock.today()
    rows = conn.execute("SELECT * FROM tasks WHERE period = ? ORDER BY seq, code", (period,)).fetchall()
    done = {r["code"] for r in rows if r["status"] == "完成" or r["cancelled"]}
    names = {r["code"]: r["name"] for r in rows}
    ev_counts = dict(conn.execute(
        "SELECT e.task_id, COUNT(*) FROM evidence e JOIN tasks t ON t.id = e.task_id "
        "WHERE t.period = ? AND e.voided = 0 GROUP BY e.task_id", (period,)
    ).fetchall())
    views = []
    for r in rows:
        d = dict(r)
        preds = json.loads(d.pop("predecessors"))
        views.append(TaskView(
            **{k: d[k] for k in d if k not in ("needs_evidence", "is_milestone", "blocked", "cancelled", "due_date")},
            due_date=date.fromisoformat(r["due_date"]),
            predecessors=preds,
            needs_evidence=bool(r["needs_evidence"]),
            is_milestone=bool(r["is_milestone"]),
            blocked=bool(r["blocked"]),
            cancelled=bool(r["cancelled"]),
            waiting_on=[f"{p} {names.get(p, '')}".strip() for p in preds if p not in done],
            evidence_count=ev_counts.get(r["id"], 0),
            today=today,
        ))
    return views


def get_task(conn: sqlite3.Connection, task_id: int, today: date | None = None) -> TaskView | None:
    row = conn.execute("SELECT period FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        return None
    return next(t for t in tasks_for_period(conn, row["period"], today) if t.id == task_id)


def list_periods(conn: sqlite3.Connection) -> list[str]:
    return [r[0] for r in conn.execute("SELECT period FROM periods ORDER BY period DESC")]


def period_info(conn: sqlite3.Connection, period: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM periods WHERE period = ?", (period,)).fetchone()


def task_events(conn: sqlite3.Connection, task_id: int) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM events WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()


def period_events(conn: sqlite3.Connection, period: str) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM events WHERE period = ? ORDER BY id", (period,)).fetchall()


def system_events(conn: sqlite3.Connection, limit: int = 200) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM events WHERE period IS NULL ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()


def task_evidence(conn: sqlite3.Connection, task_id: int) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM evidence WHERE task_id = ? ORDER BY id", (task_id,)).fetchall()


def my_todo(tasks: list[TaskView], name: str) -> tuple[list[TaskView], list[TaskView]]:
    """回傳（我負責且未完成的任務, 等我覆核的任務）。"""
    mine = [t for t in tasks if t.owner == name and not t.is_done and t.status != "待覆核"]
    reviews = [t for t in tasks if t.reviewer == name and t.status == "待覆核" and not t.cancelled]
    return mine, reviews
