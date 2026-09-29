/**
 * `/graph` — the k-nearest-neighbour similarity graph Leiden clusters.
 *
 * Two questions, answered by two mechanisms suited to them:
 * - **What to draw** is a server question: the strongest links, chosen
 *   communities, one document's neighbourhood, or the documents a search
 *   returns (`POST /graph/query`: keyword / semantic / hybrid ranking plus the
 *   same condition tree as Explore, optionally with their neighbours).
 * - **What to look at** is a browser question: highlight conditions over the
 *   nodes on screen (community, degree, strength, text, whether a search
 *   returned it), evaluated locally and instantly, dimming or hiding the rest.
 *
 * The renderer is the canvas + d3-force one from v0.3, unchanged in capability.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  Alert,
  Badge,
  Button,
  Card,
  Grid,
  InputNumber,
  Popover,
  Segmented,
  Select,
  Slider,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type { GetRef } from 'antd'
import {
  AimOutlined,
  ApartmentOutlined,
  BranchesOutlined,
  CameraOutlined,
  CaretRightOutlined,
  ClusterOutlined,
  ExpandOutlined,
  EyeOutlined,
  FilterOutlined,
  HighlightOutlined,
  PauseOutlined,
  QuestionCircleOutlined,
  SearchOutlined,
  ShareAltOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { keys, useCommunities, useConfig, useExploreFields } from '@/api/hooks'
import type { GraphData, GraphQueryResult, QueryNode, SearchMode } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { CommunityKey } from '@/components/CommunityKey'
import { FilterChip } from '@/components/Chip'
import { useDocumentDrawer } from '@/components/DocumentDrawer'
import { EmptyState } from '@/components/EmptyState'
import { CANVAS_PALETTES, GraphCanvas, type GraphCanvasHandle, type SimNode } from '@/components/graph/GraphCanvas'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { ActiveConditions, AdvancedConditionsDrawer, type ConditionPreset, type PreviewState } from '@/components/query/AdvancedConditionsDrawer'
import { describeTreeLocally, matchesTree, type EvalRecord } from '@/components/query/evaluate'
import type { BuilderField } from '@/components/query/queryBuilderConfig'
import { countRules, treeFromRules } from '@/components/query/queryTree'
import { SavedSearchButtons } from '@/components/SavedSearches'
import { MODES } from '@/components/search/defaults'
import { SearchBox } from '@/components/search/SearchBox'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion'
import { parseIds, parseJson, positiveInt, similarityBand, useUrlState } from '@/hooks/useUrlState'
import { fmtInt, fmtScore } from '@/lib/format'
import { links, rule } from '@/lib/links'
import { communityColor, communityLabel } from '@/lib/palette'
import { useAppearance } from '@/theme/AppearanceProvider'

type View = 'top' | 'communities' | 'focus' | 'query'

const EDGE_LIMITS = [250, 500, 1000, 2000, 5000]
/** The API's ceiling for `GET /graph?limit=`; a custom count is clamped to it. */
const MAX_EDGES = 10_000
/** Above this the canvas layout takes seconds rather than moments. */
const LARGE_EDGES = 5_000

/**
 * How many edges to draw: the presets, or "Custom…" and a number. The number applies on
 * Enter, on leaving the box, or after a pause in typing — never on every keystroke.
 */
function EdgeLimit({ limit, onChange }: { limit: number; onChange: (value: number) => void }) {
  const [custom, setCustom] = useState(!EDGE_LIMITS.includes(limit))
  const [typed, setTyped] = useState<number | null>(limit)
  const box = useRef<GetRef<typeof InputNumber>>(null)
  const focusBox = useRef(false)
  // Chosen from the list: the number is what comes next. The Select takes focus back as
  // its dropdown closes, so the box is focused after that, not on mount.
  useEffect(() => {
    if (!custom || !focusBox.current) return
    focusBox.current = false
    const timer = window.setTimeout(() => {
      box.current?.focus()
      box.current?.select()
    }, 60)
    return () => window.clearTimeout(timer)
  }, [custom])
  useEffect(() => {
    setTyped(limit)
    if (!EDGE_LIMITS.includes(limit)) setCustom(true)
  }, [limit])
  const commit = useCallback(
    (value: number | null) => {
      if (value === null || !Number.isFinite(value)) return
      const next = Math.min(MAX_EDGES, Math.max(1, Math.round(value)))
      if (next !== limit) onChange(next)
    },
    [limit, onChange],
  )
  useEffect(() => {
    if (!custom || typed === limit) return
    const timer = window.setTimeout(() => commit(typed), 700)
    return () => window.clearTimeout(timer)
  }, [custom, typed, limit, commit])

  return (
    <Space.Compact>
      <Select
        style={{ width: custom ? 118 : 140 }}
        value={custom ? 'custom' : limit}
        onChange={(value: number | 'custom') => {
          if (value === 'custom') {
            focusBox.current = true
            return setCustom(true)
          }
          setCustom(false)
          onChange(value)
        }}
        options={[...EDGE_LIMITS.map((v) => ({ value: v, label: `${fmtInt(v)} edges` })), { value: 'custom' as const, label: 'Custom…' }]}
        aria-label="Edge limit"
      />
      {custom && (
        <Tooltip title={`1 to ${fmtInt(MAX_EDGES)} edges, strongest first. Above ${fmtInt(LARGE_EDGES)} the layout takes a few seconds.`}>
          <InputNumber
            ref={box}
            style={{ width: 128 }}
            min={1}
            max={MAX_EDGES}
            step={100}
            precision={0}
            value={typed}
            onChange={(value) => setTyped(value)}
            onPressEnter={() => commit(typed)}
            onBlur={() => commit(typed)}
            formatter={(value) => (value === undefined ? '' : fmtInt(Number(value)))}
            parser={(text) => Number((text ?? '').replace(/[^\d]/g, ''))}
            status={typed !== null && typed > LARGE_EDGES ? 'warning' : undefined}
            suffix="edges"
            aria-label="Number of edges to draw"
          />
        </Tooltip>
      )}
    </Space.Compact>
  )
}
const SEED_LIMITS = [25, 50, 100, 150, 200, 500, 1000]

/**
 * The two band handles stop one step apart instead of crossing (crossed handles swap roles,
 * so the one being moved would silently become the other bound; rc-slider also lets equal
 * handles pass each other, hence the one-step gap). `allowCross` and `pushable` are
 * rc-slider props that antd forwards but does not declare.
 */
const NO_HANDLE_CROSSING = { allowCross: false, pushable: 0.01 } as object

const VIEWS: { value: View; label: string; icon: React.ReactNode; hint: string }[] = [
  { value: 'top', label: 'Strongest links', icon: <ShareAltOutlined />, hint: 'The highest-similarity edges of the whole graph' },
  { value: 'communities', label: 'Communities', icon: <ClusterOutlined />, hint: 'Only edges inside the communities you choose' },
  { value: 'focus', label: 'Neighbourhood', icon: <AimOutlined />, hint: 'One document and its neighbours, 1 or 2 hops out' },
  { value: 'query', label: 'Search results', icon: <SearchOutlined />, hint: 'The documents a search or conditions return, and how they link' },
]

/** Node attributes the highlight conditions can test, all computed from what is on screen. */
function highlightFields(communityChoices: { value: number | string; label: string; count: number }[], hasSeeds: boolean): BuilderField[] {
  return [
    { name: 'text', label: 'Text', kind: 'fulltext', operators: ['like', 'not_like', 'any_words', 'phrase'] },
    { name: 'external_id', label: 'External ID', kind: 'keyword', operators: ['equal', 'not_equal', 'like', 'not_like', 'starts_with', 'ends_with'] },
    {
      name: 'community_id',
      label: 'Community',
      kind: 'community',
      operators: ['select_equals', 'select_not_equals', 'select_any_in', 'select_not_any_in', 'is_null', 'is_not_null'],
      choices: communityChoices,
    },
    {
      name: 'degree',
      label: 'Links in view',
      kind: 'number',
      operators: ['equal', 'not_equal', 'less', 'less_or_equal', 'greater', 'greater_or_equal', 'between'],
      min: 0,
      description: 'How many edges the node has among the drawn ones',
    },
    {
      name: 'strength',
      label: 'Link strength in view',
      kind: 'number',
      operators: ['less', 'less_or_equal', 'greater', 'greater_or_equal', 'between'],
      min: 0,
      step: 0.1,
      description: 'Sum of the similarity scores of its drawn edges',
    },
    {
      name: 'best_link',
      label: 'Strongest link',
      kind: 'number',
      operators: ['less', 'less_or_equal', 'greater', 'greater_or_equal', 'between'],
      min: -1,
      max: 1,
      step: 0.01,
    },
    ...(hasSeeds
      ? [
          { name: 'seed', label: 'Returned by the search', kind: 'boolean' as const, operators: ['equal'] },
          { name: 'seed_rank', label: 'Search rank', kind: 'number' as const, operators: ['less', 'less_or_equal', 'greater', 'between'], min: 1 },
        ]
      : []),
  ]
}

export default function GraphPage() {
  const navigate = useNavigate()
  const drawer = useDocumentDrawer()
  const screens = Grid.useBreakpoint()
  const reducedMotion = usePrefersReducedMotion()
  const { mode: appearance } = useAppearance()
  const canvasRef = useRef<GraphCanvasHandle>(null)
  const [params, set] = useUrlState()
  const { data: communities = [] } = useCommunities()
  const catalogue = useExploreFields()
  // Edges are only stored above the build threshold, so a band below it is always empty.
  const buildThreshold = useConfig().data?.policy.min_similarity

  // ------------------------------------------------------------------ the question, from the URL
  const view: View = (['top', 'communities', 'focus', 'query'].includes(params.get('view') ?? '')
    ? params.get('view')
    : params.get('focus')
      ? 'focus'
      : 'top') as View
  const limit = Math.min(MAX_EDGES, positiveInt(params.get('limit'), 1000))
  // The similarity band: only edges with min ≤ score ≤ max are drawn. A hand-edited URL
  // with the bounds crossed is read as the band between them.
  const [minScore, maxScore] = similarityBand(params.get('min'), params.get('max'))
  const chosen = useMemo(() => parseIds(params.get('communities')), [params])
  const focus = params.get('focus')
  const hops = params.get('hops') === '2' ? 2 : 1
  const q = params.get('q') ?? ''
  const searchMode = ((params.get('mode') as SearchMode | null) ?? 'hybrid') as SearchMode
  const docTree = useMemo(() => parseJson<QueryNode>(params.get('tree')), [params])
  const seedLimit = positiveInt(params.get('seeds'), 150)
  const expand = params.get('expand') === '1'
  const hlTree = useMemo(() => parseJson<QueryNode>(params.get('hl')), [params])
  const hideUnmatched = params.get('hlmode') === 'hide'

  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [paused, setPaused] = useState(false)
  const [selected, setSelected] = useState<SimNode | null>(null)
  const [draft, setDraft] = useState(q)
  const [docTreeOpen, setDocTreeOpen] = useState(false)
  const [hlOpen, setHlOpen] = useState(false)
  const debouncedMin = useDebouncedValue(minScore, 250)
  const debouncedMax = useDebouncedValue(maxScore, 250)
  // The slider moves from its own state: the URL updates asynchronously, and a held arrow
  // key computing each step from the not-yet-updated URL value would drop steps.
  const [band, setBand] = useState<[number, number]>([minScore, maxScore])
  useEffect(() => setBand([minScore, maxScore]), [minScore, maxScore])

  // ------------------------------------------------------------------ what to draw (server)
  const queryParams = useMemo(() => {
    switch (view) {
      case 'focus':
        return focus ? { view, focus, hops, minScore: debouncedMin, maxScore: debouncedMax, nodeLimit: Math.min(limit, 1000) } : null
      case 'communities':
        return chosen.length ? { view, limit, minScore: debouncedMin, maxScore: debouncedMax, chosen } : null
      case 'query':
        return q.trim() || countRules(docTree)
          ? { view, q: q.trim(), searchMode, docTree, seedLimit, expand, minScore: debouncedMin, maxScore: debouncedMax }
          : null
      default:
        return { view, limit, minScore: debouncedMin, maxScore: debouncedMax }
    }
  }, [view, focus, hops, debouncedMin, debouncedMax, limit, chosen, q, searchMode, docTree, seedLimit, expand])

  const graph = useQuery<GraphData & Partial<GraphQueryResult>>({
    queryKey: keys.graph(queryParams ?? {}),
    enabled: !!queryParams,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
    queryFn: ({ signal }) => {
      const band = { minScore: debouncedMin, maxScore: debouncedMax }
      if (view === 'focus') return api.egoGraph(focus!, { hops, nodeLimit: Math.min(limit, 1000), ...band }, signal)
      if (view === 'communities') return api.graph({ limit, ...band, communityIds: chosen }, signal)
      if (view === 'query')
        return api.graphQuery(
          {
            query: q.trim(),
            mode: searchMode,
            condition_tree: docTree,
            limit: seedLimit,
            expand,
            neighbor_limit: 300,
            min_score: debouncedMin,
            max_score: debouncedMax,
          },
          signal,
        )
      return api.graph({ limit, ...band }, signal)
    },
  })
  const data = queryParams ? graph.data : undefined

  // ------------------------------------------------------------------ what to look at (browser)
  const seeds = useMemo(() => new Set((data?.seeds ?? []).map((s) => s.id)), [data])
  const records = useMemo(() => {
    const degree = new Map<string, number>()
    const strength = new Map<string, number>()
    const best = new Map<string, number>()
    for (const l of data?.links ?? []) {
      for (const id of [l.source, l.target]) {
        degree.set(id, (degree.get(id) ?? 0) + 1)
        strength.set(id, (strength.get(id) ?? 0) + l.score)
        best.set(id, Math.max(best.get(id) ?? -1, l.score))
      }
    }
    const rank = new Map((data?.seeds ?? []).map((s) => [s.id, s.rank]))
    return new Map<string, EvalRecord>(
      (data?.nodes ?? []).map((n) => [
        n.id,
        {
          text: n.text,
          external_id: n.external_id ?? '',
          community_id: n.community_id,
          degree: degree.get(n.id) ?? 0,
          strength: Math.round((strength.get(n.id) ?? 0) * 1000) / 1000,
          best_link: best.has(n.id) ? best.get(n.id) : null,
          seed: seeds.has(n.id),
          seed_rank: rank.get(n.id) ?? null,
        },
      ]),
    )
  }, [data, seeds])

  const highlight = useMemo(() => {
    if (!countRules(hlTree)) return null
    const lit = new Set<string>()
    for (const [id, record] of records) if (matchesTree(hlTree, record)) lit.add(id)
    return lit
  }, [hlTree, records])

  const legend = useMemo(() => {
    const counts = new Map<string, { id: number | null; count: number }>()
    for (const n of data?.nodes ?? []) {
      const key = n.community_id === null ? 'none' : String(n.community_id)
      const entry = counts.get(key) ?? { id: n.community_id, count: 0 }
      entry.count += 1
      counts.set(key, entry)
    }
    return [...counts.entries()].sort((a, b) => b[1].count - a[1].count)
  }, [data])

  const communityChoices = useMemo(
    () => legend.filter(([, e]) => e.id !== null).map(([, e]) => ({ value: e.id as number, label: `C${e.id}`, count: e.count })),
    [legend],
  )
  const hlFields = useMemo(() => highlightFields(communityChoices, seeds.size > 0), [communityChoices, seeds])
  const hlLabels = useMemo(() => Object.fromEntries(hlFields.map((f) => [f.name, f.label])), [hlFields])

  const nodeOptions = useMemo(
    () => (data?.nodes ?? []).map((n) => ({ value: n.id, label: `${n.external_id ?? n.id.slice(0, 8)}  ${n.text.slice(0, 70)}` })),
    [data],
  )

  const toggle = (key: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const onSelect = useCallback((node: SimNode | null) => setSelected(node), [])

  // Arriving at a neighbourhood ("Show in graph", "Neighbourhood") selects its centre,
  // so it is marked, its links are emphasised and its card is open. Child effects run
  // first, so the canvas already holds the new nodes here.
  const centerId = view === 'focus' ? focus : null
  useEffect(() => {
    if (centerId && data?.nodes.some((n) => n.id === centerId)) canvasRef.current?.selectNode(centerId)
  }, [centerId, data])

  // ------------------------------------------------------------------ neighbourhood document picker
  const [pickerTerm, setPickerTerm] = useState('')
  const debouncedPicker = useDebouncedValue(pickerTerm, 300)
  const picker = useQuery({
    queryKey: ['graph-picker', debouncedPicker, focus],
    enabled: view === 'focus',
    queryFn: async ({ signal }) => {
      const result = await api.explore({ query_text: debouncedPicker, page: 1, page_size: 20, highlight: false, sort: debouncedPicker ? '_score' : 'updated_at' }, signal)
      const items = result.items
      if (focus && !items.some((i) => i.id === focus)) {
        const current = await api.document(focus, signal).catch(() => null)
        if (current) items.unshift({ ...current })
      }
      return items
    },
    placeholderData: keepPreviousData,
  })

  // ------------------------------------------------------------------ previews for the two drawers
  const useDocPreview = (draftTree: QueryNode | null): PreviewState => {
    const preview = useQuery({
      queryKey: ['explore-preview', draftTree, ''],
      queryFn: ({ signal }) => api.explore({ condition_tree: draftTree, page: 1, page_size: 1, highlight: false }, signal),
      placeholderData: keepPreviousData,
      retry: false,
    })
    return { count: preview.data?.total ?? null, text: preview.data?.condition_text, loading: preview.isFetching, error: preview.error ? (preview.error as Error).message : null }
  }
  const useHighlightPreview = (draftTree: QueryNode | null): PreviewState => {
    let count = 0
    for (const record of records.values()) if (matchesTree(draftTree, record)) count += 1
    return { count: countRules(draftTree) ? count : records.size, text: describeTreeLocally(draftTree, hlLabels) }
  }
  const hlPresets = useMemo<ConditionPreset[]>(
    () => [
      { label: 'Hubs (8+ links)', tree: treeFromRules([{ field: 'degree', operator: 'greater_or_equal', value: [8] }]), hint: 'Documents with many neighbours in view' },
      { label: 'Loosely attached', tree: treeFromRules([{ field: 'degree', operator: 'less_or_equal', value: [1] }]), hint: 'One link or none in view' },
      { label: 'Near-duplicates', tree: treeFromRules([{ field: 'best_link', operator: 'greater_or_equal', value: [0.95] }]), hint: 'A neighbour with similarity ≥ 0.95' },
      { label: 'In no community', tree: treeFromRules([{ field: 'community_id', operator: 'is_null', value: [] }]), hint: 'Too loosely linked to join a community, or not clustered yet' },
      ...(seeds.size ? [{ label: 'Search results only', tree: treeFromRules([{ field: 'seed', operator: 'equal', value: [true] }]) }] : []),
      ...(communityChoices[0]
        ? [{ label: `Community C${communityChoices[0].value}`, tree: treeFromRules([rule.communities([communityChoices[0].value as number])]) }]
        : []),
    ],
    [seeds, communityChoices],
  )

  // ------------------------------------------------------------------ render
  const palette = CANVAS_PALETTES[appearance]
  const communityOptions = communities.map((c) => ({
    value: c.community_id,
    label: <CommunityKey id={c.community_id} label={`C${c.community_id} · ${c.size}`} />,
    searchText: `C${c.community_id}`,
  }))
  const hlRules = countRules(hlTree)
  const docRules = countRules(docTree)
  const bandIsSet = minScore > 0 || maxScore < 1
  const similarityControl = (
    <Tooltip
      title={`Draw only edges whose cosine similarity is inside this band. Raise the minimum to keep strong links; lower the maximum to hide near-duplicates and see the weaker links between topics.${
        buildThreshold !== undefined ? ` Edges exist from ${buildThreshold.toFixed(2)}, the graph's build threshold.` : ''
      }`}
    >
      <div style={{ width: 300, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          Similarity {band[0].toFixed(2)}–{band[1].toFixed(2)}
        </Typography.Text>
        <Slider
          range
          style={{ flex: 1 }}
          min={0}
          max={1}
          step={0.01}
          value={band}
          onChange={([low, high]: number[]) => {
            setBand([low, high])
            set({ min: low > 0 ? low : null, max: high < 1 ? high : null })
          }}
          ariaLabelForHandle={['Minimum edge similarity', 'Maximum edge similarity']}
          {...NO_HANDLE_CROSSING}
        />
      </div>
    </Tooltip>
  )
  const setLimit = useCallback((value: number) => set({ limit: value === 1000 ? null : value }), [set])
  const edgeLimit = <EdgeLimit limit={limit} onChange={setLimit} />
  const summary = [
    VIEWS.find((v) => v.value === view)?.label,
    q && `“${q}”`,
    chosen.length ? chosen.map((c) => `C${c}`).join(', ') : '',
    bandIsSet ? `similarity ${minScore.toFixed(2)}–${maxScore.toFixed(2)}` : '',
    hlRules ? `${hlRules} highlight rule${hlRules === 1 ? '' : 's'}` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const emptyHint =
    view === 'communities' && !chosen.length
      ? { title: 'Choose one or more communities', hint: 'Their internal edges will be drawn.' }
      : view === 'focus' && !focus
        ? { title: 'Pick a document', hint: 'Its neighbours, one or two hops out, will be drawn.' }
        : view === 'query' && !queryParams
          ? { title: 'Search, or add conditions', hint: 'The matching documents and the links between them will be drawn.' }
          : {
              title: 'No edges match',
              hint:
                bandIsSet && buildThreshold !== undefined && maxScore < buildThreshold
                  ? `The graph only stores edges with similarity ≥ ${buildThreshold.toFixed(2)} (its build threshold). Raise the maximum, or rebuild the graph with a lower threshold on Operations.`
                  : bandIsSet
                    ? 'No edge falls inside the similarity band: widen it, widen the question, or import documents.'
                    : 'Widen the question, or import documents.',
            }

  return (
    <div className="nu-page">
      <PageHeader
        title="Similarity graph"
        tag={
          data && (
            <Tag color="blue" bordered={false}>
              {fmtInt(data.nodes.length)} documents · {fmtInt(data.links.length)} edges
            </Tag>
          )
        }
        subtitle="How documents link by similarity; colour is the Leiden community. Choose what to draw, then highlight what matters."
        actions={<SavedSearchButtons summary={summary} disabled={view === 'top' && !hlRules} />}
      />

      <Card className="nu-explorer-controls" size="small">
        <div className="nu-toolbar-group">
          <Segmented
            value={view}
            onChange={(next) => {
              setSelected(null)
              set({ view: next === 'top' ? null : String(next) }, { push: true })
            }}
            // Icons only on a phone: four labels do not fit in 390 pixels.
            options={VIEWS.map((v) => ({
              value: v.value,
              label: <Tooltip title={screens.sm === false ? `${v.label}: ${v.hint}` : v.hint}>{screens.sm === false ? null : v.label}</Tooltip>,
              icon: v.icon,
            }))}
          />
          {view === 'top' && (
            <>
              {edgeLimit}
              {similarityControl}
            </>
          )}
          {view === 'communities' && (
            <>
              <Select
                mode="multiple"
                allowClear
                maxTagCount="responsive"
                style={{ minWidth: 260, maxWidth: 420, flex: '1 1 260px' }}
                placeholder="Choose communities"
                value={chosen}
                onChange={(ids: number[]) => set({ communities: ids.join(',') || null })}
                options={communityOptions}
                showSearch
                optionFilterProp="searchText"
                aria-label="Communities to draw"
              />
              {edgeLimit}
              {similarityControl}
            </>
          )}
          {view === 'focus' && (
            <>
              <Select
                showSearch
                style={{ minWidth: 280, maxWidth: 520, flex: '1 1 320px' }}
                placeholder="Find a document by words or id"
                value={focus ?? undefined}
                filterOption={false}
                onSearch={setPickerTerm}
                loading={picker.isFetching}
                onChange={(id: string) => {
                  setSelected(null)
                  set({ focus: id }, { push: true })
                }}
                options={(picker.data ?? []).map((d) => ({ value: d.id, label: `${d.external_id} — ${d.text.slice(0, 80)}` }))}
                notFoundContent={picker.isFetching ? <Spin size="small" /> : 'No documents'}
                aria-label="Document at the centre"
              />
              <Segmented
                value={hops}
                onChange={(v) => set({ hops: v === 2 ? 2 : null })}
                options={[
                  { label: '1 hop', value: 1 },
                  { label: '2 hops', value: 2 },
                ]}
              />
              {similarityControl}
            </>
          )}
          {view === 'query' && (
            <>
              <div style={{ flex: '1 1 320px', minWidth: 260 }}>
                <SearchBox
                  scope="graph"
                  value={draft}
                  onChange={setDraft}
                  onSubmit={(value) => set({ q: value.trim() || null }, { push: true })}
                  loading={graph.isFetching}
                  placeholder="Search, then see how the results connect"
                />
              </div>
              <Segmented
                value={searchMode}
                onChange={(m) => set({ mode: m === 'hybrid' ? null : String(m) })}
                options={MODES.map((m) => ({ value: m.value, label: <Tooltip title={m.hint}>{m.label}</Tooltip> }))}
              />
              <Badge count={docRules} size="small">
                <Button icon={<FilterOutlined />} onClick={() => setDocTreeOpen(true)}>
                  Conditions
                </Button>
              </Badge>
              <Select
                style={{ width: 150 }}
                value={seedLimit}
                onChange={(v) => set({ seeds: v === 150 ? null : v })}
                options={SEED_LIMITS.map((v) => ({ value: v, label: `${v} documents` }))}
                aria-label="How many matching documents to draw"
              />
              <Tooltip title="Also draw the strongest neighbours of the results, so bridges to other topics appear">
                <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  <Switch size="small" checked={expand} onChange={(v) => set({ expand: v ? 1 : null })} />
                  Neighbours
                </label>
              </Tooltip>
              {similarityControl}
            </>
          )}
        </div>
        <div className="nu-explorer-subbar">
          <Badge count={hlRules} size="small">
            <Button icon={<HighlightOutlined />} onClick={() => setHlOpen(true)} disabled={!data?.nodes.length}>
              Highlight
            </Button>
          </Badge>
          <Segmented
            value={hideUnmatched ? 'hide' : 'dim'}
            disabled={!hlRules}
            onChange={(v) => set({ hlmode: v === 'hide' ? 'hide' : null })}
            options={[
              { value: 'dim', label: 'Dim the rest' },
              { value: 'hide', label: 'Hide the rest' },
            ]}
          />
          <ActiveConditions
            text={describeTreeLocally(hlTree, hlLabels)}
            rules={hlRules}
            onEdit={() => setHlOpen(true)}
            onClear={() => set({ hl: null, hlmode: null })}
          >
            {view === 'query' && docRules > 0 && (
              <FilterChip icon={<FilterOutlined />} name="the document conditions" onEdit={() => setDocTreeOpen(true)} onRemove={() => set({ tree: null })}>
                {docRules} document condition{docRules === 1 ? '' : 's'}
              </FilterChip>
            )}
          </ActiveConditions>
          <div style={{ flex: 1 }} />
          <Select
            showSearch
            optionFilterProp="label"
            allowClear
            style={{ width: screens.md ? 300 : 200 }}
            placeholder="Find a document in view"
            options={nodeOptions}
            onSelect={(id: string) => canvasRef.current?.focusNode(id)}
            aria-label="Find a document in the graph"
          />
        </div>
      </Card>

      {graph.error && queryParams && (
        <Alert type="error" showIcon message="Could not load the graph" description={(graph.error as Error).message} />
      )}
      {(data?.warnings ?? []).map((w) => (
        <Alert key={w} type="warning" showIcon message={w} />
      ))}

      <Card
        className="sl-graph-card"
        size="small"
        title={
          <Space size={10} wrap>
            <ApartmentOutlined />
            <span>{VIEWS.find((v) => v.value === view)?.label}</span>
            {data && (
              <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
                {fmtInt(data.nodes.length)} documents, {fmtInt(data.links.length)} edges
                {view === 'focus' ? ` around the selected document (${hops} hop${hops > 1 ? 's' : ''})` : ''}
                {view === 'query' && data.matched !== undefined ? ` · ${fmtInt(seeds.size)} results of ${fmtInt(data.matched)} matching` : ''}
                {highlight ? ` · ${fmtInt(highlight.size)} highlighted` : ''}
              </Typography.Text>
            )}
          </Space>
        }
        extra={
          <Space size={4}>
            <Popover
              trigger="click"
              placement="bottomRight"
              title="Using the graph"
              content={
                <ul className="nu-help-list">
                  <li><kbd>Drag</kbd> the background to pan, a node to move it</li>
                  <li><kbd>Scroll</kbd> or pinch to zoom</li>
                  <li><kbd>Click</kbd> a node to select it and see its links</li>
                  <li><kbd>Double-click</kbd> a node to open the document</li>
                  <li>Legend chips hide or show a community</li>
                  <li>The similarity band keeps edges between its two handles</li>
                </ul>
              }
            >
              <Button type="text" icon={<QuestionCircleOutlined />} aria-label="How to use the graph">
                How to use
              </Button>
            </Popover>
            <Tooltip title="Fit to view">
              <Button type="text" icon={<ExpandOutlined />} onClick={() => canvasRef.current?.fit()} aria-label="Fit the graph to the view" />
            </Tooltip>
            <Tooltip title={paused ? 'Resume layout' : 'Pause layout'}>
              <Button
                type="text"
                icon={paused ? <CaretRightOutlined /> : <PauseOutlined />}
                onClick={() => setPaused((p) => !p)}
                aria-label={paused ? 'Resume the layout' : 'Pause the layout'}
              />
            </Tooltip>
            <Tooltip title="Export as PNG">
              <Button type="text" icon={<CameraOutlined />} onClick={() => canvasRef.current?.exportPng()} aria-label="Export the graph as PNG" />
            </Tooltip>
          </Space>
        }
      >
        <div className="sl-graph-stage">
          {data && data.nodes.length > 0 ? (
            <GraphCanvas
              ref={canvasRef}
              data={data}
              hidden={hidden}
              selectedId={selected?.id ?? null}
              paused={paused}
              reducedMotion={reducedMotion}
              highlight={highlight}
              hideUnmatched={hideUnmatched}
              seeds={seeds}
              centerId={centerId}
              palette={palette}
              onSelect={onSelect}
              onOpen={drawer.open}
            />
          ) : (
            !graph.isFetching && (
              <div style={{ display: 'grid', placeItems: 'center', height: '100%', minHeight: 420 }}>
                <EmptyState title={emptyHint.title} hint={emptyHint.hint} />
              </div>
            )
          )}

          {graph.isFetching && (
            <div className="graph-overlay" style={{ top: 12, right: 12 }}>
              <Spin size="small" />
            </div>
          )}

          {data && data.nodes.length > 0 && (
            <div className="graph-overlay" style={{ left: 12, bottom: 12, right: 12 }}>
              <div className="graph-legend" role="group" aria-label="Communities (toggle visibility)">
                {legend.map(([key, entry]) => (
                  <button key={key} type="button" className="legend-chip" aria-pressed={!hidden.has(key)} onClick={() => toggle(key)}>
                    <span className="ckey">
                      <span className="ckey-glyph" style={{ background: communityColor(entry.id) }} />
                      {communityLabel(entry.id)} {entry.count}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {selected && (
            <Card
              size="small"
              className="graph-overlay"
              style={{ top: 12, left: 12, width: screens.md ? 360 : 'calc(100% - 24px)' }}
              title={
                <Space>
                  <CommunityKey id={selected.community_id} />
                  <Typography.Text type="secondary" className="mono" style={{ fontSize: 12 }}>
                    {selected.external_id}
                  </Typography.Text>
                </Space>
              }
              extra={
                <Button type="text" onClick={() => setSelected(null)} aria-label="Clear the selection">
                  Close
                </Button>
              }
            >
              <Typography.Paragraph ellipsis={{ rows: 4 }} style={{ marginBottom: 8 }}>
                {selected.text}
              </Typography.Paragraph>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
                {records.get(selected.id)?.degree ?? 0} links in view · strongest {fmtScore(records.get(selected.id)?.best_link as number | null)}
                {seeds.has(selected.id) ? ` · search rank ${records.get(selected.id)?.seed_rank}` : ''}
              </Typography.Paragraph>
              <Space wrap size={[4, 4]}>
                <Button type="primary" icon={<EyeOutlined />} onClick={() => drawer.open(selected.id)}>
                  Details
                </Button>
                <Button icon={<AimOutlined />} onClick={() => set({ view: 'focus', focus: selected.id }, { push: true })}>
                  Neighbourhood
                </Button>
                {selected.community_id !== null && (
                  <Tooltip title="Highlight every node of this community">
                    <Button
                      icon={<HighlightOutlined />}
                      onClick={() => set({ hl: JSON.stringify(treeFromRules([rule.communities([selected.community_id as number])])) })}
                    >
                      C{selected.community_id}
                    </Button>
                  </Tooltip>
                )}
                <Tooltip title="Semantic search with this document's text">
                  <Button icon={<BranchesOutlined />} onClick={() => navigate(links.explore({ q: selected.text.slice(0, 300), mode: 'semantic' }))}>
                    Similar
                  </Button>
                </Tooltip>
              </Space>
            </Card>
          )}
        </div>
      </Card>

      <AdvancedConditionsDrawer
        open={hlOpen}
        title="Highlight nodes"
        noun="nodes"
        engine="your browser, over the nodes on screen — nothing is re-fetched"
        fields={hlFields}
        value={hlTree}
        onClose={() => setHlOpen(false)}
        onApply={(tree) => set({ hl: tree ? JSON.stringify(tree) : null })}
        usePreview={useHighlightPreview}
        presets={hlPresets}
      />
      <AdvancedConditionsDrawer
        open={docTreeOpen}
        title="Which documents to draw"
        noun="documents"
        engine="Elasticsearch, before ranking — the same fields as Explore"
        fields={catalogue.data?.fields ?? []}
        value={docTree}
        onClose={() => setDocTreeOpen(false)}
        onApply={(tree) => set({ tree: tree ? JSON.stringify(tree) : null, view: 'query' })}
        usePreview={useDocPreview}
        presets={[
          { label: 'Not clustered yet', tree: treeFromRules([rule.unclustered()]) },
          { label: 'Long documents', tree: treeFromRules([rule.lengthAtLeast(500)]) },
        ]}
      />

      <PageDoc doc={PAGE_DOCS.graph} />
    </div>
  )
}
