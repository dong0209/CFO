"""瀏覽器端對端測試：兩個分頁、不同人員同時操作，確認資料不會互相覆蓋。

需要額外安裝（僅開發用）：pip install playwright 及 Chromium 瀏覽器。
執行：python tests/e2e_two_tabs.py
（未安裝 playwright 時，pytest 會自動略過這個檔案，因為檔名不是 test_ 開頭。）
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from playwright.sync_api import Page, expect, sync_playwright  # noqa: E402


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _chromium() -> str | None:
    """雲端開發環境的 Chromium 位置；本機有安裝 playwright 瀏覽器時回傳 None 用預設值。"""
    import glob
    found = glob.glob("/opt/pw-browsers/chromium-*/chrome-linux*/chrome")
    return os.environ.get("CHROMIUM_PATH") or (found[0] if found else None)


def _prepare(data_dir: Path) -> None:
    """建立乾淨資料庫、產生 2026-09 任務，並預先設好 PIN（略過首次變更）。"""
    os.environ["CLOSEAPP_DATA_DIR"] = str(data_dir)
    from closeapp import auth, services as svc
    from closeapp.context import load_context
    from closeapp.db import open_db
    ctx = load_context()
    with open_db(ctx.settings.db_path) as conn:
        svc.generate_period(conn, "2026-09", ctx.template, ctx.people, ctx.calendar,
                            ctx.people["陳主管"], ctx.template_hash, now=datetime(2026, 10, 1, 8, 30))
        for p in ctx.people.values():
            auth.login(conn, p, p.initial_pin, ctx.settings)
            auth.change_pin(conn, p, p.initial_pin, "9999")


def _login(page: Page, url: str, name: str) -> None:
    page.goto(url)
    page.locator('[data-testid="stSelectbox"]').first.click()
    page.get_by_role("option", name=name).click()
    page.get_by_label("PIN（4 位數字）").fill("9999")
    page.get_by_role("button", name="登入").click()
    expect(page.get_by_role("heading", name="我的待辦")).to_be_visible(timeout=15000)


def _open_task(page: Page, code_and_name: str) -> None:
    page.get_by_role("link", name="當月任務").click()
    expect(page.get_by_text("選擇步驟查看明細與操作")).to_be_visible(timeout=15000)
    heading = page.get_by_role("heading", name=code_and_name.split("（")[0])
    box = page.locator('[data-testid="stSelectbox"]').filter(has_text="選擇步驟查看明細與操作")
    for _ in range(3):  # 頁面重新繪製中時選取可能沒生效，重試
        box.click()
        page.keyboard.type(code_and_name.split(" ")[0], delay=50)
        page.wait_for_timeout(500)
        page.keyboard.press("Enter")
        try:
            expect(heading).to_be_visible(timeout=5000)
            return
        except AssertionError:
            page.keyboard.press("Escape")
    expect(heading).to_be_visible(timeout=5000)


def main() -> int:
    data_dir = Path(tempfile.mkdtemp(prefix="closeapp-e2e-"))
    _prepare(data_dir)
    port = _free_port()
    env = dict(os.environ, CLOSEAPP_DATA_DIR=str(data_dir), CLOSEAPP_TODAY="2026-10-02")
    server = subprocess.Popen(
        [sys.executable, "-m", "streamlit", "run", "app.py", "--server.port", str(port)],
        cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    url = f"http://127.0.0.1:{port}/"
    try:
        for _ in range(60):
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                break
            except OSError:
                time.sleep(0.5)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=_chromium())
            a = browser.new_context().new_page()   # 分頁 A：林應收（AR）
            b = browser.new_context().new_page()   # 分頁 B：陳主管
            _login(a, url, "林應收")
            _login(b, url, "陳主管")

            # 1) 兩人同時看著同一個任務（S02，版本相同）
            _open_task(a, "S02 電商平台營收與撥款對帳（未開始）")
            _open_task(b, "S02 電商平台營收與撥款對帳（未開始）")

            # 2) A 先標記卡關
            a.get_by_role("button", name="🛑 標記卡關").click()
            a.get_by_label("卡關原因（必填）").fill("平台撥款明細未提供")
            a.get_by_role("button", name="確認").click()
            expect(a.get_by_text("已標記卡關。")).to_be_visible(timeout=15000)

            # 3) B 的畫面還沒重新整理，按「開始」→ 必須被拒絕，不可覆蓋 A 的卡關
            b.get_by_role("button", name="▶ 開始").click()
            expect(b.get_by_text("已被 林應收")).to_be_visible(timeout=15000)
            print("✔ 過期畫面的操作被拒絕，並提示是誰先更新")

            # 4) B 的畫面已自動更新為最新資料，看得到卡關，再按一次「開始」就成功
            expect(b.get_by_text("卡關中：平台撥款明細未提供")).to_be_visible(timeout=15000)
            b.get_by_role("button", name="▶ 開始").click()
            expect(b.get_by_text("已開始。")).to_be_visible(timeout=15000)

            # 5) 兩人同時操作不同任務：都要成功
            _open_task(a, "S01 門市 POS 營收與帳上核對（未開始）")
            _open_task(b, "S03 現金與零用金盤點（未開始）")
            a.get_by_role("button", name="▶ 開始").click()
            b.get_by_role("button", name="▶ 開始").click()
            expect(a.get_by_text("已開始。")).to_be_visible(timeout=15000)
            expect(b.get_by_text("已開始。")).to_be_visible(timeout=15000)
            print("✔ 兩人同時操作不同任務都成功")
            browser.close()

        from closeapp import audit
        from closeapp.db import open_db
        with open_db(data_dir / "close.db") as conn:
            rows = {r["code"]: r for r in conn.execute("SELECT * FROM tasks WHERE code IN ('S01','S02','S03')")}
            assert rows["S02"]["blocked"] == 1 and rows["S02"]["status"] == "進行中", dict(rows["S02"])
            assert rows["S01"]["status"] == "進行中" and rows["S03"]["status"] == "進行中"
            proxy = conn.execute("SELECT proxy FROM events WHERE task_code='S02' AND action='開始'").fetchone()
            assert proxy["proxy"] == 1
            chain = audit.verify_chain(conn)
            assert chain.ok, chain.message
        print("✔ 資料庫最終狀態正確（卡關保留、主管代理有標示），" + chain.message)
        return 0
    finally:
        server.terminate()
        server.wait(timeout=10)


if __name__ == "__main__":
    sys.exit(main())
