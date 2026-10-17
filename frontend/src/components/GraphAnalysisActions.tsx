import { Alert, Button, Card, Space, Tag, Typography } from 'antd'
import { ExperimentOutlined, HighlightOutlined } from '@ant-design/icons'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { api } from '@/api/client'
import { CommunityKey } from './CommunityKey'

/** Graph → analysis → saved Topics, with membership captured before reclustering. */
export function GraphAnalysisActions({ ids, onHighlight }: { ids: number[]; onHighlight?: (id: number) => void }) {
  const navigate = useNavigate()
  const config = useQuery({ queryKey: ['analysis-config'], queryFn: ({ signal }) => api.analysisConfig(signal) })
  const analyze = useMutation({ mutationFn: (communityIds: number[]) => api.analyze({ community_ids: communityIds, time_range: 'all' }), onSuccess: (job) => navigate(`/topics?run=${job.params.analysis_id}`) })
  if (!ids.length) return null
  return <Card className="nu-card" size="small" title={`${ids.length} detected ${ids.length === 1 ? 'community' : 'communities'}`}>
    <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
      <Space wrap>{ids.slice(0, 12).map((id) => <Space.Compact key={id}><Tag style={{ margin: 0 }}><CommunityKey id={id} /></Tag>{onHighlight && <Button size="small" icon={<HighlightOutlined />} aria-label={`Highlight community C${id}`} onClick={() => onHighlight(id)} />}</Space.Compact>)}{ids.length > 12 && <Typography.Text type="secondary">and {ids.length - 12} more</Typography.Text>}</Space>
      <Button type="primary" icon={<ExperimentOutlined />} loading={analyze.isPending} disabled={!config.data?.configured} onClick={() => analyze.mutate(ids)}>Send to analysis</Button>
    </Space>
    <Typography.Paragraph type="secondary" style={{ margin: '10px 0 0' }}>These communities share similar documents. Analyze their full membership to uncover topics, narratives, sentiment and classifications, then investigate the results in Topics.</Typography.Paragraph>
    {!config.isLoading && !config.data?.configured && <Typography.Text type="secondary">Configure a provider key to enable AI analysis.</Typography.Text>}
    {analyze.error && <Alert style={{ marginTop: 12 }} type="error" showIcon message="Analysis could not start" description={analyze.error.message} />}
  </Card>
}
