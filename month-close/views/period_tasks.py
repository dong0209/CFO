"""當月任務：全部步驟一覽，可篩選，點選後查看與操作。"""
import streamlit as st

from closeapp import ui
from closeapp.queries import tasks_for_period

user = ui.current_user()
period = st.session_state.get("period")

st.title(f"🗂️ 當月任務　{period or ''}")
if not period:
    st.info("尚未產生任何月份的任務。")
    st.stop()

with ui.db() as conn:
    tasks = tasks_for_period(conn, period)

f1, f2, f3 = st.columns([2, 3, 2])
owners = f1.multiselect("負責人", sorted({t.owner for t in tasks}), placeholder="全部")
statuses = f2.multiselect("狀態", list(ui.STATUS_ICON), placeholder="全部")
flags = f3.multiselect("標記", ["卡關", "逾期"], placeholder="不限")

shown = [t for t in tasks
         if (not owners or t.owner in owners)
         and (not statuses or t.display_status in statuses)
         and ("卡關" not in flags or t.blocked)
         and ("逾期" not in flags or t.is_overdue)]

st.dataframe(ui.tasks_frame(shown), hide_index=True, width="stretch")

if shown:
    by_id = {t.id: t for t in shown}
    picked = st.selectbox("選擇步驟查看明細與操作", list(by_id),
                          format_func=lambda i: f"{by_id[i].code} {by_id[i].name}（{by_id[i].display_status}）",
                          key="picked_task")
    t = by_id[picked]
    st.subheader(f"{t.code} {t.name}")
    ui.task_panel(t, user)
