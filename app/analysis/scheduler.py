"""Daily UTC scheduler. Persist due times and never build an unbounded job queue."""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta

from app.analysis.service import utcnow
from app.errors import BusyError
from app.schemas import AnalysisRequest

log = logging.getLogger(__name__)


class AnalysisScheduler:
    def __init__(self, service):
        self.service = service
        self._stop = threading.Event()
        self._thread = None

    @property
    def enabled(self):
        return (
            self.service.settings.analysis_schedule_enabled
            and self.service.llm.configured
        )

    def status(self):
        s = self.service.settings
        return {
            "enabled": self.enabled,
            "interval_hours": s.analysis_interval_hours,
            "lookback_hours": 24,
            "next_run_at": self.service.store.due() if self.enabled else None,
        }

    def tick(self, now=None):
        if not self.enabled:
            return None
        now = now or utcnow()
        due = self.service.store.due()
        interval = timedelta(hours=self.service.settings.analysis_interval_hours)
        if due is None:
            self.service.store.set_due((now + interval).isoformat())
            return None
        if now < datetime.fromisoformat(due) or self.service.container.jobs.active():
            return None
        try:
            job = self.service.submit(AnalysisRequest(), trigger="scheduled", now=now)
        except BusyError:
            return None
        self.service.store.set_due((now + interval).isoformat())
        return job

    def start(self):
        self.tick()
        if not self.enabled or self._thread:
            return
        self._thread = threading.Thread(
            target=self._loop, name="analysis-scheduler", daemon=True
        )
        self._thread.start()

    def _loop(self):
        while not self._stop.wait(30):
            try:
                self.tick()
            except Exception:
                log.exception("Analysis scheduler tick failed; retrying in 30 seconds")

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
