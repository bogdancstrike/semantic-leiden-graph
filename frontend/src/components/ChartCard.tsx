import { useState, type ReactNode } from 'react'
import { Button, Card, Segmented, Table, Tooltip } from 'antd'
import { BarChartOutlined, DownloadOutlined, TableOutlined } from '@ant-design/icons'
import ReactEChartsCore from 'echarts-for-react/lib/core'
import { echarts } from './charts/echarts'
import { EmptyState } from './EmptyState'
import { downloadText, toCsv } from '@/lib/download'

export interface ChartColumn {
  key: string
  label: string
}

/**
 * A chart that can always be read as a table (after the Nucleus ChartCard).
 *
 * Charts are for shape; tables are for "what exactly was the number". Both come
 * from the same rows, the chosen view is remembered per chart, and the CSV
 * button exports those rows — a chart you cannot get the numbers out of is a
 * chart people screenshot into a spreadsheet.
 */
export function ChartCard({
  id,
  title,
  option,
  rows,
  columns,
  height = 260,
  extra,
  onSelect,
  loading = false,
  empty,
  description,
}: {
  id: string
  title: ReactNode
  option: object | null
  rows: Record<string, string | number | null>[]
  columns: ChartColumn[]
  height?: number
  extra?: ReactNode
  /** Clicking a bar, point or slice drills into what is behind it. */
  onSelect?: (name: string, index: number) => void
  loading?: boolean
  empty?: { title: string; hint?: string }
  description?: ReactNode
}) {
  const [view, setView] = useState<'chart' | 'table'>(() => {
    try {
      return window.localStorage.getItem(`semantic-leiden.chart.${id}`) === 'table' ? 'table' : 'chart'
    } catch {
      return 'chart'
    }
  })
  const choose = (next: 'chart' | 'table') => {
    setView(next)
    try {
      window.localStorage.setItem(`semantic-leiden.chart.${id}`, next)
    } catch {
      // storage disabled; the choice just does not persist
    }
  }

  return (
    <Card
      size="small"
      className="nu-chartcard"
      loading={loading}
      title={title}
      extra={
        <span className="nu-chart-extra">
          {extra}
          <Tooltip title="Download these numbers as CSV">
            <Button
              type="text"
              size="small"
              disabled={!rows.length}
              aria-label={`Download ${id} as CSV`}
              icon={<DownloadOutlined />}
              onClick={() => downloadText(`${id}.csv`, toCsv(rows, columns), 'text/csv')}
            />
          </Tooltip>
          <Segmented
            size="small"
            value={view}
            onChange={(next) => choose(next as 'chart' | 'table')}
            options={[
              { value: 'chart', icon: <BarChartOutlined />, title: 'Chart' },
              { value: 'table', icon: <TableOutlined />, title: 'Table' },
            ]}
          />
        </span>
      }
    >
      {description && <div style={{ fontSize: 12, color: 'var(--nu-text-secondary)', marginBottom: 6 }}>{description}</div>}
      {!rows.length || !option ? (
        <div style={{ minHeight: height, display: 'grid', placeItems: 'center' }}>
          <EmptyState compact title={empty?.title ?? 'Nothing to chart yet'} hint={empty?.hint} />
        </div>
      ) : view === 'chart' ? (
        <ReactEChartsCore
          echarts={echarts}
          option={option}
          style={{ height, cursor: onSelect ? 'pointer' : 'default' }}
          notMerge
          onEvents={
            onSelect
              ? { click: (params: { name?: string; dataIndex?: number }) => params.name && onSelect(params.name, params.dataIndex ?? 0) }
              : undefined
          }
        />
      ) : (
        <Table
          size="small"
          rowKey="__row"
          dataSource={rows.map((row, index) => ({ ...row, __row: index }))}
          pagination={rows.length > 10 ? { pageSize: 10, size: 'small' } : false}
          scroll={{ y: height - 40 }}
          columns={columns.map((column) => ({
            title: column.label,
            dataIndex: column.key,
            render: (value: string | number | null) => (typeof value === 'number' ? value.toLocaleString() : (value ?? '—')),
          }))}
          onRow={
            onSelect
              ? (row, index) => ({
                  onClick: () => onSelect(String((row as Record<string, unknown>)[columns[0].key] ?? ''), index ?? 0),
                  style: { cursor: 'pointer' },
                })
              : undefined
          }
        />
      )}
    </Card>
  )
}
