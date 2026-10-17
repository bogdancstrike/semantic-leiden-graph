from typing import Annotated

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
    run_id: str | None = None,
    document_id: str | None = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 24,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    return c.analysis.store.topics(
        query=q,
        sentiment=sentiment,
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
