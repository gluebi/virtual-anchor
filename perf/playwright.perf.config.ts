import { defineConfig, devices } from '@playwright/test'

/**
 * Standalone config for the scroll benchmark. **Not part of `pnpm test:e2e`, deliberately.**
 *
 * This repo has already settled the question of whether timing belongs in CI, twice in writing:
 * commit `af282b8` ("stop asserting the speed of the machine") and `ios-momentum.spec.ts:465` —
 * "a CI runner under load produces gaps a developer's laptop never will, and a threshold here
 * would fail for the wrong reason." CI runs two-core shared runners inside a container with
 * `fullyParallel: true`. Numbers from there would be noise wearing a number's clothing.
 *
 * So this is a local instrument, run on demand, on a machine whose state the person running it
 * can see. `spike/playwright.spike.config.ts` is the precedent for a second config that the main
 * suite does not know about.
 */
export default defineConfig({
  testDir: '.',
  reporter: 'list',
  // A benchmark that retries reports the run that happened to go well, which is the opposite of
  // what it is for.
  retries: 0,
  // The two settings that make the numbers mean anything. Parallel workers competing for cores is
  // precisely what `af282b8` reproduced by oversubscribing them.
  workers: 1,
  fullyParallel: false,
  // Five repetitions of a multi-second gesture, plus a page load, per test.
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:4180',
    // Headed, because the question is about frame pacing and headless frame pacing is synthetic.
    headless: false,
    // So the touch fling is dispatched as touch rather than silently downgraded. It does not make
    // `isIOSWebKit()` true — the UA is still Chrome — which is stated in `drive.ts`'s header.
    hasTouch: true,
    launchOptions: {
      args: [
        // Chromium throttles rAF in an occluded or backgrounded window to about 1 Hz. Without
        // these, a window that drifts behind another app reports a catastrophic FPS that is a
        // fact about window management and not about this library. `scroll-fps.spec.ts` also
        // *checks* for it rather than trusting the flags, because a flag that stops working
        // silently is worse than no flag.
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // The demo's own `preview` script hardcodes 4173, which is the e2e suite's port and — after a
    // `pnpm test:e2e` — is serving the *instrumented* build. Serving on a port of our own is what
    // stops a benchmark silently measuring `build:trace`.
    command: 'pnpm --filter demo exec vite preview --port 4180 --strictPort',
    url: 'http://localhost:4180',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
