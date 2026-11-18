"""Watson's exam (owner, 16-17 Nov 2026): how good the engine is now, as one comparable line.

For each invented consultation (English and Slovak; German once it has a consultation and a
voice) it measures what doctors get: word errors per voice, the Ayurvedic terms caught, form
fields right when the form is filled from what Watson heard, and the processor time per
ten-second live piece. Runs on this computer only: no Modal minutes, no GitHub minutes.
The calls are made once with Piper (scripts/make-dialogue.py) and kept outside the repository.

Run: uv run python bench/exam.py [en sk]
Each run appends one line to docs/exam/scores.jsonl, the scorecard's history. Invented data only.
"""

import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
import wave
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from form_bench import FIXTURES, score  # noqa: E402
from transcribe_bench import opus, wer, words  # noqa: E402

from clinical_worker.config import Settings  # noqa: E402
from clinical_worker.form import Line, LlamaModel, Template, fill  # noqa: E402
from clinical_worker.transcribe import transcribe_track  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
CALLS = Path.home() / ".local" / "share" / "watson" / "exam"
LIVE_PIECES = 4  # per voice: enough for a stable median, a few minutes of processor time


def call_for(language: str) -> Path:
    """The two-voice call for this language, made once."""
    folder = CALLS / language
    if not (folder / "script.json").is_file():
        case = FIXTURES / f"consultations/ayurveda-{language}.json"
        subprocess.run(  # noqa: S603 - this repository's own script, on its own fixture
            [sys.executable, str(REPO / "scripts/make-dialogue.py"), str(case), str(folder)],
            check=True,
        )
    return folder


def pieces(track: Path, folder: Path, count: int) -> list[Path]:
    """Ten-second pieces of a track, as the call screen sends them, keeping those with sound."""
    out = []
    with wave.open(str(track)) as source:
        rate, frames = source.getframerate(), source.getnframes()
        step = rate * 10
        for n, start in enumerate(range(0, frames, step)):
            source.setpos(start)
            data = source.readframes(step)
            if not any(data[i] for i in range(0, len(data), 97)):
                continue  # this voice is silent here
            piece = folder / f"{track.stem}-{n}.wav"
            with wave.open(str(piece), "w") as target:
                target.setparams(source.getparams())
                target.writeframes(data)
            out.append(piece)
            if len(out) == count:
                break
    return out


def examine(language: str, settings: Settings, model: LlamaModel) -> dict[str, object]:
    folder = call_for(language)
    script = json.loads((folder / "script.json").read_text())
    case = json.loads((FIXTURES / f"consultations/ayurveda-{language}.json").read_text())
    terms = [t.strip().lower() for t in settings.vocabulary.split(",") if t.strip()]
    result: dict[str, object] = {"language": language}
    segments = []
    with tempfile.TemporaryDirectory() as tmp:
        heard_all, said_all = "", ""
        for speaker in ("practitioner", "patient"):
            squeezed = Path(tmp) / f"{speaker}.webm"
            opus(folder / f"{speaker}.wav", squeezed)  # as the browser records a call
            heard = transcribe_track(squeezed, language, settings, lambda: False)
            text = " ".join(s.text for s in heard.segments)
            result[f"wer_{speaker}"] = round(wer(words(script[speaker]), words(text)), 4)
            segments += [(s.start, speaker, s.text) for s in heard.segments]
            heard_all, said_all = (
                heard_all + " " + text.lower(),
                said_all + " " + script[speaker].lower(),
            )
        said_terms = [t for t in terms if t in said_all]
        result["terms_caught"] = f"{sum(t in heard_all for t in said_terms)}/{len(said_terms)}"

        timings = []
        for speaker in ("practitioner", "patient"):
            for piece in pieces(folder / f"{speaker}.wav", Path(tmp), LIVE_PIECES):
                squeezed = piece.with_suffix(".webm")
                opus(piece, squeezed)
                started = time.monotonic()
                transcribe_track(squeezed, language, settings, lambda: False)
                timings.append(time.monotonic() - started)
        result["live_seconds_per_piece"] = round(statistics.median(timings), 1)

    lines = [Line(i, speaker, text) for i, (_, speaker, text) in enumerate(sorted(segments))]
    template = Template.model_validate_json(
        (FIXTURES / "templates/ayurveda-intake.json").read_text()
    )
    marks = score(case, lines, fill(model, template, lines, case["language"]), show=False)
    result["form_right"] = f"{marks['right']}/{marks['fields']}"
    result["form_invented"] = marks["invented"]
    return result


def main() -> None:
    languages = sys.argv[1:] or ["en", "sk"]
    settings = Settings()
    model = LlamaModel(settings.form_model_path)
    commit = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],  # noqa: S607 - git from the developer's path
        cwd=REPO,
        capture_output=True,
        text=True,
    ).stdout.strip()
    line = {
        "date": datetime.now(UTC).strftime("%Y-%m-%dT%H:%MZ"),
        "commit": commit,
        "speech_model": settings.model,
        "form_model": settings.form_model_file,
        "cpus": os.cpu_count(),
    }
    results = []
    for language in languages:
        result = examine(language, settings, model)
        print(json.dumps(result))
        results.append(result)
    line["results"] = results
    scores = REPO / "docs/exam/scores.jsonl"
    scores.parent.mkdir(exist_ok=True)
    with scores.open("a") as out:
        out.write(json.dumps(line) + "\n")
    print(f"appended to {scores.relative_to(REPO)}")


if __name__ == "__main__":
    main()
