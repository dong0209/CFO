"""月份與系統管理（僅主管）：產生當月任務、人員 PIN、覆核軌跡驗證。"""
from datetime import date

import pandas as pd
import streamlit as st

from closeapp import audit, auth, clock, services as svc, ui
from closeapp.config import validate_template
from closeapp.queries import list_periods, system_events
from closeapp.workdays import due_date, missing_holiday_years, next_period, prev_period

user = ui.current_user()
ctx = ui.ctx()
if not user.is_manager:
    st.error("只有主管可以使用此頁。")
    st.stop()

st.title("⚙️ 月份與系統管理")
tab_gen, tab_tpl, tab_people, tab_audit = st.tabs(["產生月份", "目前範本", "人員與 PIN", "軌跡驗證"])

# ---------------------------------------------------------------- 產生月份
with tab_gen:
    with ui.db() as conn:
        existing = list_periods(conn)
    today = clock.today()
    last_month = prev_period(f"{today.year}-{today.month:02d}")
    candidates = sorted({last_month, next_period(last_month)} |
                        ({next_period(existing[0])} if existing else set()))
    candidates = [p for p in candidates if p not in existing]
    period = st.selectbox("要產生的月份", candidates, index=0 if candidates else None,
                          help="一般在月底後第 1 個工作日產生上個月的月結任務。")
    errors = validate_template(ctx.template, ctx.people)
    if errors:
        st.error("範本有誤，請先修正 config/template.csv：\n\n" + "\n".join(f"- {e}" for e in errors))
    elif period:
        if missing := missing_holiday_years(period, ctx.calendar):
            st.warning(f"假日檔沒有 {'、'.join(map(str, missing))} 年的資料，截止日可能不正確。"
                       "請先依人事行政總處公告更新 config/holidays.csv。")
        month = int(period[5:])
        steps = [s for s in ctx.template if s.applies_to(month)]
        preview = pd.DataFrame([{
            "代碼": s.code, "步驟": s.name, "負責人": s.owner, "覆核人": s.reviewer or "—",
            "截止規則": s.due_rule, "預計完成": ui.date_label(due_date(s, period, ctx.calendar)),
            "需附佐證": "是" if s.needs_evidence else "",
        } for s in steps])
        st.caption(f"將依範本產生 {len(steps)} 項任務（範本中 {len(ctx.template) - len(steps)} 項不適用本月）：")
        st.dataframe(preview, hide_index=True, width="stretch")

        def _generate(p: str) -> None:
            try:
                with ui.db() as conn:
                    n = svc.generate_period(conn, p, ctx.template, ctx.people, ctx.calendar,
                                            user, ctx.template_hash)
                st.session_state["period"] = p
                ui.flash("success", f"已產生 {p} 月結任務 {n} 項。")
            except svc.ServiceError as e:
                ui.flash("error", str(e))

        st.button(f"產生 {period} 月結任務", type="primary", on_click=_generate, args=(period,))
    if existing:
        st.caption("已產生的月份：" + "、".join(existing))

# ---------------------------------------------------------------- 範本
with tab_tpl:
    st.caption("範本來源：config/template.csv（可用 Excel 編輯，存成 CSV UTF-8）。"
               "修改範本不會影響已產生的月份。線上編輯功能將於第 3 階段提供。")
    st.dataframe(pd.DataFrame([{
        "代碼": s.code, "順序": s.seq, "步驟名稱": s.name, "負責人": s.owner, "覆核人": s.reviewer or "",
        "截止規則": s.due_rule, "適用月份": s.months, "前置步驟": "、".join(s.predecessors),
        "需附佐證": "是" if s.needs_evidence else "否", "關帳里程碑": "是" if s.is_milestone else "",
        "說明": s.note,
    } for s in ctx.template]), hide_index=True, width="stretch")

# ---------------------------------------------------------------- 人員
with tab_people:
    with ui.db() as conn:
        rows = {r["name"]: r for r in conn.execute("SELECT * FROM auth")}
    now_s = clock.fmt(clock.now())

    def _state(name: str) -> str:
        r = rows.get(name)
        if r is None:
            return "尚未登入過"
        if r["locked_until"] and r["locked_until"] > now_s:
            return f"鎖定至 {r['locked_until'][11:16]}"
        return "待變更 PIN" if r["must_change"] else "正常"

    st.dataframe(pd.DataFrame([{"姓名": p.name, "角色": p.role, "分工": p.duty, "PIN 狀態": _state(p.name)}
                               for p in ctx.people.values()]), hide_index=True, width="stretch")
    st.caption("人員名單來源：config/people.yaml。")
    with st.form("reset_pin", clear_on_submit=True):
        st.markdown("**重設 PIN**（對方下次登入須自行變更）")
        target = st.selectbox("人員", [p for p in ctx.people if p != user.name])
        temp = st.text_input("臨時 PIN（4 位數字）", type="password", max_chars=4)
        if st.form_submit_button("重設"):
            try:
                with ui.db() as conn:
                    auth.reset_pin(conn, user, ctx.people[target], temp)
                st.success(f"已重設 {target} 的 PIN。")
            except (ValueError, PermissionError) as e:
                st.error(str(e))

# ---------------------------------------------------------------- 軌跡驗證
with tab_audit:
    st.caption("覆核軌跡每筆都與前一筆以雜湊值串接。若有人繞過系統直接修改資料庫檔案，驗證會失敗並指出位置。")
    if st.button("驗證覆核軌跡"):
        with ui.db() as conn:
            result = audit.verify_chain(conn)
        (st.success if result.ok else st.error)(result.message)
        st.caption(f"最後一筆雜湊值：{result.last_hash}")
    st.markdown("**系統事件**（登入鎖定、PIN 變更與重設）")
    with ui.db() as conn:
        st.dataframe(ui.events_frame(system_events(conn)), hide_index=True, width="stretch")
