// End-to-end tests against the demo build (engineering §4). `pnpm e2e` builds and serves it.
// PW_CHANNEL=msedge (or chrome) uses an installed browser instead of Playwright's Chromium.
import { defineConfig } from '@playwright/test';

const PORT = 4175;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  // Every page load generates and syncs two weeks of demo data, so keep parallelism low.
  workers: 2,
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    acceptDownloads: true,
    ...(process.env['PW_CHANNEL'] ? { channel: process.env['PW_CHANNEL'] } : {}),
  },
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env['CI'],
  },
});
