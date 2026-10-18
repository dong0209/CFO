"""簡易登入：選姓名＋4 位數 PIN。

- PIN 只存雜湊值（PBKDF2-SHA256＋隨機鹽），不存明碼。
- 第一次登入用 people.yaml 的初始PIN，登入後強制變更。
- 連續輸錯達上限即鎖定一段時間。
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timedelta

from . import audit, clock
from .config import Person, Settings
from .db import transaction

_ITERATIONS = 200_000


def _hash(pin: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", pin.encode(), bytes.fromhex(salt), _ITERATIONS).hex()


def _new_secret(pin: str) -> tuple[str, str]:
    salt = secrets.token_hex(16)
    return salt, _hash(pin, salt)


@dataclass(frozen=True)
class LoginResult:
    ok: bool
    must_change: bool = False
    message: str = ""


def _ensure_row(conn: sqlite3.Connection, person: Person, now: datetime) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM auth WHERE name = ?", (person.name,)).fetchone()
    if row is None:
        salt, h = _new_secret(person.initial_pin)
        conn.execute(
            "INSERT INTO auth (name, pin_salt, pin_hash, must_change, updated_at) VALUES (?, ?, ?, 1, ?)",
            (person.name, salt, h, clock.fmt(now)),
        )
        row = conn.execute("SELECT * FROM auth WHERE name = ?", (person.name,)).fetchone()
    return row


def login(conn: sqlite3.Connection, person: Person, pin: str, settings: Settings,
          now: datetime | None = None) -> LoginResult:
    now = now or clock.now()
    with transaction(conn):
        row = _ensure_row(conn, person, now)
        if row["locked_until"] and row["locked_until"] > clock.fmt(now):
            return LoginResult(False, message=f"PIN 錯誤次數過多，已鎖定至 {row['locked_until'][11:16]}，或請主管重設。")
        if hmac.compare_digest(_hash(pin, row["pin_salt"]), row["pin_hash"]):
            conn.execute("UPDATE auth SET failed = 0, locked_until = NULL WHERE name = ?", (person.name,))
            return LoginResult(True, must_change=bool(row["must_change"]))
        failed = row["failed"] + 1
        if failed >= settings.pin_max_failures:
            until = clock.fmt(now + timedelta(minutes=settings.lock_minutes))
            conn.execute("UPDATE auth SET failed = 0, locked_until = ? WHERE name = ?", (until, person.name))
            audit.append_event(conn, actor=person.name, action="PIN 錯誤鎖定", now=now,
                               note=f"連續輸錯 {failed} 次，鎖定至 {until}")
            return LoginResult(False, message=f"PIN 錯誤次數過多，已鎖定 {settings.lock_minutes} 分鐘。")
        conn.execute("UPDATE auth SET failed = ? WHERE name = ?", (failed, person.name))
        left = settings.pin_max_failures - failed
        return LoginResult(False, message=f"PIN 錯誤，再錯 {left} 次將鎖定。")


def _check_new_pin(new_pin: str) -> None:
    if not re.fullmatch(r"\d{4}", new_pin or ""):
        raise ValueError("新 PIN 須為 4 位數字。")


def change_pin(conn: sqlite3.Connection, person: Person, old_pin: str, new_pin: str,
               now: datetime | None = None) -> None:
    now = now or clock.now()
    _check_new_pin(new_pin)
    if new_pin == person.initial_pin:
        raise ValueError("新 PIN 不可與初始 PIN 相同。")
    with transaction(conn):
        row = _ensure_row(conn, person, now)
        if not hmac.compare_digest(_hash(old_pin, row["pin_salt"]), row["pin_hash"]):
            raise ValueError("目前的 PIN 不正確。")
        if old_pin == new_pin:
            raise ValueError("新 PIN 不可與目前的 PIN 相同。")
        salt, h = _new_secret(new_pin)
        conn.execute(
            "UPDATE auth SET pin_salt = ?, pin_hash = ?, must_change = 0, failed = 0, "
            "locked_until = NULL, updated_at = ? WHERE name = ?",
            (salt, h, clock.fmt(now), person.name),
        )
        audit.append_event(conn, actor=person.name, action="變更 PIN", now=now)


def reset_pin(conn: sqlite3.Connection, manager: Person, target: Person, temp_pin: str,
              now: datetime | None = None) -> None:
    """主管設定一組臨時 PIN，對方下次登入時須再變更。"""
    now = now or clock.now()
    if not manager.is_manager:
        raise PermissionError("只有主管可以重設 PIN。")
    _check_new_pin(temp_pin)
    with transaction(conn):
        _ensure_row(conn, target, now)
        salt, h = _new_secret(temp_pin)
        conn.execute(
            "UPDATE auth SET pin_salt = ?, pin_hash = ?, must_change = 1, failed = 0, "
            "locked_until = NULL, updated_at = ? WHERE name = ?",
            (salt, h, clock.fmt(now), target.name),
        )
        audit.append_event(conn, actor=manager.name, action="重設 PIN", now=now,
                           note=f"重設 {target.name} 的 PIN")
