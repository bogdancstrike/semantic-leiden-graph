import type { ReactNode } from 'react'

/**
 * `List.Item.Meta` without its `<h4>`: a list row's title is not a section
 * heading, and a stray h4 under the page's h1 breaks heading navigation.
 */
export function ListMeta({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="nu-list-meta">
      <div className="nu-list-meta-title">{title}</div>
      {description && <div className="nu-list-meta-description">{description}</div>}
    </div>
  )
}
