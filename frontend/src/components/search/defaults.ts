import type { SearchMode, SearchRequest } from '@/api/types'

/** Ranking options that are a preference of the reader, not part of the question. */
export type SearchTuning = Pick<SearchRequest, 'min_score' | 'routing' | 'fusion' | 'lexical' | 'mmr'> & {
  /** Let anchor documents vote which communities to search (v0.3 routing). */
  autoRoute: boolean
  excludeCommunities: number[]
  liveSearch: boolean
}

export const DEFAULT_TUNING: SearchTuning = {
  min_score: undefined,
  routing: { strategy: 'sum', anchors: 20, communities: 1, temperature: 0.05 },
  fusion: { method: 'rrf', alpha: 0.5, rrf_k: 60 },
  lexical: { syntax: 'plain', operator: 'or', fuzzy: false, phrase_boost: true },
  mmr: { enabled: false, lambda: 0.7, candidates: 50 },
  autoRoute: false,
  excludeCommunities: [],
  liveSearch: true,
}

export const MODES: { value: SearchMode; label: string; hint: string }[] = [
  { value: 'hybrid', label: 'Hybrid', hint: 'Qdrant and Elasticsearch in parallel, fused with RRF or DBSF' },
  { value: 'semantic', label: 'Semantic', hint: 'Dense vectors in Qdrant: meaning, paraphrases, other languages' },
  { value: 'keyword', label: 'Keyword', hint: 'BM25 in Elasticsearch: exact names, codes, rare terms' },
]

/** How many tuning options differ from the defaults — the badge on the button. */
export function tuningChanges(t: SearchTuning): number {
  const d = DEFAULT_TUNING
  return (
    (t.autoRoute ? 1 : 0) +
    (t.excludeCommunities.length ? 1 : 0) +
    (t.min_score !== undefined ? 1 : 0) +
    (t.mmr.enabled ? 1 : 0) +
    (t.fusion.method !== d.fusion.method || t.fusion.alpha !== d.fusion.alpha ? 1 : 0) +
    (t.lexical.syntax !== d.lexical.syntax || t.lexical.operator !== d.lexical.operator || t.lexical.fuzzy ? 1 : 0)
  )
}

export function buildSearchRequest(
  query: string,
  mode: SearchMode,
  tuning: SearchTuning,
  opts: { topK: number; communities: number[]; conditionTree: SearchRequest['filters']['condition_tree'] },
): SearchRequest {
  const scope: SearchRequest['scope'] = tuning.autoRoute
    ? { type: 'auto', community_ids: [], exclude_community_ids: tuning.excludeCommunities }
    : opts.communities.length
      ? { type: 'communities', community_ids: opts.communities, exclude_community_ids: tuning.excludeCommunities }
      : { type: 'global', community_ids: [], exclude_community_ids: tuning.excludeCommunities }
  return {
    query,
    mode,
    top_k: Math.min(200, Math.max(1, opts.topK)),
    min_score: mode === 'keyword' ? undefined : tuning.min_score,
    scope,
    routing: tuning.routing,
    fusion: tuning.fusion,
    lexical: tuning.lexical,
    mmr: tuning.mmr,
    filters: opts.conditionTree ? { condition_tree: opts.conditionTree } : {},
    highlight: true,
    facets: true,
    explain: true,
  }
}
