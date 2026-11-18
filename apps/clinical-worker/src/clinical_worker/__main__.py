"""`clinical-worker engine` runs the engine; `clinical-worker drain` runs it on demand (cloud);
`clinical-worker live` runs the live worker on demand (cloud), which reads only live pieces.

`fetch-model`, `fetch-form-model`, `fetch-ocr-model` and `export-schema` are setup commands."""

import json
import logging
import os
import sys
from pathlib import Path

from .config import Settings, load_settings
from .schema import SCHEMA_VERSION, Transcript

# The repository's packages/schemas, for `export-schema`, a development command. An engine installed
# elsewhere (on Modal, /root/clinical_worker) never uses it, and must still load.
SCHEMA_DIR = Path(*Path(__file__).resolve().parts[:-5]) / "packages" / "schemas"


def schema_json() -> str:
    return json.dumps(Transcript.model_json_schema(), indent=2) + "\n"


def _fetch_model(settings: Settings) -> None:
    # The only network access the engine makes outside Supabase, and only when run explicitly.
    from faster_whisper import download_model
    from faster_whisper.utils import _MODELS
    from huggingface_hub import HfApi

    download_model(settings.model, output_dir=str(settings.model_path))
    repository = _MODELS.get(settings.model, settings.model)
    revision = HfApi().model_info(repository).sha
    (settings.model_path / "revision.txt").write_text(f"{repository}@{revision}\n")
    print(f"model ready: {settings.model_path} ({repository}@{revision})")


def _fetch_form_model(settings: Settings) -> None:
    # The form model (decision 0005), fetched once; the engine reads it from disk only.
    from huggingface_hub import hf_hub_download

    settings.form_model_path.parent.mkdir(parents=True, exist_ok=True)
    hf_hub_download(
        settings.form_model_repository,
        settings.form_model_file,
        local_dir=str(settings.form_model_path.parent),
    )
    print(f"form model ready: {settings.form_model_path}")


def _fetch_ocr_model(settings: Settings) -> None:
    # The OCR models that read photos and scans, fetched once; the engine reads them from disk only.
    from .documents import Reader

    Reader(settings.ocr_model_dir).load()
    print(f"OCR models ready: {settings.ocr_model_dir}")


def _run_engine(settings: Settings, on_demand: bool = False, live: bool = False) -> None:
    from .engine import Engine

    os.environ.setdefault("HF_HUB_OFFLINE", "1")  # models come from disk only
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    for noisy in ("httpx", "httpcore", "hpack"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    if not (
        settings.engine_email
        and settings.engine_password.get_secret_value()
        and settings.supabase_publishable_key
    ):
        sys.exit(
            "Set WATSON_ENGINE_EMAIL, WATSON_ENGINE_PASSWORD, WATSON_SUPABASE_PUBLISHABLE_KEY."
        )
    engine = Engine(settings)
    engine.run_on_demand(live) if on_demand else engine.run_forever()


def main() -> None:
    settings = load_settings()
    command = sys.argv[1] if len(sys.argv) > 1 else "engine"
    if command == "engine":
        _run_engine(settings)
    elif command == "drain":
        _run_engine(settings, on_demand=True)
    elif command == "live":
        _run_engine(settings, on_demand=True, live=True)
    elif command == "fetch-model":
        _fetch_model(settings)
    elif command == "fetch-form-model":
        _fetch_form_model(settings)
    elif command == "fetch-ocr-model":
        _fetch_ocr_model(settings)
    elif command == "export-schema":
        SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
        for old in SCHEMA_DIR.glob("transcript-*.schema.json"):
            old.unlink()
        (SCHEMA_DIR / f"transcript-{SCHEMA_VERSION}.schema.json").write_text(schema_json())
    else:
        sys.exit(
            "usage: clinical-worker "
            "[engine|drain|live|fetch-model|fetch-form-model|fetch-ocr-model|export-schema]"
        )


if __name__ == "__main__":
    main()
