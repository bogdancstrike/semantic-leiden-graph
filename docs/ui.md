# UI specification — Semantic Leiden Explorer (v0.4)

This document is the complete **visual and interaction specification** of the frontend in
`frontend/src`. Together with [specs.md](specs.md) it is meant to be enough to rebuild the system
from nothing:

| Document | Covers |
|---|---|
| [specs.md](specs.md) | use cases, functional requirements, the API contract (§5), search (§6) and CSV import (§7) specifications, non-functional requirements, **what to copy from Nucleus and how to adapt it (§9)**, operations (§10), tests and acceptance checklist, and the architecture — services, stores (Elasticsearch, Qdrant, Neo4j/GDS), pipelines, jobs, data model, flows (§14–§30) |
| **ui.md** (this file) | design system, shell, routes and URL state, shared components, every page, interaction patterns, accessibility, responsive rules, performance, storage and UI security, rebuild checklist |

Every value, string and threshold below was read from the v0.4.0 code. Copy in `"quotes"` or
code spans is the exact text the UI shows. Where the code itself is inconsistent, §12.3 says
so rather than papering over it.

## Contents

1. [Overview](#1-overview)
2. [Design system](#2-design-system)
3. [App shell](#3-app-shell)
4. [Routing and URL state](#4-routing-and-url-state)
5. [Shared components](#5-shared-components)
6. [Pages](#6-pages)
7. [Interaction patterns](#7-interaction-patterns)
8. [Accessibility](#8-accessibility)
9. [Responsive behaviour](#9-responsive-behaviour)
10. [Performance](#10-performance)
11. [Storage keys and UI security](#11-storage-keys-and-ui-security)
12. [Rebuild checklist](#12-rebuild-checklist)

---

## 1. Overview

### 1.1 What the UI is

A single-page application with **six pages** inside one **app shell**:

| Group | Page | Path | One-line job |
|---|---|---|---|
| Overview | Dashboard | `/` | Corpus health at a glance; every number drills into the view behind it |
| Explore | Explore documents | `/documents` | Browse (exact Elasticsearch filter) or rank (keyword / semantic / hybrid) documents, narrowed by RAQB conditions |
| Explore | Similarity graph | `/graph` | Draw part of the kNN similarity graph (four sources), highlight nodes with in-browser conditions |
| Explore | Communities | `/communities` | Leiden communities with quality metrics; topic search and metric conditions |
| Data | Import | `/import` | CSV wizard: file → column mapping → upload → background job → result |
| Data | Operations | `/operations` | Cluster, rebuild, reconcile, delete data sources; job table and clustering history |

Cross-cutting rules that every page follows:

- **Full width.** Content fills the viewport beside the sidebar; there is no max-width container.
  Tables, graphs and charts earn the room.
- **The question lives in the URL.** Search text, mode, condition trees, filters, sort, page
  size and view are query parameters, so every view is bookmarkable, shareable, savable and
  Back/Forward work (§4).
- **One visual key per community.** A rotated-square glyph in a stable hashed colour, the same
  in tables, charts, chips and graph nodes (§2.2.9).
- **Every page ends with a documentation footer** — What / Flow / Tech / Why / How, three to
  five words each, the full sentence on hover (§5.2).
- **WCAG 2.1 AA** in both themes, verified with axe-core (§8).

### 1.2 Stack

Versions are the ones installed in `frontend/node_modules` for v0.4.0 (`package.json` ranges in brackets).

| Concern | Library | Version |
|---|---|---|
| UI runtime | React, React DOM | 18.3.1 (`^18.3.1`) |
| Component kit | antd | 5.29.3 (`^5.29.3`) |
| Icons | @ant-design/icons (Outlined set only) | 5.6.1 (`^5.5.2`) |
| Routing | react-router-dom (`BrowserRouter`, future flags `v7_startTransition`, `v7_relativeSplatPath`) | 6.30.6 (`^6.28.0`) |
| Server state | @tanstack/react-query | 5.103.2 (`^5.90.0`) |
| Condition builder | @react-awesome-query-builder/antd (RAQB) | 6.6.15 |
| Charts | echarts (core build) + echarts-for-react (`lib/core`) | 5.6.0 / 3.0.6 |
| Graph | d3-force, d3-zoom, d3-drag, d3-selection on a `<canvas>` | 3.x |
| CSV preview | papaparse | 5.7.0 |
| Dates (RAQB antd widgets) | dayjs | 1.11.x |
| Font | @fontsource-variable/inter (self-hosted Inter Variable) | 5.2.x |
| Build / dev | Vite 7 (`@vitejs/plugin-react`), TypeScript ~5.9 | 7.3.6 |
| Tests | vitest (node environment, `src/**/*.test.ts`) | 3.2.x |
| A11y audit | @playwright/test + @axe-core/playwright (dev) | 1.48+ / 4.10+ |
| Serving | `nginxinc/nginx-unprivileged:1.29-alpine`, port 8080 (compose maps **3000**) | — |

Path alias: `@/` → `frontend/src/` (Vite `resolve.alias` and `tsconfig`).

### 1.3 Source layout

```
frontend/
├─ index.html              lang="en", theme-color meta (rewritten at runtime), inline SVG favicon (the logo)
├─ nginx.conf              SPA fallback, /api proxy, CSP and security headers, 1100m body limit
├─ scripts/a11y-audit.mjs  axe-core over 17 UI states × 2 themes
├─ vite.config.ts          alias, manualChunks, dev proxy /api → :8000
└─ src/
   ├─ main.tsx             provider stack (§3.1)
   ├─ App.tsx              routes, legacy ?tab= redirects, NotFound, idle prefetch
   ├─ config.ts            API_PREFIX '/api', STORAGE_KEYS, CONSOLES
   ├─ index.css            the only stylesheet: shell, page furniture, graph stage, overrides
   ├─ api/                 client.ts (fetch + XHR upload, ApiError), hooks.ts (react-query), types.ts
   ├─ app/                 AppShell.tsx, navigation.tsx, ErrorBoundary.tsx, pageDocs.ts
   ├─ theme/               tokens.ts, antd.ts, echarts.ts, AppearanceProvider.tsx
   ├─ components/          PageHeader, PageDoc, EmptyState, StatCard, CommunityKey, Chip, ListMeta,
   │  │                    ChartCard, SavedSearches, DocumentDrawer, JobProgress, ApiKeyButton
   │  ├─ charts/           echarts.ts (core registration), options.ts (bar, line+bar, scatter, pie)
   │  ├─ query/            AdvancedConditionsDrawer, AdvancedQueryBuilder, queryBuilderConfig, queryTree, evaluate
   │  ├─ search/           SearchBox, SearchTuningDrawer, ResultCard, SearchInsights, defaults
   │  └─ graph/            GraphCanvas.tsx (canvas + d3-force renderer)
   ├─ hooks/               useUrlState, useSticky, useRecentSearches, useDebouncedValue, useReducedMotion
   ├─ lib/                 links, palette, highlight, format, download, csv, importSession, lib.test.ts
   └─ pages/               OverviewPage, ExplorePage, GraphPage, CommunitiesPage, ImportPage, OperationsPage
```

### 1.4 The Nucleus template

The look, the shell and most shared components come from the **Nucleus dashboard platform
template**:

> **`/home/user/workspace/templates/nucleus-dashboard-platform-template`**
> (React app in `frontend/`, Flask API in `backend/`, docs in `docs/`, e.g. `docs/features.md`)

**Which module to copy and how to adapt it is specified in [specs.md §9](specs.md) ("Reusing the
Nucleus template").** This file only says what the result must
look and behave like. For the look, open these Nucleus files/pages side by side with ours:

| Our surface | Nucleus visual reference (`frontend/src/…`) | What to match |
|---|---|---|
| App shell | `app/AppShell.tsx`, `app/navigation.tsx` | dark rail grouped by intent, 56 px header with trail and global controls, drawer below `lg` |
| Tokens, themes | `theme/tokens.ts`, `theme/antd.ts`, `theme/AppearanceProvider.tsx`, `theme/echarts.ts`, `theme/contrast.test.ts` | identical palette, density axis, contrast-driven overrides |
| Page furniture | `components/PageHeader.tsx`, `components/StatCard.tsx`, `components/EmptyState.tsx`, `components/ChartCard.tsx`, `components/charts/options.ts`, `index.css` | title + one-line subtitle + right-hand actions; KPI tiles; chart ↔ table toggle with CSV |
| Explore | `pages/DataExplorerPage.tsx`, `components/explorer/*` (`AdvancedSearchDrawer`, `AdvancedQueryBuilder`, `queryBuilderConfig`, `queryTree`, `SimpleSearch`, `SavedSearchDrawer`) | toolbar card, draft/apply conditions drawer with live count and inspector, saved searches, recent searches |
| Dashboard | `pages/DashboardPage.tsx` | KPI row, 12-column chart grid, drill-down on click |
| Import | `pages/ImportPage.tsx` | stepper wizard, dragger, mapping, progress, result |
| Operations | `pages/admin/JobsPage.tsx` | job cards, status badges, job table |
| Highlighting | `components/HighlightedText.tsx` | `<mark>` in the accent tint, never `innerHTML` |

Not taken from Nucleus: Keycloak auth, its routes and pages, tours (`PageTour`), the command
palette, and its `components/graph/ForceGraph.tsx` — the graph keeps the v0.3 canvas renderer
(§5.19), restyled with the tokens.

To see Nucleus running: `make up` in the template root (Docker; prints the URLs when healthy), or
`make dev-web` for its Vite dev server on **http://localhost:5174**, which proxies `/platform` to
its API on `localhost:5101` (see the template README, "Running it").

### 1.5 Running this UI

```bash
docker compose up -d --build          # whole stack; UI on http://localhost:3000 (nginx → app:8000 for /api)

cd frontend
npm ci
npm run dev                           # Vite on :5173, proxies /api/* → http://localhost:8000 (prefix stripped)
npm run build                         # tsc -b && vite build → dist/
npm test                              # vitest: highlight parser, CSV mapping, condition trees, formatting, export
npm run typecheck
npm run audit:a11y                    # see §8.3
```

The browser only ever talks to **`/api/*`** (`API_PREFIX`); nginx (prod) and the Vite proxy (dev)
strip the prefix. Everything deployment-specific (limits, model, graph policy, whether an API key
is required) comes from `GET /config` at runtime; nothing is baked into the bundle.

---

## 2. Design system

### 2.1 Principles

Encoded in `theme/tokens.ts` (ported from Nucleus) and the conventions it carries:

1. **One source, three consumers.** `tokens.ts` feeds the antd theme (`antd.ts`), the CSS custom
   properties (`cssVariables()`), and the ECharts theme (`echarts.ts`). The graph canvas gets its
   colours from the page (`CANVAS_PALETTES`). No other file invents a hex value, except the fixed
   sidebar colours and canvas palette listed below.
2. **Colour means something.** Status, severity, retrieval engine and community get colour;
   nothing else does. One accent (the logo's core indigo), lighter in dark mode.
3. **Density is a first-class axis** (compact / standard / comfortable), applied to antd and to
   the stylesheet at once.
4. **Readable first.** Every foreground/background pair used for text measures ≥ 4.5:1; where
   antd's derived colours did not, the token is named explicitly with the measured ratio in a
   comment (§2.14).
5. **Conventions** (from Nucleus): one primary action per surface; quiet row actions are text
   buttons; pages do not set control sizes (density does); every filter is shown once, by its
   own control; a page subtitle is one sentence and the details live in the footer.

### 2.2 Colour tokens

#### 2.2.1 Neutral (light mode greys, slate)

| Token | Hex | Used for |
|---|---|---|
| `NEUTRAL[50]` | `#f8fafc` | table header bg, canvas bg (light) |
| `NEUTRAL[100]` | `#f1f5f9` | page background (light), hover, subtle borders |
| `NEUTRAL[200]` | `#e2e8f0` | borders, chart axis lines (light) |
| `NEUTRAL[300]` | `#cbd5e1` | strong borders |
| `NEUTRAL[400]` | `#94a3b8` | unassigned community colour, "cancelled", sidebar group titles |
| `NEUTRAL[500]` | `#5f6e85` | tertiary text, placeholder, "queued"; **darkened from `#64748b`** (4.34:1 → ≥ 4.5:1 on the page ground) |
| `NEUTRAL[600]` | `#475569` | secondary text, chart labels (light) |
| `NEUTRAL[700]` | `#334155` | — |
| `NEUTRAL[800]` | `#1e293b` | tooltip bg (light) |
| `NEUTRAL[900]` | `#0f172a` | body text (light), **sidebar background (both themes)** |
| `NEUTRAL[950]` | `#020617` | — |

#### 2.2.2 Ink (dark mode greys, near-achromatic charcoal)

Slate inverted reads as navy at 8 % lightness; with these greys only the accent and status colours carry hue.

| Token | Hex | Used for |
|---|---|---|
| `INK[950]` | `#08090c` | canvas bg (dark) |
| `INK[900]` | `#0b0c10` | page background (dark) |
| `INK[850]` | `#0e0f14` | header bg (dark), `theme-color` meta in dark |
| `INK[800]` | `#15171c` | cards / containers (dark) |
| `INK[750]` | `#1b1e24` | elevated surfaces, table header, chart tooltip (dark) |
| `INK[700]` | `#232730` | hover, table row hover, tooltip bg (dark) |
| `INK[650]` | `#262a33` | borders (dark), chart axis |
| `INK[600]` | `#343a45` | antd `colorBorder`, strong borders (dark) |
| `INK[500]` | `#4a515e` | — |
| `INK[400]` | `#7d8595` | tertiary text, placeholder (dark) |
| `INK[300]` | `#9aa2b1` | secondary text, chart labels (dark) |
| `INK[200]` | `#c3c8d2` | — |
| `INK[100]` | `#e8eaf0` | body text (dark), selected option text in dark Select |

`PAPER = #ffffff` (cards, header and elevated surfaces in light mode).

#### 2.2.3 Logo and accent

`LOGO`: ring `#8b8bf0`, core `#5b5bd6`, spark `#22d3ee`. The accent is taken *from* the logo.

| `ACCENT` | Hex | Role |
|---|---|---|
| 50 | `#eeeefc` | `--nu-accent-soft` (light): chip pressed, `<mark>`, table row hover, selected history row |
| 100 | `#dcdcf9` | — |
| 200 | `#bcbcf3` | dark link hover, **dark Dropdown selected ink** |
| 300 | `#9a9aec` | dark link, dark Tabs selected, `--nu-accent-ink` (dark) |
| 400 | `#7c7cf5` | `colorPrimary` and `--nu-accent` in dark mode |
| 500 | `#5b5bd6` | `colorPrimary` / `--nu-accent` in light mode; **primary buttons in both modes**; sidebar selected item |
| 600 | `#4a4ac0` | light link hover |
| 700 | `#4338ca` | light link active, `--nu-accent-ink` (light) |
| 800 | `#332f96` | — |
| 900 | `#272470` | — |

#### 2.2.4 Semantic

| Meaning | Fill (`SEMANTIC`, ≥ 3:1) | Light text ink (`SEMANTIC_INK.light`, ≥ 4.5:1) | Dark text ink (`SEMANTIC_INK.dark`) |
|---|---|---|---|
| success | `#16a34a` | `#166534` | `#4ade80` |
| warning | `#ca8a04` | `#854d0e` | `#fbbf24` |
| danger | `#dc2626` | `#b91c1c` | `#f87171` |
| info | `#0891b2` | `#155e75` | `#22d3ee` |
| neutral | `NEUTRAL[500]` | — | — |

Rule: fills (icons, bars, badges, dots) use `SEMANTIC`; **text** on any tint uses `SEMANTIC_INK`
(`--nu-*-ink`). The antd `color*Text` tokens are set to the ink values.

#### 2.2.5 Chart series

`SERIES` (adjacent entries differ in hue *and* lightness):
`#5b5bd6`, `#0891b2`, `#16a34a`, `#ca8a04`, `#db2777`, `#7c3aed`, `#0d9488`, `#ea580c`, `#64748b`, `#4338ca`.

#### 2.2.6 Retrieval engines

Wherever the two engines are compared side by side (the Explain popover's rank bars):
`SEMANTIC_COLOR = #0891b2` (cyan, Qdrant) and `KEYWORD_COLOR = #ea580c` (orange, Elasticsearch).

#### 2.2.7 Status

`STATUS_COLORS` keyed by the upper-cased API string; `statusColor(value)` falls back to `NEUTRAL[400]`.

| Status | Colour |
|---|---|
| `QUEUED` | `#5f6e85` |
| `RUNNING` | `#5b5bd6` |
| `SUCCEEDED` | `#16a34a` |
| `FAILED` | `#dc2626` |
| `CANCELLED` | `#94a3b8` |
| `HEALTHY` / `DEGRADED` / `UNAVAILABLE` | `#16a34a` / `#ca8a04` / `#dc2626` |

#### 2.2.8 Fixed shell colours (not themed)

The sidebar is dark in both themes: background `#0f172a !important`, right border
`rgba(148,163,184,0.12)`, group titles `#94a3b8` (6.9:1 on the rail; the former 55 % alpha measured
2.98:1), logo title `#fff`, logo subtitle `rgba(255,255,255,0.68)`, collapse trigger bg `#0b1220`
(hover `#131f38`) with icon `rgba(255,255,255,0.55)` (hover `#fff`), foot panel border
`rgba(148,163,184,0.14)`, foot text `rgba(226,232,240,0.7)`, foot numbers `#fff`. Mobile scrim
`rgba(2,6,23,0.55)`.

#### 2.2.9 Community colours (`lib/palette.ts`)

Twelve hues that hold 3:1 against both the light card (`#fff`) and the dark card (`#15171c`); the
first eight are the chart series order:

`#5b5bd6`, `#0891b2`, `#16a34a`, `#ca8a04`, `#db2777`, `#7c3aed`, `#0d9488`, `#ea580c`,
`#2563eb`, `#65a30d`, `#c026d3`, `#b45309`.

Leiden ids are arbitrary integers, so the colour is a **stable hash of the id**:

```ts
hashed = Math.imul(Math.abs(id) ^ 0x9e3779b9, 0x85ebca6b) >>> 0
color  = COMMUNITY_COLORS[hashed % 12]
```

`null`/`undefined` (in no community) → `UNASSIGNED_COLOR = NEUTRAL[400] = #94a3b8`.
Vocabulary: `NO_COMMUNITY = "No community"`, label `C<id>` (`communityLabel`), and the hint
`NO_COMMUNITY_HINT` = "In no community: added since the last clustering run, or too loosely linked
to join one (a community has at least two documents)."

### 2.3 CSS custom properties

`AppearanceProvider` writes these on `<html>` (`document.documentElement.style`) on every mode or
density change, plus `data-theme`, `data-density`, `style.colorScheme`, and sets
`<meta name="theme-color">` to `#0e0f14` (dark) or `#ffffff` (light).

| Property | Light | Dark |
|---|---|---|
| `--nu-accent` | `#5b5bd6` | `#7c7cf5` |
| `--nu-accent-ink` | `#4338ca` | `#9a9aec` |
| `--nu-accent-soft` | `#eeeefc` | `rgba(124,124,245,0.16)` |
| `--nu-bg` | `#f1f5f9` | `#0b0c10` |
| `--nu-surface` | `#ffffff` | `#15171c` |
| `--nu-surface-raised` | `#ffffff` | `#1b1e24` |
| `--nu-border` | `#e2e8f0` | `#262a33` |
| `--nu-border-subtle` | `#f1f5f9` | `#232730` |
| `--nu-border-strong` | `#cbd5e1` | `#343a45` |
| `--nu-hover` | `#f1f5f9` | `#232730` |
| `--nu-text` | `#0f172a` | `#e8eaf0` |
| `--nu-text-secondary` | `#475569` | `#9aa2b1` |
| `--nu-text-tertiary` | `#5f6e85` | `#7d8595` |
| `--nu-success` / `-warning` / `-danger` / `-info` | semantic fills (same both modes) | same |
| `--nu-success-ink` … `--nu-info-ink` | `SEMANTIC_INK.light` | `SEMANTIC_INK.dark` |
| `--nu-row-height` / `--nu-control-height` / `--nu-font-size` / `--nu-padding` | from density (§2.9) | same |
| `--nu-font` / `--nu-font-mono` | `FONT.family` / `FONT.mono` | same |
| `--nu-radius-control` / `--nu-radius-card` | `4px` / `6px` | same |
| `--nu-shadow-sm` / `-md` / `-lg` | `SHADOW` | `SHADOW_DARK` |
| `--nu-canvas` | `#f8fafc` | `#08090c` |
| `--nu-canvas-grid` | `rgba(71,85,105,0.07)` | `rgba(154,162,177,0.06)` |

### 2.4 antd theme (`theme/antd.ts → buildTheme(mode, density)`)

`ConfigProvider theme={buildTheme(...)}` with `componentSize = 'small'` when the rendered density
is compact, else `'middle'`. `cssVar: { key: 'sl' }`; algorithm `darkAlgorithm` / `defaultAlgorithm`;
`wireframe: false`; `lineHeight: 1.5`.

**Global tokens**

| Token | Light | Dark | Note |
|---|---|---|---|
| `colorPrimary` | ACCENT 500 | ACCENT 400 | |
| `colorLink` / `Hover` / `Active` | 500 / 600 / 700 | 300 / 200 / 400 | |
| `colorInfo` / `Success` / `Warning` / `Error` | semantic fills | same | |
| `colorBgLayout` | NEUTRAL 100 | INK 900 | |
| `colorBgContainer` | PAPER | INK 800 | |
| `colorBgElevated` | PAPER | INK 750 | |
| `colorBorder` / `colorBorderSecondary` | NEUTRAL 200 / 100 | INK 600 / 650 | |
| `colorText` / `Secondary` / `Tertiary` | NEUTRAL 900 / 600 / 500 | INK 100 / 300 / 400 | |
| `colorTextDescription` | NEUTRAL 600 | INK 300 | named: derived lands just under 4.5:1 |
| `colorTextPlaceholder` | NEUTRAL 500 | INK 400 | named: derived measured 1.83:1 |
| `color{Success,Warning,Error,Info}Text` | `SEMANTIC_INK.light` | `SEMANTIC_INK.dark` | |
| `fontFamily` / `fontFamilyCode` | `FONT.family` / `FONT.mono` | same | |
| `fontSize` / `controlHeight` | density | density | |
| `borderRadius` / `LG` / `SM` | 4 / 6 / 4 | same | |
| `boxShadow` / `boxShadowSecondary` | `SHADOW.md` / `.lg` | `SHADOW_DARK.md` / `.lg` | |

**Component overrides**

| Component | Override | Why |
|---|---|---|
| Layout | `headerBg` PAPER / INK 850, `headerHeight 56`, `headerPadding '0 16px'`, `siderBg` NEUTRAL 900, `bodyBg` NEUTRAL 100 / INK 900 | shell |
| Menu | `itemHeight = controlHeight + 4`, `itemMarginInline 8`, `itemBorderRadius 4`, `darkItemBg` and `subMenuItemBg` transparent, `darkItemSelectedBg` ACCENT 500 | rail look |
| Table | `cellPaddingBlock = (rowHeight − fontSize × 1.5) / 2`, `cellPaddingInline = padding`, `headerBg` NEUTRAL 50 / INK 750, `headerSplitColor` transparent, `rowHoverBg` ACCENT 50 / INK 700, `borderColor` NEUTRAL 200 / INK 650 | row height follows density exactly |
| Button | `colorPrimary` ACCENT 500 (both modes), `colorError` danger, no shadows | white on the derived indigo is 4.45:1; ACCENT 500 is 5.37:1 |
| Card | `paddingLG = padding + 4` | density |
| Descriptions | `itemPaddingBottom = padding` | density |
| Tabs | `horizontalMargin '0 0 12px 0'`, selected/ink ACCENT 500 (light) / 300 (dark), hover 600 / 200 | readable selected tab |
| Tooltip | `colorBgSpotlight` NEUTRAL 800 / INK 700 | |
| Dropdown | dark only: `colorPrimary` ACCENT 200 | selected item ink measured 2.69:1 derived, 6.3:1 named |
| Select | dark only: `optionSelectedColor` INK 100 | same issue in Select popups |
| Modal | `borderRadiusLG 8` | |
| Drawer | `paddingLG 16` | |

### 2.5 Global readability overrides (`index.css`, from the Nucleus contrast audit)

```css
.ant-btn-dangerous:not(.ant-btn-primary)               { color/border-color: var(--nu-danger-ink) !important }
.ant-btn-dangerous.ant-btn-text:not(.ant-btn-primary)  { border-color: transparent !important }
.ant-tag-success, .ant-tag-green                       { color: var(--nu-success-ink) !important }
.ant-tag-warning, .ant-tag-gold, .ant-tag-orange       { color: var(--nu-warning-ink) !important }
.ant-tag-error,   .ant-tag-red                         { color: var(--nu-danger-ink) !important }
.ant-tag-processing, .ant-tag-blue, .ant-tag-cyan, .ant-tag-geekblue { color: var(--nu-info-ink) !important }
.ant-tag-purple                                        { color: var(--nu-text) !important }
```

Also: `::selection` accent background with white text; thin scrollbars
(`scrollbar-color: var(--nu-border) transparent`); `mark` and `mark.nu-mark` =
`background: var(--nu-accent-soft); color: inherit; font-weight: 650; padding 0 1px; radius 3px`
(matches in the accent tint, never browser yellow).

RAQB's own cream-and-gold palette is replaced (`.nu-query-builder …`): groups on `--nu-bg` with
`--nu-border`, rules on `--nu-surface-raised` with `--nu-border-subtle`, error borders/text
`--nu-danger`, drop placeholder border `--nu-accent`; the builder has `min-width: 680px` inside a
horizontally scrolling wrapper.

### 2.6 ECharts theme and option builders

`buildChartTheme(mode, density)` (exposed as `chartTheme` from `useAppearance()`):
`color = SERIES`, transparent background, text `fontFamily` Inter, `fontSize = density − 1`, colour
NEUTRAL 600 / INK 300; axis colour NEUTRAL 200 / INK 650; `strong` NEUTRAL 900 / INK 100;
`surface` PAPER / INK 800; tooltip bg PAPER / INK 750, border = axis colour, 1 px, text strong
colour at density font size.

`components/charts/echarts.ts` registers only **Bar, Line, Pie, Scatter** + Aria, DataZoom, Grid,
Legend, MarkLine, Tooltip components + CanvasRenderer.

`components/charts/options.ts` (every builder takes the theme; `aria.enabled: true`; tooltips
`confine: true`; `animation` off under `prefers-reduced-motion`):

| Builder | Shape |
|---|---|
| `compact(v)` | tick formatter: `1.5M`, `15k`, else up to 3 decimals |
| `barOption` | category × value; optional per-bar `colors`, `horizontal` (then y inverse, radius `[0,3,3,0]`, else `[3,3,0,0]`), `barMaxWidth 28`, axis-shadow tooltip; **inside dataZoom when > 40 vertical categories** (initial window = 40 bars); grid `8/16/16/8` containLabel |
| `lineBarOption` | line (left axis, `symbolSize 6`, width 2) + optional bars (right axis, opacity 0.35, `barMaxWidth 22`); legend top, `roundRect` 10×10 |
| `scatterOption` | x/y value axes (`scale: true`), y-axis name left-aligned so it is not clipped, bubble `symbolSize = 6 + √(size/max) × 26`, opacity 0.8, 1 px border in `surface`; tooltip `<b>C12</b><br/>Cohesion: 0.812<br/>Conductance: 0.104<br/>Size: 37` |
| `pieOption` | donut radius `45%–72%`, centre `50% 45%`, 2 px surface borders, labels `{d}%` only (names in the scrolling bottom legend), `minShowLabelAngle 4` |

Axis style everywhere: axis line in `axis`, no ticks, labels 11 px in `text`, dashed split lines.

### 2.7 Graph canvas palette (`CANVAS_PALETTES`)

The canvas cannot read CSS; the page passes the palette for the current mode.

| Key | Light | Dark | Painted as |
|---|---|---|---|
| `link` | `rgba(71,85,105,0.22)` | `rgba(154,162,177,0.22)` | normal edges |
| `linkDim` | `rgba(71,85,105,0.05)` | `rgba(154,162,177,0.05)` | edges outside the focus / highlight |
| `linkFocus` | `rgba(91,91,214,0.8)` | `rgba(124,124,245,0.85)` | edges of the hovered/selected node (1.6 px) |
| `ring` | `#5b5bd6` | `#7c7cf5` | halo and outer ring of the marked node |
| `hover` | `#0f172a` | `#e8eaf0` | hover ring |
| `seed` | `#0f172a` | `#e8eaf0` | thin ring on search results |
| `label` | `rgba(15,23,42,0.88)` | `rgba(232,234,240,0.88)` | node labels |
| `background` | `#f8fafc` | `#08090c` | PNG export fill, label halo |
| `marker` | `#0f172a` | `#ffffff` | body of the selected / centre node (max contrast with every community colour) |

The stage behind the canvas: `--nu-canvas` background with a 40 × 40 px grid of 1 px
`--nu-canvas-grid` lines.

### 2.8 Typography

Font: **Inter Variable**, self-hosted via `@fontsource-variable/inter` (imported in `main.tsx`), stack
`'Inter Variable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`.
Monospace (identifiers only: external ids, internal ids, sources, code, inspector text):
`'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` at `0.88em`
(JetBrains Mono is not bundled; the system monospace is the usual result). Body:
`-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility`. All counts use
`font-variant-numeric: tabular-nums`.

| Element | Size / weight / extras |
|---|---|
| Body, controls | density font size: 13 (compact) / 14 / 14 px |
| Page title `h1.nu-page-title` | 22 px / 650, letter-spacing −0.015em, inline tag beside it |
| Page subtitle | 13 px, `--nu-text-secondary`, max-width 110ch |
| Section title `.nu-section-title` (h2 in drawers) | 14 px / 650 |
| Detail headings `.sl-detail-heading` (h2 in expanded rows) | 13 px / 650 |
| KPI label | 11.5 px / 600, uppercase, letter-spacing 0.04em, secondary |
| KPI number | 24 px / 700, line-height 1.15, letter-spacing −0.02em, tabular |
| KPI hint | 11.5 px, line-height 1.35, 2-line clamp |
| Sidebar group title | 11 px / 700, uppercase, letter-spacing 0.09em, `#94a3b8` |
| Logo | title 15 px / 650 white, letter-spacing −0.01em; subtitle 11 px |
| Sidebar foot | 12 px, line-height 1.6 |
| Breadcrumb | 13 px |
| Footer doc key / value | 10.5 px / 700 uppercase 0.08em tertiary / 12 px secondary |
| Chips | 12.5 px, line-height 1.3 |
| Result meta, timings, hints | 12 px secondary |
| Result text | line-height 1.55, `overflow-wrap: anywhere` |
| Document drawer body text | 15 px, line-height 1.6 |
| `kbd` | 11 px mono, 1 px border + 2 px bottom border, radius 4, `--nu-bg` |
| Empty state | title strong, hint 12.5 px tertiary, icon 28 px tertiary at 0.7 opacity |

Copy style: sentence case everywhere (titles, buttons, menu items); verbs on buttons
("Run clustering", "Import data", "Explore its documents"); "…" on buttons that open a
confirmation ("Delete…", "API key…"); curly quotes around user text (`“railway”`); middle dot
` · ` separates facts; en dash for ranges (`1–25 of 1,234`); counts via `Intl.NumberFormat('en-US')`;
relative times via `Intl.RelativeTimeFormat('en', {numeric:'auto'})` ("2 hours ago", "yesterday"),
with the absolute `toLocaleString()` in a tooltip. Missing values render `—`.

### 2.9 Density and spacing

| Density (label) | Row height | Control height | Font | Padding | antd `componentSize` |
|---|---|---|---|---|---|
| `compact` ("Compact") | 32 | 28 | 13 | 8 | small |
| `middle` ("Standard", default) | 40 | 32 | 14 | 12 | middle |
| `comfortable` ("Comfortable") | 52 | 40 | 14 | 16 | middle |

On a handheld (`max-width: 767px`) a stored `compact` renders as `middle` — 28 px controls miss the
24 px touch minimum once padding is counted; the stored preference is kept.

Fixed spacing: page stack gap **12 px** (`.nu-page`, `.nu-fill`); grids gap 12 px; content padding
`20px 24px 0` (≤ 991 px: `14px 14px 0`); header padding-inline 18 px (≤ 991: 10 px) and gap 12 (8);
KPI tile body 16 px; alert strip body `10px 14px`; results padding `12px 16px`; card body padding =
`padding + 4`. Layout constants (`LAYOUT`): header 56, sidebar 248 / collapsed 56.

### 2.10 Radius, shadow, elevation, z-index

Radius: control 4, card 6, modal 8, pill 999 (chips, job pill, legend chips); KPI icon tile 10;
sidebar foot 8; `mark` 3; rank bars 3.

| Shadow | Light | Dark |
|---|---|---|
| sm | `0 1px 2px rgba(15,23,42,0.06)` | `0 1px 2px rgba(0,0,0,0.5)` |
| md | `0 2px 8px rgba(15,23,42,0.08)` | `0 4px 16px rgba(0,0,0,0.5)` |
| lg | `0 8px 24px rgba(15,23,42,0.12)` | `0 12px 34px rgba(0,0,0,0.62)` |

Depth in dark mode comes from darker, more opaque shadows. Elevation ladder: page `--nu-bg` →
cards `--nu-surface` → popovers/drawers/raised `--nu-surface-raised`.

z-index: skip link 1000; mobile sidebar 60; scrim 50; graph tooltip 3; graph overlays 2; sticky
drawer action bar 3; RAQB duplicate button 2.

### 2.11 Icons

Only `@ant-design/icons` *Outlined* glyphs. Navigation: `DashboardOutlined` (Dashboard),
`SearchOutlined` (Documents), `ApartmentOutlined` (Similarity graph), `ClusterOutlined`
(Communities), `ImportOutlined` (Import), `ControlOutlined` (Operations). Recurrent meanings:
`FilterOutlined` conditions / presets, `SlidersOutlined` ranking options, `HighlightOutlined`
graph highlight, `ApartmentOutlined` "show in graph" and applied condition chips, `EyeOutlined`
open/details, `AimOutlined` neighbourhood, `ClearOutlined` clear, `DownloadOutlined` export/CSV,
`SaveOutlined` / `FolderOpenOutlined` saved searches, `ReloadOutlined` refresh / import another,
`DeleteOutlined` delete, `KeyOutlined` API key, `SettingOutlined` settings,
`SunOutlined`/`MoonOutlined`/`DesktopOutlined` appearance, `ExportOutlined` external consoles,
`WarningOutlined` consistency band, `InboxOutlined` empty/dropzone, `QuestionCircleOutlined` help,
`InfoCircleOutlined` explain, `HistoryOutlined` recent search, `CopyOutlined` duplicate rule,
`BarChartOutlined`/`TableOutlined` chart↔table, `TableOutlined`/`BarsOutlined`/`AppstoreOutlined`
table/list/cards. Icons in KPI tiles sit in a 36 × 36 tile tinted with
`color-mix(in srgb, <accent> 14%, transparent)` and are `aria-hidden`.

### 2.12 Motion

- Hover transitions 120 ms ease: KPI tiles (shadow md, `translateY(-1px)`, accent border),
  chips, results (accent border + shadow sm), duplicate-rule button fade.
- Mobile sidebar slides with `transform 0.2s ease`.
- Charts animate (ECharts default) unless reduced motion.
- Graph layout animates with d3-force; drag reheats to `alphaTarget(0.25)`.
- `prefers-reduced-motion: reduce`: global CSS clamps animations/transitions to 0.01 ms and
  `scroll-behavior: auto`; ECharts `animation: false`; the graph computes its layout synchronously
  (`simulation.tick(min(300, ceil(log(alphaMin)/log(1 − alphaDecay))))`) and draws once; the first
  auto-fit happens after 50 ms instead of 900 ms.

### 2.13 Focus

`:focus-visible { outline: 2px solid var(--nu-accent); outline-offset: 2px; border-radius: 2px }`;
chips and chip parts: 2 px accent outline, offset 2 / 1 px; central-document buttons offset 1 px;
`#nu-main:focus { outline: none }` (it is focused programmatically by the skip link). The skip link
`Skip to content` is off-screen (`left: -9999px`) until focused, then pinned top-left on
`--nu-surface` with shadow md and radius `0 0 6px 0`.

### 2.14 Contrast rules (summary)

1. Body and secondary text ≥ 4.5:1 on every ground it lands on (page, card, raised, rail).
2. Status fills ≥ 3:1; any **text** in a status colour uses the ink variant.
3. Community colours ≥ 3:1 against `#fff` and `#15171c`; community *names* are always text in
   `--nu-text` next to the coloured glyph, never coloured text.
4. Measured fixes kept in code comments: NEUTRAL 500 `#64748b → #5f6e85` (4.34:1); primary
   buttons on ACCENT 500 (4.45:1 → 5.37:1); placeholders named (1.83:1); sidebar group titles
   `#94a3b8` (2.98:1 → 6.9:1); dark dropdown selection ACCENT 200 (2.69:1 → 6.3:1); dark Select
   selected option INK 100; tags and danger buttons re-inked (§2.5).
5. A tinted chip keeps its tertiary text readable by remapping
   `--nu-text-tertiary: var(--nu-text-secondary)` inside `.nu-chip.is-pressed`.

---

## 3. App shell

### 3.1 Provider stack (`main.tsx`)

```
@fontsource-variable/inter + index.css
<StrictMode>
  <QueryClientProvider client>          refetchOnWindowFocus false · staleTime 15 s ·
                                        retry: never on 4xx ApiError, else up to 2
    <AppearanceProvider>                appearance + density → antd ConfigProvider, CSS vars, chart theme
      <AntApp notification={{ maxCount: 3, placement: 'bottomRight' }}>   (App.useApp() message/notification)
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />                       <Routes> with <AppShell/> as the layout route
```

`AppShell` renders: skip link → mobile scrim → `Sider` → `Layout` { `Header`, `ConsistencyBand`,
`Content` { `#nu-main` (tabIndex −1) › `DocumentDrawerProvider` › `ErrorBoundary resetKey=pathname`
› `Suspense fallback=<Skeleton active paragraph={{rows:10}}/>` › `<Outlet/>` } } → `ApiKeyDialog`.

### 3.2 Layout

Desktop (≥ 992 px, `lg`):

```
┌──────────────┬──────────────────────────────────────────────────────────────────────────────┐
│ ◎ Semantic   │ Explore / Explore documents        [Import ▰▰▱ 42%] ● Ready [Consoles ▾] (☾) (⚙)│ 56 px header
│   Leiden     ├──────────────────────────────────────────────────────────────────────────────┤
│   Explorer·v0.4│ ⚠ Stores disagree on the document count — Elasticsearch 72, Qdrant 70, …  [Reconcile under Operations] │ band (only when inconsistent)
│              ├──────────────────────────────────────────────────────────────────────────────┤
│ OVERVIEW     │                                                                              │
│ ▣ Dashboard  │   page content (full width, scrolls inside .nu-content)                      │
│ EXPLORE      │                                                                              │
│ ⌕ Documents  │                                                                              │
│ ⋔ Similarity │                                                                              │
│   graph      │                                                                              │
│ ⊛ Communities│                                                                              │
│ DATA         │                                                                              │
│ ⇩ Import   ● │  ← processing badge while an import runs                                     │
│ ⚙ Operations │                                                                              │
│ ┌──────────┐ │                                                                              │
│ │Documents 72│ │                                                                            │
│ │Communities 4│ │  sidebar foot "Corpus at a glance"                                        │
│ │Similarity edges 410│                                                                      │
│ └──────────┘ │   WHAT … FLOW … TECH … WHY … HOW …   (page footer)                          │
│ [   «   ]    │ ← antd collapse trigger                                                      │
└──────────────┴──────────────────────────────────────────────────────────────────────────────┘
  248 px (56 collapsed)
```

Below `lg`:

```
┌──────────────────────────────────────────────────┐
│ (☰)                     [Import 42%] ● [⇱] (☾) (⚙)│   no breadcrumb; Consoles icon-only; readiness text hidden < 768
├──────────────────────────────────────────────────┤
│ page content                                      │
└──────────────────────────────────────────────────┘
(☰) opens the sidebar as an off-canvas panel (fixed, translateX(-100%) → 0, 248 px) over a scrim;
clicking the scrim or navigating closes it.
```

The shell is `height: 100dvh; overflow: hidden`; only `.nu-content` scrolls. `#nu-main` is a
flex column with `min-height: 100%` so the page footer sits at the bottom of short pages
(`.nu-pagedoc { margin-top: auto }`).

### 3.3 Sidebar

- antd `Sider theme="dark"`, width 248, `collapsible` on desktop (bottom trigger), collapsed width
  56; on mobile `collapsedWidth 0` and the `.nu-sider--mobile/--open` classes. Collapsed state
  persists in `semantic-leiden.sidebar.collapsed` (`'true'`/`'false'`).
- **Logo** link to `/` (`aria-label="Semantic Leiden Explorer, dashboard"`), min-height 56, padding
  `0 16px`, gap 11: the 28 × 28 SVG mark (viewBox 64: two ellipses `rx 26 ry 11` stroke `#8b8bf0`
  width 4 rotated −28° and 52° (second at 50 % opacity), core circle r 11 `#5b5bd6`, spark circle
  r 4 at (23, −12.2) `#22d3ee`), then **"Semantic Leiden"** over *"Explorer · v0.4"* (labels hidden
  when collapsed). The same mark is the favicon (inline SVG data URI in `index.html`).
- **Menu** (`mode="inline"`, dark), grouped (group titles hidden when collapsed):

  | Group | Item label | Path | Breadcrumb / document title |
  |---|---|---|---|
  | OVERVIEW | Dashboard | `/` | Dashboard |
  | EXPLORE | Documents | `/documents` | Explore documents |
  | EXPLORE | Similarity graph | `/graph` | Similarity graph |
  | EXPLORE | Communities | `/communities` | Communities |
  | DATA | Import | `/import` | Import |
  | DATA | Operations | `/operations` | Operations |

  The selected key is the **longest** nav key that equals or prefixes the path (`selectedKeyFor`).
  While a job is active, the item that owns it shows a trailing `Badge status="processing"`:
  Import for `kind === 'import'`, Operations for every other kind.
- **Foot** "Corpus at a glance" (`aria-label`), shown only with labels: rows *Documents*,
  *Communities*, *Similarity edges* with bold white tabular numbers from `GET /stats`; bottom
  margin 60 px to clear the trigger.

### 3.4 Header

Grid `auto | minmax(0,1fr) | auto`, 56 px, bottom border `--nu-border`, `--nu-surface` background.

Left: on mobile a text button `☰` (`aria-label="Open navigation"`); on desktop the **breadcrumb**
(`trailFor`): overview pages show just the page title; others show `Group / Page title`, the group
linking to its first item (e.g. `Explore` → `/documents`). Each crumb is a router `Link`.

Right, in order (space 10 desktop / 4 mobile):

1. **Job pill** (`JobPill`, only while a job is queued/running): a `<button class="nu-jobpill">`
   30 px high, pill radius, `--nu-bg`, 12.5 px, max-width 280: job label (ellipsis) + 72 px antd
   `Progress size="small" status="active"` without info + `NN%`. `aria-label="<Label> running, NN%"`,
   progress `aria-label="<Label> progress"`, tooltip `"<Label>: <phase | queued>. Open for details."`.
   Click → `/import` for imports, `/operations` otherwise. Percent = `jobPercent()` (§5.18).
   Labels: Import, Rebuild graph, Clustering, Reconcile, Delete source.
2. **Readiness**: `Badge` status `processing` ("Checking") until the first `/ready` answer, then
   `success` ("Ready") or `error` ("Degraded"); text hidden below 768 px. Tooltip lists the checks
   (`elasticsearch: up, qdrant: up, neo4j: down`), or "API unreachable" / "Checking the stores".
   Polled every 20 s, no retry.
3. **Consoles** dropdown button ("Consoles ▾"; icon-only `ExportOutlined` on mobile,
   `aria-label="Operator consoles"`). Items open in a new tab (`rel="noreferrer noopener"`), each with
   a small `ExportOutlined`: "API docs (Swagger)" → `http://localhost:8000/docs`, "Qdrant dashboard" →
   `http://localhost:6333/dashboard`, "Neo4j Browser" → `http://localhost:7474`,
   "Elasticsearch (JSON)" → `http://localhost:9200` (local-compose defaults in `config.ts`).
4. **Theme toggle**: circle button, `SunOutlined` in dark / `MoonOutlined` in light; tooltip
   "Switch to light"/"Switch to dark"; `aria-label` "Switch to the light theme"/"…dark theme". It
   sets an explicit `light`/`dark` appearance (leaving `system`).
5. **Settings** (circle `SettingOutlined`, click-triggered dropdown, selectable, with a red badge dot
   when an API key is required but not set). Menu:
   - group **Appearance**: Light (`SunOutlined`), Dark (`MoonOutlined`), System (`DesktopOutlined`)
   - group **Density**: Compact, Standard, Comfortable
   - divider
   - "API key…" (`KeyOutlined`); when required and missing: "API key… (required)" in danger style.

   Selected keys mark the current appearance and density. Tooltip "Settings" / "Settings — an API
   key is required for write actions", suppressed while the menu is open. `aria-label` "Settings"
   / "Settings (API key required)".

### 3.5 Consistency band

Rendered under the header on **every page** when `stats.consistent === false` and no job is active
(`jobs_active` false — counts legitimately differ mid-job): a full-width strip, `role="status"`,
background `color-mix(in srgb, var(--nu-warning) 12%, var(--nu-surface))`, bottom border warning
35 %, 13 px, `WarningOutlined` in warning ink:

> Stores disagree on the document count — Elasticsearch 72, Qdrant 70, Neo4j 72. **[Reconcile under Operations]**

### 3.6 Error boundary, suspense, not found

- `ErrorBoundary` (class component) wraps every page inside the shell, so a fault never takes the
  navigation down; it resets when the pathname changes. Fallback: antd `Result status="warning"`
  title "This view hit an unexpected error", subtitle = error message, button "Try again".
  **After a deploy** a tab started on the previous build may ask for a chunk that no longer exists
  ("Failed to fetch dynamically imported module"). Pages and the query builder load through
  `lazyPage` (`lib/lazyPage.ts`), which reloads the tab **once** to pick up the new build (`index.html`
  is `no-cache`); `main.tsx` does the same on Vite's `vite:preloadError`. A second failure within 30 s
  (sessionStorage `semantic-leiden.chunk-reload-at`) is not retried: the boundary shows an info
  Result "A new version of the app is available" / "This tab still runs the previous version, whose
  files were replaced. Reload to continue; nothing you saved is lost." with a primary **Reload**.
- Lazy page chunks suspend into a 10-row active `Skeleton`.
- Unknown paths render `EmptyState` "There is no page at this address" / "It may have moved in the
  v0.4 navigation." with primary "Go to the dashboard".
- `document.title` = `"<nav title> · Semantic Leiden Explorer"` (e.g. "Similarity graph · Semantic
  Leiden Explorer"); `index.html` default title "Semantic Leiden Explorer".

### 3.7 API key dialog

Modal "API key" (from Settings). Paragraph: when `config.auth_required` — "The API requires a key
for imports, clustering and deletes. It is kept in this browser tab only (sessionStorage) and sent
as X-API-Key."; otherwise — "The API does not require a key right now. Set API_KEY on the server to
protect the write endpoints." One field labelled **X-API-Key** (`Input.Password`, `id="api-key-input"`,
autocomplete off, autofocus). Footer: link-style "Clear the stored key" (left, only when a key is
stored), "Close", "Save". Toasts: "API key saved for this tab" / "API key cleared".
`useApiKeyNeeded()` = `auth_required && no stored key` drives the badge dot and the danger item.

---

## 4. Routing and URL state

### 4.1 Route table (`App.tsx`)

| Path | Element | Chunk |
|---|---|---|
| `/` (index) | `Home` → legacy redirect or `OverviewPage` | `OverviewPage` |
| `/documents` | `ExplorePage` | `ExplorePage` |
| `/explore` | `<Navigate to="/documents" replace/>` | — |
| `/search` | `<Navigate to="/documents" replace/>` | — |
| `/graph` | `GraphPage` | `GraphPage` |
| `/communities` | `CommunitiesPage` | `CommunitiesPage` |
| `/import` | `ImportPage` | `ImportPage` |
| `/operations` | `OperationsPage` | `OperationsPage` |
| `*` | `NotFound` | — |

All six pages are `React.lazy` imports. After first paint the app warms the two likeliest next
chunks, `ExplorePage` and `GraphPage`, in `requestIdleCallback` (fallback `setTimeout` 1500 ms).

### 4.2 Legacy redirects

v0.3 kept the view in `/?tab=`; `Home` rewrites these with `replace`, keeping every other
parameter:

| `?tab=` | Goes to | Extra rewrite |
|---|---|---|
| `search` | `/documents` | if `q` is present and `mode` is not, add `mode=hybrid` |
| `documents` | `/documents` | — |
| `graph` | `/graph` | if `focus` is present, add `view=focus` |
| `communities` | `/communities` | — |
| `import` | `/import` | — |
| `operations` | `/operations` | — |

### 4.3 `useUrlState()` semantics

`const [params, set] = useUrlState()` wraps `useSearchParams`:

- `set(changes, { push? })` merges into the **current** parameters (functional update, so two
  handlers in one tick do not clobber each other). `null`, `undefined` and `''` delete a key.
- Default is **replace** (no history entry): used for refinements — pagination, sort, page size,
  view, edge limit, min similarity, mode segments on Graph/Communities, highlight trees, quick
  community filters.
- `{ push: true }` adds a history entry: submitting a search, choosing an example, applying an
  Explore condition tree, "Clear all", switching the graph view, choosing a graph centre, clicking
  "Neighbourhood".
- Defaults are **not written**: a parameter equal to its default is removed, so canonical URLs stay
  short (e.g. `mode` is dropped when it equals the implied default, `limit=1000`, `seeds=150`,
  `size=25`, `view=table`).
- Parsers: `positiveInt(v, fallback)` (integers > 0), `parseJson<T>(v)` (object or null; bad JSON →
  null, never throws), `parseIds(v)` (comma list → integers, **empty segments dropped before
  `Number()`**, which would otherwise turn `''` into community 0).

### 4.4 Per-page parameters

**`/documents`**

| Param | Values | Default | Notes |
|---|---|---|---|
| `q` | text | `''` | the search box; live search writes it trimmed |
| `mode` | `browse` \| `hybrid` \| `semantic` \| `keyword` | `hybrid` if `q` else `browse` | *ranked* = mode ≠ browse **and** `q` non-empty; `semantic` with empty `q` behaves as browse |
| `tree` | RAQB JSON tree | none | the applied advanced conditions |
| `communities` | `3,7` | none | quick community filter (merged into the tree as `community_id is one of`) |
| `sort` | `updated_at` `created_at` `length` `external_id` `community_id` `source` `_score` | `_score` if `q` else `updated_at` | browse only |
| `order` | `asc` \| `desc` | `desc` | |
| `page` | ≥ 1 | 1 | browse only; `page × size ≤ 10,000` |
| `size` | 1–200 | 25 | page size when browsing; `top_k` when ranking ("Show 25 more" adds 25) |
| `view` | `table` \| `list` \| `cards` | `table` (≥ 768 px) / `list` (< 768 px) | |
| `record` | document id | none | opens the document drawer once, then the param is removed |

**`/graph`**

| Param | Values | Default | Notes |
|---|---|---|---|
| `view` | `top` \| `communities` \| `focus` \| `query` | `focus` if `focus` present, else `top` | |
| `limit` | presets 250, 500, 1000, 2000, 5000, or any 1–10,000 (Custom…; larger values clamped) | 1000 | edges (top/communities); node limit for focus = `min(limit, 1000)` |
| `min` | 0–1 | 0 | lower bound of the similarity band (debounced 250 ms before fetching) |
| `max` | 0–1 | 1 | upper bound of the similarity band (debounced 250 ms); crossed bounds in a hand-edited URL are read as the band between them (`similarityBand` in `hooks/useUrlState.ts`) |
| `communities` | ids | none | view `communities` |
| `focus` | document id | none | centre of the neighbourhood |
| `hops` | `1` \| `2` | 1 | |
| `q` | text | none | view `query` |
| `mode` | `hybrid` \| `semantic` \| `keyword` | `hybrid` | view `query` |
| `tree` | RAQB JSON | none | "which documents to draw" (server) |
| `seeds` | 25, 50, 100, 150, 200, 500, 1000 | 150 | how many matching documents |
| `expand` | `1` | off | also draw their strongest neighbours (`neighbor_limit` 300) |
| `hl` | RAQB JSON | none | highlight conditions (browser) |
| `hlmode` | `hide` | dim | hide instead of dim non-matching nodes |

**`/communities`**: `q` (topic, or `C12`/`12` to jump — regex `/^\s*c?(\d+)\s*$/i`), `mode`
(`hybrid` default), `tree` (metric conditions), `selected` (community id; expands its row, turns to
its page and scrolls to it). Table sort and page are component state, not URL.

**`/import`**: `job` (an import job id to show; written when an upload becomes a job).

**`/` and `/operations`**: none.

### 4.5 Deep links (`lib/links.ts`)

All cross-page navigation is built here so a drill-down always means the same question on arrival.

| Builder | Produces |
|---|---|
| `links.explore({ q?, mode?, communities?, rules?, record? })` | `/documents?q=…&mode=…&communities=1,2&tree=<treeFromRules(rules)>&record=…` |
| `links.graph({ focus?, communities?, q?, view? })` | `/graph?view=…` where view defaults to `focus` (if focus) → `communities` (if ids) → `query` (if q) |
| `links.communities({ selected?, q? })` | `/communities?selected=…&q=…` |

Rule helpers (each a `SimpleRule {field, operator, value}`):

| Helper | Rule |
|---|---|
| `rule.source(s)` | `source select_equals [s]`, or `source is_null` for `null` (the "(no source)" bucket) |
| `rule.unassigned()` | `community_id is_null` — in no community, for either reason |
| `rule.unclustered()` | `community_version is_null` — added/changed since the last run |
| `rule.clustered()` | `community_version is_not_null` |
| `rule.communities(ids)` | `community_id select_any_in [ids]` |
| `rule.lengthAtLeast(n)` | `length greater_or_equal [n]` |
| `rule.lengthBetween(a, b)` | `length between [a, b]` |

"In no community but clustered" (too loosely linked) = `clustered() AND unassigned()`.

### 4.6 Drill-down map

| From | Action | To |
|---|---|---|
| Dashboard | Documents tile | `/documents` |
| Dashboard | Similarity edges / Mean degree tile | `/graph` |
| Dashboard | Communities tile | `/communities` |
| Dashboard | Not clustered yet tile | `/documents?tree=[community_version is empty]` |
| Dashboard | In no community tile | `/documents?tree=[clustered AND community_id is empty]` |
| Dashboard | Modularity / Data sources tile, alert tags | `/operations` (job alert: `/import` for imports) |
| Dashboard | Community sizes bar, quality bubble | `/communities?selected=<id>` |
| Dashboard | Documents by source slice | `/documents?tree=[source is …]` |
| Dashboard | Document length bar | `/documents?tree=[length between a and b−1]` (last bucket: `≥ a`) |
| Explore row / result | Details, row click, Enter | document drawer |
| Explore row / result | Neighbourhood / graph icon | `/graph?view=focus&focus=<id>` |
| Document drawer | Show in graph | `/graph?view=focus&focus=<id>` |
| Document drawer | Find similar | `/documents?q=<first 300 chars>&mode=semantic` |
| Document drawer | Community C<id> | `/communities?selected=<id>` |
| Graph selected card | Neighbourhood | same page, `view=focus&focus=<id>` (push) |
| Graph selected card | C<id> | same page, `hl=<community is one of [id]>` |
| Graph selected card | Similar | `/documents?q=<first 300 chars>&mode=semantic` |
| Communities expanded row | Explore its documents | `/documents?communities=<id>` |
| Communities expanded row | Show in graph | `/graph?view=communities&communities=<id>,<2 nearest neighbours>` |
| Communities expanded row | Search “topic” here | `/documents?communities=<id>&q=<topic>&mode=hybrid` |
| Operations sources table | Explore | `/documents?tree=[source is …]` |
| Import result | Explore the documents / Open the graph | `/documents` / `/graph` |
| Job pill, consistency band | click | `/import` or `/operations` |

---

## 5. Shared components

### 5.1 `PageHeader({ title, subtitle?, actions?, tag? })`

`.nu-page-header`: flex, space-between, wrap, gap 16, margin-bottom 4. Left block (flex `1 1 480px`):
`h1.nu-page-title` holding the title **and** the optional `tag` (a count or status beside it, e.g.
`Tag color="blue" bordered={false}` "1,234 matches"), then `.nu-page-subtitle` (one sentence). Right:
`Space wrap` of actions. Every page has exactly one `h1`, and it is this one.

### 5.2 `PageDoc({ doc })` — the documentation footer

`<footer class="nu-pagedoc" aria-label="About this page">`: `margin-top: auto`, `padding 14px 0 16px`,
dashed top border, auto-fit grid `minmax(min(190px,100%),1fr)` gap `8px 16px`. Five items in order
**WHAT · FLOW · TECH · WHY · HOW**: uppercase key (10.5 px/700, tertiary) + value (12 px secondary,
three to five words). Each item with a `details` sentence gets an antd `Tooltip` with that sentence.
Content lives in `app/pageDocs.ts` (`PAGE_DOCS.overview|explore|graph|communities|import|operations`)
and is quoted per page in §6.

### 5.3 `EmptyState({ title?, hint?, icon?, action?, compact? })` and `NoResults`

Centred block: icon (default `InboxOutlined`, 28 px, tertiary, 0.7 opacity), strong title, 12.5 px
tertiary hint, optional action (margin-top 12). Padding 40/16 px, compact 18/12 px. Two distinct
meanings, never mixed: **"nothing here yet"** carries the action that creates the first record
(e.g. "Import a CSV"); **"nothing matched"** is `NoResults({ onClear?, hint? })` = "Nothing matches
this question" / default hint "Loosen the conditions, switch the matching mode or lower the minimum
score." / button "Clear the question".

### 5.4 `StatCard({ label, value, icon?, accent?, hint?, loading?, onClick? })`

antd `Card.nu-statcard` (body padding 16, min-height 96, 1 px `--nu-border`). Row: 36 × 36 icon tile
(radius 10, accent colour, 14 % tint) + label / number / hint. `accent`: `accent` (ACCENT 500,
default), `success`, `warning`, `danger`, `info`, `neutral` (NEUTRAL 500). Loading shows a small
active `Skeleton.Input` (80 px). **Clickable tiles** get `role="button"`, `tabIndex 0`,
`aria-label="<label>: <value>. Open the details."`, Enter/Space activation, pointer cursor and the
hover lift (shadow md, −1 px, accent border).

Tile grids: `.nu-kpis` (auto-fill 190 px), `.nu-kpis--4` and `--8` (4 columns; `--8` becomes 8 at
≥ 1800 px), `.nu-kpis--6` (6 columns; 3 at ≤ 1300 px); all three become 2 columns at ≤ 900 px.

### 5.5 `CommunityKey({ id, label? })`

`<span class="ckey" title="Community 12 | NO_COMMUNITY_HINT">`: a 10 × 10 square rotated 45° (radius
3, `box-shadow: 0 0 0 2px var(--nu-surface)`), `aria-hidden`, in `communityColor(id)`, then the label
(`C12`, or "No community"). Used for every community mention — tables, results, drawer, chips,
selects, legend, tooltips.

### 5.6 `Chip` and `FilterChip`

`Chip({ children, onClick, pressed?, icon?, label? })` — a real `<button type="button" class="nu-chip">`
(antd `CheckableTag` is an unfocusable span). Pill, min-height 26, padding `2px 10px`, 1 px border,
`--nu-surface`, 12.5 px secondary text; hover → accent border + text colour; `pressed` →
`aria-pressed` + `.is-pressed` (accent-soft background, accent border). Used for example queries,
presets, facet toggles.

`FilterChip({ children, name, onEdit?, onRemove, icon?, tone? })` — an applied filter: two buttons
inside one pill: the label (`aria-label="Edit <name>"`, hover accent ink) and a 24 × 24 round `×`
(`aria-label="Remove <name>"`, hover danger ink on `--nu-hover`). `tone="accent"` renders pressed.
Max width `min(560px, 100%)`, text ellipsis.

### 5.7 `ListMeta({ title, description? })`

`List.Item.Meta` without its `<h4>` (a stray h4 under the page h1 broke heading order). Title 600
weight, description 13 px secondary.

### 5.8 `ChartCard` — a chart that is always also a table

Props: `id`, `title`, `option` (ECharts option or `null`), `rows`, `columns [{key,label}]`, `height`
(default 260), `extra?`, `onSelect?(name, index)`, `loading?`, `empty?{title,hint}`, `description?`.

- antd `Card size="small" class="nu-chartcard"`; `extra` holds: page extras, a text icon button
  `DownloadOutlined` (tooltip "Download these numbers as CSV", `aria-label="Download <id> as CSV"`,
  disabled with no rows) exporting `<id>.csv` via `toCsv(rows, columns)`, and a small `Segmented`
  with two icon options `BarChartOutlined` "Chart" / `TableOutlined` "Table".
- The chosen view persists per chart in `semantic-leiden.chart.<id>`.
- `description` renders above the body at 12 px secondary.
- No rows or no option → compact `EmptyState` (default "Nothing to chart yet") centred in `height`.
- Chart view: `ReactEChartsCore` (`notMerge`), click on a bar/point/slice calls `onSelect(name,
  dataIndex)`; pointer cursor when selectable.
- Table view: small antd `Table`, 10 rows per page when > 10, `scroll.y = height − 40`, numbers
  `toLocaleString()`, nulls `—`; row click calls `onSelect(firstColumnValue, index)`.

### 5.9 `SearchBox` (after Nucleus `SimpleSearch`)

`AutoComplete` wrapping an `Input` (`allowClear`, `SearchOutlined` prefix, placeholder doubling as
`aria-label`). Suffix: "searching…" (12 px secondary) while loading, else a faint `<kbd>/</kbd>`.
Suggestions are **only the reader's recent searches for this page** (`scope`: `explore`, `graph`,
`communities`), filtered by substring, excluding the current value: a group header "Recent searches"
with a link-style "Clear", then rows `HistoryOutlined term` with a small `×` ("Forget this search",
`aria-label="Forget <term>"`). Enter or picking a suggestion submits and remembers the term (≥ 2
characters, most recent first, 10 max, de-duplicated). Terms are remembered on submit, never while
typing.

### 5.10 `SavedSearchButtons({ summary, disabled? })` (after Nucleus `SavedSearchDrawer`)

Two header actions on Explore, Graph and Communities:

- **"Saved (n)"** (`FolderOpenOutlined`; `n` = saved searches for *this path*) opens a 440 px Drawer
  "Saved searches". Empty: "No saved searches on this page" / "Ask a question, then use Save search
  to keep it here." Rows: name as a link button (navigates to `path + search`, closes the drawer),
  the summary (12 px) and "saved 3 days ago" (11 px); actions: copy-link icon ("Copy a link to this
  search"; toast "Link copied") and danger delete icon with `Popconfirm` "Delete “<name>”?".
- **"Save search"** (`SaveOutlined`), disabled with tooltip "Ask a question first — there is nothing
  to save yet" when the page has no question; otherwise tooltip "Save this question under a name".
  Opens Modal "Save this search" with a required **Name** (max 80, prefilled with the first 60
  characters of the summary; error "Give the search a name") and the summary below. Saves
  `{id, name, path, search, summary, created_at}` at the top of the list (100 max); toast
  `Saved “<name>”`.

A saved search *is* a URL; nothing is stored server-side.

### 5.11 `AdvancedConditionsDrawer` (after Nucleus `AdvancedSearchDrawer`)

One drawer serves four evaluators (Explore documents, Graph "which documents to draw", Graph
highlight, Communities metrics). Props: `open`, `title?` (default "Advanced conditions"), `noun`
(plural), `fields: BuilderField[]`, `value`, `onClose`, `onApply(tree|null)`,
`usePreview(draft) → {count, text?, loading?, error?}` (a hook; server count or local count),
`presets?`, `engine` (where it runs, used in the lesson), `extraHelp?`.

```
┌ ⋔ Advanced conditions ─────────────────────────────────────────────────── ✕ ┐  width min(1120px, 96vw)
│ ▾ ? How this works                                                          │  collapsible, state sticky
│   A rule            A group             And · Or · Not     Nothing runs until you apply │
│   One comparison…   A bracket around…   And narrows, Or…   The count below previews…    │
│ Start from: (⧩ Not clustered yet) (⧩ In no community) (⧩ Long documents) …  │  presets (role=group)
│ ┌ RAQB builder ─────────────────────────────────────────────────────────┐  │
│ │ [And|Or] [Not]                                     [+ Rule] [+ Group] │  │
│ │  [Choose a field ▾] [Comparison ▾] [Value      ]            ⧉  🗑    │  │
│ └───────────────────────────────────────────────────────────────────────┘  │
│ ┌ What this asks ───────────────────────────────────────────────────────┐  │
│ │ Length ≥ 500 AND Text contains "railway"                               │  │  mono pre; "All <noun>" when empty
│ └───────────────────────────────────────────────────────────────────────┘  │
│ ─────────────────────────────────────────────── (sticky bottom action bar) │
│ 2 rules · matching                         [⌫ Clear] [Cancel] [⧩ Apply · 1,204 documents] │
│ 1,204 documents                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Behaviour:

- The drawer edits a **draft**; the page keeps showing the last applied question. Closing or
  Cancel discards the draft (`destroyOnHidden`). Nothing changes behind the drawer until **Apply**.
- Initial draft: the applied tree if it has rules, else `starterTree()` (one blank rule, so the
  field picker is visible immediately).
- The draft is debounced **280 ms** before `usePreview`; the count label reads "Previewing…" while
  settling, else "1 rule · matching" / "N rules · matching", value = count, suffix = noun.
- Only finished rules count (`pruneTree`): a rule needs field + operator + value(s) (two for
  `between`; none for `is_empty`/`is_not_empty`/`is_null`/`is_not_null`). Groups left empty vanish.
- "How this works" lesson (4 columns, auto-fit 240 px): **A rule** — "One comparison: a field, how to
  compare it, and a value — `Length > 200`. Rules you have not finished are ignored while you work."
  **A group** — "A bracket around rules, answered together and then combined with the rest — how
  `A and (B or C)` is said." **And · Or · Not** — "And narrows, Or widens, Not inverts the whole
  group." **Nothing runs until you apply** — "The count below previews this draft against the real
  <noun>, evaluated by <engine>. <extraHelp>". Open state persists in
  `semantic-leiden.conditions.help` (default open).
- Presets: "Start from:" + `Chip`s with `FilterOutlined`, tooltip = preset hint; a click replaces the
  draft.
- "What this asks": the server's `condition_text` (Explore/Graph documents) or
  `describeTreeLocally()` (browser evaluators).
- Preview error: `Alert` error "This condition could not be previewed" with the message.
- Action bar (sticky bottom, raised surface, top border): **Clear** (`ClearOutlined`, disabled with 0
  rules; tooltip "Empty the tree and start again. Nothing behind the drawer changes."), **Cancel**,
  primary **Apply** — label "Apply" when the draft equals the applied tree, else
  "Apply · 1,204 documents". Apply sends `pruneTree(draft)` (or `null`) and closes.
- The RAQB builder module is `React.lazy` — downloaded the first time any drawer opens; a 4-row
  Skeleton shows meanwhile.

`ActiveConditions({ text, rules, onEdit, onClear, children? })` — the toolbar read-back:
`role="group" aria-label="Active filters"`, label "Filtered by", optional extra chips (children),
then an accent `FilterChip` with `ApartmentOutlined`: "1 condition: …" / "N conditions: …" (flattened
text, cut at 90 characters with "…"); tooltip shows the full text in a `pre`. Edit reopens the
drawer; × clears the tree. Renders nothing without rules and children.

### 5.12 `AdvancedQueryBuilder` and `queryBuilderConfig`

RAQB `Query` + `Builder` inside `div.nu-query-builder > div.query-builder` (`aria-label="Condition
builder"`), styles from `@react-awesome-query-builder/antd/css/styles.css` re-themed (§2.5).

- **Local ownership while editing**: the incoming `value` is compared with the last emitted JSON and
  only reloads when someone else changed it (saved search, Back, preset). Reloading on the echo made
  "Add rule" appear to do nothing because RAQB discards empty rules on load.
- Duplicate: every non-root rule/group gets a text icon button (`CopyOutlined`, tooltip "Duplicate",
  `aria-label="Duplicate this rule|group"`) absolutely positioned top-right (7 px / 6 px), invisible
  until the row is hovered or focused within; rows reserve 38 px right padding so it never covers
  Delete. Duplicating deep-clones with fresh ids and inserts the copy right after the original.
- Settings: `showNot`, `canReorder`, `canRegroup`, `maxNesting 12`, `maxNumberOfRules 200`,
  `renderSize 'small'`, keep empty/incomplete rules and empty groups on load, value sources
  `['value']` only, field sources `['field']`.
- Labels: add buttons "Rule" / "Group", "Not"; placeholders "Choose a field", "Comparison", "Value";
  field select `aria-label="Field"` (searchable), operator select `aria-label="Comparison"`, every
  value widget `aria-label="Value"`. Library icon buttons get names + tooltips: Add a rule ("One
  condition — a field, a comparison and a value"), Add a group ("A bracket: rules inside it are
  answered together, then combined with the rest"), Add a rule here / Add a group here, Remove this
  rule, Remove this group ("…and everything in it").
- Field kinds → RAQB types: `fulltext`/`keyword` → text, `enum`/`community`/`metadata` → select,
  `number` → number (min/max/step), `datetime` → datetime (value format `YYYY-MM-DDTHH:mm:ss`, the ISO
  "T" Elasticsearch wants), `boolean` → boolean. Select choices show "label · count"; custom values
  allowed except for communities; searchable.
- Operator vocabulary (dropdown = inspector read-back): `=`, `≠`, `is`, `is not`, `<`, `≤`, `>`, `≥`,
  `contains`, `does not contain`, `starts with`, `ends with`, `between`, `not between`, `is one of`,
  `is none of`, `is empty`, `is not empty`, plus three full-text operators added to the text widget:
  `any_words` "has any of the words", `phrase` "has the exact phrase", `query_syntax` "matches query
  syntax". A field offers exactly the operators its evaluator honours.

Document field catalogue (from `GET /explore/fields`, defined server-side in
`app/search/conditions.py`): **Text** (fulltext: contains, does not contain, has any of the words,
has the exact phrase, matches query syntax), **External ID** (keyword: =, ≠, contains, does not
contain, starts with, ends with), **Source** (enum with counts: is, is not, is one of, is none of, is
empty, is not empty, contains, does not contain), **Community** (community with sizes: is, is not, is
one of, is none of, =, ≠, is empty, is not empty), **Clustering run** (number + empty/not empty),
**Length**, **Created**, **Updated**, and one **metadata** field per discovered CSV column (select:
is, is not, is one of, is none of, starts with, is empty, is not empty — exact match only). Field
descriptions become builder tooltips.

### 5.13 Tree helpers (`query/queryTree.ts`) and the browser evaluator (`query/evaluate.ts`)

The JSON tree travels (URL, saved search, request body); RAQB's Immutable state never leaves the
builder. Helpers: `emptyTree`, `starterTree`, `treeFromRules(rules, conj)`, `withRules(tree, rules)`
(appends to an AND root; an OR or negated root is wrapped as a child of a new AND root so its
meaning is kept), `isCompleteRule`, `pruneTree`, `countRules`, `isEmptyTree`, `flattenRules`,
`duplicateNode`, `childMap`/`childrenOf` (accept `children1` as object or array). Ids are
`crypto.randomUUID()` with a fallback.

`matchesTree(tree, record)` mirrors the server compiler: incomplete rules neither match nor exclude,
text is case- and accent-folded (`NFD`, strip diacritics, lower-case), `contains` = every word
present, `has any of` = some word, `phrase` = folded substring, numbers compare numerically, missing
values fail comparisons, depth > 12 is ignored, an empty tree matches everything, `Not` inverts the
group. `describeTreeLocally(tree, labels)` produces the read-back ("Links in view ≥ 8 and (Community
is one of 3, 7)").

### 5.14 `SearchTuningDrawer` — "Ranking options"

400 px Drawer, title "Ranking options", extra "Reset" (`UndoOutlined`, restores `DEFAULT_TUNING`).
Stored in `semantic-leiden.search.tuning.v2`. Changes only how eligible documents are **ordered**;
eligibility lives in the conditions.

- Top toggle: **"Search as you type"** (default on).
- Collapse (all open by default):
  - **Ranking** — hybrid only: **Fusion** segmented `RRF | DBSF` (help: "RRF uses ranks only (robust
    default). DBSF normalises score distributions, so a very strong keyword match can dominate.");
    **"Balance: X% keyword, Y% semantic"** slider 0–1 step 0.05 (alpha, no tooltip, ends labelled
    Keyword / Semantic, `ariaLabelForHandle="Keyword to semantic balance"`). Not keyword: **Minimum
    cosine similarity** number −1…1 step 0.05, placeholder "No floor". Toggle **"Diversify results
    (MMR)"** with help icon; when on, "Relevance weight λ" slider 0–1.
  - **Community routing** — toggle **"Route to the best communities automatically"** + note "Anchor
    documents nearest to the query vote for communities; only the winners are searched. Overrides the
    community filter in the toolbar." When on: **Routing strategy** select (Sum of similarities,
    Softmax vote, Mean similarity, Best anchor, Nearest document (v0.2)); **Anchors** 1–200 and **Top**
    1–10 side by side; softmax only: **Temperature** slider 0.01–1. Always: **"Never search these
    communities"** multi-select (placeholder "None excluded", options `◆ C3 (41)`).
  - **Keyword matching** — hidden in semantic mode: **Query syntax** `Plain | Advanced` (help lists
    `"exact phrase"`, `-exclude`, `a | b`, `prefix*`, `fuzzy~`), **Terms must match** `Any term | All
    terms`, toggle **Typo tolerance** (disabled with Advanced), toggle **Boost exact phrases**.
- Defaults: routing `{strategy:'sum', anchors:20, communities:1, temperature:0.05}`, fusion `{rrf,
  alpha 0.5, rrf_k 60}`, lexical `{plain, or, fuzzy false, phrase_boost true}`, mmr `{off, λ 0.7,
  candidates 50}`, autoRoute off, no exclusions, live search on.
- The toolbar button's badge counts changed groups (`tuningChanges`): auto-route, exclusions, min
  score, MMR, fusion method/alpha, lexical syntax/operator/fuzzy.

### 5.15 `ResultCard`, `ResultText`, `Explain`

`ResultCard` (list and cards views): `<article class="sl-result" aria-label="Result N">`, padding
`12px 14px`, 1 px border, card radius, hover accent border + shadow sm, `content-visibility: auto`
(`contain-intrinsic-size: auto 128px`).

```
 12  ◆ C3  news-0042          fused 0.0164  [both engines]  csv:news.csv  412 chars  2 hours ago
 …the minister announced new «investments» in «railway» stations… … second fragment …
 [👁 Details] [Full text] [⋔ Neighbourhood] [ⓘ Explain]  desk: transport  lang: ro
```

Meta: position (bold tabular), `CommunityKey`, mono external id (ellipsis 220 px), score labelled by
mode (`fused` 4 decimals / `BM25` / `cosine` 3 decimals), gold tag "both engines" when both ranks
exist, source, length, relative update time. Text: highlight fragments joined by a tertiary " … ",
else a 3-row ellipsis paragraph. Actions (text buttons): **Details** (drawer), **Full text** / **Show
matches** toggle (only with highlights, `aria-expanded`), **Neighbourhood** (tooltip "Open the
similarity graph around this document"), **Explain** (ranked only; click popover "Why this result"),
then up to three metadata tags `key: value`.

`Explain` (260 px): two `RankBar`s — "Semantic" (cyan) and "Keyword" (orange): label, 6 px track with
fill width `max(6, 100 − (rank−1)/depth × 100)%` (0 when absent), `#rank` or `none`, and "score x" under
it; then "fused score" (5 decimals) and "MMR position" when present. `depth = max(size × 3, 50)`.

### 5.16 Search insights (`SearchInsights.tsx`)

- `Timings`: `aria-label="Server timings"`, inline 12 px list — embed, route, pre-filter, Qdrant,
  Elasticsearch, fusion, MMR, hydrate, **total** (bold) — each via `fmtMs` (`<1 ms`, `12 ms`,
  `1.23 s`).
- `RoutingCard` "Community vote" (extra tag = strategy): top 6 candidates as `vote-row`s (72 px key,
  track with community-coloured fill = share, selected at full opacity else 0.45, percent), tooltip
  "N anchor(s), best cosine x"; footer "Searched C3, C7". Empty: "No clustered anchors".
- `FacetCard` "Matches by community" (extra: "all matches" = keyword aggregation before the
  community filter, or "candidates" = semantic candidate set, each with an explanatory tooltip):
  first 24 buckets as pressed/unpressed `Chip`s `◆ C3 · 12` toggling the quick filter
  (`aria-label="Community C3, 12 matches[, filtering]"`), the no-community bucket as a plain tag,
  "+N more" / "Show fewer"; "Sources" tags when more than one source.
- `Warnings`: one warning `Alert` per server warning string.

### 5.17 Document drawer (`DocumentDrawerProvider`, `useDocumentDrawer().open(id)`)

One drawer for the whole app, provided inside the shell. Opening from inside it **stacks**; the
header then shows **Back** (`ArrowLeftOutlined`). Close empties the stack. Width 600 px (≥ 768 px) or
100 %; title "Document"; `destroyOnHidden`.

```
┌ Document                                       [← Back] ✕ ┐
│ Full document text, 15 px / 1.6, copy icon                 │
│ [⋔ Show in graph] [⌕ Find similar] [⊛ Community C3] [🗑 Delete] │
│ ┌──────────────┬───────────────────────────────────────┐   │
│ │ External ID  │ news-0042  ⧉                          │   │
│ │ Internal ID  │ 3f1c…  ⧉                               │   │
│ │ Community    │ ◆ C3  [run v5]                         │   │
│ │ Source       │ csv:news.csv                           │   │
│ │ Length       │ 412 characters                         │   │
│ │ Updated      │ 2 hours ago                            │   │
│ │ Metadata     │ [desk: transport] [lang: ro]           │   │
│ └──────────────┴───────────────────────────────────────┘   │
│ Neighbours by engine (h2)                                   │
│ [Semantic] [Keyword] [Graph]                                │
│ Nearest vectors in Qdrant (meaning, cross-lingual).         │
│ ◆ C3 news-0107 score 0.812                                  │
│   two-line excerpt…                              (button)   │
└─────────────────────────────────────────────────────────────┘
```

- Buttons: "Show in graph" (tooltip "Open the similarity graph around this document"), "Find
  similar" (tooltip "Semantic search using this document's text as the query"), "Community C<id>"
  (only when clustered), danger "Delete" behind `Popconfirm` "Delete this document?" / "Removes it
  from Elasticsearch, Qdrant and Neo4j." (ok "Delete", danger) → toast "Document deleted", drawer
  closes, corpus queries invalidated. Any navigation from the drawer closes it.
- Tabs (8 neighbours each, `GET /documents/{id}/similar?method=…&limit=8`): **Semantic** "Nearest
  vectors in Qdrant (meaning, cross-lingual).", **Keyword** "Elasticsearch more-like-this (shared
  distinctive terms).", **Graph** "SIMILAR_TO neighbours stored in Neo4j (what Leiden saw)." Each
  neighbour is a full-width button that stacks the drawer. Empty: compact "No neighbours".

  | Tab | Engine | Server query |
  |---|---|---|
  | Semantic | Qdrant | query-by-id nearest points, hydrated from Elasticsearch |
  | Keyword | Elasticsearch | `more_like_this` on `text` + `text.folded` |
  | Graph | Neo4j | the stored `SIMILAR_TO` neighbours by score |

  Comparing the three tabs is the quickest way to see why a document landed in its community; when
  Semantic and Keyword disagree it is usually a paraphrase or a translation (Semantic shows
  near-copies, Keyword shows verbatim reuse).
- Loading: 8-row Skeleton. Missing: "Document not found" / "It may have been deleted."

### 5.18 `JobProgress({ jobId, onDone? })` — the "Processing" block

Polls `GET /jobs/{id}` every **800 ms** until finished (then refreshes the whole corpus cache once
per job). `aria-live="polite"`.

- A small, non-responsive antd `Steps` (`.phase-steps`) with the phases of the job kind:

  | Kind | Steps (phase key → title) |
  |---|---|
  | import | counting → **Read**, indexing → **Index**, linking → **Link**, leiden → **Cluster**, done → **Done** |
  | rebuild | deleting edges → **Reset**, linking → **Link**, leiden → **Cluster**, done → **Done** |
  | cluster | leiden → **Leiden**, syncing communities → **Sync**, done → **Done** |
  | reconcile | scanning → **Scan**, re-embedding → **Repair**, linking → **Link**, done → **Done** |
  | delete | scanning → **Find**, deleting → **Delete**, leiden → **Cluster**, done → **Done** |

  Aliases map sub-phases onto a coarser step: `syncing communities → leiden`, `deleting edges →
  linking`, `waiting for vector index → linking`. Succeeded = every step complete (`finish`); failed
  = `error`; cancelled = `wait`; otherwise `process`.
- While running: active `Progress` with `aria-label="<Label> progress"`, percent = processed/total
  (0 without a total), text `12,000 / 30,000` or the phase name; then 12 px secondary "Waiting for the
  previous job to finish" (queued) or the phase, plus `: <message>`; then **"Cancel job"** (cooperative
  `DELETE /jobs/{id}`).
- Failed: error Alert "Job failed" + error text. Cancelled: info Alert "Job cancelled".
- `onDone(job)` fires once per job id when it leaves queued/running.
- `jobPercent(job)` for compact indicators = `(stepIndex + processed/total) / (steps − 1)`, 100 when
  succeeded. `JOB_LABELS`: import "Import", rebuild "Rebuild graph", cluster "Clustering", reconcile
  "Reconcile", delete "Delete source".

### 5.19 `GraphCanvas` — canvas + d3-force renderer

Props: `data {nodes, links}`, `hidden` (legend-hidden community keys, `'none'` for no community),
`selectedId`, `paused`, `reducedMotion`, `highlight: Set|null`, `hideUnmatched`, `seeds: Set`,
`centerId`, `palette`, `onSelect(node|null)`, `onOpen(id)`. Imperative handle: `fit()`,
`exportPng()`, `focusNode(id)` (zoom to ≥ 1.8×, centre, select; counts as a user camera move),
`selectNode(id)` (select without moving the camera).

- **Why canvas.** SVG creates one DOM node per circle and line; beyond about 1–2k elements layout and
  paint dominate (v0.2 used SVG and also restarted the simulation on every selection). Canvas draws
  everything in a handful of batched paths per frame. WebGL renderers (sigma.js, cosmos) scale to
  100k+ nodes but are only worth their weight beyond about 5k *visible* nodes, which the server caps
  never reach.
- **Nodes**: radius `min(12, 3.2 + √degree × 1.3)`, fill = community colour; previous positions are
  reused when data changes so the picture does not jump. Node `text` from the graph endpoints is a
  snippet of at most 320 characters (what the tooltip and the selected-node card show; the drawer
  loads the full document).
- **Forces**: link distance `18 + (1 − score) × 140`, strength `max(0.05, score²)`; many-body
  `−42` (distanceMax 320, θ 0.9), or `−18` (180, θ 1.2) above **1,500 nodes**; `forceX/Y(0)` strength
  0.04; collide `radius + 1.5` (1 iteration) only at ≤ 1,500 nodes; alphaDecay 0.0228, or 0.05 when
  large. Drag pins the node (`fx/fy`) and reheats to `alphaTarget 0.25`; release unpins.
- **Zoom**: d3-zoom `scaleExtent [0.05, 8]`, double-click zoom disabled (double-click opens the
  document); initial transform centres the origin.
- **Drawing** (demand-driven: a frame is scheduled only on tick, zoom, hover, selection, legend,
  highlight, theme; selection and highlight never restart the simulation):
  1. edges batched in three paths — normal `link`, context `linkDim`, emphasised `linkFocus` at
     1.6 px (edges touching the hovered/selected node);
  2. nodes batched per colour; with a focus, non-neighbours draw at alpha 0.22; with a highlight,
     non-matching nodes at 0.14 (or are removed entirely with "Hide the rest");
  3. search seeds: a thin 1.2 px ring (`seed`) at radius + 1.6, alpha 0.85 (0.5 while a focus or
     highlight is active);
  4. **the selected node and the neighbourhood centre are marked, not just ringed**: a 25 % `ring`
     halo (body + 9 px), a body of radius `1.5 × r + 2` in `marker` (near-black light / white dark),
     the community colour kept as an inner dot (0.6 r), a 2.5 px `ring` outline, and a bold 12 px label
     with a background-coloured halo;
  5. hover ring (`hover`, 2 px);
  6. labels (11 px Inter, `label` colour) only when zoomed in beyond 1.6× or around a focus, at most
     120, never on dimmed nodes.
- **Fit**: bounds of visible nodes at 90 % of the stage, max 4×. Auto-fit 900 ms after new data
  (50 ms reduced motion) and again when the simulation ends — unless the reader has panned/zoomed.
- **Pointer**: hover sets the hover node and a tooltip (`.graph-tooltip`: 320 px max, raised surface,
  shadow md, 12 px) with community, mono id, "N edges" and the text, clamped inside the stage; click
  selects (background click clears); double-click opens the document drawer. Hit radius is
  `r + 4/k`; hidden nodes are not hittable. Touch works through d3-drag's local coordinates.
- **Canvas element**: `tabIndex 0`, `role="img"`, `aria-label="Semantic graph with N documents and M
  similarity edges. Use the node finder to select a document with the keyboard."`; DPR capped at 2;
  resized by a `ResizeObserver`; cursor grab/grabbing.
- **PNG export**: copies the canvas onto a background-filled canvas and downloads
  `semantic-graph-<ISO timestamp to seconds>.png`.

### 5.20 Highlight rendering (`lib/highlight.tsx`)

Elasticsearch wraps matches in U+0002 / U+0003 instead of HTML. `parseHighlight` splits on the
control characters into `{text, marked}` segments and `Highlighted` renders `<mark>` elements — no
`innerHTML`. Elasticsearch trims fragments with Java's `String.trim()`, which strips a leading U+0002:
a closing marker before any opening one therefore means "the fragment starts inside a match". An
unterminated opening marker marks the rest.

### 5.21 Formatting (`lib/format.ts`)

`fmtInt` (en-US grouping, `—` for null), `fmtScore(n, digits=3)`, `fmtMs` (`<1 ms`, `N ms`, `N.NN s`
below 10 s, `N.N s` above), `fmtBytes` (B/KB/MB/GB, 1 decimal), `fmtRelative` (seconds → days via
`Intl.RelativeTimeFormat`), `shortId`.

---

## 6. Pages

Every page is `div.nu-page` (flex column, gap 12) = `PageHeader` → controls → content → `PageDoc`.

### 6.1 Dashboard — `/` (`OverviewPage.tsx`)

Visual reference: Nucleus `pages/DashboardPage.tsx`.

```
Dashboard                                                        [⟳ Refresh] [⇩ Import data]
all-MiniLM-L6-v2 · k = 12, similarity ≥ 0.58 · Leiden γ = 1
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ ⚠ Needs attention  (Stores disagree on the document count) (1,204 documents not clustered yet) │  alert strip (only if any)
└─────────────────────────────────────────────────────────────────────────────────────────────┘
[DOCUMENTS 72] [SIMILARITY EDGES 410] [COMMUNITIES 4] [NOT CLUSTERED YET 0]                  nu-kpis--8
[IN NO COMMUNITY 3] [MODULARITY 0.612] [MEAN DEGREE 11.39] [DATA SOURCES 1]                  (8 in one row ≥ 1800 px)
┌ Community sizes ─────────────────────────── span 8 ┐┌ Documents by source ── span 4 ┐
│ bars C3 C1 C7 … (40 largest, community colours)     ││ donut + legend                 │   h 280
└─────────────────────────────────────────────────────┘└────────────────────────────────┘
┌ Clustering history ─────────── span 6 ┐┌ Community quality ──────────── span 6 ┐           h 260
└───────────────────────────────────────┘└────────────────────────────────────────┘
┌ Document length ─ span 4 ┐┌ Documents added over time ─ span 4 ┐┌ Store consistency ─ span 4 ┐ h 240/240/214
└──────────────────────────┘└────────────────────────────────────┘└────────────────────────────┘
┌ ⋔ Recent jobs ─────────────────────────────────────────────────────────────────── All jobs ┐
│ ● Import  succeeded  30,000 created, 0 updated, 0 failed                                     │  antd Timeline, 8 newest
│   2 hours ago · sample.csv                                                                   │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
WHAT Corpus health at a glance  FLOW Stats → KPIs → drill-down  TECH ECharts, Elasticsearch, Neo4j …
```

**Header.** Title "Dashboard". Subtitle: `<model basename> · k = <neighbor_k>, similarity ≥
<min_similarity> · Leiden γ = <config.leiden_gamma>`; while loading "Loading the corpus overview…".
Actions: **Refresh** (`ReloadOutlined`, loading while refetching, tooltip "Numbers from <relative
time>") invalidates every corpus query; primary **Import data** → `/import`.

**Data.** `GET /stats` (polled 3 s while a job runs, else 30 s), `/config`, `/communities`,
`/cluster/runs?limit=50`, `POST /explore/insights {}` (corpus-wide distributions), `/sources`,
`/jobs`.

**Alert strip** (`Card.nu-alert-strip`, only when at least one alert): `AlertOutlined` in warning
ink, bold "Needs attention", then clickable tags (`role="button"`, `tabIndex 0`, Enter/Space), each
with a tooltip:

| Condition | Tag colour and text | Goes to | Tooltip |
|---|---|---|---|
| stores inconsistent and no job running | error "Stores disagree on the document count" | `/operations` | "Run Reconcile to repair Qdrant and Neo4j from Elasticsearch." |
| unclustered > 0 | warning "N documents not clustered yet" | `/operations` | "Documents added or changed since the last Leiden run. Run clustering to assign communities." |
| documents > 0 and no run | warning "Clustering has never run" | `/operations` | "Run Leiden under Operations." |
| a job is active | processing "<Label> queued\|running" | `/import` or `/operations` | "Open to follow its progress." |

**KPI tiles** (all clickable):

| Label | Icon / accent | Value | Hint | Click |
|---|---|---|---|---|
| Documents | FileText / accent | documents | "<ES store size> in Elasticsearch" | `/documents` |
| Similarity edges | NodeIndex / info | edges | "k = 12, cosine ≥ 0.58" | `/graph` |
| Communities | Cluster / success | communities | "Groups of 2 or more documents, found by weighted Leiden" | `/communities` |
| Not clustered yet | QuestionCircle / warning if > 0 else neutral | unclustered | "Added or changed since the last clustering run" | Explore, `community_version is empty` |
| In no community | Disconnect / neutral | outside_communities | "Too loosely linked; N have no neighbour" | Explore, clustered AND no community |
| Modularity | Trophy / accent | last run modularity (3 dp) or `—` | "Run v5, 2 hours ago" / "No clustering run yet" | `/operations` |
| Mean degree | Branches / info | 2 dp | "Average similarity edges per document" | `/graph` |
| Data sources | Database / neutral | number of sources | "Import labels, e.g. csv:news.csv" | `/operations` |

**Charts** (`ChartCard`s in `.nu-chart-grid`, 12 columns):

| Id | Title | Span / height | Shape and data | Description | Click |
|---|---|---|---|---|---|
| `community-sizes` | Community sizes | 8 / 280 | bars `C<id>` × size, 40 largest, community colours | "The 40 largest communities; click a bar to open it." (empty: "No communities yet" / "Run clustering under Operations.") | `/communities?selected=` |
| `documents-by-source` | Documents by source | 4 / 280 | donut, SERIES colours, "(no source)" for null | — | Explore filtered by source |
| `clustering-history` | Clustering history | 6 / 260 | line modularity + bars communities per `v<version>` (oldest → newest) | "Modularity (line) and community count (bars) per Leiden run." (table adds γ and duration) | — |
| `community-quality` | Community quality | 6 / 260 | scatter cohesion × conductance, bubble = size | "Cohesion (higher is tighter) against conductance (lower is better separated); bubble size is the community size." | `/communities?selected=` |
| `document-length` | Document length | 4 / 240 | bars per length bucket | "Characters per document; click a bar to list those documents." | Explore with length rule |
| `documents-over-time` | Documents added over time | 4 / 240 | bars per timeline bucket, cyan; labels are dates, or date + time for `s/m/h` intervals | — | — |
| `store-consistency` | Store consistency | 4 / 214 | horizontal bars Elasticsearch (documents), Qdrant (vectors), Neo4j (nodes) in SERIES 3/4/1 | success text "All three stores agree." or warning "The stores disagree — reconcile under Operations." | — |

**Recent jobs** card (`ApartmentOutlined` "Recent jobs", extra text button "All jobs" → `/operations`):
antd `Timeline` of the 8 newest jobs, dot colour = status colour; each item: bold label, a borderless
tag with the status in its colour, a secondary one-line outcome — import "N created, N updated, N
failed", cluster "N communities, modularity 0.612", rebuild "N edges", reconcile "N repaired, N
orphans removed", delete "N documents deleted from <source>", failed → error text, cancelled →
"cancelled", running → phase — and a tertiary 11.5 px line: relative time (tooltip absolute) and
" · <filename>" when present. Loading: 4-row Skeleton; empty: compact "No jobs have run in this API
process yet".

**States.** Empty corpus (`documents === 0`): tiles and charts are replaced by one card with
`EmptyState` "The corpus is empty" / "Import a CSV with an id and a text column; the dashboard fills
in as soon as it is indexed." / primary "Import a CSV" (`ImportOutlined` icon); the alert strip and
Recent jobs still show. Tiles show skeleton numbers while `/stats` loads; charts show card loading.

**Footer** (`PAGE_DOCS.overview`):

| Key | Short | On hover |
|---|---|---|
| What | Corpus health at a glance | Counts, clustering quality and distributions of the whole corpus on one screen. |
| Flow | Stats → KPIs → drill-down | GET /stats, /communities, /cluster/runs and /explore/insights feed the tiles and charts; every tile links to the view behind it. |
| Tech | ECharts, Elasticsearch, Neo4j | ECharts (core build) themed from the same design tokens as AntD; numbers come from Elasticsearch aggregations and Neo4j. |
| Why | Spot problems early | Unclustered documents, inconsistent stores or a weak modularity are visible before anyone searches. |
| How | Click any tile or bar | Tiles and chart bars are clickable and open the documents, communities or graph they summarise. |

### 6.2 Explore documents — `/documents` (`ExplorePage.tsx`)

Visual reference: Nucleus `pages/DataExplorerPage.tsx` + `components/explorer/*`. Search lives here
(the old `/search` and `/explore` redirect).

```
Explore documents [1,234 matches]                             [📂 Saved (2)] [💾 Save search] [⇩ Export ▾]
Browse every document, or rank them by keyword, meaning or both, and narrow any view with conditions.
┌ nu-explorer-controls ──────────────────────────────────────────────────────────────────────────────┐
│ [Browse|Hybrid|Semantic|Keyword] [⌕ Search by meaning or words, in any language          /] [⧩ Advanced²] [⚟ Ranking¹] │
│ [All communities        ▾]  Try (⌕ railway investments in Romania) (⌕ patch for an authentication flaw)│
│                                 (⌕ căi ferate) (⌕ kafka consumer lag)  or press / to search         │
│   — or, once filtered —  Filtered by (⋔ 2 conditions: Length ≥ 500 AND Source is csv:… ×)  [⌫ Clear all] │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ ⌗ What these documents add up to                                                     (◉) Insights ┐
│ [MATCHING DOCUMENTS 1,234] [COMMUNITIES 4] [NO COMMUNITY 12] [AVERAGE LENGTH 412 chars]            │
│ ┌ Matches by community ───────────────── span 8 ┐┌ Length (characters) ─ span 4 ┐   h 200          │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ ☰ Documents  sorted by updated at ↓ · 12 ms                                   [▦ Table|☰ List|▣ Cards] ┐
│   # │ Document                                 │ Community │ Source      │ Length │ Updated   │ Metadata │ 👁 ⋔ │
│   1 │ two-line text with «highlights»…         │ ◆ C3      │ csv:news.csv│    412 │ 2 h ago   │ desk: x  │      │
│     │ news-0042 (mono, 12 px)                  │           │             │        │           │          │      │
│                                            1–25 of 1,234   ‹ 1 2 3 … 50 ›   25 / page ▾                       │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
WHAT Search and filter documents  FLOW Query → ES + Qdrant → fuse  TECH Elasticsearch, Qdrant, RAQB …
```

**Two engines, one page.** *Browse* is an exact Elasticsearch question (`POST /explore/query`): true
totals, any sort, numbered pages. *Hybrid / Semantic / Keyword* rank the top matches (`POST /search`):
BM25, Qdrant vectors, or both fused; the same condition tree becomes the Elasticsearch filter or the
Qdrant pre-filter. The page always says which one answered (tag wording, results title, insights).

**Header.** Title "Explore documents". Tag (when data): browse "1,234 matches" (`+` when the total
is a lower bound, singular "match"); ranked "1,234 keyword matches" (`+` at ≥ 10,000) or "N ranked"
when no lexical total. Subtitle "Browse every document, or rank them by keyword, meaning or both, and
narrow any view with conditions." Actions: `SavedSearchButtons` (summary like `“railway” · hybrid
ranking · communities C3 · 2 conditions`; disabled with no q, rules or communities) and **Export**
dropdown (disabled with no rows): "Results on screen as CSV", "Results on screen as JSON", and when
browsing "Every match as CSV (up to 5,000)" (pages of 200 with a "Collecting matches…" loading
toast). Files `documents-<YYYY-MM-DDTHHMMSS>.csv|json`, columns `id, external_id, text, community_id,
source, length, updated_at, score, metadata` (metadata as JSON). Toast "Exported N documents".

**Toolbar row 1** (grid `auto | minmax(280px,1fr) | auto`; one column ≤ 1100 px):

- Mode `Segmented`: **Browse**, **Hybrid**, **Semantic**, **Keyword**, each label in a tooltip:
  Browse "Exact Elasticsearch filter: every match, true totals, any sort, numbered pages"; Hybrid
  "Qdrant and Elasticsearch in parallel, fused with RRF or DBSF. Ranks the top matches."; Semantic
  "Dense vectors in Qdrant: meaning, paraphrases, other languages. Ranks the top matches."; Keyword
  "BM25 in Elasticsearch: exact names, codes, rare terms. Ranks the top matches." Changing mode resets
  page, sort and order; choosing the implied default removes `mode`.
- `SearchBox` (scope `explore`). Placeholder says what typing will do: explicit Browse → "Filter by
  words or id — every match, exact count"; with a query → "Search by <mode> relevance — any
  language"; otherwise "Search by meaning or words, in any language".
- **Advanced** (`FilterOutlined`, badge = rule count) opens the conditions drawer; **Ranking**
  (`SlidersOutlined`, badge = changed tuning groups; tooltip "Fusion, routing, diversity and keyword
  matching" when ranked, else "Ranking options apply to Keyword, Semantic and Hybrid") opens
  `SearchTuningDrawer` (in Browse it is configured as hybrid).

**Toolbar row 2** (`.nu-explorer-subbar`):

- Community quick filter: multi-select 240 px, placeholder "All communities", options `◆ C3 · 41`,
  searchable by `C3`, `maxTagCount="responsive"`, `aria-label="Community filter"`; disabled while
  automatic routing is on and ranking (tooltip "Automatic routing chooses communities; turn it off
  under Ranking to pick them", else "Only documents of these communities").
- Then exactly one of: `ActiveConditions` for the applied tree; an empty spacer when only q/communities
  are set (each filter is shown once, by its own control); or, with nothing asked, "Try" + four example
  chips (`railway investments in Romania`, `patch for an authentication flaw`, `căi ferate`, `kafka
  consumer lag` — a click sets `q` and `mode=hybrid`, push) + "or press `/` to search".
- **Clear all** (`ClearOutlined`) when anything is set: clears q, tree, communities, page, sort,
  order, mode (push).

**Search box ↔ URL.** The box keeps its own draft. Live search (when "Search as you type" is on)
writes `q` 350 ms after typing stops, only for ≥ 3 characters or an empty box, and reacts **only to
typing** — a query set from an example, the history or a link is never cleared by the stale debounced
box. The URL is copied into the box only when it changed for another reason, and trimmed-equal values
are left alone (so a space typed between two words is not deleted). Enter submits immediately (push).
`/` (outside inputs) or **Ctrl/⌘ + K** focuses the box from anywhere on the page.

**Requests.**

- Browse: `POST /explore/query {query_text: q, condition_tree: tree ∧ communities, sort, order, page,
  page_size: size, facets: false, highlight: !!q}`, `keepPreviousData`.
- Ranked: `POST /search` built by `buildSearchRequest(q, mode, tuning, {topK: size, communities, conditionTree:
  tree})`: scope `auto` (auto-route) / `communities` / `global` with exclusions; `top_k` 1–200;
  `min_score` ignored for keyword; routing, fusion, lexical, MMR from tuning; `filters.condition_tree`;
  `highlight`, `facets`, `explain` all true. Debounced 200 ms; stale 60 s.
- Insights (browse only, when the Insights switch is on): `POST /explore/insights {query_text,
  condition_tree}`.
- Field catalogue: `GET /explore/fields` (stale 60 s) → builder fields and presets.
- `?record=<id>` opens that document's drawer once and removes the parameter.

**Insights card** (collapsible body; switch "Insights" in the card extra, `aria-label="Show insights"`,
state in `semantic-leiden.explore.insights`, default on). Title "What these documents add up to"
(browse) or "How the engines answered" (ranked), `NodeIndexOutlined`.

- Browse: `nu-kpis--4` — **Matching documents**; **Communities** (info, "Distinct Leiden communities
  among the matches"); **No community** (warning if > 0, hint "N not clustered yet · N too loosely
  linked", clickable → adds `community_id is empty`); **Average length** ("412 chars", hint "min–max
  characters"). Then two charts (height 200): `explore-communities` "Matches by community" span 8 (bars
  per community incl. "No community" in grey; "Click a bar to keep only that community."; click
  toggles the quick filter, or adds `community_id is empty` for No community) and `explore-length`
  "Length (characters)" span 4 (click adds a length rule).
- Ranked: `Timings`, `Warnings`, then (auto-fit 300 px grid) `RoutingCard` (when routing ran) and
  `FacetCard` (toggles the quick filter). Skeleton until the first answer.

**Results card** (`.nu-explorer-results`, body padding 0). Title: `BarsOutlined` + "Documents" (browse)
with "sorted by <field> ↑|↓ · <took> ms" (relevance for `_score`), or "Top N by <mode> relevance"
(ranked); "Updating…" while fetching. Extra: view `Segmented` **Table / List / Cards** (default Table,
List below 768 px; choosing the default removes `view`).

- **Table** (`size="middle"`, `scroll.x 900`, fades to 0.65 opacity while settling). Columns: `#`
  (56 px, right-aligned, bold tabular position); **Document** (`sl-cell-text` 280–760 px: highlights
  or 2-line text, then mono external id 12 px); **Community** (130, sortable in browse); **Source**
  (170, ellipsis, ≥ lg, sortable in browse); ranked → **Score** (120; header tooltip "Click a score to
  see which engine ranked the document where"; a text button with `InfoCircleOutlined` + score opens
  the Explain popover); browse → **Length** (100, right, ≥ md, sortable) and **Updated** (130, ≥ md,
  sortable, relative with absolute tooltip); **Metadata** (200, ≥ xl, three `key: value` tags);
  actions (92, fixed right, header visually hidden "Actions"): eye icon (tooltip "Open this document",
  `aria-label="Open <id>"`) and graph icon (tooltip "Show its neighbourhood in the graph",
  `aria-label="Show <id> in the graph"`). Rows are focusable (`tabIndex 0`), click or Enter opens the
  drawer. Browse pagination: page sizes 10/25/50/100/200, "1–25 of 1,234", total capped at 10,000;
  sort changes write `sort`/`order` and reset `page`; removing a sort removes both. Ranked: no
  pagination.
- **List / Cards**: `ResultCard`s in `.sl-results` (gap 10, padding `12px 16px 16px`); cards view is an
  auto-fill grid of 360 px min columns. Browse shows "Previous · Page X of Y · Next" below when there is
  more than one page.
- Ranked footer: "N ranked results · 1,234 keyword matches" and **"Show 25 more"** (while `size < 200`
  and a full page came back) — ranked lists grow instead of paging.

**States.** Loading: 8-row Skeleton. Error: Alert — info for HTTP 409, else error; message "Clustering
has not run yet" (code `not_clustered`, with action "Go to operations") or "This question could not
be run", description = API message. Empty corpus: "The corpus is empty" / "Import a CSV with an id and
a text column to start exploring." / primary "Import a CSV". No match: `NoResults` with "Clear the
question" (clears everything).

**Advanced conditions drawer.** Noun "documents"; engine "Elasticsearch — the same tree filters
keyword search and pre-filters semantic search"; extra help "N fields available, including metadata
columns from your CSVs." (or danger "The field catalogue could not be loaded."). Preview =
`POST /explore/query` with `page_size 1`, the draft ∧ quick communities, and the box text when browsing.
Presets: **Not clustered yet** ("Added or changed since the last Leiden run"), **In no community**
("Clustered, but too loosely linked to join a community of two or more"), **Long documents** (≥ 500;
"At least 500 characters"), **Short documents** (< 80; "Under 80 characters"), **Changed in the last
day** (`updated_at >` now − 24 h), **From <largest source>** (when sources exist), **Mentions A or B,
not C** (Text has any of "railway train" AND Text does not contain "football"; "An example to edit:
any of two words, and not a third"). Apply writes `tree` (push) and resets `page`.

**Footer** (`PAGE_DOCS.explore`):

| Key | Short | On hover |
|---|---|---|
| What | Search and filter documents | Browse every document, or rank them by keyword (BM25), semantic (vectors) or hybrid relevance. |
| Flow | Query → ES + Qdrant → fuse | Conditions compile to an Elasticsearch bool query; in semantic mode they pre-filter Qdrant by id; hybrid fuses both lists with RRF or DBSF. |
| Tech | Elasticsearch, Qdrant, RAQB | react-awesome-query-builder edits the condition tree; Elasticsearch runs filters and BM25; Qdrant runs HNSW vector search. |
| Why | Precise, explainable retrieval | Every result says which engine found it and which Leiden community it belongs to. |
| How | Type, refine, open | Type a query, pick how to match, add conditions under Advanced, click a row to open the document. |

### 6.3 Similarity graph — `/graph` (`GraphPage.tsx`)

Two questions, two mechanisms: **what to draw** is a server question (four sources); **what to look
at** is a browser question (highlight conditions over the nodes on screen, instant, nothing
re-fetched).

```
Similarity graph [412 documents · 1,000 edges]                               [📂 Saved] [💾 Save search]
How documents link by similarity; colour is the Leiden community. Choose what to draw, then highlight what matters.
┌ controls ─────────────────────────────────────────────────────────────────────────────────────────┐
│ [⇆ Strongest links|⊛ Communities|◎ Neighbourhood|⌕ Search results] [1,000 edges ▾] Similarity 0.00–1.00 ○━━━○ │
│ [✎ Highlight¹] [Dim the rest|Hide the rest]  Filtered by (⋔ 1 condition: Links in view ≥ 8 ×)   [Find a document in view ▾] │
└─────────────────────────────────────────────────────────────────────────────────────────────────────┘
┌ ⋔ Strongest links  412 documents, 1,000 edges · 37 highlighted        [? How to use] [⤢] [❚❚] [📷] ┐
│ ┌ selected node card (360) ┐                                                          (spinner) │
│ │ ◆ C3  news-0042     Close│         · ·  ●──●   canvas on a 40 px grid                        │
│ │ text, 4 lines…           │       ●──◉══●   ◉ = selected/centre: halo + dark body + inner dot │
│ │ 9 links in view · strongest 0.912 │  ·    ●                                                  │
│ │ [👁 Details] [◎ Neighbourhood] [✎ C3] [⑂ Similar] │                                          │
│ └──────────────────────────┘                                                                   │
│ (◆ C3 142) (◆ C1 98) (◆ C7 77) (◆ No community 12)   ← legend chips, toggle visibility          │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
WHAT See similarity neighbourhoods  FLOW Neo4j edges → d3 layout  TECH Neo4j, d3-force, Canvas …
```

**Header.** Title "Similarity graph"; tag "N documents · M edges"; subtitle "How documents link by
similarity; colour is the Leiden community. Choose what to draw, then highlight what matters."; actions
`SavedSearchButtons` (summary e.g. "Search results · “vaccine” · 2 highlight rules"; disabled on the
default view without highlight rules).

**What to draw** — view `Segmented` (push; clears the selection). Icons + labels; on phones
(< 576 px) icons only, with "Label: hint" tooltips:

| View | Label / icon | Hint | Controls | Request |
|---|---|---|---|---|
| `top` | Strongest links / `ShareAltOutlined` | "The highest-similarity edges of the whole graph" | edge count: select (250 … 5,000 "edges" + **Custom…**, `aria-label="Edge limit"`) and, for Custom, a number box, similarity band | `GET /graph?limit&min_score&max_score` |
| `communities` | Communities / `ClusterOutlined` | "Only edges inside the communities you choose" | multi-select "Choose communities" (`aria-label="Communities to draw"`), edge limit, similarity band | `GET /graph?limit&min_score&max_score&community_id=…` |
| `focus` | Neighbourhood / `AimOutlined` | "One document and its neighbours, 1 or 2 hops out" | searchable document picker "Find a document by words or id" (`aria-label="Document at the centre"`; options "`<external_id> — <first 80 chars>`"; 20 results of `POST /explore/query` by relevance or newest, debounced 300 ms; the current centre is always included), `1 hop \| 2 hops`, similarity band | `GET /graph/ego/{id}?hops&node_limit=min(limit,1000)&min_score&max_score` |
| `query` | Search results / `SearchOutlined` | "The documents a search or conditions return, and how they link" | `SearchBox` (scope `graph`, placeholder "Search, then see how the results connect"), mode `Hybrid\|Semantic\|Keyword`, **Conditions** button (badge; opens "Which documents to draw"), seed-count select ("150 documents", `aria-label="How many matching documents to draw"`), switch **Neighbours** (tooltip "Also draw the strongest neighbours of the results, so bridges to other topics appear"), similarity band | `POST /graph/query {query, mode, condition_tree, limit: seeds, expand, neighbor_limit: 300, min_score, max_score}` |

Edge count control (`EdgeLimit`, top and communities views): a `Space.Compact` of the select
(`aria-label="Edge limit"`; "250 edges" … "5,000 edges" and **Custom…**) and, for Custom, an
`InputNumber` (`aria-label="Number of edges to draw"`, 128 px, suffix "edges", thousands separators,
min 1, max 10,000, step 100). Choosing Custom… moves focus into the box (after the dropdown closes)
and selects its value. The number applies on Enter, on blur, or 700 ms after typing stops — never per
keystroke; it is clamped to 1–10,000 (the API ceiling). Above 5,000 the box turns to the warning style
and its tooltip says "1 to 10,000 edges, strongest first. Above 5,000 the layout takes a few seconds."
Measured: 10,000 edges (1,934 nodes) fetched and drawn in about 1.2–1.5 s. A `?limit=` that is not a
preset (for example 777) reopens as Custom… with that number; choosing a preset hides the box; 1000
is the default and is removed from the URL.

Similarity band control: label "Similarity 0.80–0.90" (12 px, secondary) + a two-handle range
slider 0–1 step 0.01 in a 300 px row; handles named "Minimum edge similarity" and "Maximum edge
similarity" (`ariaLabelForHandle`); tooltip "Draw only edges whose cosine similarity is inside this
band. Raise the minimum to keep strong links; lower the maximum to hide near-duplicates and see the
weaker links between topics. Edges exist from 0.75, the graph's build threshold." (the threshold is
`policy.min_similarity` from `/config`). The handles stop one step apart and never cross
(rc-slider `allowCross: false`, `pushable: 0.01`). The slider moves from local state mirrored to
`?min=`/`?max=` (default values are removed from the URL), so a held arrow key never drops steps;
requests are debounced 250 ms. A non-default band is added to the card's status line
("similarity 0.80–0.90"), and the How-to-use popover adds "The similarity band keeps edges between
its two handles". Graph queries: `keepPreviousData`, stale 30 s, no
retry.

**What to look at** — second row: **Highlight** (`HighlightOutlined`, badge = rules, disabled with no
nodes) opens the drawer "Highlight nodes"; `Dim the rest | Hide the rest` (disabled without rules,
writes `hlmode`); `ActiveConditions` for the highlight (clear removes `hl` and `hlmode`), plus, in the
query view, a `FilterChip` "N document conditions" (edit reopens the documents drawer, × removes
`tree`); flexible spacer; node finder select "Find a document in view" (300 px ≥ md, 200 px below;
options "`<external_id>  <first 70 chars>`"; `aria-label="Find a document in the graph"`) — picking one
zooms to it and selects it (the keyboard path into the canvas).

Highlight fields (computed from the drawn graph): **Text** (contains, does not contain, has any of the
words, has the exact phrase), **External ID** (=, ≠, contains, does not contain, starts with, ends with),
**Community** (choices = communities in view with node counts; is, is not, is one of, is none of, is
empty, is not empty), **Links in view** (degree among drawn edges; "How many edges the node has among
the drawn ones"), **Link strength in view** (sum of drawn edge scores, step 0.1), **Strongest link**
(−1…1, step 0.01), and with search results **Returned by the search** (boolean) and **Search rank**.
Presets: "Hubs (8+ links)", "Loosely attached" (≤ 1 link), "Near-duplicates" (strongest link ≥ 0.95),
"In no community", "Search results only" (with seeds), "Community C<largest in view>". Engine "your
browser, over the nodes on screen — nothing is re-fetched"; preview count = matching nodes (all nodes
when empty); read-back via `describeTreeLocally`.

Documents drawer ("Which documents to draw"): catalogue fields as on Explore, engine "Elasticsearch,
before ranking — the same fields as Explore", preview `POST /explore/query` count, presets "Not
clustered yet" and "Long documents"; Apply writes `tree` **and switches to** `view=query`.

**Graph card** (`.sl-graph-card`, min-height 480, grows to fill the page). Title: view icon/label +
"N documents, M edges" + " around the selected document (1 hop|2 hops)" (focus) + " · S results of M
matching" (query) + " · H highlighted". Extra (text buttons): **How to use** (`QuestionCircleOutlined`,
click popover "Using the graph": "**Drag** the background to pan, a node to move it", "**Scroll** or
pinch to zoom", "**Click** a node to select it and see its links", "**Double-click** a node to open the
document", "Legend chips hide or show a community"), **Fit** (`ExpandOutlined`, "Fit to view"),
**Pause/Resume layout** (`PauseOutlined`/`CaretRightOutlined`), **Export as PNG** (`CameraOutlined`); each
icon button has an `aria-label` ("Fit the graph to the view", "Pause the layout", "Export the graph as
PNG").

Stage overlays (`.graph-overlay`): spinner top-right while fetching; **legend** bottom (left/right 12 px)
— `role="group" aria-label="Communities (toggle visibility)"`, pill buttons `◆ C3 142` sorted by node
count, `aria-pressed`, hidden ones at 0.4 opacity, max-height 96 px scrolling; **selected-node card**
top-left (360 px ≥ md, else full width − 24): title `CommunityKey` + mono id, extra "Close"
(`aria-label="Clear the selection"`), 4-line text, "N links in view · strongest 0.912 · search rank
R", buttons primary **Details** (drawer), **Neighbourhood** (focus view on this node, push), **C<id>**
(tooltip "Highlight every node of this community"; writes `hl`), **Similar** (tooltip "Semantic search
with this document's text"; Explore semantic with the first 300 characters).

**Arrival at a neighbourhood** ("Show in graph", "Neighbourhood", `?focus=`) selects the centre node
once it is in the data: it is marked (§5.19 step 4), its links emphasised and its card opened, without
moving the camera.

**Empty states** in the stage (when not fetching): communities view without a choice — "Choose one or
more communities" / "Their internal edges will be drawn."; focus without a centre — "Pick a document" /
"Its neighbours, one or two hops out, will be drawn."; query without q or conditions — "Search, or add
conditions" / "The matching documents and the links between them will be drawn."; otherwise "No edges
match" / "No edge falls inside the similarity band: widen it, widen the question, or import documents." (band set) — or, when the band's maximum is below the build threshold, "The graph only stores edges with similarity ≥ 0.75 (its build threshold). Raise the maximum, or rebuild the graph with a lower threshold on Operations." — or "Widen the question, or import documents." (full band) Errors: Alert "Could
not load the graph"; server warnings as warning Alerts.

**Footer** (`PAGE_DOCS.graph`):

| Key | Short | On hover |
|---|---|---|
| What | See similarity neighbourhoods | The k-nearest-neighbour similarity graph Leiden clusters; colour is the community. |
| Flow | Neo4j edges → d3 layout | Edges come from Neo4j (strongest links, communities, a neighbourhood or the documents a search returns); d3-force lays them out on a canvas. |
| Tech | Neo4j, d3-force, Canvas | Canvas + d3-force keep thousands of nodes interactive; highlight conditions are evaluated in the browser. |
| Why | See how topics connect | Bridges between communities and isolated documents are findings a table cannot show. |
| How | Choose source, highlight, drag | Pick what to draw, highlight nodes with conditions, click a node for details, double-click to open it. |

### 6.4 Communities — `/communities` (`CommunitiesPage.tsx`)

Two kinds of search: **topic search** asks the corpus "which communities discuss this?" (a search with
automatic routing: anchors vote in Qdrant, ranked hits are counted per community); **metric conditions**
ask the table ("cohesion ≥ 0.8 and conductance < 0.2"), evaluated in the browser.

```
Communities [4 communities]                                                  [📂 Saved] [💾 Save search]
Topic clusters found by Leiden on the similarity graph, with quality metrics from graph structure alone.
┌ controls ───────────────────────────────────────────────────────────────────────────────────────┐
│ [Hybrid|Semantic|Keyword] [⌕ Which communities discuss… (any language) — or type C12 to jump  /] [⧩ Metric conditions] │
│ Try (⌕ railway infrastructure) (⌕ ransomware) (⌕ interest rates) (⌕ fotbal) (⧩ Tight, well separated) (⧩ Bridges) │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
[COMMUNITIES 4] [LARGEST 31] [MEDIAN SIZE 17] [MEAN COHESION 0.742] [MEAN CONDUCTANCE 0.118] [MODULARITY 0.612]
┌ Sizes ─────────────── span 6 (4 with topic) ┐┌ Cohesion vs conductance ─ span 6 (4) ┐┌ Vote for “…” ─ span 4 ┐
└─────────────────────────────────────────────┘└──────────────────────────────────────┘└───────────────────────┘
┌ ⊛ All communities  click a row for its central documents and neighbours ─────────────────────────┐
│ ▸ │ Community │ Size          │ Cohesion │ Density │ Conductance │ Internal edges │ Boundary edges │
│ ▾ │ ◆ C3      │ 31 ▰▰▰▰▰▱     │ 0.781    │ 0.412   │ [0.104]     │ 198            │ 23             │
│   ┌ ◆ Community C3                                   [⌕ Explore its documents] [⋔ Show in graph] ┐│
│   │ 31 documents · cohesion 0.781 · conductance 0.104                                             ││
│   │ ─────────────────────────────────────────────────────────────────────────────────────────── ││
│   │ Most central documents              │ Neighbouring communities                               ││
│   │ Ranked by summed similarity…        │ Connected by boundary edges. Strong bridges suggest…   ││
│   │ ① text, two lines…                  │ COMMUNITY   SHARED EDGES          AVG. SIMILARITY      ││
│   │   news-0042 · 11 links · strength 9.12 │ ◆ C7     ▰▰▰▰▰▰▱▱  14         0.642               ││
│   └───────────────────────────────────────────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
WHAT Inspect Leiden topic clusters  FLOW Graph metrics → table, charts  TECH Neo4j GDS Leiden …
```

**Header.** Title "Communities"; tag "N communities" or "X of N" when filtered; subtitle "Topic clusters
found by Leiden on the similarity graph, with quality metrics from graph structure alone."; actions
`SavedSearchButtons` (summary e.g. `topic “ransomware” · 2 metric conditions`, else "All communities",
disabled without a question).

**Toolbar.** Mode `Segmented` Hybrid/Semantic/Keyword (tooltip = mode hint + ". Anchors always vote
semantically."); `SearchBox` (scope `communities`, placeholder "Which communities discuss… (any
language) — or type C12 to jump"); **Metric conditions** (`FilterOutlined`, badge). Second row:
`ActiveConditions` (metric tree), or an empty spacer when only `q` is set, or "Try" + example chips
`railway infrastructure`, `ransomware`, `interest rates`, `fotbal` + the first two presets as chips;
**Clear all** (clears q, tree, selected; push). Submitting a query clears `selected`.

**Topic search.** `q` matching `/^\s*c?(\d+)\s*$/i` is a **jump**: the table shows only that
community. Anything else is a topic: `POST /search {query, mode, top_k: 100, scope: auto, routing:
{sum, anchors: 100, communities: 10, temperature 0.05}, fusion rrf/0.5/60, lexical plain/or,
mmr off, highlight false, facets true, explain false}`, debounced 250 ms. Each row gets
`topic_share` (anchor vote %, 1 dp), `topic_hits` (how many of the top 100 results fall in it),
`topic_matches` (facet count) and `best_score`. With a topic the table keeps only communities with a
vote or a hit, ordered by vote share then hits. Error: Alert "The topic search failed".

**Metric conditions** (browser): fields **Community** (is / is not / is one of / is none of), **Size
(documents)**, **Cohesion** ("Mean similarity of edges inside the community. Higher is a tighter
topic."), **Density** ("Internal edges divided by all possible pairs"), **Conductance** ("Share of edge
weight leaving the community. 0 is perfectly separated."), **Internal edges**, **Boundary edges**, and
with a topic **Topic vote (%)** and **Topic results**; numeric operators =, ≠, <, ≤, >, ≥, between, not
between. Presets: **Tight, well separated** (cohesion ≥ 0.75 AND conductance ≤ 0.2; "High cohesion and
low conductance: clean topics"), **Bridges** (conductance ≥ 0.4; "Much of their weight leaves the
community"), **Large (200+)**, **Tiny (≤ 5)** ("Often noise or near-duplicates"), and with a topic
**Topic vote ≥ 10%**. Engine "your browser, over the metrics Neo4j computed — nothing is re-fetched";
preview = count of matching rows. Apply writes `tree` (replace).

**KPI tiles** (`nu-kpis--6`, computed over the *filtered* rows): **Communities** (hint "2+ docs each ·
N in none" or "No clustering run yet"), **Largest** (info; hint "C12 — click to open"; click selects
it), **Median size** (neutral), **Mean cohesion** (success, "Higher is tighter"), **Mean conductance**
(warning, "Lower is better separated"), **Modularity** (hint "γ 1, N communities").

**Charts** (height 240; spans 6 + 6, or 4 + 4 + 4 with a topic): `communities-sizes` "Sizes" (60
largest filtered, community colours, "Largest first; click a bar to open the community."),
`communities-quality` "Cohesion vs conductance" ("Top-right is tight but leaky; bottom-right is the
ideal. Bubble size is the community size."), and with a topic `communities-topic` "Vote for “<first 30
chars>”" (horizontal bars of the top 12 vote shares in %, "N communities received anchor votes.").
Clicking any bar/bubble selects the community.

**Table** (`.nu-explorer-results`; title `ClusterOutlined` "All communities" or "Communities discussing
“<topic>”" + secondary "click a row for its central documents and neighbours"). `size="middle"`,
`scroll.x 760`, 25 rows per page (hidden on one page), sorting done by the page (so the page of any row
is known). Columns: **Community** (120, fixed left); with a topic **Topic vote** (180; community-coloured
90 px progress + "12.5%"; header tooltip "Share of the anchor vote: how strongly the documents nearest to
the topic sit in this community") and **Results** (100, right; "How many of the top 100 ranked results
fall in this community"); **Size** (180; number + 90 px progress relative to the largest); **Cohesion**,
**Density** (≥ md), **Conductance** (tag: warning ≥ 0.4, success ≤ 0.15, else plain), **Internal edges**
and **Boundary edges** (≥ lg). All metric columns sortable; header tooltips explain each metric;
decorative progress bars are `aria-hidden`. The expand column header is visually hidden "Details".

Row behaviour: a row is focusable; click, Enter or Space (on the row itself) toggles `selected`; only one
row is expanded at a time (`expandedRowKeys = [selected]`). When `selected` changes (deep link, chart
click, neighbour click, Largest tile) the table **turns to the page holding the row** and scrolls it to
the top after 350 ms. A new question resets to page 1.

**Expanded panel** (`CommunityDetailPanel`, `section.sl-detail aria-label="Community C3"`,
`GET /communities/{id}?limit=8`):

- Header (bottom border): title `CommunityKey` "Community C3" (15 px/650) over the facts line "31
  documents · cohesion 0.781 · conductance 0.104[ · topic vote 12.5%]"; actions on the right (block
  layout, never inline with the text): primary **Explore its documents** (`FileSearchOutlined`),
  **Show in graph** (tooltip "This community and its two closest neighbours"), and with a topic
  **Search “<topic, 24 chars>” here**.
- Body: auto-fit two columns (min 360 px):
  - **Most central documents** (h2) — "Ranked by summed similarity to the other members: the documents
    that best represent the community." Ordered list of buttons: round accent-soft rank badge, 2-line
    text, meta "`<external_id>` · N links · strength 9.12"; click opens the drawer. Empty: "No documents
    found".
  - **Neighbouring communities** (h2) — "Connected by boundary edges. Strong bridges suggest topics that
    could merge at a lower resolution (γ)." A plain table (`th scope="col"`): Community (button, opens
    that community's row), Shared edges (bar in the neighbour's colour, relative to the strongest, + count),
    Avg. similarity (right). With no neighbours: a dashed box with a success check — "**Fully
    separated.** No similarity edge leaves this community, so it is a self-contained topic."
- Loading: 4-row Skeleton.

**States.** Loading: Skeleton in the table card. No communities: "No communities yet" / "Import
documents and run clustering under Operations." No match: `NoResults` "No community matches the topic
and the metric conditions together." Error: Alert "Could not load communities".

**Footer** (`PAGE_DOCS.communities`):

| Key | Short | On hover |
|---|---|---|
| What | Inspect Leiden topic clusters | Every community (at least two documents) with its size, cohesion, density and conductance, and its most central documents. |
| Flow | Graph metrics → table, charts | Metrics come from the graph structure in Neo4j; topic search votes communities from semantic anchors (Qdrant) and hits. |
| Tech | Neo4j GDS Leiden | Weighted Leiden (Neo4j Graph Data Science); metric conditions are evaluated in the browser. |
| Why | Judge cluster quality | A well separated community has high cohesion and low conductance; bridges suggest topics that could merge. |
| How | Search a topic, filter metrics | Ask which communities discuss a topic, narrow by metrics under Advanced, expand a row for its documents. |

### 6.5 Import — `/import` (`ImportPage.tsx`)

Visual reference: Nucleus `pages/ImportPage.tsx`. A four-step wizard; the upload and the job **survive
navigation and reloads**. **Any delimited text file** is accepted: the page shows how it will be read
(separator, encoding, header row — detected, changeable), shows its **header**, and the reader
**chooses the column to analyse**.

```
Import                                                                        [⟳ Import another file]
Load any CSV or delimited text file, up to 1.0 GB, and choose the column to analyse. Rows are upserted…
(1 File)──(2 Columns)──(3 Import)──(4 Done)                                        steps, max-width 760
┌ main (2fr) ──────────────────────────────────────────────────────┐┌ side (min 300, 1fr) ───────────┐
│ ┌ dragger ────────────────────────────────────────────────────┐  ││ File format                    │
│ │  Drop a CSV or any delimited text file here, or click…      │  ││ One document per row, any      │
│ │  Any column names, with or without a header row; comma,…    │  ││ columns. … pick the column to  │
│ └─────────────────────────────────────────────────────────────┘  ││ analyse …                      │
│  after choosing a file:                                           ││ title;body;desk               │
│ ┌ File ───────────────────────────────────────────────────────┐  ││ [⇩ Download an example]        │
│ │ File: export.csv   Size: 1.3 KB   Columns: 4   Rows: 12      │  │├────────────────────────────────┤
│ │ Separator                Encoding                            │  ││ Add one document               │
│ │ [Detect — Semicolon (;)▾][Detect — Windows-1252 (…)▾] (◉) First row is the header │├──────────┤
│ │ ⓘ The first line “sep=…” is Excel's separator hint; …        │  ││ Earlier imports                │
│ ┌ Columns ────────────────────────────────────────────────────┐  │└────────────────────────────────┘
│ │ Column to analyse                      Row id                │
│ │ [Summary                         ▾]    [Generated from the text ▾]
│ │ Its text is embedded, linked …          Re-importing a row with the same id updates it. …
│ │ Columns to keep: click a column in the preview below …  3 of 3 kept  Keep all  Keep none │
│ │ ┌☑ Title ▒▒│ Summary ░░░░░░░░░░░░░░ │☑ Category ▒│☑ Year ▒▒┐ │   every header of the file; click a
│ │ │ kept   ▒▒│ analysed ░░░░░░░░░░░░░ │ kept ▒▒▒▒▒▒│ kept ▒▒▒│ │   column to keep/drop it: kept = green,
│ │ │ Article 0│ Study of rail freight… │ transport  │ 2020    │ │   analysed = indigo
│ ┌ Import options ─────────────────────────────────────────────┐  │
│ │ Source label …  (◉) Run Leiden …  Minimum community size [10 documents]  (○) Rebuild …  (○) Import the first …
│ │ [Import and analyse “Summary”] [Choose another file]         │
│  while running: Uploading ▰▰▰▱ 62% [Cancel upload] → Processing: steps + bar + [Cancel job]
│  when done:     Result (✓ Imported 12 documents …) + Descriptions + Skipped rows table
└──────────────────────────────────────────────────────────────────┘
```

Layout: `.nu-imp-layout` grid `minmax(0,2fr) minmax(300px,1fr)`, one column ≤ 1100 px.

**Header.** Title "Import"; subtitle "Load any CSV or delimited text file, up to <upload_max_bytes>, and
choose the column to analyse. Rows are upserted by id, so re-importing changes nothing." (the size part
appears once `/config` has answered); action **Import another file** (`ReloadOutlined`) whenever a file
or session exists (disabled while uploading).

**Steps** (`Steps size="small"`, max 760 px): File → Columns → Import → Done; current = 3 when finished,
2 while uploading/processing, 1 with a file, else 0; status `error` if the finished job failed.

**Step 1 — file.** `Upload.Dragger` (single file, no upload list, **no extension filter**):
`InboxOutlined`, "Drop a CSV or any delimited text file here, or click to choose", hint "Any column
names, with or without a header row; comma, semicolon, tab, pipe or another separator; UTF-8, UTF-16 or
a Windows encoding — all detected and shown. You then choose the column to analyse. Up to <size> and
<rows> rows." Client checks, each a closable error Alert: size (only once `/config` is known: `The file
is 1.2 GB; the limit is 1.0 GB. Split it into several files.`), binary content (`“book.xlsx” is an Excel
workbook or a ZIP archive (.xlsx, .zip), not delimited text. Save or export it as CSV and choose that
file.` — also legacy Excel, gzip, PDF, PNG, JPEG, NUL-byte "binary data"), empty file. **Only the first
256 KiB is read** (`readHead`), decoded with `TextDecoder` and parsed with PapaParse, so a 1 GB file
previews instantly; the bytes are kept in the draft so changing the separator, encoding or header
setting re-parses without reading the file again.

**How the browser reads it** (`lib/csv.ts`, the same rules as `app/pipeline/csv_reader.py`):
encoding = BOM (UTF-8 / UTF-16 LE / BE), a UTF-16 NUL pattern, valid UTF-8 (`TextDecoder` fatal +
stream), else Windows-1252; an Excel `sep=<c>` first line sets the separator and is skipped; otherwise
the separator among `, ; \t |` that splits the first 50 records into the most consistent cell count;
with a header row the first record gives the names, without one they are `column_1 … column_n`;
`uniqueHeaders` collapses whitespace, strips a BOM, names blank headers `column_<n>` and suffixes
repeats `_2`, `_3` — identical to the server, so the chosen column resolves there. Per column it
computes filled count, average length, uniqueness and numeric share over up to 200 rows; the row count
is exact for small files, else estimated from the head's bytes per row.

**Step 2 — columns.**

- **File** card: `Descriptions` File (mono), Size, Columns, Rows (or "Rows (estimate)" with "≈").
  Format row (`.nu-imp-format`, wraps): **Separator** select (`aria-label="Separator"`; "Detect —
  Semicolon (;)" plus Comma (,), Semicolon (;), Tab, Pipe (|), *Other character…* which reveals a
  one-character input `aria-label="Separator character"`), **Encoding** select (`aria-label="Encoding"`;
  "Detect — <detected>" plus UTF-8, UTF-16 LE, UTF-16 BE, Windows-1252 (Western European), Windows-1250
  (Central European, Romanian), ISO-8859-2 (Latin-2), ISO-8859-1 (Latin-1)), switch **First row is the
  header** (on). Changing any of them re-parses; the mapping is kept where its columns survive
  (`carryMapping`), else re-suggested. Notices: info "The first line “sep=…” is Excel's separator hint;
  it is used and skipped."; warning "The file reads as a single column" / "If it has several, choose its
  separator above. A single column works too: it is the text to analyse."; warning "N character(s) could
  not be read as <encoding>" / "Accented letters shown as � mean another encoding: try Windows-1252, or
  Windows-1250 for Romanian and Central European files."; info "N sampled row(s) have more cells than
  there are columns" / "Usually a separator inside an unquoted value, or a different separator. Such rows
  are skipped and listed after the import."
- **Columns** card:
  - **Column to analyse** (bold label; searchable select `aria-label="Column to analyse"`, warning
    outline while empty): each option shows the name (600), a *suggested* tag on the likeliest column,
    and a second line "≈ N characters · <first sample, 60 chars>" (or "empty in the sample"). Help: "Its
    text is embedded, linked to similar documents and clustered. No other column is embedded." Choosing
    another column puts the previous one back into metadata if there is room. Suggestion
    (`suggestColumns`): a column named `text, body, content, abstract, description, message, summary,
    review, comment, article, post, tweet, notes, note` (in that order) unless another non-numeric column
    is more than three times longer on average; else the longest non-numeric column.
  - **Row id** (select `aria-label="Row id"`): **Generated from the text** (default) or any other column
    (a column whose sampled values are all present and distinct reads "<name> · unique in the sample");
    a column named `id, key, uuid, guid, identifier, doc_id, document_id, record_id` with unique values is
    preselected. Help: "Re-importing a row with the same id updates it. Generated ids come from the text,
    so identical texts are one document."
  - **Columns to keep** — chosen **in the preview table**, not in a list. Above the table: "**Columns to
    keep:** click a column in the preview below to keep it as filterable metadata ▢ or leave it out."
    (the swatch is the green tint), a live "K of M kept (at most 20)" counter and text buttons **Keep all**
    / **Keep none**. Defaults: every other column up to `limits.metadata_max_keys` (20).
  - Checks (`checkMapping`): blocking warning "Before importing" — "Choose the column to analyse." /
    "Keep at most 20 metadata columns."; info notes — "N of the first M rows have no text in “<col>” and
    will be skipped.", "“<col>” holds mostly numbers; choose a column with words to analyse.", "“<col>"
    holds short values (about N characters); similarity works best on sentences or paragraphs.", "N of the
    first M rows have an empty id and will be skipped.", "N ids repeat in the first M rows; a later row
    replaces the earlier one with the same id."
  - **Preview table** (`.nu-imp-preview`, `size="small"`, first 10 rows, inside `.nu-imp-preview-scroll`
    which scrolls wide files horizontally — antd's own `scroll.x` is avoided because its hidden measuring
    row copies the header checkboxes into an `aria-hidden` region): **every column of the file** in file
    order; each header shows the name (ellipsis at 220 px) over a role tag — **analysed** (processing
    blue), **id**, **kept** (success green), **not imported**. The analysed column is tinted
    `--nu-accent-soft` with a 3 px accent top edge, its cells clamp to two lines (260–420 px) and an empty
    one shows the warning tag "empty — skipped". **Kept** columns are tinted `--nu-success-soft`
    (`rgba(22,163,74,.10)` light, `rgba(74,222,128,.12)` dark) with a 3 px `--nu-success` top edge;
    not-imported columns use tertiary text. Every kept or not-imported column is a toggle: a click on any
    of its cells or its header keeps or drops it (`cursor: pointer`, title "Kept — click to leave it out" /
    "Not imported — click to keep it"); its header also holds a checkbox `aria-label="Keep column <name>"`
    for the keyboard (a click on the checkbox itself is not counted twice). At the limit, unchecked boxes
    disable and a click shows the warning message "At most 20 columns can be kept; leave another one out
    first." The analysed and id columns are not toggles. Caption: "The first 10 rows of the file.
    Column names come from the header row." / "No header row: columns are numbered."
- Upload fields (`uploadFields`): `text_column`, `id_column` or `generate_ids=true`, `metadata_columns`
  (JSON, always explicit), `delimiter` (always, as previewed), `has_header` (`false` only when off),
  `encoding` **only when the reader chose one** — left to the server when detected, so a file whose head
  is UTF-8 but whose tail is not is still re-read as Windows-1252.

**Import options** card: "Source label — filterable in Explore and deletable under Operations" input
(max 128, default and placeholder `csv:<file name>`); switch "Run Leiden clustering afterwards"
(default on) and under it **Minimum community size** (`InputNumber aria-label="Minimum community size"`,
2–100,000, suffix "documents", **default 10**, disabled while clustering is off; help "Leiden groups with
fewer documents are left in no community. Later clustering runs (Operations, re-cluster after a delete)
reuse this size unless given another." → `min_community_size`, sent only with clustering on); switches
"Rebuild every edge (slower; only after changing k or the threshold)" (off), "Import the
first <text_max_chars> characters of longer texts (otherwise those rows are skipped and listed)" (off →
`truncate_long_texts`). Files over **100 MB** show an info Alert "Large file: 1.0 GB, roughly 3,200,000
rows" / "Every new or changed row is embedded on the API's CPU, so a file this size can take hours. You
can leave this page — the progress stays here and in the header — and cancel the job at any time; rows
imported until then are kept." Buttons: primary **Import and analyse “<column>”** (disabled while
blocked, with the blocking reasons as tooltip) and **Choose another file**.

**Step 3 — upload and processing.**

- **Uploading** card (extra "name · size"): active `Progress` (`aria-label="Upload progress"`) fed by XHR
  `upload.onprogress` (fetch cannot report upload progress) and **Cancel upload** (aborts: "Upload
  cancelled."). Errors: 401 "Uploading needs an API key. Add it with the key button in the header.", 413
  server detail or "The file is larger than the upload limit.", network "Network error while uploading.
  Check your connection and retry."
- **Processing** card (extra = file name): `JobProgress` for the import job (Read → Index → Link →
  Cluster → Done, bar with `processed / total`, phase text, **Cancel job**). A fresh success toasts
  "Import finished" (only if it finished within the last 15 s, so reopening an old job is not news).

**Step 4 — result** (`ImportSummary`, succeeded jobs): `Result` success (warning when rows failed)
"Imported N documents", subtitle "All rows were indexed in Elasticsearch, embedded into Qdrant and
linked in Neo4j." or "N row(s) were skipped. The rest are searchable now."; buttons primary **Explore the
documents**, **Open the graph**. `Descriptions` (1/2/3 columns by breakpoint): Analysed column (bold),
Minimum community size (when clustered, "10 documents"),
Ids ("generated from the text" or the column), Read as ("Windows-1252 (Western European) · Semicolon (;)",
plus " · no header row"), Rows read, Created,
Updated, Unchanged (skipped), Failed, Truncated texts (if any), Edges written, Communities and Modularity
(if clustered), Total time. **Skipped rows (N)** table (Row, id mono, Reason; 10 per page) with "showing
the first 200; every skipped row is counted" when truncated. Then **Import another file**.

**Browser-side flow** (the server side is in [specs.md §21.1](specs.md)):

```
drop file ─► size + binary checks ─► first 256 KiB: encoding, sep= line, separator, header, unique names
          ─► suggested column to analyse + id + metadata; checks (block the Import button, explain why)
change    ─► separator / encoding / header ─► re-parse the kept bytes, keep the mapping where it survives
Import    ─► XHR multipart POST /api/documents/upload (upload.onprogress → "Uploading" bar)
          ─► nginx streams it (proxy_request_buffering off) ─► API writes to disk, enforces the byte cap (413)
          ◄─ 202 {job}  ─► ?job=<id>, stage "processing"
poll      ─► GET /api/jobs/{id} every 800 ms ─► phase stepper + processed/total bar
finish    ─► invalidate every corpus query once ─► Result card (+ "Import finished" toast if fresh)
```

**Persistence.** The upload and job live in `lib/importSession.ts` (module-level store via
`useSyncExternalStore`: stages `idle → uploading → processing → finished`), the half-mapped file in a
second module-level draft store, so leaving and returning shows the same bar or card. When an upload
becomes a job its id is written to `?job=`; after a full reload the page re-attaches to that job, or —
with no `job` param, no draft and nothing on screen — to the running import from `GET /jobs`. Clicking a
history entry shows that job (`?job=`). "Import another file" dismisses the current job so it is not
re-attached automatically. If an import is running while another file is prepared: info Alert "Another
import is running: <file>" / "A new import starts when it finishes; jobs run one at a time." with **Show
progress**.

**Side column.**

- **File format**: "A header row, then one document per row. Columns named `id` and `text` are picked up
  on their own; any other names can be mapped after choosing the file. Quoted cells may contain commas
  and line breaks. Excel users: save as "CSV UTF-8"." + mono sample `id,text,desk` /
  `news-001,"Rail funding approved.",transport` + **Download template** (`semantic-leiden-template.csv`,
  three rows incl. a Romanian one).
- **Add one document**: textarea "Paste raw text" (4 rows, max 20,000, counter, `aria-label="Document
  text"`), input "Optional id (reuse it to update the document)" (`aria-label="Document id"`), primary
  **Add document** (`POST /documents`). Toasts: "Added with N similarity edges. Run clustering to assign a
  community." / "Document updated." / "Unchanged: identical text already stored."
- **Earlier imports**: list of import jobs (newest first as returned): file name as a link button
  (`aria-label="Show import <file>"`, disabled while uploading), status badge in its colour, mono source,
  outcome line ("N created, N updated, N failed", error in danger, "Waiting for the previous job", or
  "phase processed / total"), relative time on the right; the shown job is highlighted with
  `--nu-accent-soft`. Empty: "Nothing imported since the API started" / "Job history is kept in the API
  process."

**Footer** (`PAGE_DOCS.import`):

| Key | Short | On hover |
|---|---|---|
| What | Load CSV documents | Upload a CSV; each row becomes a document. Extra columns are kept as filterable metadata. |
| Flow | Upload → embed → link → cluster | The file streams to the API, a background job indexes it in Elasticsearch, embeds it into Qdrant, links neighbours in Neo4j and runs Leiden. |
| Tech | FastAPI, ES, Qdrant, Neo4j | XHR upload with progress, FastAPI background jobs, sentence-transformers embeddings. |
| Why | Bulk, idempotent ingestion | Rows are upserted by id: re-importing a file changes nothing, edited rows are re-embedded. |
| How | Drop, map columns, import | Drop a file, check which column is the id and the text, choose options, and follow the progress — it survives leaving the page. |

### 6.6 Operations — `/operations` (`OperationsPage.tsx`)

Visual reference: Nucleus `pages/admin/JobsPage.tsx`.

```
Operations  ● A job is running
Maintenance jobs run one at a time in the background; their progress survives page changes and reloads.
┌ ⊛ Cluster (Leiden) ─────────┐┌ ⌗ Rebuild similarity graph ─┐┌ 🛡 Reconcile stores ────────┐  auto-fit 320 px
│ Runs weighted Leiden on …    ││ Deletes every SIMILAR_TO …   ││ Elasticsearch is the source…│
│ Resolution γ (default 1)     ││ Neighbours per document k (now 12) ││ [Run reconcile]       │
│ [ 1          ]               ││ [ 12         ]               ││ (job progress)              │
│ Random seed [ 42 ]           ││ Minimum similarity (now 0.58)││                             │
│ Min. community size (default: last run) [ ]││ (◉) Cluster afterwards ││                     │
│ [Run clustering]             ││ [Rebuild graph]              ││                             │
│ steps + bar + [Cancel job]   ││                              ││                             │
│ Hide this result             ││                              ││                             │
└──────────────────────────────┘└──────────────────────────────┘└─────────────────────────────┘
┌ 🗄 Data sources ─────────────────────────────────────────────────── 30,072 documents in total ┐
│ Every import is labelled with a source (by default csv:<file name>). Deleting a source removes… │
│ Source          │ Documents ▼        │ No community │ First imported │ Last updated │           │
│ csv:sample.csv  │ 30,000 ▰▰▰▰▰▰▰▰    │ 12           │ 2 hours ago    │ 2 hours ago  │ [⌕ Explore] [🗑 Delete…] │
│ seed            │ 72     ▱           │ 0            │ 3 days ago     │ 3 days ago   │ [⌕ Explore] [🗑 Delete…] │
│ (delete job progress, Hide this result)                                                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Jobs ─────────────────────────────────────────────────────────────────────────────────────────┐
│ Job │ Status │ Progress │ Created │ Duration │                                                  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
┌ Modularity per run ─ span 4 ┐┌ Clustering history ─────────────────────────────── span 8 ┐
└─────────────────────────────┘└─────────────────────────────────────────────────────────────┘
WHAT Run maintenance jobs  FLOW Job queue → three stores  TECH Background jobs, Leiden …
```

**Header.** Title "Operations"; tag `Badge status="processing" text="A job is running"` while any job is
active; subtitle "Maintenance jobs run one at a time in the background; their progress survives page
changes and reloads."

**Job cards** (grid auto-fit `minmax(min(320px,100%),1fr)`, aligned to the top). Every field label is a
12 px secondary caption with its explanation as tooltip; number inputs are full width with the current
server default as placeholder; empty inputs send nothing (server default).

| Card | Copy | Fields | Start |
|---|---|---|---|
| **Cluster (Leiden)** (`ClusterOutlined`) | "Runs weighted Leiden on the current graph and writes a new community version to Neo4j, Qdrant and Elasticsearch." | "Resolution γ (default 1)" 0.05–50 step 0.1 ("Higher γ: more, smaller communities. Lower: fewer, broader ones."); "Random seed" ("A fixed seed makes runs reproducible for the same graph."); "Minimum community size (default <the last run's size, else the setting>)" integer 2–100,000 ("Smaller Leiden groups — typically documents with no neighbour, alone in a group of one — are left in no community. Never less than 2. The default is the size of the last run (an import sets it too).") | primary **Run clustering** → `POST /jobs/cluster {gamma?, random_seed?, min_community_size?}` |
| **Rebuild similarity graph** (`NodeIndexOutlined`) | "Deletes every SIMILAR_TO edge and recomputes k-nearest neighbours for all documents with a new policy." | "Neighbours per document k (now 12)" 1–200 ("More neighbours: denser graph, fewer isolated documents, larger communities."); "Minimum similarity (now 0.58)" −1…1 step 0.01 ("Edges below this cosine are not created. Higher values split weakly related topics."); switch "Cluster afterwards" (on) | **Rebuild graph** behind `Popconfirm` "Rebuild all edges?" / "Search keeps working; graph views are incomplete until the job finishes." → `POST /jobs/rebuild {neighbor_k?, min_similarity?, cluster}` |
| **Reconcile stores** (`SafetyCertificateOutlined`) | "Elasticsearch is the source of truth. Reconcile re-embeds documents missing from Qdrant, removes vectors and nodes whose document no longer exists, and re-links repaired documents." | — | **Run reconcile** → `POST /jobs/reconcile` |

Start buttons are disabled while any job is active, wrapped in a tooltip "Another job is running. Jobs
run one at a time so the graph is never changed twice at once." Start errors toast the API message.

**Job slot per card** (derived from the server's job list, never from component state, so returning to
the page finds a running job where it was left): the job of that kind that is running/queued; else the
one started from this view (unless hidden); else one that finished in the last **10 minutes** (unless
hidden). It renders `JobProgress` + text button **Hide this result**.

**Data sources** card (`DatabaseOutlined`; extra "N documents in total"; `GET /sources`). Intro "Every
import is labelled with a source (by default `csv:<file name>`). Deleting a source removes all of its
documents from Elasticsearch, their vectors from Qdrant and their nodes and edges from Neo4j." Table (10
per page, hidden on one page, `scroll.x 640`, row key = source or `__none__`): **Source** (mono, or
secondary "(no source)"); **Documents** (220; sortable, default descending; number + 90 px progress,
`aria-hidden`); **No community** (130, ≥ md; header tooltip "Documents in no community: not clustered
yet, or too loosely linked to join one"); **First imported** (≥ lg) and **Last updated** (≥ md), relative
with absolute tooltip; actions (visually hidden header "Actions"): text **Explore** (`SearchOutlined`,
`aria-label="Explore documents from <source>"`) and danger text **Delete…** (`DeleteOutlined`,
`aria-label="Delete all documents from <source>"`, disabled while a job runs with tooltip "Another job
is running; deleting waits for it."). Empty: compact "No data sources yet" + "Import a CSV". Load error:
Alert "Could not load the data sources". Below the table: the delete job slot.

**Delete modal** (`destroyOnHidden`): title `DeleteOutlined` "Delete <source>?"; body "This removes **N
documents** from Elasticsearch, their vectors from Qdrant and their nodes and edges from Neo4j. It cannot
be undone; re-import the file to get them back."; checkbox "Re-cluster afterwards (communities of the
remaining documents are recomputed)" (checked by default); **type-to-confirm** above **1,000 documents**:
"Type `<source>` to confirm" + input (`aria-label="Type the source name to confirm"`, error status while
wrong); info Alert "Another job is running; start the delete when it finishes." when busy. OK button
(danger) "Delete N documents", disabled until confirmed / while busy, loading while submitting →
`POST /jobs/delete-source {source, cluster}`. Success toast (once per job, only for a delete started
here): "Deleted N documents from <source>".

**Jobs** card (full width — outcomes are sentences): table (8 per page, `scroll.x 560`, newest first):
**Job** (label), **Status** (`Badge` in status colour; tooltip = error or phase), **Progress**
(succeeded → summary: import "N created, N updated, N failed", cluster "N communities", rebuild "N
edges", reconcile "N repaired, N orphans removed", delete "N deleted from <source>"; failed → danger
error; running → "phase processed / total" or phase), **Created** (relative, absolute tooltip),
**Duration** (≥ md; live while running), actions: text **Cancel** for running/queued jobs
(`aria-label="Cancel <Label> job"`). Empty: "No jobs have run in this API process yet".

**History row**: `operations-modularity` "Modularity per run" (span 4, line + bars, height 220; empty
"No clustering runs yet") and card "Clustering history" (span 8): table (8 per page) **Run** `v5`,
**Communities**, **In none** (tooltip "Documents clustered into a group smaller than the minimum
community size"), **Modularity**, **γ**, **k / min** (`12 / 0.58`), **Duration**, **When**.

**Footer** (`PAGE_DOCS.operations`):

| Key | Short | On hover |
|---|---|---|
| What | Run maintenance jobs | Re-cluster, rebuild the similarity graph, reconcile stores and delete whole data sources. |
| Flow | Job queue → three stores | Jobs run one at a time in the API process; Elasticsearch is the source of truth, Qdrant and Neo4j are rebuilt from it. |
| Tech | Background jobs, Leiden | In-process job runner with cooperative cancellation; Neo4j GDS Leiden; Qdrant and Elasticsearch bulk APIs. |
| Why | Keep stores consistent | The graph is never rebuilt and clustered concurrently, and a partial failure is always repairable. |
| How | Pick a job, confirm, watch | Set the parameters, start the job and follow its phases; progress survives reloads. |

---

## 7. Interaction patterns

1. **URL-as-state.** Anything an address should describe is in the URL (§4.4); preferences are in
   localStorage (§11.1); transient UI (open drawers, selection, hidden legend chips, Communities sort)
   is component state.
2. **Draft → Apply** for every condition editor (§5.11): live count and read-back while editing,
   nothing behind the drawer changes until Apply, Cancel discards.
3. **Show each filter once, by its own control.** The search box shows the words, the community select
   shows communities, the `ActiveConditions` chip shows the tree. Applied filters are chips with an edit
   label and a separate remove button.
4. **Drill-down everywhere.** KPI tiles, chart bars/bubbles/slices, chart table rows, facet chips and
   legend chips narrow or navigate (§4.6). Clickable tiles lift on hover.
5. **Chart = table.** Every chart can flip to its numbers and export them as CSV (§5.8).
6. **Stale-while-revalidate.** Queries keep the previous data while the next loads
   (`keepPreviousData`); the result area fades to 0.65 and says "Updating…"; initial loads show
   Skeletons, never spinners over empty space (the graph's corner spinner is the exception, over
   existing data).
7. **Empty ≠ no match.** "Nothing here yet" offers the creating action; "nothing matched" offers
   "Clear the question" (§5.3).
8. **Errors say what to do.** API errors surface as Alerts with the server's `detail`; typed codes get
   specific copy and actions (`not_clustered` → "Clustering has not run yet" + "Go to operations"; 409
   is info, not error). Client messages: 401 → "This action needs an API key. …"; 502/504 → "The API is
   not reachable. Check that the app container is running." Queries never retry 4xx; others retry twice.
9. **Confirm in proportion.** Single document delete and graph rebuild: `Popconfirm`. Source delete:
   modal with counts, re-cluster option and type-to-confirm above 1,000 documents. Starting a
   re-cluster: no confirmation (it is reversible by running again).
10. **Toasts** (`App.useApp().message`) for completed actions ("Document deleted", "Saved “…”", "Link
    copied", "Import finished", "Deleted N documents from …", "Exported N documents"); `notification`
    max 3 at bottom-right.
11. **Background jobs are always visible**: header job pill (every page), processing badge in the nav,
    phase stepper + bar on the owning page, Dashboard alert tag, consistency band suppressed mid-job.
    Jobs run one at a time; start buttons explain why they are disabled.
12. **Progress survives navigation** (import session store; Operations derives slots from `/jobs`) and
    **reloads** (`?job=`, re-attach to the active import).
13. **One document drawer**, stackable with Back, reachable from every page.
14. **Search as you type** (Explore) after 350 ms with ≥ 3 characters, switchable in Ranking options;
    Enter always submits. Recent searches per page; saved searches per page.
15. **Keyboard shortcuts** are few and discoverable: `/` and Ctrl/⌘ + K on Explore (hinted in the box and
    under the examples).

---

## 8. Accessibility

Target: **WCAG 2.1 AA** in light and dark themes; audited with axe-core (0 violations across all 17
cases × 2 themes at v0.4.0, dev and production builds).

### 8.1 Structure and names

- Landmarks: `aside` (Sider), `header`, `main` content (`#nu-main`, focus target of the skip link),
  `footer.nu-pagedoc aria-label="About this page"`.
- Headings: one `h1` per page (`PageHeader`); drawer and expanded-row sections use `h2`; list-row titles
  are not headings (`ListMeta` replaces `List.Item.Meta`'s `h4`).
- Every icon-only button has an `aria-label` (theme, settings, consoles on mobile, graph toolbar, table
  row actions, chart CSV, copy/delete saved search, forget recent search, RAQB buttons, duplicate).
- Every form control has a name: selects (`Community filter`, `Edge limit`, `Communities to draw`,
  `Document at the centre`, `How many matching documents to draw`, `Find a document in the graph`,
  `Role of column …`, routing selects), sliders (`ariaLabelForHandle`), progress bars (upload, job, job
  pill), switches (`Show insights`, `Generate ids from the text`), RAQB field/comparison/value.
  Decorative bars inside tables are `aria-hidden` instead of named.
- Table action and expand columns have visually hidden headers ("Actions", "Details") via `.sr-only`.
- Toggles expose state: `aria-pressed` on chips, facet chips and legend chips; `aria-expanded` on
  "Full text"; job progress region `aria-live="polite"`; consistency band `role="status"`.
- Clickable non-buttons (KPI tiles, alert tags) get `role="button"`, `tabIndex 0` and Enter/Space.
- The canvas is `role="img"` with a descriptive `aria-label` pointing to the node finder; axe excludes
  its pixels.
- Colour is never the only carrier: community glyphs always sit next to the `C12` label; status badges
  carry text; conductance tags carry the number.

### 8.2 Keyboard map

| Key | Where | Effect |
|---|---|---|
| Tab (first stop) | any page | "Skip to content" → focuses `#nu-main` |
| `/` | Explore (focus not in an input) | focus the search box |
| Ctrl/⌘ + K | Explore | focus the search box |
| Enter | search boxes | submit and remember the term |
| ↑ ↓ Enter | search boxes | pick a recent search (antd AutoComplete) |
| Enter | Explore table row | open the document drawer |
| Enter / Space | Communities table row (row focused) | expand / collapse the community |
| Enter / Space | clickable KPI tiles, Dashboard alert tags | drill down |
| Esc | drawers, modals, dropdowns, popovers | close (antd) |
| Type + Enter | Graph "Find a document in view" | zoom to and select the node |
| Tab | RAQB rule rows | reveals the duplicate button on focus-within |

### 8.3 The audit script (`frontend/scripts/a11y-audit.mjs`)

```bash
cd frontend
npx playwright install chromium            # once
npm run dev                                # or point BASE at a running UI
npm run audit:a11y                         # BASE=http://localhost:3000 npm run audit:a11y  (compose/nginx build)
TAGS=best-practice npm run audit:a11y      # stricter structural rules (landmarks, heading order)
```

- `BASE` default `http://localhost:5173`; `TAGS` default `wcag2a,wcag2aa,wcag21a,wcag21aa`.
- Chromium via Playwright, viewport 1440 × 1000; the theme is forced per pass by an init script
  writing `semantic-leiden.appearance` = `light` then `dark`.
- For each case: open the route, wait for network idle + 1.2 s, run the steps (`['text', label]` clicks
  the first exact text match, `['click', selector]`, `['wait', ms]`), then
  `new AxeBuilder({page}).withTags(TAGS).exclude('canvas').analyze()`.
- Prints `✓/✗ <theme> <case>` and, per violation, impact, rule id, help and up to three targets; exits
  **1** when any violation is found (CI gate).
- The 17 cases: `dashboard` (/), `explore` (/documents), `explore ranked` (?q=railway&mode=hybrid),
  `explore list` (…&view=list), `explore advanced drawer` (click "Advanced"), `explore ranking drawer`
  (?q=rail&mode=hybrid, click "Ranking"), `document drawer` (click first `.ant-table-row`), `graph`,
  `graph search results` (?view=query&q=vaccine&expand=1), `graph highlight drawer` (click
  "Highlight"), `communities`, `communities topic` (?q=ransomware), `community expanded` (click first
  row), `import`, `operations`, `settings menu` (click `button[aria-label^="Settings"]`), `api key
  dialog` (settings → "API key…").

Issues this audit found and v0.4 fixed (keep them fixed): sidebar group-title contrast; unnamed progress
bars and sliders; unlabelled selects including RAQB's own; dark dropdown selection contrast;
`aria-expanded` misplaced on table rows; empty table header cells; heading order broken by
`List.Item.Meta`'s `h4`; unfocusable `CheckableTag` chips.

---

## 9. Responsive behaviour

antd breakpoints (`Grid.useBreakpoint`): xs < 576, sm ≥ 576, md ≥ 768, lg ≥ 992, xl ≥ 1200, xxl ≥ 1600.
Every auto-fit grid uses `minmax(min(Npx, 100%), 1fr)` so nothing overflows a 390 px phone.

| Width | Behaviour |
|---|---|
| ≥ 1800 px | Dashboard KPI row shows all 8 tiles in one row |
| ≤ 1300 px | 6-tile rows (Communities) become 3 columns |
| ≤ 1200 px | chart spans: 4 → 6, 8 → 12 |
| ≤ 1100 px | Explore/Communities toolbar stacks to one column; Import layout becomes one column (side cards below) |
| < 992 px (`lg`) | sidebar becomes an off-canvas drawer (hamburger, scrim, closes on navigation); breadcrumb hidden; Consoles icon-only; header padding 10, content padding 14 |
| ≤ 900 px | all KPI grids 2 columns |
| < 768 px (`md`) | Explore defaults to List view; document drawer full width; graph node card full width, node finder 200 px; readiness text hidden (`.hide-mobile`); compact density floored to standard; all chart spans 12; Explore segmented controls scroll horizontally inside themselves; graph stage min-height 380 |
| < 576 px (`sm`) | graph view switcher shows icons only |

Table columns declare `responsive` breakpoints (Explore: Source ≥ lg, Length/Updated ≥ md, Metadata ≥ xl;
Communities: Density ≥ md, edges ≥ lg; Operations: No community/Last updated/Duration ≥ md, First
imported ≥ lg; Import preview metadata ≥ md) and scroll horizontally (`scroll.x`) rather than squeeze.
The shell uses `100dvh` so mobile browser bars do not cut the page.

---

## 10. Performance

- **Code splitting.** Six lazy route chunks; idle prefetch of Explore and Graph. `manualChunks` only for
  self-contained libraries: `vendor-d3`, `vendor-csv` (papaparse), `vendor-echarts` (echarts + zrender),
  `vendor-query` (TanStack). antd and its `rc-*` dependencies are left to Rollup (hand-splitting them
  produced a cross-chunk cycle). `chunkSizeWarningLimit 1100`, target `es2022`, no sourcemaps, CSS code
  split.
- **The query builder is lazy twice**: the drawer module imports `AdvancedQueryBuilder` with
  `React.lazy`, so RAQB and its CSS (~266 KB gzipped, the largest chunk) load the first time a conditions
  drawer opens. Measured v0.4 build: entry ≈ 282 KB gz (initial JS was about 405 KB gz before
  route-level splitting), ECharts ≈ 200 KB gz, d3 ≈ 21 KB gz, each page chunk 12–19 KB gz.
- **ECharts core build** with four chart types and six components (§2.6).
- **Server state** (TanStack Query): defaults `staleTime 15 s`, no refetch on focus; per query:

  | Query | Freshness / polling |
  |---|---|
  | `/config` | stale 5 min |
  | `/stats` | stale 10 s; refetch every 3 s while `jobs_active`, else 30 s |
  | `/ready` | every 20 s, no retry |
  | `/jobs` | every 1.5 s while any job is active, else 15 s |
  | `/jobs/{id}` | every 800 ms until finished, then stop |
  | `/communities` / `/communities/{id}` | stale 30 s / 60 s |
  | `/explore/fields` | stale 60 s |
  | `/sources` | stale 15 s |
  | `/search` | stale 60 s, previous data kept, no retry |
  | `/explore/query` | previous data kept, no retry |
  | `/explore/insights` | stale 30 s, previous data kept |
  | graph queries | stale 30 s, previous data kept |
  | `/documents/{id}/similar` | stale 60 s |

  A finishing job (first observation per job id) or a document delete invalidates every corpus query
  (`stats, config, communities, community, cluster-runs, jobs, sources, explore-fields, explore,
  insights, graph, search, similar, document`). Superseded requests are cancelled via `AbortSignal`.
- **Debounces**: Explore live search 350 ms; ranked search request 200 ms; conditions draft preview
  280 ms; graph min-similarity 250 ms; graph centre picker 300 ms; Communities topic search 250 ms.
- **Long lists**: `.sl-result { content-visibility: auto }`; tables paginate (browse pages ≤ 200, 10,000
  result window); ranked lists grow by 25 up to 200.
- **Canvas graph**: batched paths per colour and per edge class, frames only on demand, DPR ≤ 2, labels
  only when zoomed or focused (≤ 120), collide force dropped and cheaper many-body above 1,500 nodes,
  positions reused across data changes, selection/highlight/theme never restart the simulation, layout
  paused on demand, re-fit on settle unless the reader moved the camera; server caps (5,000 edges, 1,000
  ego nodes, 1,000 seeds) bound the worst case.
- **Import preview** parses only the first 10 rows; the upload streams through nginx
  (`proxy_request_buffering off`) with honest progress; files > 100 MB get a time warning first.

---

## 11. Storage keys and UI security

### 11.1 Browser storage

All keys are namespaced `semantic-leiden.` so two apps on one origin cannot collide. Every read and
write is wrapped in `try/catch`; with storage disabled the app works with defaults.

| Key | Storage | Value | Default / limits |
|---|---|---|---|
| `semantic-leiden.appearance` | local | `light` \| `dark` \| `system` | `system` |
| `semantic-leiden.density` | local | `compact` \| `middle` \| `comfortable` | `middle` |
| `semantic-leiden.sidebar.collapsed` | local | `'true'` \| `'false'` | `false` |
| `semantic-leiden.search.recent.<scope>` | local | JSON string[] (scopes `explore`, `graph`, `communities`) | 10 terms, ≥ 2 chars |
| `semantic-leiden.saved-searches` | local | JSON `[{id, name, path, search, summary, created_at}]` | 100 entries |
| `semantic-leiden.search.tuning.v2` | local | JSON `SearchTuning` (merged over `DEFAULT_TUNING`) | defaults §5.14 |
| `semantic-leiden.chart.<id>` | local | `chart` \| `table` | `chart` |
| `semantic-leiden.conditions.help` | local | boolean | `true` |
| `semantic-leiden.explore.insights` | local | boolean | `true` |
| `semantic-leiden.api-key` | **session** | the `X-API-Key` value | none; cleared when the tab closes |

Chart ids: `community-sizes`, `documents-by-source`, `clustering-history`, `community-quality`,
`document-length`, `documents-over-time`, `store-consistency`, `explore-communities`, `explore-length`,
`communities-sizes`, `communities-quality`, `communities-topic`, `operations-modularity`.

Module-level (in-memory, per tab, lost on reload): the import session and the import draft, dismissed
import job ids, "already announced" delete jobs, "already refreshed" finished jobs.

### 11.2 UI security

- **No `innerHTML` for data.** Highlights are parsed from control characters into React elements
  (§5.20); document text, ids and metadata are always React text. The only HTML string is the ECharts
  scatter tooltip, built from generated labels (`C12`) and numbers.
- **API key**: `sessionStorage` (tab-scoped), sent as `X-API-Key` on fetch and on the XHR upload; never
  logged or shown after saving (`Input.Password`). Reads work without it; writes need it only when the
  server sets `API_KEY`.
- **CSV exports** (`toCsv`): RFC 4180 quoting (`"` doubled; quote when `"`, `,`, CR or LF), objects as
  JSON, and a leading apostrophe for cells starting with `=`, `+`, `-`, `@`, tab or CR (formula
  injection).
- **External links** (Consoles) open with `target="_blank" rel="noreferrer noopener"`.
- **Same-origin API** through `/api`; no CORS in production. In the compose stack the UI container
  (`ui`, built from `frontend/Dockerfile`, host port 3000 → 8080, health `/healthz`) is the single
  exposed entry point; Elasticsearch, Qdrant, Neo4j and the API bind to `127.0.0.1` only. The Consoles
  menu links to those localhost ports, so it is useful on the host running the stack.
- **nginx headers**: `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none';
  base-uri 'self'; form-action 'self'; frame-ancestors 'none'` (`'unsafe-inline'` styles are required by
  antd's CSS-in-JS; no dependency needs `eval`), `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`,
  `server_tokens off`. `/assets/` cached for a year (`immutable`, content-hashed); `index.html`
  `no-cache`. Upload body limit `client_max_body_size 1100m`, read/send timeouts 3600 s, request
  buffering off. `/healthz` for the container health check. The image runs unprivileged (uid 101,
  port 8080).
- **Destructive actions** always confirm (§7.9) and state exactly what is removed from which store.

---

## 12. Rebuild checklist

### 12.1 Order of work

1. **Scaffold** Vite 7 + React 18 + TypeScript, alias `@/`, the dependency set of §1.2, dev proxy `/api`
   → `:8000`, `manualChunks` of §10, nginx config and unprivileged Dockerfile of §11.2.
2. **Theme** — port Nucleus `theme/tokens.ts`, `antd.ts`, `echarts.ts`, `AppearanceProvider.tsx` and
   adapt them to exactly §2.2–2.9 (INK greys, NEUTRAL 500 `#5f6e85`, ACCENT from the logo, `cssVar key
   'sl'`, the dark Dropdown/Select fixes, handheld density floor). Add `lib/palette.ts` (§2.2.9). See
   [specs.md §9](specs.md) for the copy/adapt list.
3. **Stylesheet** — one `index.css` with the shell, page furniture, KPI and chart grids, explorer
   toolbar, chips, results, community key, detail panel, graph stage, import layout, antd overrides,
   `.sr-only`, focus and reduced-motion rules.
4. **Shell** — `main.tsx` providers, `AppShell` (sidebar groups, foot, header controls, job pill,
   readiness, consoles, theme, settings, API key dialog, consistency band, skip link), `navigation.tsx`,
   `ErrorBoundary`, routes with lazy pages, legacy redirects, NotFound, idle prefetch.
5. **API layer** — `client.ts` (`/api` prefix, `ApiError` with status/code/details, friendly 401/502/504
   messages, XHR upload with progress/abort), `hooks.ts` with the keys, polling and invalidation of §10,
   `types.ts` mirroring [specs.md §5](specs.md) (API specification).
6. **Shared components** of §5 in this order: PageHeader, PageDoc + `pageDocs.ts`, EmptyState,
   StatCard, CommunityKey, Chip/FilterChip, ListMeta, ChartCard + option builders, SearchBox +
   recent searches, SavedSearchButtons, queryTree + evaluate + queryBuilderConfig + AdvancedQueryBuilder
   + AdvancedConditionsDrawer, SearchTuningDrawer, ResultCard, SearchInsights, DocumentDrawer,
   JobProgress, GraphCanvas, highlight and format helpers, `useUrlState`, `useSticky`, `links.ts`.
7. **Pages** in dependency order: Operations (jobs, sources) → Import (needs jobs) → Explore → Graph →
   Communities → Dashboard (links into all of them).
8. **Tests** — vitest for the highlight parser (incl. trimmed opening marker and "never interprets
   HTML"), CSV role guessing / mapping / validation, tree evaluation (accent folding, empty = match-all,
   OR/NOT/ranges, pruning, `withRules`), formatting, colour stability, CSV export and formula defusing;
   `npm run build` (strict TypeScript) is the static gate. v0.4 has **no browser E2E suite in CI**: the
   UI was smoke-tested with Playwright against the running stack in desktop and mobile viewports (zero
   console errors; import, search, drawer and operations flows). Checking those in as `@playwright/test`
   specs (Nucleus has a full `frontend/e2e/` suite to copy the structure from) is the obvious next step.
9. **Accessibility** — run `npm run audit:a11y` against dev and the nginx build until both themes report
   0 violations.

### 12.2 Acceptance checks (UI)

- [ ] Light, dark and system appearance; switching is instant and survives reload without a flash;
      three densities change table rows, controls and fonts together; phones never render compact.
- [ ] Sidebar groups Overview / Explore / Data; collapse persists; below 992 px it is a drawer that
      closes on navigation; the breadcrumb and document title follow the route.
- [ ] Starting any job shows the header pill and the nav badge on every page; the pill links to the
      owning page.
- [ ] Inconsistent stores (with no job running) show the band on every page and the Dashboard alert.
- [ ] Every page has one h1, a one-sentence subtitle and the five-part footer with hover sentences.
- [ ] Every Explore/Graph/Communities question round-trips through the URL, Back/Forward, a saved
      search and a copied link; defaults are not written to the URL; v0.3 `?tab=` links redirect.
- [ ] Explore: Browse gives exact totals, sorting and numbered pages (10,000 cap); Hybrid/Semantic/Keyword
      rank with highlights, Explain popovers, timings, community vote and facets; conditions apply in
      every mode; live search never erases a query set from an example, the history or a link.
- [ ] Conditions drawers: draft/apply, live count, read-back, presets, duplicate, unfinished rules
      ignored, RAQB loaded only on first open.
- [ ] Graph: four sources; highlight dims or hides; the selected node and the neighbourhood centre are
      unmistakable (halo + contrasting body) in both themes; legend toggles; node finder selects; PNG
      export; reduced motion lays out without animation.
- [ ] Communities: topic search re-ranks and filters; `C12` jumps; metric conditions filter instantly;
      `?selected=` opens the right row on any page and scrolls to it; the panel's actions sit in its
      header, not inline with text; neighbour bars are visible.
- [ ] Import: preview of a 1 GB file is instant; mapping validates; upload bar and job stepper survive
      leaving the page and a full reload; result lists skipped rows; history reopens a job.
- [ ] Operations: jobs one at a time with explained disabled buttons; per-card progress survives
      reloads; source delete with type-to-confirm above 1,000 documents and optional re-cluster.
- [ ] Every chart flips to a table and exports CSV; every tile/bar drills down as in §4.6.
- [ ] axe: 0 violations, 17 cases × 2 themes; keyboard map of §8.2 works.

### 12.3 Known inconsistencies in the v0.4.0 code

Reproduce these knowingly or fix them in the rebuild (fixing is recommended):

1. **Stale API-key hint.** `api/client.ts` (401 on fetch and on upload) says "Add it with the key button
   in the header", but the key now lives under **Settings → API key…**; `components/ApiKeyButton.tsx`
   exports only the dialog and a hook despite its name.
2. **`/` hint without a handler.** `SearchBox` always shows a `/` shortcut hint, but only Explore
   registers the `/` and Ctrl/⌘ + K listener; the Graph (query view) and Communities boxes show the hint
   and ignore the key.
3. **Explore row keyboard.** Rows open on Enter only (Communities accepts Enter and Space), and the row's
   `onKeyDown` does not check `e.target === e.currentTarget`: Enter on the row's graph icon button
   bubbles, so the drawer opens *and* the page navigates to the graph, leaving the global drawer open
   over it.
4. **Operations number inputs are named only by their placeholder** (e.g. "1", "42", "12"): the visible
   captions are not `<label>`s. axe accepts placeholders, screen-reader users hear the default value
   instead of "Resolution γ".
5. **Smooth scroll ignores reduced motion.** Communities scrolls the selected row with `behavior:
   'smooth'` from JavaScript; the CSS `scroll-behavior` override does not apply to explicit JS options.
6. **Hard-coded limits.** The single-document textarea caps at 20,000 characters while the options card
   reads `config.limits.text_max_chars`; before `/config` loads, the Import page falls back to a 50 MB
   upload limit (the server allows 1 GiB), so a large file dropped in the first instant is rejected; the
   `previewCsv` comment still speaks of "a 50 MB CSV".
7. **Pages setting sizes.** Explore and Communities tables pass `size="middle"` (and ChartCard tables
   `size="small"`), against the convention that density alone sets control sizes.
8. **Storage keys outside `STORAGE_KEYS`.** `semantic-leiden.chart.<id>`, `.conditions.help` and
   `.explore.insights` are string literals in their components, not entries of `config.ts`.
9. **Not every view is URL state.** Communities sort and page, the graph selection and legend hiding are
   component state, so they are not restored by Back or saved searches.
10. **Unused layout tokens.** `LAYOUT.breakpoints.tablet` (1024) and `laptop` (1440) are defined but
    unused; the CSS uses its own breakpoints (767, 900, 991, 1100, 1200, 1300, 1800).
11. **Minor copy drift.** The Communities footer says "narrow by metrics under Advanced" but the button
    is labelled "Metric conditions"; JetBrains Mono is named in the font stack but not bundled.
