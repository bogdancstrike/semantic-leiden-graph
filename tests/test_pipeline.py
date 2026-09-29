from app.ids import point_id
from app.schemas import DocumentIn, SearchMode, SearchRequest

DOCS = [
    DocumentIn(id="r1", text="railway infrastructure investment in Romania", metadata={"desk": "transport"}),
    DocumentIn(id="r2", text="railway stations modernization and railway tracks", metadata={"desk": "transport"}),
    DocumentIn(id="r3", text="faster intercity railway connections and infrastructure"),
    DocumentIn(id="f1", text="football match late goal champions league"),
    DocumentIn(id="f2", text="football club coach rotated players before the match"),
]


def test_ingest_is_idempotent_and_detects_changes(container):
    first = container.ingest_documents(DOCS, source="test")
    assert first["created"] == 5 and first["edges_upserted"] > 0
    assert container.vectors.count() == 5 and len(container.graph.nodes) == 5

    again = container.ingest_documents(DOCS, source="test")
    assert again["created"] == 0 and again["unchanged"] == 5

    changed = container.ingest_documents([DocumentIn(id="r1", text="totally new text about weather storms")], "test")
    assert changed["updated"] == 1
    assert container.vectors.count() == 5  # still one point per external id


def test_cluster_syncs_all_stores_with_version(container):
    container.ingest_documents(DOCS, source="test")
    result = container.cluster_sync()
    assert result["version"] == 1 and result["qdrant_payloads_updated"] == 5
    doc = container.es.docs[point_id("r1")]
    assert doc["community_id"] is not None and doc["community_version"] == 1
    point = container.vectors.client.retrieve(container.vectors.collection, [point_id("r1")])[0]
    assert point.payload["community_id"] == doc["community_id"]
    assert container.stats()["consistent"] is True


def test_text_change_clears_community(container):
    container.ingest_documents(DOCS, source="test")
    container.cluster_sync()
    container.ingest_documents([DocumentIn(id="f1", text="volcano eruption ash cloud")], "test")
    assert container.es.docs[point_id("f1")]["community_id"] is None
    assert container.graph.nodes[point_id("f1")] is None


def test_search_modes_and_explain(container):
    container.ingest_documents(DOCS, source="test")
    container.cluster_sync()
    engine = container.search_engine
    for mode in SearchMode:
        response, _ = engine.search(SearchRequest(query="railway infrastructure", mode=mode, top_k=3))
        assert response.results, mode
        assert response.results[0].external_id.startswith("r"), (mode, response.results[0])
        assert response.timings["total_ms"] >= 0
    hybrid, _ = engine.search(SearchRequest(query="railway infrastructure", mode="hybrid", top_k=3))
    top = hybrid.results[0].explain
    assert top.semantic_rank is not None and top.keyword_rank is not None and top.fused_score is not None
    assert hybrid.facet_source == "keyword"


def test_auto_scope_routes_to_community(container):
    container.ingest_documents(DOCS, source="test")
    container.cluster_sync()
    response, _ = container.search_engine.search(
        SearchRequest(query="football match", scope={"type": "auto"}, routing={"strategy": "sum", "anchors": 5})
    )
    assert response.routing and response.routing.selected
    assert {r.community_id for r in response.results} <= set(response.routing.selected)
    assert all(r.external_id.startswith("f") for r in response.results)


def test_metadata_prefilter_restricts_semantic_results(container):
    container.ingest_documents(DOCS, source="test")
    response, _ = container.search_engine.search(
        SearchRequest(query="railway", filters={"metadata": {"desk": "transport"}}, top_k=10)
    )
    assert {r.external_id for r in response.results} == {"r1", "r2"}


def test_mmr_marks_ranks(container):
    container.ingest_documents(DOCS, source="test")
    response, _ = container.search_engine.search(
        SearchRequest(query="railway", top_k=3, mmr={"enabled": True, "lambda": 0.3, "candidates": 5})
    )
    assert [r.explain.mmr_rank for r in response.results] == [1, 2, 3]


def test_similar_and_delete(container):
    container.ingest_documents(DOCS, source="test")
    rid = point_id("r1")
    for method in ("semantic", "keyword", "graph"):
        results = container.similar(rid, method, 3)
        assert all(r["id"] != rid for r in results)
    container.delete_document(rid)
    assert rid not in container.es.docs and container.vectors.count() == 4 and rid not in container.graph.nodes


def test_rebuild_applies_new_policy(container):
    container.ingest_documents(DOCS, source="test")
    result = container.rebuild_sync(neighbor_k=2, min_similarity=0.99)
    assert result["edge_upserts"] == 0
    assert container.policy == {"neighbor_k": 2, "min_similarity": 0.99}
    assert container.graph.policy["neighbor_k"] == 2


def test_compact_communities_drops_small_groups_and_renumbers_by_size():
    from app.pipeline.communities import compact_communities

    raw = [("a", 7), ("b", 7), ("c", 7), ("d", 3), ("e", 3), ("f", 9), ("g", 11)]
    assignments, summary = compact_communities(raw, 2)
    assert dict(assignments) == {"a": 0, "b": 0, "c": 0, "d": 1, "e": 1, "f": None, "g": None}
    assert summary == {"community_count": 2, "raw_community_count": 4, "outside_documents": 2, "min_community_size": 2}
    # a minimum below two is raised to two: a group of one is never a community
    assert compact_communities([("x", 1)], 1)[0] == [("x", None)]
    assert compact_communities(raw, 3)[1]["community_count"] == 1


def test_cluster_leaves_isolated_documents_in_no_community(container):
    container.ingest_documents([*DOCS, DocumentIn(id="z1", text="zebra quartz xylophone")], source="test")
    # The scenario under test: a document with no neighbour above the threshold.
    container.graph.edges = {pair: s for pair, s in container.graph.edges.items() if point_id("z1") not in pair}
    result = container.cluster_sync()
    assert result["community_count"] == 2 and result["raw_community_count"] == 3
    assert result["outside_documents"] == 1 and result["min_community_size"] == 2

    doc = container.es.docs[point_id("z1")]
    assert doc["community_id"] is None and doc["community_version"] == 1  # clustered, but in no community
    point = container.vectors.client.retrieve(container.vectors.collection, [point_id("z1")])[0]
    assert point.payload["community_id"] is None
    assert container.graph.nodes[point_id("z1")] is None
    assert {c["community_id"] for c in container.communities()} == {0, 1}  # compact, largest first
    assert all(c["size"] >= 2 for c in container.communities())

    stats = container.stats()
    assert stats["communities"] == 2 and stats["outside_communities"] == 1 and stats["unclustered"] == 0
    assert stats["consistent"] is True

    container.ingest_documents([DocumentIn(id="z2", text="brand new unrelated words")], "test")
    assert container.stats()["unclustered"] == 1  # added since the run: not clustered yet
