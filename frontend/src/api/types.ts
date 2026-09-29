export type SearchMode = 'semantic' | 'keyword' | 'hybrid'
export type ScopeType = 'global' | 'communities' | 'auto'
export type RoutingStrategy = 'top1' | 'sum' | 'max' | 'mean' | 'softmax'
export type FusionMethod = 'rrf' | 'dbsf'

/**
 * One node of a react-awesome-query-builder condition tree, as it travels on
 * the wire. The server compiles the same JSON into an Elasticsearch bool query
 * (`app/search/conditions.py`) and describes it for the query inspector.
 */
export interface QueryNode {
  id?: string
  type?: string
  properties?: Record<string, unknown>
  children1?: Record<string, QueryNode> | QueryNode[]
}

export interface SearchFilters {
  must_text?: string
  exclude_text?: string
  length_min?: number
  length_max?: number
  sources?: string[]
  metadata?: Record<string, string>
  unassigned_only?: boolean
  condition_tree?: QueryNode | null
}

export interface SearchRequest {
  query: string
  mode: SearchMode
  top_k: number
  min_score?: number
  scope: { type: ScopeType; community_ids: number[]; exclude_community_ids: number[] }
  routing: { strategy: RoutingStrategy; anchors: number; communities: number; temperature: number }
  fusion: { method: FusionMethod; alpha: number; rrf_k: number }
  lexical: { syntax: 'plain' | 'advanced'; operator: 'or' | 'and'; fuzzy: boolean; phrase_boost: boolean }
  mmr: { enabled: boolean; lambda: number; candidates: number }
  filters: SearchFilters
  highlight: boolean
  facets: boolean
  explain: boolean
}

export interface HitExplain {
  semantic_rank?: number
  semantic_score?: number
  keyword_rank?: number
  keyword_score?: number
  fused_score?: number
  mmr_rank?: number
}

export interface SearchHit {
  id: string
  external_id?: string
  text: string
  score: number
  community_id?: number | null
  source?: string
  metadata?: Record<string, string>
  highlights: string[]
  explain?: HitExplain
}

export interface RoutingCandidate {
  community_id: number
  support: number
  share: number
  anchors: number
  best_score: number
}

export interface FacetBucket {
  value: number | string | null
  count: number
}

export interface SearchResponse {
  mode: SearchMode
  results: SearchHit[]
  total_lexical?: number
  routing?: {
    strategy: RoutingStrategy
    selected: number[]
    candidates: RoutingCandidate[]
    anchor_document_id?: string
    anchor_score?: number
  }
  facets: Record<string, FacetBucket[]>
  facet_source: 'keyword' | 'candidates' | 'none'
  timings: Record<string, number>
  warnings: string[]
}

// ---------------------------------------------------------------------------- explore

export type ExploreFieldKind = 'fulltext' | 'keyword' | 'enum' | 'community' | 'number' | 'datetime' | 'metadata'

export interface ExploreChoice {
  value: string | number
  label: string
  count: number
}

export interface ExploreField {
  name: string
  label: string
  kind: ExploreFieldKind
  /** react-awesome-query-builder operator names the server accepts for this field. */
  operators: string[]
  choices: ExploreChoice[]
  sortable: boolean
  group: string
  description?: string
}

export interface ExploreCatalogue {
  fields: ExploreField[]
  total: number
  unassigned?: number
  sort_fields: string[]
}

export type ExploreSort = 'updated_at' | 'created_at' | 'length' | 'external_id' | 'community_id' | 'source' | '_score'

export interface ExploreRequest {
  query_text?: string
  condition_tree?: QueryNode | null
  sort?: ExploreSort
  order?: 'asc' | 'desc'
  page?: number
  page_size?: number
  facets?: boolean
  highlight?: boolean
}

export interface ExploreItem extends DocumentRecord {
  highlights?: string[]
  score?: number
}

export interface ExploreResult {
  items: ExploreItem[]
  total: number
  total_relation: 'eq' | 'gte'
  page: number
  page_size: number
  pages: number
  sort: string
  order: 'asc' | 'desc'
  condition_text: string
  rule_count: number
  facets: Record<string, FacetBucket[]>
  took_ms: number
}

export interface ExploreInsights {
  total: number
  metrics: {
    documents: number
    communities: number
    /** No community: `unclustered` + `outside_communities`. */
    unassigned: number
    unclustered?: number
    outside_communities?: number
    avg_length: number | null
    min_length: number | null
    max_length: number | null
    sources: number
  }
  communities: FacetBucket[]
  sources: FacetBucket[]
  length_buckets: { label: string; from: number | null; to: number | null; count: number }[]
  timeline: { bucket: string; count: number }[]
  timeline_interval?: string
  condition_text: string
  rule_count: number
}

// ---------------------------------------------------------------------------- corpus

export interface Community {
  community_id: number
  size: number
  internal_edges: number
  boundary_edges: number
  avg_similarity: number
  density: number
  conductance: number
}

export interface CommunityDetail {
  community_id: number
  central: (DocumentRecord & { strength: number; degree: number })[]
  neighbouring_communities: { community_id: number; edges: number; avg_score: number }[]
}

export interface ClusterRun {
  version: number
  community_count: number
  modularity: number
  gamma: number
  random_seed: number
  neighbor_k: number
  min_similarity: number
  node_count: number
  relationship_count: number
  total_ms: number
  ran_at?: string
  /** Leiden's groups before the minimum size was applied (singletons included). */
  raw_community_count?: number
  /** Documents clustered into a group smaller than `min_community_size`. */
  outside_documents?: number
  min_community_size?: number
}

export interface StoreStats {
  elasticsearch: { documents: number; unassigned: number; store_bytes: number | null }
  qdrant: { points: number; indexed_vectors: number | null; segments: number; status: string; quantization: boolean }
  neo4j: { nodes: number; edges: number; communities: number; isolated_nodes: number; mean_degree: number }
}

export interface Stats {
  documents: number
  nodes: number
  edges: number
  communities: number
  /** Documents in no community (both reasons below). */
  unassigned: number
  /** Added or changed since the last clustering run. */
  unclustered?: number
  /** Clustered, but into a group smaller than a community. */
  outside_communities?: number
  min_community_size?: number
  isolated_nodes: number
  mean_degree: number
  embedding_model: string
  neighbor_k: number
  min_similarity: number
  leiden_gamma: number
  stores: StoreStats
  consistent: boolean
  last_cluster_run: ClusterRun | null
  jobs_active: boolean
}

export interface PublicConfig {
  embedding_model: string
  embedding_dimension: number
  policy: { neighbor_k: number; min_similarity: number }
  leiden_gamma: number
  leiden_random_seed: number
  leiden_min_community_size?: number
  limits: {
    upload_max_bytes: number
    upload_max_rows: number
    text_max_chars: number
    metadata_max_keys?: number
    batch_max_documents: number
    search_prefilter_limit: number
  }
  auth_required: boolean
}

export interface DocumentRecord {
  id: string
  external_id: string
  text: string
  community_id?: number | null
  community_version?: number | null
  source?: string | null
  length?: number
  metadata?: Record<string, string> | null
  created_at?: string
  updated_at?: string
  score?: number
}

export interface DataSource {
  source: string | null
  documents: number
  unassigned: number
  unclustered?: number
  outside_communities?: number
  first_created: string | null
  last_updated: string | null
}

// ---------------------------------------------------------------------------- graph

export interface GraphNode {
  id: string
  text: string
  external_id?: string | null
  community_id: number | null
}

export interface GraphLink {
  source: string
  target: string
  score: number
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

export interface GraphQueryRequest {
  query: string
  mode: SearchMode
  condition_tree: QueryNode | null
  limit: number
  expand: boolean
  neighbor_limit: number
  min_score: number
  max_score: number
}

export interface GraphQueryResult extends GraphData {
  seeds: { id: string; rank: number; score: number | null }[]
  matched: number
  condition_text: string
  warnings?: string[]
}

// ---------------------------------------------------------------------------- jobs

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobKind = 'import' | 'rebuild' | 'cluster' | 'reconcile' | 'delete'

export interface Job {
  id: string
  kind: JobKind
  status: JobStatus
  phase: string
  processed: number
  total: number | null
  message?: string | null
  params: Record<string, unknown>
  result?: Record<string, unknown> | null
  error?: string | null
  created_at: string
  started_at?: string | null
  finished_at?: string | null
}

export interface ImportResult {
  rows: number
  received: number
  created: number
  updated: number
  unchanged: number
  failed: number
  /** Rows whose text was cut to TEXT_MAX_CHARS (truncate option). */
  truncated?: number
  /** How the file was read (after any encoding fallback) and which columns were used. */
  format?: { encoding: string; delimiter: string; has_header: boolean; text_column: string; id_column: string | null }
  edges_upserted: number
  /** The first 200 per-row errors; `failed` counts all of them. */
  errors: { row?: number | null; external_id?: string | null; reason: string }[]
  clustering?: ClusterRun & { qdrant_payloads_updated: number }
  ingest_ms?: number
  total_ms?: number
}

export interface UploadOptions {
  runCluster: boolean
  rebuild: boolean
  source?: string
  /** The column to analyse; the server default is a column named `text`. */
  textColumn?: string
  /** Omitted: a column named `id`, else ids generated from the text. */
  idColumn?: string
  metadataColumns?: string[]
  generateIds?: boolean
  /** One character; omitted: detected. */
  delimiter?: string
  /** A codec name (utf-8, windows-1252 ...); omitted: detected, with a fallback. */
  encoding?: string
  /** false: the first row is data; columns are column_1 … column_n. */
  hasHeader?: boolean
  /** Clustering after the import: the smallest group that counts as a community (≥ 2). */
  minCommunitySize?: number
  /** Import the first TEXT_MAX_CHARS characters of longer texts instead of skipping the row. */
  truncateLongTexts?: boolean
}
