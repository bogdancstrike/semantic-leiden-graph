"""FastAPI application factory."""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from collections.abc import Callable

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse

from app.api import routes_documents, routes_explore, routes_graph, routes_jobs, routes_search, routes_system
from app.config import Settings, get_settings
from app.container import Container
from app.errors import AppError

log = logging.getLogger("app")

VERSION = "0.4.0"


def build_container(settings: Settings) -> Container:
    from app.embedder import Embedder
    from app.stores.elastic import ElasticStore
    from app.stores.graph import GraphStore
    from app.stores.vectors import VectorStore

    embedder = Embedder(settings)
    embedder.warmup()
    return Container(
        settings,
        embedder,
        ElasticStore(settings),
        VectorStore(settings, embedder.dimension),
        GraphStore(settings),
    )


def initialize_with_retry(factory: Callable[[], Container], settings: Settings) -> Container:
    """Bounded retry: databases in Compose/K8s often become reachable after the API."""
    container = factory()
    last: Exception | None = None
    for attempt in range(1, settings.startup_attempts + 1):
        try:
            container.initialize()
            return container
        except Exception as exc:  # noqa: BLE001
            last = exc
            log.warning("Dependency init attempt %d/%d failed: %s", attempt, settings.startup_attempts, exc)
            time.sleep(settings.startup_delay_seconds)
    container.close()
    raise RuntimeError("Could not initialise Elasticsearch/Qdrant/Neo4j") from last


def create_app(container_factory: Callable[[Settings], Container] | None = None) -> FastAPI:
    settings = get_settings()
    logging.basicConfig(
        level=settings.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    factory = container_factory or build_container

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.container = initialize_with_retry(lambda: factory(settings), settings)
        log.info("Semantic Leiden API %s ready", VERSION)
        yield
        app.state.container.close()

    app = FastAPI(
        title="Semantic Leiden Explorer API",
        version=VERSION,
        lifespan=lifespan,
    )
    app.add_middleware(GZipMiddleware, minimum_size=1024, compresslevel=5)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["Content-Type", "X-API-Key", "X-Request-ID"],
        expose_headers=["Server-Timing", "X-Request-ID", "X-Response-Time"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        started = time.perf_counter()
        response = await call_next(request)
        elapsed = (time.perf_counter() - started) * 1000
        response.headers["X-Request-ID"] = request_id
        response.headers["X-Response-Time"] = f"{elapsed:.1f}ms"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        if request.url.path not in ("/health", "/ready"):
            log.info("%s %s %s %.1fms rid=%s", request.method, request.url.path, response.status_code, elapsed, request_id)
        return response

    @app.exception_handler(AppError)
    async def app_error_handler(_: Request, exc: AppError):
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": exc.message, "code": exc.code, **({"details": exc.details} if exc.details else {})},
        )

    @app.exception_handler(RequestValidationError)
    async def validation_handler(_: Request, exc: RequestValidationError):
        errors = [
            {"loc": ".".join(str(p) for p in e["loc"]), "msg": e["msg"]} for e in exc.errors()
        ]
        first = errors[0] if errors else {"loc": "", "msg": "Invalid request"}
        return JSONResponse(
            status_code=422,
            content={"detail": f"{first['loc']}: {first['msg']}", "code": "validation_failed", "details": {"errors": errors}},
        )

    for router in (
        routes_system.router,
        routes_documents.router,
        routes_search.router,
        routes_explore.router,
        routes_graph.router,
        routes_jobs.router,
    ):
        app.include_router(router)
    return app


app = create_app()
