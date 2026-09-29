"""Explore, graph query, condition trees in search, CSV mapping, sources and deletes."""

import json

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.schemas import DocumentIn
from tests.fakes import make_container, make_settings
from tests.test_api import wait_for_job

NEWS = [
    {"id": "r1", "text": "railway infrastructure investment", "metadata": {"desk": "transport"}},
    {"id": "r2", "text": "railway stations modernization", "metadata": {"desk": "transport"}},
    {"id": "f1", "text": "football match late goal", "metadata": {"desk": "sports"}},
    {"id": "f2", "text": "football club signs striker", "metadata": {"desk": "sports"}},
]


def rule(field, operator, *value):
    return {"type": "rule", "properties": {"field": field, "operator": operator, "value": list(value)}}


def tree(*children, conjunction="AND", negate=False):
    return {"type": "group", "properties": {"conjunction": conjunction, "not": negate}, "children1": list(children)}


@pytest.fixture
def client(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("API_KEY", "")
    app = create_app(container_factory=lambda s: make_container(make_settings()))
    with TestClient(app) as test_client:
        assert test_client.post("/documents/batch", json={"documents": NEWS, "source": "news", "cluster": True}).status_code == 200
        test_client.post("/documents/batch", json={"documents": [{"id": "w1", "text": "heavy snow forecast"}], "source": "other"})
        yield test_client
    get_settings.cache_clear()


def ids(items):
    return sorted(item["external_id"] for item in items)


# ------------------------------------------------------------------ catalogue


def test_fields_catalogue(client):
    body = client.get("/explore/fields").json()
    fields = {f["name"]: f for f in body["fields"]}
    assert {"text", "external_id", "source", "community_id", "length", "created_at", "updated_at", "metadata.desk"} <= set(fields)
    assert fields["text"]["kind"] == "fulltext" and "like" in fields["text"]["operators"]
    assert {c["value"] for c in fields["source"]["choices"]} == {"news", "other"}
    assert all(c["label"] == f"C{c['value']}" for c in fields["community_id"]["choices"])
    assert {c["value"] for c in fields["metadata.desk"]["choices"]} == {"transport", "sports"}
    assert "like" not in fields["metadata.desk"]["operators"]
    assert body["total"] == 5 and "_score" in body["sort_fields"]


# ------------------------------------------------------------------ query


def test_query_tree_sort_and_paging(client):
    question = {"condition_tree": tree(rule("metadata.desk", "select_equals", "sports")), "sort": "external_id",
                "order": "asc", "page_size": 1, "page": 2}
    body = client.post("/explore/query", json=question).json()
    assert body["total"] == 2 and body["pages"] == 2 and ids(body["items"]) == ["f2"]
    assert body["condition_text"] == "desk = sports" and body["rule_count"] == 1
    assert body["sort"] == "external_id" and body["order"] == "asc"


def test_query_text_or_not_and_facets(client):
    nested = tree(
        rule("source", "select_equals", "news"),
        tree(rule("external_id", "starts_with", "R"), rule("external_id", "equal", "f2"), conjunction="OR", negate=True),
    )
    body = client.post("/explore/query", json={"condition_tree": nested, "facets": True}).json()
    assert ids(body["items"]) == ["f1"]
    assert body["facets"]["source"] == [{"value": "news", "count": 1}]
    text = client.post("/explore/query", json={"query_text": "railway", "sort": "_score"}).json()
    assert ids(text["items"]) == ["r1", "r2"]
    # `_score` without text to score against falls back to recency
    assert client.post("/explore/query", json={"sort": "_score"}).json()["sort"] == "updated_at"


def test_query_rejects_bad_questions(client):
    bad = client.post("/explore/query", json={"condition_tree": tree(rule("metadata.desk", "like", "port"))})
    assert bad.status_code == 422 and "does not support" in bad.json()["detail"]
    deep = client.post("/explore/query", json={"page": 101, "page_size": 100})
    assert deep.status_code == 422
    assert client.post("/explore/query", json={"sort": "text"}).status_code == 422


def test_insights_match_the_list(client):
    question = {"condition_tree": tree(rule("source", "select_equals", "news"))}
    insights = client.post("/explore/insights", json=question).json()
    listing = client.post("/explore/query", json=question).json()
    assert insights["total"] == listing["total"] == 4
    assert insights["metrics"]["sources"] == 1 and insights["metrics"]["unassigned"] == 0
    assert sum(b["count"] for b in insights["communities"]) == 4
    assert insights["condition_text"] == "Source = news"


# ------------------------------------------------------------------ search + graph


@pytest.mark.parametrize("mode", ["keyword", "semantic", "hybrid"])
def test_search_honours_condition_tree(client, mode):
    body = {"query": "railway", "mode": mode, "filters": {"condition_tree": tree(rule("external_id", "equal", "r2"))}}
    response = client.post("/search", json=body)
    assert response.status_code == 200, response.text
    assert [r["external_id"] for r in response.json()["results"]] == ["r2"]
    bad = client.post("/search", json={**body, "filters": {"condition_tree": tree(rule("nope", "equal", "x"))}})
    assert bad.status_code == 422


def test_graph_query_by_conditions_keeps_isolated_seeds(client):
    lonely = client.post("/graph/query", json={"condition_tree": tree(rule("external_id", "equal", "w1"))}).json()
    assert [n["external_id"] for n in lonely["nodes"]] == ["w1"] and lonely["links"] == []
    assert lonely["seeds"][0]["rank"] == 1 and lonely["matched"] == 1
    assert lonely["nodes"][0]["text"] == "heavy snow forecast"

    rail = client.post("/graph/query", json={"condition_tree": tree(rule("metadata.desk", "select_equals", "transport"))}).json()
    assert sorted(n["external_id"] for n in rail["nodes"]) == ["r1", "r2"]
    assert rail["condition_text"] == "desk = transport"


def test_graph_query_by_search_and_expand(client):
    seeded = client.post("/graph/query", json={"query": "railway", "mode": "keyword", "limit": 1}).json()
    assert len(seeded["seeds"]) == 1 and seeded["seeds"][0]["score"] is not None
    expanded = client.post("/graph/query", json={"query": "railway", "mode": "keyword", "limit": 1, "expand": True}).json()
    assert len(expanded["nodes"]) >= len(seeded["nodes"])
    seed_ids = {s["id"] for s in expanded["seeds"]}
    assert seed_ids <= {n["id"] for n in expanded["nodes"]}
    node_ids = {n["id"] for n in expanded["nodes"]}
    assert all(link["source"] in node_ids and link["target"] in node_ids for link in expanded["links"])


def test_graph_similarity_band_filters_edges_in_every_view(client):
    scores = sorted(link["score"] for link in client.get("/graph", params={"limit": 5000}).json()["links"])
    assert len(scores) >= 2, "the fake corpus must have edges of different strength"
    low, high = scores[0], scores[-1]
    cut = (low + high) / 2

    top = client.get("/graph", params={"min_score": low, "max_score": cut}).json()
    assert top["links"] and all(low <= link["score"] <= cut for link in top["links"])
    assert high > cut and all(link["score"] != high for link in top["links"])
    linked = {link["source"] for link in top["links"]} | {link["target"] for link in top["links"]}
    assert linked <= {node["id"] for node in top["nodes"]}

    focus = top["links"][0]["source"]
    ego = client.get(f"/graph/ego/{focus}", params={"min_score": 0, "max_score": cut}).json()
    assert all(link["score"] <= cut for link in ego["links"])

    body = {"query": "railway football", "mode": "keyword", "expand": True, "min_score": 0, "max_score": cut}
    seeded = client.post("/graph/query", json=body).json()
    assert all(link["score"] <= cut for link in seeded["links"])


def test_graph_accepts_custom_edge_counts_up_to_ten_thousand(client):
    assert client.get("/graph", params={"limit": 1234}).status_code == 200
    assert client.get("/graph", params={"limit": 10_000}).status_code == 200
    too_many = client.get("/graph", params={"limit": 10_001})
    assert too_many.status_code == 422 and too_many.json()["code"] == "validation_failed"


def test_graph_similarity_band_rejects_max_below_min(client):
    for response in (
        client.get("/graph", params={"min_score": 0.8, "max_score": 0.5}),
        client.get("/graph/ego/whatever", params={"min_score": 0.8, "max_score": 0.5}),
        client.post("/graph/query", json={"query": "railway", "min_score": 0.8, "max_score": 0.5}),
    ):
        assert response.status_code == 422, response.text
        assert response.json()["code"] == "validation_failed"
        assert "max_score" in response.json()["detail"]


# ------------------------------------------------------------------ CSV mapping


def upload(client, content, **data):
    response = client.post("/documents/upload", files={"file": ("m.csv", content, "text/csv")}, data=data)
    return response


def test_upload_with_mapped_columns(client):
    csv = "key,body,desk,lang\nk1,tram depot expansion,transport,en\nk2,tram lines extended,transport,ro\n"
    response = upload(client, csv, id_column="key", text_column="body", metadata_columns=json.dumps(["desk"]), source="mapped")
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded" and job["result"]["created"] == 2
    assert job["params"]["id_column"] == "key" and job["params"]["metadata_columns"] == ["desk"]
    doc = client.post("/explore/query", json={"condition_tree": tree(rule("external_id", "equal", "k1"))}).json()["items"][0]
    assert doc["metadata"] == {"desk": "transport"}


def test_upload_sets_the_minimum_community_size_and_later_runs_keep_it(client):
    csv = "key,body\n" + "".join(f"m{i},railway station number {i} modernised\n" for i in range(6))
    response = upload(client, csv, id_column="key", text_column="body", run_cluster="true", min_community_size="3")
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded" and job["params"]["min_community_size"] == 3
    assert job["result"]["clustering"]["min_community_size"] == 3
    # the next run without a size (Operations, delete + re-cluster, rebuild) reuses the last one
    assert client.get("/config").json()["leiden_min_community_size"] == 3
    assert client.get("/stats").json()["min_community_size"] == 3
    rerun = wait_for_job(client, client.post("/jobs/cluster", json={}).json()["id"])
    assert rerun["result"]["min_community_size"] == 3
    # an explicit size still wins, and becomes the new default
    explicit = wait_for_job(client, client.post("/jobs/cluster", json={"min_community_size": 2}).json()["id"])
    assert explicit["result"]["min_community_size"] == 2 and client.get("/stats").json()["min_community_size"] == 2
    too_small = upload(client, csv, id_column="key", text_column="body", min_community_size="1")
    assert too_small.status_code == 422


def test_minimum_community_size_survives_a_restart():
    from tests.fakes import make_container, make_settings

    container = make_container(make_settings())
    container.graph.runs.append({"version": 1, "min_community_size": 10})
    container.initialize()
    assert container.min_community_size == 10


def test_upload_generate_ids_and_no_metadata(client):
    response = upload(client, "body,desk\nsolar park approved,energy\n", text_column="Body", generate_ids="true",
                      metadata_columns="[]", source="generated")
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["result"]["created"] == 1 and job["params"]["generate_ids"] is True
    docs = client.post("/explore/query", json={"condition_tree": tree(rule("source", "select_equals", "generated"))}).json()
    assert docs["items"][0]["external_id"].startswith("sha1:") and not docs["items"][0].get("metadata")


@pytest.mark.parametrize(
    ("data", "message"),
    [
        ({"id_column": "missing", "text_column": "body"}, "not in the file"),
        ({"id_column": "body", "text_column": "body"}, "different"),
        ({"id_column": "key", "text_column": "body", "generate_ids": "true"}, "either"),
        ({"id_column": "key", "text_column": "body", "metadata_columns": "desk"}, "JSON array"),
        ({"id_column": "key", "text_column": "body", "metadata_columns": '["body"]'}, "already"),
        ({"id_column": "key"}, "Choose the column to analyse"),
        ({"text_column": "body", "delimiter": "ab"}, "one character"),
        ({"text_column": "body", "encoding": "nope-1"}, "Unknown encoding"),
    ],
)
def test_upload_mapping_errors(client, data, message):
    response = upload(client, "key,body,desk\nk,t,d\n", **data)
    assert response.status_code == 422 and message in response.json()["detail"], response.text


# ------------------------------------------------------------------ sources and deletes


def test_sources_listing_includes_unlabelled_bucket(client):
    container = client.app.state.container
    container.ingest_documents([DocumentIn(id="n1", text="no source at all")], source=None)
    body = client.get("/sources").json()
    by_source = {row["source"]: row for row in body["sources"]}
    assert by_source["news"]["documents"] == 4 and by_source["other"]["documents"] == 1
    assert by_source[None]["documents"] == 1 and by_source[None]["unassigned"] == 1
    assert body["total"] == 6 and body["sources"][0]["source"] == "news"
    assert by_source["news"]["first_created"] and by_source["news"]["last_updated"]


def test_delete_source_job_removes_it_everywhere(client):
    response = client.post("/jobs/delete-source", json={"source": "news", "cluster": True})
    assert response.status_code == 202, response.text
    assert response.json()["kind"] == "delete" and response.json()["params"] == {"source": "news", "cluster": True}
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    result = job["result"]
    assert (result["deleted"], result["vectors_deleted"], result["nodes_deleted"]) == (4, 4, 4)
    assert result["clustering"] is not None and result["source"] == "news"
    assert [row["source"] for row in client.get("/sources").json()["sources"]] == ["other"]
    stats = client.get("/stats").json()
    assert stats["documents"] == 1 and stats["consistent"]


def test_delete_source_refusals(client):
    assert client.post("/jobs/delete-source", json={"source": "nope"}).status_code == 404
    assert client.post("/jobs/delete-source", json={"source": None}).status_code == 404
    assert client.post("/jobs/delete-source", json={"source": "  "}).status_code == 422
    assert client.post("/jobs/delete-source", json={}).status_code == 422


def test_delete_source_needs_the_api_key(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("API_KEY", "s3cret")
    app = create_app(container_factory=lambda s: make_container(make_settings(api_key="s3cret")))
    with TestClient(app) as c:
        c.post("/documents/batch", json={"documents": NEWS[:1], "source": "news"}, headers={"X-API-Key": "s3cret"})
        assert c.post("/jobs/delete-source", json={"source": "news"}).status_code == 401
        ok = c.post("/jobs/delete-source", json={"source": "news"}, headers={"X-API-Key": "s3cret"})
        assert ok.status_code == 202
        assert c.get("/sources").status_code == 200  # reads stay open
    get_settings.cache_clear()
