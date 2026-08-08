import { expect, test, type Page } from '@playwright/test'
import { open, TOLERANCE } from './helpers.js'

/**
 * The momentum write gate, in a real WebKit that believes it is an iPhone.
 *
 * **What this proves and what it does not.** The `mobile-webkit` project supplies an
 * iPhone user agent and `hasTouch`, so `isIOSWebKit()` returns true and the gate is
 * live — which means the wiring is exercised end to end in a real engine: the gate
 * shuts on `touchend`, no `scrollTop` write escapes before `scrollend`, and the
 * deferred correction lands afterwards.
 *
 * It does **not** prove the fling survives, because Playwright's synthesised touch
 * events produce no momentum for there to be a fling. That is only verifiable on real
 * hardware — the README says so, and it still says so. What automation can do is fail
 * if a write ever escapes the closed window, which is the defect (#26) rather than the
 * symptom.
 *
 * Counting is done by patching the `scrollTop` setter before any script runs, so it
 * catches a write from anywhere in the library rather than from the paths a test
 * thought to look at.
 *
 * What is deliberately *not* asserted here is the size of the correction being held as a
 * paint offset. It depends on how wrong the demo's size estimate is at whatever viewport
 * the device descriptor supplies, which is not something a test controls: measured here
 * it comes out under a pixel, indistinguishable from the sub-pixel carry that writes the
 * same property. A threshold loose enough to pass would pass with the compensation
 * removed. The magnitude, the accumulation and the fold are asserted in
 * `engine.ios.dom.test.ts`, where the correction is an input rather than an accident.
 */

/** Count every `scrollTop` write on the scrollport, from page load onwards. */
const countScrollWrites = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const proto = Element.prototype as unknown as Record<string, unknown>
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'scrollTop')
    if (!descriptor?.set || !descriptor.get) return
    // Bound through arrows so the accessor pair keeps its receiver when re-installed
    // below; a bare reference to a descriptor's method loses `this`.
    const original = (target: Element, value: number): void => {
      descriptor.set?.call(target, value)
    }
    const read = (target: Element): unknown => descriptor.get?.call(target)
    window.__scrollWrites = 0
    Object.defineProperty(proto, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return read(this)
      },
      set(this: Element, value: number) {
        if ((this as HTMLElement).classList.contains('scroller')) {
          window.__scrollWrites = (window.__scrollWrites ?? 0) + 1
        }
        original(this, value)
      },
    })
  })
}

const writes = (page: Page): Promise<number> =>
  page.evaluate(() => window.__scrollWrites ?? 0)

/**
 * Put a finger down and leave it there.
 *
 * A DOM event rather than `page.touchscreen`, which also lifts the finger and so starts
 * the grace period that correctly reopens the gate — a tap is not a fling. Holding
 * `touching` needs no timer, so there is no race to lose.
 */
const holdFinger = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.querySelector('.scroller')?.dispatchEvent(new Event('touchstart', { bubbles: true }))
  })

/** Lift it again, which is what starts the grace period the gate watches. */
const liftFinger = (page: Page): Promise<void> =>
  page.evaluate(() => {
    document.querySelector('.scroller')?.dispatchEvent(new Event('touchend', { bubbles: true }))
  })

test.describe('the momentum write gate on an emulated iPhone', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'needs the mobile-webkit project, where isIOSWebKit() is true',
  )

  test('is live at all — the platform sniff matches', async ({ page }) => {
    // Guards the guard. If the descriptor ever stops matching, every assertion below
    // passes for the wrong reason, silently.
    await open(page, 'comment=4211')
    const active = await page.evaluate(
      () => /iP(hone|od|ad)/.test(navigator.userAgent) && 'ontouchend' in window,
    )
    expect(active).toBe(true)
  })

  test('lets no scrollTop write escape while a gesture is in flight', async ({ page }) => {
    await countScrollWrites(page)
    await open(page, 'comment=4211')

    await holdFinger(page)

    const baseline = await writes(page)

    // A style change that alters wrapping, so every mounted row re-measures at once —
    // the same event the library sees when a webfont lands. Scrolling alone is not
    // enough of a provocation: rows mounting *below* the anchor move nothing it
    // resolves against, so there is no correction to suppress and the assertion would
    // pass with the guard removed entirely.
    await page.addStyleTag({
      content: '.comment { letter-spacing: 0.45px; word-spacing: 1.5px; }',
    })

    // Long enough for the ResizeObserver deliveries and the measurement batch that
    // follows them. Every one of those used to write `scrollTop`.
    await page.waitForTimeout(600)

    expect(await writes(page)).toBe(baseline)


  })

  test('a prepend still writes, gesture or no gesture', async ({ page }) => {
    // The deliberate exception, and the reason the deferral is keyed on *cause*: a
    // model change deferred would move the reader by the whole inserted height.
    await countScrollWrites(page)
    await open(page, 'comment=4211')

    await holdFinger(page)
    const baseline = await writes(page)

    await page.evaluate(() => window.__list.insert('above', 20))
    await page.waitForTimeout(600)

    expect(await writes(page)).toBeGreaterThan(baseline)
  })

  test('still lands a deep link exactly, with the gate in the loop', async ({ page }) => {
    // The regression that matters most for consumers: the gate must not cost accuracy.
    await open(page, 'comment=6018')
    const readout = page.locator('.panel .small').first()
    await expect(readout).toContainText('settled=true', { timeout: 15_000 })
  })
})

/**
 * The same window, asserted from the library's own account of it.
 *
 * What these add over the counter above is **why**, not whether. The counter could say a write
 * happened; it could not say which of four reasons it happened for — and that difference is the
 * whole distinction between the gate working and the gate being bypassed by its own bound firing.
 * Until this suite existed, `writeScroll` reported `deferred: true` for a write that had *escaped*,
 * because the flag was computed before the test that decides. The demo's on-device readout printed
 * it as `DEFER`.
 *
 * Two things are newly checkable here and were not before. The scroller writes `scrollTop` too, and
 * emitted nothing about it — so "no write escaped" was a conclusion drawn from half the writers.
 * And `reconcileGestureShift`, the fold of a banked correction back into `scrollTop`, emitted
 * nothing at all, which made the most plausible cause of a visible jump the one thing the trace
 * could not see.
 *
 * **Still not proven, and no amount of Playwright will prove it: that the fling survives.**
 * Synthesised touch produces no momentum, so `momentum-onset` below is provoked by scroll events
 * this file wrote itself. It follows that nothing here exercises the two suspects that need real
 * momentum — a rubber-band bounce at the bottom, where `room` is zero and the engine writes into
 * the overscroll, and the 150 ms grace window losing a race against a main thread that CI is not
 * loaded like. Those are diagnosed on a device, with `?debug=1`, by reading the verdict. This
 * file's job is to fail if a write escapes a window that is closed, and to fail if the fold stops
 * being continuous.
 */
test.describe('the momentum gate, as the library reports it', () => {
  test.skip(
    ({ browserName, isMobile }) => browserName !== 'webkit' || !isMobile,
    'needs the mobile-webkit project, where isIOSWebKit() is true',
  )

  /** Every trace event of a topic, in order. */
  const events = (
    page: Page,
    topic: string,
  ): Promise<{ at: number; data: Record<string, number | string | boolean> }[]> =>
    page.evaluate((prefix) => window.__trace(prefix) as never, topic)

  /**
   * Imitate momentum's *scroll events*, which is as close as automation reaches.
   *
   * Playwright dispatches touch events but produces no fling, so the gate would never leave the
   * grace window on its own. Writing `scrollTop` from the page after `touchend` produces the one
   * signal the gate actually watches — a scroll arriving inside 150 ms of the lift — which is what
   * promotes it to `momentum` and holds it shut across the sequence.
   */
  const fling = async (
    page: Page,
    span: { frames: number } | { ms: number },
    step = 30,
  ): Promise<void> => {
    await page.evaluate(
      async ({ span: howLong, step: px }) => {
        const element = document.querySelector('.scroller')
        if (!element) throw new Error('no scroller')
        element.dispatchEvent(new Event('touchstart', { bubbles: true }))
        for (let i = 0; i < 6; i++) {
          element.scrollTop += px
          await new Promise(requestAnimationFrame)
        }
        element.dispatchEvent(new Event('touchend', { bubbles: true }))
        const until = 'ms' in howLong ? performance.now() + howLong.ms : 0
        const frames = 'frames' in howLong ? howLong.frames : Number.POSITIVE_INFINITY
        for (let i = 0; i < frames && ('frames' in howLong || performance.now() < until); i++) {
          element.scrollTop += px
          await new Promise(requestAnimationFrame)
        }
      },
      { span, step },
    )
  }

  test('the build under test has instrumentation at all', async ({ page }) => {
    // Guards the guard, the same move as the platform sniff above. Without this, every assertion
    // below passes against an empty array the moment the demo is built without the flag — silently,
    // and looking like a clean result.
    await open(page, 'debug=1&overlay=0&comment=4211')
    expect(await page.evaluate(() => typeof window.__verdict)).toBe('function')
    expect(await page.evaluate(() => window.__trace().length)).toBeGreaterThan(0)
  })

  test('the trace agrees with the writes the platform actually saw', async ({ page }) => {
    // The assertion that stops the trace from lying, and the one that would have caught the
    // scroller writing `scrollTop` untraced for as long as tracing has existed.
    //
    // Provoked with a style change and *not* with the synthetic fling below, because that fling
    // moves `scrollTop` from the page — so the descriptor counter would be counting this test's own
    // writes alongside the library's and the comparison would be meaningless. Measured: 26 of the
    // counter's writes were the test's. Here every write on the scrollport is the library's, which
    // is what makes the two numbers comparable at all.
    await countScrollWrites(page)
    await open(page, 'debug=1&overlay=0&comment=4211')

    // After the deep link has landed, so the baseline excludes the scroll that got us here.
    const baseline = await writes(page)
    await page.evaluate(() => {
      window.__traceClear()
    })

    await holdFinger(page)
    await page.addStyleTag({ content: '.comment { letter-spacing: 0.45px; word-spacing: 1.5px; }' })
    await page.waitForTimeout(400)
    // Release and let the banked correction fold, so there is a write to account for.
    await liftFinger(page)
    await page.waitForTimeout(800)

    // All three ways the library moves `scrollTop`, which is the point: any one of them missing
    // from the trace is a write a reader would not see.
    //
    // `gesture.fold` is the one that is easy to forget, and this assertion did at first. The fold
    // writes through `commitScroll` like the others, but it is deliberately *not* a `scroll.write`
    // — it is not a correction, it is a correction already taken being converted from a paint
    // offset back into a real offset. Measured here: two writes, one fold and one re-publish.
    const taken = (await events(page, 'scroll.write')).filter((event) => event.data.took === true)
    const committed = (await events(page, 'scroll.commit')).filter(
      (event) => event.data.refused === false,
    )
    const folded = await events(page, 'gesture.fold')

    expect(taken.length + committed.length + folded.length).toBe((await writes(page)) - baseline)
  })

  test('no write escapes while the gate is shut, and each one says why', async ({ page }) => {
    await open(page, 'debug=1&overlay=0&comment=4211')
    await page.evaluate(() => {
      window.__traceClear()
    })

    // Hold a finger and force every mounted row to re-measure — what a webfont landing looks like,
    // and the provocation the counter test above uses for the same reason.
    await holdFinger(page)
    await page.addStyleTag({ content: '.comment { letter-spacing: 0.45px; word-spacing: 1.5px; }' })
    await page.waitForTimeout(600)

    // Strictly stronger than "the counter did not move": a `model` write is allowed through
    // deliberately, and this distinguishes that from a measurement escaping.
    const escaped = (await events(page, 'scroll.write')).filter(
      (event) => event.data.took === true && event.data.reason !== 'model',
    )
    expect(escaped).toEqual([])
    const committed = (await events(page, 'scroll.commit')).filter(
      (event) => event.data.refused === false,
    )
    expect(committed).toEqual([])
  })

  test('a banked correction never exceeds the room it was measured against', async ({ page }) => {
    // The bound `writeScroll` promises, asserted rather than trusted. A bank larger than the scroll
    // range on that side means the reader hits a wall short of the end and the fold has nowhere to
    // land.
    await open(page, 'debug=1&overlay=0&comment=4211')
    await page.evaluate(() => {
      window.__traceClear()
    })

    await holdFinger(page)
    await page.addStyleTag({ content: '.comment { letter-spacing: 0.6px; }' })
    await fling(page, { frames: 20 })
    await page.waitForTimeout(800)

    for (const event of await events(page, 'scroll.write')) {
      if (event.data.took === true) continue
      expect(Math.abs(Number(event.data.heldAfter))).toBeLessThanOrEqual(Number(event.data.room))
    }
  })

  test('the fold is continuous, and nothing is left held afterwards', async ({ page }) => {
    // Two claims the code makes about itself in prose. `reconcileGestureShift` says both halves
    // land in one task so nothing paints between them; `commitScroll` says a correction can never
    // exceed the content above it, so the fold's target cannot leave the scrollable range. The
    // second has a gap — `room` was checked per deferral, against an offset the fling has since
    // moved — and precisely because it is asserted in a comment, nothing would report it broken.
    await open(page, 'debug=1&overlay=0&comment=4211')
    await page.evaluate(() => {
      window.__traceClear()
    })

    await holdFinger(page)
    await page.addStyleTag({ content: '.comment { letter-spacing: 0.45px; }' })
    await fling(page, { frames: 20 })
    await page.waitForTimeout(1000)

    for (const fold of await events(page, 'gesture.fold')) {
      const { from, shift, carryBefore, applied, carryAfter, clamped } = fold.data
      expect(clamped).toBe(false)
      const before = Number(from) + Number(shift) + Number(carryBefore)
      const after = Number(applied) + Number(carryAfter)
      expect(Math.abs(before - after)).toBeLessThanOrEqual(TOLERANCE)
    }

    // "Nothing held while the gate is open" is an invariant, not an intention.
    const paint = await events(page, 'paint.offset')
    if (paint.length > 0) {
      expect(Math.abs(Number(paint[paint.length - 1]?.data.shift))).toBeLessThanOrEqual(TOLERANCE)
    }
  })

  test('a prepend is reported as the deliberate override it is', async ({ page }) => {
    await open(page, 'debug=1&overlay=0&comment=4211')
    await page.evaluate(() => {
      window.__traceClear()
    })

    await holdFinger(page)
    await page.evaluate(() => window.__list.insert('above', 20))
    await page.waitForTimeout(600)

    const model = (await events(page, 'scroll.write')).filter(
      (event) => event.data.reason === 'model',
    )
    expect(model.length).toBeGreaterThan(0)
    expect(model.every((event) => event.data.took === true)).toBe(true)
  })

  test('reports what it saw, without asserting the speed of the machine', async ({ page }) => {
    // Gap statistics are reported and never asserted. `af282b8` — "stop asserting the speed of the
    // machine" — is the precedent: a CI runner under load produces gaps a developer's laptop never
    // will, and a threshold here would fail for the wrong reason. What is asserted is only that the
    // analyzer produced a verdict at all, so the diagnosis path itself stays exercised.
    await open(page, 'debug=1&overlay=0&comment=4211')
    await page.evaluate(() => {
      window.__traceClear()
    })

    await fling(page, { frames: 25 })
    await page.waitForTimeout(800)

    const verdict = await page.evaluate(() => window.__verdict())
    expect(verdict).not.toBeNull()
    expect(verdict?.gate).toBe('ios')

    // Named rather than joined-and-hoped: an empty list joins to the empty string, which in a CI
    // log reads as a missing value rather than as "nothing found".
    const found = verdict?.suspects.map((suspect) => suspect.id) ?? []
    console.log(
      `[fling] scrolls ${String(verdict?.scrolls)}  worst gap ${String(verdict?.worstScrollGapMs)}ms  ` +
        `writes ${String(verdict?.writes.taken)} taken / ${String(verdict?.writes.held)} held  ` +
        `held peak ${String(verdict?.heldPeak)}px  ` +
        `suspects ${found.length > 0 ? found.join(',') : 'none'}`,
    )
  })
})
