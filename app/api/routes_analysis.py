from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, status

from app.api.deps import get_container, require_api_key
from app.container import Container
from app.schemas import AnalysisRequest, JobOut

router = APIRouter(tags=["analysis"])
ContainerDep = Annotated[Container, Depends(get_container)]


@router.post(
    "/jobs/analyze",
    response_model=JobOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_api_key)],
)
def analyze(c: ContainerDep, body: AnalysisRequest | None = None):
    return c.analysis.submit(body or AnalysisRequest())


@router.get("/analysis/config")
def analysis_config(c: ContainerDep):
    s = c.settings
    return {
        "provider": s.llm_provider,
        "model": c.analysis.llm.model,
        "configured": c.analysis.llm.configured,
        "selection_mode": "auto",
        "context_tokens": s.llm_context_tokens,
        "output_reserve": s.llm_max_output_tokens,
        "max_communities": s.analysis_max_communities,
        "document_chars": s.analysis_document_chars,
        "schedule": c.analysis_scheduler.status(),
    }


@router.get("/analysis/runs")
def analysis_runs(
    c: ContainerDep,
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return c.analysis.store.list(limit, offset)


@router.get("/analysis/runs/{run_id}")
def analysis_run(run_id: str, c: ContainerDep):
    return c.analysis.store.get(run_id)


@router.get("/analysis/topics")
def topics(
    c: ContainerDep,
    q: Annotated[str, Query(max_length=300)] = "",
    sentiment: Annotated[
        str | None, Query(pattern="^(positive|negative|neutral|mixed|unclear)$")
    ] = None,
    priority: Literal["low", "medium", "high"] | None = None,
    classification: Annotated[str | None, Query(max_length=200)] = None,
    trend: Literal["rising", "falling", "stable", "unavailable"] | None = None,
    created_after: datetime | None = None,
    created_before: datetime | None = None,
    sort: Literal["recent", "documents", "coverage", "priority"] = "recent",
    topic_ids: Annotated[list[str] | None, Query(max_length=500)] = None,
    run_id: str | None = None,
    document_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return c.analysis.store.topics(
        query=q,
        sentiment=sentiment,
        priority=priority,
        classification=classification,
        trend=trend,
        sort=sort,
        topic_ids=set(topic_ids) if topic_ids is not None else None,
        created_after=created_after.astimezone(UTC).isoformat()
        if created_after
        else None,
        created_before=created_before.astimezone(UTC).isoformat()
        if created_before
        else None,
        run_id=run_id,
        document_id=document_id,
        limit=limit,
        offset=offset,
    )


@router.get("/analysis/topics/{topic_id}")
def topic(topic_id: str, c: ContainerDep):
    return c.analysis.topic(topic_id)


@router.get("/analysis/topics/{topic_id}/documents")
def topic_documents(
    topic_id: str,
    c: ContainerDep,
    q: Annotated[str, Query(max_length=300)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 20,
    offset: Annotated[int, Query(ge=0, le=1000)] = 0,
):
    return c.analysis.topic_documents(topic_id, q, limit, offset)


@router.delete("/analysis/topics/{topic_id}", dependencies=[Depends(require_api_key)])
def delete_topic(topic_id: str, c: ContainerDep):
    topic = c.analysis.topic(topic_id, include_statistics=False)
    c.analysis.store.delete_topic(
        topic["run"]["id"], topic["community"]["community_id"]
    )
    return {"deleted": True, "topic_id": topic_id}


@router.post(
    "/analysis/topics/{topic_id}/reanalyze",
    response_model=JobOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_api_key)],
)
def reanalyze_topic(topic_id: str, c: ContainerDep):
    return c.analysis.reanalyze(topic_id)
