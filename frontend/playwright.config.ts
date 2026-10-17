import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  use: { baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:5178', trace: 'retain-on-failure' },
  webServer: process.env.BASE_URL ? undefined : { command: 'npm run dev -- --host 127.0.0.1 --port 5178 --strictPort', url: 'http://127.0.0.1:5178', reuseExistingServer: false },
})
