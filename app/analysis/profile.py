"""Bounded, exact collection metrics computed in SQLite, independent of the LLM."""

import json
from datetime import UTC, datetime


def normalized_timestamp(value):
    try:
        stamp = datetime.fromisoformat(value)
        return stamp.astimezone(UTC).isoformat() if stamp.tzinfo else None
    except (TypeError, ValueError):
        return None


def population_profile(db, cid):
    total, unique, first, last, known = db.execute(
        "SELECT count(*),count(DISTINCT fingerprint),min(updated_at),max(updated_at),count(updated_at) FROM candidates WHERE cid=?",
        (cid,),
    ).fetchone()
    source_labels = db.execute(
        "SELECT count(*) FROM (SELECT source FROM candidates WHERE cid=? GROUP BY source)",
        (cid,),
    ).fetchone()[0]
    sources = [
        {"source": source, "documents": count}
        for source, count in db.execute(
            "SELECT source,count(*) n FROM candidates WHERE cid=? GROUP BY source ORDER BY n DESC,source LIMIT 20",
            (cid,),
        )
    ]
    span = (
        (datetime.fromisoformat(last) - datetime.fromisoformat(first)).total_seconds()
        if first
        else 0
    )
    unit, length = (
        ("hour", 13)
        if span <= 96 * 3600
        else ("day", 10)
        if span <= 96 * 86400
        else ("month", 7)
    )
    # Return latest 96 nonempty buckets, with an explicit count for omitted earlier buckets.
    activity = [
        {"date": date, "documents": count}
        for date, count in db.execute(
            "SELECT substr(updated_at,1,?) bucket,count(*) FROM candidates WHERE cid=? AND updated_at IS NOT NULL GROUP BY bucket ORDER BY bucket DESC LIMIT 96",
            (length, cid),
        )
    ]
    activity.reverse()
    duplicates = db.execute(
        "SELECT count(*) FROM (SELECT fingerprint FROM candidates WHERE cid=? GROUP BY fingerprint HAVING count(*)>1)",
        (cid,),
    ).fetchone()[0]
    examples = []
    for doc_id, count in db.execute(
        "SELECT min(id),count(*) n FROM candidates WHERE cid=? GROUP BY fingerprint HAVING n>1 ORDER BY n DESC,min(id) LIMIT 3",
        (cid,),
    ):
        doc = json.loads(
            db.execute("SELECT body FROM candidates WHERE id=?", (doc_id,)).fetchone()[
                0
            ]
        )
        examples.append(
            {
                "id": doc_id,
                "external_id": doc.get("external_id", doc_id),
                "text": doc["text"][:200],
                "documents": count,
            }
        )
    return {
        "scope": "eligible_community",
        "documents": total,
        "unique_texts": unique,
        "repeated_documents": total - unique,
        "duplicate_groups": duplicates,
        "source_labels": source_labels,
        "sources": sources,
        "other_source_documents": total - sum(s["documents"] for s in sources),
        "activity_unit": unit,
        "activity": activity,
        "omitted_activity_documents": known - sum(b["documents"] for b in activity),
        "unknown_updated_at": total - known,
        "first_updated_at": first,
        "last_updated_at": last,
        "repetition_examples": examples,
    }
