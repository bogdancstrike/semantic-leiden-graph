import { useState } from 'react'
import { Alert, Button, Checkbox, Input, Tooltip, Typography } from 'antd'
import { ExperimentOutlined, AimOutlined } from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { communityColor } from '@/lib/palette'

export interface GraphCommunity { id: number; name: string; shown: number; total?: number }

export function CommunityNavigator({ groups, active, hidden, onHighlight, onVisibility }: { groups: GraphCommunity[]; active: number | null; hidden: Set<string>; onHighlight: (id: number | null) => void; onVisibility: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const config = useQuery({ queryKey: ['analysis-config'], queryFn: ({ signal }) => api.analysisConfig(signal) })
  const analysis = useMutation({ mutationFn: (ids: number[]) => api.analyze({ community_ids: ids, time_range: 'all' }), onSuccess: (job) => navigate(`/topics?run=${job.params.analysis_id}`) })
  const selected = active === null ? groups.map(g => g.id) : [active]
  return <aside className="graph-community-navigator" aria-label="Detected graph communities">
    <div className="graph-community-heading"><div><Typography.Text strong>Detected communities</Typography.Text><br /><Typography.Text type="secondary">{groups.length} groups · click to focus</Typography.Text></div>{active !== null && <Button size="small" onClick={() => onHighlight(null)}>Show all</Button>}</div>
    <Input.Search aria-label="Find a detected community" placeholder="Find a story or theme…" size="small" value={query} onChange={(e) => setQuery(e.target.value)} allowClear />
    <div className="graph-community-list">{groups.filter(g => g.name.toLowerCase().includes(query.toLowerCase())).map((group) => <div key={group.id} className={`graph-community-row ${active === group.id ? 'is-active' : ''}`}>
      <Checkbox aria-label={`Show ${group.name}`} checked={!hidden.has(String(group.id))} onChange={() => onVisibility(String(group.id))} />
      <button type="button" className="graph-community-focus" aria-label={`Highlight community C${group.id}: ${group.name}`} aria-pressed={active === group.id} onClick={() => onHighlight(active === group.id ? null : group.id)}>
        <span className="graph-community-dot" style={{ background: communityColor(group.id) }} />
        <span><strong>{group.name}</strong><small>{group.shown} visible{group.total ? ` · ${group.total} documents in group` : ''}</small></span><AimOutlined />
      </button>
    </div>)}</div>
    <Tooltip title={active === null ? 'Analyze the full document membership of the communities shown here' : 'Analyze the highlighted community'}><Button block type="primary" icon={<ExperimentOutlined />} loading={analysis.isPending} disabled={!config.data?.configured || !selected.length} onClick={() => analysis.mutate(selected)}>{active === null ? 'Send to analysis' : 'Analyze highlighted community'}</Button></Tooltip>
    {analysis.error && <Alert type="error" message={analysis.error.message} style={{ marginTop: 8 }} />}
  </aside>
}
