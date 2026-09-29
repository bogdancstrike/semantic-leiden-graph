"""From Leiden's raw partition to the communities the product shows.

Leiden partitions *every* node, so a document with no similarity edge -- common with
a strict ``min_similarity`` -- comes back as a community of one. A group of one is
not a topic: at a 0.75 threshold that produced 2,131 "communities" with a median
size of 1. So only groups of at least ``min_size`` (never less than 2) documents
become communities; the rest are recorded as clustered but in no community.

Surviving communities are renumbered 0..N-1, largest first. Leiden's own ids are
arbitrary integers that change every run anyway; compact ids read better (C0 is the
biggest topic) and never exceed the number of communities.
"""

from __future__ import annotations

from collections import Counter

MIN_COMMUNITY_SIZE = 2


def compact_communities(
    raw: list[tuple[str, int]], min_size: int = MIN_COMMUNITY_SIZE
) -> tuple[list[tuple[str, int | None]], dict]:
    """Drop groups smaller than ``min_size`` and renumber the rest by size.

    Returns ``(assignments, summary)``: one ``(doc_id, community_id | None)`` per input
    row, in input order, and counts for the clustering-run record.
    """
    min_size = max(MIN_COMMUNITY_SIZE, int(min_size))
    sizes = Counter(community for _, community in raw)
    # Largest first; the raw id breaks ties so the numbering is deterministic.
    kept = sorted((c for c, n in sizes.items() if n >= min_size), key=lambda c: (-sizes[c], c))
    renumber = {old: new for new, old in enumerate(kept)}
    small = {c: n for c, n in sizes.items() if n < min_size}
    assignments = [(doc_id, renumber.get(community)) for doc_id, community in raw]
    return assignments, {
        "community_count": len(kept),
        "raw_community_count": len(sizes),
        "outside_documents": sum(small.values()),
        "min_community_size": min_size,
    }
