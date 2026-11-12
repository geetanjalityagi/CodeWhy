from __future__ import annotations

import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

_DEFAULT_DB = Path("data/ingest_jobs.sqlite3")

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT,
    progress_pct INTEGER DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    result_repo_id TEXT
);
"""


class IngestJobStore:
    """Thread-safe SQLite store for async ingest job tracking."""

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def __init__(self, db_path: Path = _DEFAULT_DB) -> None:
        self._db_path = db_path
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        with self._connection() as conn:
            conn.executescript(_CREATE_SQL)

    def create_job(self, repo: str) -> str:
        """Insert a new job row and return the job_id."""
        job_id = uuid.uuid4().hex
        started_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            with self._connection() as conn:
                conn.execute(
                    """
                    INSERT INTO ingest_jobs
                        (job_id, repo, status, phase, progress_pct, started_at)
                    VALUES (?, ?, 'queued', NULL, 0, ?)
                    """,
                    (job_id, repo, started_at),
                )
        return job_id

    def update_job(self, job_id: str, **fields: Any) -> None:
        """Update any subset of columns on the given job row."""
        if not fields:
            return
        allowed = {
            "status", "phase", "progress_pct", "finished_at", "error", "result_repo_id"
        }
        bad = set(fields) - allowed
        if bad:
            raise ValueError(f"Unknown ingest_jobs columns: {bad}")
        set_clause = ", ".join(f"{col} = ?" for col in fields)
        values = list(fields.values()) + [job_id]
        with self._lock:
            with self._connection() as conn:
                conn.execute(
                    f"UPDATE ingest_jobs SET {set_clause} WHERE job_id = ?",  # noqa: S608
                    values,
                )

    def get_job(self, job_id: str) -> dict | None:
        """Return all columns for the job as a dict, or None if not found."""
        with self._lock:
            with self._connection() as conn:
                row = conn.execute(
                    "SELECT * FROM ingest_jobs WHERE job_id = ?", (job_id,)
                ).fetchone()
        return dict(row) if row else None

    def list_jobs(self, repo: str | None = None) -> list[dict]:
        """Return all jobs, optionally filtered by repo, newest first."""
        with self._lock:
            with self._connection() as conn:
                if repo is not None:
                    rows = conn.execute(
                        "SELECT * FROM ingest_jobs WHERE repo = ? ORDER BY started_at DESC",
                        (repo,),
                    ).fetchall()
                else:
                    rows = conn.execute(
                        "SELECT * FROM ingest_jobs ORDER BY started_at DESC"
                    ).fetchall()
        return [dict(r) for r in rows]
