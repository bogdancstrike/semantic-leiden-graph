"""SQLite report snapshots and persistent UTC schedule state (single API process)."""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from app.errors import NotFoundError


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
            for community in run.get("communities", []):
                if (
                    memberships is not None
                    and (run["id"], community["community_id"]) not in memberships
                    and document_id not in {d["id"] for d in community["documents"]}
                ):
                    continue
                analysis = community.get("analysis", {})
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
                        "error": community.get("error"),
                        "scope": run.get("scope"),
                    }
                )
        return {"topics": topics[offset : offset + limit], "total": len(topics)}

    def save(self, run: dict) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO runs VALUES (?, ?, ?)",
                (run["id"], run["created_at"], json.dumps(run)),
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
