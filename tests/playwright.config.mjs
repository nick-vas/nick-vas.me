import { defineConfig, devices } from '@playwright/test';

// Tests run against the production build in ../public (hugo --minify --baseURL http://localhost:4173/).
// Software WebGL in CI can be missing in some browsers; the site then removes the canvas and the
// tests treat that as a valid fallback rather than a failure.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  webServer: {
    command: 'npm run serve',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: {} } },
    { name: 'webkit', use: { ...devices['Desktop Safari'], launchOptions: {} } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'], launchOptions: {} } },
  ],
});
