"""Watson's engine on Modal (owner's decision of 16 Oct 2026, decision 0009).

The same engine as on the laptop, with the laptop's exact libraries (uv.lock), on Modal's
processors, and only while work waits. After Synculariti's modal/modal_llm.py and its cost safety.

- `wake`: the address the database knocks on, with a shared secret, when a transcript, a document
  or a form is queued (migration 20261016150000). It starts `drain`; for a live piece of a call in
  progress it starts `live` (migration 20261118100000).
- `drain`: `clinical-worker drain`: works until nothing has come for a while, then stops. The
  database refuses the stop while work waits, so nothing is left behind.
- `live`: `clinical-worker live`: reads only live pieces, so the words on the doctor's screen never
  wait behind a transcript, a document or a form; it stops a minute after the last piece.
- `fetch_models`: fills the models volume once, from Hugging Face. The engine reads models from
  disk only.

Cost safety, as Synculariti's: the database's monthly allowance of running time, Modal's workspace
budget, and Modal's credit. One container of each worker at a time, an hour at most.

Set up and deploy with scripts/configure-cloud-engine.sh (Modal profile `watson`, never
Synculariti's).
"""

import modal

app = modal.App("watson-engine")

# Where the engine's settings look for models (Settings.home is ~/.local/share/watson); its work
# folder next to it stays on the container's own disk.
MODELS = "/root/.local/share/watson/models"
models = modal.Volume.from_name("watson-models", create_if_missing=True)

# WATSON_SUPABASE_URL, WATSON_SUPABASE_PUBLISHABLE_KEY, WATSON_ENGINE_EMAIL, WATSON_ENGINE_PASSWORD:
# the cloud engine's own account, which may claim jobs and nothing else.
engine_secret = modal.Secret.from_name("watson-engine")
# WAKE_SECRET, the same as the one in the database's Vault.
wake_secret = modal.Secret.from_name("watson-engine-wake")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_sync(uv_version="0.10.12")
    # Four physical cores are eight threads; the speech library would otherwise count the host's.
    .env({"WATSON_CPU_THREADS": "8"})
    .add_local_python_source("clinical_worker")
)


def _clinical_worker(command: str) -> None:
    import sys

    from clinical_worker.__main__ import main

    sys.argv = ["clinical-worker", command]
    main()


# Europe, near Watson's database in Frankfurt (owner, 29 Oct 2026: "mostly for speed"):
# recordings and documents travel less. The broad "eu" region costs 1.15x Modal's base price
# (one country: 1.75x) and starts containers sooner. Volumes are distributed: models follow.
REGION = "eu"


@app.function(
    image=image,
    region=REGION,
    cpu=4.0,
    memory=8192,
    timeout=60 * 60,
    max_containers=1,
    retries=2,  # a container that died is started again; it claims the job once its lease lapses
    volumes={MODELS: models},
    secrets=[engine_secret],
)
def drain() -> None:
    _clinical_worker("drain")


# The speech model only: no form model, no OCR, so half the memory.
@app.function(
    image=image,
    region=REGION,
    cpu=4.0,
    memory=4096,
    timeout=60 * 60,
    max_containers=1,
    retries=2,
    volumes={MODELS: models},
    secrets=[engine_secret],
)
def live() -> None:
    _clinical_worker("live")


@app.function(
    image=image, region=REGION, timeout=30 * 60, volumes={MODELS: models}, secrets=[engine_secret]
)
def fetch_models() -> None:
    for command in ("fetch-model", "fetch-form-model", "fetch-ocr-model"):
        _clinical_worker(command)
    models.commit()


web_image = modal.Image.debian_slim(python_version="3.12").pip_install("fastapi[standard]==0.143.3")


@app.function(image=web_image, secrets=[wake_secret], scaledown_window=2)
@modal.asgi_app()
def wake():  # type: ignore[no-untyped-def]
    import hmac
    import os

    from fastapi import Body, FastAPI, Header, HTTPException

    web = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @web.post("/")
    def knock(
        authorization: str = Header(default=""),
        live_piece: bool = Body(False, embed=True, alias="live"),
    ) -> dict[str, bool]:
        # An open door to the engine would be somebody else's free computing.
        expected = f"Bearer {os.environ['WAKE_SECRET']}".encode()
        if not hmac.compare_digest(authorization.encode(), expected):
            raise HTTPException(status_code=403)
        (live if live_piece else drain).spawn()
        return {"ok": True}

    return web
