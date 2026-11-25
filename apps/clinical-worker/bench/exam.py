"""Watson's exam (owner, 16-17 Nov 2026): how good the engine is now, as one comparable line.

For each invented consultation (English and Slovak; German once it has a consultation and a
voice) it measures what doctors get: word errors per voice, the Ayurvedic terms caught, form
fields right when the form is filled from what Watson heard, and the processor time per
ten-second live piece. Runs on this computer only: no Modal minutes, no GitHub minutes.
The calls are made once with Piper (scripts/make-dialogue.py) and kept outside the repository.
Where a language's Piper voice is poor (Slovak: both speech models mishear its words the same way),
real voices count too: native speakers reading sentences (Google's FLEURS, CC BY 4.0), fetched once.

Run: uv run python bench/exam.py [en sk]
Each run appends one line to docs/exam/scores.jsonl, the scorecard's history. Invented data only.
"""

import csv
import json
import os
import re
import statistics
import subprocess
import sys
import tarfile
import tempfile
import time
import wave
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from faster_whisper import decode_audio

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from form_bench import FIXTURES, score  # noqa: E402
from transcribe_bench import opus, wer, words  # noqa: E402

from clinical_worker.config import Settings  # noqa: E402
from clinical_worker.form import Line, LlamaModel, Template, fill  # noqa: E402
from clinical_worker.lessons import Edit, derive, render  # noqa: E402
from clinical_worker.transcribe import SAMPLE_RATE, transcribe_track  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
CALLS = Path.home() / ".local" / "share" / "watson" / "exam"
LIVE_PIECES = 4  # per voice: enough for a stable median, a few minutes of processor time
FLEURS = {"sk": "sk_sk"}  # languages measured on real voices too, and their FLEURS names
REAL_SENTENCES = 40  # about seven minutes of speech in one track, three minutes to read


def habits(template: Template) -> str:
    """A doctor's habits, one lesson of each kind, made the way the engine makes them
    (clinical_worker.lessons): a word swapped in two consultations, two questions they clear,
    one they shorten. Plan step 4: lessons stay only while the form's score with them holds."""
    edits = [
        Edit("dosha", "Pitta imbalance", "Pitta vitiation", "c1"),
        Edit("dosha", "Vata imbalance", "Vata vitiation", "c2"),
    ] + [
        Edit(
            "diet",
            "Porridge for breakfast, coffee at ten, cold drinks",
            "Porridge, coffee",
            f"d{n}",
        )
        for n in range(3)
    ]
    labels = {field.key: field.label for field in template.fields}
    lessons = derive(edits, {"exercise": 4, "yoga": 4}, {"exercise": 3, "yoga": 3}, labels)
    assert len(lessons) == 4, lessons  # noqa: S101 - every kind is in the exam
    return render(lessons)


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


def real_voices(language: str) -> tuple[Path, str]:
    """One track of FLEURS' first dev sentences (each once, no digits) a second apart, as a call
    track is read, and what they say. Fetched and made once."""
    code, folder = FLEURS[language], CALLS / f"fleurs-{language}"
    if not (folder / "wav").is_dir():
        from huggingface_hub import hf_hub_download

        for name in ("dev.tsv", "audio/dev.tar.gz"):
            hf_hub_download(
                "google/fleurs", f"data/{code}/{name}", repo_type="dataset", local_dir=folder
            )
        with tarfile.open(folder / f"data/{code}/audio/dev.tar.gz") as archive:
            archive.extractall(folder / "wav", filter="data")
    rows: dict[str, tuple[str, str]] = {}
    with (folder / f"data/{code}/dev.tsv").open() as tsv:
        for sentence, file, text, *_ in csv.reader(tsv, delimiter="\t", quoting=csv.QUOTE_NONE):
            if sentence not in rows and not re.search(r"\d", text):
                rows[sentence] = (file, text)
    chosen = list(rows.values())[:REAL_SENTENCES]
    track = folder / f"real-{REAL_SENTENCES}.wav"
    if not track.is_file():
        gap = np.zeros(SAMPLE_RATE, dtype=np.float32)
        clips = [decode_audio(str(folder / "wav/dev" / file)) for file, _ in chosen]
        # Each voice levelled, as the browser's automatic gain does in a call: FLEURS voices differ
        # by up to 25 dB, and a quiet sentence beside a loud one is lost in Whisper's 30 s window.
        clips = [np.clip(c * 0.05 / max(float(np.sqrt(np.mean(c**2))), 1e-6), -1, 1) for c in clips]
        with wave.open(str(track), "w") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(SAMPLE_RATE)
            out.writeframes(
                (np.concatenate([x for c in clips for x in (c, gap)]) * 32767)
                .astype("<i2")
                .tobytes()
            )
    return track, " ".join(text for _, text in chosen)


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
            result[f"wer_{speaker}"] = round(
                wer(words(script[speaker], language), words(text, language)), 4
            )
            segments += [(s.start, speaker, s.text) for s in heard.segments]
            heard_all, said_all = (
                heard_all + " " + text.lower(),
                said_all + " " + script[speaker].lower(),
            )
        said_terms = [t for t in terms if t in said_all]
        result["terms_caught"] = f"{sum(t in heard_all for t in said_terms)}/{len(said_terms)}"

        if language in FLEURS:
            track, said = real_voices(language)
            opus(track, Path(tmp) / "real.webm")
            heard = transcribe_track(Path(tmp) / "real.webm", language, settings, lambda: False)
            text = " ".join(s.text for s in heard.segments)
            result["wer_real_voices"] = round(wer(words(said, language), words(text, language)), 4)

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
    taught = score(
        case,
        lines,
        fill(model, template, lines, case["language"], lessons=habits(template)),
        show=False,
    )
    result["form_right_with_lessons"] = f"{taught['right']}/{taught['fields']}"
    result["form_invented_with_lessons"] = taught["invented"]
    result["lessons_hold"] = (
        taught["right"] >= marks["right"] and taught["invented"] <= marks["invented"]
    )
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
