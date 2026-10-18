"""讀取 config/ 下的設定檔：系統參數、人員名單、月結範本、假日。

設定檔都是給財務人員直接編輯的，所以這裡的錯誤訊息一律寫成看得懂的中文，
並指出是哪個檔案、哪一列出錯。
"""
from __future__ import annotations

import csv
import hashlib
import io
import os
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent

ROLES = ("主管", "同仁")
TEMPLATE_COLUMNS = [
    "代碼", "順序", "步驟名稱", "負責人", "覆核人", "截止規則",
    "適用月份", "前置步驟", "需附佐證", "關帳里程碑", "說明",
]
HOLIDAY_COLUMNS = ["日期", "類型", "說明"]

_RULE_T = re.compile(r"^T\s*\+\s*(\d+)$", re.IGNORECASE)
_RULE_FIXED = re.compile(r"^次月\s*(\d+)\s*日$")


class ConfigError(Exception):
    """設定檔內容有誤。"""


# ---------------------------------------------------------------- 路徑與系統參數

@dataclass(frozen=True)
class Settings:
    config_dir: Path
    data_dir: Path
    timezone: str
    pin_max_failures: int
    lock_minutes: int
    refresh_seconds: int

    @property
    def db_path(self) -> Path:
        return self.data_dir / "close.db"

    @property
    def evidence_dir(self) -> Path:
        return self.data_dir / "evidence"

    @property
    def template_path(self) -> Path:
        return self.config_dir / "template.csv"

    @property
    def holidays_path(self) -> Path:
        return self.config_dir / "holidays.csv"

    @property
    def people_path(self) -> Path:
        return self.config_dir / "people.yaml"


def _resolve(p: str | Path) -> Path:
    p = Path(p).expanduser()
    return p if p.is_absolute() else ROOT / p


def load_settings() -> Settings:
    """環境變數 CLOSEAPP_CONFIG_DIR／CLOSEAPP_DATA_DIR 可覆蓋位置（示範模式與測試用）。"""
    config_dir = _resolve(os.environ.get("CLOSEAPP_CONFIG_DIR") or "config")
    raw = _load_yaml(config_dir / "settings.yaml") or {}
    data_dir = _resolve(os.environ.get("CLOSEAPP_DATA_DIR") or raw.get("資料夾") or "data")
    try:
        return Settings(
            config_dir=config_dir,
            data_dir=data_dir,
            timezone=str(raw.get("時區") or "Asia/Taipei"),
            pin_max_failures=int(raw.get("PIN錯誤上限", 5)),
            lock_minutes=int(raw.get("鎖定分鐘", 15)),
            refresh_seconds=int(raw.get("自動更新秒數", 30)),
        )
    except (TypeError, ValueError) as e:
        raise ConfigError(f"settings.yaml 的數字欄位格式錯誤：{e}") from e


def _load_yaml(path: Path):
    if not path.exists():
        raise ConfigError(f"找不到設定檔：{path}")
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as e:
        raise ConfigError(f"{path.name} 格式錯誤（請檢查縮排與冒號）：{e}") from e


def read_text_any(path: Path) -> str:
    """CSV 可能由 Excel 存成 UTF-8（含 BOM）或 Big5，兩種都接受。"""
    data = path.read_bytes()
    for enc in ("utf-8-sig", "cp950"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise ConfigError(f"{path.name} 無法辨識文字編碼，請用 Excel「另存為 CSV UTF-8」。")


def _read_csv(path: Path, columns: list[str]) -> list[dict[str, str]]:
    if not path.exists():
        raise ConfigError(f"找不到設定檔：{path}")
    reader = csv.DictReader(io.StringIO(read_text_any(path)))
    header = [h.strip() for h in (reader.fieldnames or [])]
    missing = [c for c in columns if c not in header]
    if missing:
        raise ConfigError(f"{path.name} 缺少欄位：{'、'.join(missing)}")
    rows = []
    for row in reader:
        clean = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        if any(clean.get(c) for c in columns):  # 略過空白列
            rows.append(clean)
    return rows


# ---------------------------------------------------------------- 人員

@dataclass(frozen=True)
class Person:
    name: str
    role: str
    duty: str
    initial_pin: str

    @property
    def is_manager(self) -> bool:
        return self.role == "主管"


def load_people(path: Path) -> dict[str, Person]:
    raw = _load_yaml(path) or {}
    items = raw.get("人員") if isinstance(raw, dict) else None
    if not items:
        raise ConfigError("people.yaml 裡沒有「人員:」清單。")
    people: dict[str, Person] = {}
    for i, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ConfigError(f"people.yaml 第 {i} 位人員格式錯誤。")
        name = str(item.get("姓名") or "").strip()
        role = str(item.get("角色") or "").strip()
        pin = item.get("初始PIN")
        if not name:
            raise ConfigError(f"people.yaml 第 {i} 位人員缺少姓名。")
        if name in people:
            raise ConfigError(f"people.yaml 姓名重複：{name}")
        if role not in ROLES:
            raise ConfigError(f"people.yaml「{name}」的角色須為 主管 或 同仁（目前：{role or '空白'}）。")
        if not isinstance(pin, str):
            raise ConfigError(f"people.yaml「{name}」的初始PIN 請加上引號，例如 \"0123\"。")
        if not re.fullmatch(r"\d{4}", pin):
            raise ConfigError(f"people.yaml「{name}」的初始PIN 須為 4 位數字。")
        people[name] = Person(name, role, str(item.get("分工") or "").strip(), pin)
    if not any(p.is_manager for p in people.values()):
        raise ConfigError("people.yaml 至少要有一位「主管」。")
    return people


# ---------------------------------------------------------------- 假日

@dataclass(frozen=True)
class HolidayFile:
    holidays: dict[date, str]   # 放假日
    makeup_days: dict[date, str]  # 補班日（週末要上班）

    @property
    def years(self) -> set[int]:
        return {d.year for d in self.holidays} | {d.year for d in self.makeup_days}


def parse_date(text: str) -> date:
    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text.strip())
    if not m:
        raise ValueError(text)
    return date(int(m[1]), int(m[2]), int(m[3]))


def load_holidays(path: Path) -> HolidayFile:
    holidays: dict[date, str] = {}
    makeup: dict[date, str] = {}
    for line, row in enumerate(_read_csv(path, HOLIDAY_COLUMNS), start=2):
        try:
            d = parse_date(row["日期"])
        except ValueError:
            raise ConfigError(f"holidays.csv 第 {line} 列日期格式錯誤：{row['日期']}（請用 2026-01-01）") from None
        kind = row["類型"]
        if kind == "假日":
            holidays[d] = row["說明"]
        elif kind == "補班":
            makeup[d] = row["說明"]
        else:
            raise ConfigError(f"holidays.csv 第 {line} 列類型須為 假日 或 補班（目前：{kind}）")
    return HolidayFile(holidays, makeup)


# ---------------------------------------------------------------- 月結範本

@dataclass(frozen=True)
class TemplateStep:
    code: str
    seq: int
    name: str
    owner: str
    reviewer: str | None
    due_rule: str
    months: str
    predecessors: tuple[str, ...]
    needs_evidence: bool
    is_milestone: bool
    note: str

    def applies_to(self, month: int) -> bool:
        return month in parse_months(self.months)


def parse_due_rule(rule: str) -> tuple[str, int]:
    """回傳 ("T", N) 或 ("次月", 日)。"""
    rule = rule.strip()
    if m := _RULE_T.match(rule):
        return "T", int(m[1])
    if m := _RULE_FIXED.match(rule):
        day = int(m[1])
        if 1 <= day <= 31:
            return "次月", day
    raise ValueError(rule)


def parse_months(text: str) -> set[int]:
    text = (text or "").strip()
    if text in ("", "全部"):
        return set(range(1, 13))
    if text == "單月":
        return {1, 3, 5, 7, 9, 11}
    if text == "雙月":
        return {2, 4, 6, 8, 10, 12}
    try:
        months = {int(x) for x in re.split(r"[;,、\s]+", text) if x}
    except ValueError:
        raise ValueError(text) from None
    if not months or not months <= set(range(1, 13)):
        raise ValueError(text)
    return months


def _yes(text: str) -> bool:
    return text.strip().upper() in ("是", "Y", "YES", "TRUE", "1", "V")


def load_template(path: Path) -> list[TemplateStep]:
    steps = []
    for line, row in enumerate(_read_csv(path, TEMPLATE_COLUMNS), start=2):
        try:
            seq = int(row["順序"] or 0)
        except ValueError:
            raise ConfigError(f"template.csv 第 {line} 列「順序」須為數字。") from None
        preds = tuple(p.strip() for p in re.split(r"[;,、\s]+", row["前置步驟"]) if p.strip())
        steps.append(TemplateStep(
            code=row["代碼"],
            seq=seq,
            name=row["步驟名稱"],
            owner=row["負責人"],
            reviewer=row["覆核人"] or None,
            due_rule=row["截止規則"],
            months=row["適用月份"] or "全部",
            predecessors=preds,
            needs_evidence=_yes(row["需附佐證"]),
            is_milestone=_yes(row["關帳里程碑"]),
            note=row["說明"],
        ))
    return sorted(steps, key=lambda s: (s.seq, s.code))


def validate_template(steps: list[TemplateStep], people: dict[str, Person]) -> list[str]:
    """回傳錯誤訊息清單；空清單代表範本可用。"""
    errors: list[str] = []
    codes = [s.code for s in steps]
    seen: set[str] = set()
    for s in steps:
        label = f"步驟 {s.code or '（無代碼）'}「{s.name}」"
        if not s.code:
            errors.append(f"{label}缺少代碼。")
        elif s.code in seen:
            errors.append(f"代碼重複：{s.code}")
        seen.add(s.code)
        if not s.name:
            errors.append(f"{label}缺少步驟名稱。")
        if s.owner not in people:
            errors.append(f"{label}的負責人「{s.owner}」不在人員名單中。")
        if s.reviewer and s.reviewer not in people:
            errors.append(f"{label}的覆核人「{s.reviewer}」不在人員名單中。")
        if s.reviewer and s.reviewer == s.owner:
            errors.append(f"{label}的負責人與覆核人不可為同一人（職能分離）。")
        try:
            parse_due_rule(s.due_rule)
        except ValueError:
            errors.append(f"{label}的截止規則「{s.due_rule}」無法辨識，請填 T+3 或 次月10日。")
        try:
            parse_months(s.months)
        except ValueError:
            errors.append(f"{label}的適用月份「{s.months}」無法辨識，請填 全部、單月、雙月 或 3,6,9,12。")
        for p in s.predecessors:
            if p not in codes:
                errors.append(f"{label}的前置步驟「{p}」不存在。")
            if p == s.code:
                errors.append(f"{label}不可以自己為前置步驟。")
    if not any(s.is_milestone for s in steps):
        errors.append("範本中沒有任何「關帳里程碑」步驟，系統將無法計算實際關帳日。")
    if not errors:
        cycle = _find_cycle(steps)
        if cycle:
            errors.append("前置步驟形成循環：" + " → ".join(cycle))
    return errors


def _find_cycle(steps: list[TemplateStep]) -> list[str] | None:
    graph = {s.code: list(s.predecessors) for s in steps}
    state: dict[str, int] = {}
    path: list[str] = []

    def visit(code: str) -> list[str] | None:
        state[code] = 1
        path.append(code)
        for p in graph.get(code, []):
            if state.get(p) == 1:
                return path[path.index(p):] + [p]
            if state.get(p) is None and (found := visit(p)):
                return found
        path.pop()
        state[code] = 2
        return None

    for code in graph:
        if state.get(code) is None and (found := visit(code)):
            return found
    return None


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
