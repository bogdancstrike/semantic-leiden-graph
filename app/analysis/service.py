"""Discover communities, snapshot top-k recent evidence, analyze, and persist."""

from __future__ import annotations

import threading
import uuid
from collections import Counter, defaultdict
from datetime import UTC, datetime, timedelta
from itertools import islice

from app.analysis.llm import LLMClient
from app.analysis.store import AnalysisStore
from app.errors import BusyError, DependencyUnavailable
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

    def submit(
        self,
        request: AnalysisRequest,
        *,
        trigger: str = "manual",
        now: datetime | None = None,
    ):
        self.llm.require_configured()
        with self._submission_lock:
            if any(
                j.kind == "analysis" and j.status in ("queued", "running")
                for j in self.container.jobs.list()
            ):
                raise BusyError("An analysis is already queued or running.")
            now = now or utcnow()
            run = {
                "id": uuid.uuid4().hex,
                "created_at": now.isoformat(),
                "status": "queued",
                "trigger": trigger,
                "provider": self.settings.llm_provider,
                "model": self.llm.model,
                "top_k": request.top_k or self.settings.analysis_top_k,
                "max_communities": request.max_communities
                or self.settings.analysis_max_communities,
                "window_start": (
                    now - timedelta(hours=request.lookback_hours)
                ).isoformat(),
                "window_end": now.isoformat(),
                "communities": [],
            }
            self.store.save(run)
            # Worker waits for submission to persist job_id before changing the report.
            ready = threading.Event()

            def execute(ctx):
                ready.wait()
                return self._run(ctx, run)

            def cancelled():
                ready.wait()
                run.update(status="cancelled", finished_at=utcnow().isoformat())
                self.store.save(run)

            job = self.container.jobs.submit(
                "analysis",
                execute,
                params={"analysis_id": run["id"], **request.model_dump()},
                on_cancel=cancelled,
            )
            run["job_id"] = job.id
            self.store.save(run)
            ready.set()
            return job

    def _snapshot(self, ctx, run):
        c = self.container
        with c.structural(blocking=True):
            clustering = c._cluster(ctx, None, None)
            run["community_version"] = clustering.get("version")
            candidates = defaultdict(list)
            counts = Counter()
            unassigned = 0
            documents = iter(
                c.es.iter_analysis_documents(run["window_start"], run["window_end"])
            )
            try:
                while batch := list(islice(documents, 1000)):
                    ctx.progress(
                        "selecting evidence", sum(counts.values()) + unassigned, None
                    )
                    strengths = c.graph.analysis_strengths(
                        [d["id"] for d in batch if d.get("community_id") is not None]
                    )
                    for doc in batch:
                        cid = doc.get("community_id")
                        if cid is None:
                            unassigned += 1
                            continue
                        counts[cid] += 1
                        # Keep only top-k so memory depends on communities, not corpus size.
                        text = doc["text"][: self.settings.analysis_document_chars]
                        candidates[cid].append(
                            {
                                "id": doc["id"],
                                "external_id": doc.get("external_id", doc["id"]),
                                "text": text,
                                "truncated": len(text) < len(doc["text"]),
                                "source": doc.get("source"),
                                "updated_at": doc.get("updated_at"),
                                "strength": strengths.get(doc["id"], 0.0),
                            }
                        )
                        candidates[cid].sort(key=lambda d: (-d["strength"], d["id"]))
                        del candidates[cid][run["top_k"] :]
            finally:
                if hasattr(documents, "close"):
                    documents.close()
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
                        "documents": candidates[cid],
                        "status": "pending",
                    }
                    for cid in selected
                ],
            )

    def _run(self, ctx, run):
        try:
            ctx.check_cancelled()
            run["status"] = "running"
            self.store.save(run)
            self._snapshot(ctx, run)
            self.store.save(run)
            for i, community in enumerate(run["communities"]):
                ctx.progress("analyzing communities", i, len(run["communities"]))
                evidence = {
                    "community_id": community["community_id"],
                    "community_version": run["community_version"],
                    "window_start": run["window_start"],
                    "window_end": run["window_end"],
                    "documents": community["documents"],
                }
                try:
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
