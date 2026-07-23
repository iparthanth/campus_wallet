import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  // Money flows must not race each other through one shared database.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Use the Chrome already installed on this machine instead of downloading
        // Playwright's bundled browsers (~400 MB). CI installs its own.
        channel: process.env.CI ? undefined : 'chrome',
      },
    },
  ],

  // Playwright starts the frontend; the API must already be running (npm start in api/).
  webServer: {
    command: 'npm run dev',
    cwd: '../web',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
