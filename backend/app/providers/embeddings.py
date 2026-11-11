from __future__ import annotations

import hashlib
import math
import re
import threading
from abc import ABC, abstractmethod
from typing import Any, Final, Optional, Sequence

_MODEL_CACHE: dict[str, Any] = {}
_MODEL_LOCK = threading.Lock()

from app.config import Settings, settings

EMBEDDING_DIMENSIONS: Final[int] = 384
#: Must agree with the vector index declared in app.graph.schema.
INDEX_VECTOR_DIMENSIONS: Final[int] = 384


def compute_cosine_similarity(v1: Sequence[float], v2: Sequence[float]) -> float:
    """Computes cosine similarity between two numeric vectors."""
    if len(v1) != len(v2) or not v1:
        return 0.0
    dot = sum(a * b for a, b in zip(v1, v2))
    norm1 = math.sqrt(sum(a * a for a in v1))
    norm2 = math.sqrt(sum(b * b for b in v2))
    if norm1 == 0.0 or norm2 == 0.0:
        return 0.0
    return max(-1.0, min(1.0, dot / (norm1 * norm2)))


class BaseEmbeddingProvider(ABC):
    """Abstract interface for generating text embeddings."""

    def __init__(self, dimensions: int = EMBEDDING_DIMENSIONS) -> None:
        self.dimensions = dimensions

    @abstractmethod
    def embed_text(self, text: str) -> list[float]:
        """Embed a single text string into a float vector of length `dimensions`."""
        ...

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        """Embed a list of text strings."""
        return [self.embed_text(t) for t in texts]

    def similarity(self, text1: str, text2: str) -> float:
        """Helper computing cosine similarity between two strings."""
        v1 = self.embed_text(text1)
        v2 = self.embed_text(text2)
        return compute_cosine_similarity(v1, v2)


class DeterministicFallbackEmbeddingProvider(BaseEmbeddingProvider):
    """Generates deterministic 384-dimensional unit vectors using hashing.

    Guarantees that identical strings yield identical vectors,
    similar token overlap yields higher cosine similarity,
    and runs completely offline without downloading 100MB model weights.
    """

    def embed_text(self, text: str) -> list[float]:
        clean = text.strip().lower()
        if not clean:
            return [0.0] * self.dimensions

        tokens = re.findall(r"\w+", clean)
        if not tokens:
            return [0.0] * self.dimensions

        vector = [0.0] * self.dimensions

        for tok in tokens:
            # Hash token into 4 dimension indices with alternating signs
            h = hashlib.sha256(tok.encode("utf-8")).digest()
            for i in range(0, 32, 4):
                idx = int.from_bytes(h[i : i + 2], "big") % self.dimensions
                sign = 1.0 if (h[i + 2] % 2 == 0) else -1.0
                weight = float(h[i + 3] + 1) / 256.0
                vector[idx] += sign * weight

        # Normalize to unit length
        norm = math.sqrt(sum(x * x for x in vector))
        if norm > 0:
            vector = [x / norm for x in vector]
        return vector


class SentenceTransformersProvider(BaseEmbeddingProvider):
    """Wraps sentence_transformers 'all-MiniLM-L6-v2' when installed."""

    def __init__(self, model_name: str = "all-MiniLM-L6-v2") -> None:
        super().__init__(dimensions=EMBEDDING_DIMENSIONS)
        self.model_name = model_name

    def _get_model(self):
        if self.model_name not in _MODEL_CACHE:
            with _MODEL_LOCK:
                if self.model_name not in _MODEL_CACHE:
                    from sentence_transformers import SentenceTransformer  # type: ignore

                    _MODEL_CACHE[self.model_name] = SentenceTransformer(self.model_name)
        return _MODEL_CACHE[self.model_name]

    def embed_text(self, text: str) -> list[float]:
        model = self._get_model()
        vec = model.encode(text, convert_to_numpy=True).tolist()
        return vec

    def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._get_model()
        vecs = model.encode(list(texts), convert_to_numpy=True).tolist()
        return vecs


def get_embedding_provider(
    provider_name: Optional[str] = None,
    dimensions: Optional[int] = None,
    cfg: Optional[Settings] = None,
) -> BaseEmbeddingProvider:
    """Factory selecting the embedding provider.

    `dimensions` comes from configuration so a change actually takes effect. It must
    agree with the vector index in app.graph.schema, which is declared at 384; a
    mismatch is rejected here rather than surfacing as a write failure later.
    """
    config = cfg or settings
    size = dimensions or config.embedding_dimensions or EMBEDDING_DIMENSIONS
    if size != INDEX_VECTOR_DIMENSIONS:
        raise ValueError(
            f"embedding dimension {size} does not match the graph vector index "
            f"({INDEX_VECTOR_DIMENSIONS}); change both together or neither"
        )

    name = (provider_name or config.embedding_provider or "local").lower()

    if name in ("local", "all-minilm-l6-v2"):
        # Offline short-circuits before any import so nothing is downloaded. The
        # deterministic provider is not semantic, so callers must be able to see
        # that; they can, because the class is named for what it is.
        if config.offline:
            return DeterministicFallbackEmbeddingProvider(dimensions=size)
        try:
            import sentence_transformers  # noqa: F401

            return SentenceTransformersProvider()
        except ImportError:
            # Fall back to deterministic hashing provider
            return DeterministicFallbackEmbeddingProvider(dimensions=size)

    return DeterministicFallbackEmbeddingProvider(dimensions=size)
