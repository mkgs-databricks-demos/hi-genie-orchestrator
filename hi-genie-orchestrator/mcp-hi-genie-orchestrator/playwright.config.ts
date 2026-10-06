import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://localhost:${process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'VITE_STANDALONE=true npx vite --config client/vite.config.ts --host 127.0.0.1 --port 8000',
    url: `http://localhost:${process.env.DATABRICKS_APP_PORT || process.env.PORT || 8000}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
