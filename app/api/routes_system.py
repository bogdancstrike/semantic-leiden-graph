from __future__ import annotations

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.api.deps import get_container
from app.config import get_settings
from app.container import Container

router = APIRouter(tags=["system"])


@router.get("/health", summary="Liveness: the process is up and initialised")
def health(c: Container = Depends(get_container)):
    return {"status": "ok"}


@router.get("/ready", summary="Readiness: all three stores respond")
def ready(c: Container = Depends(get_container)):
    checks = c.readiness()
    ok = all(checks.values())
    return JSONResponse({"status": "ready" if ok else "degraded", "checks": checks}, status_code=200 if ok else 503)


@router.get("/stats")
def stats(c: Container = Depends(get_container)):
    return c.stats()


@router.get("/config", summary="Public runtime configuration for clients (no secrets)")
def public_config(c: Container = Depends(get_container)):
    s = get_settings()
    return {
        "embedding_model": c.embedder.model_name,
        "embedding_dimension": c.embedder.dimension,
        "policy": c.policy,
        "leiden_gamma": s.leiden_gamma,
        "leiden_random_seed": s.leiden_random_seed,
        # the size the next clustering run uses by default: the last run's, else the setting
        "leiden_min_community_size": c.min_community_size,
        "limits": {
            "upload_max_bytes": s.upload_max_bytes,
            "upload_max_rows": s.upload_max_rows,
            "text_max_chars": s.text_max_chars,
            "metadata_max_keys": s.metadata_max_keys,
            "batch_max_documents": s.batch_max_documents,
            "search_prefilter_limit": s.search_prefilter_limit,
        },
        "auth_required": s.api_key is not None,
        "stores": {"content": "elasticsearch", "vectors": "qdrant", "graph": "neo4j"},
    }
