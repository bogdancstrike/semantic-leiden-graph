import type { ReactNode } from 'react'
import { Button, Typography } from 'antd'
import { InboxOutlined } from '@ant-design/icons'

/**
 * "Nothing here yet" wants the action that creates the first record; "nothing
 * matched" wants the filters cleared. A single shrug for both leaves the reader
 * unsure whether they are looking at an empty system or a bad filter.
 */
export function EmptyState({
  title = 'Nothing here yet',
  hint,
  icon,
  action,
  compact = false,
}: {
  title?: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  action?: ReactNode
  compact?: boolean
}) {
  return (
    <div className={`nu-empty${compact ? ' nu-empty--compact' : ''}`}>
      <div className="nu-empty-icon">{icon ?? <InboxOutlined />}</div>
      <Typography.Text strong>{title}</Typography.Text>
      {hint && <div className="nu-empty-hint">{hint}</div>}
      {action && <div className="nu-empty-action">{action}</div>}
    </div>
  )
}

export function NoResults({ onClear, hint }: { onClear?: () => void; hint?: ReactNode }) {
  return (
    <EmptyState
      title="Nothing matches this question"
      hint={hint ?? 'Loosen the conditions, switch the matching mode or lower the minimum score.'}
      action={onClear ? <Button onClick={onClear}>Clear the question</Button> : undefined}
    />
  )
}
