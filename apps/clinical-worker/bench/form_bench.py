"""Scores a local model on filling the example form from an invented consultation.

Run: uv run --with llama-cpp-python python bench/form_bench.py <model.gguf> [consultation.json]
The consultation's "expected" block says, per field, whether it was discussed and which words
a correct answer contains (and must not contain). Invented data only (spec 5.1)."""

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from clinical_worker.form import Line, LlamaModel, Template, fill  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "test-fixtures"


def score(
    case: dict[str, Any], lines: list[Line], answers: list[Any], show: bool = True
) -> dict[str, int]:
    """How many of the form's answers are right against the invented consultation's expectations.
    Shared with bench/exam.py, which scores answers filled from what Watson heard."""
    by_line = {line.position: line.text.lower() for line in lines}
    score = {"right": 0, "fields": 0, "words": 0, "words_found": 0, "invented": 0, "bad_quotes": 0}
    for answer in answers:
        want = case["expected"][answer.key]
        text = (answer.text or "").lower()
        score["fields"] += 1
        if not want["discussed"]:
            ok = answer.text is None
            score["invented"] += not ok
            note = "not discussed" if ok else "INVENTED"
        else:
            found = [
                w for w in want.get("include", []) if any(a in text for a in w.lower().split("|"))
            ]
            bad = [w for w in want.get("exclude", []) if w.lower() in text]
            quoted = " ".join(by_line[n] for n in answer.evidence)
            quote_ok = bool(answer.evidence) and any(
                a in quoted for w in want.get("include", []) for a in w.lower().split("|")
            )
            score["words"] += len(want.get("include", []))
            score["words_found"] += len(found)
            score["bad_quotes"] += answer.text is not None and not quote_ok
            ok = answer.text is not None and len(found) == len(want.get("include", [])) and not bad
            note = (
                f"{len(found)}/{len(want.get('include', []))} words"
                + (f", WRONG: {bad}" if bad else "")
                + ("" if quote_ok else ", quote misses")
            )
        score["right"] += ok
        if show:
            mark = "ok " if ok else "XX "
            print(f"{mark} {answer.key:20} {note:32} {answer.evidence} {answer.text}")
    return score


def main() -> None:
    model_path = Path(sys.argv[1])
    case = json.loads(
        Path(
            sys.argv[2] if len(sys.argv) > 2 else FIXTURES / "consultations/ayurveda-en.json"
        ).read_text()
    )
    template = Template.model_validate_json(
        (FIXTURES / "templates/ayurveda-intake.json").read_text()
    )
    lines = [Line(i, speaker, text) for i, (speaker, text) in enumerate(case["turns"])]
    model = LlamaModel(model_path)
    answers = fill(model, template, lines, case["language"])
    score_ = score(case, lines, answers)
    print(
        json.dumps(
            {
                "model": model_path.name,
                "seconds": model.last_seconds,
                "usage": model.last_usage,
                **score_,
            }
        )
    )


if __name__ == "__main__":
    main()
