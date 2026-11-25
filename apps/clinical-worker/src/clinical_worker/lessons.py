"""What Watson learns from a doctor's corrections (plan step 4, 25 Nov 2026): habits, never facts.

A lesson comes from the forms a doctor approved: a word they replace in at least two consultations
and never let stand (never one with a number in it), a question they nearly always clear, or
answers they always make much shorter or longer. Raw past answers never reach the model, so one
patient's details cannot appear in another patient's form. Each lesson has a key the doctor can
forget it by."""

import difflib
import re
from dataclasses import dataclass
from typing import Any

from .form import Template

MIN_CONSULTATIONS = 2  # a replacement seen in one consultation only is that patient's detail
MIN_ANSWERS = 3  # how often a question must have been answered before its habit counts
CLEARED_SHARE = 0.6  # cleared this often: leave it empty unless said in so many words
SHORTER, LONGER = 0.6, 1.6  # the doctor's words against Watson's, in characters
MOST = 12  # lessons in a prompt, at most
WORD = re.compile(r"[^\W\d_]+(?:['-][^\W\d_]+)*")


@dataclass(frozen=True)
class Edit:
    """An answer the doctor rewrote: the question, Watson's words, theirs, and the consultation."""

    key: str
    watson: str
    doctor: str
    consultation: str


@dataclass(frozen=True)
class Lesson:
    key: str  # stable: how a doctor forgets it
    rule: str  # for the model
    said: str  # for the doctor
    weight: int  # how often it was seen; the strongest are kept


def _replacements(edit: Edit) -> list[tuple[str, str]]:
    """Single words the doctor put in place of Watson's, in answers without any number."""
    if re.search(r"\d", edit.watson + edit.doctor):
        return []
    before, after = WORD.findall(edit.watson.lower()), WORD.findall(edit.doctor.lower())
    matcher = difflib.SequenceMatcher(a=before, b=after, autojunk=False)
    return [
        (before[i1], after[j1])
        for op, i1, i2, j1, j2 in matcher.get_opcodes()
        if op == "replace" and i2 - i1 == 1 and j2 - j1 == 1
    ]


def _words(edits: list[Edit], kept: set[str]) -> list[Lesson]:
    """Words the doctor always replaces. One they also let stand (kept) is a fact they corrected,
    such as "right" for "left", and never becomes a rule."""
    seen: dict[tuple[str, str], set[str]] = {}
    for edit in edits:
        for pair in _replacements(edit):
            seen.setdefault(pair, set()).add(edit.consultation)
    return [
        Lesson(
            f"word:{old}>{new}",
            f'Write "{new}", not "{old}".',
            f'You write "{new}" where Watson wrote "{old}".',
            len(where),
        )
        for (old, new), where in seen.items()
        if len(where) >= MIN_CONSULTATIONS and old not in kept
    ]


def _cleared(
    answered: dict[str, int], cleared: dict[str, int], labels: dict[str, str]
) -> list[Lesson]:
    return [
        Lesson(
            f"empty:{key}",
            f"{key}: leave it empty unless the practitioner says it in so many words.",
            f'You usually clear "{labels.get(key, key)}": Watson fills it only when you say it.',
            count,
        )
        for key, count in cleared.items()
        if answered.get(key, 0) >= MIN_ANSWERS and count / answered[key] >= CLEARED_SHARE
    ]


def _lengths(edits: list[Edit], labels: dict[str, str]) -> list[Lesson]:
    by_key: dict[str, list[Edit]] = {}
    for edit in edits:
        by_key.setdefault(edit.key, []).append(edit)
    lessons = []
    for key, rewrites in by_key.items():
        if len(rewrites) < MIN_ANSWERS:
            continue
        ratio = sum(len(e.doctor) for e in rewrites) / max(1, sum(len(e.watson) for e in rewrites))
        label = labels.get(key, key)
        if ratio <= SHORTER:
            lessons.append(
                Lesson(
                    f"short:{key}",
                    f"{key}: keep it short, a few words.",
                    f'You keep "{label}" short: Watson writes it briefly.',
                    len(rewrites),
                )
            )
        elif ratio >= LONGER:
            lessons.append(
                Lesson(
                    f"long:{key}",
                    f"{key}: write it in full, with the detail the practitioner gave.",
                    f'You write "{label}" in full: Watson gives it more detail.',
                    len(rewrites),
                )
            )
    return lessons


def derive(
    edits: list[Edit],
    answered: dict[str, int],
    cleared: dict[str, int],
    labels: dict[str, str],
    forgotten: set[str] = frozenset(),  # type: ignore[assignment]
    kept: set[str] = frozenset(),  # type: ignore[assignment]
) -> list[Lesson]:
    """The doctor's habits, strongest first, at most MOST, without those they asked to forget.
    kept: the words in the doctor's approved answers."""
    found = _words(edits, kept) + _cleared(answered, cleared, labels) + _lengths(edits, labels)
    wanted = [lesson for lesson in found if lesson.key not in forgotten]
    return sorted(wanted, key=lambda lesson: (-lesson.weight, lesson.key))[:MOST]


def render(lessons: list[Lesson]) -> str:
    """The lessons as rules for the form model; nothing when there are none."""
    if not lessons:
        return ""
    return (
        "\n- How this practitioner writes, learned from their corrections"
        " (habits, never facts about this patient):"
        + "".join(f"\n  - {lesson.rule}" for lesson in lessons)
    )


def learned(history: dict[str, Any], template: Template) -> list[Lesson]:
    """The lessons for a form, from the correction history the database hands the engine with the
    job (private.correction_history). Habits about questions this form does not ask are left out."""
    labels = {field.key: field.label for field in template.fields}
    edits = [
        Edit(str(e["key"]), str(e["watson"]), str(e["doctor"]), str(e["consultation"]))
        for e in history.get("edits") or []
    ]
    lessons = derive(
        edits,
        answered={k: int(v) for k, v in (history.get("answered") or {}).items()},
        cleared={k: int(v) for k, v in (history.get("cleared") or {}).items()},
        labels=labels,
        forgotten=set(history.get("forgotten") or []),
        kept={w for token in history.get("kept") or [] for w in WORD.findall(str(token).lower())},
    )
    return [x for x in lessons if x.key.startswith("word:") or x.key.split(":", 1)[1] in labels]
