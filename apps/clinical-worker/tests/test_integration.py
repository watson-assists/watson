"""The real engine against the local Supabase stack (MASTER_BUILD_SPEC.md sections 12.7, 18, 20).

Run `supabase start` first. These tests are skipped when the stack is not running or the tiny
model has not been fetched (`python -m clinical_worker fetch-model` with WATSON_MODEL=tiny)."""

import hashlib
import io
import json
import logging
import random
import struct
import subprocess
import uuid
import wave
from pathlib import Path
from typing import Any

import pytest
from storage3.utils import StorageException
from supabase import Client, ClientOptions, create_client

from clinical_worker.config import Settings
from clinical_worker.engine import Engine
from clinical_worker.errors import ErrorCategory, WorkerError
from clinical_worker.transcribe import TrackTranscription

REPO = Path(__file__).resolve().parents[3]
HOME = Path.home() / ".local" / "share" / "watson"
SPEECH = (REPO / "packages/test-fixtures/audio/en-patient-sleep.wav").read_bytes()
PASSWORD = "correct-horse-battery-1"


def _stack() -> dict[str, str] | None:
    try:
        raw = subprocess.run(
            ["supabase", "status", "-o", "json"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
        status = json.loads(raw[raw.index("{") : raw.rindex("}") + 1])
        return {
            "url": status["API_URL"],
            "public": status["PUBLISHABLE_KEY"],
            "secret": status["SECRET_KEY"],
        }
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return None


STACK = _stack()
pytestmark = [
    pytest.mark.skipif(STACK is None, reason="the local Supabase stack is not running"),
    pytest.mark.skipif(
        not (HOME / "models" / "faster-whisper-tiny").is_dir(), reason="no tiny model"
    ),
]


def _wav(samples: list[int], rate: int = 16000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return buffer.getvalue()


_rng = random.Random(7)
SILENCE = _wav([0] * 16000 * 5)
ROOM_NOISE = _wav([max(-32768, min(32767, int(_rng.gauss(0, 900)))) for _ in range(16000 * 6)])
UNDECODABLE = bytes(_rng.getrandbits(8) for _ in range(40_000))


def _client(key: str) -> Client:
    assert STACK is not None
    return create_client(
        STACK["url"], key, options=ClientOptions(auto_refresh_token=False, persist_session=False)
    )


def _admin() -> Client:
    assert STACK is not None
    return _client(STACK["secret"])


def _account(label: str, practitioner: bool = True) -> tuple[str, str, Client]:
    assert STACK is not None
    email = f"{label}-{uuid.uuid4().hex[:8]}@watson.test"
    created = _admin().auth.admin.create_user(
        {"email": email, "password": PASSWORD, "email_confirm": True}
    )
    # Since SEC-02 (29 Oct) a practitioner is one by role, as in apps/web/tests/local-stack.ts.
    if practitioner:
        subprocess.run(
            ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-q"],
            # The id is a UUID that Supabase Auth just returned, not outside input.
            input="insert into private.user_roles (user_id, role)"  # noqa: S608
            f" values ('{created.user.id}', 'practitioner');",
            text=True,
            check=True,
            capture_output=True,
        )
    client = _client(STACK["public"])
    client.auth.sign_in_with_password({"email": email, "password": PASSWORD})
    return created.user.id, email, client


@pytest.fixture(scope="module")
def engine() -> Engine:
    assert STACK is not None
    user_id, email, _ = _account("engine", practitioner=False)
    _admin().rpc("register_engine", {"p_user_id": user_id, "p_label": "pytest"}).execute()
    return Engine(
        Settings(
            home=HOME,
            model="tiny",
            supabase_url=STACK["url"],
            supabase_publishable_key=STACK["public"],
            engine_email=email,
            engine_password=PASSWORD,  # type: ignore[arg-type]
        )
    )


@pytest.fixture(scope="module")
def cara() -> tuple[str, str, Client]:
    return _account("cara")


@pytest.fixture(autouse=True)
def empty_queue() -> None:
    """One queue serves every test; start each from an empty one."""
    subprocess.run(
        ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-q"],
        input="update public.transcription_jobs set status = 'cancelled', finished_at = now()"
        " where status in ('queued', 'processing');"
        " update public.form_jobs set status = 'cancelled', finished_at = now()"
        " where status in ('queued', 'processing');"
        " update public.patient_documents set reading = 'failed'"
        " where reading in ('waiting', 'reading');",
        text=True,
        check=True,
        capture_output=True,
    )


def _data(request: Any) -> Any:
    """Runs a request and returns its body, which supabase-py types as any JSON value."""
    return request.execute().data


def _queue(cara: tuple[str, str, Client], practitioner: bytes, patient: bytes) -> str:
    """Creates a consultation with the two files as its tracks, and starts transcription."""
    user_id, _, client = cara
    created = _data(
        client.rpc(
            "create_consultation",
            {
                "p_synthetic_patient_ref": "SYN-0042",
                "p_scheduled_at": "2026-10-05T08:30:00Z",
                "p_language": "en",
                "p_consent_recorded": True,
            },
        )
    )
    consultation_id: str = created["consultation_id"]
    for speaker, data in (("practitioner", practitioner), ("patient", patient)):
        path = f"{user_id}/{consultation_id}/{speaker}"
        client.storage.from_("audio").upload(path, data, {"content-type": "audio/wav"})
        answer = _data(
            client.rpc(
                "register_audio_track",
                {
                    "p_consultation_id": consultation_id,
                    "p_speaker": speaker,
                    "p_format": "wav",
                    "p_size_bytes": len(data),
                    "p_sha256": hashlib.sha256(data).hexdigest(),
                },
            )
        )
        assert answer["ok"], answer
    assert _data(client.rpc("start_transcription", {"p_consultation_id": consultation_id}))["ok"]
    return consultation_id


def _outcome(cara: tuple[str, str, Client], consultation_id: str) -> dict[str, Any]:
    client = cara[2]
    consultation = client.table("consultations").select("status").eq("id", consultation_id)
    job = (
        client.table("transcription_jobs")
        .select("status, error_category, failed_speaker")
        .eq("consultation_id", consultation_id)
        .order("queued_at", desc=True)
        .limit(1)
    )
    transcripts = _data(
        client.table("transcripts").select("id").eq("consultation_id", consultation_id)
    )
    segments: list[dict[str, Any]] = (
        _data(
            client.table("transcript_segments")
            .select("speaker, machine_text, confidence, possibly_not_speech")
            .eq("transcript_id", transcripts[0]["id"])
            .order("position")
        )
        if transcripts
        else []
    )
    return {
        "status": _data(consultation.single())["status"],
        "job": _data(job.single()),
        "segments": segments,
    }


def _on_to_its_form(practitioner: tuple[str, str, Client], consultation_id: str) -> bool:
    """Since every consultation pins a form version (20261108083404), a delivered transcript goes
    straight on to its form: the consultation waits for the form and its job is queued. Updated
    from "transcript_ready" with the owner's approval, 17 Nov."""
    jobs = _data(
        practitioner[2].table("form_jobs").select("status").eq("consultation_id", consultation_id)
    )
    return _status(practitioner, consultation_id) == "extraction_processing" and jobs == [
        {"status": "queued"}
    ]


def test_a_full_job_delivers_a_transcript_and_logs_no_text(
    engine: Engine,
    cara: tuple[str, str, Client],
    caplog: pytest.LogCaptureFixture,
    capfd: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level(logging.DEBUG)  # every logger, every level
    consultation_id = _queue(cara, SPEECH, SPEECH)
    assert engine.run_once()

    outcome = _outcome(cara, consultation_id)
    assert _on_to_its_form(cara, consultation_id)
    assert {s["speaker"] for s in outcome["segments"]} == {"practitioner", "patient"}
    text = " ".join(s["machine_text"] for s in outcome["segments"]).lower()
    assert "sleep" in text

    logged = (caplog.text + "".join(capfd.readouterr())).lower()
    words = {w.strip(".,?!;:'\"") for w in text.split()} - {""}
    leaked = {w for w in words if len(w) > 5 and w in logged}
    assert not leaked, f"transcript words in the logs: {sorted(leaked)}"


def test_digital_silence_gives_an_empty_transcript(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    consultation_id = _queue(cara, SILENCE, SILENCE)
    assert engine.run_once()
    outcome = _outcome(cara, consultation_id)
    assert _on_to_its_form(cara, consultation_id)
    assert outcome["segments"] == []


def test_room_noise_is_flagged_never_passed_off_as_speech(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    consultation_id = _queue(cara, ROOM_NOISE, ROOM_NOISE)
    assert engine.run_once()
    outcome = _outcome(cara, consultation_id)
    assert _on_to_its_form(cara, consultation_id)
    for segment in outcome["segments"]:
        assert segment["possibly_not_speech"] or (segment["confidence"] or 0) < 0.5, segment


def test_undecodable_audio_fails_and_names_the_track(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    consultation_id = _queue(cara, SPEECH, UNDECODABLE)
    assert engine.run_once()
    outcome = _outcome(cara, consultation_id)
    assert outcome["status"] == "transcription_failed"
    assert outcome["job"] == {
        "status": "failed",
        "error_category": "AUDIO_CORRUPT",
        "failed_speaker": "patient",
    }


def test_a_file_changed_after_registration_is_refused(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    consultation_id = _queue(cara, SPEECH, SPEECH)
    # Only the master key can still replace the file; the engine must notice.
    path = f"{cara[0]}/{consultation_id}/patient"
    _admin().storage.from_("audio").update(path, SILENCE, {"content-type": "audio/wav"})
    assert engine.run_once()
    outcome = _outcome(cara, consultation_id)
    assert outcome["job"]["error_category"] == "AUDIO_CORRUPT"
    assert outcome["job"]["failed_speaker"] == "patient"


TEMPLATE = json.loads((REPO / "packages/test-fixtures/templates/ayurveda-intake.json").read_text())


class StandInModel:
    """Answers the first field from line 0 (and an invented line 999); leaves the rest empty."""

    last_seconds = 0.1
    last_usage = {"prompt_tokens": 10, "completion_tokens": 5}

    def complete(self, system: str, user: str, schema: dict[str, Any], stop: Any) -> str:
        keys = list(schema["properties"])
        answers: dict[str, Any] = {k: {"lines": [], "answer": None} for k in keys}
        answers[keys[0]] = {"lines": [0, 999], "answer": "Sleeps badly for three weeks."}
        return json.dumps(answers)


@pytest.fixture(scope="module")
def dana() -> tuple[str, str, Client]:
    """A practitioner with a form template (cara has none, so her transcripts stop there)."""
    account = _account("dana")
    assert _data(account[2].rpc("set_form_template", {"p_definition": TEMPLATE}))["ok"]
    return account


def _status(practitioner: tuple[str, str, Client], consultation_id: str) -> str:
    return str(
        _data(
            practitioner[2]
            .table("consultations")
            .select("status")
            .eq("id", consultation_id)
            .single()
        )["status"]
    )


def test_a_transcript_goes_on_to_a_form_the_practitioner_checks_and_approves(
    engine: Engine, dana: tuple[str, str, Client]
) -> None:
    client = dana[2]
    consultation_id = _queue(dana, SPEECH, SPEECH)
    assert engine.run_once()  # the transcript
    assert _status(dana, consultation_id) == "extraction_processing"

    engine.form_model = StandInModel()  # type: ignore[assignment]
    assert engine.run_once()  # the form
    assert _status(dana, consultation_id) == "draft_ready"
    form = _data(
        client.table("forms").select("id, status").eq("consultation_id", consultation_id).single()
    )
    answers = _data(
        client.table("form_answers")
        .select("field_key, machine_text, evidence, review")
        .eq("form_id", form["id"])
        .order("position")
    )
    assert len(answers) == 21 and answers[0]["field_key"] == "age"
    assert answers[0]["machine_text"] == "Sleeps badly for three weeks."
    assert answers[0]["evidence"] == [0]  # line 999 does not exist and was dropped
    assert all(a["machine_text"] is None for a in answers[1:])

    def review(key: str, decision: str, text: str | None = None) -> dict[str, Any]:
        return dict(
            _data(
                client.rpc(
                    "review_form_answer",
                    {
                        "p_form_id": form["id"],
                        "p_field_key": key,
                        "p_decision": decision,
                        "p_text": text,
                    },
                )
            )
        )

    def approve() -> dict[str, Any]:
        return dict(_data(client.rpc("approve_form", {"p_form_id": form["id"]})))

    assert approve()["error_category"] == "FORM_NOT_REVIEWED"
    assert review("work", "accept")["error_category"] == "VALIDATION"  # nothing to accept
    assert review("work", "edit", "Teacher")["ok"]
    assert _status(dana, consultation_id) == "under_review"
    assert review("age", "accept")["ok"]
    assert approve()["ok"]
    assert _status(dana, consultation_id) == "approved"
    assert review("age", "reject")["error_category"] == "INVALID_STATE_TRANSITION"


class InstructedModel(StandInModel):
    """The stand-in, keeping the instructions it was given."""

    def __init__(self) -> None:
        self.systems: list[str] = []

    def complete(self, system: str, user: str, schema: dict[str, Any], stop: Any) -> str:
        self.systems.append(system)
        return super().complete(system, user, schema, stop)


def test_the_doctors_corrections_become_a_lesson_for_the_next_form(engine: Engine) -> None:
    """Plan step 4: a word the doctor replaced in two approved forms is a rule for the next form,
    and the doctor sees it."""
    erin = _account("erin")  # a doctor of their own: dana let "badly" stand, so no habit there
    client = erin[2]
    assert _data(client.rpc("set_form_template", {"p_definition": TEMPLATE}))["ok"]
    model = InstructedModel()
    engine.form_model = model  # type: ignore[assignment]
    rule = 'Write "poorly", not "badly".'
    for _ in range(2):
        consultation_id = _queue(erin, SPEECH, SPEECH)
        assert engine.run_once() and engine.run_once()  # the transcript, then the form
        form_id = _data(
            client.table("forms").select("id").eq("consultation_id", consultation_id).single()
        )["id"]
        edit = {"p_form_id": form_id, "p_field_key": "age", "p_decision": "edit"}
        assert _data(
            client.rpc("review_form_answer", {**edit, "p_text": "Sleeps poorly for three weeks."})
        )["ok"]
        assert _data(client.rpc("approve_form", {"p_form_id": form_id}))["ok"]
    assert rule not in model.systems[-1]  # one consultation is that patient's detail
    _queue(erin, SPEECH, SPEECH)
    assert engine.run_once() and engine.run_once()
    assert rule in model.systems[-1]
    lessons = _data(client.table("practitioner_lessons").select("key, seen"))
    assert {"key": "word:badly>poorly", "seen": 2} in lessons


def test_a_form_filled_during_the_call_is_a_preview_beside_it_and_the_call_goes_on(
    engine: Engine, dana: tuple[str, str, Client]
) -> None:
    """Owner's test team, 23 Nov: "the form filled alongside the conversation"."""
    client = dana[2]
    consultation_id = _data(
        client.rpc(
            "create_consultation",
            {
                "p_scheduled_at": "2026-11-24T09:00:00Z",
                "p_language": "en",
                "p_consent_recorded": True,
            },
        )
    )["consultation_id"]
    subprocess.run(
        ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-q"],
        # The id is a UUID the database just returned, not outside input.
        input="insert into public.live_pieces"  # noqa: S608
        " (consultation_id, speaker, seq, offset_seconds, storage_path, status, text)"
        f" values ('{consultation_id}', 'patient', 0, 0, 'x/{consultation_id}/live/patient-0',"
        " 'done', 'I sleep badly for three weeks.');",
        text=True,
        check=True,
        capture_output=True,
    )
    assert _data(client.rpc("fill_form_during_call", {"p_consultation_id": consultation_id}))["ok"]
    engine.form_model = StandInModel()  # type: ignore[assignment]
    assert engine.run_once()
    job = _data(
        client.table("form_jobs").select("status, preview").eq("consultation_id", consultation_id)
    )
    assert job == [
        {
            "status": "completed",
            "preview": [{"key": "age", "text": "Sleeps badly for three weeks."}],
        }
    ]
    assert _status(dana, consultation_id) == "ready_for_audio"


def test_a_form_that_cannot_be_filled_fails_and_can_be_tried_again(
    engine: Engine, dana: tuple[str, str, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    consultation_id = _queue(dana, SPEECH, SPEECH)
    assert engine.run_once()

    def unavailable() -> Any:
        raise WorkerError(ErrorCategory.FORM_MODEL_UNAVAILABLE)

    monkeypatch.setattr(engine, "_load_form_model", unavailable)
    assert engine.run_once()
    assert _status(dana, consultation_id) == "extraction_failed"
    job = _data(
        dana[2]
        .table("form_jobs")
        .select("error_category")
        .eq("consultation_id", consultation_id)
        .single()
    )
    assert job["error_category"] == "FORM_MODEL_UNAVAILABLE"
    assert _data(dana[2].rpc("start_form", {"p_consultation_id": consultation_id}))["ok"]
    assert _status(dana, consultation_id) == "extraction_processing"


def test_the_database_refuses_answers_that_do_not_match_the_form(
    engine: Engine, dana: tuple[str, str, Client]
) -> None:
    _queue(dana, SPEECH, SPEECH)
    assert engine.run_once()
    claimed = engine.main.rpc("engine_claim_form_job", {})["job"]
    args = {"p_job_id": claimed["job_id"], "p_attempt": claimed["attempt"], "p_metrics": {}}
    one_field = [{"key": "age", "text": "42", "evidence": []}]
    assert (
        engine.main.rpc("engine_complete_form_job", {**args, "p_answers": one_field})[
            "error_category"
        ]
        == "VALIDATION"
    )
    every_field = [
        {"key": f["key"], "text": None, "evidence": [999]}
        for s in TEMPLATE["sections"]
        for f in s["fields"]
    ]
    assert (
        engine.main.rpc("engine_complete_form_job", {**args, "p_answers": every_field})[
            "error_category"
        ]
        == "VALIDATION"
    )


class DocumentModel(StandInModel):
    """Answers the first field from line 0 and document line D1 (and an invented D9)."""

    def complete(self, system: str, user: str, schema: dict[str, Any], stop: Any) -> str:
        keys = list(schema["properties"])
        assert "documents" in schema["properties"][keys[0]]["properties"]
        assert "[D1] Blood test.pdf, page 1: Ferritin 9 ug/L, low." in user
        answers: dict[str, Any] = {k: {"lines": [], "documents": [], "answer": None} for k in keys}
        answers[keys[0]] = {"lines": [0], "documents": [1, 9], "answer": "Low iron stores."}
        return json.dumps(answers)


def test_a_document_the_patient_sends_is_read_and_quoted_in_the_form(
    engine: Engine, dana: tuple[str, str, Client]
) -> None:
    from test_unit import _pdf  # the one-page PDF with its own text

    consultation_id = _queue(dana, SPEECH, SPEECH)
    token = _data(
        dana[2].table("consultations").select("invite_token").eq("id", consultation_id).single()
    )["invite_token"]
    patient = _client(STACK["public"])  # type: ignore[index]
    number = f"+4219{random.randrange(10**7, 10**8)}"
    assert _data(
        patient.rpc("patient_identify", {"p_token": token, "p_name": "Jana", "p_contact": number})
    )["ok"]
    pdf = _pdf("Ferritin 9 ug/L, low.")
    added = _data(
        patient.rpc(
            "patient_add_document",
            {
                "p_token": token,
                "p_file_name": "Blood test.pdf",
                "p_media_type": "application/pdf",
                "p_size_bytes": len(pdf),
            },
        )
    )
    patient.storage.from_("documents").upload(
        added["path"], pdf, {"content-type": "application/pdf"}
    )
    assert _data(
        patient.rpc(
            "patient_confirm_document", {"p_token": token, "p_document_id": added["document_id"]}
        )
    )["ok"]

    assert engine.run_once()  # the transcript
    assert engine.run_once()  # the document, before the form
    document = _data(
        dana[2]
        .table("patient_documents")
        .select("reading, page_texts")
        .eq("id", added["document_id"])
        .single()
    )
    assert document == {"reading": "read", "page_texts": ["Ferritin 9 ug/L, low."]}

    engine.form_model = DocumentModel()  # type: ignore[assignment]
    assert engine.run_once()  # the form, reading the document too
    assert _status(dana, consultation_id) == "draft_ready"
    form = _data(
        dana[2].table("forms").select("id").eq("consultation_id", consultation_id).single()
    )
    first = _data(
        dana[2]
        .table("form_answers")
        .select("machine_text, evidence, document_quotes")
        .eq("form_id", form["id"])
        .eq("position", 0)
        .single()
    )
    assert first == {
        "machine_text": "Low iron stores.",
        "evidence": [0],
        "document_quotes": [
            {"document_id": added["document_id"], "page": 1, "text": "Ferritin 9 ug/L, low."}
        ],
    }


# The live transcript during the call (owner, 24 October): ten-second pieces of each voice, read
# before any other work, their text for the call screen, the piece removed once read.
def _no_live_pieces() -> None:
    subprocess.run(
        ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-q"],
        input="update public.live_pieces set status = 'failed' where status in ('waiting', 'reading');"
        " update public.voice_notes set status = 'failed' where status in ('waiting', 'reading');",
        text=True,
        check=True,
    )


def _live_pieces(
    cara: tuple[str, str, Client], pieces: list[tuple[str, float, bytes]]
) -> tuple[str, list[str]]:
    """A consultation in progress and its pieces (speaker, offset in seconds, audio), in order."""
    user_id, _, client = cara
    created = _data(
        client.rpc(
            "create_consultation",
            {
                "p_scheduled_at": "2026-10-24T10:00:00Z",
                "p_language": "en",
                "p_consent_recorded": True,
            },
        )
    )
    consultation_id: str = created["consultation_id"]
    paths, seqs = [], {"patient": 0, "practitioner": 0}
    for speaker, offset, data in pieces:
        seq, seqs[speaker] = seqs[speaker], seqs[speaker] + 1
        path = f"{user_id}/{consultation_id}/live/{speaker}-{seq}"
        client.storage.from_("audio").upload(path, data, {"content-type": "audio/wav"})
        added = _data(
            client.rpc(
                "add_live_piece",
                {
                    "p_consultation_id": consultation_id,
                    "p_speaker": speaker,
                    "p_seq": seq,
                    "p_offset_seconds": offset,
                },
            )
        )
        assert added == {"ok": True}, added
        paths.append(path)
    return consultation_id, paths


def _live_piece(cara: tuple[str, str, Client], data: bytes) -> tuple[str, str]:
    consultation_id, paths = _live_pieces(cara, [("patient", 0, data)])
    return consultation_id, paths[0]


def test_a_live_piece_becomes_text_for_the_call_screen_and_is_removed(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    _no_live_pieces()
    consultation_id, path = _live_piece(cara, SPEECH)
    assert engine.run_once()
    rows = _data(
        cara[2].table("live_pieces").select("status, text").eq("consultation_id", consultation_id)
    )
    assert rows[0]["status"] == "done"
    assert len(rows[0]["text"].split()) >= 3
    with pytest.raises(StorageException):  # removed once read
        _admin().storage.from_("audio").download(path)


def test_one_voices_waiting_pieces_are_read_together_each_with_its_own_words(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    """Owner, 25 Nov: the live transcript's delay. The same voice's next pieces within twenty
    seconds are read in one pass; each still gets the words said in it."""
    _no_live_pieces()
    consultation_id, paths = _live_pieces(
        cara,
        [
            ("patient", 0, SPEECH),
            ("practitioner", 1, SPEECH),
            ("patient", 7.5, SILENCE),
            ("patient", 12.5, SPEECH),
        ],
    )
    assert engine.run_live_once()
    rows = _data(
        cara[2]
        .table("live_pieces")
        .select("speaker, seq, status, text")
        .eq("consultation_id", consultation_id)
    )
    read = {(r["speaker"], r["seq"]): (r["status"], len((r["text"] or "").split())) for r in rows}
    assert read[("practitioner", 0)] == ("waiting", 0)  # another voice: the next pass
    speech, silence, more_speech = (read[("patient", n)] for n in range(3))
    assert speech[0] == silence[0] == more_speech[0] == "done", rows
    assert speech[1] >= 3 and silence[1] == 0 and more_speech[1] >= 3, rows
    for path in paths[0], paths[2], paths[3]:  # removed once read
        with pytest.raises(StorageException):
            _admin().storage.from_("audio").download(path)


def test_a_voice_note_is_written_into_the_doctors_notes_and_removed(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    """Owner's test team, 23 Nov: the form also takes "the doctor's voice notes"."""
    _no_live_pieces()
    user_id, _, client = cara
    consultation_id = _data(
        client.rpc(
            "create_consultation",
            {
                "p_scheduled_at": "2026-11-24T09:00:00Z",
                "p_language": "en",
                "p_consent_recorded": False,
            },
        )
    )["consultation_id"]
    assert _data(
        client.rpc("save_doctor_notes", {"p_consultation_id": consultation_id, "p_text": "Pale."})
    ) == {"ok": True}
    note_id = str(uuid.uuid4())
    path = f"{user_id}/{consultation_id}/notes/{note_id}"
    client.storage.from_("audio").upload(path, SPEECH, {"content-type": "audio/wav"})
    added = _data(
        client.rpc("add_voice_note", {"p_consultation_id": consultation_id, "p_id": note_id})
    )
    assert added == {"ok": True}, added
    assert engine.run_once()
    notes = _data(
        client.table("doctor_notes").select("text").eq("consultation_id", consultation_id).single()
    )["text"]
    assert notes.startswith("Pale.\n\n") and len(notes.split()) >= 4
    note = _data(client.table("voice_notes").select("status").eq("id", note_id).single())
    assert note == {"status": "done"}
    with pytest.raises(StorageException):  # removed once read
        _admin().storage.from_("audio").download(path)


def test_a_live_piece_never_waits_for_the_form_model(
    engine: Engine, cara: tuple[str, str, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    # 17 Nov: a form fill after each ten-second piece held the next pieces back for minutes, on the
    # laptop and on Modal alike. The call screen's words come first; form work runs elsewhere.
    _no_live_pieces()
    asked: list[bool] = []

    def refuse() -> None:
        asked.append(True)
        raise AssertionError("the form model was asked during a call")

    monkeypatch.setattr(engine, "_load_form_model", refuse)
    consultation_id, _ = _live_piece(cara, SPEECH)
    assert engine.run_once()
    assert asked == []
    rows = _data(
        cara[2].table("live_pieces").select("status").eq("consultation_id", consultation_id)
    )
    assert rows == [{"status": "done"}]


def test_the_speech_model_is_told_the_names_and_spellings_of_the_consultation(
    engine: Engine, cara: tuple[str, str, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    # Owner, 24 Oct: the doctor corrects a misheard name; Watson then listens for it.
    _no_live_pieces()
    user_id, _, client = cara
    contact = f"+421905{random.randint(100000, 999999)}"
    created = _data(
        client.rpc(
            "create_consultation",
            {
                "p_scheduled_at": "2026-10-24T10:00:00Z",
                "p_language": "en",
                "p_consent_recorded": True,
                "p_patient_name": "Jana Nováková",
                "p_patient_contact": contact,
            },
        )
    )
    path = f"{user_id}/{created['consultation_id']}/live/patient-0"
    client.storage.from_("audio").upload(path, SPEECH, {"content-type": "audio/wav"})
    client.rpc(
        "add_live_piece",
        {
            "p_consultation_id": created["consultation_id"],
            "p_speaker": "patient",
            "p_seq": 0,
            "p_offset_seconds": 0,
        },
    ).execute()
    told: list[list[str]] = []

    def listening(
        path: Path, language: str | None, settings: Settings, should_stop: Any, hints: list[str]
    ) -> TrackTranscription:
        told.append(hints)
        return TrackTranscription(
            segments=[], language="en", language_probability=None, duration_seconds=1.0
        )

    monkeypatch.setattr("clinical_worker.engine.transcribe_track", listening)
    assert engine.run_once()
    assert told and "Jana Nováková" in told[0]


def test_a_live_piece_comes_before_a_queued_transcript(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    _no_live_pieces()
    queued = _queue(cara, SPEECH, SPEECH)
    consultation_id, _ = _live_piece(cara, SILENCE)
    assert engine.run_once()
    piece = _data(
        cara[2].table("live_pieces").select("status, text").eq("consultation_id", consultation_id)
    )
    assert piece == [{"status": "done", "text": ""}]  # silence: nothing to show
    job = _data(cara[2].table("transcription_jobs").select("status").eq("consultation_id", queued))
    assert job == [{"status": "queued"}]


def test_a_live_piece_of_an_ended_call_is_removed_unread(
    engine: Engine, cara: tuple[str, str, Client]
) -> None:
    _no_live_pieces()
    consultation_id, path = _live_piece(cara, SPEECH)
    subprocess.run(
        ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-q"]
        + ["-v", f"id={consultation_id}"],
        input="update public.consultations set status = 'audio_imported' where id = :'id';",
        text=True,
        check=True,
    )
    engine.run_once()
    piece = _data(
        cara[2].table("live_pieces").select("status, text").eq("consultation_id", consultation_id)
    )
    assert piece == [{"status": "failed", "text": None}]
    with pytest.raises(StorageException):  # its file is gone too
        _admin().storage.from_("audio").download(path)


def test_the_live_worker_reads_live_pieces_only_in_a_run_of_its_own(
    engine: Engine, cara: tuple[str, str, Client], monkeypatch: pytest.MonkeyPatch
) -> None:
    # 18 Nov: during a call the words never wait behind a transcript, a document or a form. The
    # live worker reads live pieces and nothing else, and its run counts in the same allowance.
    _no_live_pieces()
    queued = _queue(cara, SPEECH, SPEECH)
    consultation_id, _ = _live_piece(cara, SILENCE)
    seen: list[bool] = []

    def once(step: Any, finish: Any, idle_seconds: float, poll_seconds: float, **_: Any) -> None:
        seen.extend([step(), step(), finish()])  # the piece; then nothing, the transcript waits
        assert (idle_seconds, poll_seconds) == (60, 1)

    monkeypatch.setattr("clinical_worker.engine.on_demand", once)
    engine.run_on_demand(live=True)
    assert seen == [True, False, True]
    piece = _data(
        cara[2].table("live_pieces").select("status").eq("consultation_id", consultation_id)
    )
    assert piece == [{"status": "done"}]
    job = _data(cara[2].table("transcription_jobs").select("status").eq("consultation_id", queued))
    assert job == [{"status": "queued"}]
    runs = subprocess.run(
        ["docker", "exec", "-i", "supabase_db_watson", "psql", "-U", "postgres", "-qtA"],
        input="select live, finished_at is not null from public.engine_runs"
        " order by started_at desc limit 1;",
        text=True,
        check=True,
        capture_output=True,
    ).stdout.split()
    assert runs == ["t|t"]
