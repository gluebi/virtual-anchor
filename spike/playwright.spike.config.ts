import { defineConfig, devices } from '@playwright/test'

/**
 * Standalone config for the residual-carry risk gate: it loads a static file
 * directly, so it needs no dev server and must not inherit the main config's.
 */
export default defineConfig({
  testDir: '.',
  reporter: 'list',
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
})
