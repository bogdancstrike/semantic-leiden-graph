"""Idempotent Docker Compose seed job.

* waits for the API (Compose ``depends_on: service_healthy``)
* reads ``SEED_FILE`` -- ``.csv`` (id,text[,metadata...]) or ``.txt`` (one doc per line)
* posts documents in batches to ``/documents/batch`` and then runs Leiden once

Because document IDs are deterministic (UUIDv5 of the external ID; content hash for
.txt lines), re-running the seed never duplicates data: unchanged rows are skipped by
hash comparison. ``SEED_FORCE=true`` just forces the run even when data exists.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

API_URL = os.getenv("API_URL", "http://app:8000").rstrip("/")
SEED_FILE = Path(os.getenv("SEED_FILE", "/app/data/sample.csv"))
SEED_FORCE = os.getenv("SEED_FORCE", "false").lower() in {"1", "true", "yes", "on"}
API_KEY = os.getenv("API_KEY") or None
BATCH = int(os.getenv("SEED_BATCH", "1000"))


def call(method: str, path: str, payload: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if API_KEY:
        headers["X-API-Key"] = API_KEY
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(f"{API_URL}{path}", data=body, method=method, headers=headers)
    try:
        with urlopen(request, timeout=900) as response:
            data = response.read()
            return json.loads(data) if data else {}
    except HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"API {method} {path} failed: HTTP {exc.code}: {details}") from exc
    except URLError as exc:
        raise RuntimeError(f"API {method} {path} unavailable: {exc}") from exc


def load_documents(path: Path) -> list[dict]:
    if not path.exists():
        raise FileNotFoundError(f"Seed file does not exist: {path}")
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            docs = []
            for row in reader:
                row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
                if not row.get("id") or not row.get("text"):
                    continue
                metadata = {k: v for k, v in row.items() if k not in {"id", "text"} and v}
                docs.append({"id": row["id"], "text": row["text"], "metadata": metadata or None})
            return docs
    return [
        {"text": line.strip()}
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]


def main() -> int:
    stats = call("GET", "/stats")
    existing = int(stats.get("documents", 0))
    if existing > 0 and not SEED_FORCE:
        print(f"Seed skipped: {existing} documents already indexed.")
        if int(stats.get("unassigned", 0)) > 0 or int(stats.get("communities", 0)) == 0:
            print("Unclustered documents found; running Leiden.")
            print(json.dumps(call("POST", "/cluster"), indent=2))
        return 0

    docs = load_documents(SEED_FILE)
    if not docs:
        print("Seed skipped: seed file contains no documents.")
        return 0

    print(f"Seeding {len(docs)} documents from {SEED_FILE} ...")
    totals = {"created": 0, "updated": 0, "unchanged": 0, "failed": 0, "edges_upserted": 0}
    for start in range(0, len(docs), BATCH):
        report = call("POST", "/documents/batch", {"documents": docs[start : start + BATCH], "source": "seed"})
        for key in totals:
            totals[key] += int(report.get(key, 0))
    print(json.dumps(totals, indent=2))

    print("Running weighted Leiden and syncing community IDs to Qdrant + Elasticsearch ...")
    print(json.dumps(call("POST", "/cluster"), indent=2))
    print("Seed complete.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"Seed failed: {exc}", file=sys.stderr)
        raise
