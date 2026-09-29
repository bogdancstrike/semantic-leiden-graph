/**
 * `/communities` — the groups weighted Leiden found, and how good they are.
 *
 * Two kinds of search, each suited to what is being asked:
 * - **Topic search** asks the corpus: "which communities discuss this?". The
 *   query runs as a search with automatic routing, so anchor documents vote for
 *   communities (Qdrant) and the ranked hits are counted per community.
 * - **Metric conditions** ask the table: "cohesion ≥ 0.8 and conductance < 0.2".
 *   The metrics are already on screen, so the query builder's tree is evaluated
 *   in the browser — instant, and nothing is re-fetched.
 */

import { useEffect, useMemo, useState } from 'react'
import { Alert, Badge, Button, Card, Progress, Segmented, Skeleton, Space, Table, Tag, Tooltip, Typography } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClearOutlined,
  ClusterOutlined,
  DeploymentUnitOutlined,
  FileSearchOutlined,
  FilterOutlined,
  FundOutlined,
  NodeIndexOutlined,
  PartitionOutlined,
  SearchOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { useCommunities, useCommunity, useSearch, useStats } from '@/api/hooks'
import type { Community, SearchMode, SearchRequest } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { ChartCard } from '@/components/ChartCard'
import { Chip } from '@/components/Chip'
import { barOption, scatterOption } from '@/components/charts/options'
import { CommunityKey } from '@/components/CommunityKey'
import { useDocumentDrawer } from '@/components/DocumentDrawer'
import { EmptyState, NoResults } from '@/components/EmptyState'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { ActiveConditions, AdvancedConditionsDrawer, type ConditionPreset, type PreviewState } from '@/components/query/AdvancedConditionsDrawer'
import { describeTreeLocally, matchesTree, type EvalRecord } from '@/components/query/evaluate'
import type { BuilderField } from '@/components/query/queryBuilderConfig'
import { countRules, treeFromRules } from '@/components/query/queryTree'
import { SavedSearchButtons } from '@/components/SavedSearches'
import { MODES } from '@/components/search/defaults'
import { SearchBox } from '@/components/search/SearchBox'
import { StatCard } from '@/components/StatCard'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { parseJson, useUrlState } from '@/hooks/useUrlState'
import { fmtInt, fmtScore } from '@/lib/format'
import { links } from '@/lib/links'
import { communityColor } from '@/lib/palette'
import { useAppearance } from '@/theme/AppearanceProvider'
import type { QueryNode } from '@/api/types'

interface Row extends Community {
  topic_share: number | null
  topic_hits: number
  topic_matches: number | null
  best_score: number | null
}

const JUMP = /^\s*c?(\d+)\s*$/i
const PAGE_SIZE = 25

/** Column sorts, applied here rather than by the table so the page of any row is known. */
const SORTERS: Record<string, (a: Row, b: Row) => number> = {
  topic_share: (a, b) => (a.topic_share ?? 0) - (b.topic_share ?? 0),
  topic_hits: (a, b) => a.topic_hits - b.topic_hits,
  size: (a, b) => a.size - b.size,
  avg_similarity: (a, b) => a.avg_similarity - b.avg_similarity,
  density: (a, b) => a.density - b.density,
  conductance: (a, b) => a.conductance - b.conductance,
  internal_edges: (a, b) => a.internal_edges - b.internal_edges,
  boundary_edges: (a, b) => a.boundary_edges - b.boundary_edges,
}

const metricNumber = (name: string, label: string, description: string, extra: Partial<BuilderField> = {}): BuilderField => ({
  name,
  label,
  kind: 'number',
  operators: ['equal', 'not_equal', 'less', 'less_or_equal', 'greater', 'greater_or_equal', 'between', 'not_between'],
  description,
  ...extra,
})

function metricFields(communityChoices: BuilderField['choices'], topic: boolean): BuilderField[] {
  return [
    {
      name: 'community_id',
      label: 'Community',
      kind: 'community',
      operators: ['select_equals', 'select_not_equals', 'select_any_in', 'select_not_any_in'],
      choices: communityChoices,
    },
    metricNumber('size', 'Size (documents)', 'Number of member documents', { min: 0 }),
    metricNumber('avg_similarity', 'Cohesion', 'Mean similarity of edges inside the community. Higher is a tighter topic.', { min: 0, max: 1, step: 0.01 }),
    metricNumber('density', 'Density', 'Internal edges divided by all possible pairs', { min: 0, max: 1, step: 0.01 }),
    metricNumber('conductance', 'Conductance', 'Share of edge weight leaving the community. 0 is perfectly separated.', { min: 0, max: 1, step: 0.01 }),
    metricNumber('internal_edges', 'Internal edges', 'Edges with both ends inside', { min: 0 }),
    metricNumber('boundary_edges', 'Boundary edges', 'Edges to other communities', { min: 0 }),
    ...(topic
      ? [
          metricNumber('topic_share', 'Topic vote (%)', 'Share of the anchor vote for the topic search', { min: 0, max: 100 }),
          metricNumber('topic_hits', 'Topic results', 'Ranked search results that fall in this community', { min: 0 }),
        ]
      : []),
  ]
}

function CommunityDetailPanel({ row, topic, onSelect }: { row: Row; topic: string; onSelect: (id: number) => void }) {
  const id = row.community_id
  const { data, isLoading } = useCommunity(id)
  const drawer = useDocumentDrawer()
  const navigate = useNavigate()
  const neighbours = data?.neighbouring_communities ?? []
  const maxEdges = Math.max(1, ...neighbours.map((n) => n.edges))

  return (
    <section className="sl-detail" aria-label={`Community C${id}`}>
      {/* Who this is and what can be done with it, above the evidence. */}
      <header className="sl-detail-head">
        <div className="sl-detail-title">
          <CommunityKey id={id} label={`Community C${id}`} />
          <span className="sl-detail-facts">
            {fmtInt(row.size)} documents · cohesion {fmtScore(row.avg_similarity)} · conductance {fmtScore(row.conductance)}
            {row.topic_share !== null ? ` · topic vote ${row.topic_share.toFixed(1)}%` : ''}
          </span>
        </div>
        <div className="sl-detail-actions">
          <Button type="primary" icon={<FileSearchOutlined />} onClick={() => navigate(links.explore({ communities: [id] }))}>
            Explore its documents
          </Button>
          <Tooltip title="This community and its two closest neighbours">
            <Button icon={<ApartmentOutlined />} onClick={() => navigate(links.graph({ communities: [id, ...neighbours.slice(0, 2).map((n) => n.community_id)] }))}>
              Show in graph
            </Button>
          </Tooltip>
          {topic && (
            <Button icon={<SearchOutlined />} onClick={() => navigate(links.explore({ communities: [id], q: topic, mode: 'hybrid' }))}>
              Search “{topic.length > 24 ? `${topic.slice(0, 24)}…` : topic}” here
            </Button>
          )}
        </div>
      </header>

      {isLoading ? (
        <Skeleton active paragraph={{ rows: 4 }} />
      ) : (
        <div className="sl-detail-body">
          <div className="sl-detail-section">
            <h2 className="sl-detail-heading">Most central documents</h2>
            <p className="sl-detail-hint">Ranked by summed similarity to the other members: the documents that best represent the community.</p>
            {data?.central.length ? (
              <ol className="sl-central-list">
                {data.central.map((doc, index) => (
                  <li key={doc.id}>
                    <button type="button" className="sl-central-item" onClick={() => drawer.open(doc.id)}>
                      <span className="sl-central-rank">{index + 1}</span>
                      <span className="sl-central-body">
                        <span className="sl-central-text">{doc.text ?? doc.id}</span>
                        <span className="sl-central-meta">
                          <span className="mono">{doc.external_id}</span> · {doc.degree} links · strength {fmtScore(doc.strength, 2)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState compact title="No documents found" />
            )}
          </div>

          <div className="sl-detail-section">
            <h2 className="sl-detail-heading">Neighbouring communities</h2>
            <p className="sl-detail-hint">Connected by boundary edges. Strong bridges suggest topics that could merge at a lower resolution (γ).</p>
            {neighbours.length === 0 ? (
              <div className="sl-detail-empty">
                <CheckCircleOutlined />
                <span>
                  <strong>Fully separated.</strong> No similarity edge leaves this community, so it is a self-contained topic.
                </span>
              </div>
            ) : (
              <table className="sl-neighbours">
                <thead>
                  <tr>
                    <th scope="col">Community</th>
                    <th scope="col">Shared edges</th>
                    <th scope="col" className="is-number">Avg. similarity</th>
                  </tr>
                </thead>
                <tbody>
                  {neighbours.map((n) => (
                    <tr key={n.community_id}>
                      <td>
                        <button type="button" className="nu-row-button" onClick={() => onSelect(n.community_id)} aria-label={`Open community C${n.community_id}`}>
                          <CommunityKey id={n.community_id} />
                        </button>
                      </td>
                      <td>
                        <span className="sl-neighbour-bar">
                          <span className="rank-bar-track" aria-hidden>
                            <span className="rank-bar-fill" style={{ width: `${(n.edges / maxEdges) * 100}%`, background: communityColor(n.community_id) }} />
                          </span>
                          <span className="is-number">{fmtInt(n.edges)}</span>
                        </span>
                      </td>
                      <td className="is-number">{fmtScore(n.avg_score)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

export default function CommunitiesPage() {
  const { chartTheme } = useAppearance()
  const [params, set] = useUrlState()
  const { data: communities = [], isLoading, error } = useCommunities()
  const { data: stats } = useStats()

  const q = params.get('q') ?? ''
  const mode = ((params.get('mode') as SearchMode | null) ?? 'hybrid') as SearchMode
  const tree = useMemo(() => parseJson<QueryNode>(params.get('tree')), [params])
  const selected = params.get('selected') !== null ? Number(params.get('selected')) : null
  const [draft, setDraft] = useState(q)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  useEffect(() => setDraft((current) => (current.trim() === q ? current : q)), [q])

  // "C12" or "12" jumps to a community; anything else is a topic.
  const jump = JUMP.exec(q)
  const topic = jump ? '' : q.trim()

  const request = useMemo<SearchRequest | null>(
    () =>
      topic
        ? {
            query: topic,
            mode,
            top_k: 100,
            scope: { type: 'auto', community_ids: [], exclude_community_ids: [] },
            routing: { strategy: 'sum', anchors: 100, communities: 10, temperature: 0.05 },
            fusion: { method: 'rrf', alpha: 0.5, rrf_k: 60 },
            lexical: { syntax: 'plain', operator: 'or', fuzzy: false, phrase_boost: true },
            mmr: { enabled: false, lambda: 0.7, candidates: 50 },
            filters: {},
            highlight: false,
            facets: true,
            explain: false,
          }
        : null,
    [topic, mode],
  )
  const debouncedRequest = useDebouncedValue(request, 250)
  const search = useSearch(debouncedRequest)
  const topicData = topic ? search.data : undefined

  const rows: Row[] = useMemo(() => {
    const votes = new Map((topicData?.routing?.candidates ?? []).map((c) => [c.community_id, c]))
    const hits = new Map<number, number>()
    for (const hit of topicData?.results ?? []) {
      if (hit.community_id !== null && hit.community_id !== undefined) hits.set(hit.community_id, (hits.get(hit.community_id) ?? 0) + 1)
    }
    const matches = new Map((topicData?.facets.communities ?? []).map((b) => [b.value, b.count]))
    return communities.map((c) => ({
      ...c,
      topic_share: topicData ? Math.round((votes.get(c.community_id)?.share ?? 0) * 1000) / 10 : null,
      topic_hits: hits.get(c.community_id) ?? 0,
      topic_matches: topicData ? (matches.get(c.community_id) ?? 0) : null,
      best_score: votes.get(c.community_id)?.best_score ?? null,
    }))
  }, [communities, topicData])

  const filtered = useMemo(() => {
    let out = rows.filter((r) => matchesTree(tree, r as unknown as EvalRecord))
    if (jump) out = out.filter((r) => r.community_id === Number(jump[1]))
    if (topicData) out = out.filter((r) => (r.topic_share ?? 0) > 0 || r.topic_hits > 0).sort((a, b) => (b.topic_share ?? 0) - (a.topic_share ?? 0) || b.topic_hits - a.topic_hits)
    return out
  }, [rows, tree, jump, topicData])

  const [sortState, setSortState] = useState<{ key: string; order: 'ascend' | 'descend' } | null>(null)
  const ordered = useMemo(() => {
    const compare = sortState ? SORTERS[sortState.key] : undefined
    if (!sortState || !compare) return filtered
    return [...filtered].sort((a, b) => (sortState.order === 'ascend' ? compare(a, b) : compare(b, a)))
  }, [filtered, sortState])
  const [page, setPage] = useState(1)
  const orderOf = (key: string) => (sortState?.key === key ? sortState.order : null)

  // A new question starts on its first page; a selected community (a deep link, a
  // chart bar, a neighbour) turns to the page that holds it and scrolls it into view.
  useEffect(() => setPage(1), [q, tree])
  useEffect(() => {
    if (selected === null) return
    const index = ordered.findIndex((r) => r.community_id === selected)
    if (index < 0) return
    setPage(Math.floor(index / PAGE_SIZE) + 1)
    const timer = window.setTimeout(() => document.querySelector(`[data-row-key="${selected}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 350)
    return () => window.clearTimeout(timer)
  }, [selected, ordered])

  const communityChoices = useMemo(() => communities.map((c) => ({ value: c.community_id, label: `C${c.community_id}`, count: c.size })), [communities])
  const fields = useMemo(() => metricFields(communityChoices, !!topicData), [communityChoices, topicData])
  const labels = useMemo(() => Object.fromEntries(fields.map((f) => [f.name, f.label])), [fields])
  const rules = countRules(tree)
  const usePreview = (draftTree: QueryNode | null): PreviewState => ({
    count: rows.filter((r) => matchesTree(draftTree, r as unknown as EvalRecord)).length,
    text: describeTreeLocally(draftTree, labels),
  })
  const presets: ConditionPreset[] = [
    {
      label: 'Tight, well separated',
      tree: treeFromRules([
        { field: 'avg_similarity', operator: 'greater_or_equal', value: [0.75] },
        { field: 'conductance', operator: 'less_or_equal', value: [0.2] },
      ]),
      hint: 'High cohesion and low conductance: clean topics',
    },
    { label: 'Bridges', tree: treeFromRules([{ field: 'conductance', operator: 'greater_or_equal', value: [0.4] }]), hint: 'Much of their weight leaves the community' },
    { label: 'Large (200+)', tree: treeFromRules([{ field: 'size', operator: 'greater_or_equal', value: [200] }]) },
    { label: 'Tiny (≤ 5)', tree: treeFromRules([{ field: 'size', operator: 'less_or_equal', value: [5] }]), hint: 'Often noise or near-duplicates' },
    ...(topicData ? [{ label: 'Topic vote ≥ 10%', tree: treeFromRules([{ field: 'topic_share', operator: 'greater_or_equal', value: [10] }]) }] : []),
  ]

  // ------------------------------------------------------------------ KPIs
  const sizes = filtered.map((c) => c.size).sort((a, b) => a - b)
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : null
  const mean = (key: 'avg_similarity' | 'conductance') => (filtered.length ? filtered.reduce((s, c) => s + c[key], 0) / filtered.length : null)
  const largest = filtered.reduce<Row | null>((best, c) => (!best || c.size > best.size ? c : best), null)
  const run = stats?.last_cluster_run
  const maxSize = Math.max(1, ...communities.map((c) => c.size))
  const select = (id: number | null) => set({ selected: id === null || id === selected ? null : id })

  const columns: ColumnsType<Row> = [
    { title: 'Community', dataIndex: 'community_id', width: 120, fixed: 'left', render: (id: number) => <CommunityKey id={id} /> },
    ...(topicData
      ? [
          {
            title: <Tooltip title="Share of the anchor vote: how strongly the documents nearest to the topic sit in this community">Topic vote</Tooltip>,
            dataIndex: 'topic_share',
            key: 'topic_share',
            width: 180,
            sorter: true,
            sortOrder: orderOf('topic_share'),
            render: (v: number | null, row: Row) => (
              <Space size={8}>
                <Progress percent={v ?? 0} showInfo={false} size="small" strokeColor={communityColor(row.community_id)} style={{ width: 90, margin: 0 }} aria-hidden />
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{(v ?? 0).toFixed(1)}%</span>
              </Space>
            ),
          },
          {
            title: <Tooltip title="How many of the top 100 ranked results fall in this community">Results</Tooltip>,
            dataIndex: 'topic_hits',
            key: 'topic_hits',
            width: 100,
            align: 'right' as const,
            sorter: true,
            sortOrder: orderOf('topic_hits'),
          },
        ]
      : []),
    {
      title: 'Size',
      dataIndex: 'size',
      width: 180,
      key: 'size',
      sorter: true,
      sortOrder: orderOf('size'),
      render: (size: number) => (
        <Space>
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 44, display: 'inline-block' }}>{fmtInt(size)}</span>
          <Progress percent={(size / maxSize) * 100} showInfo={false} size="small" style={{ width: 90, margin: 0 }} aria-hidden />
        </Space>
      ),
    },
    {
      title: <Tooltip title="Mean similarity of edges inside the community. Higher means a tighter topic.">Cohesion</Tooltip>,
      dataIndex: 'avg_similarity',
      key: 'avg_similarity',
      sorter: true,
      sortOrder: orderOf('avg_similarity'),
      render: (v: number) => fmtScore(v),
    },
    {
      title: <Tooltip title="Internal edges divided by all possible pairs.">Density</Tooltip>,
      dataIndex: 'density',
      key: 'density',
      sorter: true,
      sortOrder: orderOf('density'),
      responsive: ['md'],
      render: (v: number) => fmtScore(v),
    },
    {
      title: <Tooltip title="Share of edge weight leaving the community. 0 is perfectly separated; high values suggest a bridge topic.">Conductance</Tooltip>,
      dataIndex: 'conductance',
      key: 'conductance',
      sorter: true,
      sortOrder: orderOf('conductance'),
      render: (v: number) => (
        <Tag bordered={false} color={v >= 0.4 ? 'warning' : v <= 0.15 ? 'success' : undefined}>
          {fmtScore(v)}
        </Tag>
      ),
    },
    { title: 'Internal edges', dataIndex: 'internal_edges', key: 'internal_edges', responsive: ['lg'], sorter: true, sortOrder: orderOf('internal_edges'), render: fmtInt },
    { title: 'Boundary edges', dataIndex: 'boundary_edges', key: 'boundary_edges', responsive: ['lg'], sorter: true, sortOrder: orderOf('boundary_edges'), render: fmtInt },
  ]

  const chartRows = [...filtered].sort((a, b) => b.size - a.size).slice(0, 60)
  const summary = [topic && `topic “${topic}”`, jump && `C${jump[1]}`, rules && `${rules} metric condition${rules === 1 ? '' : 's'}`].filter(Boolean).join(' · ')

  return (
    <div className="nu-page">
      <PageHeader
        title="Communities"
        tag={
          communities.length > 0 && (
            <Tag color="blue" bordered={false}>
              {filtered.length === communities.length ? `${fmtInt(communities.length)} communities` : `${fmtInt(filtered.length)} of ${fmtInt(communities.length)}`}
            </Tag>
          )
        }
        subtitle="Topic clusters found by Leiden on the similarity graph, with quality metrics from graph structure alone."
        actions={<SavedSearchButtons summary={summary || 'All communities'} disabled={!summary} />}
      />

      <Card className="nu-explorer-controls" size="small">
        <div className="nu-explorer-toolbar">
          <Segmented
            value={mode}
            onChange={(m) => set({ mode: m === 'hybrid' ? null : String(m) })}
            options={MODES.map((m) => ({ value: m.value, label: <Tooltip title={`${m.hint}. Anchors always vote semantically.`}>{m.label}</Tooltip> }))}
          />
          <SearchBox
            scope="communities"
            value={draft}
            onChange={setDraft}
            onSubmit={(value) => set({ q: value.trim() || null, selected: null }, { push: true })}
            loading={search.isFetching}
            placeholder="Which communities discuss… (any language) — or type C12 to jump"
          />
          <div className="nu-toolbar-group">
            <Badge count={rules} size="small">
              <Button icon={<FilterOutlined />} onClick={() => setAdvancedOpen(true)}>
                Metric conditions
              </Button>
            </Badge>
          </div>
        </div>
        <div className="nu-explorer-subbar">
          {rules > 0 ? (
            <ActiveConditions text={describeTreeLocally(tree, labels)} rules={rules} onEdit={() => setAdvancedOpen(true)} onClear={() => set({ tree: null })} />
          ) : q ? (
            <div className="nu-conditions" />
          ) : (
            <div className="nu-conditions">
              <span className="nu-conditions-label">Try</span>
              {['railway infrastructure', 'ransomware', 'interest rates', 'fotbal'].map((example) => (
                <Chip key={example} icon={<SearchOutlined />} onClick={() => set({ q: example }, { push: true })}>
                  {example}
                </Chip>
              ))}
              {presets.slice(0, 2).map((preset) => (
                <Chip key={preset.label} icon={<FilterOutlined />} onClick={() => set({ tree: JSON.stringify(preset.tree) }, { push: true })}>
                  {preset.label}
                </Chip>
              ))}
            </div>
          )}
          {(q || rules > 0) && (
            <Button icon={<ClearOutlined />} onClick={() => set({ q: null, tree: null, selected: null }, { push: true })}>
              Clear all
            </Button>
          )}
        </div>
      </Card>

      {search.error && topic && <Alert type="error" showIcon message="The topic search failed" description={(search.error as Error).message} />}

      <div className="nu-kpis nu-kpis--6">
        <StatCard
          label="Communities"
          value={fmtInt(filtered.length)}
          icon={<ClusterOutlined />}
          loading={isLoading}
          hint={
            run
              ? `${stats?.min_community_size ?? 2}+ docs each · ${fmtInt(stats?.outside_communities ?? run.outside_documents ?? 0)} in none`
              : 'No clustering run yet'
          }
        />
        <StatCard
          label="Largest"
          value={largest ? fmtInt(largest.size) : '—'}
          icon={<DeploymentUnitOutlined />}
          accent="info"
          loading={isLoading}
          hint={largest ? `C${largest.community_id} — click to open` : undefined}
          onClick={largest ? () => select(largest.community_id) : undefined}
        />
        <StatCard label="Median size" value={fmtInt(median)} icon={<PartitionOutlined />} accent="neutral" loading={isLoading} />
        <StatCard label="Mean cohesion" value={fmtScore(mean('avg_similarity'))} icon={<NodeIndexOutlined />} accent="success" loading={isLoading} hint="Higher is tighter" />
        <StatCard label="Mean conductance" value={fmtScore(mean('conductance'))} icon={<FundOutlined />} accent="warning" loading={isLoading} hint="Lower is better separated" />
        <StatCard label="Modularity" value={run ? fmtScore(run.modularity) : '—'} icon={<TrophyOutlined />} loading={!stats} hint={run ? `γ ${run.gamma}, ${fmtInt(run.community_count)} communities` : undefined} />
      </div>


      <div className="nu-chart-grid">
        <div className={topicData ? 'nu-span-4' : 'nu-span-6'}>
          <ChartCard
            id="communities-sizes"
            title="Sizes"
            description="Largest first; click a bar to open the community."
            height={240}
            loading={isLoading}
            option={barOption(chartTheme, {
              categories: chartRows.map((c) => `C${c.community_id}`),
              values: chartRows.map((c) => c.size),
              colors: chartRows.map((c) => communityColor(c.community_id)),
              name: 'Documents',
            })}
            rows={chartRows.map((c) => ({ community: `C${c.community_id}`, size: c.size }))}
            columns={[
              { key: 'community', label: 'Community' },
              { key: 'size', label: 'Documents' },
            ]}
            onSelect={(name) => select(Number(name.slice(1)))}
          />
        </div>
        <div className={topicData ? 'nu-span-4' : 'nu-span-6'}>
          <ChartCard
            id="communities-quality"
            title="Cohesion vs conductance"
            description="Top-right is tight but leaky; bottom-right is the ideal. Bubble size is the community size."
            height={240}
            loading={isLoading}
            option={scatterOption(chartTheme, {
              points: filtered.map((c) => ({ name: `C${c.community_id}`, x: c.avg_similarity, y: c.conductance, size: c.size, color: communityColor(c.community_id) })),
              xName: 'Cohesion',
              yName: 'Conductance',
            })}
            rows={filtered.map((c) => ({ community: `C${c.community_id}`, cohesion: c.avg_similarity, conductance: c.conductance, size: c.size }))}
            columns={[
              { key: 'community', label: 'Community' },
              { key: 'cohesion', label: 'Cohesion' },
              { key: 'conductance', label: 'Conductance' },
              { key: 'size', label: 'Size' },
            ]}
            onSelect={(name) => select(Number(name.slice(1)))}
          />
        </div>
        {topicData && (
          <div className="nu-span-4">
            <ChartCard
              id="communities-topic"
              title={`Vote for “${topic.slice(0, 30)}”`}
              description={`${topicData.routing?.candidates.length ?? 0} communities received anchor votes.`}
              height={240}
              option={barOption(chartTheme, {
                categories: (topicData.routing?.candidates ?? []).slice(0, 12).map((c) => `C${c.community_id}`),
                values: (topicData.routing?.candidates ?? []).slice(0, 12).map((c) => Math.round(c.share * 1000) / 10),
                colors: (topicData.routing?.candidates ?? []).slice(0, 12).map((c) => communityColor(c.community_id)),
                horizontal: true,
                name: 'Vote share',
                format: (v) => `${v}%`,
              })}
              rows={(topicData.routing?.candidates ?? []).map((c) => ({ community: `C${c.community_id}`, share: Math.round(c.share * 1000) / 10, anchors: c.anchors }))}
              columns={[
                { key: 'community', label: 'Community' },
                { key: 'share', label: 'Vote %' },
                { key: 'anchors', label: 'Anchors' },
              ]}
              onSelect={(name) => select(Number(name.slice(1)))}
            />
          </div>
        )}
      </div>

      <Card
        className="nu-explorer-results"
        size="small"
        title={
          <Space>
            <ClusterOutlined />
            {topicData ? `Communities discussing “${topic}”` : 'All communities'}
            <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
              click a row for its central documents and neighbours
            </Typography.Text>
          </Space>
        }
      >
        {error && <Alert type="error" showIcon message="Could not load communities" description={(error as Error).message} />}
        {isLoading ? (
          <div className="nu-results-pad">
            <Skeleton active />
          </div>
        ) : communities.length === 0 ? (
          <EmptyState title="No communities yet" hint="Import documents and run clustering under Operations." />
        ) : (
          <Table
            rowKey="community_id"
            size="middle"
            columns={columns}
            dataSource={ordered}
            scroll={{ x: 760 }}
            pagination={{ current: page, pageSize: PAGE_SIZE, hideOnSinglePage: true, showSizeChanger: false, style: { padding: '0 16px' } }}
            onChange={(pagination, _filters, sorter) => {
              const active = Array.isArray(sorter) ? sorter[0] : sorter
              setSortState(active?.order && active.columnKey ? { key: String(active.columnKey), order: active.order } : null)
              setPage(pagination.current ?? 1)
            }}
            expandable={{
              columnTitle: <span className="sr-only">Details</span>,
              expandedRowKeys: selected !== null ? [selected] : [],
              onExpand: (open, row) => select(open ? row.community_id : null),
              expandedRowRender: (c) => <CommunityDetailPanel row={c} topic={topic} onSelect={(id) => set({ selected: id })} />,
            }}
            onRow={(row) => ({
              onClick: () => select(row.community_id),
              onKeyDown: (e) => {
                if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
                  e.preventDefault()
                  select(row.community_id)
                }
              },
              tabIndex: 0,
              style: { cursor: 'pointer' },
            })}
            locale={{ emptyText: <NoResults onClear={() => set({ q: null, tree: null })} hint="No community matches the topic and the metric conditions together." /> }}
          />
        )}
      </Card>

      <AdvancedConditionsDrawer
        open={advancedOpen}
        title="Metric conditions"
        noun="communities"
        engine="your browser, over the metrics Neo4j computed — nothing is re-fetched"
        fields={fields}
        value={tree}
        onClose={() => setAdvancedOpen(false)}
        onApply={(next) => set({ tree: next ? JSON.stringify(next) : null })}
        usePreview={usePreview}
        presets={presets}
      />

      <PageDoc doc={PAGE_DOCS.communities} />
    </div>
  )
}
