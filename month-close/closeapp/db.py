"""SQLite 資料庫：資料表定義、連線與交易。

多人同時使用的做法：
- WAL 模式：讀取不會被寫入擋住。
- 每次寫入都用 BEGIN IMMEDIATE 取得寫入鎖，交易很短，其他人最多等幾毫秒。
- 任務有 version 欄位，寫入時比對畫面上看到的版本（見 services.py），
  別人先改過就拒絕，不會默默覆蓋。
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS periods (
    period        TEXT PRIMARY KEY,          -- 2026-09
    month_end     TEXT NOT NULL,
    generated_at  TEXT NOT NULL,
    generated_by  TEXT NOT NULL,
    template_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
    id             INTEGER PRIMARY KEY,
    period         TEXT NOT NULL REFERENCES periods(period),
    code           TEXT NOT NULL,
    seq            INTEGER NOT NULL,
    name           TEXT NOT NULL,
    owner          TEXT NOT NULL,
    reviewer       TEXT,
    due_rule       TEXT NOT NULL,
    due_date       TEXT NOT NULL,
    predecessors   TEXT NOT NULL DEFAULT '[]',   -- JSON：前置步驟代碼
    needs_evidence INTEGER NOT NULL DEFAULT 0,
    is_milestone   INTEGER NOT NULL DEFAULT 0,
    note           TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT '未開始'
                   CHECK (status IN ('未開始', '進行中', '待覆核', '完成')),
    blocked        INTEGER NOT NULL DEFAULT 0,
    blocked_reason TEXT,
    blocked_at     TEXT,
    blocked_by     TEXT,
    started_at     TEXT,
    submitted_at   TEXT,
    completed_at   TEXT,
    return_count   INTEGER NOT NULL DEFAULT 0,
    cancelled      INTEGER NOT NULL DEFAULT 0,
    cancel_reason  TEXT,
    version        INTEGER NOT NULL DEFAULT 1,
    updated_at     TEXT NOT NULL,
    updated_by     TEXT NOT NULL,
    UNIQUE (period, code)
);

-- 覆核軌跡：只能新增，不能修改或刪除（由下方 trigger 強制）
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    period      TEXT,
    task_id     INTEGER,
    task_code   TEXT,
    actor       TEXT NOT NULL,
    action      TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    note        TEXT NOT NULL DEFAULT '',
    proxy       INTEGER NOT NULL DEFAULT 0,  -- 1 = 主管代理操作
    detail      TEXT NOT NULL DEFAULT '{}',  -- JSON：其他補充資訊
    prev_hash   TEXT NOT NULL,
    hash        TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, '覆核軌跡不可修改'); END;

CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, '覆核軌跡不可刪除'); END;

CREATE TABLE IF NOT EXISTS evidence (
    id          INTEGER PRIMARY KEY,
    task_id     INTEGER NOT NULL REFERENCES tasks(id),
    kind        TEXT NOT NULL CHECK (kind IN ('檔案', '路徑')),
    filename    TEXT,
    stored_path TEXT,       -- 相對於佐證資料夾
    sha256      TEXT,
    size_bytes  INTEGER,
    location    TEXT,       -- 共用資料夾路徑
    added_by    TEXT NOT NULL,
    added_at    TEXT NOT NULL,
    voided      INTEGER NOT NULL DEFAULT 0,
    void_reason TEXT,
    voided_by   TEXT,
    voided_at   TEXT
);

CREATE TABLE IF NOT EXISTS auth (
    name         TEXT PRIMARY KEY,
    pin_salt     TEXT NOT NULL,
    pin_hash     TEXT NOT NULL,
    must_change  INTEGER NOT NULL DEFAULT 1,
    failed       INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_period ON tasks(period);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
CREATE INDEX IF NOT EXISTS idx_events_period ON events(period);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id);
"""


def connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=15, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    return conn


def init_db(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
    finally:
        conn.close()


@contextmanager
def open_db(path: Path) -> Iterator[sqlite3.Connection]:
    conn = connect(path)
    try:
        yield conn
    finally:
        conn.close()


@contextmanager
def transaction(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")
