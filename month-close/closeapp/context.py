"""一次載入所有設定，供畫面與指令列工具共用。"""
from __future__ import annotations

from dataclasses import dataclass

from . import clock
from .config import (HolidayFile, Person, Settings, TemplateStep, file_hash, load_holidays,
                     load_people, load_settings, load_template)
from .db import init_db
from .workdays import WorkCalendar


@dataclass(frozen=True)
class AppContext:
    settings: Settings
    people: dict[str, Person]
    template: list[TemplateStep]
    template_hash: str
    holidays: HolidayFile
    calendar: WorkCalendar


def load_context(settings: Settings | None = None) -> AppContext:
    settings = settings or load_settings()
    clock.set_timezone(settings.timezone)
    init_db(settings.db_path)
    holidays = load_holidays(settings.holidays_path)
    return AppContext(
        settings=settings,
        people=load_people(settings.people_path),
        template=load_template(settings.template_path),
        template_hash=file_hash(settings.template_path),
        holidays=holidays,
        calendar=WorkCalendar(holidays),
    )
