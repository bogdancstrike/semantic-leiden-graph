# Community Analysis Implementation Plan

> **For agentic workers:** Execute this plan inline with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover Leiden communities, select top-k recent documents in each, and persist configurable Gemini/OpenAI analysis on demand and every 24 hours.

**Architecture:** Reuse the existing serialized job runner and structural lock for clustering and document selection. A provider adapter sends bounded document content to Gemini generateContent or OpenAI Responses; SQLite persists immutable run snapshots and schedule state, backed by a Docker volume. The Communities page starts jobs and displays persisted results and evidence.

**Tech Stack:** FastAPI, Pydantic, httpx, SQLite, existing Elasticsearch/Qdrant/Neo4j, React, Ant Design, pytest, Vitest, Playwright.

## Scope

The long pasted specification was absent from the received message. Audit the repository's existing specification and implement the explicit additional requirements. Do not claim verification of unseen requirements. Never commit provider credentials.

## Task 1: Provider and persistence

Files: `app/analysis/{llm,store}.py`, `app/config.py`, `requirements.txt`, `tests/test_analysis.py`, `.gitignore`.

- [ ] Add validated settings: provider defaults to gemini, model defaults to gemini-flash-latest, secret keys, bounded input/output, timeout/retries, top-k, schedule interval, state path.
- [ ] Test actual HTTP payloads with httpx MockTransport for both providers, structured response validation, empty/blocked output, retryable/permanent errors, and secret redaction.
- [ ] Implement Gemini generateContent with X-goog-api-key and OpenAI Responses with Bearer authentication and store=false using official API contracts.
- [ ] Persist queued/running/completed/partial/failed/cancelled runs and schedule due time in SQLite; test reopening the database and interrupted runs.
- [ ] Run focused pytest, inspect staged changes for secrets, commit and push.

## Task 2: Discovery, ranking, jobs, and scheduling

Files: `app/analysis/{service,scheduler}.py`, `app/stores/{elastic,graph}.py`, `app/container.py`, `app/main.py`, `app/api/routes_analysis.py`, `app/schemas.py`, `tests/{fakes,test_analysis,test_analysis_api}.py`.

- [ ] Add a streaming Elasticsearch query over updated_at in [window_start, window_end), excluding older/future documents before ranking.
- [ ] Rank eligible documents by weighted within-community strength with deterministic ID ties; keep top-k per community and explicitly report configured community limits and unassigned counts.
- [ ] Refresh Leiden under the structural lock, snapshot community_version and document evidence, then release the lock before LLM calls.
- [ ] Submit authenticated background analysis jobs, reject duplicate active analyses, persist reports and per-community failures, preserve cancellation.
- [ ] Add paginated report/history endpoints and public configuration without secrets.
- [ ] Schedule every 24 hours using persisted UTC due times; skip unconfigured providers, retry busy submission later, stop cleanly on shutdown.
- [ ] Test window boundaries, top-k among eligible documents, empty input, limits, partial failure, duplicate requests, auth, cancellation, scheduler restart/enablement.
- [ ] Run full backend suite, commit and push.

## Task 3: UI, operations, and documentation

Files: `frontend/src/components/AnalysisPanel.tsx`, `frontend/src/pages/CommunitiesPage.tsx`, `frontend/src/api/{client,hooks,types}.ts`, `frontend/src/components/JobProgress.tsx`, frontend tests, `.env.example`, `docker-compose.yml`, `Dockerfile`, `README.md`.

- [ ] Add analysis controls to Communities: provider from server configuration, top-k, lookback, run action, schedule status, history, report summaries, evidence links, and partial/failed states.
- [ ] Reuse current page styling and job polling; restore active analysis after navigation/reload.
- [ ] Add frontend request tests and browser smoke coverage of the button and results.
- [ ] Wire provider/scheduler environment variables and a writable persistent state volume into Compose.
- [ ] Document setup, daily time-window semantics, API endpoints, ranking, limits, provider switching, real test commands and remaining limitations.
- [ ] Run pytest, frontend tests/typecheck/build, Compose config, and browser smoke checks. Exercise the live Gemini endpoint with the supplied key without printing or committing it.
- [ ] Review diff and secret exclusions, commit and push.
