"""Conservative topic volume comparisons across equal, non-overlapping periods."""

from datetime import datetime

import numpy as np


def comparable(current, previous):
    if current.get("embedding_model") != previous.get("embedding_model"):
        return False
    if not current.get("window_start") or not previous.get("window_start"):
        return False
    if current.get("scope", {"type": "corpus"}) != previous.get(
        "scope", {"type": "corpus"}
    ):
        return False
    a, b = (
        datetime.fromisoformat(current["window_start"]),
        datetime.fromisoformat(current["window_end"]),
    )
    c, d = (
        datetime.fromisoformat(previous["window_start"]),
        datetime.fromisoformat(previous["window_end"]),
    )
    duration = (b - a).total_seconds()
    return (
        duration > 0
        and abs(duration - (d - c).total_seconds()) < 60
        and 0 <= (a - d).total_seconds() <= duration
    )


def add_trends(current, previous=None):
    baseline = previous if previous and comparable(current, previous) else None
    old_total = (
        baseline.get(
            "assigned_documents",
            baseline.get("eligible_documents", 0)
            - baseline.get("unassigned_documents", 0),
        )
        if baseline
        else 0
    )
    total = current.get("assigned_documents", 0)
    used = set()
    for topic in current["communities"]:
        topic["trend"] = {
            "direction": "unavailable",
            "reason": "No comparable earlier period with a matching topic.",
        }
        if not baseline or not old_total or not total or not topic.get("centroid"):
            continue
        vector = np.asarray(topic["centroid"])
        matches = []
        for old in baseline["communities"]:
            if old["community_id"] in used or not old.get("centroid"):
                continue
            other = np.asarray(old["centroid"])
            if vector.shape != other.shape:
                continue
            similarity = float(np.dot(vector, other))
            if similarity >= 0.82:
                matches.append((similarity, old))
        if not matches:
            continue
        similarity, old = max(matches, key=lambda pair: pair[0])
        used.add(old["community_id"])
        ratio = (topic["document_count"] / total) / (old["document_count"] / old_total)
        direction = (
            "rising"
            if ratio >= 1.25 and topic["document_count"] >= 3
            else "falling"
            if ratio <= 0.8 and old["document_count"] >= 3
            else "stable"
        )
        topic["trend"] = {
            "direction": direction,
            "share_change_percent": round((ratio - 1) * 100, 1),
            "previous_documents": old["document_count"],
            "current_documents": topic["document_count"],
            "baseline_topic_id": f"{baseline['id']}:{old['community_id']}",
            "similarity": round(similarity, 3),
            "reason": "Change in the topic’s share of documents updated in comparable periods; matched by embedding similarity.",
        }
