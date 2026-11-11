#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import logging
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

# Add backend directory to sys.path
REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "backend"))

from app.config import settings
from app.providers.llm_provider import TokenBudget, TokenBudgetExhaustedError, get_llm_provider
from app.services.extraction import (
    EXTRACTION_VERSION,
    ExtractionSchemaRejected,
    extract_decisions_from_source,
    last_call_metadata,
    last_rejected_quotes,
    summarise_injection_flags,
)
from app.stores.sqlite_cache import SqliteCache

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("codewhy.extract")

#: The pull request that added HTTP/2 TLS settings and the one that reverted it.
#: They are the clearest statement of intent in this history, so they are read first.
PINNED_PULL_REQUESTS: tuple[int, ...] = (3456, 3466)

#: Files whose changes explain the retry, connection and TLS behaviour.
TARGET_FILES: tuple[str, ...] = (
    "src/urllib3/connectionpool.py",
    "src/urllib3/connection.py",
    "src/urllib3/util/ssl_.py",
)

#: Default target description used by `--scope targets`, named after --repo.
REPO_SLUG = "urllib3__urllib3"


def _pull_request_number(source_id: str) -> Optional[int]:
    """The number in `pr:owner/name#123`, or None for any other kind of source."""
    if not source_id.startswith("pr:") or "#" not in source_id:
        return None
    tail = source_id.rsplit("#", 1)[1]
    return int(tail) if tail.isdigit() else None


def _target_file_match_count(payload: dict[str, Any]) -> int:
    """How many distinct target files an ingested payload lists.

    Matched on the suffix because the stored paths carry different roots: `git`
    recorded `src/urllib3/...` while GitHub reported `urllib3/...` for older files.
    The count is the relevance signal: a change touching two target files is more
    relevant to the retry/connection/TLS behaviour than one touching a single file.
    """
    files = payload.get("files") or []
    if not isinstance(files, list):
        return 0
    wanted = {name.rsplit("/", 1)[-1] for name in TARGET_FILES}
    matched = {
        name.rsplit("/", 1)[-1]
        for name in files
        if isinstance(name, str) and name.rsplit("/", 1)[-1] in wanted
    }
    return len(matched)


def _touches_target_files(payload: dict[str, Any]) -> bool:
    """Whether an ingested payload lists one of the target files."""
    return _target_file_match_count(payload) > 0


def changed_files_from_payload(payload: dict[str, Any]) -> list[str]:
    """The file paths an ingested payload records, in order and without blanks.

    These become the decision's affected entities. The stored payload is untrusted
    JSON, so anything that is not a non-empty string is dropped rather than passed
    through into the graph, and a path repeated in the payload is listed once.
    """
    files = payload.get("files")
    if not isinstance(files, list):
        return []
    seen: set[str] = set()
    result: list[str] = []
    for name in files:
        if isinstance(name, str) and name.strip() and name not in seen:
            seen.add(name)
            result.append(name)
    return result


def _pull_request_sort_number(source_id: str) -> int:
    """The numeric tie-break for a source: its pull request number, or a large value."""
    number = _pull_request_number(source_id)
    return number if number is not None else 1_000_000_000


def _sort_key(row: dict[str, Any]) -> tuple[int, int, int, str]:
    """Rank a candidate in the extraction queue.

    Order: pinned pull requests, then the target-file tier ranked by how many target
    files the change touches (its relevance), then everything else, then documentation.
    Within a tier, ties are broken by the pull request number, so the queue is ordered
    by intent rather than by whichever string id happens to sort first (`#2` before
    `#1000`). Documentation sorts last because a changelog restates a decision rather
    than making one, so it should never crowd out the record of the decision itself.
    """
    source_id = row["id"]
    number = _pull_request_number(source_id)

    if number is not None and number in PINNED_PULL_REQUESTS:
        return (0, PINNED_PULL_REQUESTS.index(number), 0, source_id)

    if row.get("kind") == "doc":
        return (3, 0, 0, source_id)

    try:
        payload = json.loads(row["payload"])
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    matched = _target_file_match_count(payload)
    if matched:
        return (1, -matched, _pull_request_sort_number(source_id), source_id)

    return (2, 0, _pull_request_sort_number(source_id), source_id)


def select_sources(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    """The first `limit` candidates in priority order."""
    return sorted(rows, key=_sort_key)[:limit]


def resolve_source_ids(args: argparse.Namespace, candidates: list[dict[str, Any]]) -> set[str]:
    """Map the `--sources` arguments onto known source ids.

    Both `pr:owner/name#3456` and a bare `3456` are accepted, because writing the
    full id for every run is tedious and the repository is already fixed by --repo.
    """
    by_number = {
        str(_pull_request_number(row["id"])): row["id"]
        for row in candidates
        if _pull_request_number(row["id"]) is not None
    }
    known = {row["id"] for row in candidates}
    resolved: set[str] = set()
    for value in args.sources or []:
        if value in known:
            resolved.add(value)
        elif value.isdigit() and value in by_number:
            resolved.add(by_number[value])
        else:
            logger.warning("--sources: %r is not a known source in this repository", value)
    return resolved


def select_target_scope(
    cache: SqliteCache,
    args: argparse.Namespace,
    candidates: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Only the sources that explain the target files.

    That is the pull requests that touched them, the revert chain that ties those
    pull requests together in either direction, and the documents that describe
    those same files. Documentation of the repository as a whole is left out: a
    changelog restates decisions but rarely explains one.
    """
    from app.services.ingest.targets import load_targets

    try:
        targets = load_targets(Path(args.targets)) if getattr(args, "targets", None) else None
    except Exception as exc:  # noqa: BLE001 - a bad target file must not crash the run
        logger.warning("--scope targets: could not read the target file: %s", exc)
        return candidates
    if targets is None:
        return candidates

    wanted_suffixes = {name.rsplit("/", 1)[-1] for name in targets.all_files()}

    def touches_targets(row: dict[str, Any]) -> bool:
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            return False
        files = payload.get("files") or []
        if not isinstance(files, list):
            return False
        return any(
            isinstance(name, str) and name.rsplit("/", 1)[-1] in wanted_suffixes
            for name in files
        )

    scoped = [row for row in candidates if row["kind"] == "pr" and touches_targets(row)]

    # The revert chain: a scoped pull request that reverts another scoped one, or is
    # reverted by one, is in scope even if it touched no target file itself. #3466
    # reverts #3456, which is how the two halves of a decision get read together.
    numbers = {
        n for n in (_pull_request_number(row["id"]) for row in scoped) if n is not None
    }
    reverted: dict[int, set[int]] = {}
    for row in candidates:
        if row["kind"] != "pr":
            continue
        number = _pull_request_number(row["id"])
        if number is None:
            continue
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            continue
        text = " ".join(
            str(payload.get(field) or "") for field in ("title", "body")
        )
        for other in numbers | _revert_targets(text):
            reverted.setdefault(other, set()).add(number)
            if other != number and number in numbers:
                reverted.setdefault(number, set()).add(other)

    chain_numbers = set(reverted)
    for row in candidates:
        number = _pull_request_number(row["id"]) if row["kind"] == "pr" else None
        if number is not None and number in chain_numbers:
            if row not in scoped:
                scoped.append(row)

    # Documents that name one of the target files, so a doc explaining the file is
    # read alongside the pull requests that changed it.
    for row in candidates:
        if row["kind"] != "doc":
            continue
        try:
            payload = json.loads(row["payload"])
        except (TypeError, ValueError):
            continue
        blob = json.dumps(payload).lower()
        if any(suffix.lower() in blob for suffix in wanted_suffixes):
            scoped.append(row)

    seen: set[str] = set()
    unique = []
    for row in scoped:
        if row["id"] not in seen:
            seen.add(row["id"])
            unique.append(row)
    return unique


def _revert_targets(text: str) -> set[int]:
    """Numbers a pull request reverts, from phrases like 'Reverts owner/name#12'."""
    import re

    return {int(n) for n in re.findall(r"reverts?\s+[^\s#]*#(\d+)", text, re.IGNORECASE)}


def source_url_for(source_id: str, repo: str, payload: dict[str, Any]) -> str:
    """The canonical web address of a source.

    A stored `url` is trusted when present. Otherwise the address is derived from
    the identifier, because a citation that points at the repository homepage
    instead of the pull request is not a citation anyone can check.
    """
    stored = payload.get("url")
    if isinstance(stored, str) and stored:
        return stored

    number = _pull_request_number(source_id)
    if number is not None:
        return f"https://github.com/{repo}/pull/{number}"
    if source_id.startswith("issue:") and "#" in source_id:
        issue = source_id.rsplit("#", 1)[1]
        if issue.isdigit():
            return f"https://github.com/{repo}/issues/{issue}"
    if source_id.startswith("commit:"):
        return f"https://github.com/{repo}/commit/{source_id.split(':', 1)[1]}"
    if source_id.startswith("doc:"):
        path = source_id.split(":", 2)[2] if source_id.count(":") >= 2 else ""
        return f"https://github.com/{repo}/blob/main/{path}"
    return f"https://github.com/{repo}"


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract engineering decisions and verified citations from SQLite cache."
    )
    parser.add_argument(
        "--repo",
        type=str,
        default="urllib3/urllib3",
        help="Repository identifier (owner/name)",
    )
    parser.add_argument(
        "--cache",
        type=Path,
        default=REPO_ROOT / "data" / "ingest.sqlite3",
        help="Path to the SQLite cache",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=50,
        help="Maximum candidate records to extract",
    )
    parser.add_argument(
        "--token-budget",
        dest="token_budget",
        type=int,
        default=None,
        help="Stop extraction once this many tokens have been used.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan extraction without invoking the LLM or updating the cache",
    )
    parser.add_argument(
        "--retry-failed",
        dest="retry_failed",
        action="store_true",
        help="Only retry the sources a previous run recorded as failed",
    )
    parser.add_argument(
        "--run-id",
        dest="run_id",
        type=str,
        default=uuid.uuid4().hex,
        help="Identifier recorded against this run's token usage",
    )
    parser.add_argument(
        "--sources",
        nargs="+",
        metavar="ID",
        default=None,
        help=(
            "Extract only these sources, given as pr:owner/name#123 or a bare "
            "pull request number. Overrides --limit."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-extract sources that already have a recorded result",
    )
    parser.add_argument(
        "--scope",
        choices=("targets", "all"),
        default="all",
        help=(
            "'targets' restricts the run to sources linked to the target files, "
            "their revert chain and the docs covering those files."
        ),
    )
    parser.add_argument(
        "--max-sources",
        dest="max_sources",
        type=int,
        default=None,
        help=(
            "Cap how many sources are extracted this run. Applied after ranking "
            "and after skipping finished or noisy sources, so the allowance goes "
            "to the highest-priority pending sources."
        ),
    )
    parser.add_argument(
        "--targets",
        type=Path,
        default=REPO_ROOT / "targets" / f"{REPO_SLUG}.json",
        help="Target file description used by --scope targets",
    )
    parser.add_argument(
        "--sample-review-file",
        type=Path,
        default=None,
        help=(
            "Path for a markdown audit file of the decisions just extracted. "
            "Opt-in: nothing is written unless this is given, so a run cannot leave "
            "an unverifiable file of extracted quotes in the tree."
        ),
    )
    parser.add_argument(
        "--rederive-entities",
        dest="rederive_entities",
        action="store_true",
        help=(
            "Rebuild stored decisions' affected_entities from the cached payloads and "
            "exit. No model is called and nothing else is changed."
        ),
    )
    return parser.parse_args(argv)


def persist_rejected_quotes(
    cache: SqliteCache,
    args: argparse.Namespace,
    source_id: str,
    source_url: str,
) -> int:
    """Store the quotes this source's extraction proposed but verification dropped.

    The reply is gone once the call returns, so the candidate, the rung it failed at
    and the decision it belonged to are written down while they are still known.
    """
    rejected = last_rejected_quotes()
    if not rejected:
        return 0
    now = datetime.now(timezone.utc).isoformat()
    rows = [
        {
            "run_id": args.run_id,
            "repo": args.repo,
            "source_id": source_id,
            "source_url": source_url,
            "created_at": now,
            **entry,
        }
        for entry in rejected
    ]
    return cache.put_rejected_quotes(rows)


def rederive_affected_entities(
    cache: SqliteCache,
    repo: str,
    targets_path: Path,
) -> tuple[int, int]:
    """Rebuild every stored decision's affected_entities from the cached payloads.

    No model is called and nothing but the entity list changes. The payload already
    in the cache is the same input the original extraction used, so re-deriving it
    through the current filter is deterministic. Only a configuration key read from a
    target file is added, which is why the targets file is read here. Returns the
    number of decisions whose list changed and the number considered.
    """
    from app.services.extraction import filter_affected_entities
    from app.services.ingest.targets import load_targets

    target_files: set[str] = set()
    try:
        target_files = set(load_targets(Path(targets_path)).files)
    except Exception as exc:  # noqa: BLE001 - a missing target file must not stop the run
        logger.warning("entity re-derivation: could not read the targets file: %s", exc)

    payloads = {
        row["id"]: row["payload"]
        for row in cache.fetch_raw_objects(repo, limit=10_000_000)
    }
    # A configuration key is attributed only when it was read from a target file.
    config_keys = [
        row["name"] for row in cache.config_keys_for(repo) if row["file_path"] in target_files
    ]

    decisions = cache.decisions_for_repo(repo)
    changed = 0
    for decision in decisions:
        raw = payloads.get(decision["source_id"])
        if raw is None:
            continue
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError):
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        entities = filter_affected_entities(changed_files_from_payload(payload), config_keys)
        try:
            previous = sorted(json.loads(decision["affected_entities"] or "[]"))
        except (TypeError, ValueError):
            previous = []
        if entities != previous:
            cache.update_affected_entities(decision["id"], entities)
            changed += 1
    return changed, len(decisions)


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    cache_path = args.cache
    if not cache_path.exists():
        logger.warning("Cache file %s does not exist; running in dry-run/preview mode.", cache_path)
        return 0

    # The cache is closed on every path out, including an exception, so the file is
    # never left locked for the next run.
    args.command_argv = list(argv if argv is not None else sys.argv[1:])
    with SqliteCache(cache_path) as cache:
        if args.rederive_entities:
            changed, total = rederive_affected_entities(cache, args.repo, args.targets)
            logger.info(
                "Re-derived affected entities: %d of %d decisions changed", changed, total
            )
            return 0
        return run_extraction(args, cache)


def run_extraction(args: argparse.Namespace, cache: SqliteCache) -> int:
    noisy_ids = cache.noisy_record_ids(args.repo)
    logger.info("Found %d noisy records to exclude from extraction", len(noisy_ids))

    budget = TokenBudget(
        args.token_budget if args.token_budget is not None else settings.max_llm_tokens_per_run
    )
    provider = get_llm_provider(budget=budget)

    # Every candidate is ranked first and only then cut to the limit, so --limit
    # selects the highest priority sources instead of whichever ids sort first.
    candidates = cache.fetch_raw_objects(args.repo, limit=10_000)
    failed_ids = cache.failed_source_ids(args.repo)
    # Completion is read from the recorded outcome, not from the presence of a
    # decision. A source that answered correctly with nothing to extract has no
    # decision row, and reading only decisions made it look untouched.
    already_done = cache.processed_source_ids(args.repo, EXTRACTION_VERSION)

    if args.scope == "targets":
        candidates = select_target_scope(cache, args, candidates)
        logger.info(
            "--scope targets: %d sources in scope "
            "(target files, their revert chain, and the docs covering them)",
            len(candidates),
        )

    if args.sources:
        candidates = [row for row in candidates if row["id"] in resolve_source_ids(args, candidates)]
        logger.info("--sources: %d sources selected", len(candidates))
    elif args.retry_failed:
        # Filtered before ranking and limiting, not after. Truncating to the top N
        # first meant a limit smaller than the failure count selected sources that
        # had already succeeded, and then discarded them, so `--retry-failed --limit 3`
        # found nothing to do however many failures were outstanding.
        candidates = [row for row in candidates if row["id"] in failed_ids]
        logger.info("--retry-failed: %d failed sources to choose from", len(candidates))

    # The limit counts sources that still need doing, so the finished ones are
    # removed first. Applying the limit before this filter spent the whole
    # allowance on sources already recorded as complete: with #3456 and #3466
    # answered and empty, a --limit 2 run selected those two, skipped both, and
    # did nothing at all.
    if not args.force:
        already_counted = len([row for row in candidates if row["id"] in already_done])
        candidates = [
            row for row in candidates
            if row["id"] not in already_done or row["id"] in failed_ids
        ]
        if already_counted:
            logger.info(
                "%d sources already have a recorded result and were not reconsidered",
                already_counted,
            )

    # Noise is dropped before the caps for the same reason finished sources are:
    # a noisy record has nothing to contribute, so letting it hold a --limit or
    # --max-sources slot starves a source that does.
    candidates = [row for row in candidates if row["id"] not in noisy_ids]
    considered = len(candidates)

    # --max-sources caps the ranked list, not the raw one. Truncating before the
    # ranking spent the allowance on whichever ids sorted first, so a second pass
    # over a repository selected the lowest-numbered sources, skipped the ones
    # already done, and extracted nothing at all.
    if args.max_sources is not None:
        candidates = select_sources(candidates, args.max_sources)

    rows = select_sources(candidates, args.limit)

    pending = rows

    # Counts only. The flagged text itself never reaches a log line.
    injection_counts = summarise_injection_flags(
        [{"source_id": row.get("id"), "injection_detected": row.get("injection_detected")}
         for row in pending]
    )
    logger.info(
        "prompt-injection scan: %d of %d sources flagged",
        injection_counts["sources_flagged"], injection_counts["sources_total"],
    )
    logger.info(
        "Selected %d of %d candidates in priority order for %s",
        len(pending), considered, args.repo,
    )

    extracted_decisions_count = 0
    extracted_evidence_count = 0
    #: A source answered correctly with an empty decisions list. The only legitimate
    #: reading of "nothing to extract".
    no_decision_count = 0
    #: Answered, but not in the agreed shape. Recorded, never silently dropped.
    schema_rejected_count = 0
    #: A decision was extracted but no supporting quote survived verification.
    unverified_quote_count = 0
    #: Candidate quotes dropped by verification, kept so a rejection is diagnosable.
    rejected_quote_count = 0
    failed_count = 0
    sample_records: list[dict[str, Any]] = []

    def record_source_outcome(
        source_id: str,
        status: str,
        tokens_before: int,
        *,
        decisions: int = 0,
        finish_reason: str = "",
        detail: str = "",
    ) -> None:
        """Write one row per source per run, whatever the outcome.

        Without this, a source that answered correctly with no decisions left no
        trace at all: its failure row was cleared and no decision row existed, so it
        looked untried and was neither retried nor skipped.
        """
        meta = last_call_metadata() if status != "failed" else {}
        cache.record_extraction_source(
            repo=args.repo,
            source_id=source_id,
            extraction_version=EXTRACTION_VERSION,
            status=status,
            run_id=args.run_id,
            model=str(meta.get("model") or settings.llm_model),
            response_format_mode=str(meta.get("response_format_mode") or ""),
            finish_reason=finish_reason or str(meta.get("finish_reason") or ""),
            decisions=decisions,
            tokens=int(meta.get("tokens") or 0) or (budget.total_tokens - tokens_before),
            detail=detail,
        )

    for position, row in enumerate(pending, start=1):
        source_id = row["id"]
        raw_payload = json.loads(row["payload"])
        source_type = row["kind"]
        source_url = source_url_for(source_id, args.repo, raw_payload)
        title = raw_payload.get("title", "")
        body = raw_payload.get("body", "")
        author = raw_payload.get("author", {}).get("login") if isinstance(raw_payload.get("author"), dict) else None
        created_at = raw_payload.get("createdAt") or raw_payload.get("created_at")
        changed_files = changed_files_from_payload(raw_payload)

        if args.dry_run:
            logger.info("[DRY-RUN] %d/%d %s (%s) %s", position, len(pending), source_id, title[:50], source_url)
            continue

        tokens_before = budget.total_tokens
        logger.info("%d/%d extracting %s", position, len(pending), source_id)

        try:
            records = extract_decisions_from_source(
                provider=provider,
                source_id=source_id,
                source_type=source_type,
                source_url=source_url,
                repo=args.repo,
                title=title,
                body=body,
                author=author,
                created_at=created_at,
                changed_files=changed_files,
                extraction_version=EXTRACTION_VERSION,
            )
        except TokenBudgetExhaustedError:
            # The budget is a deliberate stop, not a failure of this source.
            logger.warning(
                "Token budget exhausted (used=%d/%d). Halting extraction as PARTIAL.",
                budget.total_tokens,
                budget.max_tokens,
            )
            break
        except ExtractionSchemaRejected as rejected:
            # A reply that is valid JSON but not the agreed shape. Recorded rather
            # than dropped: silently returning nothing here is what made a good
            # extraction disappear from the real run.
            schema_rejected_count += 1
            logger.warning(
                "Source %s schema_rejected: %s; keys received: %s",
                source_id, rejected.reason, ", ".join(rejected.received_keys) or "(none)",
            )
            cache.record_extraction_failure(
                source_id=source_id,
                repo=args.repo,
                extraction_version=EXTRACTION_VERSION,
                final_status="schema_rejected",
                error=str(rejected),
            )
            record_source_outcome(source_id, "schema_rejected", tokens_before)
            continue
        except Exception as exc:  # noqa: BLE001 - one bad source must not end the run
            # Recorded so a rerun can retry exactly this source. The exception text
            # may quote the credential, so it is scrubbed before it is stored.
            failed_count += 1
            logger.warning("Source %s failed: %s", source_id, type(exc).__name__)
            cache.record_extraction_failure(
                source_id=source_id,
                repo=args.repo,
                extraction_version=EXTRACTION_VERSION,
                final_status=str(getattr(exc, "status_code", type(exc).__name__)),
                error=str(exc),
            )
            record_source_outcome(
                source_id, "failed", tokens_before,
                finish_reason=getattr(exc, "finish_reason", ""),
            )
            continue

        # The source completed, so it is no longer outstanding work.
        cache.clear_extraction_failure(source_id)

        if not records:
            no_decision_count += 1
        record_source_outcome(
            source_id,
            "ok" if records else "no_decision",
            tokens_before,
            decisions=len(records),
        )

        for dec in records:
            if not dec.quote_verified:
                unverified_quote_count += 1

        for dec in records:
            dec_row = {
                "id": dec.id,
                "source_id": dec.source_id,
                "repo": dec.repo,
                "summary": dec.summary,
                "decision_type": dec.decision_type,
                "rationale": dec.rationale,
                "state": dec.state.value if hasattr(dec.state, "value") else str(dec.state),
                "alternatives_considered": dec.alternatives_considered,
                "constraints": dec.constraints,
                "affected_entities": dec.affected_entities,
                "source_references": dec.source_references,
                "decision_date": dec.decision_date,
                "source_author": dec.source_author,
                "explicit_reversal_language": dec.explicit_reversal_language,
                "unknown_fields": dec.unknown_fields,
                "quote_verified": dec.quote_verified,
                "reason_unstated": dec.reason_unstated,
                "extraction_version": dec.extraction_version,
                "content_hash": dec.content_hash,
                "created_at": dec.created_at,
            }
            cache.put_decision(dec_row)
            extracted_decisions_count += 1

            for ev in dec.evidence:
                ev_row = {
                    "id": ev.id,
                    "decision_id": ev.decision_id,
                    "source_id": ev.source_id,
                    "source_type": ev.source_type,
                    "source_url": ev.source_url,
                    "quote": ev.quote,
                    "author": ev.author,
                    "timestamp": ev.timestamp,
                    "classification": ev.classification,
                    "claim": ev.claim,
                    "quote_verified": ev.quote_verified,
                }
                cache.put_evidence(ev_row)
                extracted_evidence_count += 1

                if len(sample_records) < 20:
                    sample_records.append({
                        "summary": dec.summary,
                        "quote": ev.quote,
                        "source_url": ev.source_url,
                        "verified": "yes" if ev.quote_verified else "no",
                    })

        rejected_quote_count += persist_rejected_quotes(cache, args, source_id, source_url)

    # A dry run makes no change at all: the linking pass writes the `links` table and
    # must be stopped before it runs, not after.
    if args.dry_run:
        return 0

    # ------------------------------------------------------------------
    # Linking pass. Without this the links table stayed empty, so the graph
    # build had nothing to replay and every REVERTS/PART_OF/REFERENCES edge was
    # silently lost.
    # ------------------------------------------------------------------
    links_written = build_links(cache, args.repo, rows)
    logger.info("Linking finished: %d links written.", links_written)

    # Tokens spent by earlier runs are part of the true total, so they are read
    # back rather than implied by this run alone.
    tokens_this_run = budget.total_tokens
    tokens_before = cache.total_extraction_tokens()
    cache.record_extraction_run(
        repo=args.repo,
        run_id=args.run_id,
        tokens=tokens_this_run,
        decisions=extracted_decisions_count,
        evidence=extracted_evidence_count,
        failures=failed_count,
    )
    logger.info(
        "Extraction finished: %d decisions, %d verified evidence quotes written.",
        extracted_decisions_count,
        extracted_evidence_count,
    )
    logger.info("Tokens used this run: %d", tokens_this_run)
    logger.info("Tokens used in total, including earlier runs: %d", tokens_before + tokens_this_run)
    logger.info(
        "Failures this run: %d of %d attempted sources", failed_count, len(pending)
    )
    # One line per outcome so a run cannot look productive by accident. Each source
    # lands in exactly one of these buckets.
    logger.info(
        "Run summary: decisions=%d no_decision=%d schema_rejected=%d "
        "unverified_quote=%d failed=%d (of %d attempted)",
        extracted_decisions_count,
        no_decision_count,
        schema_rejected_count,
        unverified_quote_count,
        failed_count,
        len(pending),
    )
    logger.info("Rejected quote candidates recorded: %d", rejected_quote_count)
    if schema_rejected_count or failed_count:
        for row in cache.extraction_failures(args.repo):
            logger.info(
                "  rejected or failed source %s: status=%s attempts=%s",
                row["source_id"], row["final_status"], row["attempts"],
            )

    if sample_records and args.sample_review_file:
        generate_sample_review_file(
            args.sample_review_file,
            sample_records,
            command=" ".join(["python", "scripts/extract.py", *(args.command_argv or [])]),
            generated_at=datetime.now(timezone.utc).isoformat(),
        )

    # Nothing usable came back, so the exit code has to say so. A partial run still
    # exits 0 because its work is stored and a rerun continues from it.
    attempted = len(pending)
    unusable = failed_count + schema_rejected_count
    if attempted and unusable == attempted:
        logger.error(
            "No source produced a usable result: %d rejected, %d failed.",
            schema_rejected_count, failed_count,
        )
        return 1
    return 0


def build_links(cache: SqliteCache, repo: str, source_rows: list[Any]) -> int:
    """Run every deterministic link extractor over the cached history.

    All of these are pure functions over already-ingested text, so they need no
    model call and are safe to re-run: put_links upserts on a stable id.
    """
    from app.services import linking

    collected: list[Any] = []

    for commit in cache.iter_commits(repo):
        message = commit.get("message") or ""
        collected.extend(linking.extract_revert_links(commit["sha"], message, repo))
        collected.extend(
            linking.extract_commit_pr_links(
                commit["sha"],
                commit.get("subject") or "",
                message,
                repo,
                explicit_prs=json.loads(commit.get("pull_requests") or "[]"),
            )
        )
        for number in json.loads(commit.get("closing") or "[]"):
            collected.extend(
                linking.extract_issue_links(
                    source_id=f"pr:{repo}#{number}", source_type="pull_request",
                    text=f"#{number}", repo=repo,
                )
            )

    for doc in cache.iter_documents(repo):
        path = doc.get("path") or ""
        collected.extend(linking.extract_document_supersession(path, doc.get("content") or "", repo))

    file_paths = sorted({commit.get("path") for commit in cache.iter_commit_files(repo)
                         if commit.get("path")})
    collected.extend(linking.extract_containment_links(repo, file_paths))

    rows = [record.as_row() for record in collected]
    return cache.put_links(rows) if rows else 0


def generate_sample_review_file(
    output_path: Path,
    samples: list[dict[str, Any]],
    command: str = "",
    generated_at: str = "",
) -> None:
    """Write the audit file.

    The header names the command that produced it. A file of extracted decisions
    with no provenance is indistinguishable from one that was written by hand, and
    this one is meant to be checked against real pull requests.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# Extracted Decisions Sample (Manual Verification)",
        "",
        f"Generated by: `{command or 'unknown'}`",
        f"Generated at: {generated_at or 'unknown'}",
        "",
        "This file contains extracted decisions and citations for manual audit.",
        "Every quote below was checked against the source text by code, and every "
        "row is still expected to be checked by a person against the linked page.",
        "",
        "| # | Decision Summary | Verbatim Quote | Source URL | Verified? |",
        "|---|---|---|---|---|",
    ]
    for idx, s in enumerate(samples, start=1):
        clean_quote = s["quote"].replace("\n", " ").replace("|", "\\|")[:80]
        clean_sum = s["summary"].replace("\n", " ").replace("|", "\\|")[:60]
        lines.append(f"| {idx} | {clean_sum} | `{clean_quote}` | {s['source_url']} | {s['verified']} |")
    lines.append("")
    output_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info("Wrote %d sample review decisions to %s", len(samples), output_path)


if __name__ == "__main__":
    sys.exit(main())
