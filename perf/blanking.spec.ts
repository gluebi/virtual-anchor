/**
 * Does the viewport go blank when you fling the list hard, and what does it take.
 *
 * **The complaint this exists for.** Scroll fast enough and the content disappears — empty space
 * where rows should be, filling in once the gesture slows. It reproduces here, and the conditions
 * are specific enough to be worth writing down.
 *
 * ## The mechanism
 *
 * The browser scrolls on the **compositor** thread; the set of mounted rows is recomputed on the
 * **main** thread from a scroll event. Overscan is what buys the main thread time, and it is a
 * distance — `DEFAULT_BUFFER` in `engine.ts` — while what has to be covered is *latency*. The
 * pixels a given latency costs depend entirely on how fast the content is moving, so for any
 * fixed buffer there is a speed that spends the whole of it inside one frame; past that the
 * compositor is presenting a region no row has been mounted for. This measures where that speed
 * is, which is the only thing a number for the buffer can honestly be chosen against.
 *
 * ## Why a wheel gesture will not show it, and a fling will
 *
 * `Input.synthesizeScrollGesture` with a **mouse** source delivers wheel events that the main
 * thread processes in order, so it cannot get ahead — an earlier version of this file swept wheel
 * speeds from 3,000 to 50,000 px/s, at 1× and 6× CPU, and found nothing at all. With
 * `preventFling: false` and a **touch** source the gesture hands off to the compositor, which
 * keeps scrolling whether or not the main thread is keeping up. That is the case that blanks, and
 * it is also the case a real thumb or trackpad produces.
 *
 * ## Two instruments, because the obvious one is blind
 *
 * The rAF blank probe measures what the *main thread* believes is on screen. It runs after the
 * scroll handler in the same frame, so it sees a world the handler has already made consistent —
 * and it reports ~2% (the demo's 12 px inter-item gap) even for gestures that visibly blanked.
 * That is not a bug in the probe; it is the definition of the blind spot. PNG byte size is the
 * second instrument: a screenshot is what was actually composited, and an empty scrollport
 * compresses to a small fraction of a full one. The control measures that fraction rather than
 * assuming it, and {@link test.beforeAll} asserts the two are far enough apart for the signal to
 * mean anything.
 *
 * Reported, never asserted (`af282b8`) — except the control, which asserts the instrument.
 */

import { expect, test } from '@playwright/test'
import { open } from '../e2e/helpers.js'
import { armBlankProbe, installPerf, record } from './measure.js'
import { recordFrames, resetToTop, scrollTop, throttleCpu, touchFling, warmUp } from './drive.js'
import { median } from './report.js'

const QUERY = 'loadAll=1&quiet=1'

/** 24,000 px/s is where one frame of latency costs the whole buffer, so the sweep straddles it. */
const SPEEDS = [8000, 40_000]
/** 1× is this machine. The rest stand in for a device whose main thread cannot keep up. */
const THROTTLES = [1, 6, 20]

let settledBytes = 0
let emptyRatio = 1
/**
 * What counts as a blank frame, derived from the control rather than declared.
 *
 * A screencast captures the whole viewport — page header, side panel and all — so an empty list
 * does not take the frame to zero; it takes it to whatever the surrounding chrome encodes to,
 * measured as {@link emptyRatio}. A frame within a quarter of that is a frame with about as
 * little list in it as a page with no rows at all. Writing a fixed 0.25 here, as an earlier
 * revision did, put the threshold *below* the empty control and made the test unfalsifiable.
 */
let blankThreshold = 0

interface Finding {
  throttle: number
  speed: number
  travelPx: number
  worstFrameMs: number
  /** What the main-thread probe thought, kept to show that it did not see it. */
  probeBlankPct: number
  /** The emptiest composited frame, as a share of a settled screenshot. */
  minRatio: number
  frameCount: number
  blankShots: number
  /** Where the blank frames fell, as a share of the way through the gesture. */
  blankAt: number[]
}

const findings: Finding[] = []

/**
 * Measure what "full" and "empty" compress to, and refuse to continue if they are not far apart.
 *
 * Without this the whole file rests on an assumption about PNG compression. With it, the signal
 * is calibrated on the actual page, at the actual size, in the actual browser.
 */
test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  await installPerf(page)
  await open(page, QUERY)

  // Calibrated through the same instrument the measurement uses. A control measured with
  // `page.screenshot()` would be a different encoder at a different size, and the ratio between
  // them would mean nothing.
  const idle = (): Promise<void> => page.waitForTimeout(400)
  settledBytes = median(await recordFrames(page, idle))
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-virtual-key]')) row.remove()
  })
  emptyRatio = median(await recordFrames(page, idle)) / settledBytes
  await page.close()

  blankThreshold = emptyRatio * 1.25

  expect(
    emptyRatio,
    `an empty list encodes to ${emptyRatio.toFixed(2)} of a full one, which is too close to ` +
      'call — the blankness measurement below could not distinguish a blank frame from a full one',
  ).toBeLessThan(0.6)
})

for (const throttle of THROTTLES) {
  for (const speed of SPEEDS) {
    test(`fling at ${String(speed)} px/s, ${String(throttle)}× CPU`, async ({ page }) => {
      await installPerf(page)
      await open(page, QUERY)
      await armBlankProbe(page)
      await warmUp(page)
      await throttleCpu(page, throttle)

      // A warm-up fling, discarded. The first synthesized touch gesture on a fresh page reliably
      // moves nothing — observed across every cell of this table — and a measured run that began
      // with it would report a pristine 1.00 for a gesture that never happened.
      await touchFling(page, { distance: 2000, speed: 8000 })
      await resetToTop(page)

      const before = await scrollTop(page)
      const { frames, value: shots } = await record(page, () =>
        recordFrames(page, () => touchFling(page, { distance: 2000, speed })),
      )
      const after = await scrollTop(page)
      await throttleCpu(page, 1)

      expect(shots.length, 'the screencast delivered no frames').toBeGreaterThan(3)
      // Guards the guard, and this file needs it more than any other: a fling that moved nothing
      // photographs as a perfectly full scrollport, which reads as "no blanking here" rather than
      // as "no gesture here". An earlier revision of this spec omitted it and reported exactly
      // that, for four cells out of six.
      expect(after - before, 'the fling moved the scroller nowhere').toBeGreaterThan(0)

      const ratios = shots.map((bytes) => bytes / settledBytes)
      findings.push({
        throttle,
        speed,
        travelPx: after - before,
        worstFrameMs: frames.gaps.reduce((worst, gap) => Math.max(worst, gap), 0),
        probeBlankPct: frames.blanks.reduce((worst, blank) => Math.max(worst, blank), 0) * 100,
        minRatio: ratios.reduce((least, ratio) => Math.min(least, ratio), Infinity),
        frameCount: ratios.length,
        blankShots: ratios.filter((ratio) => ratio <= blankThreshold).length,
        blankAt: ratios
          .map((ratio, index) => (ratio <= blankThreshold ? index / ratios.length : -1))
          .filter((position) => position >= 0),
      })
    })
  }
}

test.afterAll(() => {
  if (findings.length === 0) return

  const head = 'CPU    fling px/s   travel px   worst frame   main-thread probe   emptiest frame   blank captures'
  const body = findings.map(
    (finding) =>
      `${`${String(finding.throttle)}×`.padEnd(6)} ${String(finding.speed).padEnd(12)} ` +
      `${String(Math.round(finding.travelPx)).padEnd(11)} ${`${finding.worstFrameMs.toFixed(0)} ms`.padEnd(13)} ` +
      `${`${finding.probeBlankPct.toFixed(0)}%`.padEnd(19)} ${finding.minRatio.toFixed(2).padEnd(16)} ` +
      `${String(finding.blankShots)}/${String(finding.frameCount)}  at ${finding.blankAt.map((p) => `${(p * 100).toFixed(0)}%`).join(',') || '-'}`,
  )

  // eslint-disable-next-line no-console -- the report is the point of the run
  console.log(
    [
      '',
      'blank viewport during a compositor-driven fling — full thread, demo quiet',
      `an empty scrollport measures ${emptyRatio.toFixed(2)}; a settled one is 1.00`,
      '',
      head,
      '-'.repeat(head.length),
      ...body,
      '',
      'main-thread probe — largest contiguous uncovered run the rAF probe saw. It stays near the',
      '                    demo’s 12 px gap even when the page visibly blanked: that is the blind',
      '                    spot this file’s header describes, not a disagreement.',
      'emptiest frame    — smallest capture as a share of a settled screenshot. Approaching the',
      `                    empty figure above (${emptyRatio.toFixed(2)}) means a fully blank frame reached the screen.`,
      `blank captures    — composited frames at or below ${blankThreshold.toFixed(2)} of a settled one (the`,
      '                    empty control times 1.25), out of those the screencast delivered.',
      '',
    ].join('\n'),
  )
})
