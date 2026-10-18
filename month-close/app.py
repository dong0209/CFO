"""月結進度追蹤系統：主程式（登入與頁面導覽）。

啟動：streamlit run app.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import streamlit as st

sys.path.insert(0, str(Path(__file__).resolve().parent))

from closeapp import auth, clock, ui  # noqa: E402

st.set_page_config(page_title="月結進度追蹤", page_icon="📋", layout="wide")
ui.reset_run_cache()
ctx = ui.ctx()


def login_page() -> None:
    st.title("📋 月結進度追蹤系統")
    with st.form("login"):
        name = st.selectbox("姓名", list(ctx.people), index=None, placeholder="請選擇")
        pin = st.text_input("PIN（4 位數字）", type="password", max_chars=4)
        submitted = st.form_submit_button("登入", type="primary")
    if submitted:
        if not name:
            st.error("請選擇姓名。")
            return
        with ui.db() as conn:
            result = auth.login(conn, ctx.people[name], pin, ctx.settings)
        if result.ok:
            st.session_state["user"] = name
            st.session_state["must_change"] = result.must_change
            st.rerun()
        st.error(result.message)


def change_pin_page(forced: bool = False) -> None:
    user = ui.current_user()
    st.title("變更 PIN")
    if forced:
        st.info("第一次登入或 PIN 已被重設，請先設定您自己的 4 位數 PIN。")
    with st.form("change_pin", clear_on_submit=True):
        old = st.text_input("目前的 PIN", type="password", max_chars=4)
        new = st.text_input("新 PIN", type="password", max_chars=4)
        again = st.text_input("再輸入一次新 PIN", type="password", max_chars=4)
        submitted = st.form_submit_button("變更", type="primary")
    if submitted:
        if new != again:
            st.error("兩次輸入的新 PIN 不一致。")
            return
        try:
            with ui.db() as conn:
                auth.change_pin(conn, user, old, new)
        except ValueError as e:
            st.error(str(e))
            return
        st.session_state["must_change"] = False
        ui.flash("success", "PIN 已變更。")
        st.rerun()


def logout() -> None:
    for key in list(st.session_state):
        del st.session_state[key]


user = ui.current_user()
if user is None:
    st.session_state.pop("user", None)
    login_page()
    st.stop()

if st.session_state.get("must_change"):
    change_pin_page(forced=True)
    st.stop()

with st.sidebar:
    st.markdown(f"### 👤 {user.name}")
    st.caption(f"{user.role}・{user.duty}")
    st.button("登出", on_click=logout)
    st.divider()
ui.period_selector()
with st.sidebar:
    st.button("🔄 重新整理", help="看別人剛做的更新")
    st.caption(f"資料時間 {clock.now():%m/%d %H:%M:%S}")

pages = [
    st.Page("views/my_tasks.py", title="我的待辦", icon="📥", default=True),
    st.Page("views/period_tasks.py", title="當月任務", icon="🗂️"),
]
if user.is_manager:
    pages.append(st.Page("views/admin.py", title="月份與系統管理", icon="⚙️"))
pages.append(st.Page(lambda: change_pin_page(), title="變更 PIN", icon="🔑", url_path="pin"))

nav = st.navigation(pages)
ui.show_flash()
nav.run()
