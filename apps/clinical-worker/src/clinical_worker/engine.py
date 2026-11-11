"""Pulls jobs from the database and processes them (MASTER_BUILD_SPEC.md section 12.7).

The engine signs in as its own account, which can call the engine functions and read the
audio of the job it has claimed and the document it is reading, and nothing else. It listens
on no port."""

import hashlib
import shutil
import tempfile
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from supabase import Client, ClientOptions, create_client

from .audio import audio_duration_seconds
from .config import AUDIO_FORMATS, Settings
from .documents import Reader
from .errors import ErrorCategory, Stopped, WorkerError
from .form import Cancelled, Line, LlamaModel, Template, coverage, document_lines, fill
from .log import log_event
from .merge import merge
from .schema import Speaker, Track, Transcript, TranscriptionModel
from .transcribe import TrackTranscription, model_revision, transcribe_track

SPEAKERS: tuple[Speaker, Speaker] = ("practitioner", "patient")


class Connection:
    """One signed-in session. If the session has lapsed, it signs in once more and retries."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = self._sign_in()

    def _sign_in(self) -> Client:
        client = create_client(
            self.settings.supabase_url,
            self.settings.supabase_publishable_key,
            options=ClientOptions(auto_refresh_token=True, persist_session=False),
        )
        client.auth.sign_in_with_password(
            {
                "email": self.settings.engine_email,
                "password": self.settings.engine_password.get_secret_value(),
            }
        )
        return client

    def rpc(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        for attempt in (1, 2):
            try:
                data = self.client.rpc(name, args).execute().data
                return data if isinstance(data, dict) else {}
            except Exception as exc:
                if attempt == 2 or not _session_lapsed(exc):
                    raise
                self.client = self._sign_in()
        raise AssertionError("unreachable")

    def remove(self, path: str, bucket: str = "audio") -> None:
        for attempt in (1, 2):
            try:
                self.client.storage.from_(bucket).remove([path])
                return
            except Exception as exc:
                if attempt == 2 or not _session_lapsed(exc):
                    raise
                self.client = self._sign_in()

    def download(self, path: str, bucket: str = "audio") -> bytes:
        for attempt in (1, 2):
            try:
                return self.client.storage.from_(bucket).download(path)
            except Exception as exc:
                if attempt == 2 or not _session_lapsed(exc):
                    raise
                self.client = self._sign_in()
        raise AssertionError("unreachable")


def _session_lapsed(exc: Exception) -> bool:
    text = str(exc).lower()
    return "jwt" in text or "expired" in text or "401" in text


def _missing(exc: Exception) -> bool:
    text = str(exc).lower()
    return "not found" in text or "404" in text


class Heartbeat(threading.Thread):
    """Tells the database where the job is, at least every `interval` seconds, and
    raises the `stopped` flag when the answer is to stop."""

    def __init__(
        self,
        connection: Connection,
        job_id: str,
        attempt: int,
        interval: float,
        rpc: str = "engine_heartbeat",
    ) -> None:
        super().__init__(daemon=True)
        self.rpc = rpc
        self.connection = connection
        self.job_id = job_id
        self.attempt = attempt
        self.interval = interval
        self.stage = "validating"
        self.audio_seconds: float | None = None
        self.stopped = threading.Event()
        self._finished = threading.Event()
        self._lock = threading.Lock()

    def beat(self) -> None:
        with self._lock:
            try:
                args: dict[str, Any] = {"p_job_id": self.job_id, "p_attempt": self.attempt}
                if self.rpc == "engine_heartbeat":
                    args |= {"p_stage": self.stage, "p_audio_seconds": self.audio_seconds}
                answer = self.connection.rpc(self.rpc, args)
                if not answer.get("continue"):
                    self.stopped.set()
            except Exception as exc:
                log_event(
                    "job.heartbeat_failed", job_id=self.job_id, exception_type=type(exc).__name__
                )

    def move_to(self, stage: str) -> None:
        self.stage = stage
        self.beat()
        if self.stopped.is_set():
            raise Stopped

    def run(self) -> None:
        while not self._finished.wait(self.interval):
            self.beat()

    def finish(self) -> None:
        self._finished.set()


def on_demand(
    step: Callable[[], bool],
    finish: Callable[[], bool],
    idle_seconds: float,
    poll_seconds: float,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """An engine started on demand (decision 0009): works until nothing has come for `idle_seconds`,
    then stops, unless `finish` says work arrived just as it was stopping."""
    while True:
        last_work = clock()
        while clock() - last_work < idle_seconds:
            if step():
                last_work = clock()
            else:
                sleep(poll_seconds)
        if finish():
            return


class Engine:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.main = Connection(settings)
        self.beats = Connection(
            settings
        )  # a second session, so a long download never delays a heartbeat
        self.form_model: LlamaModel | None = None  # loaded at the first form job
        self.reader = Reader(settings.ocr_model_dir)  # OCR models load at the first scan

    def run_forever(self) -> None:
        log_event(
            "engine.started",
            model=self.settings.model,
            device=self.settings.device,
            compute_type=self.settings.compute_type,
        )
        while True:
            if not self._step():
                time.sleep(self.settings.poll_seconds)

    def run_on_demand(self) -> None:
        """In the cloud: started when work waits, stopped when there is none (decision 0009)."""
        run_id = self.main.rpc("engine_run_started", {})["run_id"]
        log_event(
            "engine.started_on_demand", model=self.settings.model, device=self.settings.device
        )
        on_demand(
            self._step,
            lambda: bool(self.main.rpc("engine_run_finished", {"p_run_id": run_id}).get("ok")),
            self.settings.idle_seconds,
            self.settings.poll_seconds,
        )
        log_event("engine.stopped_on_demand")

    def _step(self) -> bool:
        """One job, if there is one. A failure is logged and counts as nothing done."""
        try:
            return self.run_once()
        except Exception as exc:
            log_event("engine.poll_failed", exception_type=type(exc).__name__)
            return False

    def run_once(self) -> bool:
        """Claims and processes one job. False when there was nothing to do."""
        # A piece of the call in progress first: the practitioner is watching for its text.
        answer = self.main.rpc("engine_claim_live_piece", {})
        if not answer.get("ok"):
            raise RuntimeError(str(answer.get("error_category")))
        for path in answer.get("remove") or []:  # pieces set aside unread: no audio left behind
            self._remove_live_file(path)
        if answer.get("piece"):
            self.process_live_piece(answer["piece"])
            return True
        answer = self.main.rpc("engine_claim_job", {})
        if not answer.get("ok"):
            raise RuntimeError(str(answer.get("error_category")))
        if answer.get("job"):
            self.process(answer["job"])
            return True
        # Transcripts first: a doctor waits for those. Then the patient's documents, so a form
        # filled next can use them. Forms come last.
        answer = self.main.rpc("engine_claim_document", {})
        if not answer.get("ok"):
            raise RuntimeError(str(answer.get("error_category")))
        if answer.get("document"):
            self.process_document(answer["document"])
            return True
        answer = self.main.rpc("engine_claim_form_job", {})
        if not answer.get("ok"):
            raise RuntimeError(str(answer.get("error_category")))
        if answer.get("job"):
            self.process_form(answer["job"])
            return True
        return False

    def process_live_piece(self, piece: dict[str, Any]) -> None:
        """Ten seconds of one voice during the call: its text for the call screen (owner, 24 Oct).
        The piece is removed either way; the transcript after the call uses the full recordings."""
        try:
            data = self.main.download(piece["storage_path"])
            self.settings.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=self.settings.work_dir) as folder:
                path = Path(folder) / "piece"
                path.write_bytes(data)
                hints = self._hints(piece.get("consultation_id"))
                heard = transcribe_track(
                    path, piece["language"], self.settings, lambda: False, hints=hints
                )
            text = " ".join(s.text for s in heard.segments if not s.possibly_not_speech)
            result = self.main.rpc("engine_live_piece_done", {"p_id": piece["id"], "p_text": text})
            if (
                result.get("ok")
                and text
                and piece.get("provisional_enabled")
                and piece.get("template")
            ):
                try:
                    keys = coverage(
                        self._load_form_model(),
                        Template.model_validate(piece["template"]),
                        Line(0, piece["speaker"], text),
                        piece.get("language") or "",
                    )
                    self.main.rpc(
                        "engine_record_provisional_coverage",
                        {"p_piece_id": piece["id"], "p_field_keys": keys},
                    )
                except Exception as exc:
                    log_event("provisional_coverage.failed", exception_type=type(exc).__name__)
        except Exception as exc:
            log_event("live_piece.failed", exception_type=type(exc).__name__)
            self.main.rpc("engine_live_piece_failed", {"p_id": piece["id"]})
        finally:
            self._remove_live_file(piece["storage_path"])

    def _hints(self, consultation_id: str | None) -> list[str]:
        """The consultation's names and the spellings its practitioner taught, for the speech
        model. None when they cannot be had: the transcript is still made, only less well."""
        if not consultation_id:
            return []
        try:
            answer = self.main.rpc("engine_hints", {"p_consultation_id": consultation_id})
        except Exception as exc:
            log_event("hints.unavailable", exception_type=type(exc).__name__)
            return []
        return [str(hint) for hint in answer.get("hints", [])] if answer.get("ok") else []

    def _remove_live_file(self, path: str) -> None:
        try:
            self.main.remove(path)
        except Exception as exc:
            log_event("live_piece.not_removed", exception_type=type(exc).__name__)

    def process_document(self, document: dict[str, Any]) -> None:
        ids: dict[str, str | int] = {
            "document_id": document["document_id"],
            "attempt": document["attempt"],
        }
        started = time.monotonic()
        log_event("document.claimed", **ids)
        try:
            data = self.main.download(document["storage_path"], "documents")
            pages = self.reader.read(data, document["media_type"])
            answer = self.main.rpc(
                "engine_complete_document",
                {
                    "p_document_id": document["document_id"],
                    "p_attempt": document["attempt"],
                    "p_pages": pages or [""],
                },
            )
            if not answer.get("ok"):
                log_event(
                    "document.result_refused",
                    **ids,
                    error_category=str(answer.get("error_category")),
                )
                return
            log_event(
                "document.read" if answer.get("readable") else "document.unreadable",
                **ids,
                pages=len(pages),
                duration_seconds=round(time.monotonic() - started, 2),
            )
        except WorkerError as error:
            self._fail_document(document, error.category, ids, error.__cause__)
        except Exception as exc:
            self._fail_document(document, ErrorCategory.DOCUMENT_FAILED, ids, exc)

    def _fail_document(
        self,
        document: dict[str, Any],
        category: ErrorCategory,
        ids: dict[str, str | int],
        cause: BaseException | None,
    ) -> None:
        log_event(
            "document.failed",
            **ids,
            error_category=category.value,
            exception_type=type(cause).__name__ if cause else None,
        )
        try:
            self.main.rpc(
                "engine_fail_document",
                {
                    "p_document_id": document["document_id"],
                    "p_attempt": document["attempt"],
                    "p_error_category": category.value,
                },
            )
        except Exception as exc:
            log_event("document.failure_not_reported", **ids, exception_type=type(exc).__name__)

    def _load_form_model(self) -> LlamaModel:
        if self.form_model is None:
            path = self.settings.form_model_path
            if not path.is_file():
                raise WorkerError(ErrorCategory.FORM_MODEL_UNAVAILABLE)
            try:
                self.form_model = LlamaModel(
                    path, self.settings.form_context_tokens, self.settings.cpu_threads
                )
            except Exception as exc:
                raise WorkerError(ErrorCategory.FORM_MODEL_UNAVAILABLE) from exc
        return self.form_model

    def process_form(self, job: dict[str, Any]) -> None:
        ids: dict[str, str | int] = {
            "job_id": job["job_id"],
            "consultation_id": job["consultation_id"],
            "attempt": job["attempt"],
        }
        heartbeat = Heartbeat(
            self.beats,
            job["job_id"],
            job["attempt"],
            self.settings.heartbeat_seconds,
            rpc="engine_form_heartbeat",
        )
        heartbeat.start()
        log_event("form.claimed", **ids)
        try:
            template = Template.model_validate(job["template"])
            lines = [Line(int(x["position"]), x["speaker"], str(x["text"])) for x in job["lines"]]
            documents = document_lines(job.get("documents") or [])
            model = self._load_form_model()
            answers = fill(
                model,
                template,
                lines,
                job.get("language") or "",
                heartbeat.stopped.is_set,
                documents,
            )
            answered = sum(1 for a in answers if a.state != "unanswered")
            metrics = {
                "form_model_name": self.settings.form_model_file,
                "form_duration_seconds": model.last_seconds,
                "prompt_tokens": model.last_usage.get("prompt_tokens"),
                "completion_tokens": model.last_usage.get("completion_tokens"),
                "answered_field_count": answered,
            }
            answer = self.main.rpc(
                "engine_complete_form_job",
                {
                    "p_job_id": job["job_id"],
                    "p_attempt": job["attempt"],
                    "p_answers": [
                        {
                            "key": a.key,
                            "text": a.text,
                            "value_type": a.value_type,
                            "value": a.value,
                            "state": a.state,
                            "evidence": a.evidence,
                            "documents": [
                                {"document_id": q.document_id, "page": q.page, "text": q.text}
                                for q in a.quotes
                            ],
                        }
                        for a in answers
                    ],
                    "p_metrics": metrics,
                },
            )
            if answer.get("ok"):
                log_event(
                    "form.completed",
                    **ids,
                    answered_field_count=answered,
                    prompt_tokens=model.last_usage.get("prompt_tokens"),
                    completion_tokens=model.last_usage.get("completion_tokens"),
                    duration_seconds=model.last_seconds,
                )
            elif answer.get("error_category") == "VALIDATION":
                raise WorkerError(ErrorCategory.FORM_FAILED)
            else:
                log_event(
                    "form.result_refused", **ids, error_category=str(answer.get("error_category"))
                )
        except (Stopped, Cancelled):
            log_event("form.stopped", **ids)
        except WorkerError as error:
            self._fail_form(job, error.category, ids, error.__cause__)
        except Exception as exc:
            self._fail_form(job, ErrorCategory.FORM_FAILED, ids, exc)
        finally:
            heartbeat.finish()

    def _fail_form(
        self,
        job: dict[str, Any],
        category: ErrorCategory,
        ids: dict[str, str | int],
        cause: BaseException | None,
    ) -> None:
        log_event(
            "form.failed",
            **ids,
            error_category=category.value,
            exception_type=type(cause).__name__ if cause else None,
        )
        try:
            self.main.rpc(
                "engine_fail_form_job",
                {
                    "p_job_id": job["job_id"],
                    "p_attempt": job["attempt"],
                    "p_error_category": category.value,
                },
            )
        except Exception as exc:
            log_event("form.failure_not_reported", **ids, exception_type=type(exc).__name__)

    def process(self, job: dict[str, Any]) -> None:
        ids: dict[str, str | int] = {
            "job_id": job["job_id"],
            "consultation_id": job["consultation_id"],
            "attempt": job["attempt"],
        }
        started = time.monotonic()
        heartbeat = Heartbeat(
            self.beats, job["job_id"], job["attempt"], self.settings.heartbeat_seconds
        )
        heartbeat.start()
        self.settings.work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        workdir = Path(tempfile.mkdtemp(dir=self.settings.work_dir))
        log_event("job.claimed", **ids)
        try:
            paths = self._fetch(job, workdir, heartbeat)
            language = None if job["language"] == "auto" else job["language"]
            hints = self._hints(job["consultation_id"])
            results: dict[Speaker, TrackTranscription] = {}
            for speaker in SPEAKERS:
                heartbeat.move_to(f"transcribing_{speaker}")
                try:
                    results[speaker] = transcribe_track(
                        paths[speaker],
                        language,
                        self.settings,
                        heartbeat.stopped.is_set,
                        hints=hints,
                    )
                except WorkerError as error:
                    raise WorkerError(error.category, speaker) from error
            heartbeat.move_to("merging")
            transcript, metrics = self._assemble(job, results, started)
            answer = self.main.rpc(
                "engine_complete_job",
                {
                    "p_job_id": job["job_id"],
                    "p_attempt": job["attempt"],
                    "p_transcript": transcript.model_dump(mode="json"),
                    "p_metrics": metrics,
                },
            )
            if answer.get("error_category") == "VALIDATION":
                # The database found the transcript inconsistent; the job must not hang.
                raise WorkerError(ErrorCategory.TRANSCRIPT_MERGE_FAILED)
            if answer.get("ok"):
                log_event(
                    "job.completed",
                    **ids,
                    model=self.settings.model,
                    segment_count=len(transcript.segments),
                    audio_duration_seconds=metrics["audio_duration_seconds"],
                    duration_seconds=round(time.monotonic() - started, 2),
                )
            else:
                log_event(
                    "job.result_refused", **ids, error_category=str(answer.get("error_category"))
                )
        except Stopped:
            log_event("job.stopped", **ids, stage=heartbeat.stage)
        except WorkerError as error:
            self._fail(job, error.category, error.speaker, ids, error.__cause__)
        except Exception as exc:
            self._fail(job, ErrorCategory.TRANSCRIPTION_FAILED, None, ids, exc)
        finally:
            heartbeat.finish()
            shutil.rmtree(workdir, ignore_errors=True)  # no copy of the audio outlives the job

    def _fetch(
        self, job: dict[str, Any], workdir: Path, heartbeat: Heartbeat
    ) -> dict[Speaker, Path]:
        paths: dict[Speaker, Path] = {}
        total = 0.0
        for track in job["tracks"]:
            speaker: Speaker = track["speaker"]
            if track["format"] not in AUDIO_FORMATS:
                raise WorkerError(ErrorCategory.AUDIO_FORMAT_UNSUPPORTED, speaker)
            try:
                data = self.main.download(track["storage_path"])
            except Exception as exc:
                category = (
                    ErrorCategory.AUDIO_FILE_MISSING
                    if _missing(exc)
                    else ErrorCategory.STORAGE_UNAVAILABLE
                )
                raise WorkerError(category, speaker) from exc
            if len(data) > self.settings.max_bytes:
                raise WorkerError(ErrorCategory.AUDIO_TOO_LARGE, speaker)
            if hashlib.sha256(data).hexdigest() != track["sha256"]:
                # The file is not the one that was registered.
                raise WorkerError(ErrorCategory.AUDIO_CORRUPT, speaker)
            path = workdir / f"{speaker}.{track['format']}"
            path.write_bytes(data)
            path.chmod(0o600)
            try:
                total += audio_duration_seconds(path, self.settings.max_duration_seconds)
            except WorkerError as error:
                raise WorkerError(error.category, speaker) from error
            paths[speaker] = path
            if heartbeat.stopped.is_set():
                raise Stopped
        heartbeat.audio_seconds = total
        heartbeat.beat()  # the time limit is now known (section 12.4)
        return paths

    def _assemble(
        self, job: dict[str, Any], results: dict[Speaker, TrackTranscription], started: float
    ) -> tuple[Transcript, dict[str, Any]]:
        together = bool(job["recorded_together"])
        offsets: dict[Speaker, float] = {
            t["speaker"]: float(t["offset_seconds"]) for t in job["tracks"]
        }
        segments = merge(
            {speaker: result.segments for speaker, result in results.items()},
            offsets,
            together,
            self.settings.overlap_tolerance_seconds,
        )
        model = TranscriptionModel(
            model=self.settings.model,
            revision=model_revision(self.settings),
            device=self.settings.device,
            compute_type=self.settings.compute_type,
        )
        tracks = [
            Track(
                speaker=t["speaker"],
                audio_sha256=t["sha256"],
                duration_seconds=results[t["speaker"]].duration_seconds,
                offset_seconds=offsets[t["speaker"]],
                sync_method="shared_clock" if together else "none",
                language=results[t["speaker"]].language,
                language_probability=results[t["speaker"]].language_probability,
                transcription_model=model,
            )
            for t in job["tracks"]
        ]
        try:
            transcript = Transcript(
                consultation_id=job["consultation_id"],
                created_at_utc=datetime.now(UTC),
                ordering="exact" if together else "approximate",
                low_confidence_threshold=self.settings.low_confidence_threshold,
                tracks=tracks,
                segments=segments,
            )
        except ValueError as exc:
            raise WorkerError(ErrorCategory.TRANSCRIPT_MERGE_FAILED) from exc
        threshold = self.settings.low_confidence_threshold
        metrics = {
            "audio_duration_seconds": round(sum(r.duration_seconds for r in results.values()), 2),
            "transcription_duration_seconds": round(time.monotonic() - started, 2),
            "transcription_model_name": "faster-whisper",
            "transcription_model_size": self.settings.model,
            "device_type": self.settings.device,
            "compute_type": self.settings.compute_type,
            "transcript_segment_count": len(segments),
            "low_confidence_segment_count": sum(
                1
                for s in segments
                if s.possibly_not_speech or (s.confidence is not None and s.confidence < threshold)
            ),
            "overlap_segment_count": sum(1 for s in segments if s.overlap),
        }
        return transcript, metrics

    def _fail(
        self,
        job: dict[str, Any],
        category: ErrorCategory,
        speaker: str | None,
        ids: dict[str, str | int],
        cause: BaseException | None,
    ) -> None:
        log_event(
            "job.failed",
            **ids,
            error_category=category.value,
            speaker=speaker,
            exception_type=type(cause).__name__ if cause else None,
        )
        try:
            self.main.rpc(
                "engine_fail_job",
                {
                    "p_job_id": job["job_id"],
                    "p_attempt": job["attempt"],
                    "p_error_category": category.value,
                    "p_speaker": speaker,
                    "p_metrics": {},
                },
            )
        except Exception as exc:
            log_event("job.failure_not_reported", **ids, exception_type=type(exc).__name__)
