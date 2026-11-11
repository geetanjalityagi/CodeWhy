from __future__ import annotations

from contextlib import asynccontextmanager
import os
from pathlib import Path
import sys
from typing import Optional

_BACKEND_DIR = str(Path(__file__).resolve().parent.parent)
if _BACKEND_DIR not in sys.path:
    sys.path.insert(0, _BACKEND_DIR)

if os.environ.get("VERCEL"):
    os.environ.setdefault("DATA_SOURCE", "graph")
    os.environ.setdefault("SQLITE_CACHE_PATH", "data/ingest.sqlite3")
    os.environ.setdefault("ALLOW_MOCK_PROVIDERS", "true")
    os.environ.setdefault("OFFLINE", "true")

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import routes_decisions, routes_health, routes_repositories
from app.api.deps import get_settings
from app.config import Settings
from app.services.data_source import NotFoundError
from app.services.errors import DataSourceError
from app.services.health import APP_VERSION

API_PREFIX = "/api/v1"
FRONTEND_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
]

CONTRACT_NOTES = """
Rules enforced by validators. An invalid response cannot be constructed, so a client may
treat these as guarantees rather than as conventions.

Answer shape:
- `full`, `partial` and every `refusal` except `ambiguous_entity` carry a non-empty `answer`.
- `reason_code` is `entity_not_found`, `ambiguous_entity`, `out_of_scope`, `no_decision_path`
  or `low_score` only with outcome `refusal`, and `no_verified_quote` only with outcome
  `partial`. It is null for `full`.
- `entity` is null when `reason_code` is `entity_not_found`, `ambiguous_entity` or
  `out_of_scope`.
- `ambiguous_entity` offers at least two candidates with distinct ids, and its `answer` is null.
- `full` requires at least one citation, at least one of kind SOURCE, and every citation's
  `decision_id` present in `decisions`. `no_verified_quote` forbids citations entirely.
- Every refusal lists at least one entry in `evidence_gaps`.

Confidence:
- `confidence.label` is always derived from `confidence.score`: 0.75 or more is HIGH,
  0.50 up to but not including 0.75 is MEDIUM, below 0.50 is LOW. A supplied label that
  disagrees with the score is rejected, not corrected.
- `full` requires HIGH. `partial` requires MEDIUM, or MEDIUM or LOW when `reason_code` is
  `no_verified_quote`. HIGH is never allowed on a partial.
- A scored refusal, meaning `no_decision_path` or `low_score`, requires MEDIUM or LOW. A
  refusal is never HIGH.
- `entity_not_found`, `ambiguous_entity` and `out_of_scope` are refusals that happen before
  scoring, so confidence is null for them. `no_decision_path` and `low_score` carry a score.
- If `signals.contradiction` is 1 the score is capped at 0.70. `contradiction` is a
  binary `Literal[0.0, 1.0]`, so no intermediate value can bypass the cap. The best score the
  section 7 formula can produce with contradiction 1 is 0.30 + 0.20 + 0.20 + 0.15 + 0.15
  minus 0.30, which is 0.70, so a response with contradiction 1 can never be `full`.

Graph:
- Node ids are unique, at most `MAX_GRAPH_NODES` are returned, and every edge endpoint is
  present in `nodes`. A truncated response sets `truncated` to true, so `truncated: false`
  guarantees the subgraph is complete.

Every response produced by the fixture data source carries `fixture: true`.
""".strip()


@asynccontextmanager
async def _lifespan(application: FastAPI):
    """Eagerly warm up the data source so the SQLite load happens at startup.

    get_data_source() populates the InMemoryGraphStore from SQLITE_CACHE_PATH
    the first time it is called, then deps.py caches it for the lifetime of
    the process. Calling it here ensures the load completes before the first
    real request arrives rather than blocking that request.
    """
    import logging
    from app.api import deps as _deps
    from app.services.data_source import get_data_source

    log = logging.getLogger(__name__)
    try:
        cfg: Settings = application.dependency_overrides.get(get_settings, get_settings)()
        if _deps._DATA_SOURCE is None:
            _deps._DATA_SOURCE = get_data_source(cfg)
            log.info("Data source initialised: %s", type(_deps._DATA_SOURCE).__name__)
        if not cfg.offline and cfg.data_source == "graph":
            try:
                from app.providers.embeddings import get_embedding_provider
                provider = get_embedding_provider(cfg=cfg)
                provider.embed_text("warmup")
                log.info("Embedding provider pre-warmed: %s", type(provider).__name__)
            except Exception as emb_exc:  # noqa: BLE001
                log.warning("Embedding pre-warm skipped or failed: %s", emb_exc)
    except Exception as exc:  # noqa: BLE001
        log.error("Startup data source init failed: %s", exc)
    yield


def create_app(config: Optional[Settings] = None) -> FastAPI:
    """Build the application.

    `config` overrides the process-wide settings for this application only. A test
    passes `Settings(_env_file=None)` here so the app under test cannot pick up the
    developer's `.env` and start talking to a real provider or a real database.
    """
    application = FastAPI(
        title="CodeWhy",
        version=APP_VERSION,
        description=(
            "Answers why code is the way it is, from reconstructed engineering history. "
            "Phase 0 serves synthetic fixtures only; every response is flagged `fixture: true`.\n\n"
            + CONTRACT_NOTES
        ),
        lifespan=_lifespan,
    )
    if config is not None:
        application.dependency_overrides[get_settings] = lambda: config
    application.add_middleware(
        CORSMiddleware,
        allow_origins=FRONTEND_ORIGINS,
        allow_origin_regex=r"^(http://(localhost|127\.0\.0\.1)(:\d+)?|https://.*\.onrender\.com|https://.*\.vercel\.app)$",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(routes_health.router, prefix=API_PREFIX)
    application.include_router(routes_repositories.router, prefix=API_PREFIX)
    application.include_router(routes_decisions.router, prefix=API_PREFIX)

    @application.exception_handler(NotFoundError)
    async def _not_found(request: Request, exc: NotFoundError) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(exc)})

    @application.exception_handler(DataSourceError)
    async def _data_source_error(request: Request, exc: DataSourceError) -> JSONResponse:
        # A data source that cannot answer is a server-side failure, not a statement
        # that the repository lacks the decision. Reporting it as a refusal would
        # tell the caller the history is missing when the request simply failed.
        return JSONResponse(status_code=503, content={"detail": str(exc)})

    return application


app = create_app()
