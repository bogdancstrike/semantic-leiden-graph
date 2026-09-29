/**
 * `/import` — loading a CSV, as a wizard: file, columns, import, done.
 *
 * Everything the v0.3 page did is kept — preview, validation, options, the
 * XHR upload bar, the "Processing" card with its phase stepper — and laid out
 * after the Nucleus import page. Two things are new:
 *
 * **Any delimited file, and the reader picks the column to analyse.** The
 * separator, encoding and header row are detected and can be changed; the
 * header is shown with sample values; one column is analysed (embedded, linked,
 * clustered), an optional one is the id (else ids come from the text), and the
 * others the reader ticks are kept as filterable metadata.
 *
 * **Progress survives navigation.** The upload and the job live in
 * `importSession` (a module-level store) and the half-mapped file in the draft
 * store below, so leaving the page and coming back shows the same bar. After a
 * full reload the page re-attaches to the running import job from `/jobs`, and
 * `?job=<id>` shows any import from the history.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  InputNumber,
  List,
  Progress,
  Result,
  Select,
  Space,
  Steps,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd'
import { DownloadOutlined, InboxOutlined, ReloadOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { invalidateCorpus, useActiveJob, useConfig, useJobs } from '@/api/hooks'
import type { ImportResult, Job } from '@/api/types'
import { PAGE_DOCS } from '@/app/pageDocs'
import { EmptyState } from '@/components/EmptyState'
import { ListMeta } from '@/components/ListMeta'
import { JobProgress } from '@/components/JobProgress'
import { PageDoc } from '@/components/PageDoc'
import { PageHeader } from '@/components/PageHeader'
import { useUrlState } from '@/hooks/useUrlState'
import {
  DELIMITER_OPTIONS,
  ENCODING_OPTIONS,
  PREVIEW_ROWS,
  carryMapping,
  checkMapping,
  defaultMapping,
  delimiterName,
  downloadTemplate,
  encodingName,
  previewCsv,
  suggestColumns,
  uploadFields,
  type ColumnMapping,
  type CsvPreview,
} from '@/lib/csv'
import { fmtBytes, fmtInt, fmtMs, fmtRelative, fmtScore } from '@/lib/format'
import { importSession, useImportSession } from '@/lib/importSession'
import { statusColor } from '@/theme/tokens'

const { Text, Paragraph } = Typography

// ---------------------------------------------------------------------------- draft store

/** The file being prepared, before anything is uploaded. Outlives the page like the session. */
interface Draft {
  file: File | null
  /** The bytes previewed, kept so a new separator or encoding re-parses without re-reading. */
  head: Uint8Array | null
  preview: CsvPreview | null
  /** null: detected. */
  delimiterChoice: string | null
  encodingChoice: string | null
  hasHeader: boolean
  mapping: ColumnMapping
  source: string
  runCluster: boolean
  rebuild: boolean
  truncateLongTexts: boolean
  /** Clustering after the import: smaller Leiden groups are left in no community. */
  minCommunitySize: number | null
  error: string | null
}

/** The import's own default: communities of fewer documents rarely tell a reader anything. */
const DEFAULT_IMPORT_MIN_COMMUNITY = 10

const EMPTY_DRAFT: Draft = {
  file: null,
  head: null,
  preview: null,
  delimiterChoice: null,
  encodingChoice: null,
  hasHeader: true,
  mapping: { textColumn: null, idColumn: null, metadataColumns: [] },
  source: '',
  runCluster: true,
  rebuild: false,
  truncateLongTexts: false,
  minCommunitySize: DEFAULT_IMPORT_MIN_COMMUNITY,
  error: null,
}

let draftState: Draft = EMPTY_DRAFT
const draftListeners = new Set<() => void>()
/** Jobs the reader put aside with "Import another file"; not re-attached automatically. */
const dismissedJobs = new Set<string>()

function setDraft(patch: Partial<Draft>) {
  draftState = { ...draftState, ...patch }
  draftListeners.forEach((listener) => listener())
}

function useDraft(): Draft {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener)
      return () => draftListeners.delete(listener)
    },
    () => draftState,
    () => draftState,
  )
}

// ---------------------------------------------------------------------------- helpers

/** The server's metadata limit until `/config` answers. */
const DEFAULT_METADATA_MAX = 20

function useMetadataMax(): number {
  return useConfig().data?.limits.metadata_max_keys ?? DEFAULT_METADATA_MAX
}

/** Re-read the draft's file with another separator, encoding or header setting. */
async function reparse(patch: Partial<Pick<Draft, 'delimiterChoice' | 'encodingChoice' | 'hasHeader'>>, metadataMax: number) {
  const draft = { ...draftState, ...patch }
  if (!draft.file || !draft.head) return
  try {
    const preview = await previewCsv(
      draft.file,
      { delimiter: draft.delimiterChoice, encoding: draft.encodingChoice, hasHeader: draft.hasHeader },
      draft.head,
    )
    setDraft({ ...patch, preview, mapping: carryMapping(draft.mapping, preview.columns, preview.stats, metadataMax), error: null })
  } catch (e) {
    setDraft({ ...patch, error: (e as Error).message })
  }
}

function jobOutcome(job: Job): string {
  const r = (job.result ?? {}) as Partial<ImportResult>
  if (job.status === 'succeeded') return `${fmtInt(r.created ?? 0)} created, ${fmtInt(r.updated ?? 0)} updated, ${fmtInt(r.failed ?? 0)} failed`
  if (job.status === 'failed') return job.error ?? 'Failed'
  if (job.status === 'cancelled') return 'Cancelled'
  if (job.status === 'queued') return 'Waiting for the previous job'
  return job.total ? `${job.phase} ${fmtInt(job.processed)} / ${fmtInt(job.total)}` : job.phase
}

// ---------------------------------------------------------------------------- summary

function ImportSummary({ job }: { job: Job }) {
  const navigate = useNavigate()
  const result = job.result as unknown as ImportResult | undefined
  if (job.status !== 'succeeded' || !result) return null
  const cluster = result.clustering
  return (
    <Card size="small" className="nu-card" title="Result">
      <Result
        status={result.failed ? 'warning' : 'success'}
        title={`Imported ${fmtInt(result.created + result.updated)} documents`}
        subTitle={
          result.failed
            ? `${fmtInt(result.failed)} row(s) were skipped. The rest are searchable now.`
            : 'All rows were indexed in Elasticsearch, embedded into Qdrant and linked in Neo4j.'
        }
        extra={[
          <Button key="explore" type="primary" onClick={() => navigate('/documents')}>
            Explore the documents
          </Button>,
          <Button key="graph" onClick={() => navigate('/graph')}>
            Open the graph
          </Button>,
        ]}
      />
      <Descriptions
        size="small"
        bordered
        column={{ xs: 1, sm: 2, lg: 3 }}
        items={[
          ...(result.format
            ? [
                { key: 'analysed', label: 'Analysed column', children: <Text strong>{result.format.text_column}</Text> },
                { key: 'ids', label: 'Ids', children: result.format.id_column ?? 'generated from the text' },
                {
                  key: 'read',
                  label: 'Read as',
                  children: `${encodingName(result.format.encoding)} · ${delimiterName(result.format.delimiter)}${result.format.has_header ? '' : ' · no header row'}`,
                },
              ]
            : []),
          { key: 'rows', label: 'Rows read', children: fmtInt(result.rows) },
          { key: 'created', label: 'Created', children: fmtInt(result.created) },
          { key: 'updated', label: 'Updated', children: fmtInt(result.updated) },
          { key: 'unchanged', label: 'Unchanged (skipped)', children: fmtInt(result.unchanged) },
          { key: 'failed', label: 'Failed', children: fmtInt(result.failed) },
          ...(result.truncated ? [{ key: 'truncated', label: 'Truncated texts', children: fmtInt(result.truncated) }] : []),
          { key: 'edges', label: 'Edges written', children: fmtInt(result.edges_upserted) },
          ...(cluster
            ? [
                { key: 'communities', label: 'Communities', children: fmtInt(cluster.community_count) },
                ...(cluster.min_community_size
                  ? [{ key: 'minsize', label: 'Minimum community size', children: `${fmtInt(cluster.min_community_size)} documents` }]
                  : []),
                { key: 'modularity', label: 'Modularity', children: fmtScore(cluster.modularity) },
              ]
            : []),
          { key: 'time', label: 'Total time', children: fmtMs(result.total_ms) },
        ]}
      />
      {result.errors.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <Text strong>Skipped rows ({fmtInt(result.failed)})</Text>
          {result.failed > result.errors.length && (
            <Text type="secondary" style={{ marginLeft: 8 }}>
              showing the first {fmtInt(result.errors.length)}; every skipped row is counted
            </Text>
          )}
          <Table
            style={{ marginTop: 8 }}
            rowKey="key"
            dataSource={result.errors.map((e, i) => ({ ...e, key: `${e.row ?? 'x'}-${i}` }))}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            columns={[
              { title: 'Row', dataIndex: 'row', width: 80 },
              { title: 'id', dataIndex: 'external_id', width: 180, render: (v) => <span className="mono">{v ?? '—'}</span> },
              { title: 'Reason', dataIndex: 'reason' },
            ]}
          />
        </div>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------- mapping

function FileCard({ draft }: { draft: Draft }) {
  const metadataMax = useMetadataMax()
  const file = draft.file!
  const preview = draft.preview!
  const standard = (d: string | null) => d === null || DELIMITER_OPTIONS.some((o) => o.value === d)
  const [otherMode, setOtherMode] = useState(!standard(draft.delimiterChoice))
  const [otherDelimiter, setOtherDelimiter] = useState(standard(draft.delimiterChoice) ? '' : (draft.delimiterChoice ?? ''))
  const delimiterValue = otherMode ? 'other' : (draft.delimiterChoice ?? 'auto')
  return (
    <Card size="small" className="nu-card" title="File">
      <Descriptions
        size="small"
        column={{ xs: 1, sm: 2, lg: 4 }}
        items={[
          { key: 'name', label: 'File', children: <Text className="mono">{file.name}</Text> },
          { key: 'size', label: 'Size', children: fmtBytes(file.size) },
          { key: 'columns', label: 'Columns', children: fmtInt(preview.columns.length) },
          {
            key: 'rows',
            label: preview.wholeFile ? 'Rows' : 'Rows (estimate)',
            children: `${preview.wholeFile ? '' : '≈ '}${fmtInt(preview.estimatedRows)}`,
          },
        ]}
      />
      {/* How to read it: detected, shown, and changeable — the preview below follows at once. */}
      <div className="nu-imp-format">
        <label className="nu-imp-field">
          <Text type="secondary">Separator</Text>
          <Select
            aria-label="Separator"
            value={delimiterValue}
            onChange={(value: string) => {
              setOtherMode(value === 'other')
              if (value === 'other') {
                if (otherDelimiter) void reparse({ delimiterChoice: otherDelimiter }, metadataMax)
                return
              }
              void reparse({ delimiterChoice: value === 'auto' ? null : value }, metadataMax)
            }}
            options={[
              { value: 'auto', label: `Detect — ${delimiterName(preview.detected.delimiter)}` },
              ...DELIMITER_OPTIONS,
              { value: 'other', label: 'Other character…' },
            ]}
          />
        </label>
        {delimiterValue === 'other' && (
          <label className="nu-imp-field nu-imp-field--narrow">
            <Text type="secondary">Character</Text>
            <Input
              aria-label="Separator character"
              maxLength={1}
              value={otherDelimiter}
              placeholder=":"
              onChange={(e) => {
                setOtherDelimiter(e.target.value)
                if (e.target.value && e.target.value !== '"') void reparse({ delimiterChoice: e.target.value }, metadataMax)
              }}
            />
          </label>
        )}
        <label className="nu-imp-field">
          <Text type="secondary">Encoding</Text>
          <Select
            aria-label="Encoding"
            value={draft.encodingChoice ?? 'auto'}
            onChange={(value: string) => void reparse({ encodingChoice: value === 'auto' ? null : value }, metadataMax)}
            options={[{ value: 'auto', label: `Detect — ${encodingName(preview.detected.encoding)}` }, ...ENCODING_OPTIONS]}
          />
        </label>
        <label className="nu-imp-switch">
          <Switch checked={draft.hasHeader} onChange={(hasHeader) => void reparse({ hasHeader }, metadataMax)} aria-label="First row is the header" />
          <Text>First row is the header</Text>
        </label>
      </div>
      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
        {preview.detected.sepLine && <Alert type="info" showIcon message="The first line “sep=…” is Excel's separator hint; it is used and skipped." />}
        {preview.columns.length <= 1 && (
          <Alert
            type="warning"
            showIcon
            message="The file reads as a single column"
            description="If it has several, choose its separator above. A single column works too: it is the text to analyse."
          />
        )}
        {preview.undecodable > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`${fmtInt(preview.undecodable)} character(s) could not be read as ${encodingName(preview.format.encoding)}`}
            description="Accented letters shown as � mean another encoding: try Windows-1252, or Windows-1250 for Romanian and Central European files."
          />
        )}
        {preview.wideRows > 0 && (
          <Alert
            type="info"
            showIcon
            message={`${fmtInt(preview.wideRows)} sampled row(s) have more cells than there are columns`}
            description="Usually a separator inside an unquoted value, or a different separator. Such rows are skipped and listed after the import."
          />
        )}
      </Space>
    </Card>
  )
}

function roleOf(column: string, mapping: ColumnMapping): 'text' | 'id' | 'metadata' | 'ignore' {
  if (column === mapping.textColumn) return 'text'
  if (column === mapping.idColumn) return 'id'
  return mapping.metadataColumns.includes(column) ? 'metadata' : 'ignore'
}

const ROLE_TAG = {
  text: <Tag color="processing" bordered={false}>analysed</Tag>,
  id: <Tag bordered={false}>id</Tag>,
  metadata: <Tag color="success" bordered={false}>kept</Tag>,
  ignore: <Tag bordered={false}>not imported</Tag>,
}

function ColumnsCard({ draft }: { draft: Draft }) {
  const metadataMax = useMetadataMax()
  const { message } = App.useApp()
  const preview = draft.preview!
  const { mapping } = draft
  const check = checkMapping(mapping, preview, metadataMax)
  const suggested = suggestColumns(preview.columns, preview.stats)
  const others = preview.columns.filter((c) => c !== mapping.textColumn && c !== mapping.idColumn)

  const setMapping = (patch: Partial<ColumnMapping>) => {
    const next = { ...mapping, ...patch }
    // A column is one thing: analysed, id or metadata.
    next.metadataColumns = next.metadataColumns.filter((c) => c !== next.textColumn && c !== next.idColumn)
    if (next.idColumn === next.textColumn) next.idColumn = null
    setDraft({ mapping: next })
  }
  const chooseText = (column: string) => {
    // The column that stops being analysed becomes metadata again, if there is room.
    const freed = mapping.textColumn && mapping.textColumn !== column ? [mapping.textColumn] : []
    const metadataColumns = [...mapping.metadataColumns, ...freed].slice(0, metadataMax)
    setMapping({ textColumn: column, metadataColumns })
  }

  /** Keep a column as metadata, or leave it out — from a click anywhere in its preview column. */
  const toggleKept = (column: string) => {
    if (column === mapping.textColumn || column === mapping.idColumn) return
    if (mapping.metadataColumns.includes(column)) {
      setMapping({ metadataColumns: mapping.metadataColumns.filter((c) => c !== column) })
    } else if (mapping.metadataColumns.length >= metadataMax) {
      void message.warning(`At most ${metadataMax} columns can be kept; leave another one out first.`)
    } else {
      // Kept columns stay in file order, like the preview.
      const kept = new Set([...mapping.metadataColumns, column])
      setMapping({ metadataColumns: preview.columns.filter((c) => kept.has(c)) })
    }
  }

  const describe = (column: string) => {
    const s = preview.stats[column]
    const sample = preview.samples[column]?.[0]
    return (
      <span className="nu-imp-option">
        <span className="nu-imp-option-name">{column}</span>
        {column === suggested.text && <Tag bordered={false} color="processing">suggested</Tag>}
        <span className="nu-imp-option-meta">
          {s?.filled ? `≈ ${fmtInt(Math.round(s.avgLength))} characters` : 'empty in the sample'}
          {sample ? ` · ${sample.slice(0, 60)}` : ''}
        </span>
      </span>
    )
  }

  const tableRows = preview.rows.slice(0, PREVIEW_ROWS).map((row, index) => ({ ...row, __key: String(index) }))
  return (
    <Card size="small" className="nu-card" title="Columns">
      <div className="nu-imp-mapping">
        <label className="nu-imp-field nu-imp-field--wide">
          <Text strong>Column to analyse</Text>
          <Select
            aria-label="Column to analyse"
            showSearch
            optionFilterProp="searchText"
            placeholder="Choose the column with the text"
            value={mapping.textColumn ?? undefined}
            onChange={chooseText}
            options={preview.columns.map((c) => ({ value: c, searchText: c, label: describe(c) }))}
            optionLabelProp="searchText"
            status={mapping.textColumn ? undefined : 'warning'}
          />
          <Text type="secondary" className="nu-imp-help">
            Its text is embedded, linked to similar documents and clustered. No other column is embedded.
          </Text>
        </label>
        <label className="nu-imp-field">
          <Text strong>Row id</Text>
          <Select
            aria-label="Row id"
            value={mapping.idColumn ?? '__generated'}
            onChange={(value: string) => setMapping({ idColumn: value === '__generated' ? null : value })}
            options={[
              { value: '__generated', label: 'Generated from the text' },
              ...preview.columns
                .filter((c) => c !== mapping.textColumn)
                .map((c) => ({ value: c, label: preview.stats[c]?.unique ? `${c} · unique in the sample` : c })),
            ]}
          />
          <Text type="secondary" className="nu-imp-help">
            Re-importing a row with the same id updates it. Generated ids come from the text, so identical texts are one document.
          </Text>
        </label>
      </div>

      {others.length > 0 && (
        <div className="nu-imp-keep">
          <Text>
            <Text strong>Columns to keep:</Text> click a column in the preview below to keep it as filterable metadata{' '}
            <span className="nu-imp-swatch nu-imp-swatch--kept" aria-hidden="true" /> or leave it out.
          </Text>
          <Space size={4} wrap>
            <Text type="secondary" aria-live="polite">
              {mapping.metadataColumns.length} of {Math.min(others.length, metadataMax)} kept
              {others.length > metadataMax ? ` (at most ${metadataMax})` : ''}
            </Text>
            <Button size="small" type="text" onClick={() => setMapping({ metadataColumns: others.slice(0, metadataMax) })}>
              Keep all
            </Button>
            <Button size="small" type="text" onClick={() => setMapping({ metadataColumns: [] })}>
              Keep none
            </Button>
          </Space>
        </div>
      )}

      <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
        {check.missing.length > 0 && <Alert type="warning" showIcon message="Before importing" description={check.missing.join(' ')} />}
        {check.problems.map((problem) => (
          <Alert key={problem} type="info" showIcon message={problem} />
        ))}
      </Space>

      {/* The header as the file has it, every column, with what each becomes. */}
      {/* The wrapper scrolls wide files: antd's own `scroll.x` adds a hidden measuring row
          that copies every header — checkboxes included — into an aria-hidden region. */}
      <div className="nu-imp-preview-scroll">
      <Table
        className="nu-imp-preview"
        size="small"
        pagination={false}
        rowKey="__key"
        dataSource={tableRows}
        columns={preview.columns.map((column) => {
          const role = roleOf(column, mapping)
          const toggleable = role === 'metadata' || role === 'ignore'
          const full = role === 'ignore' && mapping.metadataColumns.length >= metadataMax
          const className = [
            role === 'text' ? 'nu-imp-col-analysed' : role === 'metadata' ? 'nu-imp-col-kept' : role === 'ignore' ? 'nu-imp-col-ignored' : '',
            toggleable ? 'nu-imp-col-toggle' : '',
          ]
            .filter(Boolean)
            .join(' ')
          // The whole column is the target for a pointer; the checkbox in its header is the
          // keyboard and screen-reader control (a click on it must not toggle twice).
          const onColumnClick = (event: React.MouseEvent) => {
            if ((event.target as HTMLElement).closest('.ant-checkbox-wrapper')) return
            if (toggleable) toggleKept(column)
          }
          const hint = role === 'metadata' ? 'Kept — click to leave it out' : role === 'ignore' ? 'Not imported — click to keep it' : undefined
          return {
            key: column,
            dataIndex: column,
            className,
            onHeaderCell: () => ({ onClick: onColumnClick, title: hint }),
            onCell: () => ({ onClick: onColumnClick, title: hint }),
            title: (
              <span className="nu-imp-head">
                <span className="nu-imp-head-row">
                  {toggleable && (
                    <Checkbox
                      aria-label={`Keep column ${column}`}
                      checked={role === 'metadata'}
                      disabled={full}
                      onChange={() => toggleKept(column)}
                    />
                  )}
                  <span className="nu-imp-head-name" title={column}>
                    {column}
                  </span>
                </span>
                {ROLE_TAG[role]}
              </span>
            ),
            render: (value: string) =>
              role === 'text' && !(value ?? '').trim() ? (
                <Tag color="warning" bordered={false}>
                  empty — skipped
                </Tag>
              ) : (
                <span className={role === 'text' ? 'nu-imp-cell-text' : 'nu-imp-cell'} title={value}>
                  {value}
                </span>
              ),
          }
        })}
      />
      </div>
      <Text type="secondary" className="nu-imp-help">
        {preview.wholeFile ? `The first ${Math.min(PREVIEW_ROWS, preview.rows.length)} rows.` : `The first ${PREVIEW_ROWS} rows of the file.`}{' '}
        {preview.format.hasHeader ? 'Column names come from the header row.' : 'No header row: columns are numbered.'}
      </Text>
    </Card>
  )
}

/** Above this, say how long a file will take before somebody starts it. */
const LARGE_FILE_BYTES = 100 * 1024 * 1024

function OptionsCard({ draft, busy }: { draft: Draft; busy: boolean }) {
  const { data: config } = useConfig()
  const metadataMax = useMetadataMax()
  const preview = draft.preview!
  const file = draft.file!
  const textLimit = config?.limits.text_max_chars ?? 20_000
  const check = checkMapping(draft.mapping, preview, metadataMax)
  const blocked = check.missing.length > 0

  const start = () => {
    void importSession.start(file, {
      runCluster: draft.runCluster,
      rebuild: draft.rebuild,
      truncateLongTexts: draft.truncateLongTexts,
      minCommunitySize: draft.minCommunitySize ?? DEFAULT_IMPORT_MIN_COMMUNITY,
      source: draft.source.trim() || `csv:${file.name}`,
      ...uploadFields(draft.mapping, preview.format, draft.encodingChoice !== null),
    })
  }

  return (
    <Card size="small" className="nu-card" title="Import options">
      <Space direction="vertical" style={{ width: '100%' }} size="middle">
        <label style={{ display: 'grid', gap: 4 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Source label — filterable in Explore and deletable under Operations
          </Text>
          <Input value={draft.source} onChange={(e) => setDraft({ source: e.target.value })} maxLength={128} placeholder={`csv:${file.name}`} />
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Switch checked={draft.runCluster} onChange={(runCluster) => setDraft({ runCluster })} />
          Run Leiden clustering afterwards
        </label>
        <div className="nu-imp-mincomm">
          <label className="nu-imp-field nu-imp-field--narrow-wide">
            <Text type="secondary">Minimum community size</Text>
            <InputNumber
              aria-label="Minimum community size"
              min={2}
              max={100000}
              precision={0}
              value={draft.minCommunitySize}
              disabled={!draft.runCluster}
              onChange={(minCommunitySize) => setDraft({ minCommunitySize })}
              suffix="documents"
            />
          </label>
          <Text type="secondary" className="nu-imp-help">
            Leiden groups with fewer documents are left in no community. Later clustering runs (Operations, re-cluster after a delete)
            reuse this size unless given another.
          </Text>
        </div>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Switch checked={draft.rebuild} onChange={(rebuild) => setDraft({ rebuild })} />
          Rebuild every edge (slower; only after changing k or the threshold)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Switch checked={draft.truncateLongTexts} onChange={(truncateLongTexts) => setDraft({ truncateLongTexts })} />
          Import the first {fmtInt(textLimit)} characters of longer texts (otherwise those rows are skipped and listed)
        </label>
        {file.size > LARGE_FILE_BYTES && (
          <Alert
            type="info"
            showIcon
            message={`Large file: ${fmtBytes(file.size)}, roughly ${fmtInt(preview.estimatedRows)} rows`}
            description="Every new or changed row is embedded on the API's CPU, so a file this size can take hours. You can leave this page — the progress stays here and in the header — and cancel the job at any time; rows imported until then are kept."
          />
        )}
        <Space wrap>
          <Tooltip title={blocked ? check.missing.join(' ') : undefined}>
            <Button type="primary" disabled={blocked || busy} onClick={start}>
              {draft.mapping.textColumn ? `Import and analyse “${draft.mapping.textColumn}”` : 'Import'}
            </Button>
          </Tooltip>
          <Button onClick={() => setDraft({ ...EMPTY_DRAFT })}>Choose another file</Button>
        </Space>
      </Space>
    </Card>
  )
}

// ---------------------------------------------------------------------------- side column

function SingleDocument() {
  const [text, setText] = useState('')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const { message } = App.useApp()
  const client = useQueryClient()
  const submit = async () => {
    setBusy(true)
    try {
      const r = await api.ingest(text.trim(), id.trim() || undefined)
      message.success(
        r.created
          ? `Added with ${r.edges_upserted} similarity edges. Run clustering to assign a community.`
          : r.updated
            ? 'Document updated.'
            : 'Unchanged: identical text already stored.',
      )
      setText('')
      setId('')
      void invalidateCorpus(client)
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title="Add one document" size="small" className="nu-card">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Input.TextArea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste raw text"
          maxLength={20000}
          showCount
          aria-label="Document text"
          // The counter is drawn below the box; without room it sits on the next input.
          style={{ marginBottom: 18 }}
        />
        <Input value={id} onChange={(e) => setId(e.target.value)} placeholder="Optional id (reuse it to update the document)" aria-label="Document id" />
        <Button type="primary" disabled={!text.trim()} loading={busy} onClick={submit}>
          Add document
        </Button>
      </Space>
    </Card>
  )
}

function History({ jobs, selected, disabled, onOpen }: { jobs: Job[]; selected: string | null; disabled: boolean; onOpen: (id: string) => void }) {
  const imports = jobs.filter((job) => job.kind === 'import')
  return (
    <Card size="small" className="nu-card" title="Earlier imports">
      {imports.length === 0 ? (
        <EmptyState compact title="Nothing imported since the API started" hint="Job history is kept in the API process." />
      ) : (
        <List
          dataSource={imports}
          renderItem={(job) => (
            <List.Item
              style={{ background: job.id === selected ? 'var(--nu-accent-soft)' : undefined, paddingInline: 8 }}
              extra={<Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>{fmtRelative(job.created_at)}</Text>}
            >
              <ListMeta
                title={
                  <button
                    type="button"
                    className="nu-link-button"
                    disabled={disabled}
                    onClick={() => onOpen(job.id)}
                    aria-label={`Show import ${String(job.params.filename ?? job.id)}`}
                  >
                    {String(job.params.filename ?? 'Import')}
                  </button>
                }
                description={
                  <Space direction="vertical" size={0}>
                    <Space size={8} wrap>
                      <Badge color={statusColor(job.status)} text={job.status} />
                      {job.params.source ? <Text type="secondary" className="mono">{String(job.params.source)}</Text> : null}
                    </Space>
                    <Text type={job.status === 'failed' ? 'danger' : 'secondary'} style={{ fontSize: 12 }}>
                      {jobOutcome(job)}
                    </Text>
                  </Space>
                }
              />
            </List.Item>
          )}
        />
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------- page

export default function ImportPage() {
  const { data: config } = useConfig()
  const { data: jobs = [] } = useJobs()
  const activeJob = useActiveJob()
  const { message } = App.useApp()
  const session = useImportSession()
  const draft = useDraft()
  const [params, setUrl] = useUrlState()
  const jobParam = params.get('job')
  const metadataMax = useMetadataMax()
  // Unknown until /config answers: the server enforces its limit either way.
  const maxBytes = config?.limits.upload_max_bytes
  const busy = session.stage === 'uploading' || session.stage === 'processing'
  const activeImport = activeJob?.kind === 'import' ? activeJob : undefined

  // Keep the session, the address and the server's job list agreeing on which import is shown.
  const lastSessionJob = useRef(session.jobId)
  useEffect(() => {
    // A new upload became a job: put it in the address so a reload finds it.
    if (session.jobId && session.jobId !== lastSessionJob.current) {
      lastSessionJob.current = session.jobId
      if (jobParam !== session.jobId) setUrl({ job: session.jobId })
      return
    }
    lastSessionJob.current = session.jobId
    // The address names an import the session is not showing (history click, shared link).
    if (jobParam && jobParam !== session.jobId && session.stage !== 'uploading' && !dismissedJobs.has(jobParam)) {
      const job = jobs.find((candidate) => candidate.id === jobParam && candidate.kind === 'import')
      if (job) importSession.attach(job)
      return
    }
    // Nothing on screen but an import is running (reload, other tab): show it.
    if (!jobParam && session.stage === 'idle' && !draft.file && activeImport && !dismissedJobs.has(activeImport.id)) {
      importSession.attach(activeImport)
    }
  }, [session.jobId, session.stage, jobParam, jobs, activeImport, draft.file, setUrl])

  /** Show one import (history click, "Show progress"); an explicit choice undoes a dismissal. */
  const showJob = (id: string) => {
    dismissedJobs.delete(id)
    setUrl({ job: id })
  }

  const resetAll = () => {
    if (session.jobId) dismissedJobs.add(session.jobId)
    if (session.stage !== 'uploading') importSession.reset()
    setDraft({ ...EMPTY_DRAFT })
    setUrl({ job: null })
  }

  const accept = async (candidate: File) => {
    if (session.stage === 'finished') {
      if (session.jobId) dismissedJobs.add(session.jobId)
      importSession.reset()
      setUrl({ job: null })
    }
    importSession.clearError()
    if (maxBytes !== undefined && candidate.size > maxBytes) {
      setDraft({ ...EMPTY_DRAFT, error: `The file is ${fmtBytes(candidate.size)}; the limit is ${fmtBytes(maxBytes)}. Split it into several files.` })
      return
    }
    try {
      // Any name is fine: the content decides (workbooks and archives are named and refused).
      const { head, ...preview } = await previewCsv(candidate)
      setDraft({
        ...EMPTY_DRAFT,
        file: candidate,
        head,
        preview,
        mapping: defaultMapping(preview.columns, preview.stats, metadataMax),
        source: `csv:${candidate.name}`,
      })
    } catch (e) {
      setDraft({ ...EMPTY_DRAFT, error: (e as Error).message })
    }
  }

  const onJobDone = (job: Job) => {
    importSession.finish(job)
    // A finished job opened from the history is not news; one that just ended is.
    const fresh = job.finished_at && Date.now() - new Date(job.finished_at).getTime() < 15_000
    if (fresh && job.status === 'succeeded') message.success('Import finished')
  }

  const finishedJob = session.finishedJob
  const step = session.stage === 'finished' ? 3 : busy ? 2 : draft.file ? 1 : 0
  const stepStatus = session.stage === 'finished' && finishedJob?.status === 'failed' ? 'error' : step === 3 ? 'finish' : 'process'
  const showDraft = !busy && session.stage !== 'finished' && !!draft.file && !!draft.preview

  return (
    <div className="nu-page">
      <PageHeader
        title="Import"
        subtitle={`Load any CSV or delimited text file${maxBytes ? `, up to ${fmtBytes(maxBytes)}` : ''}, and choose the column to analyse. Rows are upserted by id, so re-importing changes nothing.`}
        actions={
          <>
            {/* The template download lives with the format help it illustrates. */}
            {(session.stage !== 'idle' || draft.file) && (
              <Button icon={<ReloadOutlined />} onClick={resetAll} disabled={session.stage === 'uploading'}>
                Import another file
              </Button>
            )}
          </>
        }
      />

      <Steps
        className="nu-imp-steps"
        size="small"
        current={step}
        status={stepStatus}
        items={[{ title: 'File' }, { title: 'Columns' }, { title: 'Import' }, { title: 'Done' }]}
      />

      <div className="nu-imp-layout">
        <div className="nu-imp-main">
          {session.error && (
            <Alert type="error" showIcon message={session.error} closable onClose={() => importSession.clearError()} />
          )}
          {draft.error && <Alert type="error" showIcon message={draft.error} closable onClose={() => setDraft({ error: null })} />}

          {!busy && session.stage === 'idle' && activeImport && !jobParam && (draft.file || dismissedJobs.has(activeImport.id)) && (
            <Alert
              type="info"
              showIcon
              message={`Another import is running: ${String(activeImport.params.filename ?? 'a CSV')}`}
              description="A new import starts when it finishes; jobs run one at a time."
              action={<Button onClick={() => showJob(activeImport.id)}>Show progress</Button>}
            />
          )}

          {!busy && session.stage !== 'finished' && !draft.file && (
            <Card size="small" className="nu-card">
              <Upload.Dragger
                multiple={false}
                maxCount={1}
                showUploadList={false}
                beforeUpload={(f) => {
                  void accept(f)
                  return Upload.LIST_IGNORE
                }}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">Drop a CSV or any delimited text file here, or click to choose</p>
                <p className="nu-drop-hint">
                  Any column names, with or without a header row; comma, semicolon, tab, pipe or another separator; UTF-8, UTF-16 or a Windows
                  encoding — all detected and shown. You then choose the column to analyse.
                  {maxBytes ? ` Up to ${fmtBytes(maxBytes)} and ${fmtInt(config?.limits.upload_max_rows)} rows.` : ''}
                </p>
              </Upload.Dragger>
            </Card>
          )}

          {showDraft && (
            <>
              <FileCard draft={draft} />
              <ColumnsCard draft={draft} />
              <OptionsCard draft={draft} busy={busy} />
            </>
          )}

          {session.stage === 'uploading' && (
            <Card
              size="small"
              className="nu-card"
              title="Uploading"
              extra={
                <Text type="secondary">
                  {session.fileName} · {fmtBytes(session.fileSize)}
                </Text>
              }
            >
              <Progress percent={session.uploadPercent} status="active" aria-label="Upload progress" />
              <Button onClick={() => importSession.cancelUpload()}>Cancel upload</Button>
            </Card>
          )}

          {session.jobId && (session.stage === 'processing' || session.stage === 'finished') && (
            <Card size="small" className="nu-card" title="Processing" extra={session.fileName ? <Text type="secondary">{session.fileName}</Text> : null}>
              <JobProgress key={session.jobId} jobId={session.jobId} onDone={onJobDone} />
            </Card>
          )}

          {session.stage === 'finished' && finishedJob && <ImportSummary job={finishedJob} />}

          {session.stage === 'finished' && (
            <div>
              <Button onClick={resetAll}>Import another file</Button>
            </div>
          )}
        </div>

        <div className="nu-imp-side">
          <Card size="small" className="nu-card" title="File format">
            <Paragraph type="secondary" style={{ fontSize: 13 }}>
              One document per row, any columns. After choosing the file you see its header and pick the <strong>column to analyse</strong>{' '}
              — the one with the text. An id column is optional (ids are generated from the text otherwise), and the other columns can be kept
              as filterable metadata. Quoted cells may contain separators and line breaks. Excel workbooks (.xlsx) must be saved as CSV first.
            </Paragraph>
            <pre className="nu-template">{'title;body;desk\nRail funding;"Stations will be modernised.";transport'}</pre>
            <Button icon={<DownloadOutlined />} style={{ marginTop: 12 }} onClick={downloadTemplate}>
              Download an example
            </Button>
          </Card>
          <SingleDocument />
          <History jobs={jobs} selected={session.jobId} disabled={session.stage === 'uploading'} onOpen={showJob} />
        </div>
      </div>

      <PageDoc doc={PAGE_DOCS.import} />
    </div>
  )
}
