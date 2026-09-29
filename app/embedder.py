"""Sentence-Transformers wrapper.

Design notes
------------
* ``sentence_transformers`` (and therefore torch) is imported lazily so unit tests and
  tooling that never embed anything do not pay the multi-second import cost.
* Vectors are L2-normalised: cosine similarity == dot product, which matches the Qdrant
  COSINE collection and lets MMR use a plain matrix product.
* Query embeddings are memoised in a bounded LRU. Analysts repeat and refine queries a
  lot; a cache hit turns ~10-30 ms of CPU inference into a dict lookup.
* Asymmetric models (E5, BGE, GTE...) need different prefixes for queries and
  passages; both are configurable.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from typing import Protocol

import numpy as np

from app.config import Settings

log = logging.getLogger(__name__)


class EmbedderProtocol(Protocol):
    model_name: str
    dimension: int

    def encode_documents(self, texts: list[str]) -> np.ndarray: ...

    def encode_query(self, text: str) -> list[float]: ...


class _LRU:
    def __init__(self, capacity: int) -> None:
        self.capacity = capacity
        self._data: OrderedDict[str, list[float]] = OrderedDict()
        self._lock = threading.Lock()
        self.hits = 0
        self.misses = 0

    def get(self, key: str) -> list[float] | None:
        with self._lock:
            value = self._data.get(key)
            if value is None:
                self.misses += 1
                return None
            self._data.move_to_end(key)
            self.hits += 1
            return value

    def put(self, key: str, value: list[float]) -> None:
        if self.capacity <= 0:
            return
        with self._lock:
            self._data[key] = value
            self._data.move_to_end(key)
            while len(self._data) > self.capacity:
                self._data.popitem(last=False)


class Embedder:
    def __init__(self, settings: Settings) -> None:
        from sentence_transformers import SentenceTransformer  # lazy: heavy import

        self.settings = settings
        self.model_name = settings.embedding_model
        self.model = SentenceTransformer(settings.embedding_model, device=settings.embedding_device)
        dimension = self.model.get_sentence_embedding_dimension()
        if dimension is None:
            raise RuntimeError("Embedding model did not expose its output dimension")
        self.dimension = int(dimension)
        self._cache = _LRU(settings.query_cache_size)
        # Serialise inference: torch already parallelises one batch across cores;
        # concurrent batches would just thrash the CPU caches.
        self._lock = threading.Lock()

    def warmup(self) -> None:
        self.encode_documents(["warmup"])
        log.info("Embedding model %s ready (dim=%d)", self.model_name, self.dimension)

    def encode_documents(self, texts: list[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dimension), dtype=np.float32)
        prefix = self.settings.embedding_document_prefix
        inputs = [prefix + t for t in texts] if prefix else texts
        with self._lock:
            vectors = self.model.encode(
                inputs,
                batch_size=self.settings.embedding_batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
        return np.asarray(vectors, dtype=np.float32)

    def encode_query(self, text: str) -> list[float]:
        cached = self._cache.get(text)
        if cached is not None:
            return cached
        prefix = self.settings.embedding_query_prefix
        with self._lock:
            vector = self.model.encode(
                prefix + text,
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
        result = np.asarray(vector, dtype=np.float32).tolist()
        self._cache.put(text, result)
        return result

    def cache_stats(self) -> dict:
        return {"hits": self._cache.hits, "misses": self._cache.misses, "capacity": self._cache.capacity}
