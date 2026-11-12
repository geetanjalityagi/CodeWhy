from __future__ import annotations

import logging
import re
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app.stores.ingest_jobs import IngestJobStore

logger = logging.getLogger("codewhy.ingest_api")

router = APIRouter(tags=["ingest"])

# Single shared store for the lifetime of the process
_JOB_STORE = IngestJobStore(Path("data/ingest_jobs.sqlite3"))

_REPO_RE = re.compile(r"^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$")

# Extensions considered non-code (mirrors auto_targets.py)
_SKIP_EXT = {".md", ".txt", ".rst", ".lock", ".yaml", ".yml", ".toml"}
_SKIP_EXT_SOFT = {".json"}


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------


class IngestRequest(BaseModel):
    repo: str
    max_prs: int = 100


class IngestJobResponse(BaseModel):
    job_id: str
    repo: str
    status: str
    phase: str | None = None
    progress_pct: int = 0
    started_at: str
    finished_at: str | None = None
    error: str | None = None
    result_repo_id: str | None = None


# ---------------------------------------------------------------------------
# File-ranking helper (inlined from auto_targets logic)
# ---------------------------------------------------------------------------


def _rank_files(clone_path: Path, top_n: int) -> list[str]:
    """Return the top N most-changed code files from git history."""
    result = subprocess.run(
        ["git", "log", "--name-only", "--format="],
        cwd=str(clone_path),
        capture_output=True,
        text=True,
        check=True,
    )
    counter: Counter[str] = Counter()
    for line in result.stdout.splitlines():
        path = line.strip()
        if not path:
            continue
        suffix = Path(path).suffix.lower()
        if suffix in _SKIP_EXT:
            continue
        counter[path] += 1

    ranked = counter.most_common()
    primary = [p for p, _ in ranked if Path(p).suffix.lower() not in _SKIP_EXT_SOFT]
    if len(primary) >= top_n:
        return primary[:top_n]
    soft = [p for p, _ in ranked if Path(p).suffix.lower() in _SKIP_EXT_SOFT]
    return (primary + soft)[:top_n]


def _find_clone(clone_root: Path, owner: str, name: str) -> Path | None:
    for candidate in (
        clone_root / f"{owner}__{name}",
        clone_root / f"{owner}_{name}",
    ):
        if candidate.exists() and (candidate / ".git").exists():
            return candidate
    return None


# ---------------------------------------------------------------------------
# Background task
# ---------------------------------------------------------------------------


def _run_ingest_background(
    job_id: str,
    repo: str,
    max_prs: int,
    job_store: IngestJobStore,
) -> None:
    """Synchronous ingest pipeline — runs in FastAPI's thread-pool background."""
    finished_at_now = lambda: datetime.now(timezone.utc).isoformat()

    try:
        # ── Phase 1: clone ───────────────────────────────────────────────
        job_store.update_job(job_id, status="cloning", phase="Cloning repository from GitHub...", progress_pct=10)

        # Resolve paths relative to the process CWD (the project root when
        # launched via `uvicorn --app-dir backend`)
        clone_root = Path("data/clones")
        targets_dir = Path("targets")
        targets_dir.mkdir(parents=True, exist_ok=True)

        # Import ingest helpers (available inside the backend package)
        from app.config import settings as _settings
        from app.services.ingest.git_probe import clone_repository, parse_slug
        from app.services.ingest.targets import IngestTargets, load_targets
        from app.stores.sqlite_cache import SqliteCache
        from app.services.ingest.github_client import GitHubGraphQLClient
        from app.services.ingest.pipeline import run_ingest

        owner, name = parse_slug(repo)

        # Clone (or update) the repository
        clone_path = clone_repository(repo, clone_root, size_limit_mb=_settings.max_repo_size_mb)

        # ── Phase 2: auto-generate targets ──────────────────────────────
        job_store.update_job(job_id, status="fetching", phase="Analysing repository structure...", progress_pct=25)

        ranked_files = _rank_files(clone_path, top_n=20)
        if not ranked_files:
            raise RuntimeError("No code files found in git history — cannot build targets.")

        targets = IngestTargets(repo=repo, files=ranked_files, dirs=[], config_keys=[])

        # Persist targets file for debuggability
        import json
        targets_path = targets_dir / f"auto_{owner}__{name}.json"
        targets_path.write_text(
            json.dumps({"repo": repo, "files": ranked_files, "dirs": [], "config_keys": []}, indent=2),
            encoding="utf-8",
        )

        # ── Phase 3: fetch PRs & commits ────────────────────────────────
        job_store.update_job(job_id, status="fetching", phase="Fetching pull requests and commits...", progress_pct=40)

        cache_path = Path("data/ingest.sqlite3")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache = SqliteCache(cache_path)

        client = GitHubGraphQLClient(token=_settings.github_token)

        # ── Phase 4: run ingest pipeline ────────────────────────────────
        job_store.update_job(job_id, status="extracting", phase="Running ingest pipeline...", progress_pct=60)

        run_ingest(
            repo=repo,
            targets=targets,
            settings=_settings,
            cache=cache,
            clone_root=clone_root,
            client=client,
            max_prs=max_prs,
        )

        # ── Phase 5: done ───────────────────────────────────────────────
        result_repo_id = repo.replace("/", "-")
        job_store.update_job(
            job_id,
            status="done",
            phase="Ingestion complete.",
            progress_pct=100,
            finished_at=finished_at_now(),
            result_repo_id=result_repo_id,
        )
        logger.info("Ingest job %s done for %s → %s", job_id, repo, result_repo_id)

    except Exception as exc:  # noqa: BLE001
        logger.exception("Ingest job %s failed: %s", job_id, exc)
        job_store.update_job(
            job_id,
            status="failed",
            phase="Ingestion failed.",
            finished_at=finished_at_now(),
            error=str(exc),
        )


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/repositories/ingest",
    status_code=202,
    summary="Kick off async ingestion of a GitHub repository",
)
def start_ingest(
    request: IngestRequest,
    background_tasks: BackgroundTasks,
) -> JSONResponse:
    if not _REPO_RE.match(request.repo):
        raise HTTPException(
            status_code=422,
            detail="repo must match ^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$ (e.g. owner/name)",
        )
    job_id = _JOB_STORE.create_job(request.repo)
    background_tasks.add_task(
        _run_ingest_background,
        job_id,
        request.repo,
        request.max_prs,
        _JOB_STORE,
    )
    return JSONResponse(
        status_code=202,
        content={"job_id": job_id, "repo": request.repo, "status": "queued"},
    )


@router.get(
    "/repositories/ingest",
    summary="List recent ingest jobs",
)
def list_ingest_jobs(repo: str | None = None) -> dict:
    jobs = _JOB_STORE.list_jobs(repo=repo)
    return {"jobs": jobs}


@router.get(
    "/repositories/ingest/{job_id}",
    response_model=IngestJobResponse,
    summary="Poll the status of an ingest job",
)
def get_ingest_job(job_id: str) -> IngestJobResponse:
    job = _JOB_STORE.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Ingest job {job_id!r} not found")
    return IngestJobResponse(**job)
