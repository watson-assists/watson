import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from pydantic import ValidationError

from clinical_worker.__main__ import SCHEMA_DIR, schema_json
from clinical_worker.config import load_settings
from clinical_worker.log import log_event
from clinical_worker.merge import merge
from clinical_worker.schema import (
    SCHEMA_VERSION,
    Segment,
    Speaker,
    Track,
    Transcript,
    TranscriptionModel,
)
from clinical_worker.transcribe import RawSegment


def raw(start: float, end: float, text: str = "words") -> RawSegment:
    return RawSegment(start=start, end=end, text=text, confidence=0.9, possibly_not_speech=False)


class TestMerge:
    def test_orders_by_time_across_speakers(self) -> None:
        segments = merge(
            {"practitioner": [raw(0, 2, "a"), raw(6, 8, "c")], "patient": [raw(3, 5, "b")]},
            {},
            recorded_together=False,
            tolerance_seconds=0.25,
        )
        assert [s.machine_text for s in segments] == ["a", "b", "c"]
        assert [s.position for s in segments] == [0, 1, 2]
        assert [s.speaker for s in segments] == ["practitioner", "patient", "practitioner"]

    def test_breaks_ties_practitioner_first_then_track_order(self) -> None:
        segments = merge(
            {"patient": [raw(1, 2, "p1"), raw(1, 2, "p2")], "practitioner": [raw(1, 2, "d1")]},
            {},
            recorded_together=False,
            tolerance_seconds=0.25,
        )
        assert [s.machine_text for s in segments] == ["d1", "p1", "p2"]

    def test_applies_each_track_offset(self) -> None:
        segments = merge(
            {"practitioner": [raw(0, 1, "a")], "patient": [raw(0, 1, "b")]},
            {"patient": 5.0},
            recorded_together=True,
            tolerance_seconds=0.25,
        )
        assert [(s.machine_text, s.start_seconds) for s in segments] == [("a", 0.0), ("b", 5.0)]

    def test_marks_overlap_only_when_the_tracks_share_a_clock(self) -> None:
        tracks: dict[Speaker, list[RawSegment]] = {
            "practitioner": [raw(0, 3, "a")],
            "patient": [raw(2, 4, "b")],
        }
        together = merge(tracks, {}, recorded_together=True, tolerance_seconds=0.25)
        assert [s.overlap for s in together] == [True, True]
        apart = merge(tracks, {}, recorded_together=False, tolerance_seconds=0.25)
        assert [s.overlap for s in apart] == [None, None]

    def test_ignores_overlap_within_the_tolerance_and_within_one_speaker(self) -> None:
        brief = merge(
            {"practitioner": [raw(0, 2.1)], "patient": [raw(2.0, 4)]},
            {},
            recorded_together=True,
            tolerance_seconds=0.25,
        )
        assert [s.overlap for s in brief] == [False, False]
        same = merge(
            {"practitioner": [raw(0, 3), raw(1, 4)], "patient": []},
            {},
            recorded_together=True,
            tolerance_seconds=0.25,
        )
        assert [s.overlap for s in same] == [False, False]


def transcript(**overrides: object) -> dict[str, object]:
    model = TranscriptionModel(model="tiny", device="cpu", compute_type="int8")
    tracks = [
        Track(
            speaker=speaker,
            audio_sha256="a" * 64,
            duration_seconds=7.5,
            sync_method="none",
            language="en",
            transcription_model=model,
        )
        for speaker in ("practitioner", "patient")
    ]
    segment = Segment(
        segment_id=uuid4(),
        position=0,
        speaker="patient",
        start_seconds=0,
        end_seconds=1,
        machine_text="x",
    )
    return {
        "consultation_id": uuid4(),
        "created_at_utc": datetime.now(UTC),
        "ordering": "approximate",
        "low_confidence_threshold": 0.5,
        "tracks": tracks,
        "segments": [segment],
        **overrides,
    }


class TestTranscriptSchema:
    def test_accepts_a_consistent_transcript(self) -> None:
        assert Transcript.model_validate(transcript()).schema_version == "2.0.0"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"tracks": []},
            {
                "segments": [
                    Segment(
                        segment_id=uuid4(),
                        position=3,
                        speaker="patient",
                        start_seconds=0,
                        end_seconds=1,
                        machine_text="x",
                    )
                ]
            },
            {
                "segments": [
                    Segment(
                        segment_id=uuid4(),
                        position=0,
                        speaker="patient",
                        start_seconds=0,
                        end_seconds=1,
                        machine_text="x",
                        overlap=True,
                    )
                ]
            },
            {"diagnosis": "anything"},
        ],
    )
    def test_refuses_an_inconsistent_transcript(self, overrides: dict[str, object]) -> None:
        with pytest.raises(ValidationError):
            Transcript.model_validate(transcript(**overrides))

    def test_refuses_a_segment_that_ends_before_it_starts(self) -> None:
        with pytest.raises(ValidationError):
            Segment(
                segment_id=uuid4(),
                position=0,
                speaker="patient",
                start_seconds=2,
                end_seconds=1,
                machine_text="x",
            )

    def test_committed_json_schema_is_current(self) -> None:
        committed = (SCHEMA_DIR / f"transcript-{SCHEMA_VERSION}.schema.json").read_text()
        assert committed == schema_json(), "run: uv run clinical-worker export-schema"


class TestSettings:
    def test_environment_wins_over_the_file(self, tmp_path) -> None:  # type: ignore[no-untyped-def]
        file = tmp_path / "engine.env"
        file.write_text("WATSON_MODEL=medium\nWATSON_ENGINE_EMAIL=engine@example.test\n")
        settings = load_settings({"WATSON_ENV_FILE": str(file), "WATSON_MODEL": "tiny"})
        assert (settings.model, settings.engine_email) == ("tiny", "engine@example.test")

    def test_password_never_appears_in_its_representation(self) -> None:
        settings = load_settings(
            {"WATSON_ENV_FILE": "/nonexistent", "WATSON_ENGINE_PASSWORD": "s3cret-value"}
        )
        assert "s3cret-value" not in repr(settings)


def test_log_event_refuses_fields_outside_the_allow_list() -> None:
    with pytest.raises(ValueError, match="machine_text"):
        log_event("x", machine_text="anything")


def test_form_answers_keep_only_real_lines_and_say_nothing_for_topics_not_discussed() -> None:
    from clinical_worker.form import Line, Template, parse

    template = Template.model_validate(
        {
            "title": "T",
            "sections": [
                {
                    "title": "S",
                    "fields": [
                        {"key": "sleep", "label": "Sleep"},
                        {"key": "diet", "label": "Diet"},
                        {"key": "work", "label": "Work"},
                    ],
                }
            ],
        }
    )
    lines = [Line(0, "patient", "I sleep badly."), Line(1, "practitioner", "Since when?")]
    raw = json.dumps(
        {
            "sleep": {"lines": [0, 0, 7, "1"], "answer": "  Sleeps badly.  "},
            "diet": {"lines": [1], "answer": "None specified."},
            "extra": {"lines": [0], "answer": "not asked for"},
        }
    )
    answers = {a.key: a for a in parse(raw, template, lines)}
    assert answers["sleep"].text == "Sleeps badly." and answers["sleep"].evidence == [0]
    assert answers["diet"].text is None and answers["diet"].evidence == []
    assert answers["work"].text is None  # missing from the output
    assert set(answers) == {"sleep", "diet", "work"}


def test_live_coverage_returns_keys_only_and_discards_provisional_values() -> None:
    from clinical_worker.form import Line, Template, coverage

    class CoverageModel:
        def complete(self, system, user, schema, stop):  # type: ignore[no-untyped-def]
            return json.dumps(
                {
                    "sleep": {"lines": [0], "answer": "Wakes at three."},
                    "diet": {"lines": [], "answer": None},
                }
            )

    assert coverage(
        CoverageModel(),
        Template.model_validate(SMALL_TEMPLATE),
        Line(0, "patient", "I wake at three."),
        "en",
    ) == ["sleep"]


# Documents the patient sent (roadmap, 14 October): numbered lines in the prompt, quoted by page.

SMALL_TEMPLATE = {
    "title": "T",
    "sections": [
        {
            "title": "S",
            "fields": [{"key": "sleep", "label": "Sleep"}, {"key": "diet", "label": "Diet"}],
        }
    ],
}
LAB_PHOTO = (SCHEMA_DIR.parents[0] / "test-fixtures/documents/lab-report-sk.jpg").read_bytes()
OCR_MODELS = load_settings({}).ocr_model_dir


def _pdf(text: str) -> bytes:
    """A one-page PDF whose text is in the file itself, as a lab's software writes it."""
    stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R"
        b" /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out, offsets = b"%PDF-1.4\n", []
    for number, body in enumerate(bodies, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    return out + b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(bodies) + 1,
        xref,
    )


def test_documents_become_numbered_lines_newest_first_within_a_budget() -> None:
    from clinical_worker.form import DOCUMENT_CHARACTERS, document_lines

    lines = document_lines(
        [
            {
                "document_id": "new",
                "file_name": "Blood test.pdf",
                "pages": ["Ferritin 9 µg/L\n\n  low  ", "Page two"],
            },
            {"document_id": "old", "file_name": "Letter.pdf", "pages": ["An older letter"]},
        ]
    )
    assert [(d.number, d.document_id, d.page, d.text) for d in lines] == [
        (1, "new", 1, "Ferritin 9 µg/L"),
        (2, "new", 1, "low"),
        (3, "new", 2, "Page two"),
        (4, "old", 1, "An older letter"),
    ]
    many = document_lines([{"document_id": "d", "file_name": "f", "pages": ["z" * 300] * 100}])
    assert 0 < sum(len(d.text) for d in many) <= DOCUMENT_CHARACTERS


def test_a_form_without_documents_is_asked_exactly_as_before() -> None:
    from clinical_worker.form import DOCUMENT_RULES, DocumentLine, Line, Template, prompt, schema

    template = Template.model_validate(SMALL_TEMPLATE)
    lines = [Line(0, "patient", "I sleep badly.")]
    system, user = prompt(template, lines, "en")
    assert DOCUMENT_RULES not in system and "Documents" not in user
    assert list(schema(template)["properties"]["sleep"]["properties"]) == ["lines", "answer"]

    documents = [DocumentLine(1, "d", "Blood test.pdf", 1, "Ferritin 9 µg/L")]
    system, user = prompt(template, lines, "en", documents)
    assert system.endswith(DOCUMENT_RULES)
    assert user.endswith(
        "Documents the patient sent:\n[D1] Blood test.pdf, page 1: Ferritin 9 µg/L"
    )
    assert list(schema(template, True)["properties"]["sleep"]["properties"]) == [
        "lines",
        "documents",
        "answer",
    ]


def test_document_numbers_become_quotes_and_unknown_ones_are_dropped() -> None:
    from clinical_worker.form import DocumentLine, Line, Quote, Template, parse

    raw = {
        "sleep": {"lines": [0], "documents": [1, 1, 9], "answer": "Low iron stores."},
        "diet": {"lines": [], "documents": [1], "answer": None},
    }
    documents = [DocumentLine(1, "d", "Blood test.pdf", 2, "Ferritin 9 µg/L")]
    answers = {
        a.key: a
        for a in parse(
            json.dumps(raw),
            Template.model_validate(SMALL_TEMPLATE),
            [Line(0, "patient", "x")],
            documents,
        )
    }
    assert answers["sleep"].quotes == [Quote("d", 2, "Ferritin 9 µg/L")]
    assert answers["diet"].quotes == []  # no answer, so nothing to quote


def test_a_pdf_is_read_from_its_own_text_without_ocr(tmp_path: Path) -> None:
    from clinical_worker.documents import Reader

    reader = Reader(tmp_path)  # no OCR models here: a PDF with text must not need them
    assert reader.read(_pdf("Ferritin 9 ug/L, low. Haemoglobin 118 g/L."), "application/pdf") == [
        "Ferritin 9 ug/L, low. Haemoglobin 118 g/L."
    ]


def test_a_photo_without_ocr_models_says_so_and_a_broken_file_is_unreadable(tmp_path: Path) -> None:
    from clinical_worker.documents import Reader
    from clinical_worker.errors import ErrorCategory, WorkerError

    with pytest.raises(WorkerError) as missing:
        Reader(tmp_path).read(LAB_PHOTO, "image/jpeg")
    assert missing.value.category == ErrorCategory.OCR_MODEL_UNAVAILABLE
    with pytest.raises(WorkerError) as broken:
        Reader(tmp_path).read(b"not a pdf at all", "application/pdf")
    assert broken.value.category == ErrorCategory.DOCUMENT_UNREADABLE


@pytest.mark.skipif(
    not OCR_MODELS.is_dir() or len(list(OCR_MODELS.glob("*.onnx"))) < 3,
    reason="run `clinical-worker fetch-ocr-model` first",
)
def test_a_photo_of_a_slovak_lab_report_is_read_with_its_diacritics() -> None:
    from clinical_worker.documents import Reader

    [page] = Reader(OCR_MODELS).read(LAB_PHOTO, "image/jpeg")
    for words in (
        "Laboratórny výsledok",
        "Feritín: 9",
        "(referencia 15–150) — nízky",
        "znížené zásoby železa",
    ):
        assert words in page


class TestOnDemand:
    """An engine started on demand in the cloud (decision 0009): it works until nothing has come for
    a while, then stops, unless work arrived just as it was stopping."""

    class Clock:
        def __init__(self) -> None:
            self.now = 0.0

        def __call__(self) -> float:
            return self.now

        def sleep(self, seconds: float) -> None:
            self.now += seconds

    def test_it_works_while_there_is_work_and_stops_once_idle(self) -> None:
        from clinical_worker.engine import on_demand

        clock = self.Clock()
        jobs = [True, True]  # two jobs waiting, each taking 30 seconds
        steps: list[float] = []

        def step() -> bool:
            steps.append(clock.now)
            if jobs:
                jobs.pop()
                clock.now += 30
                return True
            return False

        on_demand(
            step,
            finish=lambda: True,
            idle_seconds=150,
            poll_seconds=10,
            clock=clock,
            sleep=clock.sleep,
        )
        assert steps[:3] == [0, 30, 60]
        assert clock.now == 210  # the last job ended at 60; then 150 seconds without work
        assert len(steps) == 2 + 15

    def test_it_carries_on_when_work_arrives_as_it_stops(self) -> None:
        from clinical_worker.engine import on_demand

        clock = self.Clock()
        answers = [False, True]  # the database refuses the first stop: a job has just arrived
        late_job = [True]
        done: list[float] = []

        def step() -> bool:
            if clock.now >= 150 and late_job:
                late_job.pop()
                done.append(clock.now)
                return True
            return False

        on_demand(
            step,
            finish=lambda: answers.pop(0),
            idle_seconds=150,
            poll_seconds=10,
            clock=clock,
            sleep=clock.sleep,
        )
        assert done == [150]
        assert answers == []
        assert clock.now == 300

    def test_the_idle_time_outlasts_a_lost_job_lease(self) -> None:
        # A job whose engine vanished is claimable again after two minutes; an engine started again
        # by Modal must still be there to claim it.
        assert load_settings({"WATSON_ENV_FILE": "/nonexistent"}).idle_seconds > 120


def test_the_engines_commands_load_outside_the_repository() -> None:
    # On Modal the package sits at /root/clinical_worker, two folders from the root, not inside
    # the repository (decision 0009).
    import shutil
    import subprocess
    import sys
    import tempfile

    import clinical_worker

    shallow = Path(tempfile.mkdtemp(dir="/tmp"))
    try:
        shutil.copytree(Path(clinical_worker.__file__).parent, shallow / "clinical_worker")
        loaded = subprocess.run(
            [sys.executable, "-c", "import clinical_worker.__main__"],
            cwd=shallow,
            capture_output=True,
            text=True,
            env={"PYTHONPATH": str(shallow), "PATH": ""},
        )
    finally:
        shutil.rmtree(shallow)
    assert loaded.returncode == 0, loaded.stderr[-300:]


def test_the_speech_model_hears_the_ayurvedic_terms_and_the_consultations_own_names() -> None:
    from clinical_worker.transcribe import hotwords

    assert (
        hotwords("Ayurveda, dosha", ["Jana Nováková", "dosha", ""])
        == "Ayurveda, dosha, Jana Nováková"
    )
    assert hotwords("", []) is None


def test_a_field_for_the_practitioner_alone_is_never_asked_of_the_model() -> None:
    # Owner, 24 Oct: private notes are the practitioner's; Watson never fills them in.
    from clinical_worker.form import Line, Template, parse, prompt, schema

    template = Template.model_validate(
        {
            "title": "T",
            "sections": [
                {"title": "Sleep", "fields": [{"key": "sleep", "label": "Sleep"}]},
                {
                    "title": "For you only",
                    "fields": [
                        {"key": "private_notes", "label": "Private notes", "mode": "manual"}
                    ],
                },
            ],
        }
    )
    lines = [Line(0, "patient", "I wake at three every night.")]
    system, user = prompt(template, lines, "en")
    assert "private_notes" not in user and "For you only" not in user
    assert list(schema(template)["properties"]) == ["sleep"]
    raw = '{"sleep": {"lines": [0], "answer": "Wakes at 3"}, "private_notes": {"lines": [0], "answer": "x"}}'
    answers = {a.key: a for a in parse(raw, template, lines)}
    assert answers["sleep"].text == "Wakes at 3"
    assert answers["private_notes"].text is None and answers["private_notes"].evidence == []


def test_typed_form_values_keep_explicit_states_choices_and_repeater_item_ids() -> None:
    from clinical_worker.form import Line, Template, parse, schema

    template = Template.model_validate(
        {
            "title": "Typed",
            "title_i18n": {"en": "Typed", "sk": "Typovaný"},
            "sections": [
                {
                    "key": "safety",
                    "title": "Safety / Bezpečnosť",
                    "title_i18n": {"en": "Safety", "sk": "Bezpečnosť"},
                    "fields": [
                        {
                            "key": "pregnancy",
                            "label": "Pregnancy / Tehotenstvo",
                            "value_type": "single_choice",
                            "options": [
                                {"key": "yes", "label": "Yes / Áno"},
                                {"key": "no", "label": "No / Nie"},
                            ],
                        },
                        {
                            "key": "medications",
                            "label": "Medication / Lieky",
                            "value_type": "repeater",
                            "item_fields": [
                                {"key": "name", "label": "Name / Názov", "value_type": "text"},
                                {"key": "dose", "label": "Dose / Dávka", "value_type": "text"},
                            ],
                        },
                        {
                            "key": "safety_confirmed",
                            "label": "Safety confirmed / Bezpečnosť potvrdená",
                            "mode": "manual",
                            "value_type": "attestation",
                        },
                    ],
                }
            ],
            "approval_gates": [
                {"key": "safety", "type": "attestation", "field_key": "safety_confirmed"}
            ],
        }
    )
    output_schema = schema(template)
    assert output_schema["properties"]["pregnancy"]["properties"]["value"]["anyOf"][0]["enum"] == [
        "yes",
        "no",
    ]
    assert "safety_confirmed" not in output_schema["properties"]

    raw = json.dumps(
        {
            "pregnancy": {"lines": [0], "state": "explicit_none", "value": None},
            "medications": {
                "lines": [1],
                "state": "known",
                "value": [{"name": "Medicine A", "dose": "5 mg"}],
            },
        }
    )
    answers = {
        answer.key: answer
        for answer in parse(
            raw,
            template,
            [Line(0, "patient", "I am not pregnant."), Line(1, "patient", "Medicine A, 5 mg.")],
        )
    }
    assert answers["pregnancy"].state == "explicit_none"
    assert answers["pregnancy"].value is None
    assert answers["pregnancy"].evidence == [0]
    [medication] = answers["medications"].value
    assert medication["values"] == {"name": "Medicine A", "dose": "5 mg"}
    assert len(medication["item_id"]) == 36
    assert answers["safety_confirmed"].state == "unanswered"


def test_typed_form_rejects_unknown_choice_keys_and_drops_their_evidence() -> None:
    from clinical_worker.form import Line, Template, parse

    template = Template.model_validate(
        {
            "title": "Typed",
            "sections": [
                {
                    "title": "Assessment",
                    "fields": [
                        {
                            "key": "agni",
                            "label": "Agni",
                            "value_type": "single_choice",
                            "options": [
                                {"key": "sama", "label": "Sama"},
                                {"key": "manda", "label": "Manda"},
                            ],
                        }
                    ],
                }
            ],
        }
    )
    [answer] = parse(
        '{"agni":{"lines":[0],"state":"known","value":"invented"}}',
        template,
        [Line(0, "patient", "Something")],
    )
    assert answer.state == "unanswered"
    assert answer.value is None
    assert answer.evidence == []


def test_typed_form_rejects_impossible_calendar_dates() -> None:
    from clinical_worker.form import Line, Template, parse, schema

    template = Template.model_validate(
        {
            "title": "Typed",
            "sections": [
                {
                    "title": "Patient",
                    "fields": [
                        {"key": "date_of_birth", "label": "Date of birth", "value_type": "date"}
                    ],
                }
            ],
        }
    )
    assert (
        schema(template)["properties"]["date_of_birth"]["properties"]["value"]["anyOf"][0]["format"]
        == "date"
    )
    [answer] = parse(
        '{"date_of_birth":{"lines":[0],"state":"known","value":"2026-99-99"}}',
        template,
        [Line(0, "patient", "An impossible date")],
    )
    assert answer.state == "unanswered"
    assert answer.value is None
    assert answer.evidence == []


def test_published_massage_template_matches_the_worker_schema() -> None:
    from clinical_worker.form import Template

    migration = (
        SCHEMA_DIR.parents[1]
        / "supabase/migrations/20261108103552_typed_bilingual_form_templates.sql"
    ).read_text()
    definition = migration.split("select $form$", 1)[1].split("$form$::jsonb", 1)[0]
    template = Template.model_validate_json(definition)

    assert len(template.sections) == 10
    assert len(template.fields) > 70
    assert {field.key for field in template.fields if field.value_type == "repeater"} == {
        "medications",
        "symptom_entries",
    }
    assert len(template.approval_gates) == 6
    assert template.approval_gates[-1].signer_role == "practitioner"
