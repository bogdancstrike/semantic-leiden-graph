"""Batched ingestion pipeline shared by the API, CSV import, seed and CLI.

Per chunk (default 256 docs):
    dedupe ids -> ES mget(text_hash) -> classify new/changed/unchanged
    -> embed only new+changed -> ES bulk upsert -> Qdrant batch upsert
    -> Neo4j: MERGE nodes, reset edges of changed docs
After all chunks:
    batched Qdrant k-NN (query-by-id) for every touched doc -> Neo4j UNWIND edge upsert

Linking happens after *all* chunks are stored so documents in the same upload can
become each other's neighbours (v0.2 needed a full rebuild for that).
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from collections.abc import Callable, Iterable, Iterator

from app.config import Settings
from app.embedder import EmbedderProtocol
from app.ids import point_id, text_hash
from app.stores.elastic import ElasticStore
from app.stores.graph import GraphStore, canonical_edges
from app.stores.vectors import VectorStore

log = logging.getLogger(__name__)

Progress = Callable[[str, int, int | None], None]


@dataclass
class IngestDoc:
    external_id: str
    text: str
    metadata: dict | None = None
    source: str | None = None
    row: int | None = None


class IdList:
    """Point ids (UUID strings) packed at 16 bytes each, for the link-after-import step.

    Linking happens after every chunk is stored, so the ids of a whole upload wait in
    memory: five million UUID strings are ~450 MB of Python objects, the same ids packed
    are 80 MB. Supports what ``link`` needs: ``len``, truthiness, slices and iteration.
    """

    __slots__ = ("_buffer",)

    def __init__(self, ids: Iterable[str] = ()) -> None:
        self._buffer = bytearray()
        self.extend(ids)

    def extend(self, ids: Iterable[str]) -> None:
        for doc_id in ids:
            self._buffer += uuid.UUID(doc_id).bytes

    def __len__(self) -> int:
        return len(self._buffer) // 16

    def __bool__(self) -> bool:
        return bool(self._buffer)

    def __getitem__(self, index: slice) -> list[str]:
        start, stop, step = index.indices(len(self))
        return [str(uuid.UUID(bytes=bytes(self._buffer[i * 16 : i * 16 + 16]))) for i in range(start, stop, step)]

    def __iter__(self) -> Iterator[str]:
        for i in range(len(self)):
            yield str(uuid.UUID(bytes=bytes(self._buffer[i * 16 : i * 16 + 16])))


@dataclass
class IngestResult:
    received: int = 0
    created: int = 0
    updated: int = 0
    unchanged: int = 0
    failed: int = 0
    edges_upserted: int = 0
    touched_ids: IdList = field(default_factory=IdList)
    documents: list[dict] = field(default_factory=list)
    errors: list[dict] = field(default_factory=list)

    def as_report(self, include_documents: bool) -> dict:
        return {
            "received": self.received,
            "created": self.created,
            "updated": self.updated,
            "unchanged": self.unchanged,
            "failed": self.failed,
            "edges_upserted": self.edges_upserted,
            "documents": self.documents if include_documents else [],
            "errors": self.errors[:200],
        }


def _noop(_: str, __: int, ___: int | None) -> None:
    return None


class IngestionPipeline:
    def __init__(
        self,
        settings: Settings,
        embedder: EmbedderProtocol,
        es: ElasticStore,
        vectors: VectorStore,
        graph: GraphStore,
        policy: Callable[[], tuple[int, float]],
    ) -> None:
        self.settings = settings
        self.embedder = embedder
        self.es = es
        self.vectors = vectors
        self.graph = graph
        self.policy = policy

    def ingest(
        self,
        docs: Iterable[IngestDoc],
        *,
        total: int | None = None,
        progress: Progress = _noop,
        track_documents: bool = False,
    ) -> IngestResult:
        result = IngestResult()
        chunk: list[IngestDoc] = []
        for doc in docs:
            chunk.append(doc)
            if len(chunk) >= self.settings.ingest_chunk_size:
                self._process_chunk(chunk, result, track_documents)
                progress("indexing", result.received, total)
                chunk = []
        if chunk:
            self._process_chunk(chunk, result, track_documents)
            progress("indexing", result.received, total)

        if result.touched_ids:
            self.es.refresh()
            if len(result.touched_ids) >= self.settings.link_wait_for_index_min_docs:
                progress("waiting for vector index", 0, None)
                waited = self.vectors.wait_until_indexed(self.settings.qdrant_index_wait_seconds)
                log.info("Waited %.1fs for Qdrant HNSW before linking %d documents", waited, len(result.touched_ids))
            result.edges_upserted = self.link(result.touched_ids, progress=progress)
        return result

    # ------------------------------------------------------------------ chunk

    def _process_chunk(self, chunk: list[IngestDoc], result: IngestResult, track: bool) -> None:
        result.received += len(chunk)
        latest: dict[str, IngestDoc] = {}
        for doc in chunk:  # last occurrence wins inside a chunk
            latest[point_id(doc.external_id)] = doc
        duplicates = len(chunk) - len(latest)
        if duplicates:
            result.unchanged += duplicates

        ids = list(latest)
        state = self.es.get_state(ids)
        new_ids, changed_ids, meta_only_ids = [], [], []
        hashes: dict[str, str] = {}
        for doc_id, doc in latest.items():
            hashes[doc_id] = text_hash(doc.text)
            existing = state.get(doc_id)
            if existing is None:
                new_ids.append(doc_id)
            elif existing.get("text_hash") != hashes[doc_id]:
                changed_ids.append(doc_id)
            elif (doc.metadata or None) != (existing.get("metadata") or None) or (
                doc.source and doc.source != existing.get("source")
            ):
                meta_only_ids.append(doc_id)
            else:
                result.unchanged += 1
                if track:
                    result.documents.append({"id": doc_id, "external_id": doc.external_id, "status": "unchanged"})

        embed_ids = new_ids + changed_ids
        changed_set = set(changed_ids)
        es_docs = []
        for doc_id in embed_ids + meta_only_ids:
            doc = latest[doc_id]
            existing = state.get(doc_id) or {}
            keep_community = doc_id not in changed_set  # text change -> stale until next Leiden run
            es_docs.append(
                {
                    "id": doc_id,
                    "external_id": doc.external_id,
                    "text": doc.text,
                    "text_hash": hashes[doc_id],
                    "length": len(doc.text),
                    "source": doc.source or existing.get("source"),
                    "metadata": doc.metadata or None,
                    "embedding_model": self.embedder.model_name,
                    "community_id": existing.get("community_id") if keep_community else None,
                    "community_version": existing.get("community_version") if keep_community else None,
                    "created_at": existing.get("created_at"),
                    "_seq_no": existing.get("_seq_no"),
                    "_primary_term": existing.get("_primary_term"),
                }
            )

        failed = self.es.bulk_upsert(es_docs)
        for doc_id, reason in failed.items():
            doc = latest[doc_id]
            result.errors.append({"row": doc.row, "external_id": doc.external_id, "reason": f"elasticsearch: {reason}"})
        result.failed += len(failed)

        embed_ids = [i for i in embed_ids if i not in failed]
        if embed_ids:
            vectors = self.embedder.encode_documents([latest[i].text for i in embed_ids])
            payloads = [{"external_id": latest[i].external_id, "community_id": None} for i in embed_ids]
            self.vectors.upsert(embed_ids, vectors, payloads)
            self.graph.upsert_nodes(embed_ids)
            changed_ok = [i for i in changed_ids if i not in failed]
            if changed_ok:
                self.graph.reset_documents(changed_ok)
            result.touched_ids.extend(embed_ids)

        created = [i for i in new_ids if i not in failed]
        updated = [i for i in changed_ids + meta_only_ids if i not in failed]
        result.created += len(created)
        result.updated += len(updated)
        if track:
            for doc_id in created:
                result.documents.append({"id": doc_id, "external_id": latest[doc_id].external_id, "status": "created"})
            for doc_id in updated:
                result.documents.append({"id": doc_id, "external_id": latest[doc_id].external_id, "status": "updated"})

    # ------------------------------------------------------------------ linking

    def link(self, ids: list[str], *, progress: Progress = _noop) -> int:
        """Compute k-NN edges for ``ids`` against the whole collection."""
        k, threshold = self.policy()
        batch = self.settings.neighbor_query_batch
        pending: list[tuple[str, str, float]] = []
        written = 0
        for start in range(0, len(ids), batch):
            chunk = ids[start : start + batch]
            neighbours = self.vectors.neighbors_of(chunk, limit=k, score_threshold=threshold)
            for doc_id, points in neighbours.items():
                for point in points:
                    if str(point.id) != doc_id and float(point.score) >= threshold:
                        pending.append((doc_id, str(point.id), float(point.score)))
            if len(pending) >= self.settings.graph_write_batch:
                written += self.graph.upsert_edges(canonical_edges(pending))
                pending = []
            progress("linking", min(start + batch, len(ids)), len(ids))
        if pending:
            written += self.graph.upsert_edges(canonical_edges(pending))
        return written
