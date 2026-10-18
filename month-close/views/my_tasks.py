"""我的待辦：我負責、尚未完成的任務，以及等我覆核的任務。"""
import streamlit as st

from closeapp import ui
from closeapp.queries import my_todo, tasks_for_period

user = ui.current_user()
period = st.session_state.get("period")

st.title("📥 我的待辦")
if not period:
    st.info("尚未產生任何月份的任務。" + ("請到「月份與系統管理」產生。" if user.is_manager else "請主管先產生。"))
    st.stop()

with ui.db() as conn:
    tasks = tasks_for_period(conn, period)
mine, reviews = my_todo(tasks, user.name)
waiting_review = [t for t in tasks if t.owner == user.name and t.status == "待覆核"]

a, b, c, d = st.columns(4)
a.metric("我負責未完成", len(mine))
b.metric("等我覆核", len(reviews))
c.metric("其中逾期", sum(t.is_overdue for t in mine + reviews))
d.metric("已送出、待他人覆核", len(waiting_review))


def section(title: str, items) -> None:
    st.subheader(title)
    if not items:
        st.caption("沒有項目。")
    for t in sorted(items, key=lambda t: (not t.is_overdue, t.due_date, t.seq)):
        flags = (("　⚠️逾期" if t.is_overdue else "") + ("　🛑卡關" if t.blocked else "")
                 + ("　⏳前置未完成" if t.waiting_on and t.status != "未開始" else ""))
        header = f"{ui.status_label(t)}｜{t.code} {t.name}｜{t.due_date:%m/%d}{flags}"
        with st.expander(header, expanded=len(items) <= 3):
            ui.task_panel(t, user)


section(f"等我覆核（{len(reviews)}）", reviews)
section(f"我負責的步驟（{len(mine)}）", mine)
if waiting_review:
    st.subheader("已送出、等待覆核")
    st.dataframe(ui.tasks_frame(waiting_review), hide_index=True, width="stretch")
