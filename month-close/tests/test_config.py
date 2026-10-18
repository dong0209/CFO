from dataclasses import replace

import pytest

from closeapp.config import ConfigError, load_people, validate_template


def test_default_template_is_valid(ctx):
    assert validate_template(ctx.template, ctx.people) == []
    assert len(ctx.template) == 19


def _by_code(steps, code):
    return next(s for s in steps if s.code == code)


def test_segregation_of_duties(ctx):
    steps = list(ctx.template)
    s = _by_code(steps, "S01")
    steps[steps.index(s)] = replace(s, reviewer=s.owner)
    assert any("職能分離" in e for e in validate_template(steps, ctx.people))


def test_unknown_person_and_bad_rule(ctx):
    steps = list(ctx.template)
    s = _by_code(steps, "S02")
    steps[steps.index(s)] = replace(s, owner="不存在", due_rule="月底")
    errors = validate_template(steps, ctx.people)
    assert any("不在人員名單" in e for e in errors)
    assert any("截止規則" in e for e in errors)


def test_cycle_detected(ctx):
    steps = list(ctx.template)
    s = _by_code(steps, "S01")
    steps[steps.index(s)] = replace(s, predecessors=("S17",))
    assert any("循環" in e for e in validate_template(steps, ctx.people))


def test_pin_must_be_quoted(tmp_path):
    p = tmp_path / "people.yaml"
    p.write_text("人員:\n  - 姓名: 甲\n    角色: 主管\n    初始PIN: 1234\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="引號"):
        load_people(p)


def test_csv_in_big5_is_accepted(ctx, tmp_path):
    from closeapp.config import load_holidays
    p = tmp_path / "holidays.csv"
    p.write_bytes("日期,類型,說明\n2026/1/1,假日,元旦\n".encode("cp950"))
    hf = load_holidays(p)
    assert len(hf.holidays) == 1
