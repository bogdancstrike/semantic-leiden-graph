# Changelog

## 0.4.0

### UI (aligned with the Nucleus dashboard template)
- **Design system from the template**: shared tokens feed the antd theme, CSS variables and
  ECharts; light/dark/system appearance and three densities; Inter; the dark grouped sidebar,
  header with breadcrumb, readiness, consoles, API key and a running-job pill; full-width pages.
- **Path routes** (`/`, `/documents`, `/graph`, `/communities`, `/import`, `/operations`);
  v0.3 `?tab=` links redirect.
- **Dashboard** (new): KPI tiles and chart cards (chart/table toggle, CSV) with drill-downs.
- **Search moved into Explore** (`/documents`): browse plus keyword/semantic/hybrid ranking,
  RAQB advanced conditions, ranking options drawer, insights, saved searches, export.
- **Advanced search on every page**: condition trees compiled to Elasticsearch for documents;
  evaluated in the browser for graph highlights and community metrics.
- **Graph**: new "search results" source (ranked documents plus neighbours), highlight
  conditions (dim or hide), seed rings, and a contrasting marker for the selected node and a
  neighbourhood's centre; re-fit when the layout settles.
- **Communities**: topic search via the anchor vote, metric conditions, KPIs and charts.
- **Import**: column mapping and generated ids; the upload and job progress survive
  navigation and reloads (previously lost when leaving the page); earlier imports listed.
- **Operations**: data sources table with a confirmed, job-based delete per source.
- Every page ends with a short documentation footer (what, flow, tech, why, how).

### API
- `GET /explore/fields`, `POST /explore/query`, `POST /explore/insights`: field catalogue,
  paginated/sortable browse with condition trees, and breakdowns for the same question.
- `POST /search`: `filters.condition_tree` (filter in keyword mode, Qdrant pre-filter in
  semantic mode).
- `POST /graph/query`: the subgraph of the documents a search or condition tree returns.
- `GET /sources`, `POST /jobs/delete-source`: per-source counts and deletion from all stores.
- `POST /documents/upload`: `id_column`, `text_column`, `metadata_columns`, `generate_ids`.

### Data
- `docs/sample.csv` (30,000 synthetic rows) and its generator `docs/generate_sample.py`.

### Import any CSV, choose the column to analyse
- The import page accepts **any delimited text file**: any column names, with or without a header
  row, any separator (detected among comma/semicolon/tab/pipe from the first 50 rows, Excel's
  `sep=` line, or a character you pick), and UTF-8, UTF-16 or Windows code pages (detected, or
  chosen; an auto-detected UTF-8 file that is not is re-read as Windows-1252 before anything is
  written). Any file name; Excel workbooks, archives and PDFs are refused with a message saying what
  they are.
- The page shows the file's **header** with samples and you **choose the column to analyse**
  (the likeliest prose column is suggested). Ids are optional (generated from the text by default);
  other columns are kept as filterable metadata by checkbox, up to the limit, instead of silently
  dropping those past 20. Blank and repeated header names become `column_3`, `name_2` — the same
  rule in the browser and on the server.
- API: `POST /documents/upload` takes `delimiter`, `encoding` and `has_header`; `text_column` is the
  column to analyse; without an `id` column ids are generated automatically; the job reports how the
  file was read (`result.format`). `/config` exposes `limits.metadata_max_keys`. CLI `ingest-csv`
  gains `--text-column`, `--id-column`, `--delimiter`, `--encoding`, `--no-header`.
- The Import page no longer rejects large files with a 50 MB limit while `/config` is still loading.

### Import: minimum community size, columns chosen in the preview
- The import sets the **minimum community size** of its clustering run (Import options, default 10;
  API `min_community_size` on `POST /documents/upload`, CLI `--min-community-size`). A run given no
  size now reuses the last run's size instead of `LEIDEN_MIN_COMMUNITY_SIZE`, so Operations, delete +
  re-cluster and rebuild keep the size an import chose; `/config` and `/stats` report it.
- Columns to keep are chosen by **clicking them in the preview table** (cells or header; a checkbox in
  each header for the keyboard). Kept columns are tinted green, the analysed one indigo; the checkbox
  list is gone. *Keep all* / *Keep none* and a live counter stay above the table.

### Open tabs survive deploys
- A tab opened before a UI deploy failed with "Failed to fetch dynamically imported module" when it
  opened another page, and "Try again" could not help. It now reloads itself once to pick up the new
  version; if the file is still missing it shows "A new version of the app is available" with a
  Reload button, never a reload loop.

### Graph edge count
- The edge count dropdown on `/graph` has **Custom…**: type any number of edges from 1 to 10,000
  (applies on Enter, on leaving the box or after a pause; larger values are clamped; above 5,000 a
  warning notes the slower layout). `GET /graph` accepts `limit` up to 10,000 (was 5,000).

### Graph similarity band
- `/graph` has a **maximum similarity** next to the minimum: a two-handle range slider
  ("Similarity 0.80–0.90", `?min=` / `?max=`) that draws only the edges inside the band — lower the
  maximum to hide near-duplicates and see the weaker links between topics. Works in every source
  (strongest links, communities, neighbourhood, search results).
- API: `max_score` (default 1) on `GET /graph`, `GET /graph/ego/{id}` and `POST /graph/query`;
  `max_score < min_score` is a 422.
- The handles stop one step apart instead of crossing; a held arrow key no longer drops steps
  (the slider moves from local state mirrored to the URL); an empty band below the graph's build
  threshold explains why.

### Documentation
- Documentation consolidated into rebuild-grade documents replacing the fifteen topic documents:
  `docs/specs.md` (requirements, contracts, operations and — merged in from the former
  `architecture.md` — the architecture, §14–§30) and `docs/ui.md`, with six diagrams in
  `docs/diagrams/` as PNG and SVG (redrawn for the any-CSV import).

### UX and accessibility pass
- WCAG 2.1 AA: zero axe-core violations across every page, drawer, menu and dialog in both
  themes (was 1-3 per page: sidebar contrast, unnamed progress bars and sliders, unlabelled
  selects inside the query builder, dark dropdown selection contrast). `npm run audit:a11y`
  keeps it that way.
- Keyboard: suggestions, presets, facets and filter chips are real buttons with labelled remove
  buttons; the skip link is the first tab stop; table rows open with Enter/Space.
- Community detail rebuilt: entity header with its actions, then central documents and
  neighbouring communities as separate sections, with a proper "fully separated" state (actions
  used to flow onto the same line as the text).
- Header: one Settings menu (appearance, density, API key, with a warning dot when a key is
  required) and a labelled Consoles menu, replacing four unlabelled icon buttons.
- Each active filter is shown once; one-sentence page subtitles; the graph's interaction hints
  moved to a "How to use" popover; compact chart axes (15k) and unclipped axis names.

### Clustering
- **A community has at least two documents.** Leiden put every document without a neighbour
  into a "community" of one (2,131 communities with a median size of 1 at similarity ≥ 0.75).
  Groups below `LEIDEN_MIN_COMMUNITY_SIZE` (default 2, never lower; per run
  `min_community_size`) are now left in no community in Neo4j, Elasticsearch and Qdrant, and
  communities are renumbered by size (C0 is the largest). Runs record `raw_community_count`
  and `outside_documents`; `/stats` separates `unclustered` (not clustered yet) from
  `outside_communities`. The UI says "No community" / "Not clustered yet" accordingly, and the
  Operations clustering card takes the minimum size.

### Large imports
- **CSV uploads up to 1 GiB and 10 million rows** (were 50 MiB / 250k): API defaults, compose and
  nginx (`client_max_body_size 1100m`, one-hour proxy timeouts). Verified with a 0.98 GiB,
  4.85M-row file: uploaded in 4 s, counted in 10 s, indexed at ~250 rows/s in flat memory.
- Constant memory for any size: per-row errors are counted but only the first 200 kept, and the
  ids waiting to be linked are packed at 16 bytes each (~80 MB for 5M rows instead of ~450 MB).
- Optional `truncate_long_texts` (Import: "Import the first 20,000 characters…") imports the
  beginning of over-long texts instead of skipping them; reported as `truncated`.
- The Import page estimates rows and duration for files over 100 MB.

### Fixed
- An import failed as a whole with "field larger than field limit (131072)" when one cell was
  longer than Python's default csv limit. Cells up to 64 million characters now parse, and a
  larger one (an unclosed quote) costs that row, not the job. Invalid UTF-8 past the first
  64 KiB now fails during counting with the line number instead of mid-import.
- Search highlights lost their first marked word when Elasticsearch trimmed a fragment's
  opening control character.
- A query set from a suggestion, the history or a link was cleared again by search-as-you-type.
- `/communities?selected=<id>` did nothing when the community was not on the first page of the
  table; the page now turns to it and scrolls it into view.

## 0.3.0

### Architecture
- **Elasticsearch added as the system of record** for text, metadata and full-text search.
  Qdrant keeps vectors and a minimal payload (no text). Neo4j keeps topology, clustering
  history and the graph policy.
- **Deterministic IDs.** Point IDs are UUIDv5 of the external ID, so re-imports are idempotent.
- **Write order is ES first, then derived stores.** A `reconcile` job repairs any drift.
- **Optimistic concurrency** (`if_seq_no`/`if_primary_term`) on Elasticsearch writes.

### Search
- Keyword mode (BM25, diacritic folding, fuzzy, phrase boost, advanced syntax) and hybrid
  mode (RRF/DBSF, weighted). The two engines run concurrently.
- Auto-routing strategies `sum`, `max`, `mean`, `softmax` and `top1` over R anchors, with
  multi-community selection and vote shares.
- ES-only filters become a Qdrant ID pre-filter. Community facets use the post-filter pattern.
- MMR diversification. Highlights use control-character markers, so the UI needs no `innerHTML`.
- Per-stage timings in responses plus a `Server-Timing` header; LRU cache for query embeddings.

### Ingestion and jobs
- CSV upload with streaming, a byte limit, delimiter sniffing, BOM handling, metadata
  columns and per-row errors.
- Background jobs with progress, cancellation, and history (in-process, single worker).
- Batched pipeline: skips unchanged hashes, embeds in batches, links after all chunks
  (documents in one upload link to each other).
- Qdrant HNSW is built earlier (`indexing_threshold` 1000 KB) and linking waits for the
  optimizer. Measured 2.6x faster on 22k documents.
- Leiden: the GDS projection is dropped after each run; community sync is batched and runs
  in parallel for Qdrant and ES; every run is recorded as a `ClusterRun`.

### UI
- Full rewrite: six pages, URL-addressable state, react-query, code splitting by route.
- Canvas graph renderer; selecting a node no longer restarts the layout.
- Drag-and-drop import with client-side preview; job progress; document drawer
  comparing neighbours from all three engines.

### Fixed (review pass)
- ES partial updates deep-merged metadata. Removed keys survived and re-imports never
  converged. Writes are now full `index` operations.
- The frontend nginx config listened on the wrong port (the healthcheck failed) and
  rejected uploads over 1 MB. The frontend image could also copy host `node_modules`.
- The Neo4j healthcheck ignored a custom password.
- Blank texts via the API were stored as empty documents, and a blank item in `texts` gave a 500.
- A batch with `cluster: true` returned 409 after its documents had already been written.
- A tampered cursor caused a 500. Metadata filter keys were not normalised. `similar` on an
  unknown ID returned 500. Ego graphs could drop their centre node. Reconcile left orphan graph nodes.
- UI: live search deleted typed spaces, stale community scopes persisted, touch-dragging graph
  nodes failed, React 19 ref warning, job progress display issues.

### Compatibility
- v0.2 endpoints and fields still work: `/search/community`, `/cluster`, `/graph/rebuild`,
  `texts` batches, `community_id` on search.
- v0.2 Qdrant data does not migrate automatically (text lived in Qdrant). Re-import it.
