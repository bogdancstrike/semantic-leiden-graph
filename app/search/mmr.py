"""Maximal Marginal Relevance (Carbonell & Goldstein, 1998).

    next = argmax_d  lambda * rel(d) - (1 - lambda) * max_{s in selected} sim(d, s)

``rel`` is min-max normalised so the trade-off means the same thing for cosine,
BM25 and fused scores. Vectors are L2-normalised, so ``sim`` is a dot product.
Complexity O(k * n * d) with an incrementally maintained max-similarity vector.
"""

from __future__ import annotations

import numpy as np


def mmr_select(relevance: np.ndarray, vectors: np.ndarray, k: int, lambda_: float) -> list[int]:
    n = len(relevance)
    if n == 0 or k <= 0:
        return []
    k = min(k, n)
    rel = relevance.astype(np.float64)
    spread = rel.max() - rel.min()
    rel = (rel - rel.min()) / spread if spread > 0 else np.ones_like(rel)

    selected: list[int] = []
    max_sim = np.full(n, -np.inf)
    available = np.ones(n, dtype=bool)
    for _ in range(k):
        redundancy = np.where(np.isfinite(max_sim), max_sim, 0.0)
        scores = lambda_ * rel - (1.0 - lambda_) * redundancy
        scores[~available] = -np.inf
        best = int(np.argmax(scores))
        selected.append(best)
        available[best] = False
        max_sim = np.maximum(max_sim, vectors @ vectors[best])
    return selected
