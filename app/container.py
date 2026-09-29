"""Composition root: builds the stores/engines and exposes use-case methods.

Consistency principle
---------------------
Elasticsearch is the system of record for *content*. Qdrant vectors and the Neo4j
topology are **derived projections** that can always be rebuilt from ES:

* writes go to ES first, then to the derived stores;
* deletes go to ES first, then to the derived stores;
* any partial failure therefore leaves a state that ``reconcile`` can repair
  (missing vector -> re-embed from ES text; orphan vector/node -> delete).
"""

from __future__ import annotations

import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from app.config import Settings
from app.embedder import EmbedderProtocol
from app.errors import BusyError, NotFoundError, ValidationFailed
from app.ids import (
    content_id,
    normalize_external_id,
    normalize_metadata_key,
    normalize_text,
    point_id,
)
from app.pipeline.communities import compact_communities
from app.pipeline.csv_reader import CsvLayout, CsvRowError, count_rows, iter_rows
from app.pipeline.ingest import IngestDoc, IngestionPipeline
from app.pipeline.jobs import JobContext, JobManager
from app.schemas import (
    EXPLORE_WINDOW,
    DocumentIn,
    ExploreRequest,
    GraphQueryRequest,
    SearchFilters,
    SearchRequest,
)
from app.search.conditions import FIELD_SPECS, count_rules, describe_tree, metadata_spec
from app.search.engine import SearchEngine
from app.stores.elastic import ElasticStore
from app.stores.graph import GraphStore
from app.stores.vectors import VectorStore

log = logging.getLogger(__name__)

SNIPPET_CHARS = 320
ERRORS_KEPT = 200  # per-row errors kept in an import report; the rest are only counted


class Container:
    def __init__(
        self,
        settings: Settings,
        embedder: EmbedderProtocol,
        es: ElasticStore,
        vectors: VectorStore,
        graph: GraphStore,
    ) -> None:
        self.settings = settings
        self.embedder = embedder
        self.es = es
        self.vectors = vectors
        self.graph = graph
        # I/O fan-out (concurrent engines, parallel stats/sync). Never awaited from inside
        # itself, so it cannot deadlock.
        self.executor = ThreadPoolExecutor(max_workers=16, thread_name_prefix="io")
        self.jobs = JobManager(history=settings.job_history)
        self._structural = threading.Lock()
        self._policy = (settings.neighbor_k, settings.min_similarity)
        # The minimum community size a run uses when none is given: the last run's (so an
        # import clustered at 10 is not re-clustered at 2 by the next delete or rebuild),
        # else LEIDEN_MIN_COMMUNITY_SIZE. Read back from the ClusterRun history at startup.
        self._min_size = settings.leiden_min_community_size
        self.pipeline = IngestionPipeline(settings, embedder, es, vectors, graph, policy=lambda: self._policy)
        self.search_engine = SearchEngine(settings, embedder, es, vectors, self.executor)

    # ------------------------------------------------------------------ lifecycle

    def initialize(self) -> None:
        self.es.ensure_index()
        self.vectors.ensure_collection()
        self.graph.ensure_schema()
        stored = self.graph.load_policy()
        if stored:
            self._policy = (stored["neighbor_k"], stored["min_similarity"])
        else:
            self.graph.save_policy(*self._policy)
        last = self.graph.cluster_runs(1)
        if last and last[0].get("min_community_size"):
            self._min_size = max(2, int(last[0]["min_community_size"]))

    def close(self) -> None:
        self.jobs.shutdown()
        self.executor.shutdown(wait=False, cancel_futures=True)
        self.graph.close()

    @contextmanager
    def structural(self, blocking: bool):
        acquired = self._structural.acquire(blocking=blocking)
        if not acquired:
            raise BusyError("Another graph operation (import, rebuild or clustering) is running. Retry when it finishes.")
        try:
            yield
        finally:
            self._structural.release()

    @property
    def min_community_size(self) -> int:
        """What the next clustering run uses unless it is given a size."""
        return self._min_size

    @property
    def policy(self) -> dict:
        return {"neighbor_k": self._policy[0], "min_similarity": self._policy[1]}

    def readiness(self) -> dict[str, bool]:
        futures = {
            "elasticsearch": self.executor.submit(self.es.ping),
            "qdrant": self.executor.submit(self.vectors.ping),
            "neo4j": self.executor.submit(self.graph.ping),
        }
        return {name: bool(f.result(timeout=10)) for name, f in futures.items()}

    # ------------------------------------------------------------------ ingestion

    def to_ingest_doc(self, doc: DocumentIn, default_source: str | None, position: int | None = None) -> IngestDoc:
        where = f"documents[{position}]: " if position is not None else ""
        text = normalize_text(doc.text)
        if not text:
            raise ValidationFailed(f"{where}text is empty")
        if len(text) > self.settings.text_max_chars:
            raise ValidationFailed(f"{where}text has {len(text)} characters (limit {self.settings.text_max_chars})")
        external_id = normalize_external_id(doc.id) if doc.id and doc.id.strip() else content_id(text)
        metadata = (
            {normalize_metadata_key(k): str(v) for k, v in doc.metadata.items() if normalize_metadata_key(k)}
            if doc.metadata
            else None
        )
        return IngestDoc(external_id=external_id, text=text, metadata=metadata, source=doc.source or default_source)

    def ingest_documents(self, docs: list[DocumentIn], source: str | None, cluster: bool = False) -> dict:
        items = [self.to_ingest_doc(d, source, i if len(docs) > 1 else None) for i, d in enumerate(docs)]
        result = self.pipeline.ingest(items, total=len(items), track_documents=len(items) <= 1000)
        report = result.as_report(include_documents=len(items) <= 1000)
        if cluster and result.touched_ids:
            # The documents are already stored; a busy lock must not turn that into an error.
            try:
                with self.structural(blocking=False):
                    report["clustering"] = self._cluster(None, None, None)
            except BusyError:
                report["clustering"] = None
                report["clustering_skipped"] = "Another graph job is running; run POST /jobs/cluster afterwards."
        return report

    def submit_csv_import(
        self,
        path: Path,
        layout: CsvLayout,
        *,
        filename: str,
        source: str,
        run_cluster: bool,
        rebuild: bool,
        truncate_long_texts: bool = False,
        min_community_size: int | None = None,
    ):
        def job(ctx: JobContext) -> dict:
            try:
                with self.structural(blocking=True):
                    return self._import_csv(
                        ctx, path, layout, source, run_cluster, rebuild, truncate_long_texts, min_community_size
                    )
            finally:
                path.unlink(missing_ok=True)

        return self.jobs.submit(
            "import",
            job,
            params={
                "filename": filename,
                "source": source,
                "delimiter": layout.delimiter,
                "id_column": layout.id_column,
                "text_column": layout.text_column,
                "generate_ids": layout.id_column is None,
                "metadata_columns": list(layout.metadata_columns.values()),
                "mapped_columns": list(layout.metadata_columns),
                "run_cluster": run_cluster,
                "rebuild": rebuild,
                "truncate_long_texts": truncate_long_texts,
                "min_community_size": min_community_size,
                "bytes": path.stat().st_size,
                "encoding": layout.describe()["encoding"],
                "has_header": layout.has_header,
                "columns": layout.describe()["columns"],
                "metadata_dropped": layout.metadata_dropped,
            },
        )

    def _import_csv(
        self,
        ctx: JobContext,
        path: Path,
        layout: CsvLayout,
        source: str,
        run_cluster: bool,
        rebuild: bool,
        truncate_long_texts: bool = False,
        min_community_size: int | None = None,
    ) -> dict:
        started = time.perf_counter()
        ctx.progress("counting", 0, None)
        total = count_rows(path, layout)
        ctx.progress("indexing", 0, total)
        # A million bad rows must not become a million dicts: every one is counted, the
        # first ERRORS_KEPT are kept for the report.
        row_errors: list[dict] = []
        tally = {"skipped": 0, "truncated": 0}

        def documents():
            for item in iter_rows(
                path,
                layout,
                text_max_chars=self.settings.text_max_chars,
                max_rows=self.settings.upload_max_rows,
                truncate_long_texts=truncate_long_texts,
            ):
                if isinstance(item, CsvRowError):
                    tally["skipped"] += 1
                    if len(row_errors) < ERRORS_KEPT:
                        row_errors.append({"row": item.row, "external_id": item.external_id, "reason": item.reason})
                    continue
                if item.truncated:
                    tally["truncated"] += 1
                yield IngestDoc(item.external_id, item.text, item.metadata or None, source, item.row)

        result = self.pipeline.ingest(documents(), total=total, progress=ctx.progress)
        report = result.as_report(include_documents=False)
        report["rows"] = total
        report["failed"] += tally["skipped"]
        report["truncated"] = tally["truncated"]
        # After counting: an auto-detected UTF-8 file may have been re-read as Windows-1252.
        report["format"] = {**layout.describe(), "text_column": layout.text_column, "id_column": layout.id_column}
        report["format"].pop("columns")
        report["errors"] = (row_errors + report["errors"])[:ERRORS_KEPT]
        report["ingest_ms"] = int((time.perf_counter() - started) * 1000)

        if rebuild:
            report["rebuild"] = self._rebuild(ctx, None, None)
        if run_cluster and (result.touched_ids or rebuild):
            report["clustering"] = self._cluster(ctx, None, None, min_community_size)
        report["total_ms"] = int((time.perf_counter() - started) * 1000)
        return report

    # ------------------------------------------------------------------ graph operations

    def submit_rebuild(self, neighbor_k: int | None, min_similarity: float | None, cluster: bool):
        def job(ctx: JobContext) -> dict:
            with self.structural(blocking=True):
                result = self._rebuild(ctx, neighbor_k, min_similarity)
                if cluster:
                    result["clustering"] = self._cluster(ctx, None, None)
                return result

        return self.jobs.submit(
            "rebuild", job, params={"neighbor_k": neighbor_k, "min_similarity": min_similarity, "cluster": cluster}
        )

    def submit_cluster(self, gamma: float | None, seed: int | None, min_size: int | None = None):
        def job(ctx: JobContext) -> dict:
            with self.structural(blocking=True):
                return self._cluster(ctx, gamma, seed, min_size)

        return self.jobs.submit(
            "cluster", job, params={"gamma": gamma, "random_seed": seed, "min_community_size": min_size}
        )

    def submit_reconcile(self):
        def job(ctx: JobContext) -> dict:
            with self.structural(blocking=True):
                return self._reconcile(ctx)

        return self.jobs.submit("reconcile", job)

    def rebuild_sync(self, neighbor_k: int | None = None, min_similarity: float | None = None) -> dict:
        with self.structural(blocking=False):
            return self._rebuild(None, neighbor_k, min_similarity)

    def cluster_sync(self, gamma: float | None = None, seed: int | None = None, min_size: int | None = None) -> dict:
        with self.structural(blocking=False):
            return self._cluster(None, gamma, seed, min_size)

    def _rebuild(self, ctx: JobContext | None, neighbor_k: int | None, min_similarity: float | None) -> dict:
        started = time.perf_counter()
        k = neighbor_k if neighbor_k is not None else self._policy[0]
        s = min_similarity if min_similarity is not None else self._policy[1]
        self._policy = (k, s)
        self.graph.save_policy(k, s)
        if ctx:
            ctx.progress("deleting edges", 0, None)
        deleted = self.graph.delete_all_edges()
        ids = list(self.vectors.iter_ids())
        self.graph.upsert_nodes(ids)
        if ctx:
            ctx.progress("waiting for vector index", 0, None)
        self.vectors.wait_until_indexed(self.settings.qdrant_index_wait_seconds)
        edges = self.pipeline.link(ids, progress=ctx.progress if ctx else lambda *_: None)
        return {
            "documents_processed": len(ids),
            "edges_deleted": deleted,
            "edge_upserts": edges,
            "neighbor_k": k,
            "min_similarity": s,
            "rebuild_ms": int((time.perf_counter() - started) * 1000),
        }

    def _cluster(
        self, ctx: JobContext | None, gamma: float | None, seed: int | None, min_size: int | None = None
    ) -> dict:
        started = time.perf_counter()
        gamma = gamma if gamma is not None else self.settings.leiden_gamma
        seed = seed if seed is not None else self.settings.leiden_random_seed
        min_size = max(2, int(min_size)) if min_size is not None else self._min_size
        if self.vectors.count() == 0:
            return {"community_count": 0, "node_properties_written": 0, "modularity": 0.0, "qdrant_payloads_updated": 0}
        if ctx:
            ctx.progress("leiden", 0, None)
        version = self.graph.next_cluster_version()
        leiden = self.graph.run_leiden(gamma, seed)
        # Groups below the minimum size (singletons, mostly) are not communities:
        # they are written back as "no community" everywhere, and the rest renumbered.
        assignments, partition = compact_communities(self.graph.assignments(), min_size)
        self.graph.set_community_ids(assignments)
        if ctx:
            ctx.progress("syncing communities", 0, len(assignments))
        sync_started = time.perf_counter()
        qdrant_future = self.executor.submit(self.vectors.set_communities, assignments, version)
        es_updated = self.es.bulk_set_communities(assignments, version)
        qdrant_updated = qdrant_future.result()
        sync_ms = int((time.perf_counter() - sync_started) * 1000)
        run = {
            **leiden,
            **partition,
            "version": version,
            "gamma": float(gamma),
            "random_seed": int(seed),
            "neighbor_k": self._policy[0],
            "min_similarity": self._policy[1],
            "sync_ms": sync_ms,
            "total_ms": int((time.perf_counter() - started) * 1000),
        }
        self.graph.save_cluster_run(run)
        self._min_size = partition["min_community_size"]
        if ctx:
            ctx.progress("syncing communities", len(assignments), len(assignments))
        return {**run, "qdrant_payloads_updated": qdrant_updated, "es_documents_updated": es_updated}

    def _reconcile(self, ctx: JobContext) -> dict:
        ctx.progress("scanning", 0, None)
        es_ids = set(self.es.iter_ids())
        vector_ids = set(self.vectors.iter_ids())
        missing_vectors = sorted(es_ids - vector_ids)
        orphan_vectors = sorted(vector_ids - es_ids)
        if orphan_vectors:
            self.vectors.delete(orphan_vectors)
            self.graph.delete_nodes(orphan_vectors)
        reembedded: list[str] = []
        chunk = self.settings.ingest_chunk_size
        for start in range(0, len(missing_vectors), chunk):
            ids = missing_vectors[start : start + chunk]
            docs = self.es.fetch_display(ids)
            ids = [i for i in ids if i in docs]
            vectors = self.embedder.encode_documents([docs[i]["text"] for i in ids])
            self.vectors.upsert(ids, vectors, [{"external_id": docs[i]["external_id"], "community_id": None} for i in ids])
            self.graph.upsert_nodes(ids)
            reembedded.extend(ids)
            ctx.progress("re-embedding", start + len(ids), len(missing_vectors))
        orphan_nodes = sorted(set(self.graph.iter_ids()) - es_ids)
        if orphan_nodes:
            self.graph.delete_nodes(orphan_nodes)
        self.graph.upsert_nodes(sorted(es_ids))
        edges = self.pipeline.link(reembedded, progress=ctx.progress) if reembedded else 0
        return {
            "es_documents": len(es_ids),
            "vector_points": len(vector_ids),
            "reembedded": len(reembedded),
            "orphans_removed": len(orphan_vectors),
            "orphan_nodes_removed": len(orphan_nodes),
            "edges_upserted": edges,
        }

    # ------------------------------------------------------------------ documents

    def get_document(self, doc_id: str) -> dict:
        doc = self.es.get(doc_id)
        if doc is None:
            raise NotFoundError(f"Document {doc_id} not found")
        return doc

    def delete_document(self, doc_id: str) -> dict:
        existed = self.es.delete(doc_id)  # authority first; derived stores after
        self.vectors.delete([doc_id])
        self.graph.delete_nodes([doc_id])
        if not existed:
            raise NotFoundError(f"Document {doc_id} not found")
        return {"id": doc_id, "deleted": True}

    def similar(self, doc_id: str, method: str, limit: int) -> list[dict]:
        if self.es.get(doc_id) is None:  # otherwise Qdrant's 404 for query-by-id would surface as a 500
            raise NotFoundError(f"Document {doc_id} not found")
        if method == "keyword":
            return self.es.more_like_this(doc_id, limit)
        if method == "graph":
            rows = self.graph.neighbors(doc_id, limit)
        else:
            points = self.vectors.similar(doc_id, limit)
            rows = [
                {"id": str(p.id), "score": float(p.score), "community_id": (p.payload or {}).get("community_id")}
                for p in points
                if str(p.id) != doc_id
            ][:limit]
        docs = self.es.fetch_display([r["id"] for r in rows])
        return [{**docs[r["id"]], "score": r["score"]} for r in rows if r["id"] in docs]

    def browse(self, **kwargs: Any) -> dict:
        return self.es.browse(**kwargs)

    def lookup_external(self, external_id: str) -> dict:
        return self.get_document(point_id(normalize_external_id(external_id)))

    # ------------------------------------------------------------------ graph & analytics

    def _attach_text(self, graph: dict) -> dict:
        docs = self.es.fetch_display([n["id"] for n in graph["nodes"]])
        for node in graph["nodes"]:
            doc = docs.get(node["id"], {})
            text = doc.get("text", "")
            node["text"] = text if len(text) <= SNIPPET_CHARS else text[:SNIPPET_CHARS] + "…"
            node["external_id"] = doc.get("external_id")
        return graph

    def graph_data(self, limit: int, community_ids: list[int] | None, min_score: float, max_score: float = 1.0) -> dict:
        return self._attach_text(self.graph.graph_data(limit, community_ids, min_score, max_score))

    def ego_graph(self, doc_id: str, hops: int, node_limit: int, min_score: float, max_score: float = 1.0) -> dict:
        return self._attach_text(self.graph.ego_graph(doc_id, hops, node_limit, min_score, max_score))

    def communities(self) -> list[dict]:
        return self.graph.list_communities()

    def community_detail(self, community_id: int, limit: int) -> dict:
        detail = self.graph.community_detail(community_id, limit)
        if not detail["central"]:
            raise NotFoundError(f"Community {community_id} not found")
        docs = self.es.fetch_display([c["id"] for c in detail["central"]])
        detail["central"] = [{**docs.get(c["id"], {}), **c} for c in detail["central"]]
        detail["community_id"] = community_id
        return detail

    def cluster_runs(self, limit: int) -> list[dict]:
        return self.graph.cluster_runs(limit)

    def graph_query(self, req: GraphQueryRequest) -> dict:
        """A subgraph seeded by a question rather than by edge strength.

        With a query the seeds are the ranked search hits (the tree narrows them exactly
        as it narrows /search); without one they are the newest documents matching the
        tree. Seed ranks travel with the graph so the UI can mark what matched.
        """
        warnings: list[str] = []
        tree = req.condition_tree
        if req.query.strip():
            top_k = min(req.limit, 200)
            if req.limit > top_k:
                warnings.append(f"Ranked search returns at most {top_k} seed documents.")
            response, _ = self.search_engine.search(
                SearchRequest(
                    query=req.query,
                    mode=req.mode,
                    top_k=top_k,
                    filters=SearchFilters(condition_tree=tree),
                    highlight=False,
                    facets=False,
                    explain=False,
                )
            )
            seeds = [{"id": hit.id, "rank": rank, "score": hit.score} for rank, hit in enumerate(response.results, 1)]
            matched = response.total_lexical if response.total_lexical is not None else len(seeds)
            warnings.extend(response.warnings)
        else:
            page = self.es.explore(
                query_text="",
                condition_tree=tree,
                sort="updated_at",
                order="desc",
                offset=0,
                size=req.limit,
                facets=False,
                highlight=False,
            )
            seeds = [{"id": item["id"], "rank": rank, "score": None} for rank, item in enumerate(page["items"], 1)]
            matched = page["total"]
        graph = self.graph.subgraph(
            [s["id"] for s in seeds], req.expand, req.neighbor_limit, req.min_score, req.max_score
        )
        return {
            **self._attach_text(graph),
            "seeds": seeds,
            "matched": matched,
            "condition_text": describe_tree(tree),
            "warnings": warnings,
        }

    # ------------------------------------------------------------------ explore

    def explore(self, req: ExploreRequest) -> dict:
        started = time.perf_counter()
        if req.page * req.page_size > EXPLORE_WINDOW:
            raise ValidationFailed(
                f"Offset paging stops at {EXPLORE_WINDOW:,} results; narrow the question or sort the other way.",
                details={"page": req.page, "page_size": req.page_size},
            )
        # Relevance only means something when there is text to be relevant to.
        sort = req.sort if req.sort != "_score" or req.query_text.strip() else "updated_at"
        order = req.order if sort == req.sort else "desc"
        page = self.es.explore(
            query_text=req.query_text,
            condition_tree=req.condition_tree,
            sort=sort,
            order=order,
            offset=(req.page - 1) * req.page_size,
            size=req.page_size,
            facets=req.facets,
            highlight=req.highlight,
        )
        total = page["total"]
        return {
            **page,
            "page": req.page,
            "page_size": req.page_size,
            "pages": min(math.ceil(total / req.page_size), EXPLORE_WINDOW // req.page_size),
            "sort": sort,
            "order": order,
            "condition_text": describe_tree(req.condition_tree),
            "rule_count": count_rules(req.condition_tree),
            "took_ms": int((time.perf_counter() - started) * 1000),
        }

    def explore_insights(self, req: ExploreRequest) -> dict:
        return {
            **self.es.insights(query_text=req.query_text, condition_tree=req.condition_tree),
            "condition_text": describe_tree(req.condition_tree),
            "rule_count": count_rules(req.condition_tree),
        }

    def explore_fields(self) -> dict:
        """The query-builder catalogue: the static field table plus live choices."""
        catalogue = self.es.catalogue(max_keys=self.settings.metadata_max_keys)
        choices: dict[str, list[dict]] = {
            "source": [{"value": b["value"], "label": b["value"], "count": b["count"]} for b in catalogue["sources"]],
            "community_id": [
                {"value": b["value"], "label": f"C{b['value']}", "count": b["count"]}
                for b in sorted(catalogue["communities"], key=lambda b: (-b["count"], b["value"]))
            ],
        }
        fields = [self._field_out(spec, choices.get(spec.name, [])) for spec in FIELD_SPECS]
        for key, values in catalogue["metadata"].items():
            spec = metadata_spec(key)
            fields.append(
                self._field_out(spec, [{"value": v["value"], "label": v["value"], "count": v["count"]} for v in values])
            )
        return {
            "fields": fields,
            "total": catalogue["total"],
            "unassigned": catalogue["unassigned"],
            "sort_fields": ["updated_at", "created_at", "length", "external_id", "community_id", "source", "_score"],
        }

    @staticmethod
    def _field_out(spec, choices: list[dict]) -> dict:
        return {
            "name": spec.name,
            "label": spec.label,
            "kind": spec.kind,
            "operators": list(spec.operators),
            "choices": choices,
            "sortable": spec.sortable,
            "group": spec.group,
            "description": spec.description,
        }

    # ------------------------------------------------------------------ sources

    def sources(self) -> dict:
        return self.es.sources()

    def submit_delete_source(self, source: str | None, cluster: bool):
        if source is not None and not source.strip():
            raise ValidationFailed("source must be a non-empty label, or null for documents without a source")
        listing = {row["source"]: row["documents"] for row in self.es.sources()["sources"]}
        if not listing.get(source):
            raise NotFoundError(f"No documents with source {source!r}" if source is not None else "No documents without a source")

        def job(ctx: JobContext) -> dict:
            with self.structural(blocking=True):
                return self._delete_source(ctx, source, cluster)

        return self.jobs.submit("delete", job, params={"source": source, "cluster": cluster})

    def _delete_source(self, ctx: JobContext, source: str | None, cluster: bool) -> dict:
        """Remove one source from all three stores, authority first.

        ES goes first in every batch (it is the system of record), then the derived
        stores; a crash between them leaves orphans that ``reconcile`` removes, never
        content without its vector.
        """
        started = time.perf_counter()
        ctx.progress("scanning", 0, None)
        ids = self.es.ids_for_source(source)
        ctx.progress("deleting", 0, len(ids))
        deleted = vectors_deleted = nodes_deleted = 0
        for start in range(0, len(ids), 1000):
            batch = ids[start : start + 1000]
            deleted += self.es.bulk_delete(batch)
            vectors_deleted += self.vectors.delete_existing(batch)
            nodes_deleted += self.graph.delete_nodes_counted(batch)
            ctx.progress("deleting", start + len(batch), len(ids))
        clustering = self._cluster(ctx, None, None) if cluster and deleted else None
        return {
            "source": source,
            "deleted": deleted,
            "vectors_deleted": vectors_deleted,
            "nodes_deleted": nodes_deleted,
            "clustering": clustering,
            "total_ms": int((time.perf_counter() - started) * 1000),
        }

    def stats(self) -> dict:
        es_f = self.executor.submit(self.es.stats)
        vec_f = self.executor.submit(self.vectors.stats)
        graph_f = self.executor.submit(self.graph.stats)
        runs_f = self.executor.submit(self.graph.cluster_runs, 1)
        es_stats, vec_stats, graph_stats, runs = es_f.result(), vec_f.result(), graph_f.result(), runs_f.result()
        counts = {es_stats["documents"], vec_stats["points"], graph_stats["nodes"]}
        return {
            # v0.2-compatible flat fields
            "documents": es_stats["documents"],
            "nodes": graph_stats["nodes"],
            "edges": graph_stats["edges"],
            "communities": graph_stats["communities"],
            "embedding_model": self.embedder.model_name,
            "neighbor_k": self._policy[0],
            "min_similarity": self._policy[1],
            "leiden_gamma": self.settings.leiden_gamma,
            # v0.3 detail
            # no community at all; of those, `unclustered` were added or changed since the
            # last run and `outside_communities` were clustered into a group too small
            "unassigned": es_stats["unassigned"],
            "unclustered": es_stats.get("unclustered", es_stats["unassigned"]),
            "outside_communities": es_stats.get("outside_communities", 0),
            "min_community_size": self._min_size,
            "isolated_nodes": graph_stats["isolated_nodes"],
            "mean_degree": graph_stats["mean_degree"],
            "stores": {"elasticsearch": es_stats, "qdrant": vec_stats, "neo4j": graph_stats},
            "consistent": len(counts) == 1,
            "last_cluster_run": runs[0] if runs else None,
            "jobs_active": self.jobs.active(),
            "query_cache": getattr(self.embedder, "cache_stats", lambda: None)(),
        }
