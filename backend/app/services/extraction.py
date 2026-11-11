from __future__ import annotations

import re

import hashlib
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Final, Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field

EMAIL_SHAPED = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")

from app.prompts.extract_decision import build_extraction_prompt
from app.providers.llm_provider import BaseLLMProvider, LLMSchemaValidationError
from app.schemas.common import DecisionState
from app.services.quote_check import (
    FALLBACK_RATIONALE_UNKNOWN,
    MAX_QUOTE_CHARS,
    complete_quote,
    deepest_rung_over_sources,
    verify_quote_against_sources,
)

logger = logging.getLogger(__name__)

EXTRACTION_VERSION: Final[str] = "v1"

#: A change that explains a decision lives in the library itself, so only a path
#: under the package is kept as an affected entity.
LIBRARY_SOURCE_PREFIX: Final[str] = "src/urllib3/"

#: Vendored third-party code is not urllib3's own decision, so it is dropped even
#: though it sits under the package.
VENDORED_SOURCE_PREFIX: Final[str] = "src/urllib3/packages/"


def filter_affected_entities(
    changed_files: Sequence[str],
    config_keys: Sequence[str] = (),
) -> list[str]:
    """The entities that explain a decision, narrowed to what actually matters.

    A path is kept only when it is the library's own source: a test, a doc, a build
    file or vendored code records no decision, and keeping them turned a one-file
    change into a Governs edge to every file a large pull request happened to touch.
    A configuration key is kept as given — the caller supplies only keys read from a
    target file, so a key that merely appears in some diff is not attributed here.

    The result is sorted and de-duplicated, so the same set is stored however the
    payload happened to order it.
    """
    kept: set[str] = set()
    for name in changed_files:
        if not isinstance(name, str):
            continue
        candidate = name.strip()
        if candidate.startswith(LIBRARY_SOURCE_PREFIX) and not candidate.startswith(
            VENDORED_SOURCE_PREFIX
        ):
            kept.add(candidate)
    for key in config_keys:
        if isinstance(key, str) and key.strip():
            kept.add(key.strip())
    return sorted(kept)


# ---------------------------------------------------------------------------
# Decision Types
# ---------------------------------------------------------------------------

class DecisionType(StrEnum):
    ARCHITECTURE = "Architecture"
    RELIABILITY = "Reliability"
    PERFORMANCE = "Performance"
    SECURITY = "Security"
    COMPATIBILITY = "Compatibility"
    CONFIGURATION = "Configuration"
    MIGRATION = "Migration"
    TESTING = "Testing"
    OPERATIONAL_BEHAVIOR = "Operational behavior"
    OTHER = "Other"


# ---------------------------------------------------------------------------
# LLM Extraction Input & Output Schemas (Strict Pydantic Models)
# ---------------------------------------------------------------------------

class RawEvidenceItem(BaseModel):
    """Evidence quote produced by LLM."""
    model_config = ConfigDict(extra="ignore")

    quote: str = Field(description="Exact verbatim quote from the source text")
    claim: str = Field(default="", description="The specific claim or rationale supported by this quote")
    timestamp: Optional[str] = None


class RawCandidateDecision(BaseModel):
    """Candidate decision output schema produced by LLM."""
    model_config = ConfigDict(extra="ignore")

    summary: str = Field(description="Concise description of the engineering decision")
    decision_type: DecisionType = Field(default=DecisionType.OTHER)
    rationale: Optional[str] = Field(default=None, description="The reason or technical motivation for the decision")
    alternatives_considered: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)
    supporting_evidence: list[RawEvidenceItem] = Field(default_factory=list)
    opposing_evidence: list[RawEvidenceItem] = Field(default_factory=list)
    explicit_reversal_language: bool = Field(default=False)
    unknown_fields: list[str] = Field(default_factory=list)

class LLMExtractionPayload(BaseModel):
    """Top-level LLM completion schema.

    `extra="forbid"` is deliberate. With the default `extra="ignore"` a model that
    returns a flat object instead of `{"decisions": [...]}` has its fields silently
    discarded, `decisions` falls back to an empty list, and the run reports success
    with no decisions extracted. Refusing the reply turns that silent loss into a
    recorded failure.
    """

    model_config = ConfigDict(extra="forbid")

    no_decision: bool = Field(default=False, description="True if no deliberate engineering decision exists")
    #: Required, with no default. `{"decisions": []}` is how a model says there is
    #: nothing to extract; a reply that omits the key entirely has not followed the
    #: contract and is rejected rather than read as "no decision".
    decisions: list[RawCandidateDecision]


#: The JSON schema sent as `response_format` where the endpoint supports it, so the
#: model is constrained to the agreed shape instead of being asked politely in prose.
#: Generated from the model so the two cannot drift apart.
EXTRACTION_JSON_SCHEMA: Final[dict[str, Any]] = LLMExtractionPayload.model_json_schema()


class ExtractionSchemaRejected(RuntimeError):
    """Raised when a reply cannot be read as the agreed extraction shape.

    Carries the key names that arrived so the operator can see what the model
    actually sent. Values are never included: a rejected reply may quote
    untrusted repository text, and that text does not belong in a log line.
    """

    #: Recorded as the failure status so the run summary can count it separately
    #: from a transport failure or a genuine absence of decisions.
    status = "schema_rejected"

    def __init__(
        self,
        source_id: str,
        received_keys: Sequence[str],
        reason: str,
        finish_reason: str = "",
    ) -> None:
        self.source_id = source_id
        self.received_keys = list(received_keys)
        self.reason = reason
        self.finish_reason = finish_reason
        super().__init__(
            f"extraction for {source_id} was rejected: {reason}; "
            f"top-level keys received: {', '.join(self.received_keys) or '(none)'} "
            f"(values are not logged); finish_reason={finish_reason or 'unknown'}"
        )


# ---------------------------------------------------------------------------
# Code-Constructed Entity Models (Saved to SQLite and Graph)
# ---------------------------------------------------------------------------

@dataclass
class VerifiedEvidence:
    """Evidence record verified by code against source text."""

    id: str
    decision_id: str
    source_id: str
    source_type: str
    source_url: str
    quote: str
    author: Optional[str]
    timestamp: Optional[str]
    classification: Literal["explicit", "inferred"]
    claim: str
    quote_verified: bool


@dataclass
class ExtractedDecisionRecord:
    """Fully formed decision record enriched by code."""

    id: str
    source_id: str
    repo: str
    summary: str
    decision_type: str
    rationale: Optional[str]
    state: DecisionState
    alternatives_considered: list[str]
    constraints: list[str]
    affected_entities: list[str]
    source_references: list[str]
    decision_date: Optional[str]
    source_author: Optional[str]
    explicit_reversal_language: bool
    unknown_fields: list[str]
    evidence: list[VerifiedEvidence]
    quote_verified: bool
    #: True when the source never said why and the model supplied no rationale.
    #: The decision still stands as a record that something changed; it just cannot
    #: be presented as an explained choice.
    reason_unstated: bool
    extraction_version: str
    content_hash: str
    created_at: str


# ---------------------------------------------------------------------------
# ID Generation & Hashing Helpers
# ---------------------------------------------------------------------------

def make_decision_id(source_id: str, extraction_version: str, index: int) -> str:
    """Deterministic decision ID generated by code from source_id, version, and index."""
    raw = f"{source_id}:{extraction_version}:{index}".encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:16]
    return f"dec_{digest}"


def make_evidence_id(decision_id: str, index: int, quote: str) -> str:
    """Deterministic evidence ID generated by code."""
    raw = f"{decision_id}:{index}:{quote}".encode("utf-8")
    digest = hashlib.sha256(raw).hexdigest()[:16]
    return f"ev_{digest}"


def compute_content_hash(text: str) -> str:
    """Computes SHA-256 digest of source content."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Extraction Engine
# ---------------------------------------------------------------------------

def summarise_injection_flags(rows: list[dict[str, Any]]) -> dict[str, int]:
    """Count flagged sources for logging.

    Only counts are returned. The offending text never enters a log line, so an
    attack payload cannot smuggle itself into the audit trail.
    """
    return {
        "sources_total": len(rows),
        "sources_flagged": sum(1 for row in rows if row.get("injection_detected")),
    }


def attribution_for(author: Optional[str]) -> Optional[str]:
    """Normalise an author taken from the ingested record.

    Author identity is a factual claim, so it is read from the source payload and
    never from model output. A value that looks like an email address is dropped
    rather than stored or returned, because a login is the only identifier the
    system is prepared to hold.
    """
    if not author:
        return None
    cleaned = author.strip()
    if not cleaned or EMAIL_SHAPED.search(cleaned):
        return None
    return cleaned


def last_call_metadata() -> dict[str, Any]:
    """Model, mode, finish reason and tokens for the most recent extraction call.

    Kept on the module because the records themselves deliberately carry none of
    it: the caller needs it to record what produced a result, and putting it on the
    decision would make the model an attribute of the thing it inferred.
    """
    return dict(_LAST_CALL)


_LAST_CALL: dict[str, Any] = {}

#: Candidate quotes the most recent call rejected. Kept so the caller can persist
#: them: the reply that proposed them is gone once the call returns, and a dropped
#: quote is otherwise indistinguishable from one the model never offered.
_LAST_REJECTED: list[dict[str, Any]] = []


def last_rejected_quotes() -> list[dict[str, Any]]:
    """Candidate quotes dropped by the most recent extraction call (defensive copy)."""
    return [dict(item) for item in _LAST_REJECTED]


def extract_decisions_from_source(
    provider: BaseLLMProvider,
    source_id: str,
    source_type: str,
    source_url: str,
    repo: str,
    title: str,
    body: str,
    author: Optional[str] = None,
    created_at: Optional[str] = None,
    diff_or_patch: Optional[str] = None,
    comments: Sequence[dict[str, str]] = (),
    changed_files: Sequence[str] = (),
    config_keys: Sequence[str] = (),
    source_references: Sequence[str] = (),
    extraction_version: str = EXTRACTION_VERSION,
) -> list[ExtractedDecisionRecord]:
    """Runs LLM extraction and applies code-level validation and enrichment.

    Enforces the following rules from the specification:
    1. Delimited prompt structure (repository data is untrusted).
    2. Code produces decision_id, affected_entities, dates, author, and hashes.
    3. Verbatim quote verification: every candidate quote is checked against source text.
       Quotes that fail are dropped.
    4. If no verified quote remains for a decision, it is marked as
       "change recorded, rationale unknown" with quote_verified=False.
    """
    # 1. Compile source text for quote verification
    all_source_texts = [title or "", body or ""]
    for c in comments:
        if c.get("body"):
            all_source_texts.append(c["body"])
    if diff_or_patch:
        all_source_texts.append(diff_or_patch)

    full_text_corpus = "\n".join(all_source_texts)
    content_hash = compute_content_hash(full_text_corpus)
    _LAST_REJECTED.clear()

    # 2. Build prompt
    system_prompt, user_prompt = build_extraction_prompt(
        source_type=source_type,
        source_id=source_id,
        title=title,
        body=body,
        diff_or_patch=diff_or_patch,
        comments=comments,
    )

    # 3. Call LLM for structured output
    try:
        parsed, response = provider.complete_structured(
            schema=LLMExtractionPayload,
            prompt=user_prompt,
            system=system_prompt,
            response_json_schema=EXTRACTION_JSON_SCHEMA,
        )
        logger.info(
            "extraction for %s: response_format=%s finish_reason=%s",
            source_id,
            getattr(response, "response_format_mode", "unknown"),
            getattr(response, "finish_reason", "") or "unknown",
        )
        _LAST_CALL.clear()
        _LAST_CALL.update({
            "model": getattr(response, "model", "") or "",
            "response_format_mode": getattr(response, "response_format_mode", "") or "",
            "finish_reason": getattr(response, "finish_reason", "") or "",
            "tokens": int(getattr(response, "total_tokens", 0) or 0),
        })
    except LLMSchemaValidationError as exc:
        # The reply was text but not the agreed shape. That is a rejection, and the
        # operator has to see it; returning an empty list would report success.
        _LAST_CALL.clear()
        _LAST_CALL.update({
            "model": "",
            "response_format_mode": "",
            "finish_reason": exc.finish_reason,
            "tokens": 0,
        })
        raise ExtractionSchemaRejected(
            source_id=source_id,
            received_keys=exc.received_keys,
            reason=exc.reason,
            finish_reason=exc.finish_reason,
        ) from exc
    except Exception as exc:
        logger.error("LLM provider error extracting from %s: %s", source_id, exc)
        raise

    if parsed.no_decision or not parsed.decisions:
        return []

    # 4. Code enrichment and quote verification
    records: list[ExtractedDecisionRecord] = []
    affected_entities = filter_affected_entities(changed_files, config_keys)

    for idx, raw_dec in enumerate(parsed.decisions):
        dec_id = make_decision_id(source_id, extraction_version, idx)

        # Verify candidate supporting quotes
        verified_evidence: list[VerifiedEvidence] = []
        for ev_idx, raw_ev in enumerate(raw_dec.supporting_evidence):
            q_res = verify_quote_against_sources(raw_ev.quote, all_source_texts)
            if q_res.is_verified:
                # Complete the quote to the end of its sentence before storing it.
                # The model sometimes returns a prefix of the sentence it means, and
                # a prefix still verifies as a substring, so nothing downstream could
                # tell a whole quote from a cut one.
                completed = complete_quote(q_res.quote, "\n".join(all_source_texts))
                if completed.status == "quote_incomplete":
                    logger.debug(
                        "Dropped quote for %s: could not be completed to a whole sentence",
                        dec_id,
                    )
                    _LAST_REJECTED.append({
                        "decision_id": dec_id,
                        "decision_summary": raw_dec.summary.strip(),
                        "candidate": q_res.quote,
                        "failed_rung": "complete_quote",
                        "failure_reason": "could not be completed to a whole sentence",
                        "claim": raw_ev.claim,
                    })
                    continue
                if completed.status == "long_sentence":
                    logger.info(
                        "Quote for %s kept whole at %d characters, over the %d limit: %s",
                        dec_id, len(completed.quote), MAX_QUOTE_CHARS,
                        source_id,
                    )
                elif completed.status == "extended":
                    logger.debug(
                        "Completed a cut quote for %s: %r -> %r",
                        dec_id, q_res.quote, completed.quote,
                    )
                ev_id = make_evidence_id(dec_id, ev_idx, completed.quote)
                verified_evidence.append(
                    VerifiedEvidence(
                        id=ev_id,
                        decision_id=dec_id,
                        source_id=source_id,
                        source_type=source_type,
                        source_url=source_url,
                        quote=completed.quote,
                        author=attribution_for(author),
                        timestamp=raw_ev.timestamp or created_at,
                        classification="explicit",
                        claim=raw_ev.claim,
                        quote_verified=True,
                    )
                )
            else:
                logger.debug(
                    "Dropped unverified quote for %s: %r (%s)",
                    dec_id,
                    raw_ev.quote,
                    q_res.failure_reason,
                )
                _LAST_REJECTED.append({
                    "decision_id": dec_id,
                    "decision_summary": raw_dec.summary.strip(),
                    "candidate": raw_ev.quote,
                    "failed_rung": deepest_rung_over_sources(raw_ev.quote, all_source_texts),
                    "failure_reason": q_res.failure_reason or "",
                    "claim": raw_ev.claim,
                })

        has_verified_quotes = len(verified_evidence) > 0

        # Enforce rule: if no verified quote remains, summary is "change recorded, rationale unknown"
        if has_verified_quotes:
            summary = raw_dec.summary.strip()
            rationale = raw_dec.rationale.strip() if raw_dec.rationale else None
            quote_verified = True
        else:
            summary = FALLBACK_RATIONALE_UNKNOWN
            rationale = None
            quote_verified = False

        # Decided here rather than asked of the model: the flag is a statement about
        # what the record contains, not something inference should be able to assert
        # about itself.
        reason_unstated = not bool(rationale)

        records.append(
            ExtractedDecisionRecord(
                id=dec_id,
                source_id=source_id,
                repo=repo,
                summary=summary,
                decision_type=raw_dec.decision_type.value,
                rationale=rationale,
                state=DecisionState.ACTIVE,
                alternatives_considered=raw_dec.alternatives_considered,
                constraints=raw_dec.constraints,
                affected_entities=affected_entities,
                source_references=list(source_references),
                decision_date=created_at,
                source_author=attribution_for(author),
                explicit_reversal_language=raw_dec.explicit_reversal_language,
                unknown_fields=raw_dec.unknown_fields,
                evidence=verified_evidence,
                quote_verified=quote_verified,
                reason_unstated=reason_unstated,
                extraction_version=extraction_version,
                content_hash=content_hash,
                created_at=created_at or "",
            )
        )

    return records
