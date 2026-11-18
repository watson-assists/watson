"""Word error rate and speed of a speech model on a two-track test call.

Run: uv run python bench/transcribe_bench.py <model> <dir-from-make-dialogue> <language>
The tracks are first squeezed through 32 kbit/s Opus, as the browser records a call."""

import json
import re
import sys
import tempfile
import time
from pathlib import Path

import av

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from clinical_worker.config import Settings  # noqa: E402
from clinical_worker.transcribe import transcribe_track  # noqa: E402

# The scripts spell numbers out; the model may write digits. Both count as the same word, in the
# call's own language (18 Nov: Slovak "šesť" written "6" was scored as English "six").
NUMBERS = {
    "en": {
        "0": "zero",
        "1": "one",
        "2": "two",
        "3": "three",
        "4": "four",
        "5": "five",
        "6": "six",
        "7": "seven",
        "8": "eight",
        "9": "nine",
        "10": "ten",
        "11": "eleven",
        "19": "nineteen",
        "21": "twenty-one",
        "28": "twenty-eight",
        "42": "forty-two",
    },
    "sk": {
        "0": "nula",
        "1": "jeden",
        "2": "dva",
        "3": "tri",
        "4": "štyri",
        "5": "päť",
        "6": "šesť",
        "7": "sedem",
        "8": "osem",
        "9": "deväť",
        "10": "desať",
        "35": "tridsaťpäť",
    },
}


def words(text: str, language: str = "en") -> list[str]:
    numbers = NUMBERS.get(language, {})
    text = re.sub(r"\d+", lambda m: numbers.get(m.group(), m.group()), text.lower())
    return re.findall(r"[^\W_]+(?:'[^\W_]+)?", text.replace("-", " "))


def wer(reference: list[str], hypothesis: list[str]) -> float:
    row = list(range(len(hypothesis) + 1))
    for i, r in enumerate(reference, 1):
        prev, row[0] = row[0], i
        for j, h in enumerate(hypothesis, 1):
            prev, row[j] = row[j], min(row[j] + 1, row[j - 1] + 1, prev + (r != h))
    return row[-1] / max(1, len(reference))


def opus(source: Path, target: Path) -> None:
    with av.open(str(source)) as inp, av.open(str(target), "w", format="webm") as out:
        stream = out.add_stream("libopus", rate=48000)
        stream.bit_rate = 32000
        resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
        for frame in inp.decode(audio=0):
            for f in resampler.resample(frame):
                for packet in stream.encode(f):
                    out.mux(packet)
        for packet in stream.encode(None):
            out.mux(packet)


def main() -> None:
    model, folder, language = sys.argv[1], Path(sys.argv[2]), sys.argv[3]
    script = json.loads((folder / "script.json").read_text())
    settings = Settings(model=model)
    total = {"seconds": 0.0, "audio": 0.0, "errors": 0.0, "words": 0}
    with tempfile.TemporaryDirectory() as tmp:
        for speaker in ("practitioner", "patient"):
            squeezed = Path(tmp) / f"{speaker}.webm"
            opus(folder / f"{speaker}.wav", squeezed)
            started = time.monotonic()
            result = transcribe_track(squeezed, language, settings, lambda: False)
            seconds = time.monotonic() - started
            heard = " ".join(s.text for s in result.segments)
            ref = words(script[speaker], language)
            rate = wer(ref, words(heard, language))
            total["seconds"] += seconds
            total["audio"] += result.duration_seconds
            total["errors"] += rate * len(ref)
            total["words"] += len(ref)
            print(f"{speaker:13} WER {rate:6.1%}  {seconds:6.1f} s")
    print(
        json.dumps(
            {
                "model": model,
                "language": language,
                "wer": round(total["errors"] / total["words"], 4),
                "transcribe_seconds": round(total["seconds"], 1),
                "audio_seconds": round(total["audio"], 1),
            }
        )
    )


if __name__ == "__main__":
    main()
