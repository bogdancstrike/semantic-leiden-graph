/**
 * Accessibility audit: axe-core (WCAG 2.1 A/AA) over every page and the drawers,
 * menus and dialogs they open, in the light and the dark theme.
 *
 *   npx playwright install chromium        # once
 *   npm run dev                            # or point BASE at a running UI
 *   npm run audit:a11y                     # BASE=http://localhost:3000 npm run audit:a11y
 *
 * Exits non-zero when any violation is found, so it can gate a CI job.
 */

import { chromium } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const BASE = process.env.BASE ?? 'http://localhost:5173'
const TAGS = (process.env.TAGS ?? 'wcag2a,wcag2aa,wcag21a,wcag21aa').split(',')

// [name, route, steps]; a step is ['text', label] | ['click', selector] | ['wait', ms]
const CASES = [
  ['dashboard', '/', []],
  ['explore', '/documents', []],
  ['explore ranked', '/documents?q=railway&mode=hybrid', []],
  ['explore list', '/documents?q=railway&mode=hybrid&view=list', []],
  ['explore advanced drawer', '/documents', [['text', 'Advanced'], ['wait', 1800]]],
  ['explore ranking drawer', '/documents?q=rail&mode=hybrid', [['text', 'Ranking'], ['wait', 800]]],
  ['document drawer', '/documents', [['click', '.ant-table-row'], ['wait', 1500]]],
  ['graph', '/graph', [['wait', 1500]]],
  ['graph search results', '/graph?view=query&q=vaccine&expand=1', [['wait', 2000]]],
  ['graph highlight drawer', '/graph', [['text', 'Highlight'], ['wait', 1800]]],
  ['communities', '/communities', []],
  ['communities topic', '/communities?q=ransomware', [['wait', 1500]]],
  ['community expanded', '/communities', [['click', '.ant-table-row'], ['wait', 1500]]],
  ['import', '/import', []],
  ['operations', '/operations', []],
  ['settings menu', '/', [['click', 'button[aria-label^="Settings"]'], ['wait', 600]]],
  ['api key dialog', '/', [['click', 'button[aria-label^="Settings"]'], ['wait', 500], ['text', 'API key…'], ['wait', 600]]],
]

const browser = await chromium.launch()
let failures = 0
for (const theme of ['light', 'dark']) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript((t) => localStorage.setItem('semantic-leiden.appearance', t), theme)
  for (const [name, route, steps] of CASES) {
    const page = await context.newPage()
    await page.goto(BASE + route)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(1200)
    for (const [kind, arg] of steps) {
      if (kind === 'text') await page.getByText(arg, { exact: true }).first().click({ timeout: 5000 })
      if (kind === 'click') await page.locator(arg).first().click({ timeout: 5000 })
      if (kind === 'wait') await page.waitForTimeout(arg)
    }
    // The canvas is described by its aria-label; its pixels are not DOM content.
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).exclude('canvas').analyze()
    failures += violations.length
    console.log(`${violations.length ? '✗' : '✓'} ${theme.padEnd(5)} ${name}`)
    for (const v of violations) {
      console.log(`    [${v.impact}] ${v.id}: ${v.help}`)
      for (const node of v.nodes.slice(0, 3)) console.log(`      ${node.target.join(' ')}`)
    }
    await page.close()
  }
  await context.close()
}
await browser.close()
console.log(failures ? `\n${failures} violation type(s) found` : '\nNo accessibility violations found')
process.exit(failures ? 1 : 0)
