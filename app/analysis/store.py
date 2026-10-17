"""SQLite report snapshots and persistent UTC schedule state (single API process)."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from app.errors import ConflictError, NotFoundError


class AnalysisStore:
    def __init__(self, path: str):
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._db:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS schedule (id INTEGER PRIMARY KEY CHECK(id=1), due TEXT NOT NULL)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS members (run_id TEXT, cid INTEGER, doc_id TEXT, PRIMARY KEY(run_id, cid, doc_id))"
            )

    def add_members(self, run_id, rows):
        with self._lock, self._db:
            self._db.executemany(
                "INSERT OR IGNORE INTO members VALUES (?, ?, ?)",
                ((run_id, cid, doc_id) for cid, doc_id in rows),
            )

    def member_ids(self, run_id, cid, offset=0, limit=1000):
        with self._lock:
            return [
                r[0]
                for r in self._db.execute(
                    "SELECT doc_id FROM members WHERE run_id=? AND cid=? ORDER BY doc_id LIMIT ? OFFSET ?",
                    (run_id, cid, limit, offset),
                )
            ]

    def topics(
        self,
        *,
        query="",
        sentiment=None,
        priority=None,
        classification=None,
        trend=None,
        created_after=None,
        created_before=None,
        sort="recent",
        topic_ids=None,
        run_id=None,
        document_id=None,
        limit=24,
        offset=0,
    ):
        with self._lock:
            memberships = (
                set(
                    self._db.execute(
                        "SELECT run_id, cid FROM members WHERE doc_id=?", (document_id,)
                    )
                )
                if document_id
                else None
            )
            rows = self._db.execute(
                "SELECT body FROM runs WHERE (? IS NULL OR id=?) ORDER BY created_at DESC",
                (run_id, run_id),
            ).fetchall()
        topics = []
        for row in rows:
            run = json.loads(row[0])
            if created_after and run["created_at"] < created_after:
                continue
            if created_before and run["created_at"] >= created_before:
                continue
            for community in run.get("communities", []):
                if (
                    memberships is not None
                    and (run["id"], community["community_id"]) not in memberships
                    and document_id not in {d["id"] for d in community["documents"]}
                ):
                    continue
                analysis = community.get("analysis", {})
                if (
                    topic_ids is not None
                    and f"{run['id']}:{community['community_id']}" not in topic_ids
                ):
                    continue
                if classification and classification not in analysis.get(
                    "classifications", []
                ):
                    continue
                if (
                    trend
                    and community.get("trend", {}).get("direction", "unavailable")
                    != trend
                ):
                    continue
                if (
                    priority
                    and (analysis.get("briefing") or {})
                    .get("assessment", {})
                    .get("priority")
                    != priority
                ):
                    continue
                if sentiment and analysis.get("sentiment", "unclear") != sentiment:
                    continue
                if (
                    query
                    and query.casefold()
                    not in json.dumps(analysis, ensure_ascii=False).casefold()
                ):
                    continue
                topics.append(
                    {
                        "id": f"{run['id']}:{community['community_id']}",
                        "run_id": run["id"],
                        "created_at": run["created_at"],
                        "window_start": run["window_start"],
                        "window_end": run["window_end"],
                        "provider": run["provider"],
                        "model": run["model"],
                        "community_version": run.get("community_version"),
                        "community_id": community["community_id"],
                        "status": community["status"],
                        "document_count": community["document_count"],
                        "selected_documents": len(community["documents"]),
                        "analysis": analysis,
                        "trend": community.get("trend"),
                        "error": community.get("error"),
                        "scope": run.get("scope"),
                    }
                )
        if sort == "priority":
            ranks = {"high": 0, "medium": 1, "low": 2}
            topics.sort(
                key=lambda t: (
                    ranks.get(
                        (t["analysis"].get("briefing") or {})
                        .get("assessment", {})
                        .get("priority"),
                        3,
                    ),
                    -t["document_count"],
                )
            )
        elif sort == "documents":
            topics.sort(key=lambda t: (-t["document_count"], t["id"]))
        elif sort == "coverage":
            topics.sort(
                key=lambda t: (
                    -t["selected_documents"] / max(t["document_count"], 1),
                    -t["document_count"],
                )
            )
        return {
            "topics": topics[offset : offset + limit],
            "total": len(topics),
            "stats": {
                "analyzed": sum(t["status"] == "succeeded" for t in topics),
                "pending": sum(t["status"] == "pending" for t in topics),
                "entities": len(
                    {
                        (e["name"], e["label"])
                        for t in topics
                        for e in t["analysis"].get("entities", [])
                    }
                ),
                "trending": sum(
                    t.get("trend", {}).get("direction") == "rising"
                    for t in topics
                    if t.get("trend")
                ),
                "narratives": sum(
                    len(t["analysis"].get("narratives", [])) for t in topics
                ),
                "classifications": len(
                    {
                        label
                        for t in topics
                        for label in t["analysis"].get("classifications", [])
                    }
                ),
            },
        }

    def save(self, run: dict) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO runs VALUES (?, ?, ?)",
                (run["id"], run["created_at"], json.dumps(run)),
            )

    def delete_topic(self, run_id: str, cid: int):
        with self._lock, self._db:
            row = self._db.execute(
                "SELECT body FROM runs WHERE id=?", (run_id,)
            ).fetchone()
            if row is None:
                raise NotFoundError("Topic not found")
            run = json.loads(row[0])
            if run["status"] in ("queued", "running"):
                raise ConflictError(
                    "Wait for this analysis to finish before deleting a topic."
                )
            retained = [c for c in run["communities"] if c["community_id"] != cid]
            if len(retained) == len(run["communities"]):
                raise NotFoundError("Topic not found")
            run["communities"] = retained
            run["succeeded_communities"] = sum(
                c["status"] == "succeeded" for c in retained
            )
            run["failed_communities"] = sum(c["status"] == "failed" for c in retained)
            run.setdefault("deleted_topics", []).append(cid)
            self._db.execute(
                "UPDATE runs SET body=? WHERE id=?", (json.dumps(run), run_id)
            )
            self._db.execute(
                "DELETE FROM members WHERE run_id=? AND cid=?", (run_id, cid)
            )

    def get(self, run_id: str) -> dict:
        with self._lock:
            row = self._db.execute(
                "SELECT body FROM runs WHERE id=?", (run_id,)
            ).fetchone()
        if row is None:
            raise NotFoundError(f"Analysis {run_id} not found")
        return json.loads(row[0])

    def list(self, limit: int = 20, offset: int = 0) -> dict:
        with self._lock:
            rows = self._db.execute(
                "SELECT body FROM runs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            total = self._db.execute("SELECT count(*) FROM runs").fetchone()[0]
        # History does not transfer potentially megabytes of evidence per report.
        runs = [
            {k: v for k, v in json.loads(row[0]).items() if k != "communities"}
            for row in rows
        ]
        return {"runs": runs, "total": total}

    def recover_interrupted(self) -> None:
        with self._lock, self._db:
            rows = self._db.execute("SELECT id, body FROM runs").fetchall()
            for run_id, body in rows:
                run = json.loads(body)
                if run["status"] in ("queued", "running"):
                    run.update(
                        status="failed",
                        error="API restarted before this analysis finished.",
                    )
                    self._db.execute(
                        "UPDATE runs SET body=? WHERE id=?", (json.dumps(run), run_id)
                    )

    def due(self) -> str | None:
        with self._lock:
            row = self._db.execute("SELECT due FROM schedule WHERE id=1").fetchone()
        return row[0] if row else None

    def set_due(self, due: str) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO schedule VALUES (1, ?)", (due,))

    def close(self) -> None:
        with self._lock:
            self._db.close()
