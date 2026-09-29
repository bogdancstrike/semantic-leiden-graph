import { NEUTRAL } from '@/theme/tokens'

// Twelve hues that hold 3:1 against both the light card (#fff) and the dark one
// (#15171c), and stay distinguishable next to each other in the graph. The first
// eight are the template's chart series, so a community is the same colour in a
// chart as on the canvas. Community IDs are arbitrary Leiden integers, so colour
// is a stable hash of the ID: the same community keeps its colour everywhere.
export const COMMUNITY_COLORS = [
  '#5b5bd6',
  '#0891b2',
  '#16a34a',
  '#ca8a04',
  '#db2777',
  '#7c3aed',
  '#0d9488',
  '#ea580c',
  '#2563eb',
  '#65a30d',
  '#c026d3',
  '#b45309',
] as const

export const UNASSIGNED_COLOR = NEUTRAL[400]

export function communityColor(id: number | null | undefined): string {
  if (id === null || id === undefined) return UNASSIGNED_COLOR
  const hashed = Math.imul(Math.abs(id) ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  return COMMUNITY_COLORS[hashed % COMMUNITY_COLORS.length]
}

/** What a document without a community is called, everywhere. */
export const NO_COMMUNITY = 'No community'

export const NO_COMMUNITY_HINT =
  'In no community: added since the last clustering run, or too loosely linked to join one (a community has at least two documents).'

export const communityLabel = (id: number | null | undefined) => (id === null || id === undefined ? NO_COMMUNITY : `C${id}`)
