import type { ReactNode } from 'react'

/**
 * A pill-shaped button for suggestions, presets and facet toggles.
 *
 * A real `<button>` rather than antd's CheckableTag, which is a `<span>` with a
 * click handler: not focusable, not announced as a control, unreachable by keyboard.
 */
export function Chip({
  children,
  onClick,
  pressed,
  icon,
  label,
}: {
  children: ReactNode
  onClick: () => void
  /** For toggles: announced as pressed / not pressed. Omit for one-off actions. */
  pressed?: boolean
  icon?: ReactNode
  /** Accessible name when the visible text is not enough. */
  label?: string
}) {
  return (
    <button type="button" className={`nu-chip${pressed ? ' is-pressed' : ''}`} aria-pressed={pressed} aria-label={label} onClick={onClick}>
      {icon}
      <span className="nu-chip-text">{children}</span>
    </button>
  )
}

/**
 * An applied filter: pressing the label edits it, the × removes it. Two real
 * buttons, because antd's closable Tag draws its × as an unfocusable icon.
 */
export function FilterChip({
  children,
  name,
  onEdit,
  onRemove,
  icon,
  tone,
}: {
  children: ReactNode
  /** What the filter is, for the remove button's accessible name: "Remove <name>". */
  name: string
  onEdit?: () => void
  onRemove: () => void
  icon?: ReactNode
  tone?: 'accent'
}) {
  return (
    <span className={`nu-chip nu-chip--filter${tone === 'accent' ? ' is-pressed' : ''}`}>
      {onEdit ? (
        <button type="button" className="nu-chip-main" onClick={onEdit} aria-label={`Edit ${name}`}>
          {icon}
          <span className="nu-chip-text">{children}</span>
        </button>
      ) : (
        <span className="nu-chip-main">
          {icon}
          <span className="nu-chip-text">{children}</span>
        </span>
      )}
      <button type="button" className="nu-chip-remove" onClick={onRemove} aria-label={`Remove ${name}`}>
        ×
      </button>
    </span>
  )
}
