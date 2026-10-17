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
