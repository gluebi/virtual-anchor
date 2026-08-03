import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    // WebKit is not optional here: it truncates scrollTop to whole integers, so it
    // is the browser that proves the residual carry actually delivers sub-pixel
    // landing rather than merely computing a sub-pixel target.
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    // An iPhone descriptor over the same WebKit: iPhone UA, `hasTouch`, so
    // `isIOSWebKit()` is genuinely true and the momentum write gate is live. That is
    // as far as automation reaches — Playwright dispatches touch events but produces
    // no real fling, so what this project proves is that no write escapes between
    // `touchend` and `scrollend`, not that momentum survives. See
    // `e2e/ios-momentum.spec.ts`.
    {
      name: 'mobile-webkit',
      use: { ...devices['iPhone 15'] },
      // Only the momentum spec. The rest of the suite encodes desktop geometry — header
      // heights that wrap differently at 390px, scrollport sizes, how many articles fit
      // — so running it here reports twelve failures about the viewport and none about
      // the library. This project exists to make `isIOSWebKit()` true, not to be a
      // second full matrix; a mobile layout pass would be its own piece of work.
      testMatch: /ios-momentum\.spec\.ts/,
    },
  ],
  webServer: {
    command: 'pnpm --filter demo preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
