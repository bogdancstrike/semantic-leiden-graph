"""Opt-in HTTP smoke test against the running Compose stack and configured LLM.

ANALYSIS_TEST_API_URL=http://localhost:8000 RUN_LIVE_LLM_ANALYSIS=1 pytest -q tests/integration/test_analysis_stack.py

Creates a persisted report and incurs one real provider request. Uses existing data.
"""

import os
import time

import httpx
import pytest

URL = os.getenv("ANALYSIS_TEST_API_URL")
pytestmark = pytest.mark.skipif(not URL or os.getenv("RUN_LIVE_LLM_ANALYSIS") != "1", reason="Live analysis stack test is opt-in")


def test_live_cluster_top_k_and_analysis_report():
    headers = {"X-API-Key": os.environ["API_KEY"]} if os.getenv("API_KEY") else {}
    with httpx.Client(base_url=URL, headers=headers, timeout=30) as client:
        ready = client.get("/ready")
        assert ready.status_code == 200 and all(ready.json()["checks"].values())
        config = client.get("/analysis/config").json()
        assert config["configured"]
        assert config["schedule"]["enabled"]
        assert config["schedule"]["next_run_at"]
        response = client.post("/jobs/analyze", json={"time_range": "all", "max_communities": 1})
        assert response.status_code == 202, response.text
        job_id = response.json()["id"]
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            job = client.get(f"/jobs/{job_id}").json()
            if job["status"] in ("succeeded", "failed", "cancelled"):
                break
            time.sleep(1)
        assert job["status"] == "succeeded", job
        report_id = job["result"]["analysis_id"]
        report = client.get(f"/analysis/runs/{report_id}").json()
        assert report["status"] == "succeeded", report.get("error")
        assert report["community_version"] > 0
        assert len(report["communities"]) == 1
        community = report["communities"][0]
        assert 1 <= len(community["documents"]) <= community["document_count"]
        assert report["selection_mode"] == "auto"
        assert community["token_budget"]["input_tokens"] <= community["token_budget"]["input_budget"]
        assert community["analysis"]["narratives"]
        assert "entities" in community["analysis"]
        sent = {doc["id"] for doc in community["documents"]}
        for entity in community["analysis"]["entities"]:
            assert entity["evidence_ids"] and set(entity["evidence_ids"]) <= sent
        topic_id = f"{report_id}:{community['community_id']}"
        detail = client.get(f"/analysis/topics/{topic_id}").json()
        assert detail["community"]["graph"]["nodes"]
        docs = client.get(f"/analysis/topics/{topic_id}/documents").json()
        assert docs["membership_available"] and docs["total"] == community["document_count"]
        assert community["analysis"]["summary"]
        assert set(community["analysis"]["evidence_ids"]) <= {doc["id"] for doc in community["documents"]}
        assert community["documents"] == sorted(community["documents"], key=lambda doc: (-doc["strength"], doc["id"]))
        print(f"Live {config['provider']} analysis succeeded: {len(community['documents'])} documents; community version {report['community_version']}; report {report_id}")
