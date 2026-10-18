#!/bin/bash
# 啟動月結進度追蹤系統（正式資料：data/）
cd "$(dirname "$0")" || exit 1
[ -f .venv/bin/activate ] && source .venv/bin/activate
URL="http://localhost:8501"
echo "啟動中…完成後請用瀏覽器開啟 $URL（關閉此視窗即停止系統）"
( sleep 3; command -v open >/dev/null && open "$URL" ) &
exec python3 -m streamlit run app.py
