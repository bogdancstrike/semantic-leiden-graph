from __future__ import annotations

from fastapi import APIRouter, Depends, Response

from app.api.deps import get_container
from app.container import Container
from app.schemas import RoutingOptions, RoutingStrategy, Scope, ScopeType, SearchRequest, SearchResponse

router = APIRouter(tags=["search"])


@router.post("/search", response_model=SearchResponse, response_model_exclude_none=True)
def search(body: SearchRequest, response: Response, c: Container = Depends(get_container)):
    result, stopwatch = c.search_engine.search(body)
    response.headers["Server-Timing"] = stopwatch.server_timing()
    return result


@router.post(
    "/search/community",
    response_model=SearchResponse,
    response_model_exclude_none=True,
    summary="v0.2 auto-community search (single-anchor routing)",
)
def search_best_community(body: SearchRequest, response: Response, c: Container = Depends(get_container)):
    body.scope = Scope(type=ScopeType.auto, exclude_community_ids=body.scope.exclude_community_ids)
    if "routing" not in body.model_fields_set:
        body.routing = RoutingOptions(strategy=RoutingStrategy.top1, anchors=1)
    result, stopwatch = c.search_engine.search(body)
    response.headers["Server-Timing"] = stopwatch.server_timing()
    return result
