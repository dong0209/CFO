"""Streamlit 畫面共用元件：登入者、月份選擇、訊息提示、任務操作面板。

按鈕都使用 on_click 回呼並帶入「畫面產生當下的版本號」，
所以若別人在你看畫面的期間改了同一任務，你的操作會被拒絕並提示重新整理。
"""
from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path

import pandas as pd
import streamlit as st

from . import services as svc
from .config import ConfigError, Person
from .context import AppContext, load_context
from .db import open_db
from .queries import TaskView, list_periods, task_events, task_evidence

STATUS_ICON = {"未開始": "⚪", "等待中": "⏳", "進行中": "🔵", "待覆核": "🟡", "完成": "✅", "已取消": "➖"}


# ---------------------------------------------------------------- 基本

def ctx() -> AppContext:
    """每次重新整理都重讀設定檔，修改 config/ 後不必重新啟動。"""
    if "_ctx" not in st.session_state.get("_run_cache", {}):
        try:
            c = load_context()
        except ConfigError as e:
            st.error(f"設定檔有誤，請修正後重新整理：\n\n{e}")
            st.stop()
        st.session_state["_run_cache"] = {"_ctx": c}
    return st.session_state["_run_cache"]["_ctx"]


def reset_run_cache() -> None:
    st.session_state.pop("_run_cache", None)


@contextmanager
def db():
    with open_db(ctx().settings.db_path) as conn:
        yield conn


def current_user() -> Person | None:
    name = st.session_state.get("user")
    return ctx().people.get(name) if name else None


def flash(kind: str, message: str) -> None:
    st.session_state.setdefault("_flash", []).append((kind, message))


def show_flash() -> None:
    for kind, message in st.session_state.pop("_flash", []):
        (st.success if kind == "success" else st.error)(message)


def date_label(d) -> str:
    return f"{d:%Y-%m-%d}（週{'一二三四五六日'[d.weekday()]}）"


def status_label(t: TaskView) -> str:
    return f"{STATUS_ICON.get(t.display_status, '')} {t.display_status}"


# ---------------------------------------------------------------- 月份

def period_selector() -> str | None:
    with db() as conn:
        periods = list_periods(conn)
    if not periods:
        st.sidebar.info("尚未產生任何月份。")
        return None
    current = st.session_state.get("period")
    index = periods.index(current) if current in periods else 0
    st.session_state["period"] = st.sidebar.selectbox("月結月份", periods, index=index)
    return st.session_state["period"]


# ---------------------------------------------------------------- 操作回呼

def _call(label: str, fn, *args, **kwargs) -> None:
    user = current_user()
    if user is None:
        flash("error", "登入已逾時，請重新登入。")
        return
    try:
        with db() as conn:
            fn(conn, *args, actor=user, **kwargs)
        flash("success", f"已{label}。")
    except svc.ServiceError as e:
        flash("error", str(e))


def _cb(label: str, fn, task_id: int, version: int, text_key: str | None = None,
        text_param: str | None = None, **extra) -> None:
    kwargs = dict(extra)
    if text_key:
        kwargs[text_param] = st.session_state.get(text_key, "")
    _call(label, fn, task_id, version, **kwargs)


def _cb_reassign(task_id: int, version: int, prefix: str) -> None:
    s = st.session_state
    _call("改派", svc.reassign, task_id, version, people=ctx().people,
          owner=s[f"{prefix}_owner"], reviewer=s[f"{prefix}_reviewer"] or None,
          reason=s.get(f"{prefix}_reason", ""))


def _cb_upload(task_id: int, key: str) -> None:
    f = st.session_state.get(key)
    if f is None:
        flash("error", "請先選擇檔案。")
        return
    _call("上傳佐證", lambda conn, actor: svc.add_evidence_file(
        conn, task_id, actor, f.name, f.getvalue(), ctx().settings.evidence_dir))


def _cb_path(task_id: int, key: str) -> None:
    location = st.session_state.get(key, "")
    _call("登錄佐證路徑", lambda conn, actor: svc.add_evidence_path(conn, task_id, actor, location))


def _cb_void(evidence_id: int, key: str) -> None:
    reason = st.session_state.get(key, "")
    _call("作廢佐證", lambda conn, actor: svc.void_evidence(conn, evidence_id, actor, reason))


# ---------------------------------------------------------------- 任務面板

def task_panel(t: TaskView, user: Person) -> None:
    """單一任務的詳細資訊與可執行的操作。"""
    k = f"{t.id}_{t.version}"
    is_owner = user.name == t.owner
    is_reviewer = user.name == t.reviewer
    is_party = is_owner or is_reviewer or user.is_manager
    can_own = (is_owner or user.is_manager) and not t.cancelled
    can_review = (is_reviewer or user.is_manager) and not is_owner and not t.cancelled

    c1, c2, c3, c4 = st.columns(4)
    c1.markdown(f"**狀態**　{status_label(t)}")
    c2.markdown(f"**負責人**　{t.owner}")
    c3.markdown(f"**覆核人**　{t.reviewer or '（不需覆核）'}")
    due = f"{t.due_date:%m/%d}（{t.due_rule}）"
    c4.markdown(f"**預計完成**　{due}" + ("　⚠️ **逾期**" if t.is_overdue else ""))

    if t.cancelled:
        st.info(f"本月已取消：{t.cancel_reason}")
    if t.blocked:
        st.error(f"🛑 卡關中：{t.blocked_reason}（{t.blocked_by}，{t.blocked_at[5:16]}）")
    if t.waiting_on:
        st.warning("等待前置步驟：" + "、".join(t.waiting_on))
    if t.note:
        st.caption(f"說明：{t.note}")
    if t.return_count:
        st.caption(f"本月已被退回 {t.return_count} 次")

    # ---- 主要操作
    if not t.cancelled and t.status != "完成":
        cols = st.columns(4)
        if t.status == "未開始" and can_own:
            cols[0].button("▶ 開始", key=f"start_{k}", type="primary",
                           on_click=_cb, args=("開始", svc.start, t.id, t.version))
        if t.status == "進行中" and can_own:
            with cols[0].popover("📤 送出覆核" if t.reviewer else "✔ 標記完成"):
                with st.form(f"submit_form_{k}", clear_on_submit=True, border=False):
                    st.text_input("備註（選填）", key=f"submit_note_{k}")
                    st.form_submit_button("確認送出", type="primary", on_click=_cb,
                                          args=("送出", svc.submit, t.id, t.version, f"submit_note_{k}", "note"))
        if t.status == "待覆核" and can_review:
            with cols[0].popover("✅ 核准"):
                with st.form(f"approve_form_{k}", clear_on_submit=True, border=False):
                    st.text_input("覆核意見（選填）", key=f"approve_note_{k}")
                    st.form_submit_button("確認核准", type="primary", on_click=_cb,
                                          args=("核准", svc.approve, t.id, t.version, f"approve_note_{k}", "note"))
            with cols[1].popover("↩ 退回"):
                with st.form(f"reject_form_{k}", clear_on_submit=True, border=False):
                    st.text_area("退回原因（必填）", key=f"reject_reason_{k}")
                    st.form_submit_button("確認退回", on_click=_cb,
                                          args=("退回", svc.reject, t.id, t.version, f"reject_reason_{k}", "reason"))
        if is_party and not t.blocked:
            with cols[2].popover("🛑 標記卡關"):
                with st.form(f"block_form_{k}", clear_on_submit=True, border=False):
                    st.text_area("卡關原因（必填）", key=f"block_reason_{k}")
                    st.form_submit_button("確認", on_click=_cb,
                                          args=("標記卡關", svc.block, t.id, t.version, f"block_reason_{k}", "reason"))
        if is_party and t.blocked:
            with cols[2].popover("🟢 解除卡關"):
                with st.form(f"unblock_form_{k}", clear_on_submit=True, border=False):
                    st.text_input("處理說明（選填）", key=f"unblock_note_{k}")
                    st.form_submit_button("確認", on_click=_cb,
                                          args=("解除卡關", svc.unblock, t.id, t.version, f"unblock_note_{k}", "note"))

    # ---- 佐證
    _evidence_section(t, user, is_party)

    # ---- 主管功能
    if user.is_manager and not t.cancelled:
        with st.expander("主管功能：改派／重新開啟／取消"):
            people = list(ctx().people)
            if t.status != "完成":
                with st.form(f"reassign_form_{k}", border=False):
                    a, b = st.columns(2)
                    a.selectbox("負責人", people, index=people.index(t.owner) if t.owner in people else 0,
                                key=f"ra_{k}_owner")
                    options = [""] + people
                    b.selectbox("覆核人", options, index=options.index(t.reviewer or ""),
                                format_func=lambda x: x or "（不需覆核）", key=f"ra_{k}_reviewer")
                    st.text_input("改派原因（必填）", key=f"ra_{k}_reason")
                    st.form_submit_button("改派", on_click=_cb_reassign, args=(t.id, t.version, f"ra_{k}"))
                with st.form(f"cancel_form_{k}", clear_on_submit=True, border=False):
                    st.text_input("本月不適用的原因（必填）", key=f"cancel_reason_{k}")
                    st.form_submit_button("取消本月任務", on_click=_cb,
                                          args=("取消", svc.cancel, t.id, t.version, f"cancel_reason_{k}", "reason"))
            else:
                with st.form(f"reopen_form_{k}", clear_on_submit=True, border=False):
                    st.text_input("重新開啟原因（必填）", key=f"reopen_reason_{k}")
                    st.form_submit_button("重新開啟", on_click=_cb,
                                          args=("重新開啟", svc.reopen, t.id, t.version, f"reopen_reason_{k}", "reason"))

    # ---- 軌跡
    with st.expander("覆核軌跡"):
        with db() as conn:
            events = task_events(conn, t.id)
        st.dataframe(events_frame(events), hide_index=True, width="stretch")


def _evidence_section(t: TaskView, user: Person, is_party: bool) -> None:
    with db() as conn:
        items = task_evidence(conn, t.id)
    label = f"佐證（{t.evidence_count} 件有效）" + ("　※ 此步驟需附佐證" if t.needs_evidence else "")
    with st.expander(label, expanded=t.needs_evidence and t.evidence_count == 0 and t.status == "進行中"):
        root = ctx().settings.evidence_dir
        editable = is_party and t.status != "完成" and not t.cancelled
        for ev in items:
            cols = st.columns([6, 2])
            who = f"{ev['added_by']}・{ev['added_at'][5:16]}"
            if ev["kind"] == "檔案":
                path = root / ev["stored_path"]
                text = f"📎 {ev['filename']}　<small>{who}・SHA-256 {ev['sha256'][:12]}…</small>"
            else:
                path = None
                text = f"📁 `{ev['location']}`　<small>{who}</small>"
            if ev["voided"]:
                text = f"~~{text}~~　<small>已作廢：{ev['void_reason']}（{ev['voided_by']}）</small>"
            cols[0].markdown(text, unsafe_allow_html=True)
            if path is not None and path.exists() and not ev["voided"]:
                cols[1].download_button("下載", data=_read(path), file_name=ev["filename"],
                                        key=f"dl_{ev['id']}")
            if editable and not ev["voided"]:
                with cols[1].popover("作廢"):
                    with st.form(f"void_form_{ev['id']}", clear_on_submit=True, border=False):
                        st.text_input("作廢原因（必填）", key=f"void_reason_{ev['id']}")
                        st.form_submit_button("確認作廢", on_click=_cb_void,
                                              args=(ev["id"], f"void_reason_{ev['id']}"))
        if not items:
            st.caption("尚無佐證。")
        if editable:
            a, b = st.columns(2)
            with a.form(f"upload_form_{t.id}", clear_on_submit=True):
                st.file_uploader("上傳檔案", key=f"upload_{t.id}")
                st.form_submit_button("上傳", on_click=_cb_upload, args=(t.id, f"upload_{t.id}"))
            with b.form(f"path_form_{t.id}", clear_on_submit=True):
                st.text_input("或填共用資料夾路徑", key=f"path_{t.id}",
                              placeholder=r"\\fileserver\財務\月結\2026-09\銀行調節表.xlsx")
                st.form_submit_button("登錄路徑", on_click=_cb_path, args=(t.id, f"path_{t.id}"))


def _read(path: Path) -> bytes:
    return path.read_bytes()


def events_frame(events) -> pd.DataFrame:
    rows = []
    for e in events:
        change = f"{e['from_status']} → {e['to_status']}" if e["from_status"] != e["to_status"] else ""
        rows.append({
            "時間": e["ts"], "人員": e["actor"] + ("（主管代理）" if e["proxy"] else ""),
            "動作": e["action"], "狀態變化": change, "說明": e["note"],
        })
    return pd.DataFrame(rows, columns=["時間", "人員", "動作", "狀態變化", "說明"])


def tasks_frame(tasks: list[TaskView]) -> pd.DataFrame:
    return pd.DataFrame([{
        "代碼": t.code,
        "步驟": t.name,
        "負責人": t.owner,
        "覆核人": t.reviewer or "—",
        "預計完成": f"{t.due_date:%m/%d}（{t.due_rule}）",
        "狀態": status_label(t),
        "卡關": "🛑 " + (t.blocked_reason or "") if t.blocked else "",
        "逾期": "⚠️" if t.is_overdue else "",
        "佐證": t.evidence_count,
        "退回": t.return_count or "",
        "完成時間": (t.completed_at or "")[5:16],
    } for t in tasks])
