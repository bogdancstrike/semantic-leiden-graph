"""Discover communities, snapshot top-k recent evidence, analyze, and persist."""

from __future__ import annotations

import threading
import uuid
from datetime import UTC, datetime, timedelta
from itertools import islice

from app.analysis.candidates import Candidates
from app.analysis.llm import INSTRUCTIONS, LLMClient
from app.analysis.store import AnalysisStore
from app.errors import BusyError, DependencyUnavailable, NotFoundError
from app.pipeline.ingest import IdList
from app.pipeline.jobs import JobCancelled
from app.schemas import AnalysisRequest


def utcnow() -> datetime:
    return datetime.now(UTC)


class AnalysisService:
    def __init__(self, container):
        self.container = container
        self.settings = container.settings
        self.llm = LLMClient(self.settings)
        self.store = AnalysisStore(self.settings.analysis_db_path)
        self._submission_lock = threading.Lock()

    def topic(self, topic_id):
        try:
            run_id, cid = topic_id.rsplit(":", 1)
            cid = int(cid)
        except (ValueError, AttributeError):
            raise NotFoundError("Topic not found") from None
        run = self.store.get(run_id)
        community = next(
            (c for c in run["communities"] if c["community_id"] == cid), None
        )
        if community is None:
            raise NotFoundError("Topic not found")
        return {
            "id": topic_id,
            "run": {k: v for k, v in run.items() if k != "communities"},
            "community": community,
        }

    def topic_documents(self, topic_id, query, limit, offset):
        topic = self.topic(topic_id)
        run, community = topic["run"], topic["community"]
        position = total = 0
        documents = []
        membership_available = bool(
            self.store.member_ids(run["id"], community["community_id"], limit=1)
        )
        while True:
            ids = self.store.member_ids(run["id"], community["community_id"], position)
            if not membership_available:
                ids = [d["id"] for d in community["documents"]]
            if not ids:
                break
            page = self.container.es.topic_documents(ids, query, offset + limit)
            total += page["total"]
            documents.extend(page["documents"])
            documents.sort(key=lambda d: (-d["score"], d.get("external_id", d["id"])))
            del documents[offset + limit :]
            position += len(ids)
            if not membership_available or len(ids) < 1000:
                break
        return {
            "documents": documents[offset : offset + limit],
            "total": total,
            "membership_available": membership_available,
        }

    def submit(
        self,
        request: AnalysisRequest,
        *,
        trigger: str = "manual",
        now: datetime | None = None,
        document_ids=None,
        source: str | None = None,
    ):
        self.llm.require_configured()
        with self._submission_lock:
            if trigger != "import" and any(
                j.kind == "analysis" and j.status in ("queued", "running")
                for j in self.container.jobs.list()
            ):
                raise BusyError("An analysis is already queued or running.")
            now = now or utcnow()
            if request.community_ids is not None and document_ids is None:
                with self.container.structural(blocking=False):
                    document_ids = IdList(
                        self.container.graph.ids_for_communities(request.community_ids)
                    )
                if not document_ids:
                    raise NotFoundError(
                        "The selected communities no longer contain documents. Refresh the graph."
                    )
            run = {
                "id": uuid.uuid4().hex,
                "created_at": now.isoformat(),
                "status": "queued",
                "trigger": trigger,
                "provider": self.settings.llm_provider,
                "model": self.llm.model,
                "instructions": INSTRUCTIONS,
                "top_k": request.top_k,
                "selection_mode": "auto",
                "time_range": request.time_range,
                "scope": {
                    "type": "import",
                    "source": source,
                    "documents": len(document_ids),
                }
                if document_ids is not None
                else {"type": "corpus"},
                "max_communities": request.max_communities
                or self.settings.analysis_max_communities,
                "window_start": request.window_start.isoformat()
                if request.time_range == "custom"
                else None
                if request.time_range == "all"
                else (now - timedelta(hours=request.lookback_hours)).isoformat(),
                "window_end": request.window_end.isoformat()
                if request.time_range == "custom"
                else now.isoformat(),
                "communities": [],
            }
            if request.community_ids is not None:
                run["scope"] = {
                    "type": "communities",
                    "community_ids": request.community_ids,
                    "documents": len(document_ids),
                }
            self.store.save(run)
            # Worker waits for submission to persist job_id before changing the report.
            ready = threading.Event()

            def execute(ctx):
                ready.wait()
                return self._run(ctx, run, document_ids)

            def cancelled():
                ready.wait()
                run.update(status="cancelled", finished_at=utcnow().isoformat())
                self.store.save(run)

            job = self.container.jobs.submit(
                "analysis",
                execute,
                params={"analysis_id": run["id"], **request.model_dump(mode="json")},
                on_cancel=cancelled,
            )
            run["job_id"] = job.id
            self.store.save(run)
            ready.set()
            return job

    def _snapshot(self, ctx, run, candidates, document_ids=None):
        c = self.container
        with c.structural(blocking=True):
            clustering = c._cluster(ctx, None, None)
            run["community_version"] = clustering.get("version")
            unassigned = processed = 0

            def imported():
                ids = iter(document_ids)
                while batch := list(islice(ids, 1000)):
                    yield from c.es.fetch_display(batch).values()

            documents = iter(
                imported()
                if document_ids is not None
                else c.es.iter_analysis_documents(
                    run["window_start"], run["window_end"]
                )
            )
            try:
                while batch := list(islice(documents, 1000)):
                    ctx.progress("selecting evidence", processed, None)
                    processed += len(batch)
                    strengths = c.graph.analysis_strengths(
                        [d["id"] for d in batch if d.get("community_id") is not None]
                    )
                    for doc in batch:
                        cid = doc.get("community_id")
                        if cid is None:
                            unassigned += 1
                            continue
                        text = doc["text"][: self.settings.analysis_document_chars]
                        candidates.add(
                            cid,
                            {
                                "id": doc["id"],
                                "external_id": doc.get("external_id", doc["id"]),
                                "text": text,
                                "truncated": len(text) < len(doc["text"]),
                                "source": doc.get("source"),
                                "updated_at": doc.get("updated_at"),
                                "strength": strengths.get(doc["id"], 0.0),
                            },
                        )
            finally:
                if hasattr(documents, "close"):
                    documents.close()
            counts = candidates.counts()
            for batch in candidates.members():
                self.store.add_members(run["id"], batch)
            selected = sorted(counts, key=lambda cid: (-counts[cid], cid))[
                : run["max_communities"]
            ]
            run.update(
                eligible_documents=sum(counts.values()) + unassigned,
                unassigned_documents=unassigned,
                eligible_communities=len(counts),
                skipped_communities=len(counts) - len(selected),
                communities=[
                    {
                        "community_id": cid,
                        "document_count": counts[cid],
                        "documents": [],
                        "status": "pending",
                    }
                    for cid in selected
                ],
            )

    def _run(self, ctx, run, document_ids=None):
        with Candidates() as candidates:
            return self._analyze(ctx, run, candidates, document_ids)

    def _analyze(self, ctx, run, candidates, document_ids):
        try:
            ctx.check_cancelled()
            run["status"] = "running"
            self.store.save(run)
            self._snapshot(ctx, run, candidates, document_ids)
            self.store.save(run)
            for i, community in enumerate(run["communities"]):
                ctx.progress("analyzing communities", i, len(run["communities"]))
                metadata = {
                    "community_id": community["community_id"],
                    "community_version": run["community_version"],
                    "window_start": run["window_start"],
                    "window_end": run["window_end"],
                }
                try:
                    count = (
                        min(community["document_count"], run["top_k"])
                        if run["top_k"]
                        else community["document_count"]
                    )
                    evidence, budget = self.llm.pack(
                        metadata,
                        lambda n, cid=community["community_id"]: candidates.prefix(
                            cid, n
                        ),
                        count,
                    )
                    ctx.check_cancelled()
                    community.update(
                        documents=evidence["documents"], token_budget=budget
                    )
                    # Preserve a bounded graph snapshot alongside the evidence, independent of future clustering.
                    ids = [d["id"] for d in evidence["documents"][:80]]
                    with self.container.structural(blocking=True):
                        graph = self.container.graph.subgraph(ids, False, 0, -1.0)
                    display = {d["id"]: d for d in evidence["documents"][:80]}
                    graph["nodes"] = [
                        {
                            **node,
                            "text": display[node["id"]]["text"][:320],
                            "external_id": display[node["id"]]["external_id"],
                        }
                        for node in graph["nodes"]
                        if node["id"] in display
                    ]
                    community["graph"] = graph
                    self.store.save(run)
                    community["analysis"] = self.llm.analyze(evidence)
                    community["status"] = "succeeded"
                except DependencyUnavailable as exc:
                    community.update(status="failed", error=str(exc))
                self.store.save(run)
            ctx.check_cancelled()
            failed = sum(c["status"] == "failed" for c in run["communities"])
            succeeded = len(run["communities"]) - failed
            run.update(
                status="partial"
                if failed and succeeded
                else "failed"
                if failed
                else "succeeded",
                succeeded_communities=succeeded,
                failed_communities=failed,
            )
            if failed and not succeeded:
                run["error"] = (
                    "Analysis failed for every selected community. See the report for provider errors."
                )
        except JobCancelled:
            run.update(status="cancelled")
            raise
        except Exception:
            run.update(
                status="failed",
                error="Analysis could not complete. Check database connectivity and server logs.",
            )
            raise
        finally:
            run["finished_at"] = utcnow().isoformat()
            self.store.save(run)
        if run["status"] == "failed":
            raise DependencyUnavailable(run["error"])
        return {
            "analysis_id": run["id"],
            "status": run["status"],
            "communities": len(run["communities"]),
            "failed_communities": run["failed_communities"],
        }
