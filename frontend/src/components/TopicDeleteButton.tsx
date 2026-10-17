import { Button, Popconfirm, Tooltip } from 'antd'
import { DeleteOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/api/client'

export function TopicDeleteButton({ id, onDeleted }: { id: string; onDeleted?: () => void }) {
  const client = useQueryClient()
  const remove = useMutation({ mutationFn: () => api.deleteTopic(id), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['topics'] })
    void client.invalidateQueries({ queryKey: ['analysis-runs'] })
    void client.invalidateQueries({ queryKey: ['analysis-run'] })
    onDeleted?.()
  } })
  return <Tooltip title={remove.error?.message ?? 'Delete saved topic analysis'}><Popconfirm title="Delete this topic analysis?" description="The saved analysis and membership will be removed. Source documents remain available." okText="Delete topic" okButtonProps={{ danger: true, loading: remove.isPending }} onConfirm={() => remove.mutateAsync()}><Button danger type="text" aria-label="Delete topic" icon={<DeleteOutlined />} loading={remove.isPending} /></Popconfirm></Tooltip>
}
