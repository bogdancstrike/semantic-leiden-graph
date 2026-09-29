"""Explore: the structured side of the corpus — browse, condition trees, insights.

Ranked retrieval stays on ``/search``; these endpoints answer "which documents satisfy
this question, sorted by a field", plus the catalogue the query builder is built from.
The condition tree accepted here is the same one ``/search`` and ``/graph/query`` take in
``filters.condition_tree`` / ``condition_tree``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from app.api.deps import get_container
from app.container import Container
from app.schemas import ExploreRequest

router = APIRouter(tags=["explore"])


@router.get("/explore/fields", summary="Field catalogue for the condition builder (operators + live choices)")
def explore_fields(c: Container = Depends(get_container)):
    return c.explore_fields()


@router.post("/explore/query", summary="Documents matching a condition tree and quick text, sorted and paged")
def explore_query(body: ExploreRequest, c: Container = Depends(get_container)):
    return c.explore(body)


@router.post("/explore/insights", summary="Breakdowns (communities, sources, length, time) of the same question")
def explore_insights(body: ExploreRequest, c: Container = Depends(get_container)):
    return c.explore_insights(body)


@router.get("/sources", summary="Import sources with document counts (null = documents without a source)")
def list_sources(c: Container = Depends(get_container)):
    return c.sources()
