"""台灣工作日計算。

工作日 = 週一至週五且不是假日，或是假日檔中標記的「補班」日。
假日資料完全來自 config/holidays.csv，程式不內建任何日期。
"""
from __future__ import annotations

import calendar
from datetime import date, timedelta

from .config import HolidayFile, TemplateStep, parse_due_rule

ONE_DAY = timedelta(days=1)


class WorkCalendar:
    def __init__(self, holiday_file: HolidayFile):
        self.holidays = holiday_file.holidays
        self.makeup_days = holiday_file.makeup_days
        self.years = holiday_file.years

    def is_workday(self, d: date) -> bool:
        if d in self.makeup_days:
            return True
        if d in self.holidays:
            return False
        return d.weekday() < 5

    def add_workdays(self, start: date, n: int) -> date:
        """start 之後第 n 個工作日（n=0 回傳 start 本身）。"""
        d, count = start, 0
        while count < n:
            d += ONE_DAY
            if self.is_workday(d):
                count += 1
        return d

    def on_or_after(self, d: date) -> date:
        """遇假日順延至下一個工作日。"""
        while not self.is_workday(d):
            d += ONE_DAY
        return d

    def workdays_between(self, start: date, end: date) -> int:
        """(start, end] 之間的工作日數；end 早於 start 時回傳負數。"""
        if end == start:
            return 0
        sign = 1 if end > start else -1
        lo, hi = (start, end) if sign == 1 else (end, start)
        count, d = 0, lo
        while d < hi:
            d += ONE_DAY
            if self.is_workday(d):
                count += 1
        return sign * count


def parse_period(period: str) -> tuple[int, int]:
    year, month = period.split("-")
    return int(year), int(month)


def month_end(period: str) -> date:
    year, month = parse_period(period)
    return date(year, month, calendar.monthrange(year, month)[1])


def next_period(period: str) -> str:
    year, month = parse_period(period)
    return f"{year + 1}-01" if month == 12 else f"{year}-{month + 1:02d}"


def prev_period(period: str) -> str:
    year, month = parse_period(period)
    return f"{year - 1}-12" if month == 1 else f"{year}-{month - 1:02d}"


def due_date(step: TemplateStep, period: str, cal: WorkCalendar) -> date:
    kind, n = parse_due_rule(step.due_rule)
    end = month_end(period)
    if kind == "T":
        return cal.add_workdays(end, n)
    nxt = end + ONE_DAY
    last = calendar.monthrange(nxt.year, nxt.month)[1]
    return cal.on_or_after(date(nxt.year, nxt.month, min(n, last)))


def missing_holiday_years(period: str, cal: WorkCalendar) -> list[int]:
    """這個月份的截止日會用到的年度，若假日檔沒有資料就列出來提醒。"""
    end = month_end(period)
    needed = {end.year, (end + timedelta(days=45)).year}
    return sorted(needed - cal.years)
