# syntax=docker/dockerfile:1.7
FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/cache/huggingface

# ---------------------------------------------------------------- dependencies
FROM base AS deps
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
RUN pip install --index-url ${TORCH_INDEX_URL} torch
COPY requirements.txt .
RUN pip install -r requirements.txt

# ---------------------------------------------------------------- runtime
FROM base AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app && useradd --system --gid app --home /app app \
    && mkdir -p /cache/huggingface && chown -R app:app /cache
COPY --from=deps /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY --chown=app:app app ./app
COPY --chown=app:app data ./data
COPY --chown=app:app seed.py ./seed.py
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -fsS http://localhost:8000/health || exit 1
# One worker on purpose: the model is loaded per process and the job queue is in-process.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--timeout-graceful-shutdown", "20"]
