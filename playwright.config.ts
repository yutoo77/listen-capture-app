import { defineConfig } from '@playwright/test';

export default defineConfig({
  // CI diff capture fetches the PR base at depth 1, truncating history needed
  // by the rollback ancestry guard. Preserve commit metadata without that fetch.
  captureGitInfo: { commit: true, diff: false },
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.LC_BASE_URL || 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: { args: process.env.LC_E2E_REAL_MIC === '1'
      ? ['--use-fake-ui-for-media-stream']
      : ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
