import time

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import create_app
from tests.fakes import make_container, make_settings

CSV = "id,text,desk\nr1,railway infrastructure investment,transport\nr2,railway stations modernization,transport\nf1,football match late goal,sports\nbad,,sports\n"


@pytest.fixture
def client(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("API_KEY", "")
    app = create_app(container_factory=lambda s: make_container(make_settings()))
    with TestClient(app) as test_client:
        yield test_client
    get_settings.cache_clear()


def wait_for_job(client, job_id, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/jobs/{job_id}").json()
        if job["status"] in ("succeeded", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def test_health_ready_config(client):
    assert client.get("/health").json() == {"status": "ok"}
    assert client.get("/ready").json()["status"] == "ready"
    assert client.get("/config").json()["stores"]["content"] == "elasticsearch"


def test_csv_upload_job_end_to_end(client):
    response = client.post(
        "/documents/upload",
        files={"file": ("sample.csv", CSV, "text/csv")},
        data={"run_cluster": "true"},
    )
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    result = job["result"]
    assert result["created"] == 3 and result["failed"] == 1 and result["rows"] == 4
    assert result["errors"][0]["reason"] == "Empty text."
    assert result["clustering"]["community_count"] >= 1

    stats = client.get("/stats").json()
    assert stats["documents"] == 3 and stats["consistent"]

    listing = client.get("/documents", params={"limit": 2}).json()
    assert listing["total"] == 3 and listing["next_cursor"]

    search = client.post("/search", json={"query": "railway", "mode": "hybrid", "top_k": 2})
    assert search.status_code == 200
    assert "Server-Timing" in search.headers
    assert search.json()["results"][0]["external_id"].startswith("r")


def test_upload_needs_the_column_to_analyse_and_judges_content_not_names(client):
    bad = client.post("/documents/upload", files={"file": ("x.csv", "a,b\n1,2\n", "text/csv")})
    assert bad.status_code == 422 and "Choose the column to analyse" in bad.json()["detail"]
    assert bad.json()["details"]["found"] == ["a", "b"]
    workbook = client.post("/documents/upload", files={"file": ("x.csv", b"PK\x03\x04...", "text/csv")})
    assert workbook.status_code == 422 and "Excel workbook" in workbook.json()["detail"]
    any_name = client.post(
        "/documents/upload",
        files={"file": ("export.dat", "a;b\n1;some text\n", "application/octet-stream")},
        data={"text_column": "b", "delimiter": "semicolon", "encoding": "windows-1252", "has_header": "true"},
    )
    assert any_name.status_code == 202, any_name.text
    job = wait_for_job(client, any_name.json()["id"])
    assert job["status"] == "succeeded" and job["result"]["created"] == 1
    assert job["params"]["encoding"] == "windows-1252" and job["params"]["columns"] == ["a", "b"]
    assert job["result"]["format"] == {"encoding": "windows-1252", "delimiter": ";", "has_header": True, "text_column": "b", "id_column": None}


def test_legacy_endpoints_still_work(client):
    created = client.post("/documents", json={"text": "railway infrastructure"}).json()
    assert created["id"] and "semantic_edges_created" in created
    client.post("/documents/batch", json={"texts": ["railway stations", "football goal"]})
    assert client.post("/cluster").status_code == 200
    legacy = client.post("/search/community", json={"query": "railway", "top_k": 3}).json()
    assert legacy["community_id"] is not None and legacy["results"]


def test_validation_errors_are_readable(client):
    response = client.post("/search", json={"query": "", "top_k": 1000})
    assert response.status_code == 422
    assert response.json()["code"] == "validation_failed"


def test_api_key_guards_mutations(monkeypatch):
    get_settings.cache_clear()
    monkeypatch.setenv("API_KEY", "s3cret")
    app = create_app(container_factory=lambda s: make_container(make_settings(api_key="s3cret")))
    with TestClient(app) as c:
        assert c.post("/documents", json={"text": "x"}).status_code == 401
        assert c.post("/documents", json={"text": "x"}, headers={"X-API-Key": "s3cret"}).status_code == 200
        assert c.get("/stats").status_code == 200  # reads stay open
    get_settings.cache_clear()


def test_blank_texts_are_422_not_500(client):
    assert client.post("/documents", json={"text": "   "}).status_code == 422
    assert client.post("/documents/batch", json={"texts": ["ok", ""]}).status_code == 422
    assert client.post("/search", json={"query": "   "}).status_code == 422


def test_similar_unknown_document_is_404(client):
    response = client.get("/documents/00000000-0000-0000-0000-000000000000/similar?method=semantic")
    assert response.status_code == 404 and response.json()["code"] == "not_found"


def test_metadata_filter_search_via_api(client):
    client.post(
        "/documents/batch",
        json={"documents": [
            {"id": "a", "text": "railway funding", "metadata": {"Desk": "transport"}},
            {"id": "b", "text": "railway strike", "metadata": {"desk": "labour"}},
        ]},
    )
    body = {"query": "railway", "mode": "semantic", "filters": {"metadata": {"DESK": "transport"}}}
    results = client.post("/search", json=body).json()["results"]
    assert [r["external_id"] for r in results] == ["a"]


def test_upload_counts_every_bad_row_but_keeps_the_first_200(client):
    rows = "".join(f"e{i},\n" for i in range(250))  # 250 rows with empty text
    long_text = "word " * 40_000
    content = f'id,text\nok,railway stations modernization\n{rows}long,"{long_text}"\n'
    response = client.post("/documents/upload", files={"file": ("big.csv", content, "text/csv")}, data={"run_cluster": "false"})
    assert response.status_code == 202, response.text
    job = wait_for_job(client, response.json()["id"])
    assert job["status"] == "succeeded", job
    result = job["result"]
    assert result["rows"] == 252 and result["created"] == 1
    assert result["failed"] == 251 and len(result["errors"]) == 200 and result["truncated"] == 0

    again = client.post(
        "/documents/upload",
        files={"file": ("big.csv", content, "text/csv")},
        data={"run_cluster": "false", "truncate_long_texts": "true"},
    )
    job = wait_for_job(client, again.json()["id"])
    assert job["result"]["truncated"] == 1 and job["result"]["created"] == 1  # the long row, cut at 20,000
    assert job["params"]["truncate_long_texts"] is True
