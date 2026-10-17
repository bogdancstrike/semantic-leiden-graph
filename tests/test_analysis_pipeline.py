import threading
import time
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock

import pytest

from app.errors import BusyError, DependencyUnavailable
from app.schemas import AnalysisRequest, DocumentIn
from tests.fakes import make_container, make_settings

NOW = datetime(2026, 10, 17, 12, tzinfo=UTC)


@pytest.fixture
def analysis_container():
    c = make_container(
        make_settings(gemini_api_key="test", analysis_document_chars=100)
    )
    yield c
    c.close()


def wait(c, job):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        result = c.jobs.get(job.id)
        if result.status in ("succeeded", "failed", "cancelled"):
            return result
        time.sleep(0.005)
    raise AssertionError("job did not finish")


def seed(c):
    c.ingest_documents(
        [
            DocumentIn(id=str(i), text="railway investment " + "stations " * 30)
            for i in range(6)
        ],
        None,
    )
    ids = sorted(c.es.docs)
    for doc in c.es.docs.values():
        doc["updated_at"] = (NOW - timedelta(hours=1)).isoformat()
    c.es.docs[ids[0]]["updated_at"] = (NOW - timedelta(hours=25)).isoformat()
    c.es.docs[ids[1]]["updated_at"] = (NOW - timedelta(hours=24)).isoformat()
    c.es.docs[ids[2]]["updated_at"] = NOW.isoformat()
    c.es.docs[ids[3]]["updated_at"] = (NOW + timedelta(hours=1)).isoformat()
    return ids


def successful(evidence):
    return {
        "title": "Rail",
        "summary": "Investment",
        "key_findings": [],
        "uncertainties": [],
        "evidence_ids": [d["id"] for d in evidence["documents"]],
    }


def test_discovers_clusters_then_ranks_only_eligible_documents(analysis_container):
    c = analysis_container
    ids = seed(c)
    # Highest global centrality is outside the window. Eligible order is 5, 4, 1.
    c.graph.analysis_strengths = Mock(
        return_value={doc_id: i for i, doc_id in enumerate(ids)}
    )
    c.analysis.llm.analyze = Mock(side_effect=successful)
    job = c.analysis.submit(AnalysisRequest(top_k=2), now=NOW)
    result = wait(c, job)
    assert result.status == "succeeded", result.error
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["community_version"] == 1
    assert report["job_id"] == job.id
    assert report["eligible_documents"] == 3
    assert report["window_start"] == (NOW - timedelta(hours=24)).isoformat()
    docs = report["communities"][0]["documents"]
    assert [d["id"] for d in docs] == [ids[5], ids[4]]
    assert all(len(d["text"]) == 100 and d["truncated"] for d in docs)
    sent = c.analysis.llm.analyze.call_args.args[0]
    assert sent["documents"] == docs
    assert sent["community_version"] == report["community_version"]


def test_top_k_ties_are_deterministic_and_lower_boundary_is_included(
    analysis_container,
):
    c = analysis_container
    ids = seed(c)
    c.graph.analysis_strengths = Mock(return_value={})
    c.analysis.llm.analyze = Mock(side_effect=successful)
    job = c.analysis.submit(AnalysisRequest(top_k=50), now=NOW)
    assert wait(c, job).status == "succeeded"
    docs = c.analysis.store.get(job.params["analysis_id"])["communities"][0][
        "documents"
    ]
    assert [d["id"] for d in docs] == [ids[1], ids[4], ids[5]]


def test_empty_window_avoids_llm_calls(analysis_container):
    c = analysis_container
    c.analysis.llm.analyze = Mock()
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    assert wait(c, job).status == "succeeded"
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["eligible_documents"] == 0 and report["communities"] == []
    c.analysis.llm.analyze.assert_not_called()


def seed_two_communities(c):
    seed(c)
    ids = sorted(c.es.docs)
    for i, doc_id in enumerate(ids):
        c.es.docs[doc_id].update(
            community_id=i // 3, updated_at=(NOW - timedelta(hours=1)).isoformat()
        )
        c.graph.nodes[doc_id] = i // 3
    # Control the discovery output to exercise partial and limited reports independently.
    c._cluster = Mock(return_value={"version": 9})


def test_partial_failures_preserve_other_communities(analysis_container):
    c = analysis_container
    seed_two_communities(c)
    c.analysis.llm.analyze = Mock(
        side_effect=[
            DependencyUnavailable("quota"),
            successful({"documents": [{"id": "b"}]}),
        ]
    )
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    assert wait(c, job).status == "succeeded"
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["status"] == "partial"
    assert report["failed_communities"] == 1 and report["succeeded_communities"] == 1
    assert report["communities"][0]["error"] == "quota"


def test_every_provider_failure_marks_job_and_report_failed(analysis_container):
    c = analysis_container
    seed(c)
    c.analysis.llm.analyze = Mock(side_effect=DependencyUnavailable("quota"))
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    assert wait(c, job).status == "failed"
    assert c.analysis.store.get(job.params["analysis_id"])["status"] == "failed"


def test_community_limit_is_reported(analysis_container):
    c = analysis_container
    seed_two_communities(c)
    c.analysis.llm.analyze = Mock(side_effect=successful)
    job = c.analysis.submit(AnalysisRequest(max_communities=1), now=NOW)
    assert wait(c, job).status == "succeeded"
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["eligible_communities"] == 2 and report["skipped_communities"] == 1
    assert len(report["communities"]) == 1


def test_unassigned_documents_are_counted_without_llm_calls(analysis_container):
    c = analysis_container
    c.ingest_documents([DocumentIn(text="one isolated document")], None)
    next(iter(c.es.docs.values()))["updated_at"] = (
        NOW - timedelta(hours=1)
    ).isoformat()
    c.analysis.llm.analyze = Mock()
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    assert wait(c, job).status == "succeeded"
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["unassigned_documents"] == 1
    assert report["communities"] == []
    c.analysis.llm.analyze.assert_not_called()


def test_queued_cancellation_persists_report_and_rejects_duplicates(analysis_container):
    c = analysis_container
    release = threading.Event()
    c.jobs.submit("cluster", lambda _: release.wait(3) or {})
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    try:
        with pytest.raises(BusyError):
            c.analysis.submit(AnalysisRequest(), now=NOW)
        c.jobs.cancel(job.id)
    finally:
        release.set()
    assert wait(c, job).status == "cancelled"
    # Callback follows status update, allow completion of the worker callback.
    deadline = time.monotonic() + 1
    while (
        c.analysis.store.get(job.params["analysis_id"])["status"] != "cancelled"
        and time.monotonic() < deadline
    ):
        time.sleep(0.005)
    assert c.analysis.store.get(job.params["analysis_id"])["status"] == "cancelled"


def test_running_cancellation_preserves_evidence(analysis_container):
    c = analysis_container
    seed(c)
    entered, release = threading.Event(), threading.Event()

    def analyze(evidence):
        entered.set()
        release.wait(3)
        return successful(evidence)

    c.analysis.llm.analyze = analyze
    job = c.analysis.submit(AnalysisRequest(), now=NOW)
    try:
        assert entered.wait(2)
        # LLM network calls do not hold the structural lock.
        with c.structural(blocking=False):
            pass
        c.jobs.cancel(job.id)
    finally:
        release.set()
    assert wait(c, job).status == "cancelled"
    report = c.analysis.store.get(job.params["analysis_id"])
    assert report["status"] == "cancelled" and report["communities"][0]["documents"]


def test_scheduler_initial_due_restart_and_busy_retry(analysis_container):
    c = analysis_container
    c.settings.analysis_schedule_enabled = True
    scheduler = c.analysis_scheduler
    assert scheduler.tick(NOW) is None
    assert scheduler.status()["next_run_at"] == (NOW + timedelta(hours=24)).isoformat()
    assert scheduler.tick(NOW + timedelta(hours=23)) is None
    submit = Mock(return_value=object())
    c.analysis.submit = submit
    c.jobs.active = Mock(return_value=True)
    assert scheduler.tick(NOW + timedelta(hours=24)) is None
    assert submit.call_count == 0
    c.jobs.active = Mock(return_value=False)
    job = scheduler.tick(NOW + timedelta(hours=25))
    assert job is submit.return_value
    assert submit.call_args.kwargs["trigger"] == "scheduled"
    assert submit.call_args.args[0].lookback_hours == 24
    assert scheduler.status()["next_run_at"] == (NOW + timedelta(hours=49)).isoformat()
    assert scheduler.tick(NOW + timedelta(hours=25)) is None


@pytest.mark.parametrize("enabled,key", [(False, "test"), (True, None)])
def test_scheduler_never_submits_when_disabled_or_unconfigured(enabled, key):
    c = make_container(
        make_settings(analysis_schedule_enabled=enabled, gemini_api_key=key)
    )
    try:
        c.analysis.submit = Mock()
        assert c.analysis_scheduler.tick(NOW) is None
        assert c.analysis_scheduler.status()["enabled"] is False
        assert c.analysis.store.due() is None
        c.analysis.submit.assert_not_called()
    finally:
        c.close()
