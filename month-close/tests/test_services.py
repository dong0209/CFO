import sqlite3
from datetime import datetime

import pytest

from closeapp import audit, services as svc
from closeapp.queries import get_task, tasks_for_period
from closeapp.services import ConflictError, ServiceError

NOW = datetime(2026, 10, 1, 9, 0)


@pytest.fixture
def period(ctx, conn, manager):
    svc.generate_period(conn, "2026-09", ctx.template, ctx.people, ctx.calendar, manager,
                        ctx.template_hash, now=NOW)
    return "2026-09"


def _t(conn, code, period="2026-09"):
    return next(t for t in tasks_for_period(conn, period) if t.code == code)


def _do_path(conn, t, who):
    svc.add_evidence_path(conn, t.id, who, r"\\fileserver\財務\月結\x.xlsx", now=NOW)


def test_generate(conn, period, ctx, manager):
    tasks = tasks_for_period(conn, period)
    # 9 月是單月 → 營業稅申報（雙月）不產生
    assert len(tasks) == 18
    assert "S19" not in {t.code for t in tasks}
    assert _t(conn, "S01").display_status == "未開始"
    assert _t(conn, "S04").display_status == "等待中"
    with pytest.raises(ServiceError, match="已經產生過"):
        svc.generate_period(conn, period, ctx.template, ctx.people, ctx.calendar, manager,
                            ctx.template_hash, now=NOW)


def test_only_manager_generates(conn, ctx, people):
    with pytest.raises(ServiceError, match="主管"):
        svc.generate_period(conn, "2026-10", ctx.template, ctx.people, ctx.calendar,
                            people["林應收"], ctx.template_hash)


def test_full_flow_with_reject(conn, period, people):
    ar, gl = people["林應收"], people["李總帳"]
    t = _t(conn, "S01")
    svc.start(conn, t.id, t.version, ar, now=NOW)
    t = _t(conn, "S01")
    with pytest.raises(ServiceError, match="佐證"):
        svc.submit(conn, t.id, t.version, ar, now=NOW)
    _do_path(conn, t, ar)
    svc.submit(conn, t.id, t.version, ar, now=NOW)
    t = _t(conn, "S01")
    assert t.status == "待覆核"
    with pytest.raises(ServiceError, match="原因"):
        svc.reject(conn, t.id, t.version, gl, "  ", now=NOW)
    svc.reject(conn, t.id, t.version, gl, "門市 A 差異未說明", now=NOW)
    t = _t(conn, "S01")
    assert t.status == "進行中" and t.return_count == 1
    svc.submit(conn, t.id, t.version, ar, now=NOW)
    t = _t(conn, "S01")
    svc.approve(conn, t.id, t.version, gl, now=NOW)
    assert _t(conn, "S01").status == "完成"
    actions = [e["action"] for e in conn.execute("SELECT action FROM events WHERE task_id=?", (t.id,))]
    assert actions == ["開始", "登錄佐證路徑", "送出覆核", "退回", "送出覆核", "核准"]


def test_predecessors_block_submit_but_not_start(conn, period, people):
    cashier = people["張出納"]
    t = _t(conn, "S04")  # 銀行調節表，前置 S02、S03
    svc.start(conn, t.id, t.version, cashier, now=NOW)
    t = _t(conn, "S04")
    _do_path(conn, t, cashier)
    with pytest.raises(ServiceError, match="前置步驟尚未完成"):
        svc.submit(conn, t.id, t.version, cashier, now=NOW)


def test_permissions_and_segregation(conn, period, people, manager):
    ar, ap = people["林應收"], people["王應付"]
    t = _t(conn, "S01")
    with pytest.raises(ServiceError, match="負責人"):
        svc.start(conn, t.id, t.version, ap, now=NOW)
    # 主管代理開始 → 軌跡標示代理
    svc.start(conn, t.id, t.version, manager, now=NOW)
    ev = conn.execute("SELECT proxy FROM events WHERE task_id=? AND action='開始'", (t.id,)).fetchone()
    assert ev["proxy"] == 1
    t = _t(conn, "S01")
    _do_path(conn, t, ar)
    svc.submit(conn, t.id, t.version, ar, now=NOW)
    t = _t(conn, "S01")
    with pytest.raises(ServiceError, match="職能分離"):
        svc.approve(conn, t.id, t.version, ar, now=NOW)
    with pytest.raises(ServiceError, match="覆核人"):
        svc.approve(conn, t.id, t.version, ap, now=NOW)


def test_no_reviewer_completes_directly(conn, period, people, manager):
    # 主管最終覆核（S17）沒有覆核人；先用「取消」把前置步驟 S16 排除
    s16 = _t(conn, "S16")
    svc.cancel(conn, s16.id, s16.version, manager, "測試", now=NOW)
    t = _t(conn, "S17")
    svc.start(conn, t.id, t.version, manager, now=NOW)
    t = _t(conn, "S17")
    assert svc.submit(conn, t.id, t.version, manager, now=NOW) == "完成"


def test_block_and_unblock(conn, period, people):
    ar, ap = people["林應收"], people["王應付"]
    t = _t(conn, "S02")
    with pytest.raises(ServiceError, match="原因"):
        svc.block(conn, t.id, t.version, ar, "", now=NOW)
    with pytest.raises(ServiceError):
        svc.block(conn, t.id, t.version, ap, "與我無關", now=NOW)
    svc.block(conn, t.id, t.version, ar, "平台撥款明細未提供", now=NOW)
    t = _t(conn, "S02")
    assert t.blocked and t.blocked_reason == "平台撥款明細未提供"
    svc.unblock(conn, t.id, t.version, ar, "已取得", now=NOW)
    assert not _t(conn, "S02").blocked


def test_stale_version_is_rejected(conn, ctx, period, people):
    """模擬兩個分頁：都看到版本 1，第一個寫入成功，第二個必須被拒絕。"""
    from closeapp.db import connect
    ar = people["林應收"]
    t = _t(conn, "S02")
    other = connect(ctx.settings.db_path)
    try:
        svc.block(conn, t.id, t.version, ar, "等平台資料", now=NOW)
        with pytest.raises(ConflictError, match="已被 林應收"):
            svc.start(other, t.id, t.version, ar, now=NOW)
    finally:
        other.close()
    t2 = get_task(conn, t.id)
    assert t2.status == "未開始" and t2.blocked and t2.version == t.version + 1


def test_evidence_file_and_void(conn, ctx, period, people, manager):
    ar = people["林應收"]
    t = _t(conn, "S01")
    eid = svc.add_evidence_file(conn, t.id, ar, "../../POS:核對.xlsx", b"fake", ctx.settings.evidence_dir, now=NOW)
    row = conn.execute("SELECT * FROM evidence WHERE id=?", (eid,)).fetchone()
    assert ".." not in row["stored_path"] and ":" not in row["filename"]
    assert (ctx.settings.evidence_dir / row["stored_path"]).read_bytes() == b"fake"
    svc.void_evidence(conn, eid, ar, "傳錯檔", now=NOW)
    assert _t(conn, "S01").evidence_count == 0


def test_reopen_and_reassign(conn, period, people, manager):
    ar, gl, ap = people["林應收"], people["李總帳"], people["王應付"]
    t = _t(conn, "S01")
    svc.start(conn, t.id, t.version, ar, now=NOW)
    _do_path(conn, t, ar)
    t = _t(conn, "S01")
    svc.submit(conn, t.id, t.version, ar, now=NOW)
    t = _t(conn, "S01")
    svc.approve(conn, t.id, t.version, gl, now=NOW)
    t = _t(conn, "S01")
    with pytest.raises(ServiceError, match="主管"):
        svc.reopen(conn, t.id, t.version, ar, "x", now=NOW)
    svc.reopen(conn, t.id, t.version, manager, "門市 B 營收調整", now=NOW)
    t = _t(conn, "S01")
    assert t.status == "進行中" and t.completed_at is None
    with pytest.raises(ServiceError, match="職能分離"):
        svc.reassign(conn, t.id, t.version, manager, people, "王應付", "王應付", "x", now=NOW)
    svc.reassign(conn, t.id, t.version, manager, people, ap.name, gl.name, "林應收請假", now=NOW)
    assert _t(conn, "S01").owner == ap.name


def test_events_are_immutable(conn, period):
    with pytest.raises(sqlite3.IntegrityError, match="不可修改"):
        conn.execute("UPDATE events SET note = 'x'")
    with pytest.raises(sqlite3.IntegrityError, match="不可刪除"):
        conn.execute("DELETE FROM events")


def test_hash_chain_detects_tampering(conn, period, people):
    ar = people["林應收"]
    t = _t(conn, "S01")
    svc.start(conn, t.id, t.version, ar, now=NOW)
    assert audit.verify_chain(conn).ok
    # 有人繞過系統：拿掉 trigger 後直接改資料庫
    conn.execute("DROP TRIGGER events_no_update")
    conn.execute("UPDATE events SET actor = '王應付' WHERE action = '開始'")
    result = audit.verify_chain(conn)
    assert not result.ok and "修改" in result.message
