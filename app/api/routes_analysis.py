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
        "top_k": s.analysis_top_k,
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
