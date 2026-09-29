import { API_PREFIX, STORAGE_KEYS } from '@/config'
import type {
  ClusterRun,
  Community,
  CommunityDetail,
  DataSource,
  DocumentRecord,
  ExploreCatalogue,
  ExploreInsights,
  ExploreRequest,
  ExploreResult,
  GraphData,
  GraphQueryRequest,
  GraphQueryResult,
  Job,
  PublicConfig,
  SearchRequest,
  SearchResponse,
  Stats,
  UploadOptions,
} from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly details?: unknown

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const apiKeyStore = {
  get: (): string | null => {
    try {
      return sessionStorage.getItem(STORAGE_KEYS.apiKey)
    } catch {
      return null
    }
  },
  set: (value: string | null) => {
    try {
      if (value) sessionStorage.setItem(STORAGE_KEYS.apiKey, value)
      else sessionStorage.removeItem(STORAGE_KEYS.apiKey)
    } catch {
      // storage can be disabled (private mode); the key then lives only for this call
    }
  },
}

function authHeaders(): Record<string, string> {
  const key = apiKeyStore.get()
  return key ? { 'X-API-Key': key } : {}
}

async function toApiError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`
  let code: string | undefined
  let details: unknown
  try {
    const body = await response.json()
    message = typeof body.detail === 'string' ? body.detail : message
    code = body.code
    details = body.details
  } catch {
    // non-JSON error body (proxy error page)
  }
  if (response.status === 401) message = 'This action needs an API key. Add it with the key button in the header.'
  if (response.status === 502 || response.status === 504) message = 'The API is not reachable. Check that the app container is running.'
  return new ApiError(message, response.status, code, details)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body && !(init.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  })
  if (!response.ok) throw await toApiError(response)
  return (await response.json()) as T
}

const post = <T>(path: string, body?: unknown, signal?: AbortSignal) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), signal })

function qs(params: Record<string, string | number | boolean | undefined | null | (string | number)[]>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((v) => search.append(key, String(v)))
    else search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export const api = {
  ready: (signal?: AbortSignal) =>
    fetch(`${API_PREFIX}/ready`, { signal }).then(async (r) => ({
      ok: r.ok,
      ...((await r.json().catch(() => ({}))) as { status?: string; checks?: Record<string, boolean> }),
    })),
  config: (signal?: AbortSignal) => request<PublicConfig>('/config', { signal }),
  stats: (signal?: AbortSignal) => request<Stats>('/stats', { signal }),

  search: (body: SearchRequest, signal?: AbortSignal) => post<SearchResponse>('/search', body, signal),

  exploreFields: (signal?: AbortSignal) => request<ExploreCatalogue>('/explore/fields', { signal }),
  explore: (body: ExploreRequest, signal?: AbortSignal) => post<ExploreResult>('/explore/query', body, signal),
  insights: (body: ExploreRequest, signal?: AbortSignal) => post<ExploreInsights>('/explore/insights', body, signal),

  document: (id: string, signal?: AbortSignal) => request<DocumentRecord>(`/documents/${encodeURIComponent(id)}`, { signal }),
  similar: (id: string, method: 'semantic' | 'keyword' | 'graph', limit = 8, signal?: AbortSignal) =>
    request<{ method: string; results: DocumentRecord[] }>(
      `/documents/${encodeURIComponent(id)}/similar${qs({ method, limit })}`,
      { signal },
    ),
  deleteDocument: (id: string) => request<{ deleted: boolean }>(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  ingest: (text: string, id?: string) =>
    post<{ id: string; created: number; updated: number; unchanged: number; edges_upserted: number }>('/documents', {
      text,
      id: id || undefined,
    }),

  sources: (signal?: AbortSignal) => request<{ sources: DataSource[]; total: number }>('/sources', { signal }),

  graph: (params: { limit: number; minScore: number; maxScore: number; communityIds?: number[] }, signal?: AbortSignal) =>
    request<GraphData>(
      `/graph${qs({ limit: params.limit, min_score: params.minScore, max_score: params.maxScore, community_id: params.communityIds })}`,
      { signal },
    ),
  egoGraph: (id: string, params: { hops: number; nodeLimit: number; minScore: number; maxScore: number }, signal?: AbortSignal) =>
    request<GraphData>(
      `/graph/ego/${encodeURIComponent(id)}${qs({ hops: params.hops, node_limit: params.nodeLimit, min_score: params.minScore, max_score: params.maxScore })}`,
      { signal },
    ),
  graphQuery: (body: GraphQueryRequest, signal?: AbortSignal) => post<GraphQueryResult>('/graph/query', body, signal),

  communities: async (signal?: AbortSignal) => (await request<{ communities: Community[] }>('/communities', { signal })).communities,
  community: (id: number, signal?: AbortSignal) => request<CommunityDetail>(`/communities/${id}?limit=8`, { signal }),
  clusterRuns: async (signal?: AbortSignal) => (await request<{ runs: ClusterRun[] }>('/cluster/runs?limit=50', { signal })).runs,

  jobs: (signal?: AbortSignal) => request<Job[]>('/jobs', { signal }),
  job: (id: string, signal?: AbortSignal) => request<Job>(`/jobs/${id}`, { signal }),
  cancelJob: (id: string) => request<Job>(`/jobs/${id}`, { method: 'DELETE' }),
  clusterJob: (body: { gamma?: number; random_seed?: number; min_community_size?: number }) => post<Job>('/jobs/cluster', body),
  rebuildJob: (body: { neighbor_k?: number; min_similarity?: number; cluster: boolean }) => post<Job>('/jobs/rebuild', body),
  reconcileJob: () => post<Job>('/jobs/reconcile'),
  deleteSourceJob: (body: { source: string | null; cluster: boolean }) => post<Job>('/jobs/delete-source', body),
}

/**
 * Multipart upload through XMLHttpRequest: fetch() still cannot report *upload*
 * progress in browsers, and a 1 GB CSV on a slow link needs a progress bar.
 */
export function uploadCsv(
  file: File,
  options: UploadOptions,
  onProgress: (percent: number) => void,
): { promise: Promise<Job>; abort: () => void } {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Job>((resolve, reject) => {
    const form = new FormData()
    form.append('file', file)
    form.append('run_cluster', String(options.runCluster))
    form.append('rebuild', String(options.rebuild))
    if (options.source) form.append('source', options.source)
    if (options.generateIds) form.append('generate_ids', 'true')
    else if (options.idColumn) form.append('id_column', options.idColumn)
    if (options.textColumn) form.append('text_column', options.textColumn)
    if (options.metadataColumns) form.append('metadata_columns', JSON.stringify(options.metadataColumns))
    if (options.truncateLongTexts) form.append('truncate_long_texts', 'true')
    if (options.delimiter) form.append('delimiter', options.delimiter)
    if (options.encoding) form.append('encoding', options.encoding)
    if (options.hasHeader === false) form.append('has_header', 'false')
    if (options.runCluster && options.minCommunitySize) form.append('min_community_size', String(options.minCommunitySize))

    xhr.open('POST', `${API_PREFIX}/documents/upload`)
    Object.entries(authHeaders()).forEach(([k, v]) => xhr.setRequestHeader(k, v))
    xhr.responseType = 'json'
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    xhr.onload = () => {
      const body = xhr.response ?? {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as Job)
      else if (xhr.status === 401) reject(new ApiError('Uploading needs an API key. Add it with the key button in the header.', 401))
      else if (xhr.status === 413) reject(new ApiError(body.detail ?? 'The file is larger than the upload limit.', 413))
      else reject(new ApiError(body.detail ?? `Upload failed (${xhr.status})`, xhr.status, body.code, body.details))
    }
    xhr.onerror = () => reject(new ApiError('Network error while uploading. Check your connection and retry.', 0))
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0, 'aborted'))
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}
