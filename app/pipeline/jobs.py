"""In-process background job runner.

Long operations (CSV import, graph rebuild, Leiden) run on a **single worker thread**:

* HTTP requests return immediately with a job ID (202 Accepted) and the UI polls
  ``GET /jobs/{id}`` -- no proxy timeouts, no half-finished work when a browser tab closes;
* one worker serialises structural writes, so a rebuild can never interleave with a
  clustering run that projects the same graph;
* cancellation is cooperative: the progress callback raises ``JobCancelled``.

Limitation (docs/specs.md §20 and §29): job state is process-local. Running more
than one API replica needs a shared queue (Kafka/Redis/Arq/Celery) and a job table.
"""

from __future__ import annotations

import logging
import threading
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from collections.abc import Callable

from app.errors import ConflictError, NotFoundError
from app.schemas import JobOut, JobStatus

log = logging.getLogger(__name__)


class JobCancelled(Exception):
    pass


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class Job:
    id: str
    kind: str
    params: dict[str, Any]
    status: JobStatus = JobStatus.queued
    phase: str = "queued"
    processed: int = 0
    total: int | None = None
    message: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    created_at: datetime = field(default_factory=_now)
    started_at: datetime | None = None
    finished_at: datetime | None = None
    cancel_requested: bool = False

    def to_out(self) -> JobOut:
        return JobOut(
            id=self.id,
            kind=self.kind,
            status=self.status,
            phase=self.phase,
            processed=self.processed,
            total=self.total,
            message=self.message,
            params=self.params,
            result=self.result,
            error=self.error,
            created_at=self.created_at,
            started_at=self.started_at,
            finished_at=self.finished_at,
        )


class JobContext:
    """Handed to job functions for progress reporting and cancellation checks."""

    def __init__(self, manager: JobManager, job: Job) -> None:
        self._manager = manager
        self._job = job

    def progress(self, phase: str, processed: int, total: int | None = None, message: str | None = None) -> None:
        with self._manager._lock:
            if self._job.cancel_requested:
                raise JobCancelled()
            self._job.phase = phase
            self._job.processed = processed
            if total is not None:
                self._job.total = total
            if message is not None:
                self._job.message = message

    def check_cancelled(self) -> None:
        if self._job.cancel_requested:
            raise JobCancelled()


JobFn = Callable[[JobContext], dict[str, Any]]


class JobManager:
    def __init__(self, history: int = 50) -> None:
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="job")
        self._jobs: OrderedDict[str, Job] = OrderedDict()
        self._lock = threading.Lock()
        self._history = history

    def submit(self, kind: str, fn: JobFn, params: dict[str, Any] | None = None) -> JobOut:
        job = Job(id=uuid.uuid4().hex, kind=kind, params=params or {})
        with self._lock:
            self._jobs[job.id] = job
            self._evict()
        self._executor.submit(self._run, job, fn)
        return job.to_out()

    def _run(self, job: Job, fn: JobFn) -> None:
        with self._lock:
            if job.cancel_requested:
                job.status, job.phase, job.finished_at = JobStatus.cancelled, "cancelled", _now()
                return
            job.status, job.phase, job.started_at = JobStatus.running, "starting", _now()
        try:
            result = fn(JobContext(self, job))
            with self._lock:
                job.status, job.phase, job.result = JobStatus.succeeded, "done", result
        except JobCancelled:
            with self._lock:
                job.status, job.phase = JobStatus.cancelled, "cancelled"
        except Exception as exc:  # noqa: BLE001 - surfaced to the user via job.error
            log.exception("Job %s (%s) failed", job.id, job.kind)
            with self._lock:
                job.status, job.phase, job.error = JobStatus.failed, "failed", str(exc) or exc.__class__.__name__
        finally:
            with self._lock:
                job.finished_at = _now()

    def _evict(self) -> None:
        finished = [j for j in self._jobs.values() if j.status not in (JobStatus.queued, JobStatus.running)]
        while len(self._jobs) > self._history and finished:
            self._jobs.pop(finished.pop(0).id, None)

    def get(self, job_id: str) -> JobOut:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise NotFoundError(f"Job {job_id} not found")
            return job.to_out()

    def list(self) -> list[JobOut]:
        with self._lock:
            return [job.to_out() for job in reversed(self._jobs.values())]

    def cancel(self, job_id: str) -> JobOut:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                raise NotFoundError(f"Job {job_id} not found")
            if job.status not in (JobStatus.queued, JobStatus.running):
                raise ConflictError(f"Job is already {job.status.value}")
            job.cancel_requested = True
            job.message = "Cancellation requested"
            return job.to_out()

    def active(self) -> bool:
        with self._lock:
            return any(j.status in (JobStatus.queued, JobStatus.running) for j in self._jobs.values())

    def shutdown(self) -> None:
        with self._lock:
            for job in self._jobs.values():
                job.cancel_requested = True
        self._executor.shutdown(wait=False, cancel_futures=True)
