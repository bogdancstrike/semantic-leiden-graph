"""Elasticsearch: authority for content, metadata and full-text retrieval.

Physical layout
---------------
* The application talks to an *alias* (``ES_INDEX``, default ``documents``).
* The alias points at ``<alias>-v1``. A future mapping change creates ``-v2``, reindexes,
  and flips the alias atomically -- zero-downtime migrations without touching the app.

Mapping highlights
------------------
* ``dynamic: strict`` -- typos in field names fail loudly instead of silently creating
  garbage fields.
* ``text`` uses the ``standard`` analyzer; ``text.folded`` adds ``asciifolding`` so
  ``cai ferate`` matches ``căi ferate`` (diacritics are routinely dropped in Romanian and
  other languages when people type queries).
* ``metadata`` is ``flattened``: arbitrary CSV extra columns become filterable keyword
  leaves without a mapping explosion.
* Highlights use control characters (U+0002/U+0003) as tags so the UI can split
  fragments into React nodes without ``innerHTML`` -- no XSS surface.
"""

from __future__ import annotations

import base64
import json
import logging
from collections.abc import Iterable
from datetime import datetime, timezone
from typing import Any

from elasticsearch import Elasticsearch
from elasticsearch import NotFoundError as ESNotFound

from app.config import Settings
from app.errors import DependencyUnavailable, ValidationFailed
from app.ids import normalize_metadata_key
from app.schemas import LexicalOptions, SearchFilters
from app.search.conditions import compile_tree

log = logging.getLogger(__name__)

HL_PRE = "\u0002"
HL_POST = "\u0003"
UNASSIGNED_BUCKET = -1

INDEX_SETTINGS: dict[str, Any] = {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "refresh_interval": "1s",
    "analysis": {
        "analyzer": {
            "folded": {"type": "custom", "tokenizer": "standard", "filter": ["lowercase", "asciifolding"]},
        }
    },
}

INDEX_MAPPINGS: dict[str, Any] = {
    "dynamic": "strict",
    "properties": {
        "external_id": {"type": "keyword"},
        "text": {
            "type": "text",
            "analyzer": "standard",
            "fields": {"folded": {"type": "text", "analyzer": "folded"}},
        },
        "text_hash": {"type": "keyword", "index": False},
        "length": {"type": "integer"},
        "source": {"type": "keyword"},
        "metadata": {"type": "flattened"},
        "community_id": {"type": "integer"},
        "community_version": {"type": "integer"},
        "embedding_model": {"type": "keyword"},
        "created_at": {"type": "date"},
        "updated_at": {"type": "date"},
    },
}

DISPLAY_FIELDS = [
    "external_id",
    "text",
    "community_id",
    "community_version",
    "source",
    "length",
    "metadata",
    "created_at",
    "updated_at",
]


#: Document-length histogram edges (characters). Fixed rather than computed so two
#: questions' distributions can be compared bucket by bucket.
LENGTH_RANGES: list[tuple[int, int | None]] = [
    (0, 50), (50, 100), (100, 200), (200, 400), (400, 800), (800, 1600), (1600, 3200), (3200, None),
]


def _range_label(low: int, high: int | None) -> str:
    return f"{low}–{high}" if high is not None else f"{low}+"


def _community_buckets(agg: dict) -> list[dict]:
    return [
        {"value": None if b["key"] == UNASSIGNED_BUCKET else int(b["key"]), "count": b["doc_count"]}
        for b in agg.get("buckets", [])
    ]


# A document with no community is either *unclustered* (added or changed since the last
# Leiden run, so it has no run version) or *outside* every community (clustered, but
# into a group smaller than the minimum community size).
_COMMUNITY_STATE_AGGS: dict[str, Any] = {
    "unassigned": {"missing": {"field": "community_id"}},
    "unclustered": {"missing": {"field": "community_version"}},
    "outside": {
        "filter": {
            "bool": {
                "filter": [{"exists": {"field": "community_version"}}],
                "must_not": [{"exists": {"field": "community_id"}}],
            }
        }
    },
}


def _community_state(aggs: dict) -> dict[str, int]:
    return {
        "unassigned": int(aggs.get("unassigned", {}).get("doc_count") or 0),
        "unclustered": int(aggs.get("unclustered", {}).get("doc_count") or 0),
        "outside_communities": int(aggs.get("outside", {}).get("doc_count") or 0),
    }


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode_cursor(values: list[Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(values).encode()).decode()


def decode_cursor(cursor: str) -> list[Any]:
    try:
        values = json.loads(base64.urlsafe_b64decode(cursor.encode()).decode())
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValidationFailed("Invalid pagination cursor") from exc
    if not isinstance(values, list) or len(values) != 2:
        raise ValidationFailed("Invalid pagination cursor")
    return values


def build_filters(
    filters: SearchFilters | None,
    *,
    community_ids: list[int] | None = None,
    exclude_community_ids: list[int] | None = None,
) -> tuple[list[dict], list[dict]]:
    """Translate API filters into ES ``filter`` / ``must_not`` clause lists."""
    must: list[dict] = []
    must_not: list[dict] = []
    if community_ids:
        must.append({"terms": {"community_id": community_ids}})
    if exclude_community_ids:
        must_not.append({"terms": {"community_id": exclude_community_ids}})
    if filters is None:
        return must, must_not
    if filters.unassigned_only:
        must_not.append({"exists": {"field": "community_id"}})
    if filters.must_text:
        must.append(
            {
                "simple_query_string": {
                    "query": filters.must_text,
                    "fields": ["text", "text.folded"],
                    "default_operator": "AND",
                    "lenient": True,
                }
            }
        )
    if filters.exclude_text:
        must_not.append(
            {"simple_query_string": {"query": filters.exclude_text, "fields": ["text", "text.folded"], "lenient": True}}
        )
    length_range: dict[str, int] = {}
    if filters.length_min is not None:
        length_range["gte"] = filters.length_min
    if filters.length_max is not None:
        length_range["lte"] = filters.length_max
    if length_range:
        must.append({"range": {"length": length_range}})
    if filters.sources:
        must.append({"terms": {"source": filters.sources}})
    for key, value in filters.metadata.items():
        # keys are normalised the same way at ingest time ("Desk " -> "desk")
        normalised = normalize_metadata_key(key)
        if normalised:
            must.append({"term": {f"metadata.{normalised}": value}})
    date_range: dict[str, str] = {}
    if filters.updated_after:
        date_range["gte"] = filters.updated_after.isoformat()
    if filters.updated_before:
        date_range["lte"] = filters.updated_before.isoformat()
    if date_range:
        must.append({"range": {"updated_at": date_range}})
    if filters.condition_tree:
        clause = compile_tree(filters.condition_tree)
        if clause is not None:
            must.append(clause)
    return must, must_not


def lexical_query(query: str, options: LexicalOptions) -> dict:
    fields = ["text^1.0", "text.folded^0.7"]
    if options.syntax == "advanced":
        main: dict = {
            "simple_query_string": {
                "query": query,
                "fields": fields,
                "default_operator": options.operator.upper(),
                "flags": "ALL",
                "lenient": True,
            }
        }
    else:
        multi: dict[str, Any] = {"query": query, "fields": fields, "type": "best_fields", "operator": options.operator}
        if options.fuzzy:
            multi["fuzziness"] = "AUTO"
            multi["prefix_length"] = 1
        if options.minimum_should_match and options.operator == "or":
            multi["minimum_should_match"] = options.minimum_should_match
        main = {"multi_match": multi}
    should = []
    if options.phrase_boost:
        should.append({"match_phrase": {"text": {"query": query, "slop": 2, "boost": 2.0}}})
    return {"bool": {"must": [main], "should": should}}


def highlight_config() -> dict:
    field_cfg = {"fragment_size": 180, "number_of_fragments": 3, "no_match_size": 0}
    return {
        "pre_tags": [HL_PRE],
        "post_tags": [HL_POST],
        "require_field_match": False,
        "fields": {"text": field_cfg, "text.folded": field_cfg},
    }


def pick_highlights(hit: dict) -> list[str]:
    hl = hit.get("highlight") or {}
    return hl.get("text") or hl.get("text.folded") or []


class ElasticStore:
    def __init__(self, settings: Settings, client: Elasticsearch | None = None) -> None:
        self.settings = settings
        self.alias = settings.es_index
        self.physical_index = f"{settings.es_index}-v1"
        self.client = client or self._build_client(settings)

    @staticmethod
    def _build_client(settings: Settings) -> Elasticsearch:
        kwargs: dict[str, Any] = {
            "request_timeout": settings.es_request_timeout,
            "retry_on_timeout": True,
            "max_retries": 3,
            "verify_certs": settings.es_verify_certs,
        }
        if settings.es_ca_certs:
            kwargs["ca_certs"] = settings.es_ca_certs
        if settings.es_api_key:
            kwargs["api_key"] = settings.es_api_key.get_secret_value()
        elif settings.es_username and settings.es_password:
            kwargs["basic_auth"] = (settings.es_username, settings.es_password.get_secret_value())
        return Elasticsearch(settings.es_url, **kwargs)

    # ------------------------------------------------------------------ lifecycle

    def ping(self) -> bool:
        try:
            return bool(self.client.ping())
        except Exception:  # noqa: BLE001 - readiness probe must never raise
            return False

    def ensure_index(self) -> None:
        if not self.client.ping():
            raise DependencyUnavailable("Elasticsearch is not reachable")
        if self.client.indices.exists_alias(name=self.alias):
            return
        if self.client.indices.exists(index=self.alias):
            # A concrete index named like the alias (v0.2 layouts or manual creation).
            log.warning("Index %s exists as a concrete index; using it directly", self.alias)
            return
        self.client.indices.create(
            index=self.physical_index,
            settings=INDEX_SETTINGS,
            mappings=INDEX_MAPPINGS,
            aliases={self.alias: {"is_write_index": True}},
        )
        log.info("Created Elasticsearch index %s with alias %s", self.physical_index, self.alias)

    def refresh(self) -> None:
        self.client.indices.refresh(index=self.alias)

    # ------------------------------------------------------------------ writes

    def get_state(self, ids: list[str]) -> dict[str, dict]:
        """Current state + concurrency token (seq_no/primary_term) for change detection."""
        if not ids:
            return {}
        response = self.client.mget(
            index=self.alias,
            ids=ids,
            source_includes=["text_hash", "metadata", "community_id", "community_version", "source", "created_at"],
        )
        return {
            doc["_id"]: {**doc.get("_source", {}), "_seq_no": doc.get("_seq_no"), "_primary_term": doc.get("_primary_term")}
            for doc in response["docs"]
            if doc.get("found")
        }

    def bulk_upsert(self, docs: list[dict]) -> dict[str, str]:
        """Write complete documents. Returns {id: error} for failed items.

        Full ``index`` operations, not partial ``update``: an update's ``doc`` is
        deep-merged into ``_source``, so a metadata key removed from the CSV would
        survive forever and change detection would never converge.

        Optimistic concurrency: existing documents are written with the
        ``if_seq_no``/``if_primary_term`` read during change detection, new ones with
        ``create``. A concurrent writer (e.g. a community sync) therefore produces a
        reported version conflict instead of a silent lost update.
        """
        if not docs:
            return {}
        now = utcnow()
        operations: list[dict] = []
        for doc in docs:
            meta: dict[str, Any] = {"_index": self.alias, "_id": doc["id"]}
            body = {k: v for k, v in doc.items() if k not in ("id", "_seq_no", "_primary_term")}
            body["updated_at"] = now
            if not body.get("created_at"):
                body["created_at"] = now
            if doc.get("_seq_no") is not None and doc.get("_primary_term") is not None:
                meta["if_seq_no"] = doc["_seq_no"]
                meta["if_primary_term"] = doc["_primary_term"]
                operations.append({"index": meta})
            else:
                operations.append({"create": meta})
            operations.append(body)
        response = self.client.bulk(operations=operations, refresh=False)
        return self._bulk_errors(response)

    def bulk_set_communities(self, assignments: list[tuple[str, int]], version: int) -> int:
        updated = 0
        size = self.settings.sync_batch_size
        for start in range(0, len(assignments), size):
            operations: list[dict] = []
            for doc_id, community_id in assignments[start : start + size]:
                operations.append({"update": {"_index": self.alias, "_id": doc_id, "retry_on_conflict": 3}})
                operations.append({"doc": {"community_id": community_id, "community_version": version}})
            response = self.client.bulk(operations=operations, refresh=False)
            errors = self._bulk_errors(response)
            updated += len(operations) // 2 - len(errors)
            if errors:
                log.warning("Community sync: %d ES updates failed (e.g. %s)", len(errors), next(iter(errors.items())))
        self.refresh()
        return updated

    def delete(self, doc_id: str) -> bool:
        try:
            self.client.delete(index=self.alias, id=doc_id, refresh="wait_for")
            return True
        except ESNotFound:
            return False

    @staticmethod
    def _bulk_errors(response: Any) -> dict[str, str]:
        if not response.get("errors"):
            return {}
        failed: dict[str, str] = {}
        for item in response["items"]:
            action = next(iter(item.values()))
            if action.get("error"):
                error = action["error"]
                failed[action["_id"]] = f"{error.get('type')}: {error.get('reason')}"
        return failed

    # ------------------------------------------------------------------ reads

    def get(self, doc_id: str) -> dict | None:
        try:
            doc = self.client.get(index=self.alias, id=doc_id, source_includes=DISPLAY_FIELDS)
        except ESNotFound:
            return None
        return {"id": doc["_id"], **doc["_source"]}

    def fetch_display(
        self,
        ids: list[str],
        *,
        query: str | None = None,
        lexical: LexicalOptions | None = None,
        highlight: bool = False,
    ) -> dict[str, dict]:
        """Sources for ``ids`` plus optional highlights for ``query``.

        One request per 1,000 ids (a single request is the normal case); chunking keeps
        large graph views below ``index.max_result_window`` (10,000).
        """
        if not ids:
            return {}
        if len(ids) > 1000:
            merged: dict[str, dict] = {}
            for start in range(0, len(ids), 1000):
                merged.update(
                    self.fetch_display(ids[start : start + 1000], query=query, lexical=lexical, highlight=highlight)
                )
            return merged
        body_query: dict = {"bool": {"filter": [{"ids": {"values": ids}}]}}
        kwargs: dict[str, Any] = {}
        if highlight and query:
            body_query["bool"]["should"] = [lexical_query(query, lexical or LexicalOptions())]
            kwargs["highlight"] = highlight_config()
        response = self.client.search(
            index=self.alias,
            query=body_query,
            size=len(ids),
            source_includes=DISPLAY_FIELDS,
            track_total_hits=False,
            **kwargs,
        )
        return {
            hit["_id"]: {"id": hit["_id"], **hit["_source"], "highlights": pick_highlights(hit)}
            for hit in response["hits"]["hits"]
        }

    def search_lexical(
        self,
        query: str,
        *,
        size: int,
        options: LexicalOptions,
        filters: SearchFilters | None,
        community_ids: list[int] | None,
        exclude_community_ids: list[int] | None,
        highlight: bool,
        facets: bool,
    ) -> dict:
        """BM25 search.

        Community selection is applied as a ``post_filter`` so the community facet is
        computed over *all* matching documents -- the classic faceted-search pattern that
        lets the UI show "n matches in other communities".
        """
        must, must_not = build_filters(filters)
        q = lexical_query(query, options)
        q["bool"]["filter"] = must
        q["bool"]["must_not"] = must_not

        post_must, post_must_not = build_filters(
            None, community_ids=community_ids, exclude_community_ids=exclude_community_ids
        )
        kwargs: dict[str, Any] = {}
        if post_must or post_must_not:
            kwargs["post_filter"] = {"bool": {"filter": post_must, "must_not": post_must_not}}
        if highlight:
            kwargs["highlight"] = highlight_config()
        if facets:
            kwargs["aggs"] = {
                "communities": {"terms": {"field": "community_id", "size": 50, "missing": UNASSIGNED_BUCKET}},
                "sources": {"terms": {"field": "source", "size": 20}},
            }
        response = self.client.search(
            index=self.alias,
            query=q,
            size=size,
            source_includes=DISPLAY_FIELDS,
            track_total_hits=10_000,
            **kwargs,
        )
        hits = [
            {"id": h["_id"], "score": float(h["_score"] or 0.0), **h["_source"], "highlights": pick_highlights(h)}
            for h in response["hits"]["hits"]
        ]
        result: dict[str, Any] = {"hits": hits, "total": int(response["hits"]["total"]["value"])}
        if facets:
            aggs = response.get("aggregations", {})
            result["facets"] = {
                "communities": [
                    {"value": None if b["key"] == UNASSIGNED_BUCKET else int(b["key"]), "count": b["doc_count"]}
                    for b in aggs.get("communities", {}).get("buckets", [])
                ],
                "sources": [{"value": b["key"], "count": b["doc_count"]} for b in aggs.get("sources", {}).get("buckets", [])],
            }
        return result

    def filter_ids(
        self,
        filters: SearchFilters,
        *,
        community_ids: list[int] | None,
        exclude_community_ids: list[int] | None,
        limit: int,
    ) -> tuple[list[str], int]:
        """Resolve ES-only predicates to an ID set used as a Qdrant pre-filter."""
        must, must_not = build_filters(filters, community_ids=community_ids, exclude_community_ids=exclude_community_ids)
        response = self.client.search(
            index=self.alias,
            query={"bool": {"filter": must, "must_not": must_not}},
            size=limit,
            source=False,
            track_total_hits=limit + 1,
        )
        ids = [hit["_id"] for hit in response["hits"]["hits"]]
        return ids, int(response["hits"]["total"]["value"])

    def more_like_this(self, doc_id: str, size: int) -> list[dict]:
        response = self.client.search(
            index=self.alias,
            query={
                "more_like_this": {
                    "fields": ["text", "text.folded"],
                    "like": [{"_index": self.alias, "_id": doc_id}],
                    "min_term_freq": 1,
                    "min_doc_freq": 1,
                    "max_query_terms": 30,
                }
            },
            size=size,
            source_includes=DISPLAY_FIELDS,
        )
        return [{"id": h["_id"], "score": float(h["_score"] or 0.0), **h["_source"]} for h in response["hits"]["hits"]]

    def browse(
        self,
        *,
        limit: int,
        cursor: str | None,
        query: str | None,
        community_id: int | None,
        unassigned: bool,
        source: str | None,
        external_id: str | None,
    ) -> dict:
        must: list[dict] = []
        must_not: list[dict] = []
        if query:
            must.append(
                {"simple_query_string": {"query": query, "fields": ["text", "text.folded", "external_id"], "lenient": True}}
            )
        if community_id is not None:
            must.append({"term": {"community_id": community_id}})
        if unassigned:
            must_not.append({"exists": {"field": "community_id"}})
        if source:
            must.append({"term": {"source": source}})
        if external_id:
            must.append({"term": {"external_id": external_id}})
        kwargs: dict[str, Any] = {}
        if cursor:
            kwargs["search_after"] = decode_cursor(cursor)
        response = self.client.search(
            index=self.alias,
            query={"bool": {"filter": must, "must_not": must_not}},
            size=limit,
            sort=[{"updated_at": "desc"}, {"external_id": "asc"}],
            source_includes=DISPLAY_FIELDS,
            track_total_hits=True,
            **kwargs,
        )
        hits = response["hits"]["hits"]
        items = [{"id": h["_id"], **h["_source"]} for h in hits]
        next_cursor = encode_cursor(hits[-1]["sort"]) if len(hits) == limit else None
        return {"items": items, "total": int(response["hits"]["total"]["value"]), "next_cursor": next_cursor}

    # ------------------------------------------------------------------ explore

    @staticmethod
    def explore_query(query_text: str, condition_tree: dict | None) -> dict:
        """The one ``bool`` both the explore list and its insights run.

        Shared so the summary above a list can never describe different rows from the
        list itself. The quick text goes in ``must`` (it scores); the tree in ``filter``.
        """
        must: list[dict] = []
        filters: list[dict] = []
        if query_text.strip():
            must.append(
                {
                    "simple_query_string": {
                        "query": query_text,
                        "fields": ["text", "text.folded", "external_id"],
                        "default_operator": "AND",
                        "lenient": True,
                    }
                }
            )
        clause = compile_tree(condition_tree)
        if clause is not None:
            filters.append(clause)
        if not must and not filters:
            return {"match_all": {}}
        return {"bool": {"must": must, "filter": filters}}

    def explore(
        self,
        *,
        query_text: str,
        condition_tree: dict | None,
        sort: str,
        order: str,
        offset: int,
        size: int,
        facets: bool,
        highlight: bool,
    ) -> dict:
        kwargs: dict[str, Any] = {}
        if highlight and query_text.strip():
            kwargs["highlight"] = highlight_config()
        if facets:
            kwargs["aggs"] = {
                "community_id": {"terms": {"field": "community_id", "size": 50, "missing": UNASSIGNED_BUCKET}},
                "source": {"terms": {"field": "source", "size": 20}},
            }
        primary = {"_score": {"order": order}} if sort == "_score" else {sort: {"order": order, "missing": "_last"}}
        response = self.client.search(
            index=self.alias,
            query=self.explore_query(query_text, condition_tree),
            from_=offset,
            size=size,
            sort=[primary, {"external_id": {"order": "asc"}}],
            source_includes=DISPLAY_FIELDS,
            track_total_hits=True,
            track_scores=bool(query_text.strip()),
            **kwargs,
        )
        total = response["hits"]["total"]
        result: dict[str, Any] = {
            "items": [
                {
                    "id": h["_id"],
                    **h["_source"],
                    "highlights": pick_highlights(h),
                    "score": float(h["_score"]) if h.get("_score") is not None else None,
                }
                for h in response["hits"]["hits"]
            ],
            "total": int(total["value"]),
            "total_relation": total.get("relation", "eq"),
            "facets": {},
        }
        if facets:
            aggs = response.get("aggregations", {})
            result["facets"] = {
                "community_id": _community_buckets(aggs.get("community_id", {})),
                "source": [{"value": b["key"], "count": b["doc_count"]} for b in aggs.get("source", {}).get("buckets", [])],
            }
        return result

    def insights(self, *, query_text: str, condition_tree: dict | None) -> dict:
        """What a question adds up to, in one ``size: 0`` request."""
        ranges = [{"key": _range_label(lo, hi), "from": lo, **({"to": hi} if hi else {})} for lo, hi in LENGTH_RANGES]
        response = self.client.search(
            index=self.alias,
            query=self.explore_query(query_text, condition_tree),
            size=0,
            track_total_hits=True,
            aggs={
                "communities": {"terms": {"field": "community_id", "size": 30, "missing": UNASSIGNED_BUCKET}},
                "community_count": {"cardinality": {"field": "community_id"}},
                **_COMMUNITY_STATE_AGGS,
                "sources": {"terms": {"field": "source", "size": 20}},
                "source_count": {"cardinality": {"field": "source"}},
                "length": {"stats": {"field": "length"}},
                "length_buckets": {"range": {"field": "length", "ranges": ranges}},
                "timeline": {"auto_date_histogram": {"field": "created_at", "buckets": 30}},
            },
        )
        aggs = response.get("aggregations", {})
        length = aggs.get("length", {})
        timeline = aggs.get("timeline", {})
        total = int(response["hits"]["total"]["value"])
        return {
            "total": total,
            "metrics": {
                "documents": total,
                "communities": int(aggs.get("community_count", {}).get("value") or 0),
                **_community_state(aggs),
                "avg_length": round(length["avg"], 1) if length.get("avg") is not None else None,
                "min_length": int(length["min"]) if length.get("min") is not None else None,
                "max_length": int(length["max"]) if length.get("max") is not None else None,
                "sources": int(aggs.get("source_count", {}).get("value") or 0),
            },
            "communities": _community_buckets(aggs.get("communities", {})),
            "sources": [{"value": b["key"], "count": b["doc_count"]} for b in aggs.get("sources", {}).get("buckets", [])],
            "length_buckets": [
                {"label": b["key"], "from": int(b.get("from", 0)), "to": int(b["to"]) if "to" in b else None, "count": b["doc_count"]}
                for b in aggs.get("length_buckets", {}).get("buckets", [])
            ],
            "timeline": [
                {"bucket": b.get("key_as_string") or b["key"], "count": b["doc_count"]} for b in timeline.get("buckets", [])
            ],
            "timeline_interval": timeline.get("interval"),
        }

    def catalogue(self, *, sample: int = 500, max_keys: int = 20, values_per_key: int = 50) -> dict:
        """Choices for the query builder, in two requests.

        Keys of a ``flattened`` field are not in the mapping and cannot be aggregated,
        so they are discovered from the most recently updated documents; their values
        then come from one terms aggregation per key.
        """
        # Sampled among documents that *have* metadata: a large import without extra
        # columns would otherwise push every keyed document out of the sample.
        # Aggregations are global so the counts still describe the whole corpus.
        first = self.client.search(
            index=self.alias,
            query={"exists": {"field": "metadata"}},
            size=sample,
            sort=[{"updated_at": {"order": "desc", "missing": "_last"}}],
            source_includes=["metadata"],
            track_total_hits=False,
            aggs={
                "all": {
                    "global": {},
                    "aggs": {
                        "sources": {"terms": {"field": "source", "size": 100}},
                        "communities": {"terms": {"field": "community_id", "size": 500}},
                        "unassigned": {"missing": {"field": "community_id"}},
                    },
                }
            },
        )
        frequency: dict[str, int] = {}
        for hit in first["hits"]["hits"]:
            for key in (hit.get("_source") or {}).get("metadata") or {}:
                frequency[key] = frequency.get(key, 0) + 1
        keys = [k for k, _ in sorted(frequency.items(), key=lambda kv: (-kv[1], kv[0]))[:max_keys]]
        metadata: dict[str, list[dict]] = {}
        if keys:
            second = self.client.search(
                index=self.alias,
                size=0,
                aggs={f"k{i}": {"terms": {"field": f"metadata.{key}", "size": values_per_key}} for i, key in enumerate(keys)},
            )
            aggs = second.get("aggregations", {})
            metadata = {
                key: [{"value": b["key"], "count": b["doc_count"]} for b in aggs.get(f"k{i}", {}).get("buckets", [])]
                for i, key in enumerate(keys)
            }
        aggs = first.get("aggregations", {}).get("all", {})
        return {
            "total": int(aggs.get("doc_count") or 0),
            "sources": [{"value": b["key"], "count": b["doc_count"]} for b in aggs.get("sources", {}).get("buckets", [])],
            "communities": [
                {"value": int(b["key"]), "count": b["doc_count"]} for b in aggs.get("communities", {}).get("buckets", [])
            ],
            "unassigned": int(aggs.get("unassigned", {}).get("doc_count") or 0),
            "metadata": metadata,
        }

    # ------------------------------------------------------------------ sources

    @staticmethod
    def _source_query(source: str | None) -> dict:
        """``None`` is the bucket of documents that carry no source label at all."""
        if source is None:
            return {"bool": {"must_not": [{"exists": {"field": "source"}}]}}
        return {"term": {"source": source}}

    def sources(self) -> dict:
        """Every import source with its size and age, in one aggregation request."""
        per_bucket = {
            "first_created": {"min": {"field": "created_at"}},
            "last_updated": {"max": {"field": "updated_at"}},
            **_COMMUNITY_STATE_AGGS,
        }
        response = self.client.search(
            index=self.alias,
            size=0,
            track_total_hits=True,
            aggs={
                "sources": {"terms": {"field": "source", "size": 500}, "aggs": per_bucket},
                "no_source": {"missing": {"field": "source"}, "aggs": per_bucket},
            },
        )
        aggs = response.get("aggregations", {})

        def row(source: str | None, bucket: dict) -> dict:
            return {
                "source": source,
                "documents": int(bucket["doc_count"]),
                **_community_state(bucket),
                "first_created": bucket.get("first_created", {}).get("value_as_string"),
                "last_updated": bucket.get("last_updated", {}).get("value_as_string"),
            }

        rows = [row(b["key"], b) for b in aggs.get("sources", {}).get("buckets", [])]
        missing = aggs.get("no_source", {})
        if missing.get("doc_count"):
            rows.append(row(None, missing))
        rows.sort(key=lambda r: (-r["documents"], r["source"] or ""))
        return {"sources": rows, "total": int(response["hits"]["total"]["value"])}

    def ids_for_source(self, source: str | None, batch: int = 1000) -> list[str]:
        """All document ids of one source, walked with ``search_after`` (no 10k window)."""
        ids: list[str] = []
        search_after = None
        while True:
            kwargs: dict[str, Any] = {"search_after": search_after} if search_after else {}
            response = self.client.search(
                index=self.alias,
                query=self._source_query(source),
                size=batch,
                sort=[{"external_id": "asc"}],
                source=False,
                track_total_hits=False,
                **kwargs,
            )
            hits = response["hits"]["hits"]
            ids.extend(hit["_id"] for hit in hits)
            if len(hits) < batch:
                return ids
            search_after = hits[-1]["sort"]

    def bulk_delete(self, ids: list[str]) -> int:
        """Delete by id; returns how many existed. Refreshes so listings agree at once."""
        if not ids:
            return 0
        response = self.client.bulk(
            operations=[{"delete": {"_index": self.alias, "_id": doc_id}} for doc_id in ids], refresh="wait_for"
        )
        return sum(1 for item in response["items"] if item.get("delete", {}).get("result") == "deleted")

    def iter_ids(self, batch: int = 1000) -> Iterable[str]:
        search_after = None
        while True:
            kwargs: dict[str, Any] = {"search_after": search_after} if search_after else {}
            response = self.client.search(
                index=self.alias,
                query={"match_all": {}},
                size=batch,
                sort=[{"external_id": "asc"}],
                source=False,
                track_total_hits=False,
                **kwargs,
            )
            hits = response["hits"]["hits"]
            for hit in hits:
                yield hit["_id"]
            if len(hits) < batch:
                return
            search_after = hits[-1]["sort"]

    def count(self) -> int:
        return int(self.client.count(index=self.alias)["count"])

    def stats(self) -> dict:
        count = self.count()
        try:
            raw = self.client.indices.stats(index=self.alias, metric="store")
            size = int(raw["_all"]["primaries"]["store"]["size_in_bytes"])
        except Exception:  # noqa: BLE001 - informative only
            size = None
        response = self.client.search(index=self.alias, size=0, track_total_hits=False, aggs=_COMMUNITY_STATE_AGGS)
        aggs = response.get("aggregations", {})
        return {"documents": count, "store_bytes": size, **_community_state(aggs)}
