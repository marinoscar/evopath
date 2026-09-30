import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3535',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Start local dev server if not running. The AI specs (gym-scan, workout-prefill,
  // training-plans, training-adaptation) also need the fake providers: add
  // `-f devdb.compose.yml -f fake-ai.compose.yml` (see docs/TESTING.md), or point BASE_URL at
  // a stack that already runs them. `E2E_AI=0` skips the suites that need them.
  webServer: process.env.CI ? undefined : {
    command: 'cd ../../infra/compose && docker compose -f base.compose.yml -f dev.compose.yml up',
    url: 'http://localhost:3535/api/health/live',
    reuseExistingServer: true,
    timeout: 120000,
  },
});
