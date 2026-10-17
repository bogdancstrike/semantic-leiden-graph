# Context-aware analysis and period selection

**Goal:** Automatically select the largest centrality-ranked document prefix fitting the model, and support relative, custom date/time, and all-time analysis windows.

**Architecture:** Resolve Gemini input/output limits through model metadata and measure the exact prompt with countTokens. Use tiktoken for OpenAI and documented context limits, with an explicit override for other models. Reserve output tokens and a safety margin; preserve explicit legacy top_k only as an optional API cap. Snapshot ranked candidates in temporary SQLite so automatic selection does not keep the entire corpus in memory. Keep persistent reports backward-compatible. UI replaces manual document/hour counts with automatic sizing text and preset/custom/all period controls.

## Tasks

- [ ] Add provider model limit discovery, token counting, maximum-prefix packing, prompt/response reserve validation and oversized-first-document handling. Test Gemini HTTP request shapes, OpenAI tokenizer behavior, multilingual inputs, maximal fitting, no fixed 50-document cap and failure paths.
- [ ] Add temporary disk-backed candidates, automatic packing after snapshot, budget metadata per community and preservation of the exact sent evidence. Cover automatic and legacy-capped jobs, failures and cancellation.
- [ ] Add validated relative/custom/all request windows, aware UTC timestamps, inclusive start/exclusive end, and all-time ES scanning. Cover invalid ranges and API contracts.
- [ ] Replace Documents per topic and Last hours controls with automatic sizing and a period selector plus date/time range picker. Update client types and browser/API tests for presets, custom dates, all time, reports and mobile accessibility.
- [ ] Update README, environment configuration and Compose. Run backend/frontend/browser suites, production builds and live Gemini + UI smoke tests; commit and push validated checkpoints.
- [ ] Add CSV run_analysis toggle and request field; queue a linked analysis job over exactly the successfully imported/unchanged document IDs (not unrelated data or previously imported rows absent from this file). Include unchanged reimports, partial imports, disabled providers, job links, and multipart UI coverage.
- [ ] Add a navbar Topics page at /topics and /summaries alias. Show saved community analyses with report/window selection, searchable narrative and classification cards, sentiment, findings, evidence and graph/community links. Extend actual LLM JSON output with grounded narratives, sentiment/explanation and classifications; preserve historical report compatibility. Add browser coverage.
- [ ] Support comma-separated Gemini and OpenAI keys, rotate on rejected credentials/rate limits/transient failures, retain a working key for subsequent token/generation requests, and test redaction and failover. Never commit supplied credentials.
- [ ] Add /topics/{id} detail pages with graph snapshots, provider/prompt/token-budget audit, narrative/sentiment/classification output and paginated search over persisted community membership. Overview polls completed/in-progress analyses and links each topic to its stable report-scoped ID.
