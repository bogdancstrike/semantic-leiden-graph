"""Reproducible exact-name mention statistics over the evidence actually analyzed."""

import re
import unicodedata
from collections import Counter
from datetime import UTC, datetime


def entity_statistics(analysis, documents):
    rows = []
    memberships = []
    all_mentions = set()
    for entity in analysis.get("entities", []):
        words = unicodedata.normalize("NFC", entity["name"]).split()
        if not words:
            continue
        pattern = re.compile(
            r"(?<!\w)" + r"\s+".join(map(re.escape, words)) + r"(?!\w)", re.IGNORECASE
        )
        ids, sources, timeline, examples, dates = set(), {}, {}, [], []
        mentions = 0
        for doc in documents:
            text = unicodedata.normalize("NFC", doc.get("text", ""))
            matches = list(pattern.finditer(text))
            if not matches:
                continue
            count = len(matches)
            mentions += count
            ids.add(doc["id"])
            source = doc.get("source")
            bucket = sources.setdefault(
                source, {"source": source, "documents": 0, "mentions": 0}
            )
            bucket["documents"] += 1
            bucket["mentions"] += count
            updated = None
            try:
                stamp = datetime.fromisoformat(doc["updated_at"])
                if stamp.tzinfo is not None:
                    stamp = stamp.astimezone(UTC)
                    updated = stamp.isoformat()
                    dates.append(updated)
                    day = stamp.date().isoformat()
                    bucket = timeline.setdefault(
                        day, {"date": day, "documents": 0, "mentions": 0}
                    )
                    bucket["documents"] += 1
                    bucket["mentions"] += count
            except (KeyError, ValueError, TypeError):
                pass
            if len(examples) < 3:
                start = max(0, matches[0].start() - 90)
                end = min(len(text), matches[0].end() + 150)
                examples.append(
                    {
                        "id": doc["id"],
                        "external_id": doc.get("external_id", doc["id"]),
                        "text": ("…" if start else "")
                        + text[start:end]
                        + ("…" if end < len(text) else ""),
                        "source": source,
                        "updated_at": updated,
                    }
                )
        memberships.append(ids)
        all_mentions.update(ids)
        rows.append(
            {
                **entity,
                "mention_count": mentions,
                "document_count": len(ids),
                "document_share_percent": round(len(ids) * 100 / len(documents), 1)
                if documents
                else 0,
                "first_updated_at": min(dates) if dates else None,
                "last_updated_at": max(dates) if dates else None,
                "sources": sorted(
                    sources.values(), key=lambda v: (-v["documents"], v["source"] or "")
                ),
                "timeline": sorted(timeline.values(), key=lambda v: v["date"]),
                "examples": examples,
            }
        )
    for index, row in enumerate(rows):
        related = []
        for other_index, other in enumerate(rows):
            count = len(memberships[index] & memberships[other_index])
            if index != other_index and count:
                related.append(
                    {
                        "name": other["name"],
                        "label": other["label"],
                        "document_count": count,
                    }
                )
        row["co_occurrences"] = sorted(
            related, key=lambda v: (-v["document_count"], v["name"])
        )[:8]
    return {
        "scope": "analyzed_evidence",
        "documents": len(documents),
        "truncated_documents": sum(bool(d.get("truncated")) for d in documents),
        "mentions": sum(row["mention_count"] for row in rows),
        "documents_with_entities": len(all_mentions),
        "types": dict(Counter(row["label"] for row in rows)),
        "entities": rows,
    }
