from __future__ import annotations

from typing import TYPE_CHECKING, Final, Literal

from app.schemas.common import ConfidenceLabel

if TYPE_CHECKING:
    from app.schemas.confidence import ConfidenceScore

HIGH_THRESHOLD: Final[float] = 0.75
MEDIUM_THRESHOLD: Final[float] = 0.50
CONTRADICTION_SCORE_CAP: Final[float] = 0.70


def derive_label(score: float) -> ConfidenceLabel:
    """Derives HIGH, MEDIUM, or LOW label from numeric score."""
    if score >= HIGH_THRESHOLD:
        return ConfidenceLabel.HIGH
    if score >= MEDIUM_THRESHOLD:
        return ConfidenceLabel.MEDIUM
    return ConfidenceLabel.LOW


def calculate_confidence(
    directness: float = 1.0,
    provenance: float = 0.8,
    agreement: float = 0.4,
    relevance: float = 0.8,
    temporal_consistency: float = 1.0,
    contradiction: Literal[0.0, 1.0] = 0.0,
) -> ConfidenceScore:
    """Calculates evidence confidence score according to the Section 7 / Layer 6 formula:

    score = 0.30 * directness + 0.20 * provenance + 0.20 * agreement
          + 0.15 * relevance + 0.15 * temporal_consistency
          - 0.30 * contradiction

    Clipped to [0.0, 1.0]. If contradiction is 1.0, capped at 0.70.
    """
    raw_score = (
        0.30 * directness
        + 0.20 * provenance
        + 0.20 * agreement
        + 0.15 * relevance
        + 0.15 * temporal_consistency
        - 0.30 * contradiction
    )

    clipped = max(0.0, min(1.0, raw_score))
    if contradiction == 1.0:
        clipped = min(clipped, CONTRADICTION_SCORE_CAP)

    score_val = round(clipped, 4)
    label = derive_label(score_val)

    from app.schemas.confidence import ConfidenceScore, ConfidenceSignals

    signals = ConfidenceSignals(
        directness=round(directness, 2),
        provenance=round(provenance, 2),
        agreement=round(agreement, 2),
        relevance=round(relevance, 2),
        temporal_consistency=round(temporal_consistency, 2),
        contradiction=contradiction,
    )

    return ConfidenceScore(
        score=score_val,
        label=label,
        signals=signals,
    )
