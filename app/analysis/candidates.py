"""Temporary disk-backed ranked evidence, deleted automatically when the job ends."""

import json
import sqlite3
from contextlib import AbstractContextManager


class Candidates(AbstractContextManager):
    def __init__(self):
        self.db = sqlite3.connect("")
        self.db.execute(
            "CREATE TABLE candidates (cid INTEGER, id TEXT PRIMARY KEY, strength REAL, body TEXT)"
        )
        self.db.execute("CREATE INDEX ranking ON candidates (cid, strength DESC, id)")

    def add(self, cid, doc):
        self.db.execute(
            "INSERT OR REPLACE INTO candidates VALUES (?, ?, ?, ?)",
            (cid, doc["id"], doc["strength"], json.dumps(doc)),
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

    def members(self):
        cursor = self.db.execute("SELECT cid, id FROM candidates")
        while batch := cursor.fetchmany(1000):
            yield batch

    def __exit__(self, *args):
        self.db.close()
