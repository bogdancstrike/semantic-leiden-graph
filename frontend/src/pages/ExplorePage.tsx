/**
 * `/documents` — the explorer: browse every document or rank them, and narrow
 * either with nested conditions (after the Nucleus Data Explorer).
 *
 * Two engines answer, and the page says which:
 * - **Browse** is an exact Elasticsearch question (`POST /explore/query`): every
 *   match, a true total, any sort, numbered pages.
 * - **Keyword / Semantic / Hybrid** rank the top matches (`POST /search`) with
 *   BM25, Qdrant vectors or both fused; the same condition tree becomes a filter
 *   or a Qdrant pre-filter.
 *
 * The whole question lives in the URL, so a view can be bookmarked, saved,
 * shared and walked back with the Back button.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Dropdown,
  Grid,
  Popover,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { InputRef } from 'antd'
import type { ColumnsType, SorterResult } from 'antd/es/table/interface'
import {
  ApartmentOutlined,
  AppstoreOutlined,
  BarsOutlined,
  ClearOutlined,
  DownloadOutlined,
  EyeOutlined,
  FileTextOutlined,
  FilterOutlined,
  InfoCircleOutlined,
  NodeIndexOutlined,
  SearchOutlined,
  SlidersOutlined,
  TableOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api, ApiError } from '@/api/client'
import { useCommunities, useExplore, useExploreFields, useInsights, useSearch, useStats } from '@/api/hooks'
import type { ExploreRequest, ExploreSort, QueryNode, SearchMode } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { ChartCard } from '@/components/ChartCard'
import { Chip } from '@/components/Chip'
import { barOption } from '@/components/charts/options'
import { CommunityKey } from '@/components/CommunityKey'
import { useDocumentDrawer } from '@/components/DocumentDrawer'
import { EmptyState, NoResults } from '@/components/EmptyState'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { ActiveConditions, AdvancedConditionsDrawer, type ConditionPreset, type PreviewState } from '@/components/query/AdvancedConditionsDrawer'
import { countRules, treeFromRules, withRules } from '@/components/query/queryTree'
import { SavedSearchButtons } from '@/components/SavedSearches'
import { buildSearchRequest, DEFAULT_TUNING, MODES, tuningChanges, type SearchTuning } from '@/components/search/defaults'
import { Explain, ResultCard, ResultText, type ResultRow } from '@/components/search/ResultCard'
import { SearchBox } from '@/components/search/SearchBox'
import { FacetCard, RoutingCard, Timings, Warnings } from '@/components/search/SearchInsights'
import { SearchTuningDrawer } from '@/components/search/SearchTuningDrawer'
import { StatCard } from '@/components/StatCard'
import { STORAGE_KEYS } from '@/config'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useSticky } from '@/hooks/useSticky'
import { parseIds, parseJson, positiveInt, useUrlState } from '@/hooks/useUrlState'
import { downloadText, toCsv } from '@/lib/download'
import { fmtInt, fmtRelative, fmtScore } from '@/lib/format'
import { links, rule } from '@/lib/links'
import { communityColor, communityLabel, NO_COMMUNITY } from '@/lib/palette'
import { useAppearance } from '@/theme/AppearanceProvider'

type Mode = SearchMode | 'browse'
type View = 'table' | 'list' | 'cards'

const EXAMPLES = ['railway investments in Romania', 'patch for an authentication flaw', 'căi ferate', 'kafka consumer lag']
const SORTABLE = new Set(['external_id', 'community_id', 'source', 'length', 'updated_at', 'created_at'])
const EXPORT_LIMIT = 5000

const MODE_OPTIONS: { value: Mode; label: string; hint: string }[] = [
  { value: 'browse', label: 'Browse', hint: 'Exact Elasticsearch filter: every match, true totals, any sort, numbered pages' },
  ...MODES.map((m) => ({ value: m.value as Mode, label: m.label, hint: `${m.hint}. Ranks the top matches.` })),
]

export default function ExplorePage() {
  const navigate = useNavigate()
  const drawer = useDocumentDrawer()
  const { message } = App.useApp()
  const { chartTheme } = useAppearance()
  const [params, set] = useUrlState()
  const { data: stats } = useStats()
  const { data: communities = [] } = useCommunities()
  const catalogue = useExploreFields()
  const inputRef = useRef<InputRef>(null)

  // ------------------------------------------------------------------ the question, from the URL
  const q = params.get('q') ?? ''
  const mode: Mode = ((params.get('mode') as Mode | null) ?? (q ? 'hybrid' : 'browse')) as Mode
  const ranked = mode !== 'browse' && q.trim().length > 0
  const tree = useMemo(() => parseJson<QueryNode>(params.get('tree')), [params])
  const quickCommunities = useMemo(() => parseIds(params.get('communities')), [params])
  const screens = Grid.useBreakpoint()
  // A phone is too narrow for a table of documents; it starts on the list.
  const defaultView: View = screens.md === false ? 'list' : 'table'
  const view = (['table', 'list', 'cards'].includes(params.get('view') ?? '') ? params.get('view') : defaultView) as View
  const page = positiveInt(params.get('page'), 1)
  const size = Math.min(200, positiveInt(params.get('size'), 25))
  const sort = (params.get('sort') as ExploreSort | null) ?? (q ? '_score' : 'updated_at')
  const order = params.get('order') === 'asc' ? 'asc' : 'desc'
  const rules = countRules(tree)

  const [storedTuning, setTuning] = useSticky<SearchTuning>(STORAGE_KEYS.searchTuning, DEFAULT_TUNING)
  const tuning = useMemo(() => ({ ...DEFAULT_TUNING, ...storedTuning }), [storedTuning])
  const [insightsOpen, setInsightsOpen] = useSticky<boolean>('semantic-leiden.explore.insights', true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [tuningOpen, setTuningOpen] = useState(false)

  // ------------------------------------------------------------------ search box <-> URL
  const [draft, setDraft] = useState(q)
  // Copy the URL into the box only when it changed for another reason (Back, a
  // deep link): live search writes a *trimmed* query, and copying that back would
  // delete the space just typed between two words.
  useEffect(() => setDraft((current) => (current.trim() === q ? current : q)), [q])
  const debouncedDraft = useDebouncedValue(draft, 350)
  // Live search reacts to *typing* only. Reacting to the URL as well meant that a query
  // set from elsewhere (a suggestion, the history, a link) met the stale debounced box
  // and was immediately cleared again.
  const lastTyped = useRef(debouncedDraft)
  useEffect(() => {
    if (debouncedDraft === lastTyped.current) return
    lastTyped.current = debouncedDraft
    const next = debouncedDraft.trim()
    if (!tuning.liveSearch || next === q) return
    if (next.length >= 3 || next.length === 0) set({ q: next || null, page: null })
    // `q` is read, not watched: see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedDraft, tuning.liveSearch, set])
  const submit = (value: string) => set({ q: value.trim() || null, page: null }, { push: true })

  // "/" or Ctrl/Cmd+K focuses the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable]')
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A deep link can name a document to open (`?record=`), once.
  const record = params.get('record')
  useEffect(() => {
    if (record) {
      drawer.open(record)
      set({ record: null })
    }
  }, [record, drawer, set])

  // ------------------------------------------------------------------ requests
  const browseTree = useMemo(
    () => (quickCommunities.length ? withRules(tree, [rule.communities(quickCommunities)]) : tree),
    [tree, quickCommunities],
  )
  const exploreRequest = useMemo<ExploreRequest | null>(
    () =>
      ranked
        ? null
        : { query_text: q, condition_tree: browseTree, sort, order, page, page_size: size, facets: false, highlight: !!q },
    [ranked, q, browseTree, sort, order, page, size],
  )
  const searchRequest = useMemo(
    () => (ranked ? buildSearchRequest(q, mode as SearchMode, tuning, { topK: size, communities: quickCommunities, conditionTree: tree }) : null),
    [ranked, q, mode, tuning, size, quickCommunities, tree],
  )
  const debouncedSearch = useDebouncedValue(searchRequest, 200)
  const browse = useExplore(exploreRequest)
  const search = useSearch(ranked ? debouncedSearch : null)
  const insightsRequest = useMemo<ExploreRequest | null>(
    () => (!ranked && insightsOpen ? { query_text: q, condition_tree: browseTree } : null),
    [ranked, insightsOpen, q, browseTree],
  )
  const insights = useInsights(insightsRequest)

  const active = ranked ? search : browse
  const error = active.error as Error | null
  const settling = active.isFetching || (ranked && debouncedSearch !== searchRequest)

  const rows: ResultRow[] = useMemo(() => {
    if (ranked) {
      return (search.data?.results ?? []).map((hit) => ({
        id: hit.id,
        external_id: hit.external_id,
        text: hit.text,
        highlights: hit.highlights,
        community_id: hit.community_id,
        source: hit.source,
        metadata: hit.metadata,
        score: hit.score,
        explain: hit.explain,
      }))
    }
    return (browse.data?.items ?? []).map((item) => ({
      id: item.id,
      external_id: item.external_id,
      text: item.text,
      highlights: item.highlights ?? [],
      community_id: item.community_id,
      source: item.source,
      length: item.length,
      updated_at: item.updated_at,
      metadata: item.metadata,
      score: item.score ?? null,
    }))
  }, [ranked, search.data, browse.data])

  const total = ranked ? (search.data?.total_lexical ?? search.data?.results.length ?? 0) : (browse.data?.total ?? 0)
  const conditionText = browse.data?.condition_text || insights.data?.condition_text || ''

  // ------------------------------------------------------------------ actions
  const toggleCommunity = (id: number) => {
    const next = quickCommunities.includes(id) ? quickCommunities.filter((c) => c !== id) : [...quickCommunities, id]
    set({ communities: next.join(',') || null, page: null })
  }
  const clearQuestion = () => {
    setDraft('')
    set({ q: null, tree: null, communities: null, page: null, sort: null, order: null, mode: null }, { push: true })
  }
  const applyTree = (next: QueryNode | null) => set({ tree: next ? JSON.stringify(next) : null, page: null }, { push: true })
  const addRules = (extra: Parameters<typeof withRules>[1]) => applyTree(withRules(tree, extra))

  const exportRows = async (format: 'csv' | 'json', all: boolean) => {
    let data = rows
    if (all && exploreRequest) {
      const hide = message.loading('Collecting matches…', 0)
      try {
        const collected: ResultRow[] = []
        for (let p = 1; collected.length < EXPORT_LIMIT; p += 1) {
          const chunk = await api.explore({ ...exploreRequest, page: p, page_size: 200, highlight: false })
          collected.push(...chunk.items.map((i) => ({ ...i, highlights: [] })))
          if (chunk.items.length < 200 || p >= chunk.pages) break
        }
        data = collected.slice(0, EXPORT_LIMIT)
      } catch (e) {
        message.error((e as Error).message)
        return
      } finally {
        hide()
      }
    }
    const plain = data.map((r) => ({
      id: r.id,
      external_id: r.external_id,
      text: r.text,
      community_id: r.community_id ?? null,
      source: r.source ?? null,
      length: r.length ?? null,
      updated_at: r.updated_at ?? null,
      score: r.score ?? null,
      metadata: r.metadata ?? null,
    }))
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '')
    if (format === 'json') downloadText(`documents-${stamp}.json`, JSON.stringify(plain, null, 2), 'application/json')
    else
      downloadText(
        `documents-${stamp}.csv`,
        toCsv(plain, ['id', 'external_id', 'text', 'community_id', 'source', 'length', 'updated_at', 'score', 'metadata'].map((key) => ({ key, label: key }))),
        'text/csv',
      )
    message.success(`Exported ${plain.length.toLocaleString()} documents`)
  }

  // ------------------------------------------------------------------ advanced conditions
  const fields = catalogue.data?.fields ?? []
  const labels = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f.label])), [fields])
  const usePreview = (draftTree: QueryNode | null): PreviewState => {
    const previewTree = quickCommunities.length ? withRules(draftTree, [rule.communities(quickCommunities)]) : draftTree
    const preview = useQuery({
      queryKey: ['explore-preview', previewTree, ranked ? '' : q],
      queryFn: ({ signal }) =>
        api.explore({ query_text: ranked ? '' : q, condition_tree: previewTree, page: 1, page_size: 1, highlight: false }, signal),
      placeholderData: keepPreviousData,
      retry: false,
    })
    return { count: preview.data?.total ?? null, text: preview.data?.condition_text, loading: preview.isFetching, error: preview.error ? (preview.error as Error).message : null }
  }
  const presets = useMemo<ConditionPreset[]>(() => {
    const largestSource = fields.find((f) => f.name === 'source')?.choices[0]
    return [
      { label: 'Not clustered yet', tree: treeFromRules([rule.unclustered()]), hint: 'Added or changed since the last Leiden run' },
      {
        label: 'In no community',
        tree: treeFromRules([rule.clustered(), rule.unassigned()]),
        hint: 'Clustered, but too loosely linked to join a community of two or more',
      },
      { label: 'Long documents', tree: treeFromRules([rule.lengthAtLeast(500)]), hint: 'At least 500 characters' },
      { label: 'Short documents', tree: treeFromRules([{ field: 'length', operator: 'less', value: [80] }]), hint: 'Under 80 characters' },
      {
        label: 'Changed in the last day',
        tree: treeFromRules([{ field: 'updated_at', operator: 'greater', value: [new Date(Date.now() - 86_400_000).toISOString().slice(0, 19)] }]),
      },
      ...(largestSource ? [{ label: `From ${largestSource.label}`, tree: treeFromRules([rule.source(String(largestSource.value))]) }] : []),
      {
        label: 'Mentions A or B, not C',
        tree: {
          ...treeFromRules([
            { field: 'text', operator: 'any_words', value: ['railway train'] },
            { field: 'text', operator: 'not_like', value: ['football'] },
          ]),
        },
        hint: 'An example to edit: any of two words, and not a third',
      },
    ]
  }, [fields])

  // ------------------------------------------------------------------ table
  const depth = Math.max(size * 3, 50)
  const columns: ColumnsType<ResultRow & { position: number }> = [
    { title: '#', dataIndex: 'position', width: 56, align: 'right', render: (p: number) => <span className="sl-result-pos">{p}</span> },
    {
      title: 'Document',
      key: 'text',
      className: 'sl-cell-text',
      render: (_, row) => (
        <div>
          <div>
            <ResultText row={row} rows={2} />
          </div>
          <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
            {row.external_id}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: 'Community',
      dataIndex: 'community_id',
      key: 'community_id',
      width: 130,
      sorter: !ranked,
      sortOrder: !ranked && sort === 'community_id' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (id: number | null) => <CommunityKey id={id} />,
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 170,
      ellipsis: true,
      responsive: ['lg'],
      sorter: !ranked,
      sortOrder: !ranked && sort === 'source' ? (order === 'asc' ? 'ascend' : 'descend') : null,
      render: (v: string | null) => v ?? '—',
    },
    ...(ranked
      ? [
          {
            title: <Tooltip title="Click a score to see which engine ranked the document where">Score</Tooltip>,
            key: 'score',
            width: 120,
            render: (_: unknown, row: ResultRow) =>
              row.explain ? (
                <Popover content={<Explain explain={row.explain} depth={depth} />} title="Why this result" trigger="click">
                  <Button type="text" onClick={(e) => e.stopPropagation()} icon={<InfoCircleOutlined />}>
                    {fmtScore(row.score, mode === 'hybrid' ? 4 : 3)}
                  </Button>
                </Popover>
              ) : (
                fmtScore(row.score)
              ),
          },
        ]
      : [
          {
            title: 'Length',
            dataIndex: 'length',
            key: 'length',
            width: 100,
            align: 'right' as const,
            responsive: ['md' as const],
            sorter: true,
            sortOrder: sort === 'length' ? ((order === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend') : null,
            render: (v: number) => fmtInt(v),
          },
          {
            title: 'Updated',
            dataIndex: 'updated_at',
            key: 'updated_at',
            width: 130,
            responsive: ['md' as const],
            sorter: true,
            sortOrder: sort === 'updated_at' ? ((order === 'asc' ? 'ascend' : 'descend') as 'ascend' | 'descend') : null,
            render: (v: string) => <Tooltip title={v ? new Date(v).toLocaleString() : ''}>{fmtRelative(v)}</Tooltip>,
          },
        ]),
    {
      title: 'Metadata',
      key: 'metadata',
      width: 200,
      responsive: ['xl'],
      render: (_, row) => (
        <Space size={[4, 4]} wrap>
          {Object.entries(row.metadata ?? {})
            .slice(0, 3)
            .map(([k, v]) => (
              <Tag key={k} bordered={false}>
                {k}: {String(v)}
              </Tag>
            ))}
        </Space>
      ),
    },
    {
      title: <span className="sr-only">Actions</span>,
      key: 'actions',
      width: 92,
      fixed: 'right',
      render: (_, row) => (
        <Space size={0}>
          <Tooltip title="Open this document">
            <Button
              type="text"
              icon={<EyeOutlined />}
              aria-label={`Open ${row.external_id}`}
              onClick={(e) => {
                e.stopPropagation()
                drawer.open(row.id)
              }}
            />
          </Tooltip>
          <Tooltip title="Show its neighbourhood in the graph">
            <Button
              type="text"
              icon={<ApartmentOutlined />}
              aria-label={`Show ${row.external_id} in the graph`}
              onClick={(e) => {
                e.stopPropagation()
                navigate(links.graph({ focus: row.id }))
              }}
            />
          </Tooltip>
        </Space>
      ),
    },
  ]

  // ------------------------------------------------------------------ render
  const corpusEmpty = stats?.documents === 0
  const communityOptions = communities.map((c) => ({
    value: c.community_id,
    label: <CommunityKey id={c.community_id} label={`C${c.community_id} · ${c.size}`} />,
    searchText: `C${c.community_id}`,
  }))
  const summary = [
    q && `“${q}”`,
    mode !== 'browse' && q ? `${mode} ranking` : 'browse',
    quickCommunities.length ? `communities ${quickCommunities.map((c) => `C${c}`).join(', ')}` : '',
    rules ? `${rules} condition${rules === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="nu-page">
      <PageHeader
        title="Explore documents"
        tag={
          active.data && (
            <Tag color="blue" bordered={false}>
              {fmtInt(total)}
              {ranked
                ? search.data?.total_lexical !== undefined
                  ? `${total >= 10_000 ? '+' : ''} keyword ${total === 1 ? 'match' : 'matches'}`
                  : ' ranked'
                : `${browse.data?.total_relation === 'gte' ? '+' : ''} ${total === 1 ? 'match' : 'matches'}`}
            </Tag>
          )
        }
        subtitle="Browse every document, or rank them by keyword, meaning or both, and narrow any view with conditions."
        actions={
          <>
            <SavedSearchButtons summary={summary} disabled={!q && !rules && !quickCommunities.length} />
            <Dropdown
              menu={{
                items: [
                  { key: 'csv', label: 'Results on screen as CSV', onClick: () => void exportRows('csv', false) },
                  { key: 'json', label: 'Results on screen as JSON', onClick: () => void exportRows('json', false) },
                  ...(!ranked
                    ? [{ key: 'all', label: `Every match as CSV (up to ${EXPORT_LIMIT.toLocaleString()})`, onClick: () => void exportRows('csv', true) }]
                    : []),
                ],
              }}
              disabled={!rows.length}
            >
              <Button icon={<DownloadOutlined />}>Export</Button>
            </Dropdown>
          </>
        }
      />

      <Card className="nu-explorer-controls" size="small">
        <div className="nu-explorer-toolbar">
          <Segmented
            value={mode}
            onChange={(next) => set({ mode: next === (q ? 'hybrid' : 'browse') ? null : String(next), page: null, sort: null, order: null })}
            options={MODE_OPTIONS.map((m) => ({ value: m.value, label: <Tooltip title={m.hint}>{m.label}</Tooltip> }))}
          />
          <SearchBox
            ref={inputRef}
            scope="explore"
            value={draft}
            onChange={setDraft}
            onSubmit={submit}
            loading={settling && !!q}
            // Say what typing will do: an explicit Browse filters; otherwise a query ranks.
            placeholder={
              params.get('mode') === 'browse'
                ? 'Filter by words or id — every match, exact count'
                : q
                  ? `Search by ${mode} relevance — any language`
                  : 'Search by meaning or words, in any language'
            }
          />
          <div className="nu-toolbar-group">
            <Badge count={rules} size="small">
              <Button icon={<FilterOutlined />} onClick={() => setAdvancedOpen(true)}>
                Advanced
              </Button>
            </Badge>
            <Tooltip title={ranked ? 'Fusion, routing, diversity and keyword matching' : 'Ranking options apply to Keyword, Semantic and Hybrid'}>
              <Badge count={tuningChanges(tuning)} size="small">
                <Button icon={<SlidersOutlined />} onClick={() => setTuningOpen(true)}>
                  Ranking
                </Button>
              </Badge>
            </Tooltip>
          </div>
        </div>
        <div className="nu-explorer-subbar">
          <Tooltip title={tuning.autoRoute && ranked ? 'Automatic routing chooses communities; turn it off under Ranking to pick them' : 'Only documents of these communities'}>
            <Select
              mode="multiple"
              allowClear
              maxTagCount="responsive"
              style={{ width: 240 }}
              placeholder="All communities"
              value={quickCommunities}
              options={communityOptions}
              showSearch
              optionFilterProp="searchText"
              disabled={tuning.autoRoute && ranked}
              onChange={(ids: number[]) => set({ communities: ids.join(',') || null, page: null })}
              aria-label="Community filter"
            />
          </Tooltip>
          {/* Each filter is shown once, by its own control: the box shows the words, the
              select the communities. Only the condition tree has no other home. */}
          {rules > 0 ? (
            <ActiveConditions text={conditionText || `${rules} condition(s)`} rules={rules} onEdit={() => setAdvancedOpen(true)} onClear={() => applyTree(null)} />
          ) : q || quickCommunities.length ? (
            <div className="nu-conditions" />
          ) : (
            <div className="nu-conditions">
              <span className="nu-conditions-label">Try</span>
              {EXAMPLES.map((example) => (
                <Chip
                  key={example}
                  icon={<SearchOutlined />}
                  onClick={() => {
                    setDraft(example)
                    set({ q: example, mode: 'hybrid', page: null }, { push: true })
                  }}
                >
                  {example}
                </Chip>
              ))}
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                or press <kbd>/</kbd> to search
              </Typography.Text>
            </div>
          )}
          {(q || rules > 0 || quickCommunities.length > 0) && (
            <Button icon={<ClearOutlined />} onClick={clearQuestion}>
              Clear all
            </Button>
          )}
        </div>
      </Card>

      {/* What the question adds up to: breakdowns while browsing, the engines' view while ranking. */}
      <Card
        size="small"
        className="nu-card"
        title={
          <Space>
            <NodeIndexOutlined />
            {ranked ? 'How the engines answered' : 'What these documents add up to'}
          </Space>
        }
        extra={
          <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <Switch size="small" checked={insightsOpen} onChange={setInsightsOpen} aria-label="Show insights" />
            Insights
          </label>
        }
        styles={{ body: insightsOpen ? undefined : { display: 'none' } }}
      >
        {insightsOpen &&
          (ranked ? (
            search.data ? (
              <Space direction="vertical" style={{ width: '100%' }} size={12}>
                <Timings timings={search.data.timings} />
                <Warnings warnings={search.data.warnings} />
                <div className="nu-insights">
                  {search.data.routing && <RoutingCard routing={search.data.routing} />}
                  <FacetCard response={search.data} selected={quickCommunities} onToggle={toggleCommunity} />
                </div>
              </Space>
            ) : (
              <Skeleton active paragraph={{ rows: 2 }} />
            )
          ) : (
            <Space direction="vertical" style={{ width: '100%' }} size={12}>
              <div className="nu-kpis nu-kpis--4">
                <StatCard label="Matching documents" value={fmtInt(insights.data?.metrics.documents)} loading={!insights.data} icon={<FileTextOutlined />} />
                <StatCard
                  label="Communities"
                  value={fmtInt(insights.data?.metrics.communities)}
                  loading={!insights.data}
                  icon={<ApartmentOutlined />}
                  accent="info"
                  hint="Distinct Leiden communities among the matches"
                />
                <StatCard
                  label={NO_COMMUNITY}
                  value={fmtInt(insights.data?.metrics.unassigned)}
                  loading={!insights.data}
                  accent={insights.data?.metrics.unassigned ? 'warning' : 'neutral'}
                  icon={<FilterOutlined />}
                  hint={
                    insights.data
                      ? `${fmtInt(insights.data.metrics.unclustered ?? 0)} not clustered yet · ${fmtInt(insights.data.metrics.outside_communities ?? 0)} too loosely linked`
                      : undefined
                  }
                  onClick={insights.data?.metrics.unassigned ? () => addRules([rule.unassigned()]) : undefined}
                />
                <StatCard
                  label="Average length"
                  value={insights.data?.metrics.avg_length ? `${fmtInt(Math.round(insights.data.metrics.avg_length))} chars` : '—'}
                  loading={!insights.data}
                  accent="neutral"
                  icon={<BarsOutlined />}
                  hint={insights.data ? `${fmtInt(insights.data.metrics.min_length)}–${fmtInt(insights.data.metrics.max_length)} characters` : undefined}
                />
              </div>
              <div className="nu-chart-grid">
                <div className="nu-span-8">
                  <ChartCard
                    id="explore-communities"
                    title="Matches by community"
                    description="Click a bar to keep only that community."
                    height={200}
                    option={
                      insights.data
                        ? barOption(chartTheme, {
                            categories: insights.data.communities.map((b) => communityLabel(b.value as number | null)),
                            values: insights.data.communities.map((b) => b.count),
                            colors: insights.data.communities.map((b) => communityColor(b.value as number | null)),
                            name: 'Documents',
                          })
                        : null
                    }
                    rows={(insights.data?.communities ?? []).map((b) => ({ community: communityLabel(b.value as number | null), documents: b.count }))}
                    columns={[
                      { key: 'community', label: 'Community' },
                      { key: 'documents', label: 'Documents' },
                    ]}
                    loading={!insights.data && insights.isFetching}
                    onSelect={(name) => {
                      if (name === NO_COMMUNITY) addRules([rule.unassigned()])
                      else toggleCommunity(Number(name.slice(1)))
                    }}
                  />
                </div>
                <div className="nu-span-4">
                  <ChartCard
                    id="explore-length"
                    title="Length (characters)"
                    height={200}
                    option={
                      insights.data
                        ? barOption(chartTheme, {
                            categories: insights.data.length_buckets.map((b) => b.label),
                            values: insights.data.length_buckets.map((b) => b.count),
                            name: 'Documents',
                          })
                        : null
                    }
                    rows={(insights.data?.length_buckets ?? []).map((b) => ({ length: b.label, documents: b.count }))}
                    columns={[
                      { key: 'length', label: 'Length' },
                      { key: 'documents', label: 'Documents' },
                    ]}
                    loading={!insights.data && insights.isFetching}
                    onSelect={(_, index) => {
                      const bucket = insights.data?.length_buckets[index]
                      if (!bucket) return
                      addRules([bucket.to === null ? rule.lengthAtLeast(bucket.from ?? 0) : rule.lengthBetween(bucket.from ?? 0, bucket.to - 1)])
                    }}
                  />
                </div>
              </div>
            </Space>
          ))}
      </Card>

      <Card
        className="nu-explorer-results"
        size="small"
        title={
          <Space size={10} wrap>
            <BarsOutlined />
            <span>{ranked ? `Top ${rows.length} by ${mode} relevance` : 'Documents'}</span>
            {!ranked && browse.data && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                sorted by {sort === '_score' ? 'relevance' : sort.replace('_', ' ')} {sort !== '_score' ? (order === 'asc' ? '↑' : '↓') : ''} · {browse.data.took_ms} ms
              </Typography.Text>
            )}
            {settling && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                Updating…
              </Typography.Text>
            )}
          </Space>
        }
        extra={
          <Segmented
            size="small"
            value={view}
            onChange={(next) => set({ view: next === defaultView ? null : String(next) })}
            options={[
              { value: 'table', icon: <TableOutlined />, label: 'Table' },
              { value: 'list', icon: <BarsOutlined />, label: 'List' },
              { value: 'cards', icon: <AppstoreOutlined />, label: 'Cards' },
            ]}
          />
        }
      >
        {error && (
          <Alert
            type={error instanceof ApiError && error.status === 409 ? 'info' : 'error'}
            showIcon
            message={error instanceof ApiError && error.code === 'not_clustered' ? 'Clustering has not run yet' : 'This question could not be run'}
            description={error.message}
            action={
              error instanceof ApiError && error.code === 'not_clustered' ? (
                <Button onClick={() => navigate('/operations')}>Go to operations</Button>
              ) : undefined
            }
          />
        )}
        {corpusEmpty ? (
          <EmptyState
            title="The corpus is empty"
            hint="Import a CSV with an id and a text column to start exploring."
            action={
              <Button type="primary" onClick={() => navigate('/import')}>
                Import a CSV
              </Button>
            }
          />
        ) : active.isLoading ? (
          <div className="nu-results-pad">
            <Skeleton active paragraph={{ rows: 8 }} />
          </div>
        ) : !error && rows.length === 0 && active.data ? (
          <NoResults onClear={clearQuestion} />
        ) : view === 'table' ? (
          <Table
            rowKey="id"
            size="middle"
            columns={columns}
            dataSource={rows.map((row, i) => ({ ...row, position: ranked ? i + 1 : (page - 1) * size + i + 1 }))}
            scroll={{ x: 900 }}
            style={{ opacity: settling ? 0.65 : 1, transition: 'opacity .15s' }}
            onRow={(row) => ({
              onClick: () => drawer.open(row.id),
              onKeyDown: (e) => e.key === 'Enter' && drawer.open(row.id),
              tabIndex: 0,
              style: { cursor: 'pointer' },
            })}
            pagination={
              ranked
                ? false
                : {
                    current: page,
                    pageSize: size,
                    total: Math.min(browse.data?.total ?? 0, 10_000),
                    showSizeChanger: true,
                    pageSizeOptions: [10, 25, 50, 100, 200],
                    showTotal: (t, range) => `${range[0]}–${range[1]} of ${fmtInt(browse.data?.total ?? t)}`,
                    style: { padding: '0 16px' },
                  }
            }
            onChange={(pagination, _filters, sorter) => {
              const s = (Array.isArray(sorter) ? sorter[0] : sorter) as SorterResult<ResultRow & { position: number }> | undefined
              const field = s?.columnKey ? String(s.columnKey) : ''
              const changes: Record<string, string | number | null> = {}
              if (!ranked && (pagination.current !== page || pagination.pageSize !== size)) {
                changes.page = pagination.pageSize !== size ? null : (pagination.current ?? 1)
                changes.size = pagination.pageSize === 25 ? null : (pagination.pageSize ?? 25)
              }
              if (!ranked && s) {
                if (s.order && SORTABLE.has(field)) {
                  changes.sort = field
                  changes.order = s.order === 'ascend' ? 'asc' : 'desc'
                  changes.page = null
                } else if (!s.order && params.get('sort')) {
                  changes.sort = null
                  changes.order = null
                }
              }
              if (Object.keys(changes).length) set(changes)
            }}
            locale={{ emptyText: <NoResults onClear={clearQuestion} /> }}
          />
        ) : (
          <div className={`sl-results${view === 'cards' ? ' sl-results--cards' : ''}`} style={{ opacity: settling ? 0.65 : 1 }}>
            {rows.map((row, i) => (
              <ResultCard key={row.id} row={row} position={ranked ? i + 1 : (page - 1) * size + i + 1} mode={ranked ? (mode as SearchMode) : 'browse'} depth={depth} />
            ))}
          </div>
        )}
        {/* Ranked lists grow instead of paging: a page boundary interrupts a read that had no reason to stop. */}
        {ranked && rows.length > 0 && (
          <div className="nu-results-pad" style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12 }}>
            <Typography.Text type="secondary">
              {rows.length} ranked result{rows.length === 1 ? '' : 's'}
              {search.data?.total_lexical !== undefined
                ? ` · ${fmtInt(search.data.total_lexical)}${search.data.total_lexical >= 10_000 ? '+' : ''} keyword matches`
                : ''}
            </Typography.Text>
            {size < 200 && rows.length >= size && (
              <Button onClick={() => set({ size: Math.min(200, size + 25) })} loading={search.isFetching}>
                Show 25 more
              </Button>
            )}
          </div>
        )}
        {!ranked && view !== 'table' && browse.data && browse.data.pages > 1 && (
          <div className="nu-results-pad" style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
            <Button disabled={page <= 1} onClick={() => set({ page: page - 1 > 1 ? page - 1 : null })}>
              Previous
            </Button>
            <Typography.Text type="secondary" style={{ alignSelf: 'center' }}>
              Page {page} of {fmtInt(browse.data.pages)}
            </Typography.Text>
            <Button disabled={page >= browse.data.pages} onClick={() => set({ page: page + 1 })}>
              Next
            </Button>
          </div>
        )}
      </Card>

      <AdvancedConditionsDrawer
        open={advancedOpen}
        noun="documents"
        engine="Elasticsearch — the same tree filters keyword search and pre-filters semantic search"
        fields={fields}
        value={tree}
        onClose={() => setAdvancedOpen(false)}
        onApply={applyTree}
        usePreview={usePreview}
        presets={presets}
        extraHelp={
          catalogue.isError ? (
            <Typography.Text type="danger">The field catalogue could not be loaded.</Typography.Text>
          ) : (
            <>
              {Object.keys(labels).length} fields available, including metadata columns from your CSVs.
            </>
          )
        }
      />
      <SearchTuningDrawer
        open={tuningOpen}
        onClose={() => setTuningOpen(false)}
        mode={mode === 'browse' ? 'hybrid' : mode}
        tuning={tuning}
        onChange={setTuning}
      />

      <PageDoc doc={PAGE_DOCS.explore} />
    </div>
  )
}
