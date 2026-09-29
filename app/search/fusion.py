"""Rank fusion for hybrid retrieval.

Why client-side fusion?
Qdrant's Query API can fuse prefetches server-side, but our two lists come from
*different engines* (Qdrant cosine, Elasticsearch BM25). Fusing here also lets us
return per-engine rank/score for every hit, which the UI shows as "why is this here".

RRF (Cormack et al., 2009)
    score(d) = sum_i  w_i / (k + rank_i(d))
    Rank-only, scale-free, robust default. ``k`` dampens the head (60 is the classic value).

DBSF (distribution-based score fusion, as popularised by Qdrant)
    Each list is normalised with mean +/- 3 standard deviations to [0, 1], then
    weighted scores are summed. Uses score *magnitudes*, so a very confident BM25 hit
    can outrank a lukewarm semantic one -- useful for exact-name queries.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Ranked:
    id: str
    score: float


@dataclass
class Fused:
    id: str
    score: float
    components: dict[str, tuple[int, float]] = field(default_factory=dict)  # name -> (rank 1-based, raw score)


def _collect(lists: dict[str, list[Ranked]]) -> dict[str, Fused]:
    fused: dict[str, Fused] = {}
    for name, ranked in lists.items():
        for rank, item in enumerate(ranked, start=1):
            entry = fused.setdefault(item.id, Fused(id=item.id, score=0.0))
            entry.components[name] = (rank, item.score)
    return fused


def rrf(lists: dict[str, list[Ranked]], weights: dict[str, float] | None = None, k: int = 60) -> list[Fused]:
    weights = weights or {}
    fused = _collect(lists)
    for entry in fused.values():
        entry.score = sum(weights.get(name, 1.0) / (k + rank) for name, (rank, _) in entry.components.items())
    return sorted(fused.values(), key=lambda f: (-f.score, f.id))


def _dbsf_normalizer(scores: list[float]):
    if not scores:
        return lambda s: 0.0
    mean = sum(scores) / len(scores)
    variance = sum((s - mean) ** 2 for s in scores) / len(scores)
    std = math.sqrt(variance)
    if std == 0.0:
        return lambda s: 1.0
    low, high = mean - 3 * std, mean + 3 * std
    return lambda s: min(1.0, max(0.0, (s - low) / (high - low)))


def dbsf(lists: dict[str, list[Ranked]], weights: dict[str, float] | None = None) -> list[Fused]:
    weights = weights or {}
    normalizers = {name: _dbsf_normalizer([r.score for r in ranked]) for name, ranked in lists.items()}
    fused = _collect(lists)
    for entry in fused.values():
        entry.score = sum(
            weights.get(name, 1.0) * normalizers[name](raw) for name, (_, raw) in entry.components.items()
        )
    return sorted(fused.values(), key=lambda f: (-f.score, f.id))
