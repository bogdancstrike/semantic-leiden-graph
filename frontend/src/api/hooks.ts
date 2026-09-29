import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api } from './client'
import type { ExploreRequest, Job, SearchRequest } from './types'

export const keys = {
  stats: ['stats'] as const,
  config: ['config'] as const,
  ready: ['ready'] as const,
  communities: ['communities'] as const,
  community: (id: number) => ['community', id] as const,
  runs: ['cluster-runs'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['job', id] as const,
  sources: ['sources'] as const,
  fields: ['explore-fields'] as const,
  explore: (req: ExploreRequest) => ['explore', req] as const,
  insights: (req: ExploreRequest) => ['insights', req] as const,
  document: (id: string) => ['document', id] as const,
  similar: (id: string, method: string) => ['similar', id, method] as const,
  graph: (params: object) => ['graph', params] as const,
  search: (req: SearchRequest | null) => ['search', req] as const,
}

export const FINISHED: Job['status'][] = ['succeeded', 'failed', 'cancelled']
// Jobs whose completion already refreshed the corpus; remounting a finished job's
// progress view must not trigger another full invalidation.
const refreshedJobs = new Set<string>()

export const useConfig = () => useQuery({ queryKey: keys.config, queryFn: ({ signal }) => api.config(signal), staleTime: 5 * 60_000 })

export const useStats = () =>
  useQuery({
    queryKey: keys.stats,
    queryFn: ({ signal }) => api.stats(signal),
    staleTime: 10_000,
    refetchInterval: (q) => (q.state.data?.jobs_active ? 3_000 : 30_000),
  })

export const useReady = () =>
  useQuery({ queryKey: keys.ready, queryFn: ({ signal }) => api.ready(signal), refetchInterval: 20_000, retry: false })

export const useCommunities = () =>
  useQuery({ queryKey: keys.communities, queryFn: ({ signal }) => api.communities(signal), staleTime: 30_000 })

export const useCommunity = (id: number | null) =>
  useQuery({
    queryKey: keys.community(id ?? -1),
    queryFn: ({ signal }) => api.community(id!, signal),
    enabled: id !== null,
    staleTime: 60_000,
  })

export const useClusterRuns = () => useQuery({ queryKey: keys.runs, queryFn: ({ signal }) => api.clusterRuns(signal) })

export const useSources = () => useQuery({ queryKey: keys.sources, queryFn: ({ signal }) => api.sources(signal), staleTime: 15_000 })

/** The query-builder catalogue: fields, operators and the values each can take. */
export const useExploreFields = () =>
  useQuery({ queryKey: keys.fields, queryFn: ({ signal }) => api.exploreFields(signal), staleTime: 60_000 })

export const useJobs = () =>
  useQuery({
    queryKey: keys.jobs,
    queryFn: ({ signal }) => api.jobs(signal),
    refetchInterval: (q) => (q.state.data?.some((j) => !FINISHED.includes(j.status)) ? 1_500 : 15_000),
  })

/** The job still queued or running, if any — jobs run one at a time. */
export function useActiveJob(): Job | undefined {
  const { data } = useJobs()
  return data?.find((job) => !FINISHED.includes(job.status))
}

/** Polls one job until it finishes, then refreshes everything the job may have changed. */
export function useJob(id: string | null) {
  const client = useQueryClient()
  return useQuery({
    queryKey: keys.job(id ?? ''),
    enabled: !!id,
    queryFn: async ({ signal }) => {
      const job = await api.job(id!, signal)
      if (FINISHED.includes(job.status) && !refreshedJobs.has(job.id)) {
        refreshedJobs.add(job.id)
        void invalidateCorpus(client)
      }
      return job
    },
    refetchInterval: (q) => (q.state.data && FINISHED.includes(q.state.data.status) ? false : 800),
  })
}

export function invalidateCorpus(client: QueryClient) {
  return Promise.all(
    [
      'stats',
      'config',
      'communities',
      'community',
      'cluster-runs',
      'jobs',
      'sources',
      'explore-fields',
      'explore',
      'insights',
      'graph',
      'search',
      'similar',
      'document',
    ].map((key) => client.invalidateQueries({ queryKey: [key] })),
  )
}

export const useSearch = (request: SearchRequest | null) =>
  useQuery({
    queryKey: keys.search(request),
    queryFn: ({ signal }) => api.search(request!, signal),
    enabled: !!request && request.query.trim().length > 0,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })

export const useExplore = (request: ExploreRequest | null) =>
  useQuery({
    queryKey: keys.explore(request ?? {}),
    queryFn: ({ signal }) => api.explore(request!, signal),
    enabled: !!request,
    placeholderData: keepPreviousData,
    retry: false,
  })

export const useInsights = (request: ExploreRequest | null) =>
  useQuery({
    queryKey: keys.insights(request ?? {}),
    queryFn: ({ signal }) => api.insights(request!, signal),
    enabled: !!request,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })

export const useDocument = (id: string | null) =>
  useQuery({ queryKey: keys.document(id ?? ''), queryFn: ({ signal }) => api.document(id!, signal), enabled: !!id })

export const useSimilar = (id: string | null, method: 'semantic' | 'keyword' | 'graph') =>
  useQuery({
    queryKey: keys.similar(id ?? '', method),
    queryFn: ({ signal }) => api.similar(id!, method, 8, signal),
    enabled: !!id,
    staleTime: 60_000,
  })

export function useDeleteDocument() {
  const client = useQueryClient()
  return useMutation({ mutationFn: api.deleteDocument, onSuccess: () => invalidateCorpus(client) })
}
