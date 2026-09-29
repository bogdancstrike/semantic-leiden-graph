import { useState } from 'react'
import { Alert, Button, Card, Space, Tag, Tooltip, Typography } from 'antd'
import { CommunityKey } from '@/components/CommunityKey'
import { Chip } from '@/components/Chip'
import { EmptyState } from '@/components/EmptyState'
import { communityColor, NO_COMMUNITY } from '@/lib/palette'
import { fmtMs, fmtScore } from '@/lib/format'
import type { SearchResponse } from '@/api/types'

const TIMING_LABELS: Record<string, string> = {
  embed_ms: 'embed',
  route_ms: 'route',
  prefilter_ms: 'pre-filter',
  vector_ms: 'Qdrant',
  keyword_ms: 'Elasticsearch',
  fusion_ms: 'fusion',
  mmr_ms: 'MMR',
  hydrate_ms: 'hydrate',
  total_ms: 'total',
}

export function Timings({ timings }: { timings: Record<string, number> }) {
  return (
    <div className="timings" aria-label="Server timings">
      {Object.entries(timings).map(([key, value]) =>
        key === 'total_ms' ? (
          <strong key={key}>
            {TIMING_LABELS[key]} {fmtMs(value)}
          </strong>
        ) : (
          <span key={key}>
            {TIMING_LABELS[key] ?? key} {fmtMs(value)}
          </span>
        ),
      )}
    </div>
  )
}

/** The anchor vote behind automatic community routing. */
export function RoutingCard({ routing }: { routing: NonNullable<SearchResponse['routing']> }) {
  const top = routing.candidates.slice(0, 6)
  return (
    <Card size="small" className="nu-card" title="Community vote" extra={<Tag bordered={false}>{routing.strategy}</Tag>}>
      {top.length === 0 ? (
        <EmptyState compact title="No clustered anchors" />
      ) : (
        <Space direction="vertical" style={{ width: '100%' }} size={6}>
          {top.map((c) => (
            <Tooltip key={c.community_id} title={`${c.anchors} anchor(s), best cosine ${fmtScore(c.best_score)}`}>
              <div className="vote-row">
                <CommunityKey id={c.community_id} />
                <div className="rank-bar-track">
                  <div
                    className="rank-bar-fill"
                    style={{
                      width: `${Math.max(3, c.share * 100)}%`,
                      background: communityColor(c.community_id),
                      opacity: routing.selected.includes(c.community_id) ? 1 : 0.45,
                    }}
                  />
                </div>
                <span style={{ textAlign: 'right' }}>{Math.round(c.share * 100)}%</span>
              </div>
            </Tooltip>
          ))}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Searched {routing.selected.map((id) => `C${id}`).join(', ')}
          </Typography.Text>
        </Space>
      )}
    </Card>
  )
}

/** Matches per community; a click narrows the question to that community. */
const FACETS_SHOWN = 24

export function FacetCard({ response, selected, onToggle }: { response: SearchResponse; selected: number[]; onToggle: (id: number) => void }) {
  const [all, setAll] = useState(false)
  const every = response.facets.communities ?? []
  const buckets = all ? every : every.slice(0, FACETS_SHOWN)
  const sources = response.facets.sources ?? []
  if (!buckets.length) return null
  return (
    <Card
      size="small"
      className="nu-card"
      title="Matches by community"
      extra={
        <Tooltip
          title={
            response.facet_source === 'keyword'
              ? 'Elasticsearch aggregation over every keyword match, before the community filter is applied'
              : 'Counted over the semantic candidate set'
          }
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {response.facet_source === 'keyword' ? 'all matches' : 'candidates'}
          </Typography.Text>
        </Tooltip>
      }
    >
      <Space wrap size={[6, 6]}>
        {buckets.map((b) =>
          typeof b.value === 'number' ? (
            <Chip
              key={b.value}
              pressed={selected.includes(b.value)}
              onClick={() => onToggle(b.value as number)}
              label={`Community C${b.value}, ${b.count} matches${selected.includes(b.value) ? ', filtering' : ''}`}
            >
              <CommunityKey id={b.value} label={`C${b.value} · ${b.count}`} />
            </Chip>
          ) : (
            <Tag key="unassigned" bordered={false}>
              <CommunityKey id={null} label={`${NO_COMMUNITY} · ${b.count}`} />
            </Tag>
          ),
        )}
        {every.length > FACETS_SHOWN && (
          <Button type="text" onClick={() => setAll((v) => !v)}>
            {all ? 'Show fewer' : `+${every.length - FACETS_SHOWN} more`}
          </Button>
        )}
      </Space>
      {sources.length > 1 && (
        <div style={{ marginTop: 10 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Sources
          </Typography.Text>
          <div>
            <Space wrap size={[4, 4]}>
              {sources.map((s) => (
                <Tag key={String(s.value)} bordered={false}>
                  {String(s.value)} · {s.count}
                </Tag>
              ))}
            </Space>
          </div>
        </div>
      )}
    </Card>
  )
}

export function Warnings({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {warnings.map((w) => (
        <Alert key={w} type="warning" showIcon message={w} />
      ))}
    </Space>
  )
}
