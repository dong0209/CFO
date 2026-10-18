"""畫面冒煙測試：用 Streamlit 內建的 AppTest 模擬登入並開啟每一頁，確認沒有錯誤。"""
from datetime import datetime
from pathlib import Path

import pytest
from streamlit.testing.v1 import AppTest

from closeapp import auth, services as svc

APP = str(Path(__file__).resolve().parent.parent / "app.py")
NOW = datetime(2026, 10, 1, 9, 0)


@pytest.fixture
def ready(ctx, conn, manager, monkeypatch):
    monkeypatch.setenv("CLOSEAPP_TODAY", "2026-10-02")
    svc.generate_period(conn, "2026-09", ctx.template, ctx.people, ctx.calendar, manager,
                        ctx.template_hash, now=NOW)
    for p in ctx.people.values():
        auth.login(conn, p, p.initial_pin, ctx.settings, now=NOW)
        auth.change_pin(conn, p, p.initial_pin, "9999", now=NOW)
    return ctx


def _login(name: str, pin: str = "9999") -> AppTest:
    at = AppTest.from_file(APP, default_timeout=30).run()
    at.selectbox[0].select(name)
    at.text_input[0].input(pin)
    at.button[0].click().run()
    assert not at.exception
    return at


def test_first_login_forces_pin_change(ctx):
    at = _login("林應收", "2000")
    assert at.title[0].value == "變更 PIN"
    at.text_input[0].input("2000")
    at.text_input[1].input("2468")
    at.text_input[2].input("2468")
    at.button[0].click().run()
    assert not at.exception
    assert "我的待辦" in at.title[0].value


def test_wrong_pin(ready):
    at = _login("林應收", "1234")
    assert any("PIN 錯誤" in e.value for e in at.error)


@pytest.mark.parametrize("page", ["views/my_tasks.py", "views/period_tasks.py", "views/admin.py"])
def test_manager_pages_render(ready, page):
    at = _login("陳主管")
    at.switch_page(page).run()
    assert not at.exception, at.exception


def test_staff_start_task_from_todo(ready, conn):
    at = _login("林應收")
    start = next(b for b in at.button if b.label == "▶ 開始")
    start.click().run()
    assert not at.exception
    assert any("已開始" in s.value for s in at.success)
    started = conn.execute("SELECT COUNT(*) FROM tasks WHERE owner='林應收' AND status='進行中'").fetchone()[0]
    assert started == 1


def test_staff_cannot_open_admin(ready):
    """同仁的導覽清單中沒有管理頁，連網址都進不去。"""
    at = _login("林應收")
    with pytest.raises(ValueError, match="Could not find a navigation page"):
        at.switch_page("views/admin.py")
