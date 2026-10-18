"""覆核軌跡：只能新增的事件紀錄，並以雜湊鏈串接。

每筆事件的 hash = SHA-256(上一筆 hash + 本筆內容)。
資料庫 trigger 已禁止透過程式修改或刪除；若有人繞過系統直接改資料庫檔案，
verify_chain() 會找出第一個對不上的位置。
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime

from . import clock

GENESIS = "0" * 64
_FIELDS = ("ts", "period", "task_id", "task_code", "actor", "action",
           "from_status", "to_status", "note", "proxy", "detail")


def _digest(prev_hash: str, record: dict) -> str:
    payload = json.dumps([prev_hash] + [record[f] for f in _FIELDS],
                         ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def append_event(
    conn: sqlite3.Connection,
    *,
    actor: str,
    action: str,
    now: datetime | None = None,
    period: str | None = None,
    task_id: int | None = None,
    task_code: str | None = None,
    from_status: str | None = None,
    to_status: str | None = None,
    note: str = "",
    proxy: bool = False,
    detail: dict | None = None,
) -> str:
    """必須在 transaction() 內呼叫，才能確保雜湊鏈不會分岔。"""
    row = conn.execute("SELECT hash FROM events ORDER BY id DESC LIMIT 1").fetchone()
    prev_hash = row["hash"] if row else GENESIS
    record = {
        "ts": clock.fmt(now or clock.now()),
        "period": period,
        "task_id": task_id,
        "task_code": task_code,
        "actor": actor,
        "action": action,
        "from_status": from_status,
        "to_status": to_status,
        "note": note or "",
        "proxy": 1 if proxy else 0,
        "detail": json.dumps(detail or {}, ensure_ascii=False, sort_keys=True),
    }
    h = _digest(prev_hash, record)
    conn.execute(
        f"INSERT INTO events ({', '.join(_FIELDS)}, prev_hash, hash) "
        f"VALUES ({', '.join('?' * (len(_FIELDS) + 2))})",
        [record[f] for f in _FIELDS] + [prev_hash, h],
    )
    return h


@dataclass(frozen=True)
class ChainResult:
    ok: bool
    count: int
    last_hash: str
    broken_at: int | None = None  # 第一筆對不上的事件編號
    message: str = ""


def verify_chain(conn: sqlite3.Connection) -> ChainResult:
    prev = GENESIS
    count = 0
    for row in conn.execute("SELECT * FROM events ORDER BY id"):
        rec = dict(row)
        if rec["prev_hash"] != prev:
            return ChainResult(False, count, prev, rec["id"],
                               f"第 {rec['id']} 筆紀錄與前一筆無法銜接，前面可能有紀錄被刪除或修改。")
        if _digest(prev, rec) != rec["hash"]:
            return ChainResult(False, count, prev, rec["id"],
                               f"第 {rec['id']} 筆紀錄內容與雜湊值不符，可能遭到修改。")
        prev = rec["hash"]
        count += 1
    return ChainResult(True, count, prev, None, f"共 {count} 筆紀錄，雜湊鏈完整。")
