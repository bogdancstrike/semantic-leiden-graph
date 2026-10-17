import { useState } from 'react'
import { Alert, Button, Card, Collapse, Form, DatePicker, InputNumber, Pagination, Select, Skeleton, Space, Tag, Typography } from 'antd'
import type { Dayjs } from 'dayjs'
import { ExperimentOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'
import { FINISHED, useJobs } from '@/api/hooks'
import type { AnalysisRequest } from '@/api/types'
import { useDocumentDrawer } from './DocumentDrawer'
import { JobProgress } from './JobProgress'
import { fmtInt } from '@/lib/format'

const date = (value: string) => new Date(value).toLocaleString()

/** Runs and immutable evidence snapshots survive leaving this page or restarting the API. */
export function AnalysisPanel() {
  const queryClient = useQueryClient()
  const drawer = useDocumentDrawer()
  const [period, setPeriod] = useState('24')
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null)
  const [maxCommunities, setMaxCommunities] = useState<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [startedJob, setStartedJob] = useState<string | null>(null)
  const { data: jobs = [] } = useJobs()
  const active = jobs.find((job) => job.kind === 'analysis' && !FINISHED.includes(job.status))
  const config = useQuery({ queryKey: ['analysis-config'], queryFn: ({ signal }) => api.analysisConfig(signal), refetchInterval: 30_000 })
  const history = useQuery({ queryKey: ['analysis-runs', page], queryFn: ({ signal }) => api.analysisRuns((page - 1) * 20, signal), refetchInterval: active ? 2_000 : 15_000 })
  const runId = selectedId ?? history.data?.runs[0]?.id ?? null
  const report = useQuery({
    queryKey: ['analysis-run', runId],
    queryFn: ({ signal }) => api.analysisRun(runId!, signal),
    enabled: !!runId,
    refetchInterval: (query) => query.state.data && ['queued', 'running'].includes(query.state.data.status) ? 2_000 : false,
  })
  const start = useMutation({
    mutationFn: (body: AnalysisRequest) => api.analyze(body),
    onSuccess: (job) => {
      setStartedJob(job.id)
      setSelectedId(String(job.params.analysis_id))
      setPage(1)
      void queryClient.invalidateQueries({ queryKey: ['analysis-runs'] })
      void queryClient.invalidateQueries({ queryKey: ['jobs'] })
    },
  })
  const settings = config.data
  const run = report.data
  const jobId = active?.id ?? startedJob
  const maximum = maxCommunities ?? settings?.max_communities ?? 100

  const request: AnalysisRequest = { max_communities: maximum, ...(period === 'all' ? { time_range: 'all' as const } : period === 'custom' ? { time_range: 'custom' as const, window_start: range?.[0]?.toISOString(), window_end: range?.[1]?.toISOString() } : { time_range: 'relative' as const, lookback_hours: Number(period) }) }
  const validPeriod = period !== 'custom' || (!!range?.[0] && !!range?.[1] && range[0].isBefore(range[1]))

  return (
    <Card className="nu-card" size="small" title={<Space><ExperimentOutlined /><span>Community analysis</span></Space>}>
      {config.isLoading && <Skeleton active paragraph={{ rows: 2 }} />}
      {config.error && <Alert type="error" showIcon message="Analysis settings could not be loaded" description={config.error.message} />}
      {settings && <>
        <Typography.Paragraph type="secondary">
          Discover topics, select their most central documents in the period, and analyze the evidence with {settings.provider} ({settings.model}).
          {' '}{settings.schedule.enabled
            ? `Automatic analysis every ${settings.schedule.interval_hours} hours covers the last 24 hours. Next: ${settings.schedule.next_run_at ? date(settings.schedule.next_run_at) : 'pending'}.`
            : 'Automatic analysis is disabled.'}
        </Typography.Paragraph>
        {!settings.configured && <Alert style={{ marginBottom: 12 }} type="info" showIcon message={`Set ${settings.provider.toUpperCase()}_API_KEY on the server to enable analysis.`} />}
        <Form layout="inline" onFinish={() => start.mutate(request)} style={{ gap: 12, marginBottom: 16 }}>
          <Form.Item label="Documents per topic"><Typography.Text>Automatic · maximum that fits the model</Typography.Text></Form.Item>
          <Form.Item label="Period"><Select aria-label="Analysis period" value={period} onChange={setPeriod} style={{ width: 170 }} options={[{ value: '24', label: 'Last 24 hours' }, { value: '168', label: 'Last 7 days' }, { value: '720', label: 'Last 30 days' }, { value: 'custom', label: 'Custom range' }, { value: 'all', label: 'All time' }]} /></Form.Item>
          {period === 'custom' && <Form.Item label="Date and time"><DatePicker.RangePicker aria-label="Analysis date and time range" placeholder={['Start date and time', 'End date and time']} showTime needConfirm={false} format="YYYY-MM-DD HH:mm" value={range} onChange={setRange} style={{ maxWidth: '100%' }} /></Form.Item>}
          <Form.Item label="Maximum topics"><InputNumber aria-label="Maximum topics" min={1} max={1000} precision={0} value={maximum} onChange={setMaxCommunities} /></Form.Item>
          <Form.Item><Button type="primary" htmlType="submit" loading={start.isPending} disabled={!settings.configured || !!active || !validPeriod} icon={<ExperimentOutlined />}>Analyze now</Button></Form.Item>
        </Form>
      </>}
      {start.error && <Alert type="error" showIcon message="Analysis could not start" description={start.error.message} style={{ marginBottom: 12 }} />}
      {jobId && <div style={{ marginBottom: 16 }}><JobProgress jobId={jobId} /></div>}
      {history.error && <Alert type="error" message="Analysis history could not be loaded" description={history.error.message} />}
      {!!history.data?.runs.length && <Space wrap style={{ marginBottom: 16 }}>
        <Typography.Text>Report</Typography.Text>
        <Select aria-label="Analysis report" style={{ minWidth: 280 }} value={runId} onChange={setSelectedId}
          options={history.data.runs.map((item) => ({ value: item.id, label: `${date(item.created_at)} · ${item.trigger} · ${item.status}` }))} />
        <Pagination simple current={page} pageSize={20} total={history.data.total} hideOnSinglePage onChange={(value) => { setPage(value); setSelectedId(null) }} />
      </Space>}
      {report.isLoading && runId && <Skeleton active />}
      {report.error && <Alert type="error" message="Analysis report could not be loaded" description={report.error.message} />}
      {run && <div aria-live="polite">
        <Typography.Paragraph type="secondary">
          {run.window_start ? date(run.window_start) : 'All time'} – {date(run.window_end)} · {run.provider}/{run.model} · clustering version {run.community_version ?? 'pending'}
          {' '}<Tag color={run.status === 'succeeded' ? 'green' : run.status === 'failed' ? 'red' : 'orange'}>{run.status}</Tag>
          {run.eligible_documents !== undefined && ` · ${fmtInt(run.eligible_documents)} documents in the period · ${fmtInt(run.unassigned_documents)} without a community`}
        </Typography.Paragraph>
        {run.error && <Alert type="error" showIcon message={run.error} style={{ marginBottom: 12 }} />}
        {!!run.skipped_communities && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${run.skipped_communities} topics were skipped by the configured limit. Increase Maximum topics to include them.`} />}
        {run.status === 'partial' && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`${run.failed_communities} topics failed; successful analyses are shown below.`} />}
        {run.status === 'succeeded' && !run.communities?.length && <Alert type="info" showIcon message="No documents in the period in a community for this time window." />}
        <Collapse items={run.communities?.map((community) => ({
          key: community.community_id,
          label: <Space wrap><Tag>C{community.community_id}</Tag><span>{community.analysis?.title ?? `Topic C${community.community_id}`}</span><Typography.Text type="secondary">{community.documents.length} of {community.document_count} documents in the period · {community.status}</Typography.Text></Space>,
          children: <>
            {community.error && <Alert type="error" showIcon message={community.error} />}
            {community.analysis && <>
              <Typography.Paragraph>{community.analysis.summary}</Typography.Paragraph>
              {!!community.analysis.key_findings.length && <><Typography.Text strong>Key findings</Typography.Text><ul>{community.analysis.key_findings.map((finding, i) => <li key={i}>{finding}</li>)}</ul></>}
              {!!community.analysis.uncertainties.length && <><Typography.Text strong>Limitations</Typography.Text><ul>{community.analysis.uncertainties.map((finding, i) => <li key={i}>{finding}</li>)}</ul></>}
            </>}
            <Space wrap style={{ marginBottom: 12 }}><Button href={`/topics/${encodeURIComponent(`${run.id}:${community.community_id}`)}`}>Open topic</Button>{community.token_budget && <Typography.Text type="secondary">{fmtInt(community.token_budget.input_tokens)} / {fmtInt(community.token_budget.input_budget)} input tokens · {fmtInt(community.token_budget.output_reserve)} reserved for the response</Typography.Text>}</Space><br />
            <Typography.Text strong>Documents sent for analysis</Typography.Text>
            {community.documents.map((doc) => <div key={doc.id} style={{ marginTop: 12 }}>
              <Button type="link" style={{ padding: 0 }} onClick={() => drawer.open(doc.id)}>{doc.external_id}</Button>
              <Typography.Text type="secondary"> · centrality {doc.strength.toFixed(3)}{doc.truncated ? ' · excerpt' : ''}{community.analysis?.evidence_ids.includes(doc.id) ? ' · cited' : ''}</Typography.Text>
              <Typography.Paragraph ellipsis={{ rows: 3, expandable: true, symbol: 'Show evidence' }}>{doc.text}</Typography.Paragraph>
            </div>)}
          </>,
        }))} />
      </div>}
      {!history.isLoading && !history.data?.runs.length && !run && <Typography.Text type="secondary">No analysis reports yet. Analyze now to discover and summarize recent topics.</Typography.Text>}
    </Card>
  )
}
