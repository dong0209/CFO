"""目前時間（台北時區）。

示範模式可用環境變數 CLOSEAPP_TODAY=2026-10-06 把「今天」固定在某一天，
時、分、秒仍取實際時間，方便用假資料展示逾期等狀況。
"""
from __future__ import annotations

import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Asia/Taipei")


def set_timezone(name: str) -> None:
    global TZ
    TZ = ZoneInfo(name)


def now() -> datetime:
    current = datetime.now(TZ).replace(microsecond=0, tzinfo=None)
    fixed = os.environ.get("CLOSEAPP_TODAY")
    if fixed:
        d = date.fromisoformat(fixed)
        current = current.replace(year=d.year, month=d.month, day=d.day)
    return current


def today() -> date:
    return now().date()


def fmt(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M:%S")
