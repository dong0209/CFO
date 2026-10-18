"""備份資料庫與佐證檔。系統執行中也可以安全備份（使用 SQLite 線上備份）。

用法：python -m closeapp.backup [備份目的資料夾]
預設備份到 data 資料夾旁的 backups/年月日-時分秒/。
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

from .config import load_settings


def backup(target_root: Path | None = None) -> Path:
    settings = load_settings()
    if not settings.db_path.exists():
        raise SystemExit(f"找不到資料庫：{settings.db_path}")
    root = target_root or settings.data_dir.parent / "backups"
    target = root / datetime.now().strftime("%Y%m%d-%H%M%S")
    target.mkdir(parents=True)
    src = sqlite3.connect(settings.db_path)
    dst = sqlite3.connect(target / "close.db")
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    if settings.evidence_dir.exists():
        shutil.copytree(settings.evidence_dir, target / "evidence")
    return target


if __name__ == "__main__":
    out = backup(Path(sys.argv[1]) if len(sys.argv) > 1 else None)
    print(f"備份完成：{out}")
