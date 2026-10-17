import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const report = {
  id: 'report-1', job_id: 'job-1', created_at: '2026-10-17T12:00:00Z', status: 'succeeded', trigger: 'manual',
  provider: 'gemini', model: 'gemini-flash-latest', top_k: 3, max_communities: 100,
  window_start: '2026-10-16T12:00:00Z', window_end: '2026-10-17T12:00:00Z', community_version: 4,
  eligible_documents: 3, unassigned_documents: 0,
  communities: [{ community_id: 0, document_count: 3, status: 'succeeded',
    documents: [{ id: 'doc-1', external_id: 'rail-1', text: 'Railway stations receive funding.', truncated: false, strength: 1.2 }],
    analysis: { title: 'Railway investment', summary: 'Railway stations receive funding.', key_findings: ['Station upgrades'], uncertainties: ['Limited sample'], evidence_ids: ['doc-1'] },
  }],
}
const job = { id: 'job-1', kind: 'analysis', status: 'succeeded', phase: 'done', processed: 1, total: 1, created_at: report.created_at, params: { analysis_id: report.id }, result: { analysis_id: report.id } }

async function mockApi(page: Page, configured = true) {
  let started = false
  let submitted: unknown
  await page.route('**/api/**', async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    const path = new URL(route.request().url()).pathname.replace('/api', '')
    let body: unknown = {}
    if (path === '/ready') body = { status: 'ready', checks: { elasticsearch: true, qdrant: true, neo4j: true } }
    if (path === '/stats') body = { documents: 3, communities: 1, edges: 2, unassigned: 0, consistent: true, stores: {}, jobs_active: false }
    if (path === '/communities') body = { communities: [] }
    if (path === '/analysis/config') body = { provider: 'gemini', model: 'gemini-flash-latest', configured, top_k: 5, max_communities: 100, document_chars: 4000, schedule: { enabled: configured, interval_hours: 24, lookback_hours: 24, next_run_at: '2026-10-18T12:00:00Z' } }
    if (path === '/analysis/runs') body = { runs: started ? [report] : [], total: started ? 1 : 0 }
    if (path === '/jobs') body = []
    if (path === '/jobs/job-1') body = job
    if (path === '/analysis/runs/report-1') body = report
    if (path === '/jobs/analyze') { submitted = route.request().postDataJSON(); started = true; body = job }
    await route.fulfill({ json: body, status: path === '/jobs/analyze' ? 202 : 200 })
  })
  return () => submitted
}

test('starts analysis with chosen top-k and displays persisted evidence after reload', async ({ page }) => {
  const submitted = await mockApi(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/communities')
  await expect(page.getByText('Automatic analysis every 24 hours', { exact: false })).toBeVisible()
  await page.getByRole('spinbutton', { name: 'Documents per topic' }).fill('3')
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await expect(page.getByText('Railway investment', { exact: true })).toBeVisible()
  expect(submitted()).toEqual({ top_k: 3, lookback_hours: 24, max_communities: 100 })
  await page.getByText('Railway investment', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'rail-1' })).toBeVisible()
  await expect(page.getByText('Station upgrades', { exact: true })).toBeVisible()
  await expect(page.getByText('Limited sample', { exact: true })).toBeVisible()
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations).toEqual([])
  await page.reload()
  await expect(page.getByText('Railway investment', { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

test('disables analysis and explains missing provider configuration', async ({ page }) => {
  await mockApi(page, false)
  await page.goto('/communities')
  await expect(page.getByRole('button', { name: 'Analyze now' })).toBeDisabled()
  await expect(page.getByText('Set GEMINI_API_KEY on the server to enable analysis.')).toBeVisible()
})

test('shows provider errors when starting a run fails', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/jobs/analyze', (route) => route.fulfill({ status: 503, json: { detail: 'Provider quota exhausted', code: 'dependency_unavailable' } }))
  await page.goto('/communities')
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await expect(page.getByText('Provider quota exhausted')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Analyze now' })).toBeEnabled()
})

test('keeps controls and expanded evidence accessible on a dark mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => localStorage.setItem('semantic-leiden.appearance', 'dark'))
  await mockApi(page)
  await page.goto('/communities')
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await page.getByText('Railway investment', { exact: true }).click()
  await expect(page.getByText('Documents sent for analysis')).toBeVisible()
  const controls = page.getByRole('button', { name: 'Analyze now' })
  const bounds = await controls.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
  expect(violations).toEqual([])
})
