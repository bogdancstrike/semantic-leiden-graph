import dayjs from 'dayjs'
import { TopicDeleteButton } from '@/components/TopicDeleteButton'
import { useState } from 'react'
import { Alert, Badge, Button, Card, DatePicker, Empty, Input, Pagination, Segmented, Select, Skeleton, Space, Tag, Tooltip, Typography } from 'antd'
import { ArrowRightOutlined, ExperimentOutlined, ReloadOutlined, StarFilled, StarOutlined, RiseOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '@/api/client'
import { FINISHED, useJobs } from '@/api/hooks'
import { PageHeader } from '@/components/PageHeader'
import { JobProgress } from '@/components/JobProgress'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useSavedTopics } from '@/hooks/useSavedTopics'
import { fmtInt, fmtRelative } from '@/lib/format'

export const sentimentColor = (value?: string) => ({ positive: 'green', negative: 'red', mixed: 'orange', neutral: 'blue', unclear: 'default' })[value ?? 'unclear']

export default function TopicsPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const [params, setParams] = useSearchParams()
  const saved = useSavedTopics()
  const [query, setQuery] = useState(params.get('q') ?? '')
  const debounced = useDebouncedValue(query, 250)
  const [page, setPage] = useState(1)
  const runId = params.get('run') ?? undefined
  const documentId = params.get('document') ?? undefined
  const sentiment = params.get('sentiment') ?? undefined
  const classification = params.get('class') ?? undefined
  const sort = params.get('sort') ?? 'recent'
  const period = params.get('period') ?? 'all'
  const view = params.get('view') ?? 'all'
  const patch = (values: Record<string, string | null>) => { setParams((current) => { const next = new URLSearchParams(current); for (const [key, value] of Object.entries(values)) { if (value) next.set(key, value); else next.delete(key) } return next }); setPage(1) }
  const { data: jobs = [] } = useJobs()
  const active = jobs.find((j) => j.kind === 'analysis' && !FINISHED.includes(j.status) && (!runId || j.params.analysis_id === runId))
  const history = useQuery({ queryKey: ['analysis-runs', 'topics'], queryFn: ({ signal }) => api.analysisRuns(0, signal), refetchInterval: 15_000 })
  const createdAfter = period === 'custom' ? params.get('after') ?? undefined : period === 'all' ? undefined : new Date(Date.now() - Number(period) * 3600000).toISOString()
  const topics = useQuery({ queryKey: ['topics', runId, documentId, debounced, sentiment, classification, sort, period, params.get('after'), params.get('before'), view, saved.ids.join(','), page], queryFn: ({ signal }) => api.topics({ run_id: runId, document_id: documentId, q: debounced, sentiment, classification, sort, created_after: createdAfter, created_before: period === 'custom' ? params.get('before') ?? undefined : undefined, trend: view === 'rising' ? 'rising' : undefined, topic_ids: view === 'saved' ? (saved.ids.length ? saved.ids : ['__none__']) : undefined, offset: (page - 1) * 24 }, signal), refetchInterval: active ? 2_000 : 15_000 })
  const rows = topics.data?.topics ?? []
  const classes = [...new Set(rows.flatMap((topic) => topic.analysis?.classifications ?? []))].sort()
  const stats = topics.data?.stats
  const empty = !topics.isLoading && !rows.length
  return <div className="nu-page topics-page">
    <div className="briefing-kicker"><span>INTELLIGENCE BRIEFING</span><Badge status="processing" text={active ? 'Analysis running' : 'Live updates'} /><Typography.Text type="secondary">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</Typography.Text></div>
    <PageHeader title="Topics" tag={<Tag>{fmtInt(topics.data?.total)} topic analyses</Tag>}
      subtitle="Follow the stories taking shape in your data. Investigate the narratives, people and organizations behind every community."
      actions={<Space><Tooltip title="Refresh saved analyses"><Button icon={<ReloadOutlined />} aria-label="Refresh topics" loading={topics.isFetching} onClick={() => void topics.refetch()} /></Tooltip><Button type="primary" icon={<ExperimentOutlined />} onClick={() => navigate('/communities')}>Analyze data</Button></Space>} />
    <div className="briefing-stats">{[['Analyzed topics', stats?.analyzed ?? topics.data?.total], ['Narratives', stats?.narratives], ['Named entities', stats?.entities], ['Rising topics', stats?.trending]].map(([label, count]) => <div className="briefing-stat" key={String(label)}><span>{label}</span><strong>{fmtInt(count as number | undefined)}</strong></div>)}</div>
    <Card className="nu-card topic-filters" size="small">
      <div className="topics-toolbar">
        <Input.Search aria-label="Search topics and narratives" placeholder="Search topics, narratives, people or organizations…" value={query} onChange={(e) => { setQuery(e.target.value); patch({ q: e.target.value || null }) }} allowClear style={{ flex: '1 1 300px' }} />
        <Segmented aria-label="Topic collection" value={view} onChange={(v) => patch({ view: v === 'all' ? null : String(v) })} options={[{ label: 'All topics', value: 'all' }, { label: <span><RiseOutlined /> Rising</span>, value: 'rising' }, { label: <span><StarOutlined /> Saved</span>, value: 'saved' }]} />
      </div>
      <div className="topics-toolbar" style={{ marginTop: 12 }}>
        <Select aria-label="Topic sentiment" placeholder="All sentiments" allowClear value={sentiment} onChange={(v) => patch({ sentiment: v ?? null })} style={{ width: 150 }} options={['positive', 'negative', 'neutral', 'mixed', 'unclear'].map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} />
        <Select aria-label="Topic classification" placeholder="All classifications" allowClear showSearch value={classification} onChange={(v) => patch({ class: v ?? null })} style={{ minWidth: 180 }} options={classes.map((v) => ({ value: v, label: v }))} />
        <Select aria-label="Analyzed during" value={period} onChange={(v) => patch({ period: v === 'all' ? null : v })} style={{ width: 180 }} options={[{ value: 'all', label: 'Analyzed: all time' }, { value: '24', label: 'Analyzed: last 24h' }, { value: '168', label: 'Analyzed: last 7 days' }, { value: 'custom', label: 'Custom date/time period' }]} />
        <Select aria-label="Sort topics" value={sort} onChange={(v) => patch({ sort: v === 'recent' ? null : v })} style={{ width: 175 }} options={[{ value: 'recent', label: 'Newest first' }, { value: 'documents', label: 'Largest communities' }, { value: 'coverage', label: 'Most evidence coverage' }]} />
        <Select aria-label="Topic analysis report" value={runId ?? 'all'} style={{ minWidth: 240, maxWidth: '100%' }} onChange={(v) => patch({ run: v === 'all' ? null : v })} options={[{ value: 'all', label: 'All analysis reports' }, ...(history.data?.runs ?? []).map((r) => ({ value: r.id, label: `${new Date(r.created_at).toLocaleString()} · ${r.trigger} · ${r.status}` }))]} />
      </div>
      {period === 'custom' && <DatePicker.RangePicker showTime needConfirm={false} aria-label="Topic analysis date range" placeholder={['Analyzed after', 'Analyzed before']} value={params.get('after') && params.get('before') ? [dayjs(params.get('after')), dayjs(params.get('before'))] : null} onChange={(range) => patch({ after: range?.[0]?.toISOString() ?? null, before: range?.[1]?.toISOString() ?? null })} style={{ marginTop: 12, maxWidth: '100%' }} />}
      {documentId && <Space style={{ marginTop: 12 }}><Tag>Related to document {documentId.slice(0, 8)}</Tag><Button onClick={() => patch({ document: null })}>Remove document filter</Button></Space>}
    </Card>
    {active && <Card className="nu-card" size="small" title="Analysis in progress"><JobProgress jobId={active.id} /></Card>}
    {topics.error && <Alert type="error" showIcon message="Topics could not be loaded" description={topics.error.message} />}
    {history.error && <Alert type="warning" showIcon message="Report history could not be loaded" description={history.error.message} />}
    {topics.isLoading && <Skeleton active paragraph={{ rows: 8 }} />}
    {empty && <Card className="nu-card"><Empty description={active ? 'Topics will appear as the analysis completes.' : view === 'saved' ? 'Save a topic to keep it in your daily reading list.' : view === 'rising' ? 'No confirmed rising topics yet. Trends need comparable, non-overlapping periods.' : 'No topic analyses match this view.'}><Space><Button onClick={() => { setQuery(''); setParams({}) }}>Clear filters</Button><Button onClick={() => navigate('/import')}>Import data</Button></Space></Empty></Card>}
    <div className="topics-grid">
      {rows.map((topic, index) => <Card className={`nu-card topic-card ${index === 0 && page === 1 ? 'topic-card-lead' : ''}`} key={topic.id}>
        <div className="topic-card-heading"><Space wrap size={6}><span className="topic-reference">C{topic.community_id} / v{topic.community_version ?? '—'}</span><Tag color={sentimentColor(topic.analysis?.sentiment)}>{topic.analysis?.sentiment ?? 'unclear'}</Tag>{topic.trend?.direction === 'rising' && <Tag color="green"><RiseOutlined /> Rising {topic.trend.share_change_percent}%</Tag>}</Space><Space size={0}><TopicDeleteButton id={topic.id} /><Button type="text" icon={saved.has(topic.id) ? <StarFilled /> : <StarOutlined />} aria-label={saved.has(topic.id) ? 'Unsave topic' : 'Save topic'} onClick={() => saved.toggle(topic.id)} /></Space></div>
        <Typography.Title level={3} className="topic-title"><Link to={`/topics/${encodeURIComponent(topic.id)}`} state={{ from: location.pathname + location.search }}>{topic.analysis?.title ?? `Community C${topic.community_id}`}</Link></Typography.Title>
        {topic.error && <Alert type="error" message={topic.error} />}
        <Typography.Paragraph ellipsis={{ rows: 4 }}>{topic.analysis?.summary ?? (topic.status === 'pending' ? 'Waiting for analysis…' : 'Analysis unavailable.')}</Typography.Paragraph>
        {!!topic.analysis?.narratives?.length && <div className="topic-narrative"><span className="briefing-kicker">NARRATIVES</span><ul>{topic.analysis.narratives.slice(0, 2).map((narrative, i) => <li key={i}>{narrative}</li>)}</ul>{topic.analysis.narratives.length > 2 && <Typography.Text type="secondary">+{topic.analysis.narratives.length - 2} more in this topic</Typography.Text>}</div>}
        {!!topic.analysis?.entities?.length && <div className="topic-entities"><Typography.Text type="secondary">Named entities</Typography.Text><Space wrap size={4}>{topic.analysis.entities.slice(0, 5).map((entity) => <Tooltip title={entity.label} key={`${entity.name}:${entity.label}`}><Tag>{entity.name}</Tag></Tooltip>)}</Space></div>}
        <Space wrap>{topic.analysis?.classifications?.map((label) => <Tag key={label}><button className="topic-tag-button" onClick={() => patch({ class: label })}>{label}</button></Tag>)}</Space>
        <div className="topic-card-foot"><div><Typography.Text type="secondary">{fmtInt(topic.document_count)} documents · {fmtInt(topic.selected_documents)} analyzed</Typography.Text><br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>{fmtRelative(topic.created_at)} · {topic.window_start ? `${new Date(topic.window_start).toLocaleDateString()}–${new Date(topic.window_end).toLocaleDateString()}` : 'All available data'}</Typography.Text></div><Link to={`/topics/${encodeURIComponent(topic.id)}`} state={{ from: location.pathname + location.search }}>Investigate <ArrowRightOutlined /></Link></div>
      </Card>)}
    </div>
    <Pagination current={page} pageSize={24} total={topics.data?.total ?? 0} showSizeChanger={false} hideOnSinglePage onChange={setPage} />
  </div>
}
