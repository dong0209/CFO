"""測試共用設定：每個測試都使用暫存資料夾與 config/ 下的假資料設定。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from closeapp.context import load_context  # noqa: E402
from closeapp.db import connect  # noqa: E402


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("CLOSEAPP_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("CLOSEAPP_CONFIG_DIR", raising=False)
    monkeypatch.delenv("CLOSEAPP_TODAY", raising=False)
    return load_context()


@pytest.fixture
def conn(ctx):
    c = connect(ctx.settings.db_path)
    yield c
    c.close()


@pytest.fixture
def people(ctx):
    return ctx.people


@pytest.fixture
def manager(people):
    return people["陳主管"]
