import type { ReactNode } from 'react'
import { Card, Skeleton } from 'antd'
import { ACCENT, NEUTRAL, SEMANTIC } from '@/theme/tokens'

const ACCENTS: Record<string, string> = {
  accent: ACCENT[500],
  success: SEMANTIC.success,
  warning: SEMANTIC.warning,
  danger: SEMANTIC.danger,
  info: SEMANTIC.info,
  neutral: NEUTRAL[500],
}

/** A KPI tile. Clickable tiles drill into the records behind the number. */
export function StatCard({
  label,
  value,
  icon,
  accent = 'accent',
  hint,
  loading = false,
  onClick,
}: {
  label: string
  value: ReactNode
  icon?: ReactNode
  accent?: keyof typeof ACCENTS
  hint?: ReactNode
  loading?: boolean
  onClick?: () => void
}) {
  const color = ACCENTS[accent] ?? ACCENT[500]
  return (
    <Card
      className="nu-statcard"
      styles={{ body: { padding: 16 } }}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={onClick ? `${label}: ${typeof value === 'string' || typeof value === 'number' ? value : ''}. Open the details.` : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onClick()
              }
            }
          : undefined
      }
      style={onClick ? { cursor: 'pointer' } : undefined}
    >
      <div className="nu-statcard-row">
        {icon && (
          <div className="nu-statcard-icon" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }} aria-hidden>
            {icon}
          </div>
        )}
        <div className="nu-statcard-main">
          <div className="nu-statcard-label">{label}</div>
          {loading ? (
            <Skeleton.Input active size="small" style={{ width: 80 }} />
          ) : (
            <div className="nu-statcard-number">{value}</div>
          )}
          {hint && <div className="nu-statcard-hint">{hint}</div>}
        </div>
      </div>
    </Card>
  )
}
