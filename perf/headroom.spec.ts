/**
 * How much slower could the machine be before scrolling stops holding the display's rate.
 *
 * **Why this exists.** `scroll-fps.spec.ts` reports 60 FPS for every scenario, which is true and
 * almost uninformative: the display is 60 Hz, so 60 is the ceiling and a list using two per cent
 * of the frame budget reports exactly the same number as one using ninety. The interesting
 * quantity is the distance to the edge, and the way to observe it is to move the edge — throttle
 * the main thread until frames start dropping.
 *
 * **What this proves and what it does not.** The factor found here is a statement about
 * main-thread work per frame, and CDP's throttling emulates a slower processor and nothing else:
 * no smaller caches, no slower memory, no weaker GPU, no thermal limit. A phone is not "an M1
 * divided by six". So the breaking point transfers as an order of magnitude — "there is roughly
 * an order of magnitude of room" — and not as a claim about any particular device.
 *
 * As everywhere in this repo, the numbers are reported and not asserted (`af282b8`). What is
 * asserted is that the gesture happened.
 */

import { expect, test } from '@playwright/test'
import { open } from '../e2e/helpers.js'
import { armHandlerTiming, installPerf, measureDisplayPeriod, record } from './measure.js'
import { resetToTop, scrollTop, throttleCpu, warmUp, wheelScroll } from './drive.js'
import { aggregate, publish, summarise, type Row, type Summary } from './report.js'

const RUNS = 4
const WHEEL = { distance: 6000, speed: 3000 }

/**
 * The factors to try.
 *
 * Roughly geometric rather than linear, because the question is an order of magnitude and a
 * linear sweep spends most of its runs on the side where nothing happens. `1` is included as the
 * control: it shares every other detail with the throttled runs, so a difference between it and
 * the main suite would be the harness's doing rather than the throttle's.
 */
const RATES = [1, 4, 6, 10, 20]

/** The full thread. The largest dataset is the honest place to look for a limit. */
const QUERY = 'loadAll=1'

const rows: Row[] = []
let periodMs = 0
let browserVersion = 'unknown'

test.beforeAll(async ({ browser }) => {
  browserVersion = `chromium ${browser.version()}`
  periodMs = await measureDisplayPeriod(browser)
})

for (const rate of RATES) {
  for (const quiet of [false, true]) {
    const label = `wheel at ${String(rate)}× CPU slowdown — demo ${quiet ? 'quiet' : 'live'}`

    test(label, async ({ page }) => {
      await installPerf(page)
      await open(page, `${QUERY}${quiet ? '&quiet=1' : ''}`)
      await armHandlerTiming(page)
      await warmUp(page)
      // After the load, deliberately: throttling the load would start the measurement against a
      // list still catching up on its first measurements.
      await throttleCpu(page, rate)

      const summaries: Summary[] = []
      for (let run = 0; run < RUNS; run++) {
        await resetToTop(page)
        const before = await scrollTop(page)
        const { frames } = await record(page, () => wheelScroll(page, WHEEL))
        const after = await scrollTop(page)

        expect(after - before, `run ${String(run)}: the gesture moved the scroller nowhere`).toBeGreaterThan(0)
        expect(frames.gaps.length, `run ${String(run)}: no frames recorded`).toBeGreaterThan(5)
        expect(frames.overflowed, `run ${String(run)}: recorder overflowed`).toBe(0)

        if (run > 0) summaries.push(summarise(frames, periodMs))
      }

      // Restored before the page closes, so a leaked throttle cannot follow the browser into the
      // next test and be reported there as a finding.
      await throttleCpu(page, 1)

      rows.push({
        motion: 'wheel',
        dataset: `${String(rate)}× slower`,
        quiet,
        ...aggregate(summaries),
      })
    })
  }
}

test.afterAll(() => {
  if (rows.length === 0) return
  publish({
    name: 'headroom',
    title: `CPU headroom — wheel scrolling the full 12,000-comment thread, median of ${String(RUNS - 1)} runs`,
    rows,
    periodMs,
    browser: browserVersion,
    footer: [
      'dataset here is the emulated CPU slowdown. Read down the drop% and handler columns: the',
      'factor at which frames start being missed is the headroom, and it transfers to a slower',
      'device only as an order of magnitude — see this file’s header.',
    ],
  })
})
