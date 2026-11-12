from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

from app.config import Settings
from app.fixtures.dataset import REPOSITORY_ID
from app.fixtures.source import FixtureDataSource
from app.main import create_app
from app.schemas.ask import AskResponse
from app.schemas.decisions import DecisionDetail, DecisionListResponse
from app.schemas.entities import EntityListResponse
from app.schemas.graph import GraphResponse
from app.schemas.repository import RepositoryListResponse, RepositoryResponse
from scripts.export_contract import CONTRACT_SPECS, build_payload

CONTRACT_DIR = Path(__file__).resolve().parents[3] / "contract"

EXPECTED_FILES = {
    "ask_full.json": AskResponse,
    "ask_partial.json": AskResponse,
    "ask_refusal.json": AskResponse,
    "ask_ambiguous.json": AskResponse,
    "ask_entity_not_found.json": AskResponse,
    "ask_out_of_scope.json": AskResponse,
    "graph.json": GraphResponse,
    "decision.json": DecisionDetail,
    "decisions.json": DecisionListResponse,
    "entities.json": EntityListResponse,
    "repository.json": RepositoryResponse,
    "repositories.json": RepositoryListResponse,
}

EXPECTED_PATHS = {
    "/api/v1/health",
    "/api/v1/health/dependencies",
    "/api/v1/repositories",
    "/api/v1/repositories/{repository_id}",
    "/api/v1/repositories/{repository_id}/entities",
    "/api/v1/repositories/{repository_id}/ask",
    "/api/v1/repositories/{repository_id}/graph",
    "/api/v1/repositories/{repository_id}/decisions",
    "/api/v1/repositories/ingest",
    "/api/v1/repositories/ingest/{job_id}",
    "/api/v1/decisions/{decision_id}",
}


def test_contract_directory_contains_exactly_the_expected_files() -> None:
    assert {path.name for path in CONTRACT_DIR.glob("*.json")} == set(EXPECTED_FILES) | {
        "openapi.json",
        "openapi.v1.json",
    }


@pytest.mark.parametrize(("name", "model"), sorted(EXPECTED_FILES.items()))
def test_every_contract_file_validates(name: str, model: type[BaseModel]) -> None:
    payload = json.loads((CONTRACT_DIR / name).read_text(encoding="utf-8"))
    validated = model.model_validate(payload)
    assert validated.model_dump(mode="json") == payload


@pytest.mark.parametrize("name", sorted(name for name in EXPECTED_FILES if name.startswith("ask_")))
def test_every_ask_contract_file_is_flagged_as_a_fixture(name: str) -> None:
    payload = json.loads((CONTRACT_DIR / name).read_text(encoding="utf-8"))
    assert payload["fixture"] is True


def test_openapi_contract_file_is_a_valid_document() -> None:
    document = json.loads((CONTRACT_DIR / "openapi.json").read_text(encoding="utf-8"))
    assert document["openapi"].startswith("3.")
    assert set(document["paths"]) == EXPECTED_PATHS
    assert "AskResponse" in document["components"]["schemas"]
    assert "confidence is null" in document["info"]["description"]


EXPECTED_ASK_OUTCOMES = {
    "ask_full.json": ("full", None),
    "ask_partial.json": ("partial", "no_verified_quote"),
    "ask_refusal.json": ("refusal", "no_decision_path"),
    "ask_ambiguous.json": ("refusal", "ambiguous_entity"),
    "ask_entity_not_found.json": ("refusal", "entity_not_found"),
    "ask_out_of_scope.json": ("refusal", "out_of_scope"),
}


@pytest.mark.parametrize(("name", "expected"), sorted(EXPECTED_ASK_OUTCOMES.items()))
def test_each_ask_contract_file_has_its_documented_outcome(name: str, expected: tuple[str, str | None]) -> None:
    payload = json.loads((CONTRACT_DIR / name).read_text(encoding="utf-8"))
    assert (payload["outcome"], payload["reason_code"]) == expected


def test_repository_contract_file_names_the_fixture_repository() -> None:
    payload = json.loads((CONTRACT_DIR / "repository.json").read_text(encoding="utf-8"))
    assert payload["id"] == REPOSITORY_ID


NOT_FOUND_PATHS = {
    "/api/v1/repositories/{repository_id}",
    "/api/v1/repositories/{repository_id}/entities",
    "/api/v1/repositories/{repository_id}/ask",
    "/api/v1/repositories/{repository_id}/graph",
    "/api/v1/repositories/{repository_id}/decisions",
    "/api/v1/decisions/{decision_id}",
}


def test_openapi_documents_the_404_body_on_every_route_that_can_raise_not_found() -> None:
    document = json.loads((CONTRACT_DIR / "openapi.json").read_text(encoding="utf-8"))
    assert "ErrorResponse" in document["components"]["schemas"]
    for path in sorted(NOT_FOUND_PATHS):
        operations = document["paths"][path]
        assert operations, path
        for method, operation in operations.items():
            responses = operation["responses"]
            assert "404" in responses, (path, method)
            schema = responses["404"]["content"]["application/json"]["schema"]
            assert schema["$ref"].endswith("/ErrorResponse"), (path, method)


def test_contract_files_match_a_fresh_generation() -> None:
    data_source = FixtureDataSource(Settings(_env_file=None))
    for name, (model, question) in sorted(CONTRACT_SPECS.items()):
        payload = build_payload(name, model, question, data_source)
        fresh = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
        committed = (CONTRACT_DIR / name).read_bytes().replace(b"\r\n", b"\n")
        assert committed == fresh, f"contract/{name} has drifted from the fixtures"
    document = json.loads(json.dumps(create_app().openapi(), sort_keys=True))
    fresh_openapi = (json.dumps(document, indent=2, sort_keys=True) + "\n").encode("utf-8")
    committed_openapi = (CONTRACT_DIR / "openapi.json").read_bytes().replace(b"\r\n", b"\n")
    assert committed_openapi == fresh_openapi, "contract/openapi.json has drifted from create_app()"
