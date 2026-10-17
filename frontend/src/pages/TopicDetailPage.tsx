import { useCallback, useRef, useState } from 'react'
import { Alert, Button, Card, Collapse, Descriptions, Dropdown, Empty, Input, List, Pagination, Progress, Select, Skeleton, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd'
import { ArrowLeftOutlined, ApartmentOutlined, DownloadOutlined, ExpandOutlined, StarFilled, StarOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { api } from '@/api/client'
import { PageHeader } from '@/components/PageHeader'
import { GraphCanvas, CANVAS_PALETTES, type GraphCanvasHandle, type GraphArrangement } from '@/components/graph/GraphCanvas'
import { GraphContextMenu } from '@/components/graph/GraphContextMenu'
import { TopicDeleteButton } from '@/components/TopicDeleteButton'
import { useDocumentDrawer } from '@/components/DocumentDrawer'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { usePrefersReducedMotion } from '@/hooks/useReducedMotion'
import { useSavedTopics } from '@/hooks/useSavedTopics'
import { useAppearance } from '@/theme/AppearanceProvider'
import { fmtInt } from '@/lib/format'
import { downloadText } from '@/lib/download'
import { links } from '@/lib/links'
import { sentimentColor } from './TopicsPage'

export default function TopicDetailPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const drawer = useDocumentDrawer()
  const saved = useSavedTopics()
  const { mode } = useAppearance()
  const reduced = usePrefersReducedMotion()
  const graphRef = useRef<GraphCanvasHandle>(null)
  const [layout, setLayout] = useState<GraphArrangement>('communities')
  const [tab, setTab] = useState('analysis')
  const [query, setQuery] = useState('')
  const debounced = useDebouncedValue(query, 250)
  const [page, setPage] = useState(1)
  const [evidencePage, setEvidencePage] = useState(1)
  const [selected, setSelected] = useState<string | null>(null)
  const [snapshotQuery, setSnapshotQuery] = useState('')
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number } | null>(null)
  const closeContextMenu = useCallback(() => setContextPoint(null), [])
  const [entityType, setEntityType] = useState<string | undefined>()
  const topic = useQuery({ queryKey: ['topic', id], queryFn: ({ signal }) => api.topic(id, signal), refetchInterval: (q) => q.state.data?.community.status === 'pending' ? 2_000 : false })
  const docs = useQuery({ queryKey: ['topic-documents', id, debounced, page], queryFn: ({ signal }) => api.topicDocuments(id, debounced, (page - 1) * 20, signal), enabled: !!topic.data && tab === 'documents' })
  if (topic.isLoading) return <div className="nu-page"><Skeleton active paragraph={{ rows: 8 }} /></div>
  if (topic.error) return <div className="nu-page"><Alert type="error" showIcon message="Topic could not be loaded" description={topic.error.message} /><Link to="/topics">Back to Topics</Link></div>
  if (!topic.data) return null
  const { run, community } = topic.data
  const analysis = community.analysis
  const graph = community.graph
  const selectedNode = graph?.nodes.find(node => node.id === selected)
  const snapshotMatches = graph?.nodes.filter(node => `${node.external_id ?? ''} ${node.id} ${node.text ?? ''}`.toLocaleLowerCase().includes(snapshotQuery.toLocaleLowerCase())) ?? []
  const nodeMenu = { items: [
    { key: 'details', label: 'Show node details', disabled: !selectedNode },
    { key: 'live', label: 'Explore live connections', disabled: !selectedNode },
    { key: 'related', label: 'Find related topics', disabled: !selectedNode },
    { key: 'clear', label: 'Unselect node', disabled: !selectedNode },
    { key: 'fit', label: 'Fit graph to view' },
  ], onClick: ({ key }: { key: string }) => {
    if (key === 'fit') graphRef.current?.fit()
    if (key === 'clear') setSelected(null)
    if (key === 'details' && selectedNode) drawer.open(selectedNode.id)
    if (key === 'live' && selectedNode) navigate(links.graph({ focus: selectedNode.id }))
    if (key === 'related' && selectedNode) navigate(`/topics?document=${encodeURIComponent(selectedNode.id)}`)
  } }
  const budget = community.token_budget
  const trend = community.trend
  const coverage = community.document_count ? Math.round(community.documents.length / community.document_count * 100) : 0
  const sources = new Map<string, number>()
  community.documents.forEach((doc) => sources.set(doc.source ?? 'Unspecified source', (sources.get(doc.source ?? 'Unspecified source') ?? 0) + 1))
  const back = typeof location.state?.from === 'string' && location.state.from.startsWith('/topics') ? location.state.from : `/topics?run=${run.id}`
  const searchEntity = (name: string) => { setQuery(name); setPage(1); setTab('documents') }
  const exportBrief = () => downloadText(`topic-${run.id}-C${community.community_id}.md`, `# ${analysis?.title ?? 'Topic'}\n\n${analysis?.summary ?? ''}\n\n## Narratives\n${(analysis?.narratives ?? []).map(n => `- ${n}`).join('\n')}\n\n## Key findings\n${(analysis?.key_findings ?? []).map(n => `- ${n}`).join('\n')}\n\n## Named entities\n${(analysis?.entities ?? []).map(e => `- ${e.name} (${e.label})`).join('\n')}\n\nSentiment: ${analysis?.sentiment ?? 'unclear'}\n${analysis?.sentiment_reasoning ?? ''}\n\nClassifications: ${(analysis?.classifications ?? []).join(', ')}\n\n## Limitations\n${(analysis?.uncertainties ?? []).map(n => `- ${n}`).join('\n')}\n\nReport: ${run.id}, community C${community.community_id}, version ${run.community_version}\nPeriod: ${run.window_start ?? 'All time'} – ${run.window_end}\nModel: ${run.provider}/${run.model}\n`, 'text/markdown')
  const lines = (title: string, values?: string[]) => values?.length ? <section className="topic-reading-section"><Typography.Title level={4}>{title}</Typography.Title><ul>{values.map((v, i) => <li key={i}>{v}</li>)}</ul></section> : null
  const evidence = <><List dataSource={community.documents.slice((evidencePage - 1) * 20, evidencePage * 20)} renderItem={(doc) => <List.Item><div style={{ minWidth: 0 }}><Space wrap><Button type="link" onClick={() => drawer.open(doc.id)}>{doc.external_id}</Button><Tag>{doc.source ?? 'No source label'}</Tag>{analysis?.evidence_ids.includes(doc.id) && <Tag color="blue">Cited by LLM</Tag>}{doc.truncated && <Tag>Excerpt</Tag>}</Space><Typography.Paragraph ellipsis={{ rows: 4, expandable: true, symbol: 'Read evidence' }}>{doc.text}</Typography.Paragraph></div></List.Item>} /><Pagination current={evidencePage} pageSize={20} total={community.documents.length} onChange={setEvidencePage} showSizeChanger={false} hideOnSinglePage /></>
  return <div className="nu-page topics-page">
    <Link to={back} className="topic-back"><ArrowLeftOutlined /> Back to Topics</Link>
    <div className="briefing-kicker"><span>TOPIC DOSSIER</span><span>C{community.community_id} / VERSION {run.community_version ?? '—'}</span><Tag>{community.status}</Tag></div>
    <PageHeader title={analysis?.title ?? `Community C${community.community_id}`} tag={<Tag color={sentimentColor(analysis?.sentiment)}>{analysis?.sentiment ?? 'unclear'}</Tag>}
      subtitle={`${run.window_start ? new Date(run.window_start).toLocaleString() : 'All available data'} — ${new Date(run.window_end).toLocaleString()}`}
      actions={<Space wrap><Button icon={saved.has(id) ? <StarFilled /> : <StarOutlined />} onClick={() => saved.toggle(id)}>{saved.has(id) ? 'Saved' : 'Save topic'}</Button><Button icon={<DownloadOutlined />} onClick={exportBrief}>Export briefing</Button><TopicDeleteButton id={id} onDeleted={() => navigate(back)} /></Space>} />
    {community.error && <Alert type="error" showIcon message={community.error} />}
    <div className="topic-dossier-layout">
      <Card className="nu-card topic-dossier-main">
        <Tabs activeKey={tab} onChange={key => { setTab(key); closeContextMenu() }} items={[
          { key: 'analysis', label: 'Briefing', children: <div className="topic-analysis">
            {analysis ? <><Typography.Paragraph className="topic-summary-lead">{analysis.summary}</Typography.Paragraph>{lines('Key developments', analysis.key_findings)}{lines('Narratives in the documents', analysis.narratives)}
              {!analysis.narratives && <Alert type="info" message="Narratives were not extracted in this older report." />}
              {!!analysis.entities?.length && <section className="topic-reading-section"><Typography.Title level={4}>People, organizations and places</Typography.Title><Space wrap>{analysis.entities.slice(0, 12).map(e => <Tooltip title={`${e.label} · search within this topic`} key={`${e.name}:${e.label}`}><Button size="small" onClick={() => searchEntity(e.name)}>{e.name}</Button></Tooltip>)}</Space><Button type="link" onClick={() => setTab('entities')}>View all named entities</Button></section>}
              {lines('Limitations and uncertainties', analysis.uncertainties)}</> : <Empty description="Analysis has not completed for this topic." />}
            <Collapse items={[{ key: 'evidence', label: `Evidence sent to the LLM (${community.documents.length} documents)`, children: evidence }]} />
          </div> },
          { key: 'entities', label: `Named entities${analysis?.entities ? ` (${analysis.entities.length})` : ''}`, children: <>
            <Typography.Paragraph type="secondary">Named entities extracted from the analyzed evidence. Search an entity to investigate its mentions within the saved community.</Typography.Paragraph>
            {!analysis?.entities && <Alert type="info" message="Named entities were not extracted in this historical report. Run a new analysis to include them." />}
            <Select aria-label="Entity type" placeholder="All entity types" allowClear value={entityType} onChange={setEntityType} style={{ width: 190, marginBottom: 16 }} options={['PERSON', 'ORG', 'LOCATION', 'EVENT', 'PRODUCT', 'OTHER'].map(value => ({ value, label: value }))} />
            <Table rowKey={(e) => `${e.name}:${e.label}`} dataSource={(analysis?.entities ?? []).filter(e => !entityType || e.label === entityType)} pagination={{ pageSize: 15, hideOnSinglePage: true }} columns={[{ title: 'Entity', dataIndex: 'name', render: (name: string) => <Button type="link" onClick={() => searchEntity(name)}>{name}</Button> }, { title: 'Type', dataIndex: 'label', render: (label: string) => <Tag>{label}</Tag> }, { title: 'Supporting evidence', dataIndex: 'evidence_ids', render: (ids: string[]) => <Space wrap>{ids.map(docId => <Button key={docId} size="small" onClick={() => drawer.open(docId)}>{community.documents.find(d => d.id === docId)?.external_id ?? docId.slice(0, 8)}</Button>)}</Space> }]} />
          </> },
          { key: 'graph', label: 'Graph snapshot', children: graph?.nodes.length ? <>
            <Typography.Paragraph type="secondary">The saved evidence graph: {graph.nodes.length} central documents, {graph.links.length} links. Snapshot rendering is limited to 80 nodes; document search covers the full saved community.</Typography.Paragraph>
            <Space wrap style={{ marginBottom: 12 }}><Select aria-label="Topic graph arrangement" value={layout} onChange={setLayout} options={[{ value: 'communities', label: 'Auto-arrange' }, { value: 'force', label: 'Force layout' }, { value: 'circle', label: 'Circular' }, { value: 'grid', label: 'Grid' }]} style={{ width: 160 }} /><Button icon={<ExpandOutlined />} onClick={() => graphRef.current?.fit()}>Fit to view</Button><Button icon={<DownloadOutlined />} onClick={() => graphRef.current?.exportPng()}>Export PNG</Button></Space>
            <Typography.Paragraph type="secondary">Click a node to select it, click again or press Escape to unselect. Right-click for document details and investigation actions.</Typography.Paragraph>
            <Input.Search aria-label="Search snapshot node text" placeholder="Search node text or document ID…" value={snapshotQuery} onChange={e => setSnapshotQuery(e.target.value)} allowClear style={{ marginBottom: 8 }} />
            <Space wrap style={{ marginBottom: 12, width: '100%' }}><Select aria-label="Find a topic graph document" placeholder="Select a matching document" allowClear showSearch optionFilterProp="searchText" style={{ width: 300, maxWidth: '100%' }} options={snapshotMatches.map(n => ({ value: n.id, label: `${n.external_id ?? n.id} · ${(n.text ?? '').slice(0, 90)}`, searchText: `${n.external_id ?? ''} ${n.id} ${n.text ?? ''}` }))} value={selected} onChange={(value: string | undefined) => { if (value) graphRef.current?.focusNode(value); else setSelected(null) }} /><Typography.Text type="secondary">{snapshotMatches.length} matching nodes</Typography.Text><Button disabled={!selected} onClick={() => setSelected(null)}>Clear selection</Button><Dropdown menu={nodeMenu} trigger={['click']}><Button disabled={!selected}>Node actions</Button></Dropdown></Space>
            <div className="topic-snapshot"><GraphCanvas ref={graphRef} data={graph} hidden={new Set()} selectedId={selected} paused={reduced} reducedMotion={reduced} highlight={snapshotQuery ? new Set(snapshotMatches.map(n => n.id)) : null} hideUnmatched={false} seeds={new Set()} arrangement={layout} palette={CANVAS_PALETTES[mode]} onSelect={n => setSelected(n?.id ?? null)} onContextMenu={(n, point) => { setSelected(n?.id ?? null); setContextPoint(point) }} onOpen={drawer.open} /></div><GraphContextMenu point={contextPoint} menu={nodeMenu} onClose={closeContextMenu} />
            {selectedNode && <Card size="small" className="topic-node-details" title={`Selected node: ${selectedNode.external_id ?? selectedNode.id}`} style={{ marginTop: 12 }}><Typography.Paragraph ellipsis={{ rows: 5, expandable: true }}>{selectedNode.text}</Typography.Paragraph><Space wrap><Button onClick={() => drawer.open(selectedNode.id)}>Show node details</Button><Link to={links.graph({ focus: selectedNode.id })}>Explore live connections</Link><Button type="text" onClick={() => setSelected(null)}>Unselect node</Button></Space></Card>}

          </> : <Empty description="This historical report has no saved graph. Open the live graph from a supporting document." /> },
          { key: 'documents', label: 'Search topic documents', children: <>
            <Typography.Paragraph type="secondary">Search current content within the membership saved for this topic. Reclustering does not change this scope.</Typography.Paragraph>
            <Input.Search aria-label="Search within this topic" placeholder="Search this topic’s documents…" allowClear value={query} onChange={(e) => { setQuery(e.target.value); setPage(1) }} style={{ marginBottom: 16 }} />
            {docs.error && <Alert type="error" message="Documents could not be loaded" description={docs.error.message} />}
            {docs.data && !docs.data.membership_available && <Alert type="info" message="This older report preserved only selected evidence; search is limited to those documents." />}
            <Typography.Text type="secondary">{fmtInt(docs.data?.total)} matching documents{(docs.data?.total ?? 0) > 1020 ? ' · showing the first 1,020; narrow the search to find more' : ''}</Typography.Text>
            <List loading={docs.isLoading} dataSource={docs.data?.documents ?? []} renderItem={(doc) => <List.Item><div><Button type="link" onClick={() => drawer.open(doc.id)}>{doc.external_id}</Button><Typography.Paragraph ellipsis={{ rows: 3 }}>{doc.text}</Typography.Paragraph><Link to={links.graph({ focus: doc.id })}>See connections in graph</Link></div></List.Item>} />
            <Pagination current={page} pageSize={20} total={Math.min(docs.data?.total ?? 0, 1020)} showSizeChanger={false} onChange={setPage} hideOnSinglePage />
          </> },
          { key: 'llm', label: 'LLM activity', children: <>
            <Descriptions bordered column={1} items={[{ key: 'model', label: 'Provider / model', children: `${run.provider} / ${run.model}` }, { key: 'trigger', label: 'Triggered by', children: run.trigger }, { key: 'selected', label: 'Document selection', children: `${community.documents.length} of ${community.document_count}, ordered by centrality; maximum fitting the context window${run.top_k ? `, legacy cap ${run.top_k}` : ''}` }, { key: 'tokens', label: 'Input tokens / budget', children: budget ? `${fmtInt(budget.input_tokens)} / ${fmtInt(budget.input_budget)}` : 'Not recorded in this historical report' }, { key: 'reserve', label: 'Response reserve / safety margin', children: budget ? `${fmtInt(budget.output_reserve)} / ${fmtInt(budget.safety_margin)} tokens` : 'Not recorded' }, { key: 'created', label: 'Report created', children: new Date(run.created_at).toLocaleString() }]} />
            <Typography.Title level={4}>Instructions sent to the LLM</Typography.Title><pre className="topic-prompt">{run.instructions ?? 'Not recorded in this historical report.'}</pre>
            <Typography.Paragraph type="secondary">The evidence section preserves the exact text and IDs sent, including marked excerpts. Source documents may have changed since analysis.</Typography.Paragraph>
            <Space style={{ marginBottom: 16 }}><Button icon={<DownloadOutlined />} onClick={() => downloadText(`topic-${run.id}-C${community.community_id}.json`, JSON.stringify(topic.data, null, 2), 'application/json')}>Download full evidence JSON</Button></Space>
            <Collapse items={[{ key: 'json', label: 'Structured analysis returned by the LLM', children: <pre className="topic-prompt">{JSON.stringify(analysis, null, 2)}</pre> }]} />
          </> },
        ]} />
      </Card>
      <aside className="topic-dossier-aside">
        <Card className="nu-card" size="small" title="Evidence coverage"><div className="topic-coverage"><strong>{coverage}%</strong><span>{fmtInt(community.documents.length)} of {fmtInt(community.document_count)} documents analyzed</span></div><Progress aria-label="Documents analyzed as a percentage of topic membership" percent={coverage} showInfo={false} /><Typography.Text type="secondary">Selected automatically to fit the model’s context.</Typography.Text>{budget && <div className="topic-small-fact">{fmtInt(budget.input_tokens)} input tokens<br />{fmtInt(budget.output_reserve)} reserved for the response</div>}</Card>
        <Card className="nu-card" size="small" title="Sentiment of the reporting"><Tag color={sentimentColor(analysis?.sentiment)}>{analysis?.sentiment ?? 'unclear'}</Tag><Typography.Paragraph style={{ marginTop: 12, marginBottom: 0 }}>{analysis?.sentiment_reasoning || 'Not recorded in this historical report.'}</Typography.Paragraph></Card>
        <Card className="nu-card" size="small" title="Trend signal"><Tag color={trend?.direction === 'rising' ? 'green' : trend?.direction === 'falling' ? 'orange' : 'default'}>{trend?.direction ?? 'unavailable'}</Tag><Typography.Paragraph style={{ marginTop: 12 }}>{trend?.reason ?? 'No comparable earlier period has been recorded.'}</Typography.Paragraph>{trend?.share_change_percent !== undefined && <Typography.Text strong>{trend.share_change_percent > 0 ? '+' : ''}{trend.share_change_percent}% share change</Typography.Text>}{trend?.baseline_topic_id && <div><Link to={`/topics/${encodeURIComponent(trend.baseline_topic_id)}`}>Compare with earlier period</Link></div>}</Card>
        <Card className="nu-card" size="small" title="Classifications"><Space wrap>{analysis?.classifications?.length ? analysis.classifications.map(label => <Link key={label} to={`/topics?class=${encodeURIComponent(label)}`}><Tag>{label}</Tag></Link>) : <Typography.Text type="secondary">Not recorded</Typography.Text>}</Space></Card>
        <Card className="nu-card" size="small" title="Sources in the evidence">{[...sources].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([source,count]) => <div key={source} className="topic-source-row"><span>{source}</span><strong>{fmtInt(count)}</strong></div>)}<Button block icon={<ApartmentOutlined />} style={{ marginTop: 14 }} disabled={!community.documents.length} onClick={() => navigate(links.graph({ focus: community.documents[0].id }))}>Explore live connections</Button></Card>
      </aside>
    </div>
  </div>
}
