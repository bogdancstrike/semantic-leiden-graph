# Community Analysis Implementation Plan

> **For agentic workers:** Execute this plan inline with review checkpoints. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Discover Leiden communities, select top-k recent documents in each, and persist configurable Gemini/OpenAI analysis on demand and every 24 hours.

**Architecture:** Reuse the existing serialized job runner and structural lock for clustering and document selection. A provider adapter sends bounded document content to Gemini generateContent or OpenAI Responses; SQLite persists immutable run snapshots and schedule state, backed by a Docker volume. The Communities page starts jobs and displays persisted results and evidence.

**Tech Stack:** FastAPI, Pydantic, httpx, SQLite, existing Elasticsearch/Qdrant/Neo4j, React, Ant Design, pytest, Vitest, Playwright.

## Scope

The long pasted specification was absent from the received message. Audit the repository's existing specification and implement the explicit additional requirements. Do not claim verification of unseen requirements. Never commit provider credentials.

## Task 1: Provider and persistence

Files: `app/analysis/{llm,store}.py`, `app/config.py`, `requirements.txt`, `tests/test_analysis.py`, `.gitignore`.

- [x] Add validated settings: provider defaults to gemini, model defaults to gemini-flash-latest, secret keys, bounded input/output, timeout/retries, top-k, schedule interval, state path.
- [x] Test actual HTTP payloads with httpx MockTransport for both providers, structured response validation, empty/blocked output, retryable/permanent errors, and secret redaction.
- [x] Implement Gemini generateContent with X-goog-api-key and OpenAI Responses with Bearer authentication and store=false using official API contracts.
- [x] Persist queued/running/completed/partial/failed/cancelled runs and schedule due time in SQLite; test reopening the database and interrupted runs.
- [x] Run focused pytest, inspect staged changes for secrets, commit and push.

## Task 2: Discovery, ranking, jobs, and scheduling

Files: `app/analysis/{service,scheduler}.py`, `app/stores/{elastic,graph}.py`, `app/container.py`, `app/main.py`, `app/api/routes_analysis.py`, `app/schemas.py`, `tests/{fakes,test_analysis,test_analysis_api}.py`.

- [x] Add a streaming Elasticsearch query over updated_at in [window_start, window_end), excluding older/future documents before ranking.
- [x] Rank eligible documents by weighted within-community strength with deterministic ID ties; keep top-k per community and explicitly report configured community limits and unassigned counts.
- [x] Refresh Leiden under the structural lock, snapshot community_version and document evidence, then release the lock before LLM calls.
- [x] Submit authenticated background analysis jobs, reject duplicate active analyses, persist reports and per-community failures, preserve cancellation.
- [x] Add paginated report/history endpoints and public configuration without secrets.
- [x] Schedule every 24 hours using persisted UTC due times; skip unconfigured providers, retry busy submission later, stop cleanly on shutdown.
- [x] Test window boundaries, top-k among eligible documents, empty input, limits, partial failure, duplicate requests, auth, cancellation, scheduler restart/enablement.
- [x] Run full backend suite, commit and push.

## Task 3: UI, operations, and documentation

Files: `frontend/src/components/AnalysisPanel.tsx`, `frontend/src/pages/CommunitiesPage.tsx`, `frontend/src/api/{client,hooks,types}.ts`, `frontend/src/components/JobProgress.tsx`, frontend tests, `.env.example`, `docker-compose.yml`, `Dockerfile`, `README.md`.

- [x] Add analysis controls to Communities: provider from server configuration, top-k, lookback, run action, schedule status, history, report summaries, evidence links, and partial/failed states.
- [x] Reuse current page styling and job polling; restore active analysis after navigation/reload.
- [x] Add frontend request tests and browser smoke coverage of the button and results.
- [x] Wire provider/scheduler environment variables and a writable persistent state volume into Compose.
- [x] Document setup, daily time-window semantics, API endpoints, ranking, limits, provider switching, real test commands and remaining limitations.
- [x] Run pytest, frontend tests/typecheck/build, Compose config, and browser smoke checks. Exercise the live Gemini endpoint with the supplied key without printing or committing it.
- [x] Review diff and secret exclusions, commit and push.

## Validation results

- Backend: 162 passed with real Qdrant HTTP/gRPC, 1 opt-in live analysis test skipped in this run.
- Live Compose + Gemini smoke: passed against 30,072 documents, top-2 from one community.
- Real UI: start, completed report, evidence, reload and mobile viewport verified.
- Frontend: 31 Vitest tests and 4 Playwright tests passed; TypeScript/production build passed.
- SQLite restart recovery and schedule persistence covered by tests.
- Full-stack restart persistence: verified unchanged reports/evidence and daily due time after restarting the API.
- Full light/dark WCAG audit across all pages, drawers and menus: no accessibility violations.
- Dark mobile analysis controls and expanded evidence: automated browser regression passed.
- The requested long pasted feature list was never received; its contents could not be audited.
