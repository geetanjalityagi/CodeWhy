import pytest
from pathlib import Path
from tempfile import TemporaryDirectory
from fastapi.testclient import TestClient

from app.stores.ingest_jobs import IngestJobStore
from app.main import create_app
from app.config import Settings


def test_ingest_job_store_lifecycle():
    with TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / "test_jobs.sqlite3"
        store = IngestJobStore(db_path)

        # Create
        job_id = store.create_job("pallets/flask")
        assert job_id is not None
        job = store.get_job(job_id)
        assert job["repo"] == "pallets/flask"
        assert job["status"] == "queued"
        assert job["progress_pct"] == 0

        # Update
        store.update_job(job_id, status="cloning", phase="Cloning repo...", progress_pct=15)
        job = store.get_job(job_id)
        assert job["status"] == "cloning"
        assert job["phase"] == "Cloning repo..."
        assert job["progress_pct"] == 15

        # List
        jobs = store.list_jobs(repo="pallets/flask")
        assert len(jobs) == 1
        assert jobs[0]["job_id"] == job_id


def test_ingest_routes_validation_and_flow():
    cfg = Settings(data_source="fixture", offline=True)
    app = create_app(config=cfg)
    client = TestClient(app)

    # Invalid repo format
    resp = client.post("/api/v1/repositories/ingest", json={"repo": "invalid_format", "max_prs": 10})
    assert resp.status_code == 422

    # Valid repo
    resp = client.post("/api/v1/repositories/ingest", json={"repo": "pallets/flask", "max_prs": 10})
    assert resp.status_code == 202
    data = resp.json()
    assert "job_id" in data
    assert data["repo"] == "pallets/flask"
    job_id = data["job_id"]

    # Poll status
    resp = client.get(f"/api/v1/repositories/ingest/{job_id}")
    assert resp.status_code == 200
    status_data = resp.json()
    assert status_data["job_id"] == job_id
    assert status_data["repo"] == "pallets/flask"

