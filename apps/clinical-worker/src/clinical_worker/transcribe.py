"""One track in, timed segments out, with faster-whisper loaded from disk only."""

import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
from faster_whisper import WhisperModel, decode_audio
from numpy.typing import NDArray

from .config import DETECTABLE_LANGUAGES, Settings
from .errors import ErrorCategory, Stopped, WorkerError

SAMPLE_RATE = 16000


@dataclass(frozen=True)
class RawSegment:
    start: float
    end: float
    text: str
    confidence: float | None
    possibly_not_speech: bool


@dataclass(frozen=True)
class TrackTranscription:
    segments: list[RawSegment]
    language: str
    language_probability: float | None  # set only when the language was detected
    duration_seconds: float


@lru_cache(maxsize=1)
def _load(model_path: str, device: str, compute_type: str, cpu_threads: int) -> WhisperModel:
    # A directory path means faster-whisper never contacts Hugging Face.
    return WhisperModel(
        model_path, device=device, compute_type=compute_type, cpu_threads=cpu_threads
    )


def model_revision(settings: Settings) -> str | None:
    """Recorded by `clinical-worker fetch-model` next to the model files."""
    marker = settings.model_path / "revision.txt"
    return marker.read_text().strip() or None if marker.is_file() else None


def hotwords(vocabulary: str, hints: Sequence[str]) -> str | None:
    """What the speech model listens for: the Ayurvedic terms, then the consultation's own names and
    the spellings its practitioner taught (owner, 24 Oct). Each once."""
    words: list[str] = []
    for word in (w.strip() for w in [*vocabulary.split(","), *hints]):
        if word and word.lower() not in (w.lower() for w in words):
            words.append(word)
    return ", ".join(words) or None


def transcribe_track(
    path: Path | NDArray[np.float32],
    language: str | None,
    settings: Settings,
    should_stop: Callable[[], bool],
    hints: Sequence[str] = (),
) -> TrackTranscription:
    """Transcribes one speaker's audio, a file or samples at SAMPLE_RATE. `language=None` means
    "mixed or unsure"."""
    if not settings.model_path.is_dir():
        raise WorkerError(ErrorCategory.TRANSCRIPTION_MODEL_UNAVAILABLE)
    try:
        model = _load(
            str(settings.model_path), settings.device, settings.compute_type, settings.cpu_threads
        )
        audio = path if isinstance(path, np.ndarray) else decode_audio(str(path), SAMPLE_RATE)
        probability = None
        if language is None:
            # Detection chooses only among the languages we support (section 12.2).
            _, _, all_probabilities = model.detect_language(audio, vad_filter=True)
            allowed = [(code, p) for code, p in all_probabilities if code in DETECTABLE_LANGUAGES]
            language, probability = max(allowed, key=lambda item: item[1])
            probability = round(float(probability), 3)
        raw_segments, _ = model.transcribe(
            audio,
            language=language,
            vad_filter=True,  # digital silence produces no text
            condition_on_previous_text=False,  # limits runaway repetition
            temperature=(0.0, 0.2, 0.4),  # at most three attempts per window
            hotwords=hotwords(settings.vocabulary, hints),  # so "abhyanga" is not "piano"
        )
        segments = []
        for raw in raw_segments:  # lazy: decoding happens as we iterate
            if should_stop():
                raise Stopped
            text = raw.text.strip()
            if not text:
                continue
            segments.append(
                RawSegment(
                    start=float(raw.start),
                    end=float(raw.end),
                    text=text,
                    confidence=round(min(1.0, math.exp(raw.avg_logprob)), 3),
                    possibly_not_speech=raw.no_speech_prob > settings.no_speech_threshold,
                )
            )
    except (WorkerError, Stopped):
        raise
    except Exception as exc:
        raise WorkerError(ErrorCategory.TRANSCRIPTION_FAILED) from exc
    return TrackTranscription(
        segments=segments,
        language=language,
        language_probability=probability,
        duration_seconds=round(len(audio) / SAMPLE_RATE, 2),
    )


def said_in_each(heard: TrackTranscription, lengths: Sequence[int]) -> list[str]:
    """What was said in each of one voice's short recordings, read together in one pass (owner,
    25 Nov: the speech model reads any recording as a 30-second window, so ten short ones cost ten
    windows). `lengths` in samples, in order. A sentence belongs to the recording its middle falls
    in."""
    ends = np.cumsum(lengths) / SAMPLE_RATE
    said: list[list[str]] = [[] for _ in lengths]
    for segment in heard.segments:
        if not segment.possibly_not_speech:
            middle = (segment.start + segment.end) / 2
            where = min(int(np.searchsorted(ends, middle, side="right")), len(lengths) - 1)
            said[where].append(segment.text)
    return [" ".join(words) for words in said]
