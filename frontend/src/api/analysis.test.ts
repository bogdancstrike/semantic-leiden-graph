import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './client'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => fetchMock.mockReset())

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('community analysis requests', () => {
  it('sends top-k and time window to the authenticated job endpoint', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => 'app-key' })
    respond({ id: 'job-1', params: { analysis_id: 'report-1' } }, 202)
    const result = await api.analyze({ top_k: 7, lookback_hours: 24, max_communities: 20 })
    expect(result.id).toBe('job-1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/jobs/analyze')
    expect(init.method).toBe('POST')
    expect(init.headers['X-API-Key']).toBe('app-key')
    expect(JSON.parse(init.body)).toEqual({ top_k: 7, lookback_hours: 24, max_communities: 20 })
  })

  it('paginates history and safely encodes report ids', async () => {
    respond({ runs: [], total: 40 })
    await api.analysisRuns(20)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/analysis/runs?limit=20&offset=20')
    respond({ id: 'report/one' })
    await api.analysisRun('report/one')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/analysis/runs/report%2Fone')
  })

  it('preserves actionable provider configuration errors', async () => {
    respond({ detail: 'Set GEMINI_API_KEY to enable analysis.', code: 'dependency_unavailable' }, 503)
    await expect(api.analyze({})).rejects.toMatchObject({ status: 503, message: 'Set GEMINI_API_KEY to enable analysis.' })
  })

  it('fetches provider and schedule configuration', async () => {
    respond({ provider: 'gemini', model: 'gemini-flash-latest', configured: true, schedule: { enabled: true, interval_hours: 24 } })
    expect((await api.analysisConfig()).provider).toBe('gemini')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/analysis/config')
  })
})
