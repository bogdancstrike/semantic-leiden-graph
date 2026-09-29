/**
 * Addresses of the app's views, built in one place so a deep link from the
 * overview, a drawer or a table always means the same question on arrival.
 */

import { treeFromRules, type SimpleRule } from '@/components/query/queryTree'
import type { SearchMode } from '@/api/types'

function build(path: string, params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `${path}?${text}` : path
}

const tree = (rules: SimpleRule[] | undefined) => (rules?.length ? JSON.stringify(treeFromRules(rules)) : null)

export const links = {
  explore: (p: { q?: string; mode?: SearchMode; communities?: number[]; rules?: SimpleRule[]; record?: string } = {}) =>
    build('/documents', {
      q: p.q,
      mode: p.mode,
      communities: p.communities?.join(','),
      tree: tree(p.rules),
      record: p.record,
    }),
  graph: (p: { focus?: string; communities?: number[]; q?: string; view?: string } = {}) =>
    build('/graph', {
      view: p.view ?? (p.focus ? 'focus' : p.communities?.length ? 'communities' : p.q ? 'query' : undefined),
      focus: p.focus,
      communities: p.communities?.join(','),
      q: p.q,
    }),
  communities: (p: { selected?: number; q?: string } = {}) => build('/communities', { selected: p.selected, q: p.q }),
}

/** Rule helpers for the fields the drill-downs use. */
export const rule = {
  source: (source: string | null): SimpleRule =>
    source === null
      ? { field: 'source', operator: 'is_null', value: [] }
      : { field: 'source', operator: 'select_equals', value: [source] },
  /** In no community, for either reason. */
  unassigned: (): SimpleRule => ({ field: 'community_id', operator: 'is_null', value: [] }),
  /** Added or changed since the last clustering run. */
  unclustered: (): SimpleRule => ({ field: 'community_version', operator: 'is_null', value: [] }),
  /** Clustered, but into a group too small to be a community. */
  clustered: (): SimpleRule => ({ field: 'community_version', operator: 'is_not_null', value: [] }),
  communities: (ids: number[]): SimpleRule => ({ field: 'community_id', operator: 'select_any_in', value: [ids] }),
  lengthAtLeast: (n: number): SimpleRule => ({ field: 'length', operator: 'greater_or_equal', value: [n] }),
  lengthBetween: (from: number, to: number): SimpleRule => ({ field: 'length', operator: 'between', value: [from, to] }),
}
