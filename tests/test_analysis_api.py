import json
from unittest.mock import Mock, patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from app.stores.elastic import ElasticStore
from app.stores.graph import GraphStore
from tests.fakes import make_container, make_settings
from tests.test_analysis import CONTENT, response_for
from tests.test_api import wait_for_job


@pytest.fixture
def client(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("API_KEY", "test-auth")
    c = make_container(make_settings(gemini_api_key="provider-secret"))
    c.analysis.llm.context_limits = Mock(return_value=(1_000_000, 4096))
    c.analysis.llm.count_tokens = Mock(return_value=100)
    app = create_app(container_factory=lambda _: c)
    with TestClient(app) as client:
        yield client, c
    get_settings.cache_clear()


def test_analysis_api_runs_discovery_and_sends_real_documents_to_provider(client):
    client, c = client
    captured = []

    def handler(request):
        evidence = json.loads(
            json.loads(request.content)["contents"][0]["parts"][0]["text"]
        )
        captured.append(evidence)
        return httpx.Response(
            200,
            json=response_for(
                "gemini", {**CONTENT, "evidence_ids": [evidence["documents"][0]["id"]]}
            ),
        )

    c.analysis.llm.transport = httpx.MockTransport(handler)
    auth = {"X-API-Key": "test-auth"}
    response = client.post(
        "/documents/batch",
        headers=auth,
        json={
            "texts": ["railway stations investment", "railway infrastructure funding"]
        },
    )
    assert response.status_code == 200
    assert client.post("/jobs/analyze").status_code == 401
    response = client.post("/jobs/analyze", headers=auth, json={"top_k": 1})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    history = client.get("/analysis/runs?limit=1").json()
    report = client.get(f"/analysis/runs/{history['runs'][0]['id']}").json()
    assert report["job_id"] == job["id"]
    assert report["status"] == "succeeded"
    assert report["communities"][0]["analysis"]["title"] == CONTENT["title"]
    assert len(captured) == 1 and len(captured[0]["documents"]) == 1
    assert "railway" in captured[0]["documents"][0]["text"]
    assert report["community_version"] == 1
    assert client.get("/analysis/runs?limit=0").status_code == 422
    assert client.get("/analysis/runs?offset=-1").status_code == 422
    assert client.get("/analysis/runs/missing").status_code == 404
    assert client.get("/analysis/runs?offset=1").json()["runs"] == []


def test_analysis_config_never_exposes_keys(client):
    client, _ = client
    response = client.get("/analysis/config")
    assert response.status_code == 200
    config = response.json()
    assert config["provider"] == "gemini" and config["model"] == "gemini-flash-latest"
    assert config["configured"] is True
    assert "provider-secret" not in response.text and "test-auth" not in response.text
    assert config["schedule"]["lookback_hours"] == 24


@pytest.mark.parametrize(
    "body",
    [
        {"top_k": 0},
        {"top_k": 51},
        {"lookback_hours": 0},
        {"lookback_hours": 8761},
        {"max_communities": 0},
        {"unexpected": True},
    ],
)
def test_analysis_request_validation(client, body):
    client, _ = client
    assert (
        client.post(
            "/jobs/analyze", headers={"X-API-Key": "test-auth"}, json=body
        ).status_code
        == 422
    )


def test_unconfigured_provider_returns_actionable_503(client):
    client, c = client
    c.settings.gemini_api_key = None
    response = client.post("/jobs/analyze", headers={"X-API-Key": "test-auth"})
    assert response.status_code == 503 and "GEMINI_API_KEY" in response.json()["detail"]
    assert client.get("/analysis/runs").json()["total"] == 0


def test_elasticsearch_filters_window_before_scrolling():
    settings = make_settings()
    es = ElasticStore(settings, client=Mock())
    with patch(
        "app.stores.elastic.scan",
        return_value=iter([{"_id": "a", "_source": {"text": "content"}}]),
    ) as scan:
        docs = list(
            es.iter_analysis_documents("2026-10-16T12:00:00Z", "2026-10-17T12:00:00Z")
        )
    assert docs == [{"id": "a", "text": "content"}]
    assert scan.call_args.kwargs["query"]["query"] == {
        "range": {
            "updated_at": {"gte": "2026-10-16T12:00:00Z", "lt": "2026-10-17T12:00:00Z"}
        }
    }


def test_graph_strengths_use_only_edges_inside_document_community():
    graph = object.__new__(GraphStore)
    graph._read = Mock(return_value=[{"id": "a", "strength": 1.2}])
    assert graph.analysis_strengths(["a"]) == {"a": 1.2}
    assert "o.communityId = d.communityId" in graph._read.call_args.args[0]
    assert graph._read.call_args.kwargs["ids"] == ["a"]


@pytest.mark.parametrize(
    "body",
    [
        {"time_range": "custom"},
        {
            "time_range": "custom",
            "window_start": "2026-10-17T12:00:00Z",
            "window_end": "2026-10-16T12:00:00Z",
        },
        {
            "time_range": "custom",
            "window_start": "2026-10-17T12:00:00",
            "window_end": "2026-10-18T12:00:00",
        },
        {"time_range": "all", "window_start": "2026-10-17T12:00:00Z"},
    ],
)
def test_invalid_custom_periods_are_rejected(client, body):
    client, _ = client
    assert (
        client.post(
            "/jobs/analyze", headers={"X-API-Key": "test-auth"}, json=body
        ).status_code
        == 422
    )


def test_csv_analysis_is_scoped_to_this_file_including_unchanged_rows(client):
    client, c = client
    c.analysis.llm.analyze = Mock(
        side_effect=lambda evidence: {
            **CONTENT,
            "evidence_ids": [evidence["documents"][0]["id"]],
        }
    )
    auth = {"X-API-Key": "test-auth"}
    initial = "id,text\nold,railway stations funding\na,railway station upgrades\nb,railway station investment\n"
    imported = client.post(
        "/documents/upload",
        headers=auth,
        files={"file": ("scoped.csv", initial, "text/csv")},
    )
    assert wait_for_job(client, imported.json()["id"])["status"] == "succeeded"
    # Same source contains an older row absent from this CSV. It must not enter analysis.
    content = (
        "id,text\na,railway station upgrades\nb,railway station investment\nbad,\n"
    )
    imported = client.post(
        "/documents/upload",
        headers=auth,
        files={"file": ("scoped.csv", content, "text/csv")},
        data={"run_analysis": "true", "run_cluster": "false"},
    )
    report = wait_for_job(client, imported.json()["id"])["result"]
    assert report["unchanged"] == 2 and report["failed"] == 1
    analysis = wait_for_job(client, report["analysis_job_id"])
    assert analysis["status"] == "succeeded", analysis
    run = client.get("/analysis/runs/" + report["analysis_id"]).json()
    docs = [d for community in run["communities"] for d in community["documents"]]
    assert {d["external_id"] for d in docs} == {"a", "b"}
    assert run["trigger"] == "import" and run["scope"]["source"] == "csv:scoped.csv"


def test_import_with_unconfigured_analysis_fails_before_writing(client):
    client, c = client
    c.settings.gemini_api_key = None
    response = client.post(
        "/documents/upload",
        headers={"X-API-Key": "test-auth"},
        files={"file": ("x.csv", "id,text\na,railway funding\n", "text/csv")},
        data={"run_analysis": "true"},
    )
    assert response.status_code == 503
    assert c.es.count() == 0


def test_topics_detail_search_and_membership_survive_reclustering(client):
    client, c = client
    auth = {"X-API-Key": "test-auth"}
    c.analysis.llm.analyze = Mock(
        side_effect=lambda evidence: {
            **CONTENT,
            "evidence_ids": [evidence["documents"][0]["id"]],
        }
    )
    client.post(
        "/documents/batch",
        headers=auth,
        json={"texts": ["railway funding granted", "railway investment funding"]},
    )
    job = client.post(
        "/jobs/analyze", headers=auth, json={"time_range": "all", "top_k": 1}
    ).json()
    assert wait_for_job(client, job["id"])["status"] == "succeeded"
    topics = client.get("/analysis/topics").json()
    assert topics["total"] == 1
    topic_id = topics["topics"][0]["id"]
    detail = client.get("/analysis/topics/" + topic_id).json()
    assert detail["community"]["graph"]["nodes"]
    assert detail["run"]["instructions"]
    assert detail["community"]["analysis"]["narratives"]
    assert (
        client.get("/analysis/topics?q=Infrastructure&sentiment=positive").json()[
            "total"
        ]
        == 1
    )
    assert client.get("/analysis/topics?sentiment=negative").json()["total"] == 0
    assert client.get("/analysis/topics?offset=1").json()["topics"] == []
    # Full membership is searchable even though only one document was sent to the LLM.
    for doc in c.es.docs.values():
        doc["community_id"] = 999
    result = client.get(
        "/analysis/topics/" + topic_id + "/documents?q=funding&limit=1"
    ).json()
    assert result["total"] == 2 and result["membership_available"] is True
    assert len(result["documents"]) == 1
    assert (
        client.get("/analysis/topics/" + topic_id + "/documents?q=unrelated").json()[
            "total"
        ]
        == 0
    )
    assert client.get("/analysis/topics/bad").status_code == 404
    assert (
        client.get(
            "/analysis/topics/" + job["params"]["analysis_id"] + ":999"
        ).status_code
        == 404
    )


def test_graph_analysis_captures_member_ids_before_reclustering(client):
    client, c = client
    auth = {"X-API-Key": "test-auth"}
    client.post(
        "/documents/batch",
        headers=auth,
        json={"texts": ["railway investment", "railway station funding"]},
    )
    c.cluster_sync()
    cid = next(iter(c.graph.nodes.values()))
    c.analysis.llm.analyze = Mock(
        side_effect=lambda evidence: {
            **CONTENT,
            "evidence_ids": [evidence["documents"][0]["id"]],
        }
    )
    job = client.post(
        "/jobs/analyze",
        headers=auth,
        json={"time_range": "all", "community_ids": [cid]},
    ).json()
    assert wait_for_job(client, job["id"])["status"] == "succeeded"
    run = client.get("/analysis/runs/" + job["params"]["analysis_id"]).json()
    assert run["scope"]["type"] == "communities"
    assert run["scope"]["documents"] == 2
    assert run["eligible_documents"] == 2


def test_topic_filters_dates_sort_saved_entities_and_delete_preserve_documents(client):
    client, c = client
    auth = {"X-API-Key": "test-auth"}
    client.post("/documents/batch", headers=auth, json={"texts": ["railway funding"]})
    document_id = next(iter(c.es.docs))
    run = {
        "id": "filters",
        "created_at": "2026-10-17T12:00:00+00:00",
        "status": "succeeded",
        "window_start": "2026-10-16T12:00:00+00:00",
        "window_end": "2026-10-17T12:00:00+00:00",
        "provider": "gemini",
        "model": "test",
        "communities": [
            {
                "community_id": cid,
                "status": "succeeded",
                "document_count": count,
                "documents": [
                    {
                        "id": document_id,
                        "text": "Rail Agency funds stations. Rail Agency confirms.",
                        "updated_at": "2026-10-17T12:00:00Z",
                    }
                ],
                "analysis": {
                    "title": f"Topic {cid}",
                    "sentiment": "neutral",
                    "classifications": ["transport" if cid == 1 else "energy"],
                    "entities": [
                        {
                            "name": "Rail Agency",
                            "label": "ORG",
                            "evidence_ids": [document_id],
                        }
                    ],
                },
                "trend": {"direction": "rising" if cid == 1 else "stable"},
            }
            for cid, count in [(1, 3), (2, 10)]
        ],
    }
    c.analysis.store.save(run)
    c.analysis.store.add_members("filters", [(1, document_id), (2, document_id)])
    assert (
        client.get("/analysis/topics", params={"q": "Rail Agency"}).json()["total"] == 2
    )
    assert (
        client.get(
            "/analysis/topics",
            params={"classification": "transport", "trend": "rising"},
        ).json()["total"]
        == 1
    )
    assert (
        client.get("/analysis/topics", params={"topic_ids": ["filters:1"]}).json()[
            "total"
        ]
        == 1
    )
    assert (
        client.get("/analysis/topics?sort=documents").json()["topics"][0][
            "community_id"
        ]
        == 2
    )
    assert (
        client.get("/analysis/topics?sort=coverage").json()["topics"][0]["community_id"]
        == 1
    )
    assert (
        client.get(
            "/analysis/topics", params={"created_after": "2026-10-18T00:00:00Z"}
        ).json()["total"]
        == 0
    )
    # Exclusive upper boundary, including timezone conversion, must be passed to the store.
    assert (
        client.get(
            "/analysis/topics", params={"created_before": "2026-10-17T15:00:00+03:00"}
        ).json()["total"]
        == 0
    )
    assert (
        client.get(
            "/analysis/topics", params={"created_before": "2026-10-17T15:00:01+03:00"}
        ).json()["total"]
        == 2
    )
    details = client.get("/analysis/topics/filters:1").json()
    statistics = details["community"]["entity_statistics"]
    assert statistics["mentions"] == 2 and statistics["documents_with_entities"] == 1
    assert statistics["entities"][0]["document_count"] == 1
    assert statistics["entities"][0]["document_share_percent"] == 100
    # Statistics describe saved evidence, unaffected by current document edits.
    c.es.docs[document_id]["text"] = "Changed source text without that entity"
    assert (
        client.get("/analysis/topics/filters:1").json()["community"][
            "entity_statistics"
        ]
        == statistics
    )
    assert client.delete("/analysis/topics/filters:1").status_code == 401
    assert client.delete("/analysis/topics/filters:1", headers=auth).status_code == 200
    assert client.get("/analysis/topics/filters:1").status_code == 404
    assert client.get("/analysis/topics/filters:1/documents").status_code == 404
    assert c.analysis.store.member_ids("filters", 1) == []
    assert c.analysis.store.member_ids("filters", 2) == [document_id]
    assert client.get("/analysis/topics").json()["total"] == 1
    assert c.es.count() == 1
    assert client.delete("/analysis/topics/filters:1", headers=auth).status_code == 404
    run["status"] = "running"
    c.analysis.store.save(run)
    assert client.delete("/analysis/topics/filters:2", headers=auth).status_code == 409


def test_rich_briefing_priority_reanalysis_and_profile_are_integrated(client):
    from tests.test_analysis_briefing import BRIEFING

    client, c = client
    auth = {"X-API-Key": "test-auth"}

    def rich(evidence):
        doc_id = evidence["documents"][0]["id"]
        briefing = json.loads(json.dumps(BRIEFING).replace('"a"', json.dumps(doc_id)))
        return {**CONTENT, "evidence_ids": [doc_id], "briefing": briefing}

    c.analysis.llm.analyze = Mock(side_effect=rich)
    client.post(
        "/documents/batch",
        headers=auth,
        json={"texts": ["railway funding approved", "railway funding confirmed"]},
    )
    job = client.post(
        "/jobs/analyze", headers=auth, json={"time_range": "all", "top_k": 1}
    ).json()
    assert wait_for_job(client, job["id"])["status"] == "succeeded"
    old_id = job["params"]["analysis_id"]
    old_report = c.analysis.store.get(old_id)
    topic_id = f"{old_id}:{old_report['communities'][0]['community_id']}"
    old_members = set(
        c.analysis.store.member_ids(
            old_id, old_report["communities"][0]["community_id"]
        )
    )
    detail = client.get("/analysis/topics/" + topic_id).json()
    assert detail["community"]["population_profile"]["documents"] == 2
    assert len(detail["community"]["documents"]) == 1
    sent = c.analysis.llm.analyze.call_args.args[0]
    assert sent["population_profile"]["documents"] == 2
    assert "repetition_examples" not in sent["population_profile"]
    assert (
        client.get("/analysis/topics?priority=medium&sort=priority").json()["total"]
        == 1
    )
    assert client.get("/analysis/topics?priority=high").json()["total"] == 0
    assert client.get("/analysis/topics?priority=invalid").status_code == 422
    client.post(
        "/documents/batch",
        headers=auth,
        json={"texts": ["new railway funding outside old membership"]},
    )
    assert client.post("/analysis/topics/" + topic_id + "/reanalyze").status_code == 401
    response = client.post("/analysis/topics/" + topic_id + "/reanalyze", headers=auth)
    assert response.status_code == 202, response.text
    assert wait_for_job(client, response.json()["id"])["status"] == "succeeded"
    new_report = c.analysis.store.get(response.json()["params"]["analysis_id"])
    assert (
        new_report["id"] != old_id
        and new_report["scope"]["origin_topic_id"] == topic_id
    )
    assert {
        d["id"] for t in new_report["communities"] for d in t["documents"]
    } == old_members
    assert c.analysis.store.get(old_id) == old_report
    c.settings.gemini_api_key = None
    assert (
        client.post(
            "/analysis/topics/" + topic_id + "/reanalyze", headers=auth
        ).status_code
        == 503
    )
