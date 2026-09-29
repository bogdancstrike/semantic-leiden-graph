from __future__ import annotations

from fastapi import APIRouter, Depends, status

from app.api.deps import get_container, require_api_key
from app.container import Container
from app.schemas import ClusterRequest, DeleteSourceRequest, JobOut, RebuildRequest

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("", response_model=list[JobOut])
def list_jobs(c: Container = Depends(get_container)):
    return c.jobs.list()


@router.get("/{job_id}", response_model=JobOut)
def get_job(job_id: str, c: Container = Depends(get_container)):
    return c.jobs.get(job_id)


@router.delete("/{job_id}", response_model=JobOut, dependencies=[Depends(require_api_key)])
def cancel_job(job_id: str, c: Container = Depends(get_container)):
    return c.jobs.cancel(job_id)


@router.post("/cluster", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(require_api_key)])
def cluster_job(body: ClusterRequest | None = None, c: Container = Depends(get_container)):
    body = body or ClusterRequest()
    return c.submit_cluster(body.gamma, body.random_seed, body.min_community_size)


@router.post("/rebuild", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(require_api_key)])
def rebuild_job(body: RebuildRequest | None = None, c: Container = Depends(get_container)):
    body = body or RebuildRequest()
    return c.submit_rebuild(body.neighbor_k, body.min_similarity, body.cluster)


@router.post("/reconcile", response_model=JobOut, status_code=status.HTTP_202_ACCEPTED, dependencies=[Depends(require_api_key)])
def reconcile_job(c: Container = Depends(get_container)):
    return c.submit_reconcile()


@router.post(
    "/delete-source",
    response_model=JobOut,
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(require_api_key)],
    summary="Delete every document of one import source from all three stores",
)
def delete_source_job(body: DeleteSourceRequest, c: Container = Depends(get_container)):
    return c.submit_delete_source(body.source, body.cluster)
