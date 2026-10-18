"""月結業務規則：產生當月任務、狀態流程、覆核、卡關、佐證。

所有寫入動作的共同規則：
1. 在 BEGIN IMMEDIATE 交易中執行，並同時寫入覆核軌跡（同成同敗）。
2. 呼叫端要傳入「畫面上看到的版本號」expected_version；
   若別人已先更新同一任務，丟出 ConflictError，不會覆蓋別人的資料。
3. 權限：負責人做「開始、送審」，覆核人做「核准、退回」；主管可代理任何人，
   但軌跡會標示「代理」。無論誰操作，同一任務的負責人都不能核准自己的工作。
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime
from pathlib import Path

from . import audit, clock
from .config import Person, TemplateStep, validate_template
from .db import transaction
from .workdays import WorkCalendar, due_date, month_end

STATUSES = ("未開始", "進行中", "待覆核", "完成")


class ServiceError(Exception):
    """操作不被允許；訊息會直接顯示給使用者。"""


class ConflictError(ServiceError):
    """資料已被別人更新。"""


# ---------------------------------------------------------------- 共用

def _task(conn: sqlite3.Connection, task_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise ServiceError("找不到這個任務。")
    return row


def _check_version(task: sqlite3.Row, expected_version: int) -> None:
    if task["version"] != expected_version:
        when = (task["updated_at"] or "")[5:16]
        raise ConflictError(
            f"此任務已被 {task['updated_by']} 於 {when} 更新，請重新整理畫面後再操作。")


def _need_reason(text: str | None, what: str) -> str:
    text = (text or "").strip()
    if not text:
        raise ServiceError(f"請填寫{what}。")
    return text


def _as_owner(task: sqlite3.Row, actor: Person) -> bool:
    """回傳是否為主管代理；非負責人也非主管則拒絕。"""
    if actor.name == task["owner"]:
        return False
    if actor.is_manager:
        return True
    raise ServiceError(f"只有負責人（{task['owner']}）或主管可以執行此操作。")


def _as_reviewer(task: sqlite3.Row, actor: Person) -> bool:
    if actor.name == task["owner"]:
        raise ServiceError("負責人不可覆核自己的工作（職能分離）。")
    if actor.name == task["reviewer"]:
        return False
    if actor.is_manager:
        return True
    raise ServiceError(f"只有覆核人（{task['reviewer']}）或主管可以執行此操作。")


def _as_party(task: sqlite3.Row, actor: Person) -> bool:
    if actor.name in (task["owner"], task["reviewer"]):
        return False
    if actor.is_manager:
        return True
    raise ServiceError("只有此任務的負責人、覆核人或主管可以執行此操作。")


def _as_manager(actor: Person) -> None:
    if not actor.is_manager:
        raise ServiceError("只有主管可以執行此操作。")


def _not_cancelled(task: sqlite3.Row) -> None:
    if task["cancelled"]:
        raise ServiceError("此任務本月已取消。")


def _update(conn: sqlite3.Connection, task: sqlite3.Row, expected_version: int,
            actor: Person, now: datetime, **fields) -> None:
    fields.update(version=expected_version + 1, updated_at=clock.fmt(now), updated_by=actor.name)
    sets = ", ".join(f"{k} = ?" for k in fields)
    cur = conn.execute(
        f"UPDATE tasks SET {sets} WHERE id = ? AND version = ?",
        [*fields.values(), task["id"], expected_version],
    )
    if cur.rowcount != 1:  # 理論上不會發生（已在交易內檢查），雙重保險
        raise ConflictError("此任務已被其他人更新，請重新整理畫面後再操作。")


def _log(conn, task: sqlite3.Row, actor: Person, action: str, now: datetime, *,
         to_status: str | None = None, note: str = "", proxy: bool = False,
         detail: dict | None = None) -> None:
    audit.append_event(
        conn, actor=actor.name, action=action, now=now, period=task["period"],
        task_id=task["id"], task_code=task["code"], from_status=task["status"],
        to_status=to_status or task["status"], note=note, proxy=proxy, detail=detail,
    )


def unfinished_predecessors(conn: sqlite3.Connection, task: sqlite3.Row) -> list[str]:
    """尚未完成的前置步驟名稱。已取消的前置步驟視同完成。"""
    codes = json.loads(task["predecessors"])
    if not codes:
        return []
    marks = ",".join("?" * len(codes))
    rows = conn.execute(
        f"SELECT code, name FROM tasks WHERE period = ? AND code IN ({marks}) "
        f"AND status != '完成' AND cancelled = 0 ORDER BY seq",
        [task["period"], *codes],
    ).fetchall()
    return [f"{r['code']} {r['name']}" for r in rows]


def _active_evidence_count(conn: sqlite3.Connection, task_id: int) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM evidence WHERE task_id = ? AND voided = 0", (task_id,)
    ).fetchone()[0]


# ---------------------------------------------------------------- 產生當月任務

def generate_period(conn: sqlite3.Connection, period: str, steps: list[TemplateStep],
                    people: dict[str, Person], cal: WorkCalendar, actor: Person,
                    template_hash: str, now: datetime | None = None) -> int:
    """依範本產生當月任務，回傳產生的任務數。範本內容會複製到任務上（快照）。"""
    now = now or clock.now()
    _as_manager(actor)
    if not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", period):
        raise ServiceError("月份格式須為 2026-09。")
    errors = validate_template(steps, people)
    if errors:
        raise ServiceError("範本有誤，請先修正：\n" + "\n".join(errors))
    month = int(period[5:])
    applicable = [s for s in steps if s.applies_to(month)]
    codes = {s.code for s in applicable}
    stamp = clock.fmt(now)
    with transaction(conn):
        if conn.execute("SELECT 1 FROM periods WHERE period = ?", (period,)).fetchone():
            raise ServiceError(f"{period} 的任務已經產生過了。")
        conn.execute(
            "INSERT INTO periods (period, month_end, generated_at, generated_by, template_hash) "
            "VALUES (?, ?, ?, ?, ?)",
            (period, month_end(period).isoformat(), stamp, actor.name, template_hash),
        )
        for s in applicable:
            preds = [p for p in s.predecessors if p in codes]
            conn.execute(
                "INSERT INTO tasks (period, code, seq, name, owner, reviewer, due_rule, due_date, "
                "predecessors, needs_evidence, is_milestone, note, updated_at, updated_by) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (period, s.code, s.seq, s.name, s.owner, s.reviewer, s.due_rule,
                 due_date(s, period, cal).isoformat(), json.dumps(preds),
                 int(s.needs_evidence), int(s.is_milestone), s.note, stamp, actor.name),
            )
        audit.append_event(
            conn, actor=actor.name, action="產生月結任務", now=now, period=period,
            note=f"依範本產生 {len(applicable)} 項任務",
            detail={"範本雜湊": template_hash, "步驟": sorted(codes)},
        )
    return len(applicable)


# ---------------------------------------------------------------- 狀態流程

def start(conn, task_id: int, expected_version: int, actor: Person, now: datetime | None = None) -> None:
    """未開始 → 進行中。前置步驟未完成也可以先開始（但不能送審）。"""
    now = now or clock.now()
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        proxy = _as_owner(t, actor)
        if t["status"] != "未開始":
            raise ServiceError(f"目前狀態為「{t['status']}」，無法開始。")
        _update(conn, t, expected_version, actor, now, status="進行中",
                started_at=t["started_at"] or clock.fmt(now))
        _log(conn, t, actor, "開始", now, to_status="進行中", proxy=proxy)


def submit(conn, task_id: int, expected_version: int, actor: Person,
           note: str = "", now: datetime | None = None) -> str:
    """進行中 → 待覆核（沒有覆核人時直接完成）。回傳新狀態。"""
    now = now or clock.now()
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        proxy = _as_owner(t, actor)
        if t["status"] != "進行中":
            raise ServiceError(f"目前狀態為「{t['status']}」，須先「開始」才能送出。")
        if waiting := unfinished_predecessors(conn, t):
            raise ServiceError("前置步驟尚未完成，不能送出：\n" + "\n".join(waiting))
        if t["needs_evidence"] and _active_evidence_count(conn, task_id) == 0:
            raise ServiceError("此步驟需附佐證，請先上傳檔案或填寫共用資料夾路徑。")
        stamp = clock.fmt(now)
        if t["reviewer"]:
            _update(conn, t, expected_version, actor, now, status="待覆核", submitted_at=stamp)
            _log(conn, t, actor, "送出覆核", now, to_status="待覆核", note=note, proxy=proxy)
            return "待覆核"
        _update(conn, t, expected_version, actor, now, status="完成", submitted_at=stamp,
                completed_at=stamp, blocked=0)
        _log(conn, t, actor, "完成（無需覆核）", now, to_status="完成", note=note, proxy=proxy)
        return "完成"


def approve(conn, task_id: int, expected_version: int, actor: Person,
            note: str = "", now: datetime | None = None) -> None:
    """待覆核 → 完成。"""
    now = now or clock.now()
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        proxy = _as_reviewer(t, actor)
        if t["status"] != "待覆核":
            raise ServiceError(f"目前狀態為「{t['status']}」，沒有待覆核的內容。")
        if waiting := unfinished_predecessors(conn, t):
            raise ServiceError("前置步驟已被重新開啟、尚未完成，暫不能核准：\n" + "\n".join(waiting))
        detail = {}
        if t["blocked"]:
            detail["自動解除卡關"] = t["blocked_reason"]
        _update(conn, t, expected_version, actor, now, status="完成",
                completed_at=clock.fmt(now), blocked=0)
        _log(conn, t, actor, "核准", now, to_status="完成", note=note, proxy=proxy, detail=detail)


def reject(conn, task_id: int, expected_version: int, actor: Person,
           reason: str, now: datetime | None = None) -> None:
    """待覆核 → 進行中，必須填原因。"""
    now = now or clock.now()
    reason = _need_reason(reason, "退回原因")
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        proxy = _as_reviewer(t, actor)
        if t["status"] != "待覆核":
            raise ServiceError(f"目前狀態為「{t['status']}」，沒有待覆核的內容。")
        _update(conn, t, expected_version, actor, now, status="進行中",
                return_count=t["return_count"] + 1)
        _log(conn, t, actor, "退回", now, to_status="進行中", note=reason, proxy=proxy)


def block(conn, task_id: int, expected_version: int, actor: Person,
          reason: str, now: datetime | None = None) -> None:
    """標記卡關（任何未完成的狀態皆可），必須填原因。"""
    now = now or clock.now()
    reason = _need_reason(reason, "卡關原因")
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        proxy = _as_party(t, actor)
        if t["status"] == "完成":
            raise ServiceError("已完成的任務不能標記卡關。")
        if t["blocked"]:
            raise ServiceError("此任務已經是卡關狀態。")
        _update(conn, t, expected_version, actor, now, blocked=1, blocked_reason=reason,
                blocked_at=clock.fmt(now), blocked_by=actor.name)
        _log(conn, t, actor, "標記卡關", now, note=reason, proxy=proxy)


def unblock(conn, task_id: int, expected_version: int, actor: Person,
            note: str = "", now: datetime | None = None) -> None:
    now = now or clock.now()
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        proxy = _as_party(t, actor)
        if not t["blocked"]:
            raise ServiceError("此任務沒有卡關。")
        _update(conn, t, expected_version, actor, now, blocked=0)
        _log(conn, t, actor, "解除卡關", now, note=note, proxy=proxy,
             detail={"原卡關原因": t["blocked_reason"], "卡關時間": t["blocked_at"]})


# ---------------------------------------------------------------- 主管功能

def reassign(conn, task_id: int, expected_version: int, actor: Person, people: dict[str, Person],
             owner: str, reviewer: str | None, reason: str, now: datetime | None = None) -> None:
    """改派當月任務的負責人／覆核人（不影響範本）。"""
    now = now or clock.now()
    _as_manager(actor)
    reason = _need_reason(reason, "改派原因")
    reviewer = reviewer or None
    if owner not in people or (reviewer and reviewer not in people):
        raise ServiceError("負責人或覆核人不在人員名單中。")
    if reviewer == owner:
        raise ServiceError("負責人與覆核人不可為同一人（職能分離）。")
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        if t["status"] == "完成":
            raise ServiceError("已完成的任務不能改派，請先重新開啟。")
        if t["status"] == "待覆核" and not reviewer:
            raise ServiceError("待覆核中的任務必須指定覆核人。")
        if owner == t["owner"] and reviewer == t["reviewer"]:
            raise ServiceError("負責人與覆核人都沒有變更。")
        _update(conn, t, expected_version, actor, now, owner=owner, reviewer=reviewer)
        _log(conn, t, actor, "改派", now, note=reason,
             detail={"原負責人": t["owner"], "新負責人": owner,
                     "原覆核人": t["reviewer"], "新覆核人": reviewer})


def reopen(conn, task_id: int, expected_version: int, actor: Person,
           reason: str, now: datetime | None = None) -> None:
    """完成 → 進行中（例如發現錯誤要補正）。"""
    now = now or clock.now()
    _as_manager(actor)
    reason = _need_reason(reason, "重新開啟原因")
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        if t["status"] != "完成":
            raise ServiceError("只有已完成的任務可以重新開啟。")
        _update(conn, t, expected_version, actor, now, status="進行中", completed_at=None)
        _log(conn, t, actor, "重新開啟", now, to_status="進行中", note=reason,
             detail={"原完成時間": t["completed_at"]})


def cancel(conn, task_id: int, expected_version: int, actor: Person,
           reason: str, now: datetime | None = None) -> None:
    """本月不適用（例如本月沒有該項業務）。取消後視同不需處理，後續步驟不再等待它。"""
    now = now or clock.now()
    _as_manager(actor)
    reason = _need_reason(reason, "取消原因")
    with transaction(conn):
        t = _task(conn, task_id)
        _check_version(t, expected_version)
        _not_cancelled(t)
        if t["status"] == "完成":
            raise ServiceError("已完成的任務不能取消。")
        _update(conn, t, expected_version, actor, now, cancelled=1, cancel_reason=reason, blocked=0)
        _log(conn, t, actor, "取消本月任務", now, note=reason)


# ---------------------------------------------------------------- 佐證

_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def _evidence_open(conn, task_id: int, actor: Person) -> tuple[sqlite3.Row, bool]:
    t = _task(conn, task_id)
    _not_cancelled(t)
    proxy = _as_party(t, actor)
    if t["status"] == "完成":
        raise ServiceError("已完成的任務不能再變更佐證；如需補件，請主管先重新開啟。")
    return t, proxy


def add_evidence_file(conn, task_id: int, actor: Person, filename: str, data: bytes,
                      evidence_dir: Path, now: datetime | None = None) -> int:
    now = now or clock.now()
    safe = _UNSAFE.sub("_", Path(filename).name).strip() or "未命名檔案"
    digest = hashlib.sha256(data).hexdigest()
    with transaction(conn):
        t, proxy = _evidence_open(conn, task_id, actor)
        rel = Path(t["period"]) / f"{t['code']}_{task_id}" / f"{now:%Y%m%d-%H%M%S}_{digest[:8]}_{safe}"
        target = evidence_dir / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        try:
            cur = conn.execute(
                "INSERT INTO evidence (task_id, kind, filename, stored_path, sha256, size_bytes, "
                "added_by, added_at) VALUES (?, '檔案', ?, ?, ?, ?, ?, ?)",
                (task_id, safe, rel.as_posix(), digest, len(data), actor.name, clock.fmt(now)),
            )
            _log(conn, t, actor, "上傳佐證", now, note=safe, proxy=proxy,
                 detail={"SHA-256": digest, "大小": len(data)})
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return cur.lastrowid


def add_evidence_path(conn, task_id: int, actor: Person, location: str,
                      now: datetime | None = None) -> int:
    now = now or clock.now()
    location = _need_reason(location, "共用資料夾路徑")
    with transaction(conn):
        t, proxy = _evidence_open(conn, task_id, actor)
        cur = conn.execute(
            "INSERT INTO evidence (task_id, kind, location, added_by, added_at) "
            "VALUES (?, '路徑', ?, ?, ?)",
            (task_id, location, actor.name, clock.fmt(now)),
        )
        _log(conn, t, actor, "登錄佐證路徑", now, note=location, proxy=proxy)
        return cur.lastrowid


def void_evidence(conn, evidence_id: int, actor: Person, reason: str,
                  now: datetime | None = None) -> None:
    """佐證不能刪除，只能作廢；檔案本身保留。"""
    now = now or clock.now()
    reason = _need_reason(reason, "作廢原因")
    with transaction(conn):
        ev = conn.execute("SELECT * FROM evidence WHERE id = ?", (evidence_id,)).fetchone()
        if ev is None:
            raise ServiceError("找不到這筆佐證。")
        if ev["voided"]:
            raise ServiceError("這筆佐證已經作廢。")
        t, proxy = _evidence_open(conn, ev["task_id"], actor)
        conn.execute(
            "UPDATE evidence SET voided = 1, void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?",
            (reason, actor.name, clock.fmt(now), evidence_id),
        )
        _log(conn, t, actor, "作廢佐證", now, note=reason, proxy=proxy,
             detail={"佐證": ev["filename"] or ev["location"]})
