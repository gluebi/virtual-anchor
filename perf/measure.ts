/**
 * The instrument: a full-fidelity frame recorder that runs in the page.
 *
 * **What this measures and what it does not.** It records the interval between consecutive
 * `requestAnimationFrame` callbacks, and — where the browser has it — the `long-animation-frame`
 * entries that say how much of a frame was main-thread work. It does *not* observe presented
 * frames. `frameProbe.ts:22` states the limitation this inherits: rAF gaps "conflate 'the main
 * thread was blocked' with 'the compositor did not present a frame'". Recording LoAF alongside
 * is what lets the two be told apart — a long gap with no matching blocking time was not this
 * library's doing. For what the *compositor* put on screen, see `recordFrames` in `drive.ts`.
 *
 * ## Why this exists next to the library's own frame probe rather than reusing it
 *
 * `startFrameProbe` deliberately records only outliers: `frameProbe.ts:73` — "Emitting every
 * frame would fill the recorder with the ordinary 8ms and 16ms case and push the gesture that
 * matters out of the ring." That is the right call for a diagnostic ring buffer on a phone, and
 * it makes a percentile impossible, because the ordinary frames are never written down. A
 * benchmark needs exactly the frames that probe discards. Two further constraints rule reuse out
 * outright: this is injected with `addInitScript`, whose function is serialized and so cannot
 * close over an import, and `startFrameProbe` reports through `trace()`, which is compiled out of
 * the uninstrumented build `pnpm perf` exists to measure.
 *
 * ## One loop, and why everything hangs off it
 *
 * Every per-frame job here — the gap, the optional blank sample, the optional wait-for-still —
 * runs inside a single rAF callback. That is not tidiness. A second loop would be a second
 * main-thread wakeup per frame *during the thing being measured*, which is the failure
 * `driver.ts:5` was written to prevent, and an earlier version of this harness committed it: the
 * fling motion awaited its own rAF loop to detect the end of momentum, doubling the wakeups
 * across exactly the frames the fling scenario reports on.
 *
 * ## The probe perturbs what it measures
 *
 * Unarmed, the per-frame cost is a single store into a preallocated `Float64Array` — no
 * allocation, no layout read, no `scrollTop` access. **Armed, that is no longer true**:
 * `armBlankProbe` adds a layout flush and a rect per mounted row, every frame, and says so where
 * it is defined. Nothing here is free; the unarmed path is merely as close as a per-frame
 * observer gets.
 */

import { expect, type Browser, type Page } from '@playwright/test'
import { open } from '../e2e/helpers.js'
import { median } from './report.js'

export interface FrameRecord {
  /**
   * Milliseconds between consecutive rAF callbacks.
   *
   * The first callback of a run has no predecessor and so contributes no gap — `gaps.length`
   * is one less than the number of frames observed. Every statistic derived from this treats
   * `gaps.length` as the frame count, which keeps the rate and the durations consistent with
   * each other rather than off by one in opposite directions.
   */
  gaps: number[]
  /**
   * Blocking milliseconds from each `long-animation-frame` entry, or `null` where the browser has
   * no such entry type.
   *
   * Only the blocking duration, because only the blocking duration is read. An entry's
   * `startTime` and `duration` were collected by an earlier version and had no reader anywhere.
   */
  loaf: number[] | null
  /**
   * Milliseconds spent in the library's scroll handler, one entry per scroll event.
   *
   * Empty unless {@link armHandlerTiming} was called. This is the number that answers "how much
   * of the frame budget does the list actually use", which neither the rAF gaps nor LoAF can
   * give: gaps only say a frame was late, and `long-animation-frame` does not report a frame at
   * all until it crosses 50 ms — so on a scroll that never janks, LoAF is silent by design.
   */
  handler: number[]
  /**
   * Fraction of the scrollport with no row over it, one entry per frame.
   *
   * Empty unless {@link armBlankProbe} was called.
   */
  blanks: number[]
  /**
   * Frames the recorder had no room for.
   *
   * Non-zero means the run outlived the buffer and the record is truncated. The library's own
   * recorder surfaces `dropped()` for the same reason (`recorder.ts` header): a truncated
   * record that reports itself as complete is worse than no record.
   */
  overflowed: number
}

interface PerfHarness {
  start: () => void
  stop: () => FrameRecord
  /** Begin timing the scroll handler. Must be called *after* the list has mounted — see below. */
  armHandlerTiming: () => void
  /** Begin sampling how much of the scrollport has no row over it. */
  armBlankProbe: () => void
  /** Resolve once the scrollport has held still, judged from the loop that is already running. */
  waitForStill: (quietFrames: number, capFrames: number) => Promise<void>
}

declare global {
  interface Window {
    /** The perf harness's own recorder, installed before the app boots. */
    __perf: PerfHarness
  }
}

/**
 * Install the recorder into every document the page loads.
 *
 * `addInitScript` rather than an `evaluate` after `goto`, so the recorder survives the
 * navigation and is available before the demo's own first-paint deep link runs.
 */
export async function installPerf(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // About eleven minutes at 60 Hz, which no scenario approaches. Sized so that an overflow
    // means something went wrong rather than that the run was long.
    const cap = 40_000

    const gaps = new Float64Array(cap)
    let count = 0
    let overflowed = 0
    let handle: number | null = null
    let last = 0
    let entries: number[] = []
    let observer: PerformanceObserver | null = null

    let loafSupported = false
    try {
      loafSupported = PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')
    } catch {
      loafSupported = false
    }

    const collect = (list: readonly PerformanceEntry[]): void => {
      for (const entry of list) {
        // `blockingDuration` is not in the DOM lib yet, so it is read through a narrowing cast
        // rather than by widening the entry to `any`.
        const loaf = entry as unknown as { blockingDuration?: number }
        entries.push(loaf.blockingDuration ?? 0)
      }
    }

    // Allocated only when armed. Two 40,000-element buffers in every document of every spec is
    // 640 kB for a probe that one spec of three uses.
    let blanks: Float64Array | null = null
    let blankCount = 0
    let blankTarget: Element | null = null
    let blankTop = 0
    let blankHeight = 0

    /**
     * The largest *contiguous* stretch of the scrollport with no row over it, as a fraction of
     * the scrollport's height.
     *
     * Contiguous, and not "how many probe points missed", because the first version of this
     * measured the latter and reported a flat 7% at every speed from a crawl to 50,000 px/s. That
     * was not blanking: it was the demo's 12 px `gap` between comments. A 12 px gap every ~162 px
     * of content is 7.4% of a column of sample points, at any speed, forever. The number was
     * real, constant, and about the wrong thing.
     *
     * The spans are sorted rather than trusted in DOM order. Rows are absolutely positioned by
     * `surface.ts`, and `itemsFor` (`engine.ts:687`) deliberately mounts the pinned destination
     * and the focus-held row as *separate segments* outside the contiguous range — so document
     * order is not guaranteed to be top-to-bottom, and a sweep that assumed it would report a
     * gap that is not there.
     */
    const blankFraction = (): number => {
      if (blankTarget === null || blankHeight <= 0) return 0
      const rows = blankTarget.querySelectorAll('[data-virtual-key]')
      const spans: { top: number; bottom: number }[] = []
      const edge = blankTop + blankHeight
      for (const row of rows) {
        const rect = row.getBoundingClientRect()
        // Clipped to the scrollport: a tall comment hanging far off both ends still only covers
        // what is on screen, and counting its full height would hide a real gap beside it.
        const top = Math.max(rect.top, blankTop)
        const bottom = Math.min(rect.bottom, edge)
        if (bottom > top) spans.push({ top, bottom })
      }
      spans.sort((a, b) => a.top - b.top)

      let worst = 0
      let reached = blankTop
      for (const span of spans) {
        if (span.top > reached) worst = Math.max(worst, span.top - reached)
        if (span.bottom > reached) reached = span.bottom
      }
      return Math.max(worst, edge - reached) / blankHeight
    }

    // Stillness, judged from this loop rather than one of its own — see the module header.
    let stillWanted = 0
    let stillCap = 0
    let stillSeen = 0
    let stillFrames = 0
    let stillPrevious = -1
    let stillResolve: (() => void) | null = null
    let stillReject: ((error: Error) => void) | null = null
    // Resolved once, when the wait begins. Looking it up per frame would put a `querySelector`
    // back into the loop this whole design exists to keep empty.
    let stillTarget: Element | null = null

    const sampleStill = (): void => {
      if (stillTarget === null) return
      const now = stillTarget.scrollTop
      if (now === stillPrevious) stillSeen++
      else stillSeen = 0
      stillPrevious = now
      stillFrames++

      const settled = stillSeen >= stillWanted
      if (!settled && stillFrames < stillCap) return

      const resolve = stillResolve
      const reject = stillReject
      // Cleared before the callback, so a continuation that starts another wait cannot find this
      // one still armed.
      stillResolve = null
      stillReject = null
      stillTarget = null
      if (settled) resolve?.()
      else reject?.(new Error('the scroller never came to rest'))
    }

    // Re-requested at the top, before the work, so a throw in the body cannot silently end the
    // recording and leave a short record looking like a complete one.
    const tick = (at: number): void => {
      handle = requestAnimationFrame(tick)
      if (last !== 0) {
        if (count < cap) {
          gaps[count++] = at - last
          if (blanks !== null) blanks[blankCount++] = blankFraction()
        } else overflowed++
      }
      last = at
      sampleStill()
    }

    let handler: number[] = []
    let armed = false
    let dispatchedAt = 0

    window.__perf = {
      /**
       * Bracket the library's scroll handler between two listeners.
       *
       * A `scroll` event on an element does not bubble, but it *does* capture — a capture-phase
       * listener on `document` runs before any listener on the target. So the first listener
       * stamps the moment dispatch began, and a listener registered on the scroller *after* the
       * library's runs once the library's has returned. The difference is the engine's per-event
       * cost: `engine.ts:1717`'s handler and the `publish()` it ends with.
       *
       * **Ordering is the whole contract, and it is why this cannot be armed from
       * `addInitScript`.** Target-phase listeners fire in registration order, so this must be
       * registered after `mount()` has registered the library's — which means after the list has
       * mounted, not before the document has scripts. Arming early would put this listener first
       * and it would measure nothing but itself.
       *
       * What it includes: every scroll listener registered before this one. In the demo that is
       * the library's and nothing else, which is what makes the number attributable.
       */
      armHandlerTiming() {
        if (armed) return
        const scroller = document.querySelector('.scroller')
        if (scroller === null) throw new Error('no .scroller to time the handler on')
        document.addEventListener(
          'scroll',
          () => {
            dispatchedAt = performance.now()
          },
          true,
        )
        scroller.addEventListener('scroll', () => {
          if (dispatchedAt !== 0) handler.push(performance.now() - dispatchedAt)
        })
        armed = true
      },
      /**
       * Start measuring uncovered scrollport.
       *
       * The scrollport's own rectangle is read **once, here** and cached: it does not move while
       * its contents scroll, and re-reading it per frame would add a layout flush to a probe that
       * already forces one — the trap `frameProbe.ts:41` documents for `sampleScrollTop`.
       */
      armBlankProbe() {
        const scroller = document.querySelector('.scroller')
        if (scroller === null) throw new Error('no .scroller to probe')
        const rect = scroller.getBoundingClientRect()
        blankTarget = scroller
        blankTop = rect.top
        blankHeight = rect.height
        blanks ??= new Float64Array(cap)
      },
      waitForStill(quietFrames, capFrames) {
        const scroller = document.querySelector('.scroller')
        if (scroller === null) throw new Error('no .scroller to watch')
        return new Promise<void>((resolve, reject) => {
          stillWanted = quietFrames
          stillCap = capFrames
          stillSeen = 0
          stillFrames = 0
          stillPrevious = -1
          stillTarget = scroller
          stillResolve = resolve
          stillReject = reject
          // The recorder's loop may not be running — `waitForStill` is also usable outside a
          // recording — so make sure something is ticking.
          handle ??= requestAnimationFrame(tick)
        })
      },
      start() {
        count = 0
        blankCount = 0
        overflowed = 0
        last = 0
        entries = []
        handler = []
        if (loafSupported) {
          observer = new PerformanceObserver((list) => {
            collect(list.getEntries())
          })
          observer.observe({ type: 'long-animation-frame' })
        }
        handle ??= requestAnimationFrame(tick)
      },
      stop() {
        if (handle !== null) {
          cancelAnimationFrame(handle)
          handle = null
        }
        if (observer !== null) {
          // Drained before disconnecting: observer callbacks are delivered asynchronously, so
          // the entries for the last frames of the run have not been handed over yet.
          collect(observer.takeRecords())
          observer.disconnect()
          observer = null
        }
        return {
          gaps: Array.from(gaps.subarray(0, count)),
          loaf: loafSupported ? entries : null,
          handler,
          blanks: blanks === null ? [] : Array.from(blanks.subarray(0, blankCount)),
          overflowed,
        }
      },
    }
  })
}

/**
 * Arm the scroll-handler timer. Call once per page, after the list has mounted.
 *
 * Separate from {@link installPerf} because the two have opposite ordering requirements: the
 * recorder must exist before the app's scripts run, and this must be registered after them.
 */
export async function armHandlerTiming(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__perf.armHandlerTiming()
  })
}

/**
 * Arm the blank-viewport probe. Costs a layout flush per frame; only the blanking spec uses it.
 */
export async function armBlankProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__perf.armBlankProbe()
  })
}

/**
 * Record frames for the duration of one motion.
 *
 * The motion is passed in rather than the caller starting and stopping around it, so the
 * recording window cannot drift away from the thing it is recording — the mistake that turns a
 * benchmark into a measurement of the harness's own round trips.
 */
export async function record<T>(
  page: Page,
  motion: () => Promise<T>,
): Promise<{ frames: FrameRecord; value: T }> {
  await page.evaluate(() => {
    window.__perf.start()
  })
  const value = await motion()
  const frames = await page.evaluate(() => window.__perf.stop())
  return { frames, value }
}

/**
 * The display's frame period, measured on an idle page.
 *
 * Measured, never assumed — the house rule from `helpers.ts:26`. Hardcoding 16.67 would silently
 * misreport every derived figure on a 120 Hz display.
 *
 * The median rather than the mean, because the first frames after a navigation are not idle.
 */
export async function measurePeriod(page: Page, ms = 1000): Promise<number> {
  await page.evaluate(() => {
    window.__perf.start()
  })
  await page.waitForTimeout(ms)
  const frames = await page.evaluate(() => window.__perf.stop())
  return median(frames.gaps)
}

/**
 * The display period, plus the guard the whole report rests on.
 *
 * Here rather than in each spec because the assertion is about **the instrument**, not about the
 * scenario — it is the one hard threshold in a harness whose rule is otherwise to report and
 * never assert. The failure it catches is not a slow library: it is a headed Chromium window that
 * has been occluded or backgrounded, whose `requestAnimationFrame` is then throttled to about
 * 1 Hz. Every figure downstream would be catastrophic and meaningless, and the run has to stop
 * rather than publish them.
 */
export async function measureDisplayPeriod(browser: Browser): Promise<number> {
  const page = await browser.newPage()
  await installPerf(page)
  await open(page, 'loaded=50&quiet=1')
  const periodMs = await measurePeriod(page)
  await page.close()

  expect(periodMs, 'no frames on an idle page — the recorder is not running').toBeGreaterThan(1)
  expect(
    periodMs,
    `idle frame period ${periodMs.toFixed(1)}ms is far slower than any display. The window is ` +
      'almost certainly occluded or backgrounded, which throttles rAF; bring it to the front, ' +
      'keep the display awake, and re-run.',
  ).toBeLessThan(25)

  return periodMs
}
