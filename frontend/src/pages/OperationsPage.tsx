import { useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  ClusterOutlined,
  DatabaseOutlined,
  DeleteOutlined,
  NodeIndexOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { FINISHED, keys, useClusterRuns, useConfig, useJobs, useSources } from '@/api/hooks'
import type { ClusterRun, DataSource, Job, JobKind } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { ChartCard } from '@/components/ChartCard'
import { lineBarOption } from '@/components/charts/options'
import { EmptyState } from '@/components/EmptyState'
import { JOB_LABELS, JobProgress } from '@/components/JobProgress'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { fmtInt, fmtMs, fmtRelative, fmtScore } from '@/lib/format'
import { links, rule } from '@/lib/links'
import { useAppearance } from '@/theme/AppearanceProvider'
import { statusColor } from '@/theme/tokens'

const { Text, Paragraph } = Typography

const NO_SOURCE = '(no source)'
/** A finished job stays on its card this long, so its outcome is still there on return. */
const RECENT_MS = 10 * 60_000
/** Above this, deleting a source asks for its name to be typed. */
const TYPE_TO_CONFIRM = 1000

// Jobs whose success was already announced; a remounted card must not toast again.
const announced = new Set<string>()

function jobSummary(job: Job): string {
  const r = (job.result ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (typeof v === 'number' ? fmtInt(v) : '0')
  switch (job.kind) {
    case 'import':
      return `${num(r.created)} created, ${num(r.updated)} updated, ${num(r.failed)} failed`
    case 'cluster':
      return `${num(r.community_count)} communities`
    case 'rebuild':
      return `${num(r.edge_upserts)} edges`
    case 'reconcile':
      return `${num(r.reembedded)} repaired, ${num(r.orphans_removed)} orphans removed`
    case 'delete':
      return `${num(r.deleted)} deleted from ${r.source === null || r.source === undefined ? NO_SOURCE : String(r.source)}`
    default:
      return 'done'
  }
}

function duration(job: Job): string {
  if (!job.started_at) return '—'
  const end = job.finished_at ? new Date(job.finished_at).getTime() : Date.now()
  return fmtMs(end - new Date(job.started_at).getTime())
}

const byNewest = (a: Job, b: Job) => b.created_at.localeCompare(a.created_at)

/**
 * The job a card should show, derived from the server's job list rather than
 * from component state: coming back to the page must find a running job where
 * it was left. Priority: running/queued, then one started from this view, then
 * one that finished in the last few minutes.
 */
function jobFor(jobs: Job[], kind: JobKind, startedId: string | undefined, dismissed: Set<string>): string | null {
  const ofKind = jobs.filter((j) => j.kind === kind).sort(byNewest)
  const active = ofKind.find((j) => !FINISHED.includes(j.status))
  if (active) return active.id
  if (startedId && !dismissed.has(startedId)) return startedId
  const recent = ofKind.find(
    (j) => j.finished_at && Date.now() - new Date(j.finished_at).getTime() < RECENT_MS && !dismissed.has(j.id),
  )
  return recent?.id ?? null
}

function Field({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Tooltip title={hint}>
        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
          {label}
        </Text>
      </Tooltip>
      {children}
    </div>
  )
}

/** A start button that says why it is disabled rather than just greying out. */
function StartButton({ busy, children, ...props }: { busy: boolean; children: ReactNode } & React.ComponentProps<typeof Button>) {
  const button = (
    <Button {...props} disabled={busy || props.disabled}>
      {children}
    </Button>
  )
  return busy ? (
    <Tooltip title="Another job is running. Jobs run one at a time so the graph is never changed twice at once.">
      <span style={{ display: 'inline-block' }}>{button}</span>
    </Tooltip>
  ) : (
    button
  )
}

function JobSlot({ jobId, onDismiss, onDone }: { jobId: string | null; onDismiss: (id: string) => void; onDone?: (job: Job) => void }) {
  if (!jobId) return null
  return (
    <div style={{ marginTop: 12 }}>
      <JobProgress jobId={jobId} onDone={onDone} />
      <Button type="text" style={{ marginTop: 4, paddingInline: 0 }} onClick={() => onDismiss(jobId)}>
        Hide this result
      </Button>
    </div>
  )
}

export default function OperationsPage() {
  const { message } = App.useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const { chartTheme } = useAppearance()
  const { data: config } = useConfig()
  const { data: jobs = [], isLoading: jobsLoading } = useJobs()
  const { data: runs = [], isLoading: runsLoading } = useClusterRuns()
  const sources = useSources()

  const [started, setStarted] = useState<Partial<Record<JobKind, string>>>({})
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const dismiss = (id: string) => setDismissed((prev) => new Set(prev).add(id))

  const [gamma, setGamma] = useState<number | null>(null)
  const [seed, setSeed] = useState<number | null>(null)
  const [minSize, setMinSize] = useState<number | null>(null)
  const [k, setK] = useState<number | null>(null)
  const [threshold, setThreshold] = useState<number | null>(null)
  const [clusterAfter, setClusterAfter] = useState(true)

  const [deleting, setDeleting] = useState<DataSource | null>(null)
  const [reclusterAfterDelete, setReclusterAfterDelete] = useState(true)
  const [confirmText, setConfirmText] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const busy = jobs.some((j) => !FINISHED.includes(j.status))
  const slot = (kind: JobKind) => jobFor(jobs, kind, started[kind], dismissed)

  const start = async (kind: JobKind, fn: () => Promise<Job>) => {
    try {
      const job = await fn()
      setStarted((prev) => ({ ...prev, [kind]: job.id }))
      void client.invalidateQueries({ queryKey: keys.jobs })
      return job
    } catch (e) {
      message.error((e as Error).message)
      return null
    }
  }

  const openDelete = (source: DataSource) => {
    setDeleting(source)
    setReclusterAfterDelete(true)
    setConfirmText('')
  }

  const deleteLabel = (source: string | null) => source ?? NO_SOURCE
  const mustType = !!deleting && deleting.documents > TYPE_TO_CONFIRM
  const typedOk = !mustType || confirmText.trim() === deleteLabel(deleting?.source ?? null)

  const confirmDelete = async () => {
    if (!deleting) return
    setSubmitting(true)
    const job = await start('delete', () => api.deleteSourceJob({ source: deleting.source, cluster: reclusterAfterDelete }))
    setSubmitting(false)
    if (job) setDeleting(null)
  }

  const onDeleteDone = (job: Job) => {
    if (job.status !== 'succeeded' || announced.has(job.id) || job.id !== started.delete) return
    announced.add(job.id)
    const r = (job.result ?? {}) as Record<string, unknown>
    message.success(`Deleted ${fmtInt(Number(r.deleted ?? 0))} documents from ${deleteLabel((r.source as string | null) ?? null)}`)
  }

  // ------------------------------------------------------------------ tables
  const maxDocs = Math.max(1, ...(sources.data?.sources ?? []).map((s) => s.documents))
  const sourceColumns: ColumnsType<DataSource> = [
    {
      title: 'Source',
      dataIndex: 'source',
      render: (source: string | null) =>
        source === null ? <Text type="secondary">{NO_SOURCE}</Text> : <Text className="mono">{source}</Text>,
    },
    {
      title: 'Documents',
      dataIndex: 'documents',
      width: 220,
      sorter: (a, b) => a.documents - b.documents,
      defaultSortOrder: 'descend',
      render: (n: number) => (
        <Space>
          <span style={{ fontVariantNumeric: 'tabular-nums', minWidth: 56, display: 'inline-block' }}>{fmtInt(n)}</span>
          <Progress percent={(n / maxDocs) * 100} showInfo={false} size="small" style={{ width: 90, margin: 0 }} aria-hidden />
        </Space>
      ),
    },
    {
      title: <Tooltip title="Documents in no community: not clustered yet, or too loosely linked to join one">No community</Tooltip>,
      dataIndex: 'unassigned',
      width: 130,
      responsive: ['md'],
      render: fmtInt,
    },
    {
      title: 'First imported',
      dataIndex: 'first_created',
      width: 140,
      responsive: ['lg'],
      render: (v: string | null) => (v ? <Tooltip title={new Date(v).toLocaleString()}>{fmtRelative(v)}</Tooltip> : '—'),
    },
    {
      title: 'Last updated',
      dataIndex: 'last_updated',
      width: 140,
      responsive: ['md'],
      render: (v: string | null) => (v ? <Tooltip title={new Date(v).toLocaleString()}>{fmtRelative(v)}</Tooltip> : '—'),
    },
    {
      title: <span className="sr-only">Actions</span>,
      key: 'actions',
      width: 200,
      align: 'right',
      render: (_, row) => (
        <Space size={4}>
          <Button
            type="text"
            icon={<SearchOutlined />}
            aria-label={`Explore documents from ${deleteLabel(row.source)}`}
            onClick={() => navigate(links.explore({ rules: [rule.source(row.source)] }))}
          >
            Explore
          </Button>
          <Tooltip title={busy ? 'Another job is running; deleting waits for it.' : undefined}>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              disabled={busy}
              aria-label={`Delete all documents from ${deleteLabel(row.source)}`}
              onClick={() => openDelete(row)}
            >
              Delete…
            </Button>
          </Tooltip>
        </Space>
      ),
    },
  ]

  const jobColumns: ColumnsType<Job> = [
    { title: 'Job', dataIndex: 'kind', width: 130, render: (kind: JobKind) => JOB_LABELS[kind] ?? kind },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 120,
      render: (status: Job['status'], job) => (
        <Tooltip title={job.error ?? job.phase}>
          <Badge color={statusColor(status)} text={status} />
        </Tooltip>
      ),
    },
    {
      title: 'Progress',
      render: (_, job) => {
        // Finished jobs: summarise the result; the counters only describe the last phase.
        if (job.status === 'succeeded') return jobSummary(job)
        if (job.status === 'failed') return <Text type="danger">{job.error ?? 'failed'}</Text>
        if (job.status !== 'running' && job.status !== 'queued') return job.phase
        return job.total ? `${job.phase} ${fmtInt(job.processed)} / ${fmtInt(job.total)}` : job.phase
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      width: 120,
      render: (v: string) => <Tooltip title={new Date(v).toLocaleString()}>{fmtRelative(v)}</Tooltip>,
    },
    { title: 'Duration', key: 'duration', width: 100, responsive: ['md'], render: (_, job) => duration(job) },
    {
      title: <span className="sr-only">Actions</span>,
      width: 90,
      render: (_, job) =>
        job.status === 'running' || job.status === 'queued' ? (
          <Button type="text" aria-label={`Cancel ${JOB_LABELS[job.kind]} job`} onClick={() => api.cancelJob(job.id)}>
            Cancel
          </Button>
        ) : null,
    },
  ]

  const runColumns: ColumnsType<ClusterRun> = [
    { title: 'Run', dataIndex: 'version', width: 70, render: (v: number) => `v${v}` },
    { title: 'Communities', dataIndex: 'community_count', width: 110, render: fmtInt },
    {
      title: <Tooltip title="Documents clustered into a group smaller than the minimum community size">In none</Tooltip>,
      dataIndex: 'outside_documents',
      width: 90,
      render: (v?: number) => (v === undefined ? '—' : fmtInt(v)),
    },
    { title: 'Modularity', dataIndex: 'modularity', width: 100, render: (v: number) => fmtScore(v) },
    { title: 'γ', dataIndex: 'gamma', width: 60 },
    { title: 'k / min', key: 'policy', width: 90, render: (_, r) => `${r.neighbor_k} / ${r.min_similarity}` },
    { title: 'Duration', dataIndex: 'total_ms', width: 90, render: (v: number) => fmtMs(v) },
    { title: 'When', dataIndex: 'ran_at', render: (v: string) => fmtRelative(v) },
  ]

  const history = useMemo(() => [...runs].reverse(), [runs])
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
  const sortedJobs = useMemo(() => [...jobs].sort(byNewest), [jobs])

  return (
    <div className="nu-page">
      <PageHeader
        title="Operations"
        subtitle="Maintenance jobs run one at a time in the background; their progress survives page changes and reloads."
        tag={busy ? <Badge status="processing" text="A job is running" /> : undefined}
      />

      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', alignItems: 'start' }}>
        <Card
          className="nu-card"
          size="small"
          title={
            <Space>
              <ClusterOutlined />
              Cluster (Leiden)
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            Runs weighted Leiden on the current graph and writes a new community version to Neo4j, Qdrant and Elasticsearch.
          </Paragraph>
          <Field label={`Resolution γ (default ${config?.leiden_gamma ?? 1})`} hint="Higher γ: more, smaller communities. Lower: fewer, broader ones.">
            <InputNumber style={{ width: '100%' }} min={0.05} max={50} step={0.1} placeholder={String(config?.leiden_gamma ?? 1)} value={gamma} onChange={setGamma} />
          </Field>
          <Field label="Random seed" hint="A fixed seed makes runs reproducible for the same graph.">
            <InputNumber style={{ width: '100%' }} placeholder={String(config?.leiden_random_seed ?? 42)} value={seed} onChange={setSeed} />
          </Field>
          <Field
            label={`Minimum community size (default ${config?.leiden_min_community_size ?? 2})`}
            hint="Smaller Leiden groups — typically documents with no neighbour, alone in a group of one — are left in no community. Never less than 2. The default is the size of the last run (an import sets it too)."
          >
            <InputNumber
              style={{ width: '100%' }}
              min={2}
              max={100000}
              precision={0}
              placeholder={String(config?.leiden_min_community_size ?? 2)}
              value={minSize}
              onChange={setMinSize}
            />
          </Field>
          <StartButton
            type="primary"
            busy={busy}
            onClick={() =>
              start('cluster', () =>
                api.clusterJob({ gamma: gamma ?? undefined, random_seed: seed ?? undefined, min_community_size: minSize ?? undefined }),
              )
            }
          >
            Run clustering
          </StartButton>
          <JobSlot jobId={slot('cluster')} onDismiss={dismiss} />
        </Card>

        <Card
          className="nu-card"
          size="small"
          title={
            <Space>
              <NodeIndexOutlined />
              Rebuild similarity graph
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            Deletes every SIMILAR_TO edge and recomputes k-nearest neighbours for all documents with a new policy.
          </Paragraph>
          <Field
            label={`Neighbours per document k (now ${config?.policy.neighbor_k ?? '—'})`}
            hint="More neighbours: denser graph, fewer isolated documents, larger communities."
          >
            <InputNumber style={{ width: '100%' }} min={1} max={200} placeholder={String(config?.policy.neighbor_k ?? 12)} value={k} onChange={setK} />
          </Field>
          <Field
            label={`Minimum similarity (now ${config?.policy.min_similarity ?? '—'})`}
            hint="Edges below this cosine are not created. Higher values split weakly related topics."
          >
            <InputNumber
              style={{ width: '100%' }}
              min={-1}
              max={1}
              step={0.01}
              placeholder={String(config?.policy.min_similarity ?? 0.58)}
              value={threshold}
              onChange={setThreshold}
            />
          </Field>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
            <Switch checked={clusterAfter} onChange={setClusterAfter} />
            Cluster afterwards
          </label>
          <Popconfirm
            title="Rebuild all edges?"
            description="Search keeps working; graph views are incomplete until the job finishes."
            disabled={busy}
            onConfirm={() =>
              start('rebuild', () => api.rebuildJob({ neighbor_k: k ?? undefined, min_similarity: threshold ?? undefined, cluster: clusterAfter }))
            }
          >
            <StartButton busy={busy}>Rebuild graph</StartButton>
          </Popconfirm>
          <JobSlot jobId={slot('rebuild')} onDismiss={dismiss} />
        </Card>

        <Card
          className="nu-card"
          size="small"
          title={
            <Space>
              <SafetyCertificateOutlined />
              Reconcile stores
            </Space>
          }
        >
          <Paragraph type="secondary" style={{ fontSize: 13 }}>
            Elasticsearch is the source of truth. Reconcile re-embeds documents missing from Qdrant, removes vectors and nodes whose
            document no longer exists, and re-links repaired documents.
          </Paragraph>
          <StartButton busy={busy} onClick={() => start('reconcile', api.reconcileJob)}>
            Run reconcile
          </StartButton>
          <JobSlot jobId={slot('reconcile')} onDismiss={dismiss} />
        </Card>
      </div>

      <Card
        className="nu-card"
        size="small"
        title={
          <Space>
            <DatabaseOutlined />
            Data sources
          </Space>
        }
        extra={<Text type="secondary">{fmtInt(sources.data?.total)} documents in total</Text>}
      >
        <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 12 }}>
          Every import is labelled with a source (by default <code>csv:&lt;file name&gt;</code>). Deleting a source removes all of its
          documents from Elasticsearch, their vectors from Qdrant and their nodes and edges from Neo4j.
        </Paragraph>
        {sources.isError && <Alert type="error" showIcon message="Could not load the data sources" description={(sources.error as Error).message} />}
        <Table<DataSource>
          rowKey={(row) => row.source ?? '__none__'}
          dataSource={sources.data?.sources ?? []}
          columns={sourceColumns}
          loading={sources.isLoading}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 640 }}
          locale={{
            emptyText: (
              <EmptyState
                compact
                title="No data sources yet"
                action={<Button onClick={() => navigate('/import')}>Import a CSV</Button>}
              />
            ),
          }}
        />
        <JobSlot jobId={slot('delete')} onDismiss={dismiss} onDone={onDeleteDone} />
      </Card>

      {/* Jobs get the full width: their summaries are sentences, and half a row made them wrap four times. */}
      <Card className="nu-card" size="small" title="Jobs">
            <Table<Job>
              rowKey="id"
              dataSource={sortedJobs}
              columns={jobColumns}
              loading={jobsLoading}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              scroll={{ x: 560 }}
              locale={{ emptyText: <EmptyState compact title="No jobs have run in this API process yet" /> }}
            />
          </Card>

      <div className="nu-chart-grid">
        <div className="nu-span-4">
          <ChartCard
            id="operations-modularity"
            title="Modularity per run"
            loading={runsLoading}
            option={historyOption}
            rows={history.map((r) => ({ version: `v${r.version}`, modularity: Number(r.modularity.toFixed(4)), communities: r.community_count }))}
            columns={[
              { key: 'version', label: 'Run' },
              { key: 'modularity', label: 'Modularity' },
              { key: 'communities', label: 'Communities' },
            ]}
            height={220}
            empty={{ title: 'No clustering runs yet' }}
          />
        </div>
        <div className="nu-span-8">
          <Card className="nu-card" size="small" title="Clustering history" style={{ height: '100%' }}>
            <Table<ClusterRun>
              rowKey="version"
              dataSource={runs}
              columns={runColumns}
              loading={runsLoading}
              pagination={{ pageSize: 8, hideOnSinglePage: true }}
              scroll={{ x: 560 }}
              locale={{ emptyText: <EmptyState compact title="No clustering runs yet" /> }}
            />
          </Card>
        </div>
      </div>

      <Modal
        open={!!deleting}
        title={
          <Space>
            <DeleteOutlined />
            Delete {deleting ? deleteLabel(deleting.source) : ''}?
          </Space>
        }
        onCancel={() => setDeleting(null)}
        onOk={confirmDelete}
        okText={deleting ? `Delete ${fmtInt(deleting.documents)} documents` : 'Delete'}
        okButtonProps={{ danger: true, disabled: !typedOk || busy, loading: submitting }}
        destroyOnHidden
      >
        {deleting && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Paragraph style={{ marginBottom: 0 }}>
              This removes <Text strong>{fmtInt(deleting.documents)} documents</Text> from Elasticsearch, their vectors from Qdrant and
              their nodes and edges from Neo4j. It cannot be undone; re-import the file to get them back.
            </Paragraph>
            <Checkbox checked={reclusterAfterDelete} onChange={(e) => setReclusterAfterDelete(e.target.checked)}>
              Re-cluster afterwards (communities of the remaining documents are recomputed)
            </Checkbox>
            {mustType && (
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Type <Text code>{deleteLabel(deleting.source)}</Text> to confirm
                </Text>
                <Input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  aria-label="Type the source name to confirm"
                  autoComplete="off"
                  status={confirmText && !typedOk ? 'error' : undefined}
                />
              </div>
            )}
            {busy && <Alert type="info" showIcon message="Another job is running; start the delete when it finishes." />}
          </Space>
        )}
      </Modal>

      <PageDoc doc={PAGE_DOCS.operations} />
    </div>
  )
}
