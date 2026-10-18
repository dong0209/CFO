from datetime import date

from closeapp.config import HolidayFile, TemplateStep
from closeapp.workdays import WorkCalendar, due_date, missing_holiday_years, month_end


def _step(rule, months="全部"):
    return TemplateStep("X", 1, "x", "a", None, rule, months, (), False, False, "")


def test_t_plus_n_skips_weekend_and_holidays(ctx):
    cal = ctx.calendar
    # 2026-09-30 週三；10/1 四、10/2 五、10/5 一 … 10/9 國慶補假
    assert due_date(_step("T+1"), "2026-09", cal) == date(2026, 10, 1)
    assert due_date(_step("T+2"), "2026-09", cal) == date(2026, 10, 2)
    assert due_date(_step("T+3"), "2026-09", cal) == date(2026, 10, 5)
    assert due_date(_step("T+6"), "2026-09", cal) == date(2026, 10, 8)
    assert due_date(_step("T+7"), "2026-09", cal) == date(2026, 10, 12)


def test_spring_festival(ctx):
    # 2026-01-31 週六；2/16–2/20 春節
    cal = ctx.calendar
    assert due_date(_step("T+1"), "2026-01", cal) == date(2026, 2, 2)
    # 2026-02-28 週六、2/27 補假；3/2 週一為 T+1
    assert due_date(_step("T+1"), "2026-02", cal) == date(2026, 3, 2)


def test_makeup_workday_counts():
    cal = WorkCalendar(HolidayFile({}, {date(2025, 2, 8): "補班"}))
    # 2025-02-07 週五 → 下一個工作日是 2/8（週六補班）
    assert cal.add_workdays(date(2025, 2, 7), 1) == date(2025, 2, 8)
    assert cal.is_workday(date(2025, 2, 8))
    assert not cal.is_workday(date(2025, 2, 9))


def test_fixed_date_postponed_on_holiday(ctx):
    cal = ctx.calendar
    # 2026-10 月結 → 次月 10 日 = 2026-11-10（週二）
    assert due_date(_step("次月10日"), "2026-10", cal) == date(2026, 11, 10)
    # 2026-09 月結 → 2026-10-10 週六，順延至 10/12 週一
    assert due_date(_step("次月10日"), "2026-09", cal) == date(2026, 10, 12)
    # 2026-07 月結 → 2026-08-15 週六，順延至 8/17
    assert due_date(_step("次月15日"), "2026-07", cal) == date(2026, 8, 17)


def test_month_filter():
    assert _step("T+1", "雙月").applies_to(2)
    assert not _step("T+1", "雙月").applies_to(3)
    assert _step("T+1", "3,6,9,12").applies_to(9)


def test_workdays_between(ctx):
    cal = ctx.calendar
    assert cal.workdays_between(month_end("2026-09"), date(2026, 10, 8)) == 6
    assert cal.workdays_between(date(2026, 10, 8), date(2026, 10, 8)) == 0


def test_missing_holiday_years(ctx):
    assert missing_holiday_years("2026-09", ctx.calendar) == []
    assert missing_holiday_years("2026-12", ctx.calendar) == [2027]
