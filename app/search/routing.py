"""Community routing: pick which Leiden communities a query should be answered from.

v0.2 used the community of the single nearest document (``top1``). That is brittle at
community boundaries: one slightly-off anchor sends the whole query to the wrong place.

The voting strategies look at the top-R anchors and aggregate evidence per community:

* ``sum``     - total similarity mass (rewards communities with many good anchors)
* ``max``     - best single anchor (equivalent to top1 but reports alternatives)
* ``mean``    - average anchor similarity (favours tight but small communities)
* ``softmax`` - sum of exp(score / T); low T approaches ``max``, high T approaches count
"""

from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

from app.schemas import RoutingCandidate, RoutingOptions, RoutingResult, RoutingStrategy


@dataclass(frozen=True)
class Anchor:
    id: str
    score: float
    community_id: int | None


def route(anchors: list[Anchor], options: RoutingOptions) -> RoutingResult:
    assigned = [a for a in anchors if a.community_id is not None]
    first = anchors[0] if anchors else None
    base = dict(
        strategy=options.strategy,
        anchor_document_id=first.id if first else None,
        anchor_score=first.score if first else None,
    )
    if not assigned:
        return RoutingResult(selected=[], candidates=[], **base)

    grouped: dict[int, list[float]] = defaultdict(list)
    for anchor in assigned:
        grouped[anchor.community_id].append(anchor.score)  # type: ignore[index]

    strategy = options.strategy
    if strategy == RoutingStrategy.top1:
        winner = assigned[0].community_id
        support = {cid: (1.0 if cid == winner else 0.0) for cid in grouped}
    elif strategy == RoutingStrategy.sum:
        support = {cid: sum(scores) for cid, scores in grouped.items()}
    elif strategy == RoutingStrategy.max:
        support = {cid: max(scores) for cid, scores in grouped.items()}
    elif strategy == RoutingStrategy.mean:
        support = {cid: sum(scores) / len(scores) for cid, scores in grouped.items()}
    else:
        top = max(a.score for a in assigned)  # shift for numerical stability
        support = {
            cid: sum(math.exp((s - top) / options.temperature) for s in scores) for cid, scores in grouped.items()
        }

    positive_total = sum(max(v, 0.0) for v in support.values()) or 1.0
    candidates = sorted(
        (
            RoutingCandidate(
                community_id=cid,
                support=round(value, 6),
                share=round(max(value, 0.0) / positive_total, 4),
                anchors=len(grouped[cid]),
                best_score=round(max(grouped[cid]), 6),
            )
            for cid, value in support.items()
        ),
        key=lambda c: (-c.support, -c.best_score, c.community_id),
    )
    selected = [c.community_id for c in candidates if c.share >= options.min_share][: options.communities]
    if not selected:
        selected = [candidates[0].community_id]
    return RoutingResult(selected=selected, candidates=candidates, **base)
