from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status

from app.api.deps import get_container, require_api_key
from app.config import get_settings
from app.container import Container
from app.errors import PayloadTooLarge, ValidationFailed
from app.pipeline.csv_reader import detect_layout
from app.schemas import BatchInput, DocumentIn, JobOut, TextInput

router = APIRouter(tags=["documents"])

CHUNK = 8 * 1024 * 1024  # 1 GB uploads: fewer, larger copies


@router.post("/documents", dependencies=[Depends(require_api_key)], summary="Ingest one document")
def ingest_document(body: TextInput, c: Container = Depends(get_container)):
    report = c.ingest_documents([DocumentIn(id=body.id, text=body.text, metadata=body.metadata)], source="api")
    doc = report["documents"][0] if report["documents"] else {}
    # v0.2 response fields kept for compatibility
    return {**report, "id": doc.get("id"), "text": body.text, "semantic_edges_created": report["edges_upserted"]}


@router.post("/documents/batch", dependencies=[Depends(require_api_key)], summary="Ingest a JSON batch")
def ingest_batch(body: BatchInput, c: Container = Depends(get_container)):
    docs = body.documents or [DocumentIn(text=t) for t in (body.texts or [])]
    limit = get_settings().batch_max_documents
    if len(docs) > limit:
        raise PayloadTooLarge(f"Batch has {len(docs)} documents; limit is {limit}. Use CSV upload for bulk loads.")
    return c.ingest_documents(docs, source=body.source or "api", cluster=body.cluster)


@router.post(
    "/documents/upload",
    dependencies=[Depends(require_api_key)],
    status_code=status.HTTP_202_ACCEPTED,
    response_model=JobOut,
    summary="Upload any delimited text file; choose the column to analyse; runs as a background import job",
)
async def upload_csv(
    file: UploadFile = File(...),
    run_cluster: bool = Form(True),
    rebuild: bool = Form(False),
    source: str | None = Form(None, max_length=128),
    id_column: str | None = Form(
        None, max_length=256, description="Id column (default: a column named 'id', else ids from the text)"
    ),
    text_column: str | None = Form(
        None, max_length=256, description="The column to analyse (default: a column named 'text')"
    ),
    metadata_columns: str | None = Form(
        None, description="JSON array of headers kept as metadata; '[]' keeps none; absent keeps all others"
    ),
    generate_ids: bool = Form(False, description="No id column: derive each id from its text"),
    truncate_long_texts: bool = Form(
        False, description="Import the first TEXT_MAX_CHARS characters of longer texts instead of skipping the row"
    ),
    delimiter: str | None = Form(
        None, max_length=16, description="One character, or comma / semicolon / tab / pipe; default: detected"
    ),
    encoding: str | None = Form(
        None, max_length=40, description="e.g. utf-8, utf-16, windows-1252, windows-1250; default: detected"
    ),
    has_header: bool = Form(True, description="false: no header row; columns are column_1 ... column_n"),
    min_community_size: int | None = Form(
        None, ge=2, le=100_000, description="Clustering after the import: smallest group that counts as a community"
    ),
    c: Container = Depends(get_container),
):
    settings = get_settings()
    keep = _parse_columns(metadata_columns)
    # Any name is accepted: the content decides (detect_layout refuses workbooks and archives).
    filename = Path(file.filename or "upload.csv").name

    # Stream to disk with a hard byte limit: the request body is never fully held in RAM
    # and the background job outlives the request's own temp file.
    tmp = tempfile.NamedTemporaryFile(prefix="import-", suffix=".csv", delete=False)
    path = Path(tmp.name)
    written = 0
    try:
        with tmp:
            while chunk := await file.read(CHUNK):
                written += len(chunk)
                if written > settings.upload_max_bytes:
                    raise PayloadTooLarge(
                        f"File exceeds {settings.upload_max_bytes // (1024 * 1024)} MiB upload limit."
                    )
                tmp.write(chunk)
        layout = detect_layout(  # fail fast with 422 on a binary file, a bad codec or mapping
            path,
            settings.metadata_max_keys,
            id_column=id_column or None,
            text_column=text_column or None,
            metadata_columns=keep,
            generate_ids=generate_ids,
            delimiter=delimiter,
            encoding=encoding,
            has_header=has_header,
        )
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()

    return c.submit_csv_import(
        path,
        layout,
        filename=filename,
        source=(source or f"csv:{filename}")[:128],
        run_cluster=run_cluster,
        rebuild=rebuild,
        truncate_long_texts=truncate_long_texts,
        min_community_size=min_community_size,
    )


def _parse_columns(raw: str | None) -> list[str] | None:
    if raw is None or raw == "":
        return None
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise ValidationFailed("metadata_columns must be a JSON array of column names") from exc
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise ValidationFailed("metadata_columns must be a JSON array of column names")
    return value


@router.get("/documents", summary="Browse documents with cursor pagination")
def browse_documents(
    limit: int = Query(default=25, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=2048),
    q: str | None = Query(default=None, max_length=500),
    community_id: int | None = None,
    unassigned: bool = False,
    source: str | None = Query(default=None, max_length=128),
    external_id: str | None = Query(default=None, max_length=256),
    c: Container = Depends(get_container),
):
    return c.browse(
        limit=limit,
        cursor=cursor,
        query=q,
        community_id=community_id,
        unassigned=unassigned,
        source=source,
        external_id=external_id,
    )


@router.get("/documents/{doc_id}")
def get_document(doc_id: str, c: Container = Depends(get_container)):
    return c.get_document(doc_id)


@router.delete("/documents/{doc_id}", dependencies=[Depends(require_api_key)])
def delete_document(doc_id: str, c: Container = Depends(get_container)):
    return c.delete_document(doc_id)


@router.get("/documents/{doc_id}/similar", summary="Semantic (Qdrant), keyword (ES MLT) or graph (Neo4j) neighbours")
def similar_documents(
    doc_id: str,
    method: Literal["semantic", "keyword", "graph"] = "semantic",
    limit: int = Query(default=10, ge=1, le=100),
    c: Container = Depends(get_container),
):
    return {"method": method, "results": c.similar(doc_id, method, limit)}


@router.get("/documents/{doc_id}/neighbors", summary="Graph neighbours (alias of similar?method=graph)")
def neighbors(doc_id: str, limit: int = Query(default=20, ge=1, le=200), c: Container = Depends(get_container)):
    return {"results": c.similar(doc_id, "graph", limit)}
