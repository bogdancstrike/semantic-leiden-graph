import { useMemo } from 'react'
import { Button, Card, Skeleton, Space, Tag, Timeline, Tooltip, Typography } from 'antd'
import {
  AlertOutlined,
  ApartmentOutlined,
  BranchesOutlined,
  ClusterOutlined,
  DatabaseOutlined,
  DisconnectOutlined,
  FileTextOutlined,
  ImportOutlined,
  NodeIndexOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  TrophyOutlined,
} from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import {
  invalidateCorpus,
  useActiveJob,
  useClusterRuns,
  useCommunities,
  useConfig,
  useInsights,
  useJobs,
  useSources,
  useStats,
} from '@/api/hooks'
import type { ExploreRequest, Job } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { ChartCard } from '@/components/ChartCard'
import { barOption, lineBarOption, pieOption, scatterOption } from '@/components/charts/options'
import { EmptyState } from '@/components/EmptyState'
import { JOB_LABELS } from '@/components/JobProgress'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { StatCard } from '@/components/StatCard'
import { fmtBytes, fmtInt, fmtMs, fmtRelative, fmtScore } from '@/lib/format'
import { links, rule } from '@/lib/links'
import { communityColor, COMMUNITY_COLORS } from '@/lib/palette'
import { useAppearance } from '@/theme/AppearanceProvider'
import { SERIES, statusColor } from '@/theme/tokens'

const { Text } = Typography

// The whole corpus: insights with no question are the corpus-wide distributions.
const ALL: ExploreRequest = {}

const NO_SOURCE = '(no source)'

/** One line about what a finished job did — the counters only describe its last phase. */
function jobLine(job: Job): string {
  const r = (job.result ?? {}) as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' ? fmtInt(v) : '0')
  if (job.status === 'failed') return job.error ?? 'failed'
  if (job.status === 'cancelled') return 'cancelled'
  if (job.status !== 'succeeded') return job.status === 'queued' ? 'queued' : job.phase
  switch (job.kind) {
    case 'import':
      return `${n(r.created)} created, ${n(r.updated)} updated, ${n(r.failed)} failed`
    case 'cluster':
      return `${n(r.community_count)} communities, modularity ${fmtScore(r.modularity as number)}`
    case 'rebuild':
      return `${n(r.edge_upserts)} edges`
    case 'reconcile':
      return `${n(r.reembedded)} repaired, ${n(r.orphans_removed)} orphans removed`
    case 'delete':
      return `${n(r.deleted)} documents deleted from ${String(r.source ?? NO_SOURCE)}`
    default:
      return 'done'
  }
}

/** Timeline buckets read as dates for day-sized intervals and as times below that. */
function bucketLabel(iso: string, interval?: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.valueOf())) return iso
  return interval && /^\d+[smh]$/.test(interval)
    ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function OverviewPage() {
  const navigate = useNavigate()
  const client = useQueryClient()
  const { chartTheme } = useAppearance()
  const stats = useStats()
  const { data: config } = useConfig()
  const communities = useCommunities()
  const runs = useClusterRuns()
  const insights = useInsights(ALL)
  const sources = useSources()
  const jobs = useJobs()
  const activeJob = useActiveJob()

  const s = stats.data
  const run = s?.last_cluster_run ?? null
  const empty = s !== undefined && s.documents === 0

  // ------------------------------------------------------------------ charts
  const sizes = useMemo(() => (communities.data ?? []).slice(0, 40), [communities.data])
  const sizesOption = useMemo(
    () =>
      sizes.length
        ? barOption(chartTheme, {
            categories: sizes.map((c) => `C${c.community_id}`),
            values: sizes.map((c) => c.size),
            colors: sizes.map((c) => communityColor(c.community_id)),
            name: 'Documents',
          })
        : null,
    [sizes, chartTheme],
  )

  const history = useMemo(() => [...(runs.data ?? [])].reverse(), [runs.data])
  const historyOption = useMemo(
    () =>
      history.length
        ? lineBarOption(chartTheme, {
            categories: history.map((r) => `v${r.version}`),
            line: { name: 'Modularity', values: history.map((r) => Number(r.modularity.toFixed(4))), format: (v) => v.toFixed(3) },
            bars: { name: 'Communities', values: history.map((r) => r.community_count) },
          })
        : null,
    [history, chartTheme],
  )

  const quality = communities.data ?? []
  const qualityOption = useMemo(
    () =>
      quality.length
        ? scatterOption(chartTheme, {
            xName: 'Cohesion',
            yName: 'Conductance',
            points: quality.map((c) => ({
              name: `C${c.community_id}`,
              x: c.avg_similarity,
              y: c.conductance,
              size: c.size,
              color: communityColor(c.community_id),
            })),
          })
        : null,
    [quality, chartTheme],
  )

  const bySource = insights.data?.sources ?? []
  const sourceOption = useMemo(
    () =>
      bySource.length
        ? pieOption(chartTheme, {
            slices: bySource.map((b, i) => ({
              name: b.value === null ? NO_SOURCE : String(b.value),
              value: b.count,
              color: SERIES[i % SERIES.length],
            })),
          })
        : null,
    [bySource, chartTheme],
  )

  const lengths = insights.data?.length_buckets ?? []
  const lengthOption = useMemo(
    () =>
      lengths.some((b) => b.count > 0)
        ? barOption(chartTheme, { categories: lengths.map((b) => b.label), values: lengths.map((b) => b.count), name: 'Documents' })
        : null,
    [lengths, chartTheme],
  )

  const timeline = insights.data?.timeline ?? []
  const interval = insights.data?.timeline_interval
  const timelineOption = useMemo(
    () =>
      timeline.length
        ? barOption(chartTheme, {
            categories: timeline.map((b) => bucketLabel(b.bucket, interval)),
            values: timeline.map((b) => b.count),
            colors: timeline.map(() => COMMUNITY_COLORS[1]),
            name: 'Documents added',
          })
        : null,
    [timeline, interval, chartTheme],
  )

  const stores = s
    ? [
        { store: 'Elasticsearch', role: 'documents', count: s.stores.elasticsearch.documents },
        { store: 'Qdrant', role: 'vectors', count: s.stores.qdrant.points },
        { store: 'Neo4j', role: 'nodes', count: s.stores.neo4j.nodes },
      ]
    : []
  const storesOption = useMemo(
    () =>
      stores.length
        ? barOption(chartTheme, {
            categories: stores.map((r) => r.store),
            values: stores.map((r) => r.count),
            colors: [SERIES[3], SERIES[4], SERIES[1]],
            horizontal: true,
            name: 'Count',
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s, chartTheme],
  )

  // ------------------------------------------------------------------ alerts
  const alerts: { key: string; color: string; text: string; to: string; tip: string }[] = []
  if (s && !s.consistent && !s.jobs_active) {
    alerts.push({
      key: 'consistency',
      color: 'error',
      text: 'Stores disagree on the document count',
      to: '/operations',
      tip: 'Run Reconcile to repair Qdrant and Neo4j from Elasticsearch.',
    })
  }
  if (s && (s.unclustered ?? s.unassigned) > 0) {
    alerts.push({
      key: 'unassigned',
      color: 'warning',
      text: `${fmtInt(s.unclustered ?? s.unassigned)} documents not clustered yet`,
      to: '/operations',
      tip: 'Documents added or changed since the last Leiden run. Run clustering to assign communities.',
    })
  }
  if (s && s.documents > 0 && !run) {
    alerts.push({ key: 'no-run', color: 'warning', text: 'Clustering has never run', to: '/operations', tip: 'Run Leiden under Operations.' })
  }
  if (activeJob) {
    alerts.push({
      key: 'job',
      color: 'processing',
      text: `${JOB_LABELS[activeJob.kind]} ${activeJob.status === 'queued' ? 'queued' : 'running'}`,
      to: activeJob.kind === 'import' ? '/import' : '/operations',
      tip: 'Open to follow its progress.',
    })
  }

  const recentJobs = useMemo(
    () => [...(jobs.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 8),
    [jobs.data],
  )

  const refresh = () => void invalidateCorpus(client)
  const loading = stats.isLoading

  return (
    <div className="nu-page">
      <PageHeader
        title="Dashboard"
        subtitle={
          s
            ? `${s.embedding_model.split('/').pop()} · k = ${s.neighbor_k}, similarity ≥ ${s.min_similarity} · Leiden γ = ${config?.leiden_gamma ?? s.leiden_gamma}`
            : 'Loading the corpus overview…'
        }
        actions={
          <>
            <Tooltip title={stats.dataUpdatedAt ? `Numbers from ${fmtRelative(new Date(stats.dataUpdatedAt).toISOString())}` : undefined}>
              <Button icon={<ReloadOutlined />} loading={stats.isFetching && !loading} onClick={refresh}>
                Refresh
              </Button>
            </Tooltip>
            <Button type="primary" icon={<ImportOutlined />} onClick={() => navigate('/import')}>
              Import data
            </Button>
          </>
        }
      />

      {alerts.length > 0 && (
        <Card size="small" className="nu-alert-strip">
          <Space size={6} wrap>
            <AlertOutlined style={{ color: 'var(--nu-warning-ink)' }} />
            <Text strong style={{ marginRight: 4 }}>
              Needs attention
            </Text>
            {alerts.map((alert) => (
              <Tooltip key={alert.key} title={alert.tip}>
                <Tag
                  color={alert.color}
                  bordered={false}
                  className="nu-alert-tag"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(alert.to)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      navigate(alert.to)
                    }
                  }}
                >
                  {alert.text}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        </Card>
      )}

      {empty ? (
        <Card className="nu-card">
          <EmptyState
            title="The corpus is empty"
            hint="Import a CSV with an id and a text column; the dashboard fills in as soon as it is indexed."
            icon={<ImportOutlined />}
            action={
              <Button type="primary" onClick={() => navigate('/import')}>
                Import a CSV
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          <div className="nu-kpis nu-kpis--8" aria-label="Corpus statistics">
            <StatCard
              label="Documents"
              icon={<FileTextOutlined />}
              value={fmtInt(s?.documents)}
              loading={loading}
              hint={s ? `${fmtBytes(s.stores.elasticsearch.store_bytes)} in Elasticsearch` : undefined}
              onClick={() => navigate(links.explore())}
            />
            <StatCard
              label="Similarity edges"
              icon={<NodeIndexOutlined />}
              accent="info"
              value={fmtInt(s?.edges)}
              loading={loading}
              hint={s ? `k = ${s.neighbor_k}, cosine ≥ ${s.min_similarity}` : undefined}
              onClick={() => navigate(links.graph())}
            />
            <StatCard
              label="Communities"
              icon={<ClusterOutlined />}
              accent="success"
              value={fmtInt(s?.communities)}
              loading={loading}
              hint={`Groups of ${s?.min_community_size ?? 2} or more documents, found by weighted Leiden`}
              onClick={() => navigate(links.communities())}
            />
            <StatCard
              label="Not clustered yet"
              icon={<QuestionCircleOutlined />}
              accent={s && (s.unclustered ?? s.unassigned) > 0 ? 'warning' : 'neutral'}
              value={fmtInt(s?.unclustered ?? s?.unassigned)}
              loading={loading}
              hint="Added or changed since the last clustering run"
              onClick={() => navigate(links.explore({ rules: [rule.unclustered()] }))}
            />
            <StatCard
              label="In no community"
              icon={<DisconnectOutlined />}
              accent="neutral"
              value={fmtInt(s?.outside_communities)}
              loading={loading}
              hint={s ? `Too loosely linked; ${fmtInt(s.isolated_nodes)} have no neighbour` : undefined}
              onClick={() => navigate(links.explore({ rules: [rule.clustered(), rule.unassigned()] }))}
            />
            <StatCard
              label="Modularity"
              icon={<TrophyOutlined />}
              accent="accent"
              value={run ? fmtScore(run.modularity) : '—'}
              loading={loading}
              hint={run ? `Run v${run.version}, ${fmtRelative(run.ran_at)}` : 'No clustering run yet'}
              onClick={() => navigate('/operations')}
            />
            <StatCard
              label="Mean degree"
              icon={<BranchesOutlined />}
              accent="info"
              value={s ? s.mean_degree.toFixed(2) : '—'}
              loading={loading}
              hint="Average similarity edges per document"
              onClick={() => navigate(links.graph())}
            />
            <StatCard
              label="Data sources"
              icon={<DatabaseOutlined />}
              accent="neutral"
              value={fmtInt(sources.data?.sources.length)}
              loading={sources.isLoading}
              hint="Import labels, e.g. csv:news.csv"
              onClick={() => navigate('/operations')}
            />
          </div>

          <div className="nu-chart-grid">
            <div className="nu-span-8">
              <ChartCard
                id="community-sizes"
                title="Community sizes"
                description="The 40 largest communities; click a bar to open it."
                loading={communities.isLoading}
                option={sizesOption}
                rows={sizes.map((c) => ({ community: `C${c.community_id}`, size: c.size, cohesion: c.avg_similarity }))}
                columns={[
                  { key: 'community', label: 'Community' },
                  { key: 'size', label: 'Documents' },
                  { key: 'cohesion', label: 'Cohesion' },
                ]}
                height={280}
                empty={{ title: 'No communities yet', hint: 'Run clustering under Operations.' }}
                onSelect={(_, index) => {
                  const picked = sizes[index]
                  if (picked) navigate(links.communities({ selected: picked.community_id }))
                }}
              />
            </div>
            <div className="nu-span-4">
              <ChartCard
                id="documents-by-source"
                title="Documents by source"
                loading={insights.isLoading}
                option={sourceOption}
                rows={bySource.map((b) => ({ source: b.value === null ? NO_SOURCE : String(b.value), documents: b.count }))}
                columns={[
                  { key: 'source', label: 'Source' },
                  { key: 'documents', label: 'Documents' },
                ]}
                height={280}
                onSelect={(_, index) => {
                  const picked = bySource[index]
                  if (picked) navigate(links.explore({ rules: [rule.source(picked.value === null ? null : String(picked.value))] }))
                }}
              />
            </div>

            <div className="nu-span-6">
              <ChartCard
                id="clustering-history"
                title="Clustering history"
                description="Modularity (line) and community count (bars) per Leiden run."
                loading={runs.isLoading}
                option={historyOption}
                rows={history.map((r) => ({
                  version: `v${r.version}`,
                  modularity: Number(r.modularity.toFixed(4)),
                  communities: r.community_count,
                  gamma: r.gamma,
                  duration: fmtMs(r.total_ms),
                }))}
                columns={[
                  { key: 'version', label: 'Run' },
                  { key: 'modularity', label: 'Modularity' },
                  { key: 'communities', label: 'Communities' },
                  { key: 'gamma', label: 'γ' },
                  { key: 'duration', label: 'Duration' },
                ]}
                height={260}
                empty={{ title: 'No clustering runs yet' }}
              />
            </div>
            <div className="nu-span-6">
              <ChartCard
                id="community-quality"
                title="Community quality"
                description="Cohesion (higher is tighter) against conductance (lower is better separated); bubble size is the community size."
                loading={communities.isLoading}
                option={qualityOption}
                rows={quality.map((c) => ({
                  community: `C${c.community_id}`,
                  cohesion: c.avg_similarity,
                  conductance: c.conductance,
                  size: c.size,
                }))}
                columns={[
                  { key: 'community', label: 'Community' },
                  { key: 'cohesion', label: 'Cohesion' },
                  { key: 'conductance', label: 'Conductance' },
                  { key: 'size', label: 'Documents' },
                ]}
                height={260}
                empty={{ title: 'No communities yet' }}
                onSelect={(name) => {
                  const id = Number(name.replace(/^C/, ''))
                  if (Number.isInteger(id)) navigate(links.communities({ selected: id }))
                }}
              />
            </div>

            <div className="nu-span-4">
              <ChartCard
                id="document-length"
                title="Document length"
                description="Characters per document; click a bar to list those documents."
                loading={insights.isLoading}
                option={lengthOption}
                rows={lengths.map((b) => ({ length: b.label, documents: b.count }))}
                columns={[
                  { key: 'length', label: 'Characters' },
                  { key: 'documents', label: 'Documents' },
                ]}
                height={240}
                onSelect={(_, index) => {
                  const picked = lengths[index]
                  if (!picked) return
                  const from = picked.from ?? 0
                  const r = picked.to === null ? rule.lengthAtLeast(from) : rule.lengthBetween(from, picked.to - 1)
                  navigate(links.explore({ rules: [r] }))
                }}
              />
            </div>
            <div className="nu-span-4">
              <ChartCard
                id="documents-over-time"
                title="Documents added over time"
                loading={insights.isLoading}
                option={timelineOption}
                rows={timeline.map((b) => ({ bucket: bucketLabel(b.bucket, interval), documents: b.count }))}
                columns={[
                  { key: 'bucket', label: 'Period' },
                  { key: 'documents', label: 'Documents' },
                ]}
                height={240}
              />
            </div>
            <div className="nu-span-4">
              <ChartCard
                id="store-consistency"
                title="Store consistency"
                description={
                  s ? (
                    s.consistent ? (
                      <Text type="success">All three stores agree.</Text>
                    ) : (
                      <Text type="warning">The stores disagree — reconcile under Operations.</Text>
                    )
                  ) : undefined
                }
                loading={loading}
                option={storesOption}
                rows={stores.map((r) => ({ store: r.store, holds: r.role, count: r.count }))}
                columns={[
                  { key: 'store', label: 'Store' },
                  { key: 'holds', label: 'Holds' },
                  { key: 'count', label: 'Count' },
                ]}
                height={214}
              />
            </div>
          </div>
        </>
      )}

      <Card
        size="small"
        className="nu-card"
        title={
          <Space>
            <ApartmentOutlined />
            Recent jobs
          </Space>
        }
        extra={
          <Button type="text" onClick={() => navigate('/operations')}>
            All jobs
          </Button>
        }
      >
        {jobs.isLoading ? (
          <Skeleton active paragraph={{ rows: 4 }} />
        ) : recentJobs.length === 0 ? (
          <EmptyState compact title="No jobs have run in this API process yet" />
        ) : (
          <Timeline
            style={{ marginTop: 8 }}
            items={recentJobs.map((job) => ({
              color: statusColor(job.status),
              children: (
                <div>
                  <Text strong>{JOB_LABELS[job.kind] ?? job.kind}</Text>{' '}
                  <Tag bordered={false} style={{ color: statusColor(job.status) }}>
                    {job.status}
                  </Tag>
                  <Text type="secondary">{jobLine(job)}</Text>
                  <div style={{ fontSize: 11.5, color: 'var(--nu-text-tertiary)' }}>
                    <Tooltip title={new Date(job.created_at).toLocaleString()}>
                      <span>{fmtRelative(job.created_at)}</span>
                    </Tooltip>
                    {typeof job.params.filename === 'string' && ` · ${job.params.filename}`}
                  </div>
                </div>
              ),
            }))}
          />
        )}
      </Card>

      <PageDoc doc={PAGE_DOCS.overview} />
    </div>
  )
}
