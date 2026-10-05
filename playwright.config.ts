import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'list',
  outputDir: 'test-results/e2e',
  use: {
    baseURL: 'http://127.0.0.1:5183',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'node tests/e2e/prepare-data.mjs && node apps/server/dist/index.js --data-dir .tmp/e2e-data --host 127.0.0.1 --port 3199',
      url: 'http://127.0.0.1:3199/api/health',
      timeout: 120_000,
      reuseExistingServer: false,
    },
    {
      // Run Vite directly: a pnpm wrapper exits on teardown and leaves Vite
      // running, which keeps the port busy and stalls Playwright's shutdown.
      command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5183 --strictPort',
      cwd: 'apps/web',
      url: 'http://127.0.0.1:5183',
      env: {
        CYNOSURE_API_PROXY_TARGET: 'http://127.0.0.1:3199',
        CYNOSURE_WS_PROXY_TARGET: 'ws://127.0.0.1:3199',
      },
      timeout: 120_000,
      reuseExistingServer: false,
    },
  ],
})
