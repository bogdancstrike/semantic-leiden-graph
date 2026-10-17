import { expect, test, type Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

export const report = {
  id: 'report-1', job_id: 'job-1', created_at: '2026-10-17T12:00:00Z', status: 'succeeded', trigger: 'manual',
  provider: 'gemini', model: 'gemini-flash-latest', top_k: 3, max_communities: 100,
  window_start: '2026-10-16T12:00:00Z', window_end: '2026-10-17T12:00:00Z', community_version: 4,
  eligible_documents: 3, unassigned_documents: 0,
  communities: [{ community_id: 0, document_count: 3, status: 'succeeded',
    documents: [{ id: 'doc-1', external_id: 'rail-1', text: 'Railway stations receive funding.', truncated: false, strength: 1.2 }],
    graph: { nodes: [{ id: 'doc-1', external_id: 'rail-1', text: 'Railway funding', community_id: 0 }], links: [] },
    token_budget: { context_tokens: 10000, input_tokens: 200, input_budget: 5000, output_reserve: 4000, safety_margin: 1000 },
    analysis: { title: 'Railway investment', summary: 'Railway stations receive funding.', key_findings: ['Station upgrades'], narratives: ['Investment improves railway access'], sentiment: 'positive', sentiment_reasoning: 'Reporting emphasizes improved access', classifications: ['transport'], entities: [{ name: 'Rail Agency', label: 'ORG', evidence_ids: ['doc-1'] }], uncertainties: ['Limited sample'], evidence_ids: ['doc-1'] },
  }],
}
const job = { id: 'job-1', kind: 'analysis', status: 'succeeded', phase: 'done', processed: 1, total: 1, created_at: report.created_at, params: { analysis_id: report.id }, result: { analysis_id: report.id } }

export async function mockApi(page: Page, configured = true) {
  let started = false
  let deleted = false
  let submitted: unknown
  await page.route('**/api/**', async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue()
    const path = new URL(route.request().url()).pathname.replace('/api', '')
    let body: unknown = {}
    if (path === '/config') body = { policy: { neighbor_k: 12, min_similarity: 0.58 }, limits: { text_max_chars: 20000, metadata_max_keys: 20, upload_max_bytes: 1073741824 }, embedding_model: 'test', embedding_dimension: 384 }
    if (path === '/explore/fields') body = { fields: [], operators: [], metadata_keys: [] }
    if (path === '/ready') body = { status: 'ready', checks: { elasticsearch: true, qdrant: true, neo4j: true } }
    if (path === '/stats') body = { documents: 3, communities: 1, edges: 2, unassigned: 0, consistent: true, stores: {}, jobs_active: false }
    if (path === '/communities') body = { communities: [{ community_id: 0, size: 3, internal_edges: 2, boundary_edges: 0, avg_similarity: 0.8, density: 0.6, conductance: 0 }] }
    if (path === '/analysis/config') body = { provider: 'gemini', model: 'gemini-flash-latest', configured, top_k: 5, max_communities: 100, document_chars: 4000, schedule: { enabled: configured, interval_hours: 24, lookback_hours: 24, next_run_at: '2026-10-18T12:00:00Z' } }
    if (path === '/analysis/runs') body = { runs: started ? [report] : [], total: started ? 1 : 0 }
    if (path === '/jobs') body = []
    if (path === '/analysis/topics') body = { stats: { analyzed: deleted ? 0 : 1, entities: 1, narratives: 1, trending: 0 }, total: deleted ? 0 : 1, topics: deleted ? [] : [{ ...report.communities[0], id: 'report-1:0', run_id: 'report-1', created_at: report.created_at, provider: 'gemini', model: 'gemini-flash-latest', selected_documents: 1, community_version: 4 }] }
    if (path === '/analysis/topics/report-1:0' || path === '/analysis/topics/report-1%3A0') body = { id: 'report-1:0', run: { ...report, instructions: 'Analyze only supplied evidence.' }, community: report.communities[0] }
    if (route.request().method() === 'DELETE' && path.startsWith('/analysis/topics/')) { deleted = true; body = { deleted: true } }
    if (path.endsWith('/documents') && path.startsWith('/analysis/topics/')) body = { total: 2, membership_available: true, documents: [{ id: 'doc-1', external_id: 'rail-1', text: 'Railway stations receive funding.' }, { id: 'doc-2', external_id: 'rail-2', text: 'Station investment.' }] }
    if (path === '/documents/doc-1') body = { id: 'doc-1', external_id: 'rail-1', text: 'Railway stations receive funding.', community_id: 0 }
    if (path.startsWith('/documents/doc-1/similar')) body = { results: [] }

    if (path === '/jobs/job-1') body = job
    if (path === '/analysis/runs/report-1') body = report
    if (path === '/graph') body = { nodes: [{ id: 'doc-1', external_id: 'rail-1', text: 'Railway funding', community_id: 0 }, { id: 'doc-2', external_id: 'rail-2', text: 'Station investment', community_id: 0 }], links: [{ source: 'doc-1', target: 'doc-2', score: 0.9 }] }
    if (path === '/jobs/analyze') { submitted = route.request().postDataJSON(); started = true; body = job }
    await route.fulfill({ json: body, status: path === '/jobs/analyze' ? 202 : 200 })
  })
  return () => submitted
}

test('starts analysis with automatic sizing and displays persisted evidence after reload', async ({ page }) => {
  const submitted = await mockApi(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/communities')
  await expect(page.getByText('Automatic analysis every 24 hours', { exact: false })).toBeVisible()
  await expect(page.getByText('Automatic · maximum that fits the model')).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Documents per topic' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await expect(page.getByText('Railway investment', { exact: true })).toBeVisible()
  expect(submitted()).toEqual({ time_range: 'relative', lookback_hours: 24, max_communities: 100 })
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


test('supports all-time and a custom date/time period', async ({ page }) => {
  const submitted = await mockApi(page)
  await page.goto('/communities')
  await page.getByRole('combobox', { name: 'Analysis period' }).press('ArrowDown')
  await page.getByText('All time', { exact: true }).click()
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await expect.poll(() => submitted()).toEqual({ time_range: 'all', max_communities: 100 })
  await page.getByRole('combobox', { name: 'Analysis period' }).press('ArrowDown')
  await page.getByText('Custom range', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Analyze now' })).toBeDisabled()
  const start = page.getByPlaceholder('Start date and time')
  const end = page.getByPlaceholder('End date and time')
  await start.fill('2026-10-15 09:30')
  await start.press('Enter')
  await end.fill('2026-10-16 18:45')
  await end.press('Enter')
  await page.getByText('Community analysis', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Analyze now' })).toBeEnabled()
  await page.getByRole('button', { name: 'Analyze now' }).click()
  await expect.poll(() => (submitted() as { time_range: string })?.time_range).toBe('custom')
  expect(submitted()).toMatchObject({ window_start: expect.any(String), window_end: expect.any(String) })
})

test('Topics navbar opens briefing, detail, graph snapshot, LLM activity and scoped search', async ({ page }) => {
  await mockApi(page)
  await page.goto('/topics')
  await expect(page.getByRole('heading', { name: /^Topics/, level: 1 })).toBeVisible()
  await page.getByRole('link', { name: 'Railway investment', exact: true }).click()
  await expect(page).toHaveURL(/\/topics\/report-1%3A0/)
  await expect(page.getByText('Investment improves railway access')).toBeVisible()
  await page.getByRole('tab', { name: 'Graph snapshot' }).click()
  await expect(page.getByRole('img', { name: /Semantic graph with/ })).toBeVisible()
  await page.getByRole('tab', { name: 'LLM activity' }).click()
  await expect(page.getByText('Analyze only supplied evidence.')).toBeVisible()
  await page.getByRole('tab', { name: 'Search topic documents' }).click()
  const request = page.waitForRequest((r) => r.url().includes('/analysis/topics/') && r.url().includes('q=station'))
  await page.getByPlaceholder('Search this topic’s documents…').fill('station')
  await request
  await expect(page.getByRole('button', { name: 'rail-2', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'rail-1', exact: true }).click()
  await page.getByRole('button', { name: 'Related topics' }).click()
  await expect(page).toHaveURL(/\/topics\?document=doc-1/)
})

test('graph highlights a detected community and sends it to Topics analysis', async ({ page }) => {
  const submitted = await mockApi(page)
  await page.goto('/graph')
  await page.getByRole('button', { name: /^Highlight community C0:/ }).click()
  await expect(page).toHaveURL(/hl=/)
  await page.getByRole('button', { name: 'Analyze highlighted community' }).click()
  await expect(page).toHaveURL(/\/topics\?run=report-1/)
  expect(submitted()).toEqual({ community_ids: [0], time_range: 'all' })
})

test('summaries alias redirects to the integrated Topics page', async ({ page }) => {
  await mockApi(page)
  await page.goto('/summaries')
  await expect(page).toHaveURL(/\/topics$/)
  await expect(page.getByRole('heading', { name: /^Topics/, level: 1 })).toBeVisible()
})


test('CSV import toggle sends AI analysis and opens the linked Topics report', async ({ page }) => {
  await mockApi(page)
  const result = { rows: 2, created: 2, updated: 0, unchanged: 0, failed: 0, edges_upserted: 1, errors: [], total_ms: 10, analysis_job_id: 'job-1', analysis_id: 'report-1' }
  const imported = { id: 'import-1', kind: 'import', status: 'succeeded', phase: 'done', processed: 2, total: 2, params: { filename: 'news.csv', run_analysis: true }, result }
  let upload = ''
  await page.route('**/api/documents/upload', async (route) => { upload = route.request().postDataBuffer()?.toString() ?? ''; await route.fulfill({ status: 202, json: imported }) })
  await page.route('**/api/jobs/import-1', (route) => route.fulfill({ json: imported }))
  await page.goto('/import')
  await page.locator('input[type=file]').first().setInputFiles({ name: 'news.csv', mimeType: 'text/csv', buffer: Buffer.from('id,text\na,railway station funding\nb,railway station investment\n') })
  await page.getByRole('switch', { name: 'Run AI analysis after import' }).click()
  await page.getByRole('button', { name: 'Import and analyse “text”' }).click()
  await expect(page.getByRole('button', { name: 'Open imported Topics' })).toBeVisible()
  expect(upload).toMatch(/name="run_analysis"\r\n\r\ntrue/)
  await page.getByRole('button', { name: 'Open imported Topics' }).click()
  await expect(page).toHaveURL(/\/topics\?run=report-1/)
})


test('Topics supports saving, filters, named entity investigation, exports and deletion', async ({ page }) => {
  await mockApi(page)
  await page.goto('/topics')
  await page.getByRole('button', { name: 'Save topic', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Unsave topic' })).toBeVisible()
  await page.getByText('Saved', { exact: true }).click()
  await page.getByRole('combobox', { name: 'Analyzed during' }).press('ArrowDown')
  await page.getByText('Custom date/time period', { exact: true }).click()
  await page.getByPlaceholder('Analyzed after').fill('2026-10-15 00:00:00')
  await page.getByPlaceholder('Analyzed after').press('Enter')
  await page.getByPlaceholder('Analyzed before').fill('2026-10-18 23:00:00')
  await page.getByPlaceholder('Analyzed before').press('Enter')
  await page.getByRole('heading', { name: /^Topics/, level: 1 }).click()
  await expect.poll(() => page.url()).toContain('before=')
  await page.getByRole('link', { name: 'Railway investment', exact: true }).click()
  await page.getByRole('tab', { name: /^Named entities/ }).click()
  await expect(page.getByRole('cell', { name: 'ORG', exact: true })).toBeVisible()
  const request = page.waitForRequest((r) => r.url().includes('/documents?') && r.url().includes('q=Rail'))
  await page.getByRole('button', { name: 'Rail Agency', exact: true }).click()
  await request
  await expect(page.getByRole('tab', { name: 'Search topic documents' })).toHaveAttribute('aria-selected', 'true')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export briefing' }).click()
  expect((await download).suggestedFilename()).toMatch(/topic-report-1-C0.md/)
  await page.getByRole('button', { name: 'Delete topic', exact: true }).click()
  await page.getByRole('button', { name: 'Delete topic', exact: true }).last().click()
  await expect(page).toHaveURL(/\/topics\?view=saved/)
  await expect(page.getByRole('link', { name: 'Railway investment', exact: true })).toHaveCount(0)
})

test('graph card offers descriptive communities, arrangement, appearance and zoom controls', async ({ page }) => {
  await mockApi(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/graph')
  await expect(page.getByRole('complementary', { name: 'Detected graph communities' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Highlight community C0: Railway funding/ })).toBeVisible()
  await page.getByRole('combobox', { name: 'Graph arrangement' }).press('ArrowDown')
  await page.getByText('Grid layout', { exact: true }).click()
  await page.getByRole('button', { name: 'Auto-arrange', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click()
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click()
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByRole('switch', { name: 'Document labels' }).click()
  await page.getByRole('switch', { name: 'Community boundaries' }).click()
  await page.getByRole('button', { name: 'Reset layout' }).click()
  expect(errors).toEqual([])
})


test('topic snapshot searches node text, toggles selection and opens a node context menu', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await mockApi(page)
  await page.goto('/topics/report-1%3A0')
  await page.getByRole('tab', { name: 'Graph snapshot' }).click()
  await page.getByRole('searchbox', { name: 'Search snapshot node text' }).fill('funding')
  await expect(page.getByText('1 matching nodes', { exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Find a topic graph document' }).press('ArrowDown')
  await page.getByText('rail-1 · Railway funding', { exact: true }).click()
  await expect(page.getByText('Selected node: rail-1', { exact: true })).toBeVisible()
  const canvas = page.getByRole('img', { name: /Semantic graph with/ })
  const bounds = await canvas.boundingBox()
  const center = { x: bounds!.width / 2, y: bounds!.height / 2 }
  await canvas.click({ position: center })
  await expect(page.getByText('Selected node: rail-1', { exact: true })).toHaveCount(0)
  await canvas.click({ position: center })
  await expect(page.getByText('Selected node: rail-1', { exact: true })).toBeVisible()
  await canvas.press('Escape')
  await expect(page.getByText('Selected node: rail-1', { exact: true })).toHaveCount(0)
  await canvas.click({ position: center, button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Show node details', exact: true })).toBeVisible()
  await page.getByRole('menuitem', { name: 'Show node details', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Related topics' })).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Node actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Unselect node', exact: true }).click()
  await expect(page.getByText('Selected node: rail-1', { exact: true })).toHaveCount(0)
  await page.getByRole('searchbox', { name: 'Search snapshot node text' }).fill('no such content')
  await expect(page.getByText('0 matching nodes', { exact: true })).toBeVisible()
})
