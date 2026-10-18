from datetime import datetime, timedelta

import pytest

from closeapp import auth

NOW = datetime(2026, 10, 1, 9, 0)


def test_first_login_requires_change(conn, ctx, people):
    p = people["林應收"]
    r = auth.login(conn, p, "2000", ctx.settings, now=NOW)
    assert r.ok and r.must_change
    with pytest.raises(ValueError):
        auth.change_pin(conn, p, "2000", "2000", now=NOW)
    auth.change_pin(conn, p, "2000", "8642", now=NOW)
    assert not auth.login(conn, p, "2000", ctx.settings, now=NOW).ok
    r = auth.login(conn, p, "8642", ctx.settings, now=NOW)
    assert r.ok and not r.must_change
    row = conn.execute("SELECT pin_hash FROM auth WHERE name=?", (p.name,)).fetchone()
    assert "8642" not in row["pin_hash"]


def test_lockout_and_manager_reset(conn, ctx, people, manager):
    p = people["王應付"]
    for _ in range(ctx.settings.pin_max_failures):
        r = auth.login(conn, p, "0000", ctx.settings, now=NOW)
    assert "鎖定" in r.message
    assert not auth.login(conn, p, "3000", ctx.settings, now=NOW).ok  # 鎖定中，正確 PIN 也不行
    later = NOW + timedelta(minutes=ctx.settings.lock_minutes + 1)
    assert auth.login(conn, p, "3000", ctx.settings, now=later).ok
    with pytest.raises(PermissionError):
        auth.reset_pin(conn, p, manager, "1111")
    auth.reset_pin(conn, manager, p, "7777", now=NOW)
    r = auth.login(conn, p, "7777", ctx.settings, now=later)
    assert r.ok and r.must_change
