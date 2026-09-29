from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_container, require_api_key
from app.container import Container
from app.errors import ValidationFailed
from app.schemas import (
    ClusterRequest,
    GraphOut,
    GraphQueryOut,
    GraphQueryRequest,
    RebuildRequest,
)

router = APIRouter(tags=["graph"])


def _band(min_score: float, max_score: float) -> None:
    if max_score < min_score:
        raise ValidationFailed(
            "max_score must be greater than or equal to min_score",
            details={"min_score": min_score, "max_score": max_score},
        )


@router.get("/graph", response_model=GraphOut)
def graph_data(
    limit: int = Query(default=500, ge=1, le=10_000),
    community_id: list[int] | None = Query(default=None),
    min_score: float = Query(default=0.0, ge=-1.0, le=1.0),
    max_score: float = Query(default=1.0, ge=-1.0, le=1.0),
    c: Container = Depends(get_container),
):
    _band(min_score, max_score)
    return c.graph_data(limit=limit, community_ids=community_id, min_score=min_score, max_score=max_score)


@router.post(
    "/graph/query",
    response_model=GraphQueryOut,
    summary="Subgraph seeded by a search and/or condition tree (seeds kept even when isolated)",
)
def graph_query(body: GraphQueryRequest, c: Container = Depends(get_container)):
    return c.graph_query(body)


@router.get("/graph/ego/{doc_id}", response_model=GraphOut, summary="Neighbourhood (1-2 hops) around a document")
def ego_graph(
    doc_id: str,
    hops: int = Query(default=1, ge=1, le=2),
    node_limit: int = Query(default=150, ge=2, le=1000),
    min_score: float = Query(default=0.0, ge=-1.0, le=1.0),
    max_score: float = Query(default=1.0, ge=-1.0, le=1.0),
    c: Container = Depends(get_container),
):
    _band(min_score, max_score)
    return c.ego_graph(doc_id, hops, node_limit, min_score, max_score)


@router.get("/communities")
def communities(c: Container = Depends(get_container)):
    return {"communities": c.communities()}


@router.get("/communities/{community_id}")
def community_detail(community_id: int, limit: int = Query(default=8, ge=1, le=50), c: Container = Depends(get_container)):
    return c.community_detail(community_id, limit)


@router.get("/cluster/runs")
def cluster_runs(limit: int = Query(default=20, ge=1, le=200), c: Container = Depends(get_container)):
    return {"runs": c.cluster_runs(limit)}


# ---- synchronous v0.2 endpoints (kept for seed/CLI/scripts; UI uses /jobs/*) ----


@router.post("/graph/rebuild", dependencies=[Depends(require_api_key)])
def rebuild_graph(body: RebuildRequest | None = None, c: Container = Depends(get_container)):
    body = body or RebuildRequest(cluster=False)
    return c.rebuild_sync(body.neighbor_k, body.min_similarity)


@router.post("/cluster", dependencies=[Depends(require_api_key)])
def cluster(body: ClusterRequest | None = None, c: Container = Depends(get_container)):
    body = body or ClusterRequest()
    return c.cluster_sync(body.gamma, body.random_seed, body.min_community_size)
