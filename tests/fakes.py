"""In-memory stand-ins for Elasticsearch and Neo4j plus a deterministic embedder.

Qdrant is *not* faked: tests use ``QdrantClient(":memory:")`` (qdrant-client local
mode) so filters, batch queries and payload updates exercise real client semantics.
"""

from __future__ import annotations

import hashlib
import re
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from qdrant_client import QdrantClient

from app.config import Settings
from app.container import Container
from app.ids import normalize_metadata_key
from app.schemas import LexicalOptions, SearchFilters
from app.search import conditions
from app.stores.vectors import VectorStore

TOKEN = re.compile(r"\w+", re.UNICODE)


def tokens(text: str) -> list[str]:
    return [t.lower() for t in TOKEN.findall(text)]


def evaluate_tree(tree: dict | None, doc: dict) -> bool:
    """Evaluate a RAQB tree against one document dict, the way the ES clause would.

    Reuses the compiler's own rule resolution, so validation errors and "incomplete rule
    is skipped" behave exactly as in production.
    """
    if not tree:
        return True
    result = _evaluate(tree, doc)
    return True if result is None else result


def _evaluate(node: dict, doc: dict) -> bool | None:
    if str(node.get("type") or "group").lower() in ("group", "rule_group"):
        conjunction, negated = conditions.group_settings(node)
        parts = [r for child in conditions.children_of(node) if (r := _evaluate(child, doc)) is not None]
        if not parts:
            return None
        value = all(parts) if conjunction == "AND" else any(parts)
        return not value if negated else value
    resolved = conditions.resolve_rule(node)
    if resolved is None:
        return None
    spec, op, values = resolved
    if spec.kind == "metadata":
        actual = (doc.get("metadata") or {}).get(spec.name[len(conditions.METADATA_PREFIX):])
    else:
        actual = doc.get(spec.name)
    if op == "empty":
        return actual is None
    if op == "not_empty":
        return actual is not None
    if spec.kind == "fulltext":
        have = set(tokens(doc.get("text", "")))
        want = tokens(" ".join(map(str, values)))
        if op in ("contains", "query"):
            return set(want) <= have
        if op == "not":
            return not set(want) <= have
        if op == "any":
            return bool(set(want) & have)
        return " ".join(want) in " ".join(tokens(doc.get("text", "")))  # phrase
    if actual is None:
        return op in ("ne", "not_in", "not", "not_between")
    if op == "in":
        return actual in values
    if op == "not_in":
        return actual not in values
    if op in ("between", "not_between"):
        inside = values[0] <= actual <= values[1]
        return inside if op == "between" else not inside
    value = values[0]
    compare = {
        "eq": lambda a: a == value,
        "ne": lambda a: a != value,
        "gt": lambda a: a > value,
        "gte": lambda a: a >= value,
        "lt": lambda a: a < value,
        "lte": lambda a: a <= value,
        "contains": lambda a: str(value).lower() in str(a).lower(),
        "not": lambda a: str(value).lower() not in str(a).lower(),
        "starts": lambda a: str(a).lower().startswith(str(value).lower()),
        "ends": lambda a: str(a).lower().endswith(str(value).lower()),
    }
    return compare[op](actual)


class FakeEmbedder:
    model_name = "fake-hash-embedder"
    dimension = 64

    def _vec(self, text: str) -> np.ndarray:
        v = np.zeros(self.dimension, dtype=np.float32)
        for tok in tokens(text):
            h = int(hashlib.md5(tok.encode()).hexdigest(), 16)
            v[h % self.dimension] += 1.0
        norm = np.linalg.norm(v)
        return v / norm if norm else v

    def encode_documents(self, texts: list[str]) -> np.ndarray:
        return np.stack([self._vec(t) for t in texts]) if texts else np.zeros((0, self.dimension), np.float32)

    def encode_query(self, text: str) -> list[float]:
        return self._vec(text).tolist()


def community_state(docs) -> dict:
    """Mirror of ``elastic._community_state``: no community, never clustered, clustered into none."""
    docs = list(docs)
    return {
        "unassigned": sum(1 for d in docs if d.get("community_id") is None),
        "unclustered": sum(1 for d in docs if d.get("community_version") is None),
        "outside_communities": sum(
            1 for d in docs if d.get("community_version") is not None and d.get("community_id") is None
        ),
    }


class FakeElastic:
    """Mirrors the real store's semantics: full-document writes + seq_no concurrency."""

    def __init__(self) -> None:
        self.docs: dict[str, dict] = {}
        self.seq: dict[str, int] = {}

    def ping(self) -> bool:
        return True

    def ensure_index(self) -> None: ...

    def refresh(self) -> None: ...

    def get_state(self, ids):
        return {i: {**self.docs[i], "_seq_no": self.seq[i], "_primary_term": 1} for i in ids if i in self.docs}

    def bulk_upsert(self, docs):
        now = datetime.now(timezone.utc).isoformat()
        errors = {}
        for doc in docs:
            doc_id = doc["id"]
            body = {k: v for k, v in doc.items() if k not in ("id", "_seq_no", "_primary_term")}
            body["updated_at"] = now
            body["created_at"] = body.get("created_at") or now
            if doc.get("_seq_no") is None and doc_id in self.docs:
                errors[doc_id] = "version_conflict_engine_exception: document already exists"
                continue
            if doc.get("_seq_no") is not None and self.seq.get(doc_id) != doc["_seq_no"]:
                errors[doc_id] = "version_conflict_engine_exception: seq_no mismatch"
                continue
            self.docs[doc_id] = body  # full replace, like an ES index op
            self.seq[doc_id] = self.seq.get(doc_id, -1) + 1
        return errors

    def bulk_set_communities(self, assignments, version):
        for doc_id, cid in assignments:
            if doc_id in self.docs:
                self.docs[doc_id]["community_id"] = cid
                self.docs[doc_id]["community_version"] = version
                self.seq[doc_id] += 1
        return len(assignments)

    def delete(self, doc_id):
        self.seq.pop(doc_id, None)
        return self.docs.pop(doc_id, None) is not None

    def get(self, doc_id):
        doc = self.docs.get(doc_id)
        return {"id": doc_id, **doc} if doc else None

    def fetch_display(self, ids, *, query=None, lexical=None, highlight=False):
        out = {}
        for i in ids:
            if i in self.docs:
                hl = self._highlight(self.docs[i]["text"], query) if highlight and query else []
                out[i] = {"id": i, **self.docs[i], "highlights": hl}
        return out

    @staticmethod
    def _highlight(text, query):
        q = set(tokens(query))
        marked = [f"\u0002{w}\u0003" if w.lower() in q else w for w in text.split(" ")]
        return [" ".join(marked)] if any("\u0002" in m for m in marked) else []

    def _matches_filters(self, doc, filters: SearchFilters | None):
        if not filters:
            return True
        if filters.must_text and not set(tokens(filters.must_text)) <= set(tokens(doc["text"])):
            return False
        if filters.sources and doc.get("source") not in filters.sources:
            return False
        for k, v in filters.metadata.items():
            if (doc.get("metadata") or {}).get(normalize_metadata_key(k)) != v:
                return False
        if filters.unassigned_only and doc.get("community_id") is not None:
            return False
        return evaluate_tree(filters.condition_tree, doc)

    def search_lexical(self, query, *, size, options: LexicalOptions, filters, community_ids, exclude_community_ids, highlight, facets):
        q = set(tokens(query))
        scored = []
        for doc_id, doc in self.docs.items():
            overlap = len(q & set(tokens(doc["text"])))
            if overlap and self._matches_filters(doc, filters):
                scored.append((overlap + 0.001 * len(q), doc_id))
        scored.sort(key=lambda x: (-x[0], x[1]))
        facet_counts = defaultdict(int)
        for _, doc_id in scored:
            facet_counts[self.docs[doc_id].get("community_id")] += 1
        post = [
            (s, i)
            for s, i in scored
            if (not community_ids or self.docs[i].get("community_id") in community_ids)
            and (not exclude_community_ids or self.docs[i].get("community_id") not in exclude_community_ids)
        ]
        hits = [
            {"id": i, "score": float(s), **self.docs[i], "highlights": self._highlight(self.docs[i]["text"], query) if highlight else []}
            for s, i in post[:size]
        ]
        result = {"hits": hits, "total": len(post)}
        if facets:
            result["facets"] = {
                "communities": [{"value": k, "count": v} for k, v in facet_counts.items()],
                "sources": [],
            }
        return result

    def filter_ids(self, filters, *, community_ids, exclude_community_ids, limit):
        ids = [
            i
            for i, d in self.docs.items()
            if self._matches_filters(d, filters)
            and (not community_ids or d.get("community_id") in community_ids)
            and (not exclude_community_ids or d.get("community_id") not in exclude_community_ids)
        ]
        return ids[:limit], len(ids)

    def more_like_this(self, doc_id, size):
        base = set(tokens(self.docs[doc_id]["text"]))
        scored = sorted(
            ((len(base & set(tokens(d["text"]))), i) for i, d in self.docs.items() if i != doc_id),
            reverse=True,
        )
        return [{"id": i, "score": float(s), **self.docs[i]} for s, i in scored[:size] if s > 0]

    def browse(self, *, limit, cursor, query, community_id, unassigned, source, external_id):
        items = [
            {"id": i, **d}
            for i, d in sorted(self.docs.items(), key=lambda kv: kv[1]["external_id"])
            if (community_id is None or d.get("community_id") == community_id)
            and (not external_id or d["external_id"] == external_id)
            and (not query or set(tokens(query)) & set(tokens(d["text"])))
        ]
        start = int(cursor or 0)
        page = items[start : start + limit]
        nxt = str(start + limit) if start + limit < len(items) else None
        return {"items": page, "total": len(items), "next_cursor": nxt}

    # ------------------------------------------------------------------ explore

    def _explore_matches(self, query_text, condition_tree):
        wanted = set(tokens(query_text))
        conditions.compile_tree(condition_tree)  # same validation errors as the real store
        return [
            {"id": i, **d}
            for i, d in self.docs.items()
            if (not wanted or wanted <= set(tokens(d["text"])) | set(tokens(d.get("external_id", ""))))
            and evaluate_tree(condition_tree, d)
        ]

    def explore(self, *, query_text, condition_tree, sort, order, offset, size, facets, highlight):
        rows = self._explore_matches(query_text, condition_tree)
        rows.sort(key=lambda r: r["external_id"])
        if sort != "_score":
            present = [r for r in rows if r.get(sort) is not None]
            present.sort(key=lambda r: r[sort], reverse=order == "desc")
            rows = present + [r for r in rows if r.get(sort) is None]
        page = rows[offset : offset + size]
        items = [
            {**r, "highlights": self._highlight(r["text"], query_text) if highlight and query_text else [], "score": None}
            for r in page
        ]
        result = {"items": items, "total": len(rows), "total_relation": "eq", "facets": {}}
        if facets:
            result["facets"] = {
                "community_id": self._counts(rows, "community_id"),
                "source": [b for b in self._counts(rows, "source") if b["value"] is not None],
            }
        return result

    @staticmethod
    def _counts(rows, key):
        counts = defaultdict(int)
        for r in rows:
            counts[r.get(key)] += 1
        return [{"value": k, "count": v} for k, v in sorted(counts.items(), key=lambda kv: -kv[1])]

    def insights(self, *, query_text, condition_tree):
        rows = self._explore_matches(query_text, condition_tree)
        lengths = [r.get("length") or len(r["text"]) for r in rows]
        return {
            "total": len(rows),
            "metrics": {
                "documents": len(rows),
                "communities": len({r.get("community_id") for r in rows if r.get("community_id") is not None}),
                **community_state(rows),
                "avg_length": round(sum(lengths) / len(lengths), 1) if lengths else None,
                "min_length": min(lengths) if lengths else None,
                "max_length": max(lengths) if lengths else None,
                "sources": len({r.get("source") for r in rows if r.get("source")}),
            },
            "communities": self._counts(rows, "community_id")[:30],
            "sources": [b for b in self._counts(rows, "source") if b["value"] is not None],
            "length_buckets": [{"label": "0+", "from": 0, "to": None, "count": len(rows)}],
            "timeline": [],
            "timeline_interval": None,
        }

    def catalogue(self, *, sample=500, max_keys=20, values_per_key=50):
        rows = [{"id": i, **d} for i, d in self.docs.items()]
        keys = defaultdict(lambda: defaultdict(int))
        for r in rows:
            for k, v in (r.get("metadata") or {}).items():
                keys[k][v] += 1
        return {
            "total": len(rows),
            "sources": [b for b in self._counts(rows, "source") if b["value"] is not None],
            "communities": [b for b in self._counts(rows, "community_id") if b["value"] is not None],
            "unassigned": sum(1 for r in rows if r.get("community_id") is None),
            "metadata": {
                k: [{"value": v, "count": n} for v, n in sorted(vals.items(), key=lambda kv: -kv[1])][:values_per_key]
                for k, vals in list(keys.items())[:max_keys]
            },
        }

    # ------------------------------------------------------------------ sources

    def sources(self):
        buckets = defaultdict(list)
        for d in self.docs.values():
            buckets[d.get("source")].append(d)
        rows = [
            {
                "source": source,
                "documents": len(docs),
                **community_state(docs),
                "first_created": min(d["created_at"] for d in docs),
                "last_updated": max(d["updated_at"] for d in docs),
            }
            for source, docs in buckets.items()
        ]
        rows.sort(key=lambda r: (-r["documents"], r["source"] or ""))
        return {"sources": rows, "total": len(self.docs)}

    def ids_for_source(self, source, batch=1000):
        return sorted(
            (i for i, d in self.docs.items() if d.get("source") == source), key=lambda i: self.docs[i]["external_id"]
        )

    def bulk_delete(self, ids):
        return sum(1 for i in ids if self.delete(i))

    def iter_ids(self, batch: int = 1000):
        return iter(list(self.docs))

    def count(self):
        return len(self.docs)

    def stats(self):
        return {
            "documents": len(self.docs),
            **community_state(self.docs.values()),
            "store_bytes": None,
        }


class FakeGraph:
    def __init__(self) -> None:
        self.nodes: dict[str, int | None] = {}
        self.edges: dict[tuple[str, str], float] = {}
        self.runs: list[dict] = []
        self.policy: dict | None = None

    def ping(self):
        return True

    def ensure_schema(self): ...

    def close(self): ...

    def upsert_nodes(self, ids):
        for i in ids:
            self.nodes.setdefault(i, None)

    def reset_documents(self, ids):
        for i in ids:
            self.nodes[i] = None
            for key in [k for k in self.edges if i in k]:
                del self.edges[key]

    def upsert_edges(self, edges):
        for e in edges:
            self.edges[(e["a"], e["b"])] = e["score"]
        return len(edges)

    def delete_all_edges(self):
        n = len(self.edges)
        self.edges.clear()
        return n

    def iter_ids(self):
        return list(self.nodes)

    def delete_nodes(self, ids):
        for i in ids:
            self.nodes.pop(i, None)
            for key in [k for k in self.edges if i in k]:
                del self.edges[key]

    def load_policy(self):
        return self.policy

    def save_policy(self, k, s):
        self.policy = {"neighbor_k": k, "min_similarity": s, "updated_at": None}

    def next_cluster_version(self):
        return len(self.runs) + 1

    def save_cluster_run(self, run):
        self.runs.append({**run, "ran_at": datetime.now(timezone.utc).isoformat()})

    def cluster_runs(self, limit=20):
        return list(reversed(self.runs))[:limit]

    def run_leiden(self, gamma, seed):
        # connected components stand in for Leiden in tests
        parent = {n: n for n in self.nodes}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        for a, b in self.edges:
            if a in parent and b in parent:
                parent[find(a)] = find(b)
        roots = {}
        for n in sorted(self.nodes):
            self.nodes[n] = roots.setdefault(find(n), len(roots))
        return {
            "community_count": len(roots),
            "node_properties_written": len(self.nodes),
            "modularity": 0.5,
            "ran_levels": 1,
            "node_count": len(self.nodes),
            "relationship_count": len(self.edges),
            "project_ms": 0,
            "compute_ms": 0,
            "write_ms": 0,
            "leiden_total_ms": 0,
        }

    def assignments(self):
        return [(n, c) for n, c in self.nodes.items() if c is not None]

    def set_community_ids(self, assignments):
        for node_id, community in assignments:
            if node_id in self.nodes:
                self.nodes[node_id] = community

    def stats(self):
        return {
            "nodes": len(self.nodes),
            "edges": len(self.edges),
            "communities": len({c for c in self.nodes.values() if c is not None}),
            "isolated_nodes": sum(1 for n in self.nodes if not any(n in k for k in self.edges)),
            "mean_degree": 0.0,
        }

    def list_communities(self):
        sizes = defaultdict(int)
        for c in self.nodes.values():
            if c is not None:
                sizes[c] += 1
        return [
            {"community_id": c, "size": s, "internal_edges": 0, "boundary_edges": 0, "avg_similarity": 0.0, "density": 0.0, "conductance": 0.0}
            for c, s in sorted(sizes.items(), key=lambda kv: -kv[1])
        ]

    def community_detail(self, cid, limit):
        members = [n for n, c in self.nodes.items() if c == cid][:limit]
        return {"central": [{"id": m, "strength": 1.0, "degree": 1} for m in members], "neighbouring_communities": []}

    def neighbors(self, doc_id, limit):
        rows = []
        for (a, b), s in self.edges.items():
            if doc_id in (a, b):
                other = b if a == doc_id else a
                rows.append({"id": other, "community_id": self.nodes.get(other), "score": s})
        return sorted(rows, key=lambda r: -r["score"])[:limit]

    def graph_data(self, limit, community_ids, min_score, max_score=1.0):
        links = [
            {"source": a, "target": b, "score": s}
            for (a, b), s in sorted(self.edges.items(), key=lambda kv: -kv[1])
            if min_score <= s <= max_score and (not community_ids or (self.nodes.get(a) in community_ids and self.nodes.get(b) in community_ids))
        ][:limit]
        ids = {e["source"] for e in links} | {e["target"] for e in links}
        return {"nodes": [{"id": i, "community_id": self.nodes.get(i)} for i in ids], "links": links}

    def ego_graph(self, doc_id, hops, node_limit, min_score, max_score=1.0):
        return self.graph_data(1000, None, min_score, max_score)

    def delete_nodes_counted(self, ids):
        present = [i for i in ids if i in self.nodes]
        self.delete_nodes(present)
        return len(present)

    def subgraph(self, ids, expand, neighbor_limit, min_score, max_score=1.0):
        order = [i for i in dict.fromkeys(ids) if i in self.nodes]
        seeds = set(order)
        if expand and neighbor_limit > 0:
            best = {}
            for (a, b), score in self.edges.items():
                if not min_score <= score <= max_score:
                    continue
                for s, n in ((a, b), (b, a)):
                    if s in seeds and n not in seeds:
                        best[n] = max(best.get(n, score), score)
            order += [n for n, _ in sorted(best.items(), key=lambda kv: (-kv[1], kv[0]))[:neighbor_limit]]
        members = set(order)
        links = [
            {"source": a, "target": b, "score": s}
            for (a, b), s in sorted(self.edges.items(), key=lambda kv: -kv[1])
            if a in members and b in members and min_score <= s <= max_score
        ]
        return {"nodes": [{"id": i, "community_id": self.nodes[i]} for i in order], "links": links}


def make_settings(**overrides) -> Settings:
    base = dict(
        neighbor_k=5,
        min_similarity=0.2,
        ingest_chunk_size=16,
        neighbor_query_batch=8,
        graph_write_batch=100,
        sync_batch_size=10,
        api_key=None,
        _env_file=None,
    )
    base.update(overrides)
    return Settings(**base)


def make_container(settings: Settings | None = None) -> Container:
    settings = settings or make_settings()
    embedder = FakeEmbedder()
    vectors = VectorStore(settings, embedder.dimension, client=QdrantClient(":memory:"))
    container = Container(settings, embedder, FakeElastic(), vectors, FakeGraph())  # type: ignore[arg-type]
    container.initialize()
    return container
