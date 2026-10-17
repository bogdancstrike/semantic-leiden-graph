"""Temporary disk-backed ranked evidence, deleted automatically when the job ends."""

import hashlib
import json
import sqlite3
from contextlib import AbstractContextManager

from app.analysis.profile import normalized_timestamp, population_profile


class Candidates(AbstractContextManager):
    def __init__(self):
        self.db = sqlite3.connect("")
        self.db.execute(
            "CREATE TABLE candidates (cid INTEGER, id TEXT PRIMARY KEY, strength REAL, body TEXT, source TEXT, updated_at TEXT, fingerprint TEXT NOT NULL)"
        )
        self.db.execute("CREATE INDEX ranking ON candidates (cid, strength DESC, id)")

    def add(self, cid, doc, *, fingerprint=None):
        self.db.execute(
            "INSERT OR REPLACE INTO candidates VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                cid,
                doc["id"],
                doc["strength"],
                json.dumps(doc),
                doc.get("source"),
                normalized_timestamp(doc.get("updated_at")),
                fingerprint or hashlib.sha256(doc["text"].encode()).hexdigest(),
            ),
        )

    def counts(self):
        self.db.commit()
        return dict(
            self.db.execute("SELECT cid, count(*) FROM candidates GROUP BY cid")
        )

    def prefix(self, cid, n):
        return [
            json.loads(row[0])
            for row in self.db.execute(
                "SELECT body FROM candidates WHERE cid=? ORDER BY strength DESC, id LIMIT ?",
                (cid, n),
            )
        ]

    def profile(self, cid):
        return population_profile(self.db, cid)

    def members(self):
        cursor = self.db.execute("SELECT cid, id FROM candidates")
        while batch := cursor.fetchmany(1000):
            yield batch

    def __exit__(self, *args):
        self.db.close()
