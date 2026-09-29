"""Qdrant: authority for dense vectors and ANN candidate generation.

The payload is deliberately tiny (``external_id``, ``community_id``,
``community_version``). Text lives in Elasticsearch; duplicating it here would double
RAM usage for nothing because every result is hydrated from ES in a single request.
``community_id`` *is* duplicated because "ANN restricted to one community" must be
executed inside the HNSW traversal, not as a post-filter.
"""

from __future__ import annotations

import logging
import time
from collections import defaultdict
from collections.abc import Iterable, Sequence

import numpy as np
from qdrant_client import QdrantClient, models

from app.config import Settings
from app.errors import DependencyUnavailable, SchemaMismatch

log = logging.getLogger(__name__)


def community_filter(
    community_ids: Sequence[int] | None = None,
    exclude_community_ids: Sequence[int] | None = None,
    ids: Sequence[str] | None = None,
    unassigned_only: bool = False,
) -> models.Filter | None:
    must: list = []
    must_not: list = []
    if community_ids:
        must.append(models.FieldCondition(key="community_id", match=models.MatchAny(any=list(community_ids))))
    if exclude_community_ids:
        must_not.append(models.FieldCondition(key="community_id", match=models.MatchAny(any=list(exclude_community_ids))))
    if ids is not None:
        must.append(models.HasIdCondition(has_id=list(ids)))
    if unassigned_only:
        must.append(models.IsNullCondition(is_null=models.PayloadField(key="community_id")))
    if not must and not must_not:
        return None
    return models.Filter(must=must or None, must_not=must_not or None)


class VectorStore:
    def __init__(self, settings: Settings, vector_size: int, client: QdrantClient | None = None) -> None:
        self.settings = settings
        self.collection = settings.qdrant_collection
        self.vector_size = vector_size
        self.client = client or QdrantClient(
            url=settings.qdrant_url,
            api_key=settings.qdrant_api_key.get_secret_value() if settings.qdrant_api_key else None,
            prefer_grpc=settings.qdrant_prefer_grpc,
            timeout=settings.qdrant_timeout,
        )

    # ------------------------------------------------------------------ lifecycle

    def ping(self) -> bool:
        try:
            self.client.get_collections()
            return True
        except Exception:  # noqa: BLE001
            return False

    def ensure_collection(self) -> None:
        try:
            exists = self.client.collection_exists(self.collection)
        except Exception as exc:  # noqa: BLE001
            raise DependencyUnavailable(f"Qdrant is not reachable: {exc}") from exc

        if exists:
            self._verify_schema()
        else:
            quantization = (
                models.ScalarQuantization(
                    scalar=models.ScalarQuantizationConfig(type=models.ScalarType.INT8, always_ram=True)
                )
                if self.settings.qdrant_quantization
                else None
            )
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=models.VectorParams(size=self.vector_size, distance=models.Distance.COSINE),
                quantization_config=quantization,
                optimizers_config=self._optimizers_config(),
            )
            log.info("Created Qdrant collection %s (dim=%d)", self.collection, self.vector_size)
        self.client.create_payload_index(
            collection_name=self.collection,
            field_name="community_id",
            field_schema=models.PayloadSchemaType.INTEGER,
            wait=True,
        )

    def _optimizers_config(self) -> models.OptimizersConfigDiff | None:
        threshold = self.settings.qdrant_indexing_threshold_kb
        return models.OptimizersConfigDiff(indexing_threshold=threshold) if threshold is not None else None

    def _verify_schema(self) -> None:
        info = self.client.get_collection(self.collection)
        wanted = self.settings.qdrant_indexing_threshold_kb
        current = getattr(info.config.optimizer_config, "indexing_threshold", None)
        if wanted is not None and current != wanted:
            # Optimizer settings are safe to change online; keeps old collections consistent.
            self.client.update_collection(self.collection, optimizers_config=self._optimizers_config())
            log.info("Qdrant indexing_threshold %s -> %s KB", current, wanted)
        vectors = info.config.params.vectors
        if not isinstance(vectors, models.VectorParams):
            raise SchemaMismatch(
                f"Collection '{self.collection}' uses named vectors; this app expects one unnamed dense vector. "
                "Use a new QDRANT_COLLECTION or reset volumes."
            )
        if vectors.size != self.vector_size:
            raise SchemaMismatch(
                f"Collection '{self.collection}' has dim={vectors.size} but model produces dim={self.vector_size}. "
                "Changing EMBEDDING_MODEL requires a new collection (see docs/specs.md §10.5)."
            )

    # ------------------------------------------------------------------ writes

    def upsert(self, ids: list[str], vectors: np.ndarray, payloads: list[dict]) -> None:
        if not ids:
            return
        self.client.upsert(
            collection_name=self.collection,
            points=models.Batch(ids=ids, vectors=vectors.tolist(), payloads=payloads),
            wait=True,
        )

    def set_communities(self, assignments: list[tuple[str, int]], version: int) -> int:
        """Group by community -> one SetPayload op per community per chunk.

        v0.2 issued one HTTP call per document; this issues ~N/sync_batch_size calls.
        """
        by_community: dict[int, list[str]] = defaultdict(list)
        for doc_id, community_id in assignments:
            by_community[community_id].append(doc_id)

        operations: list[models.UpdateOperation] = []
        chunk = self.settings.sync_batch_size
        for community_id, doc_ids in by_community.items():
            for start in range(0, len(doc_ids), chunk):
                operations.append(
                    models.SetPayloadOperation(
                        set_payload=models.SetPayload(
                            payload={"community_id": community_id, "community_version": version},
                            points=doc_ids[start : start + chunk],
                        )
                    )
                )
        for start in range(0, len(operations), 100):
            self.client.batch_update_points(
                collection_name=self.collection, update_operations=operations[start : start + 100], wait=True
            )
        return len(assignments)

    def delete(self, ids: list[str]) -> None:
        if ids:
            self.client.delete(
                collection_name=self.collection, points_selector=models.PointIdsList(points=ids), wait=True
            )

    def delete_existing(self, ids: list[str]) -> int:
        """``delete`` that reports how many of ``ids`` actually had a vector."""
        if not ids:
            return 0
        present = self.client.retrieve(collection_name=self.collection, ids=ids, with_payload=False, with_vectors=False)
        self.delete(ids)
        return len(present)

    # ------------------------------------------------------------------ reads

    def search(
        self,
        vector: list[float],
        limit: int,
        query_filter: models.Filter | None = None,
        score_threshold: float | None = None,
    ) -> list[models.ScoredPoint]:
        return self.client.query_points(
            collection_name=self.collection,
            query=vector,
            query_filter=query_filter,
            score_threshold=score_threshold,
            limit=limit,
            with_payload=["community_id", "external_id"],
            with_vectors=False,
        ).points

    def wait_until_indexed(self, timeout: float) -> float:
        """Block until the optimizer is idle (HNSW built) or ``timeout`` elapses.

        Right after a bulk upsert Qdrant builds HNSW in the background; queries issued
        meanwhile fall back to brute force. Waiting a few seconds before linking thousands
        of documents is much cheaper than brute-forcing all of them. GREY ("optimisations
        pending but not triggered") also ends the wait so it can never hang.
        """
        started = time.perf_counter()
        while time.perf_counter() - started < timeout:
            status = self.client.get_collection(self.collection).status
            if status != models.CollectionStatus.YELLOW:
                break
            time.sleep(0.25)
        return time.perf_counter() - started

    def neighbors_of(self, ids: list[str], limit: int, score_threshold: float | None = None) -> dict[str, list]:
        """Batched k-NN for stored points.

        Query-by-ID: Qdrant resolves the stored vector server-side (no vector transfer)
        and excludes the query point itself (verified against a real server in
        tests/integration). A ``must_not HasId(self)`` filter would only add ~10% latency.
        """
        if not ids:
            return {}
        requests = [
            models.QueryRequest(
                query=doc_id,
                limit=limit,
                score_threshold=score_threshold,
                with_payload=False,
                with_vector=False,
            )
            for doc_id in ids
        ]
        responses = self.client.query_batch_points(collection_name=self.collection, requests=requests)
        return {doc_id: response.points for doc_id, response in zip(ids, responses, strict=True)}

    def similar(self, doc_id: str, limit: int, query_filter: models.Filter | None = None) -> list[models.ScoredPoint]:
        return self.client.query_points(
            collection_name=self.collection,
            query=doc_id,
            query_filter=query_filter,
            limit=limit + 1,
            with_payload=["community_id", "external_id"],
        ).points

    def vectors_for(self, ids: list[str]) -> dict[str, np.ndarray]:
        if not ids:
            return {}
        points = self.client.retrieve(collection_name=self.collection, ids=ids, with_vectors=True, with_payload=False)
        return {str(p.id): np.asarray(p.vector, dtype=np.float32) for p in points if isinstance(p.vector, list)}

    def iter_ids(self, batch: int = 512) -> Iterable[str]:
        offset = None
        while True:
            points, offset = self.client.scroll(
                collection_name=self.collection, limit=batch, offset=offset, with_payload=False, with_vectors=False
            )
            for point in points:
                yield str(point.id)
            if offset is None:
                return

    def count(self) -> int:
        return int(self.client.count(collection_name=self.collection, exact=True).count)

    def stats(self) -> dict:
        info = self.client.get_collection(self.collection)
        return {
            "points": self.count(),
            "indexed_vectors": info.indexed_vectors_count,
            "segments": info.segments_count,
            "status": str(info.status.value if hasattr(info.status, "value") else info.status),
            "quantization": self.settings.qdrant_quantization,
        }
