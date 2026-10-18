"""完整月份模擬：產生任務 → 推進狀態 → 退回 → 卡關 → 完成。"""
from datetime import date

from closeapp import audit
from closeapp.db import open_db
from closeapp.demo import MARKER, build_demo
from closeapp.queries import tasks_for_period
from closeapp.workdays import month_end


def test_demo_simulates_full_months(tmp_path, ctx):
    out = tmp_path / "demo"
    result = build_demo(out, months=3)
    assert (out / MARKER).exists()
    assert result["月份"] == ["2026-07", "2026-08", "2026-09"]
    with open_db(out / "close.db") as conn:
        assert audit.verify_chain(conn).ok

        # 已關帳的月份：全部完成，且有退回、卡關紀錄
        for p in ("2026-07", "2026-08"):
            tasks = tasks_for_period(conn, p)
            assert all(t.status == "完成" for t in tasks), p
            milestone = next(t for t in tasks if t.is_milestone)
            close_days = ctx.calendar.workdays_between(month_end(p), milestone.completed_date)
            assert 5 <= close_days <= 12
        actions = {r[0] for r in conn.execute("SELECT DISTINCT action FROM events")}
        assert {"產生月結任務", "開始", "送出覆核", "退回", "核准", "標記卡關", "解除卡關",
                "上傳佐證", "登錄佐證路徑", "完成（無需覆核）"} <= actions

        # 進行中的月份：有卡關、有被退回待重送、有等待中、有逾期
        current = tasks_for_period(conn, "2026-09", today=date(2026, 10, 6))
        assert any(t.blocked for t in current)
        assert any(t.return_count and t.status == "進行中" for t in current)
        assert any(t.display_status == "等待中" for t in current)
        assert any(t.is_overdue for t in current)
        assert not all(t.status == "完成" for t in current)


def test_demo_refuses_non_demo_folder(tmp_path):
    import pytest
    real = tmp_path / "real"
    real.mkdir()
    (real / "close.db").write_text("x")
    with pytest.raises(SystemExit, match="不是示範資料夾"):
        build_demo(real, months=1)
    assert (real / "close.db").exists()
