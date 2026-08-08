/**
 * How fast can you scroll the demo, and how much of the frame budget does the list use.
 *
 * **What this proves and what it does not.** It reports frame timing for three motions across
 * three dataset sizes, on this machine, in headed Chromium, driven by synthesized input. It is
 * not a claim about phones, about other engines, or about a human hand — and because the display
 * sets a ceiling no scenario can exceed, the FPS column alone cannot distinguish "comfortable"
 * from "only just keeping up". That is what the `handler` column is for: milliseconds spent in
 * the library's scroll handler per event, against a budget the header states. A run at the
 * ceiling with 2 ms of handler has room to spare; the same FPS with 14 ms does not.
 *
 * **Nothing here asserts a speed.** That is the standing rule in this repo — `af282b8`, and
 * `ios-momentum.spec.ts:465`: "Gap statistics are reported and never asserted." What *is*
 * asserted is that the measurement happened at all: that frames were recorded, that the scroller
 * actually moved, and that the recorder did not overflow. Those guard against the failure mode a
 * benchmark is most prone to, which is reporting a beautiful number for a gesture that never
 * occurred. The one hard threshold, on the display period, lives in `measureDisplayPeriod`
 * because it asserts the instrument rather than the machine.
 *
 * Set `PERF_MIN_FPS` to turn the report into a gate locally. It is unset by default and must stay
 * that way in anything automated.
 */

import { expect, test } from '@playwright/test'
import type { ScrollResult } from '../packages/virtual-anchor/src/index.js'
import { open, scrollTo } from '../e2e/helpers.js'
import { armHandlerTiming, installPerf, measureDisplayPeriod, record } from './measure.js'
import { resetToTop, scrollTop, touchFling, warmUp, wheelScroll } from './drive.js'
import { aggregate, publish, summarise, type Row, type Summary } from './report.js'

/**
 * Repetitions per cell, the first discarded.
 *
 * The discard is not superstition: the first gesture after a page load runs against a cold JIT,
 * an unwarmed size cache and a browser that has not yet decided the layer promotion for the
 * scroller. Reporting it would describe the first two seconds of a page's life rather than
 * scrolling.
 */
const RUNS = 5

/** A gesture long enough to be a scroll rather than a nudge, short enough to run five times. */
const WHEEL = { distance: 6000, speed: 3000 }
/** A flick: brief, fast, and then left alone so the momentum is the browser's. */
const FLING = { distance: 1200, speed: 6000 }
/** Far enough into the thread that the convergence loop has real work to do. */
const SCROLL_TO = 6000

interface Scenario {
  motion: 'wheel' | 'scrollToKey' | 'fling'
  dataset: string
  /**
   * Both `loaded` and `loadAll` set `FIXED_WINDOW` (`config.ts:183`), which disables paging.
   * That is load-bearing and not merely about size: without it `onEdgeReached` would extend the
   * dataset mid-gesture and the harness would be timing a data load.
   */
  query: string
}

const SCENARIOS: Scenario[] = [
  { motion: 'wheel', dataset: '200 loaded', query: 'loaded=200' },
  { motion: 'wheel', dataset: '2000 loaded', query: 'loaded=2000' },
  { motion: 'wheel', dataset: '12000 (all)', query: 'loadAll=1' },
  { motion: 'scrollToKey', dataset: '12000 (all)', query: 'loadAll=1' },
  { motion: 'fling', dataset: '12000 (all)', query: 'loadAll=1' },
]

const rows: Row[] = []
let periodMs = 0
let browserVersion = 'unknown'

test.beforeAll(async ({ browser }) => {
  browserVersion = `chromium ${browser.version()}`
  periodMs = await measureDisplayPeriod(browser)
})

const motionFor = (page: Parameters<typeof scrollTop>[0], scenario: Scenario): Promise<unknown> => {
  switch (scenario.motion) {
    case 'wheel':
      return wheelScroll(page, WHEEL)
    case 'fling':
      return touchFling(page, FLING)
    case 'scrollToKey':
      return scrollTo(page, SCROLL_TO, { behavior: 'smooth' })
  }
}

for (const scenario of SCENARIOS) {
  for (const quiet of [false, true]) {
    const label = `${scenario.motion} — ${scenario.dataset} — demo ${quiet ? 'quiet' : 'live'}`

    test(label, async ({ page }) => {
      await installPerf(page)
      // The demo's frame-rate readout switches itself off for a driven browser, keyed on
      // `navigator.webdriver` in `apps/demo/src/config.ts`. Nothing here needs to ask for that,
      // and an earlier version passed `fps=0` in every query — which read as the mechanism and
      // was not; the parameter only ever reached the pages that remembered to pass it.
      await open(page, `${scenario.query}${quiet ? '&quiet=1' : ''}`)
      // After `open`, never before: target-phase scroll listeners fire in registration order, so
      // this has to be registered behind the library's. See `measure.ts`.
      await armHandlerTiming(page)
      await warmUp(page)

      const summaries: Summary[] = []
      let last: unknown = null

      for (let run = 0; run < RUNS; run++) {
        await resetToTop(page)
        const before = await scrollTop(page)
        const { frames, value } = await record(page, () => motionFor(page, scenario))
        const after = await scrollTop(page)
        last = value

        // Guards the guard. Every statistic below would look perfectly healthy for a gesture that
        // was never delivered — the idle page runs at the display rate too. The idiom is
        // `ios-momentum.spec.ts:219`'s.
        expect(after - before, `run ${String(run)}: the motion moved the scroller nowhere`).toBeGreaterThan(0)
        expect(frames.gaps.length, `run ${String(run)}: no frames recorded`).toBeGreaterThan(10)
        expect(frames.overflowed, `run ${String(run)}: recorder overflowed, record truncated`).toBe(0)

        if (run > 0) summaries.push(summarise(frames, periodMs))
      }

      const row: Row = {
        motion: scenario.motion,
        dataset: scenario.dataset,
        quiet,
        ...aggregate(summaries),
      }
      const note = noteFor(last)
      if (note !== null) row.note = note
      rows.push(row)

      // Reported, never asserted — unless the person running it asked for a gate.
      const floor = process.env.PERF_MIN_FPS
      if (floor !== undefined) {
        expect(row.fps, `${label}: below the PERF_MIN_FPS floor`).toBeGreaterThanOrEqual(
          Number(floor),
        )
      }
    })
  }
}

/** Carry a `scrollToKey` outcome into the report; the iteration count is its real cost driver. */
function noteFor(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null
  const result = value as Partial<ScrollResult>
  if (typeof result.iterations !== 'number') return null
  return `settled=${String(result.settled)} deviation=${(result.deviation ?? 0).toFixed(3)}px iterations=${String(result.iterations)}`
}

test.afterAll(() => {
  if (rows.length === 0) return
  publish({
    name: 'scroll-fps',
    // Derived, not written out: an earlier version stated "median of 4 runs, first of 5" beside a
    // `RUNS` it did not read, so changing the constant would have made the report lie.
    title: `scroll performance — median of ${String(RUNS - 1)} runs, first of ${String(RUNS)} discarded as warm-up`,
    rows,
    periodMs,
    browser: browserVersion,
    footer: [
      'handler = ms in the library’s scroll handler per scroll event (p50), against the budget above.',
      'blocked = total long-animation-frame blocking time; “—” where the browser has no such entry.',
      ...rows
        .filter((row) => row.note !== undefined)
        .map((row) => `${row.motion} (${row.quiet ? 'quiet' : 'live'}): ${row.note ?? ''}`),
    ],
  })
})
