"""Regression tests for bugs found in the v0.3 review pass."""

from unittest.mock import MagicMock

import pytest

from app.errors import BusyError, ValidationFailed
from app.ids import point_id
from app.schemas import DocumentIn, LexicalOptions, SearchFilters
from app.stores.elastic import ElasticStore, build_filters, decode_cursor, encode_cursor
from tests.fakes import make_settings


class _Ctx:
    def progress(self, *args, **kwargs):
        return None

    def check_cancelled(self):
        return None


# ------------------------------------------------------------------ ES write semantics (real store, mocked client)


def es_with_mock():
    client = MagicMock()
    client.bulk.return_value = {"errors": False, "items": []}
    return ElasticStore(make_settings(), client=client), client


def test_bulk_upsert_uses_full_index_ops_with_optimistic_concurrency():
    store, client = es_with_mock()
    store.bulk_upsert(
        [
            {"id": "new", "text": "a", "metadata": {"desk": "x"}},
            {"id": "old", "text": "b", "metadata": None, "_seq_no": 7, "_primary_term": 2, "created_at": "2026-01-01"},
        ]
    )
    ops = client.bulk.call_args.kwargs["operations"]
    assert ops[0] == {"create": {"_index": "documents", "_id": "new"}}
    assert ops[2] == {"index": {"_index": "documents", "_id": "old", "if_seq_no": 7, "if_primary_term": 2}}
    actions = [next(iter(op)) for op in ops[::2]]
    assert actions == ["create", "index"]  # never "update": partial docs deep-merge metadata (the original bug)
    assert ops[3]["created_at"] == "2026-01-01" and "_seq_no" not in ops[3]
    assert ops[1]["created_at"] == ops[1]["updated_at"]


def test_bulk_errors_are_reported_per_document():
    store, client = es_with_mock()
    client.bulk.return_value = {
        "errors": True,
        "items": [{"index": {"_id": "old", "error": {"type": "version_conflict_engine_exception", "reason": "seq"}}}],
    }
    assert store.bulk_upsert([{"id": "old", "text": "b"}]) == {"old": "version_conflict_engine_exception: seq"}


def test_fetch_display_chunks_large_id_sets():
    store, client = es_with_mock()
    client.search.return_value = {"hits": {"hits": []}}
    store.fetch_display([f"id{i}" for i in range(2500)])
    sizes = [call.kwargs["size"] for call in client.search.call_args_list]
    assert sizes == [1000, 1000, 500]


def test_invalid_cursor_is_a_validation_error():
    assert decode_cursor(encode_cursor([1, "a"])) == [1, "a"]
    for bad in ("not-base64!!", encode_cursor({"x": 1}).replace("=", ""), "e30="):
        with pytest.raises(ValidationFailed):
            decode_cursor(bad)


def test_metadata_filter_keys_are_normalised_like_ingest():
    must, _ = build_filters(SearchFilters(metadata={"Desk ": "transport"}))
    assert must == [{"term": {"metadata.desk": "transport"}}]


def test_search_lexical_applies_community_scope_as_post_filter():
    store, client = es_with_mock()
    client.search.return_value = {"hits": {"hits": [], "total": {"value": 0}}, "aggregations": {}}
    store.search_lexical(
        "rail", size=5, options=LexicalOptions(), filters=SearchFilters(sources=["seed"]),
        community_ids=[3], exclude_community_ids=None, highlight=True, facets=True,
    )
    kwargs = client.search.call_args.kwargs
    assert kwargs["post_filter"]["bool"]["filter"] == [{"terms": {"community_id": [3]}}]
    assert {"terms": {"source": ["seed"]}} in kwargs["query"]["bool"]["filter"]  # facets respect normal filters
    assert "communities" in kwargs["aggs"]


# ------------------------------------------------------------------ ingestion semantics


def test_removed_metadata_keys_disappear_and_reimport_converges(container):
    container.ingest_documents([DocumentIn(id="d1", text="railway news", metadata={"desk": "a", "lang": "en"})], "t")
    container.cluster_sync()
    before = dict(container.es.docs[point_id("d1")])

    report = container.ingest_documents([DocumentIn(id="d1", text="railway news", metadata={"desk": "b"})], "t")
    doc = container.es.docs[point_id("d1")]
    assert report["updated"] == 1
    assert doc["metadata"] == {"desk": "b"}  # "lang" is gone
    assert doc["community_id"] == before["community_id"]  # metadata-only change keeps the community
    assert doc["created_at"] == before["created_at"]

    again = container.ingest_documents([DocumentIn(id="d1", text="railway news", metadata={"desk": "b"})], "t")
    assert again["unchanged"] == 1 and again["updated"] == 0


def test_concurrent_write_is_reported_not_lost(container):
    container.ingest_documents([DocumentIn(id="d1", text="railway news")], "t")
    doc_id = point_id("d1")
    real_get_state = container.es.get_state

    def racing_get_state(ids):
        state = real_get_state(ids)
        container.es.bulk_set_communities([(doc_id, 99)], version=5)  # someone writes in between
        return state

    container.es.get_state = racing_get_state
    report = container.ingest_documents([DocumentIn(id="d1", text="railway news", metadata={"k": "v"})], "t")
    assert report["failed"] == 1 and "version_conflict" in report["errors"][0]["reason"]
    assert container.es.docs[doc_id]["community_id"] == 99


def test_blank_and_oversized_text_rejected(container):
    with pytest.raises(ValidationFailed, match="empty"):
        container.ingest_documents([DocumentIn.model_construct(text="   ", id=None, metadata=None, source=None)], "t")
    long = "a" * (container.settings.text_max_chars + 1)
    with pytest.raises(ValidationFailed, match=r"documents\[1\]"):
        container.ingest_documents([DocumentIn(text="ok"), DocumentIn(text=long)], "t")


def test_batch_cluster_when_busy_keeps_documents_and_reports(container):
    with container.structural(blocking=True):
        report = container.ingest_documents([DocumentIn(id="d1", text="railway")], "t", cluster=True)
    assert report["created"] == 1 and report["clustering"] is None and "clustering_skipped" in report
    with container.structural(blocking=True):
        with pytest.raises(BusyError):
            container.cluster_sync()


def test_reconcile_repairs_all_derived_stores(container):
    container.ingest_documents([DocumentIn(id=f"d{i}", text=f"railway story number {i}") for i in range(4)], "t")
    missing = point_id("d1")
    container.vectors.delete([missing])  # vector lost
    container.graph.upsert_nodes(["orphan-node"])  # node without a document
    result = container._reconcile(_Ctx())
    assert result["reembedded"] == 1 and result["orphan_nodes_removed"] == 1
    assert container.vectors.count() == 4 and "orphan-node" not in container.graph.nodes
    assert container.stats()["consistent"]
