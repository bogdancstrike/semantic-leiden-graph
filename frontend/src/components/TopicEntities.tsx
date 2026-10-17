import { useState } from 'react'
import { Alert, Button, Empty, Input, InputNumber, List, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DownloadOutlined, SearchOutlined } from '@ant-design/icons'
import type { EntityInsight, EntityStatistics, NamedEntity } from '@/api/types'
import { downloadText } from '@/lib/download'
import { fmtInt } from '@/lib/format'

const date = (value?: string | null) => value ? new Date(value).toLocaleString() : 'Not recorded'

export function TopicEntities({ entities, statistics, onSearch, onOpen }: { entities?: NamedEntity[]; statistics?: EntityStatistics; onSearch: (name: string) => void; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const [type, setType] = useState<string>()
  const [minimum, setMinimum] = useState(0)
  const allRows: EntityInsight[] = statistics?.entities ?? entities ?? []
  const rows = allRows.filter(e => (!type || e.label === type) && e.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()) && (e.mention_count ?? 0) >= minimum)
  const csv = () => {
    const cell = (value: unknown) => { const text = String(value ?? ''); return `"${(/^[=+@\-\t\r]/.test(text) ? "'" : '') + text.replaceAll('"', '""')}"` }
    const values = rows.map(e => [e.name, e.label, e.mention_count, e.document_count, e.document_share_percent, e.sources?.length, e.first_updated_at, e.last_updated_at])
    downloadText('topic-entities.csv', [['Entity', 'Type', 'Mentions in analyzed evidence', 'Documents', 'Evidence coverage %', 'Source labels', 'First document updated UTC', 'Last document updated UTC'], ...values].map(row => row.map(cell).join(',')).join('\r\n'), 'text/csv')
  }
  return <div className="topic-entity-insights">
    <Typography.Paragraph type="secondary">Investigate the people, organizations and places behind this topic. Counts use case-insensitive, whole-name matches in the exact saved evidence; aliases are not merged. Dates describe content updates, not publication dates.</Typography.Paragraph>
    {!entities && <Alert type="info" message="Named entities were not extracted in this historical report. Run a new analysis to include them." />}
    {statistics && <div className="entity-metrics">{[['Named entities', statistics.entities.length], ['Total appearances', statistics.mentions], ['Documents with entities', statistics.documents_with_entities], ['Documents counted', statistics.documents]].map(([label, value]) => <div key={String(label)}><Typography.Text type="secondary">{label}</Typography.Text><strong>{fmtInt(value as number)}</strong></div>)}</div>}
    {!!statistics?.truncated_documents && <Alert type="info" style={{ marginBottom: 16 }} message={`${statistics.truncated_documents} analyzed documents contain excerpts. Counts cover the saved excerpts, not omitted text or unselected community documents.`} />}
    <Space wrap style={{ marginBottom: 16 }}>
      <Input aria-label="Find named entity" placeholder="Find an entity…" prefix={<SearchOutlined />} value={query} onChange={e => setQuery(e.target.value)} allowClear style={{ width: 210 }} />
      <Select aria-label="Entity type" placeholder="All entity types" allowClear value={type} onChange={setType} style={{ width: 170 }} options={['PERSON', 'ORG', 'LOCATION', 'EVENT', 'PRODUCT', 'OTHER'].map(value => ({ value, label: value }))} />
      <label>Minimum appearances <InputNumber aria-label="Minimum entity appearances" min={0} value={minimum} onChange={value => setMinimum(value ?? 0)} style={{ width: 75, marginLeft: 8 }} /></label>
      <Button icon={<DownloadOutlined />} onClick={csv} disabled={!rows.length}>Export entities CSV</Button>
    </Space>
    <Typography.Paragraph type="secondary">Expand a row for source distribution, dated activity, passages and entities mentioned in the same documents. Click a name to search the full saved topic membership.</Typography.Paragraph>
    <Table<EntityInsight> rowKey={e => `${e.name}:${e.label}`} dataSource={rows} scroll={{ x: 760 }} pagination={{ pageSize: 15, hideOnSinglePage: true }} columns={[
      { title: 'Entity', dataIndex: 'name', width: 190, render: (name: string) => <Button type="link" onClick={() => onSearch(name)} style={{ whiteSpace: 'normal', height: 'auto', textAlign: 'left' }}>{name}</Button>, sorter: (a,b) => a.name.localeCompare(b.name) },
      { title: 'Type', dataIndex: 'label', width: 105, render: (label: string) => <Tag>{label}</Tag>, filters: Object.keys(statistics?.types ?? {}).map(value => ({ text: value, value })), onFilter: (value, row) => row.label === value },
      { title: <Tooltip title="Exact whole-name occurrences in saved analyzed evidence">Appearances</Tooltip>, dataIndex: 'mention_count', width: 120, render: (value?: number) => value === undefined ? '—' : fmtInt(value), sorter: (a,b) => (a.mention_count ?? 0) - (b.mention_count ?? 0), defaultSortOrder: 'descend' },
      { title: 'Documents', dataIndex: 'document_count', width: 120, render: (value: number | undefined, row) => <span>{value === undefined ? '—' : fmtInt(value)}{row.document_share_percent !== undefined && <><br /><Typography.Text type="secondary">{row.document_share_percent}% of evidence</Typography.Text></>}</span>, sorter: (a,b) => (a.document_count ?? 0) - (b.document_count ?? 0) },
      { title: <Tooltip title="Distinct source labels among matching analyzed documents">Sources</Tooltip>, width: 90, render: (_,row) => row.sources ? row.sources.length : '—', sorter: (a,b) => (a.sources?.length ?? 0) - (b.sources?.length ?? 0) },
      { title: 'Latest document update', dataIndex: 'last_updated_at', width: 170, render: date, sorter: (a,b) => (a.last_updated_at ?? '').localeCompare(b.last_updated_at ?? '') },
    ]} expandable={{ expandedRowRender: entity => <div className="entity-expanded">
      <Space wrap><Button onClick={() => onSearch(entity.name)} icon={<SearchOutlined />}>Search topic for {entity.name}</Button><Typography.Text type="secondary">First update: {date(entity.first_updated_at)} · Latest update: {date(entity.last_updated_at)}</Typography.Text></Space>
      {entity.mention_count === 0 && <Alert type="info" style={{ marginTop: 12 }} message="This exact name was not found in the saved text. Review the LLM citations for aliases or an unsupported extraction." />}
      <Typography.Title level={5}>Appears alongside</Typography.Title>
      {entity.co_occurrences?.length ? <Space wrap>{entity.co_occurrences.map(other => <Tooltip key={`${other.name}:${other.label}`} title={`Same documents; this does not establish a real-world relationship`}><Button size="small" onClick={() => onSearch(other.name)}>{other.name} · {other.document_count} documents</Button></Tooltip>)}</Space> : <Typography.Text type="secondary">No other extracted entity shares a document.</Typography.Text>}
      <Typography.Title level={5}>Source distribution</Typography.Title>
      <Table size="small" rowKey={row => row.source ?? '__none__'} dataSource={entity.sources ?? []} pagination={false} columns={[{ title: 'Source label', dataIndex: 'source', render: value => value ?? 'No source label' }, { title: 'Documents', dataIndex: 'documents' }, { title: 'Appearances', dataIndex: 'mentions' }]} />
      <Typography.Title level={5}>Activity by document update date (UTC)</Typography.Title>
      <Table size="small" rowKey="date" dataSource={entity.timeline ?? []} pagination={{ pageSize: 7, hideOnSinglePage: true }} columns={[{ title: 'Date', dataIndex: 'date' }, { title: 'Documents', dataIndex: 'documents' }, { title: 'Appearances', dataIndex: 'mentions' }]} />
      <Typography.Title level={5}>Example passages</Typography.Title>
      <List dataSource={entity.examples ?? []} locale={{ emptyText: <Empty description="No exact-name passage available" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }} renderItem={example => <List.Item><div><Button type="link" onClick={() => onOpen(example.id)}>{example.external_id}</Button><Typography.Paragraph>{example.text}</Typography.Paragraph><Typography.Text type="secondary">{example.source ?? 'No source label'} · {date(example.updated_at)}</Typography.Text></div></List.Item>} />
      <Typography.Title level={5}>LLM supporting citations</Typography.Title><Space wrap>{entity.evidence_ids.map(id => <Button size="small" key={id} onClick={() => onOpen(id)}>{id.slice(0, 8)}</Button>)}</Space>
    </div> }} />
  </div>
}
