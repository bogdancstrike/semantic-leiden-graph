from copy import deepcopy

from app.analysis.trends import add_trends, comparable


def period(start, end, count):
    return {
        "id": "run",
        "scope": {"type": "corpus"},
        "embedding_model": "model",
        "window_start": start,
        "window_end": end,
        "assigned_documents": 100,
        "communities": [
            {"community_id": 0, "document_count": count, "centroid": [1.0, 0.0]}
        ],
    }


def test_trend_matches_meaning_instead_of_changing_community_ids():
    old = period("2026-10-15T00:00:00+00:00", "2026-10-16T00:00:00+00:00", 10)
    current = period("2026-10-16T00:00:00+00:00", "2026-10-17T00:00:00+00:00", 25)
    current["communities"][0]["community_id"] = 9
    add_trends(current, old)
    trend = current["communities"][0]["trend"]
    assert trend["direction"] == "rising" and trend["share_change_percent"] == 150
    assert trend["baseline_topic_id"] == "run:0"


def test_trend_compares_share_not_raw_ingestion_volume():
    old = period("2026-10-15T00:00:00+00:00", "2026-10-16T00:00:00+00:00", 10)
    current = period("2026-10-16T00:00:00+00:00", "2026-10-17T00:00:00+00:00", 20)
    current["assigned_documents"] = 200
    add_trends(current, old)
    assert current["communities"][0]["trend"]["direction"] == "stable"


def test_overlap_different_model_and_all_time_have_no_trend():
    old = period("2026-10-15T00:00:00+00:00", "2026-10-16T00:00:00+00:00", 10)
    current = period("2026-10-15T12:00:00+00:00", "2026-10-16T12:00:00+00:00", 25)
    assert not comparable(current, old)
    add_trends(current, old)
    assert current["communities"][0]["trend"]["direction"] == "unavailable"
    current["window_start"] = None
    assert not comparable(current, old)
    current = deepcopy(old)
    current["embedding_model"] = "another-model"
    assert not comparable(current, old)
