/** Build-time constants. Everything deployment-specific comes from `GET /config`. */

/** nginx (and the Vite dev proxy) strip this prefix before reaching the API. */
export const API_PREFIX = '/api'

/** localStorage keys, namespaced so two apps on one origin cannot collide. */
export const STORAGE_KEYS = {
  appearance: 'semantic-leiden.appearance',
  density: 'semantic-leiden.density',
  sidebarCollapsed: 'semantic-leiden.sidebar.collapsed',
  recentSearches: 'semantic-leiden.search.recent',
  savedSearches: 'semantic-leiden.saved-searches',
  searchTuning: 'semantic-leiden.search.tuning.v2',
  apiKey: 'semantic-leiden.api-key',
} as const

/** Operator consoles of the stack, linked from the header. Local-compose defaults. */
export const CONSOLES = [
  { key: 'api', label: 'API docs (Swagger)', href: 'http://localhost:8000/docs' },
  { key: 'qdrant', label: 'Qdrant dashboard', href: 'http://localhost:6333/dashboard' },
  { key: 'neo4j', label: 'Neo4j Browser', href: 'http://localhost:7474' },
  { key: 'es', label: 'Elasticsearch (JSON)', href: 'http://localhost:9200' },
] as const
