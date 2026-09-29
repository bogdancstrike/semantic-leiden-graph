"""Integration tests against a real Qdrant server.

Skipped unless QDRANT_TEST_URL is set, e.g.:

    docker run -d -p 6333:6333 -p 6334:6334 qdrant/qdrant:v1.19.1
    QDRANT_TEST_URL=http://localhost:6333 pytest tests/integration -q

Elasticsearch and Neo4j stay faked; this checks everything the vector layer does that
local mode cannot prove: server-side payload indexes, gRPC, batch payload operations,
query-by-id exclusion and IsNull filtering.
"""

import os
import uuid

import pytest
from qdrant_client import QdrantClient

from app.container import Container
from app.ids import point_id
from app.schemas import DocumentIn, SearchRequest
from app.stores.vectors import VectorStore, community_filter
from tests.fakes import FakeElastic, FakeEmbedder, FakeGraph, make_settings

URL = os.getenv("QDRANT_TEST_URL")
pytestmark = pytest.mark.skipif(not URL, reason="QDRANT_TEST_URL not set")

DOCS = [
    DocumentIn(id="r1", text="railway infrastructure investment in Romania", metadata={"desk": "transport"}),
    DocumentIn(id="r2", text="railway stations modernization and railway tracks", metadata={"desk": "transport"}),
    DocumentIn(id="r3", text="faster intercity railway connections and infrastructure"),
    DocumentIn(id="f1", text="football match late goal champions league"),
    DocumentIn(id="f2", text="football club coach rotated players before the match"),
]


@pytest.fixture(params=[False, True], ids=["http", "grpc"])
def container(request):
    collection = f"it_{uuid.uuid4().hex[:8]}"
    settings = make_settings(qdrant_collection=collection, qdrant_prefer_grpc=request.param)
    client = QdrantClient(url=URL, prefer_grpc=request.param)
    embedder = FakeEmbedder()
    c = Container(settings, embedder, FakeElastic(), VectorStore(settings, embedder.dimension, client=client), FakeGraph())
    c.initialize()
    yield c
    client.delete_collection(collection)
    c.close()


def test_payload_index_and_schema_verification(container):
    info = container.vectors.client.get_collection(container.vectors.collection)
    assert "community_id" in info.payload_schema
    container.vectors.ensure_collection()  # idempotent on an existing collection


def test_full_pipeline_against_server(container):
    report = container.ingest_documents(DOCS, source="it")
    assert report["created"] == 5 and report["edges_upserted"] > 0

    neighbours = container.vectors.neighbors_of([point_id("r1")], limit=10)
    assert point_id("r1") not in {str(p.id) for p in neighbours[point_id("r1")]}  # self excluded

    unassigned = container.vectors.search(FakeEmbedder().encode_query("railway"), 10, community_filter(unassigned_only=True))
    assert len(unassigned) == 5  # IsNull matches payload community_id = null

    result = container.cluster_sync()
    assert result["qdrant_payloads_updated"] == 5
    point = container.vectors.client.retrieve(container.vectors.collection, [point_id("r1")], with_payload=True)[0]
    assert point.payload["community_id"] == container.es.docs[point_id("r1")]["community_id"]
    assert point.payload["community_version"] == 1

    for mode in ("semantic", "keyword", "hybrid"):
        response, _ = container.search_engine.search(SearchRequest(query="railway infrastructure", mode=mode, top_k=3))
        assert response.results and response.results[0].external_id.startswith("r"), mode

    auto, _ = container.search_engine.search(SearchRequest(query="football match", scope={"type": "auto"}))
    assert auto.routing.selected and all(r.external_id.startswith("f") for r in auto.results)

    pre, _ = container.search_engine.search(SearchRequest(query="railway", filters={"metadata": {"desk": "transport"}}))
    assert {r.external_id for r in pre.results} == {"r1", "r2"}

    mmr, _ = container.search_engine.search(
        SearchRequest(query="railway", top_k=3, mmr={"enabled": True, "lambda": 0.5, "candidates": 5})
    )
    assert [r.explain.mmr_rank for r in mmr.results] == [1, 2, 3]

    assert len(container.similar(point_id("r1"), "semantic", 3)) == 3


def test_reconcile_and_delete_against_server(container):
    container.ingest_documents(DOCS, source="it")
    container.vectors.delete([point_id("f2")])

    class Ctx:
        def progress(self, *a, **k):
            return None

    assert container._reconcile(Ctx())["reembedded"] == 1
    assert container.vectors.count() == 5
    container.delete_document(point_id("r3"))
    assert container.vectors.count() == 4 and container.stats()["consistent"]
