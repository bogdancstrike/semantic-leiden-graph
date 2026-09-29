"""Tiny stopwatch used to report per-stage latencies (``timings`` + ``Server-Timing``)."""

from __future__ import annotations

import time
from contextlib import contextmanager


class Stopwatch:
    def __init__(self) -> None:
        self._start = time.perf_counter()
        self.stages: dict[str, float] = {}

    @contextmanager
    def stage(self, name: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.stages[name] = self.stages.get(name, 0.0) + (time.perf_counter() - started) * 1000

    def record(self, name: str, millis: float) -> None:
        self.stages[name] = self.stages.get(name, 0.0) + millis

    @property
    def total_ms(self) -> float:
        return (time.perf_counter() - self._start) * 1000

    def as_dict(self) -> dict[str, float]:
        out = {f"{name}_ms": round(value, 2) for name, value in self.stages.items()}
        out["total_ms"] = round(self.total_ms, 2)
        return out

    def server_timing(self) -> str:
        parts = [f"{name};dur={value:.1f}" for name, value in self.stages.items()]
        parts.append(f"total;dur={self.total_ms:.1f}")
        return ", ".join(parts)
