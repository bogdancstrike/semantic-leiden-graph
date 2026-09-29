/**
 * Design tokens: one source, three consumers.
 *
 * The AntD theme (`antd.ts`), the CSS custom properties the stylesheet reads and
 * the ECharts theme (`echarts.ts`) are all derived from this file, so a table and
 * the chart beside it can never be themed by two systems that drift apart.
 *
 * Ported from the Nucleus dashboard template. Rules it encodes:
 * - colour means something: status, severity and community get colour, nothing else;
 * - one accent (the logo's core), lighter in dark mode so it stays findable;
 * - density is a first-class axis (compact / middle / comfortable).
 */

export const NEUTRAL = {
  50: '#f8fafc',
  100: '#f1f5f9',
  200: '#e2e8f0',
  300: '#cbd5e1',
  400: '#94a3b8',
  // Darkened from #64748b: tertiary text lands on the page ground too, where the
  // original measured 4.34:1 (under the 4.5:1 body-text bar).
  500: '#5f6e85',
  600: '#475569',
  700: '#334155',
  800: '#1e293b',
  900: '#0f172a',
  950: '#020617',
} as const

/**
 * Near-achromatic charcoal for dark mode. Slate inverted reads as navy at 8%
 * lightness; with these greys only the accent and status colours carry hue.
 */
export const INK = {
  950: '#08090c',
  900: '#0b0c10',
  850: '#0e0f14',
  800: '#15171c',
  750: '#1b1e24',
  700: '#232730',
  650: '#262a33',
  600: '#343a45',
  500: '#4a515e',
  400: '#7d8595',
  300: '#9aa2b1',
  200: '#c3c8d2',
  100: '#e8eaf0',
} as const

export const PAPER = '#ffffff'

/** The mark's own colours; the accent is taken *from* the logo, not the reverse. */
export const LOGO = {
  ring: '#8b8bf0',
  core: '#5b5bd6',
  spark: '#22d3ee',
} as const

export const ACCENT = {
  50: '#eeeefc',
  100: '#dcdcf9',
  200: '#bcbcf3',
  300: '#9a9aec',
  400: '#7c7cf5',
  500: '#5b5bd6',
  600: '#4a4ac0',
  700: '#4338ca',
  800: '#332f96',
  900: '#272470',
} as const

export const SEMANTIC = {
  success: '#16a34a',
  warning: '#ca8a04',
  danger: '#dc2626',
  info: '#0891b2',
  neutral: NEUTRAL[500],
} as const

/**
 * The same four meanings at a lightness that can be *read* as small text.
 * `SEMANTIC` is tuned for fills (3:1); captions need 4.5:1, which the fills miss.
 */
export const SEMANTIC_INK = {
  light: { success: '#166534', warning: '#854d0e', danger: '#b91c1c', info: '#155e75' },
  dark: { success: '#4ade80', warning: '#fbbf24', danger: '#f87171', info: '#22d3ee' },
} as const

/** Categorical chart series: adjacent entries differ in hue *and* lightness. */
export const SERIES = [
  '#5b5bd6',
  '#0891b2',
  '#16a34a',
  '#ca8a04',
  '#db2777',
  '#7c3aed',
  '#0d9488',
  '#ea580c',
  '#64748b',
  '#4338ca',
] as const

/** The two retrieval signals, wherever they are compared side by side. */
export const SEMANTIC_COLOR = SEMANTIC.info
export const KEYWORD_COLOR = '#ea580c'

/** Status -> colour, keyed by the exact strings the API returns. */
export const STATUS_COLORS: Record<string, string> = {
  QUEUED: NEUTRAL[500],
  RUNNING: ACCENT[500],
  SUCCEEDED: SEMANTIC.success,
  FAILED: SEMANTIC.danger,
  CANCELLED: NEUTRAL[400],
  HEALTHY: SEMANTIC.success,
  DEGRADED: SEMANTIC.warning,
  UNAVAILABLE: SEMANTIC.danger,
}

export function statusColor(value: string | null | undefined): string {
  if (!value) return NEUTRAL[400]
  return STATUS_COLORS[value.toUpperCase()] ?? NEUTRAL[400]
}

export const RADIUS = { control: 4, card: 6, modal: 8, pill: 999 } as const

export const FONT = {
  family:
    "'Inter Variable', Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const

export type Density = 'compact' | 'middle' | 'comfortable'

export const DENSITY: Record<Density, { rowHeight: number; controlHeight: number; fontSize: number; padding: number }> = {
  compact: { rowHeight: 32, controlHeight: 28, fontSize: 13, padding: 8 },
  middle: { rowHeight: 40, controlHeight: 32, fontSize: 14, padding: 12 },
  comfortable: { rowHeight: 52, controlHeight: 40, fontSize: 14, padding: 16 },
}

export const LAYOUT = {
  headerHeight: 56,
  sidebarWidth: 248,
  sidebarCollapsedWidth: 56,
  breakpoints: { mobile: 768, tablet: 1024, laptop: 1440 },
} as const

export const SHADOW = {
  sm: '0 1px 2px rgba(15, 23, 42, 0.06)',
  md: '0 2px 8px rgba(15, 23, 42, 0.08)',
  lg: '0 8px 24px rgba(15, 23, 42, 0.12)',
} as const

/** Depth in a dark UI comes from a *darker*, more opaque shadow. */
export const SHADOW_DARK = {
  sm: '0 1px 2px rgba(0, 0, 0, 0.5)',
  md: '0 4px 16px rgba(0, 0, 0, 0.5)',
  lg: '0 12px 34px rgba(0, 0, 0, 0.62)',
} as const
