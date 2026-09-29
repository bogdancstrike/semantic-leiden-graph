import type { ReactNode } from 'react'
import { Space } from 'antd'

/**
 * One header for every page: title, one line of context, actions on the right.
 * The same three slots in the same places, so the eye already knows where the
 * actions are on a page it has never opened.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  tag,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  /** A status or count that belongs beside the title rather than under it. */
  tag?: ReactNode
}) {
  return (
    <div className="nu-page-header">
      <div className="nu-page-header-titles">
        <h1 className="nu-page-title">
          {title}
          {tag}
        </h1>
        {subtitle && <div className="nu-page-subtitle">{subtitle}</div>}
      </div>
      {actions && (
        <Space className="nu-page-actions" wrap>
          {actions}
        </Space>
      )}
    </div>
  )
}
