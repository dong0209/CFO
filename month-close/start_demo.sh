#!/bin/bash
# 以假資料啟動示範（資料在 data/demo，不會動到正式資料）
# 「今天」固定為 2026-10-06（9 月月結 T+4），方便看到逾期、卡關等情況。
cd "$(dirname "$0")" || exit 1
[ -f .venv/bin/activate ] && source .venv/bin/activate
if [ ! -f data/demo/close.db ] || [ "$1" = "--rebuild" ]; then
  python3 -m closeapp.demo || exit 1
fi
export CLOSEAPP_DATA_DIR="$PWD/data/demo"
export CLOSEAPP_TODAY="2026-10-06"
URL="http://localhost:8501"
echo "示範模式啟動中…請用瀏覽器開啟 $URL"
( sleep 3; command -v open >/dev/null && open "$URL" ) &
exec python3 -m streamlit run app.py
