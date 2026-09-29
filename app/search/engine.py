"""Query orchestration across Qdrant (semantic) and Elasticsearch (keyword).

Request lifecycle
-----------------
1. embed query (LRU cached) when the semantic list or auto-routing needs it
2. auto scope: top-R anchors from Qdrant -> community vote -> community set
3. ES-only predicates in semantic/hybrid mode -> ES resolves an ID set that becomes a
   Qdrant ``HasId`` pre-filter (filtering happens *inside* HNSW, not after)
4. semantic and keyword candidate lists run **concurrently**
5. fusion (RRF/DBSF) -> optional MMR diversification
6. hydrate text/metadata/highlights from ES in one request
"""

from __future__ import annotations

import logging
import time
from collections import Counter
from concurrent.futures import Future, ThreadPoolExecutor

import numpy as np

from app.config import Settings
from app.embedder import EmbedderProtocol
from app.errors import NotClusteredError
from app.schemas import (
    FacetBucket,
    FusionMethod,
    HitExplain,
    ScopeType,
    SearchHit,
    SearchMode,
    SearchRequest,
    SearchResponse,
)
from app.search.fusion import Fused, Ranked, dbsf, rrf
from app.search.mmr import mmr_select
from app.search.routing import Anchor, route
from app.stores.elastic import ElasticStore
from app.stores.vectors import VectorStore, community_filter
from app.timing import Stopwatch

log = logging.getLogger(__name__)

SEMANTIC = "semantic"
KEYWORD = "keyword"


def _timed(fn, *args, **kwargs):
    started = time.perf_counter()
    result = fn(*args, **kwargs)
    return result, (time.perf_counter() - started) * 1000


class SearchEngine:
    def __init__(
        self,
        settings: Settings,
        embedder: EmbedderProtocol,
        es: ElasticStore,
        vectors: VectorStore,
        executor: ThreadPoolExecutor,
    ) -> None:
        self.settings = settings
        self.embedder = embedder
        self.es = es
        self.vectors = vectors
        self.executor = executor

    def search(self, req: SearchRequest) -> tuple[SearchResponse, Stopwatch]:
        sw = Stopwatch()
        warnings: list[str] = []
        mode = req.mode
        use_semantic = mode in (SearchMode.semantic, SearchMode.hybrid)
        use_keyword = mode in (SearchMode.keyword, SearchMode.hybrid)

        query_vector: list[float] | None = None
        if use_semantic or req.scope.type == ScopeType.auto:
            with sw.stage("embed"):
                query_vector = self.embedder.encode_query(req.query)

        # -------------------------------------------------------------- scope
        community_ids = list(req.scope.community_ids) if req.scope.type == ScopeType.communities else []
        exclude_ids = list(req.scope.exclude_community_ids)
        routing = None
        if req.scope.type == ScopeType.auto:
            assert query_vector is not None
            with sw.stage("route"):
                points = self.vectors.search(
                    query_vector, req.routing.anchors, community_filter(exclude_community_ids=exclude_ids)
                )
                anchors = [
                    Anchor(str(p.id), float(p.score), (p.payload or {}).get("community_id")) for p in points
                ]
                routing = route(anchors, req.routing)
            if not anchors:
                return self._empty(req, sw, warnings), sw
            if not routing.selected:
                raise NotClusteredError("No community assignments found yet. Run clustering (POST /jobs/cluster).")
            community_ids = routing.selected

        # -------------------------------------------------------------- candidate depth
        depth = req.top_k
        if mode == SearchMode.hybrid:
            depth = req.fusion.candidates or min(max(req.top_k * 3, 50), 500)
        if req.mmr.enabled:
            depth = max(depth, req.mmr.candidates)

        # -------------------------------------------------------------- ES-driven pre-filter for Qdrant
        prefilter_ids: list[str] | None = None
        if use_semantic and req.filters.has_es_only_predicates():
            with sw.stage("prefilter"):
                prefilter_ids, matched = self.es.filter_ids(
                    req.filters,
                    community_ids=community_ids or None,
                    exclude_community_ids=exclude_ids or None,
                    limit=self.settings.search_prefilter_limit,
                )
            if matched > len(prefilter_ids):
                warnings.append(
                    f"Filters matched {matched}+ documents; semantic ranking was restricted to the first "
                    f"{len(prefilter_ids)}. Narrow the filters for exact results."
                )

        # -------------------------------------------------------------- run engines concurrently
        dense_future: Future | None = None
        lexical_future: Future | None = None
        if use_semantic and (prefilter_ids is None or prefilter_ids):
            q_filter = community_filter(
                community_ids=community_ids or None,
                exclude_community_ids=exclude_ids or None,
                ids=prefilter_ids,
                unassigned_only=req.filters.unassigned_only,
            )
            dense_future = self.executor.submit(
                _timed, self.vectors.search, query_vector, depth, q_filter, req.min_score
            )
        if use_keyword:
            lexical_future = self.executor.submit(
                _timed,
                self.es.search_lexical,
                req.query,
                size=depth,
                options=req.lexical,
                filters=req.filters,
                community_ids=community_ids or None,
                exclude_community_ids=exclude_ids or None,
                highlight=req.highlight,
                facets=req.facets,
            )

        dense_points = []
        if dense_future is not None:
            dense_points, ms = dense_future.result()
            sw.record("vector", ms)
        lexical: dict = {"hits": [], "total": 0}
        if lexical_future is not None:
            lexical, ms = lexical_future.result()
            sw.record("keyword", ms)

        semantic_list = [Ranked(str(p.id), float(p.score)) for p in dense_points]
        keyword_list = [Ranked(h["id"], h["score"]) for h in lexical["hits"]]

        # -------------------------------------------------------------- fuse
        with sw.stage("fusion"):
            if mode == SearchMode.hybrid:
                lists = {SEMANTIC: semantic_list, KEYWORD: keyword_list}
                weights = {SEMANTIC: req.fusion.alpha, KEYWORD: 1.0 - req.fusion.alpha}
                ordered = (
                    rrf(lists, weights, k=req.fusion.rrf_k)
                    if req.fusion.method == FusionMethod.rrf
                    else dbsf(lists, weights)
                )
            else:
                name, source = (SEMANTIC, semantic_list) if mode == SearchMode.semantic else (KEYWORD, keyword_list)
                ordered = [Fused(r.id, r.score, {name: (i, r.score)}) for i, r in enumerate(source, start=1)]

        # -------------------------------------------------------------- diversify
        mmr_ranks: dict[str, int] = {}
        if req.mmr.enabled and len(ordered) > 1:
            with sw.stage("mmr"):
                pool = ordered[: req.mmr.candidates]
                vectors = self.vectors.vectors_for([f.id for f in pool])
                pool = [f for f in pool if f.id in vectors]
                if pool:
                    matrix = np.stack([vectors[f.id] for f in pool])
                    picks = mmr_select(np.array([f.score for f in pool]), matrix, req.top_k, req.mmr.lambda_)
                    final = [pool[i] for i in picks]
                    mmr_ranks = {f.id: i for i, f in enumerate(final, start=1)}
                else:
                    final = ordered[: req.top_k]
        else:
            final = ordered[: req.top_k]

        # -------------------------------------------------------------- hydrate from ES
        docs = {h["id"]: h for h in lexical["hits"]}
        missing = [f.id for f in final if f.id not in docs]
        if missing:
            with sw.stage("hydrate"):
                docs.update(
                    self.es.fetch_display(missing, query=req.query, lexical=req.lexical, highlight=req.highlight)
                )

        results: list[SearchHit] = []
        orphaned = 0
        for fused in final:
            doc = docs.get(fused.id)
            if doc is None:
                orphaned += 1
                continue
            sem = fused.components.get(SEMANTIC)
            kw = fused.components.get(KEYWORD)
            results.append(
                SearchHit(
                    id=fused.id,
                    external_id=doc.get("external_id"),
                    text=doc.get("text", ""),
                    score=round(fused.score, 6),
                    community_id=doc.get("community_id"),
                    source=doc.get("source"),
                    metadata=doc.get("metadata"),
                    highlights=doc.get("highlights") or [],
                    explain=HitExplain(
                        semantic_rank=sem[0] if sem else None,
                        semantic_score=round(sem[1], 6) if sem else None,
                        keyword_rank=kw[0] if kw else None,
                        keyword_score=round(kw[1], 6) if kw else None,
                        fused_score=round(fused.score, 6) if mode == SearchMode.hybrid else None,
                        mmr_rank=mmr_ranks.get(fused.id),
                    )
                    if req.explain
                    else None,
                )
            )
        if orphaned:
            warnings.append(f"{orphaned} vector hit(s) have no content in Elasticsearch; run a reconcile/re-import.")

        # -------------------------------------------------------------- facets
        facets: dict[str, list[FacetBucket]] = {}
        facet_source = "none"
        if req.facets and "facets" in lexical:
            facets = {k: [FacetBucket(**b) for b in v] for k, v in lexical["facets"].items()}
            facet_source = "keyword"
        elif req.facets and dense_points:
            counts = Counter((p.payload or {}).get("community_id") for p in dense_points)
            facets = {
                "communities": [FacetBucket(value=cid, count=n) for cid, n in counts.most_common(50)]
            }
            facet_source = "candidates"

        response = SearchResponse(
            mode=mode,
            results=results,
            total_lexical=lexical.get("total") if use_keyword else None,
            routing=routing,
            facets=facets,
            facet_source=facet_source,  # type: ignore[arg-type]
            warnings=warnings,
            community_id=routing.selected[0] if routing and routing.selected else None,
            anchor_document_id=routing.anchor_document_id if routing else None,
            anchor_score=routing.anchor_score if routing else None,
        )
        response.timings = sw.as_dict()
        return response, sw

    def _empty(self, req: SearchRequest, sw: Stopwatch, warnings: list[str]) -> SearchResponse:
        return SearchResponse(mode=req.mode, results=[], warnings=warnings, timings=sw.as_dict())
