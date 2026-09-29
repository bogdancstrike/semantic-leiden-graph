import { memo, useState } from 'react'
import { Button, Popover, Space, Tag, Tooltip, Typography } from 'antd'
import { ApartmentOutlined, EyeOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { CommunityKey } from '@/components/CommunityKey'
import { useDocumentDrawer } from '@/components/DocumentDrawer'
import { fmtInt, fmtRelative, fmtScore } from '@/lib/format'
import { Highlighted } from '@/lib/highlight'
import { links } from '@/lib/links'
import { KEYWORD_COLOR, SEMANTIC_COLOR } from '@/theme/tokens'
import type { HitExplain, SearchMode } from '@/api/types'

/** A search hit or a browsed document, in the one shape every result view renders. */
export interface ResultRow {
  id: string
  external_id?: string | null
  text: string
  highlights: string[]
  community_id?: number | null
  source?: string | null
  length?: number
  updated_at?: string
  metadata?: Record<string, string> | null
  score?: number | null
  explain?: HitExplain
}

function RankBar({ label, rank, score, color, depth }: { label: string; rank?: number; score?: number; color: string; depth: number }) {
  const width = rank ? Math.max(6, 100 - ((rank - 1) / Math.max(depth, 1)) * 100) : 0
  return (
    <div className="rank-bar">
      <span>{label}</span>
      <div className="rank-bar-track" aria-hidden>
        <div className="rank-bar-fill" style={{ width: `${width}%`, background: color }} />
      </div>
      <span style={{ textAlign: 'right' }}>{rank ? `#${rank}` : 'none'}</span>
      {score !== undefined && <span style={{ gridColumn: '2 / 4', color: 'var(--nu-text-secondary)' }}>score {fmtScore(score)}</span>}
    </div>
  )
}

export function Explain({ explain, depth }: { explain: HitExplain; depth: number }) {
  return (
    <div style={{ width: 260 }}>
      <Space direction="vertical" style={{ width: '100%' }} size={10}>
        <RankBar label="Semantic" rank={explain.semantic_rank} score={explain.semantic_score} color={SEMANTIC_COLOR} depth={depth} />
        <RankBar label="Keyword" rank={explain.keyword_rank} score={explain.keyword_score} color={KEYWORD_COLOR} depth={depth} />
        {explain.fused_score !== undefined && explain.fused_score !== null && <div className="timings">fused score {fmtScore(explain.fused_score, 5)}</div>}
        {explain.mmr_rank !== undefined && explain.mmr_rank !== null && <div className="timings">MMR position {explain.mmr_rank}</div>}
      </Space>
    </div>
  )
}

export function ResultText({ row, rows = 3, expanded = false }: { row: ResultRow; rows?: number; expanded?: boolean }) {
  if (!expanded && row.highlights.length) {
    return (
      <>
        {row.highlights.map((fragment, i) => (
          <span key={i}>
            {i > 0 && <span style={{ color: 'var(--nu-text-tertiary)' }}> … </span>}
            <Highlighted fragment={fragment} />
          </span>
        ))}
      </>
    )
  }
  return (
    <Typography.Paragraph ellipsis={expanded ? false : { rows }} style={{ margin: 0 }}>
      {row.text}
    </Typography.Paragraph>
  )
}

interface Props {
  row: ResultRow
  position: number
  mode: SearchMode | 'browse'
  depth: number
}

export const ResultCard = memo(function ResultCard({ row, position, mode, depth }: Props) {
  const drawer = useDocumentDrawer()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)
  const scoreLabel = mode === 'hybrid' ? 'fused' : mode === 'keyword' ? 'BM25' : mode === 'semantic' ? 'cosine' : null

  return (
    <article className="sl-result" aria-label={`Result ${position}`}>
      <div className="sl-result-meta">
        <span className="sl-result-pos">{position}</span>
        <CommunityKey id={row.community_id} />
        <Typography.Text className="mono" type="secondary" ellipsis style={{ maxWidth: 220 }}>
          {row.external_id}
        </Typography.Text>
        {scoreLabel && row.score !== undefined && row.score !== null && (
          <span>
            {scoreLabel} {fmtScore(row.score, mode === 'hybrid' ? 4 : 3)}
          </span>
        )}
        {row.explain?.semantic_rank && row.explain?.keyword_rank && <Tag color="gold" bordered={false}>both engines</Tag>}
        {row.source && <span>{row.source}</span>}
        {row.length !== undefined && <span>{fmtInt(row.length)} chars</span>}
        {row.updated_at && <span>{fmtRelative(row.updated_at)}</span>}
      </div>

      <div className="sl-result-text">
        <ResultText row={row} expanded={expanded} />
      </div>

      <Space wrap size={[4, 4]}>
        <Button type="text" icon={<EyeOutlined />} onClick={() => drawer.open(row.id)}>
          Details
        </Button>
        {row.highlights.length > 0 && (
          <Button type="text" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
            {expanded ? 'Show matches' : 'Full text'}
          </Button>
        )}
        <Tooltip title="Open the similarity graph around this document">
          <Button type="text" icon={<ApartmentOutlined />} onClick={() => navigate(links.graph({ focus: row.id }))}>
            Neighbourhood
          </Button>
        </Tooltip>
        {row.explain && mode !== 'browse' && (
          <Popover content={<Explain explain={row.explain} depth={depth} />} title="Why this result" trigger="click">
            <Button type="text" icon={<InfoCircleOutlined />}>
              Explain
            </Button>
          </Popover>
        )}
        {Object.entries(row.metadata ?? {})
          .slice(0, 3)
          .map(([k, v]) => (
            <Tag key={k} bordered={false}>
              {k}: {String(v)}
            </Tag>
          ))}
      </Space>
    </article>
  )
})
