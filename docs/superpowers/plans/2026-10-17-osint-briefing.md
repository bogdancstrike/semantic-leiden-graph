# OSINT Briefing Implementation Plan

> **For agentic workers:** Execute the checked tasks in order, with tests and review at each checkpoint. Same-session execution is authorized; existing instructions cover commits and pushes.

**Goal:** Turn each topic into an evidence-backed analyst briefing that explains developments, claims, actors, implications and investigation priorities, with measured coverage for large collections.

**Architecture:** Extend structured LLM output with an optional versioned briefing and validate every citation against sent evidence. Compute whole-community volume/source/update/repetition metrics in temporary SQLite before evidence packing; keep qualitative interpretation tied to selected excerpts. Render focused reading sections and investigation actions, preserving old reports. Reanalysis creates a new report from saved membership rather than mutating history.

**Tech Stack:** Python/FastAPI/Pydantic/SQLite/pytest; React/TypeScript/Ant Design/Playwright.

## Task 1: Grounded briefing contract

Files: create `app/analysis/briefing.py`, modify `app/analysis/llm.py`, test `tests/test_analysis_briefing.py`.

- [ ] Write tests for valid rich output from both providers, omitted legacy briefing, unknown nested citations, empty required citations, invalid confidence/priority and contested claims without contrary evidence.
- [ ] Add bounded Pydantic models for assessment, developments, narrative frames, claim assessment, actors, relationships, implications, collection gaps and watch indicators. Every factual/judgment item carries evidence IDs. Briefing version is 1; confidence is low/medium/high and reflects evidence limitations, not verified truth.
- [ ] Extend `INSTRUCTIONS` with concise field contracts, attribution, uncertain event times, inference labels, no coordination claims from repetition alone, and no independent-source claims from import labels. Preserve raw analysis/evidence audit and default old briefing to absent.
- [ ] Run `.venv/bin/pytest -q tests/test_analysis.py tests/test_analysis_briefing.py tests/test_analysis_budget.py` and commit the tested contract.

Contract example to test:
```python
briefing = {
    'version': 1,
    'assessment': {'judgment': 'Funding is the central reported development',
                   'why_it_matters': 'Station access may improve', 'priority': 'medium',
                   'priority_reason': 'Monitor delivery commitments', 'confidence': 'low',
                   'confidence_reason': 'One supplied document; no external verification',
                   'evidence_ids': ['a']},
    'claims': [{'claim': 'Funding was approved', 'status': 'reported',
                'basis': 'One announcement', 'confidence': 'low',
                'supporting_evidence_ids': ['a'], 'contradicting_evidence_ids': []}],
}
```

## Task 2: Whole-community profile and triage

Files: create `app/analysis/profile.py`; modify `candidates.py`, `service.py`, `store.py`, `routes_analysis.py`; test profile/API/pipeline suites.

- [ ] Test exact document/source/repetition counts, full-text hash before excerpt truncation, UTC activity buckets and bounded output over a synthetic 100,000-document candidate set. Keep this distinct from end-to-end throughput claims.
- [ ] Extend temporary candidates with source, normalized update timestamp and full-text fingerprint. SQL profile returns total/unique/repeated counts, source labels (top 20 + remainder), update activity (≤96 buckets), largest repeated-text examples (≤3), and explicit unknown timestamps.
- [ ] Save `population_profile` per community and include the bounded profile in the prompt metadata. Compute source/volume evidence-coverage limitations using selected document counts, without representing samples as the full corpus.
- [ ] Add priority filter and priority sorting to topic summaries for analyst triage, leaving missing historical priority unrated.
- [ ] Add authenticated `POST /analysis/topics/{id}/reanalyze`: capture persisted membership IDs, queue a new all-time analysis with origin metadata, preserve old report, handle missing/deleted members and unconfigured provider.
- [ ] Run `.venv/bin/pytest -q tests/test_analysis_profile.py tests/test_analysis_pipeline.py tests/test_analysis_api.py` and commit the tested backend.

Profile example:
```python
profile = {'documents': 100000, 'unique_texts': 90000, 'repeated_documents': 10000,
           'source_labels': 5, 'sources': [], 'activity': [], 'activity_unit': 'day',
           'unknown_updated_at': 0, 'repetition_examples': []}
```

## Task 3: Analyst workspace

Files: create `frontend/src/components/TopicBriefing.tsx`, `TopicPopulation.tsx` and a Markdown export helper; modify `TopicDetailPage.tsx`, `TopicsPage.tsx`, API types/client, stylesheet and browser fixtures/tests.

- [ ] Add typed rich briefing/profile contracts and reanalysis client call. Implement a dossier reading surface: assessment and importance first, section navigation, developments/event times, narrative comparison, claim status/support/contradiction, actor roles/relationships, implications explicitly tagged inference, collection gaps, watch indicators, measured collection profile, evidence.
- [ ] Make citations open shared document drawers; follow-up queries search topic membership or the corpus. Add section/text filtering and a complete Markdown briefing export. Preserve existing NER/graph/documents/LLM tabs.
- [ ] Show reanalysis action for historical reports and link the new job/report. Poll pending work; never silently overwrite a saved report.
- [ ] Add priority labels/filter/sort to Topics. Reuse the current theme and responsive editorial dossier layout, with readable light/dark states.
- [ ] Write Playwright coverage for rich sections, citation drawers, scoped/corpus query links, historical fallback, new-report generation, priority triage, complete export and mobile/axe checks.
- [ ] Run `npm test -- --run`, `npm run build`, and `npm run test:e2e -- --workers=4` in `frontend`; commit validated UI changes.

## Task 4: Live validation and documentation

- [ ] Rebuild Compose and run the opt-in live Gemini analysis on existing corpus data. Verify nested citations, non-fabricated event times, measured profile, coverage and persistence. Inspect desktop/mobile screenshots and run focused light/dark accessibility audits.
- [ ] Update README, specs §31 and UI §13 with analysis types, reanalysis/triage contracts, exact repetition/source/date semantics and coverage limitations. Explain that the 100k test verifies aggregation, not full-stack sustained daily capacity or full LLM coverage.
- [ ] Run the full backend suite with real Qdrant, final frontend checks as changes warrant, `git diff --check`, commit/push checkpoints, leave user `.idea/` untouched.
