import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AnchorGeometry } from './anchor.js'
import { createScroller, type Scroller } from './scroller.js'
import { setTraceSink, type TraceEvent } from './trace.js'
import { SizeCache } from './sizeCache.js'
import type { ItemKey, ScrollResult } from './types.js'
import type { Viewport } from './viewport.js'

const keysFor = (n: number, prefix = 'c'): ItemKey[] =>
  Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`)

interface FakeViewport extends Viewport {
  /** Simulate an engine that snaps scroll offsets to whole pixels. */
  snap: number
  offset: number
  writes: number[]
}

const fakeViewport = (
  options: {
    size?: number
    /** Fixed maximum. Omit to have it follow the content, as a browser does. */
    max?: number
    getMax?: () => number
    snap?: number
    /** Raised where the half-pixel convergence tolerance is the point of the test. */
    devicePixelRatio?: number
  } = {},
): FakeViewport => {
  const state = {
    snap: options.snap ?? 0,
    offset: 0,
    writes: [] as number[],
  }
  const size = options.size ?? 600
  // A real scroller's maximum tracks its content height, so the fake does too —
  // a fixed maximum would hide clamping bugs rather than expose them.
  const maxOf = (): number => options.getMax?.() ?? options.max ?? 100_000

  const viewport: FakeViewport = {
    ...state,
    getScrollOffset: () => viewport.offset,
    getViewportSize: () => size,
    getMaxScrollOffset: maxOf,
    setScrollOffset: (next) => {
      viewport.writes.push(next)
      const clamped = Math.min(Math.max(next, 0), maxOf())
      // A snap of 1 truncates to whole pixels, as WebKit does.
      viewport.offset =
        viewport.snap > 0 ? Math.floor(clamped / viewport.snap) * viewport.snap : clamped
    },
    addEventListener: () => () => {},
    observeSize: () => () => {},
    getGateTarget: () => null,
    getElement: () => null,
    getScrollportElement: () => null,
    getWindow: () => null,
    getDevicePixelRatio: () => options.devicePixelRatio ?? 1,
  }
  return viewport
}

/** Drives the scroller's rAF loop manually so tests control every frame. */
interface Harness {
  scroller: Scroller
  viewport: FakeViewport
  cache: SizeCache
  /** Run queued frames, advancing the clock by `msPerFrame` each — 16ms by default. */
  frames: (count: number, msPerFrame?: number) => void
  advance: (ms: number) => void
  carries: number[]
  scrollingChanges: boolean[]
}

const harness = (
  options: {
    count?: number
    itemSize?: number
    geometry?: AnchorGeometry
    viewport?: FakeViewport
  } = {},
): Harness => {
  const count = options.count ?? 1000
  const itemSize = options.itemSize ?? 100
  const cache = new SizeCache({ keys: keysFor(count), defaultEstimate: itemSize })
  const viewport =
    options.viewport ??
    fakeViewport({ getMax: () => Math.max(0, cache.totalSize() - 600) })
  const carries: number[] = []
  const scrollingChanges: boolean[] = []

  let clock = 0
  let queue: (() => void)[] = []

  const scroller = createScroller({
    viewport,
    getCache: () => cache,
    getGeometry: () => options.geometry ?? {},
    applyCarry: (carry) => carries.push(carry),
    onScrollingChange: (scrolling) => scrollingChanges.push(scrolling),
    now: () => clock,
    requestFrame: (callback) => {
      queue.push(callback)
      return queue.length
    },
    cancelFrame: () => {
      queue = []
    },
  })

  return {
    scroller,
    viewport,
    cache,
    carries,
    scrollingChanges,
    advance: (ms) => {
      clock += ms
    },
    frames: (n, msPerFrame = 16) => {
      for (let i = 0; i < n; i++) {
        const pendingFrames = queue
        queue = []
        clock += msPerFrame
        for (const frame of pendingFrames) frame()
      }
    },
  }
}

/**
 * Runs frames until the promise settles, or gives up.
 *
 * `onFrame` runs before each one, for the tests whose subject is a list that keeps moving —
 * it is also how a caller counts the frames the loop was given, which is the measure the
 * deadlines are denominated in.
 */
const settle = async (
  h: Harness,
  promise: Promise<ScrollResult>,
  options: { msPerFrame?: number; limit?: number; onFrame?: () => void } = {},
): Promise<ScrollResult> => {
  const { msPerFrame = 16, limit = 400, onFrame } = options
  // A box rather than a `let`: TypeScript narrows a captured boolean to its literal
  // initialiser, so `!done` reads as always-true even though the promise flips it.
  const state = { done: false }
  const tracked = promise.then((result) => {
    state.done = true
    return result
  })
  for (let i = 0; i < limit && !state.done; i++) {
    onFrame?.()
    h.frames(1, msPerFrame)
    await Promise.resolve()
  }
  return tracked
}

describe('scrollToIndex alignment', () => {
  it('puts the item top at the viewport top for align start', async () => {
    const h = harness()
    const result = await settle(h, h.scroller.scrollToIndex(42, { align: 'start' }))

    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(4200)
  })

  it('puts the item bottom at the viewport bottom for align end', async () => {
    const h = harness({ count: 1000, itemSize: 100 })
    await settle(h, h.scroller.scrollToIndex(42, { align: 'end' }))

    // Item 42 spans [4200, 4300); a 600px viewport ending at 4300 starts at 3700.
    expect(h.viewport.offset).toBe(3700)
  })

  it('centres the item for align center', async () => {
    const h = harness()
    await settle(h, h.scroller.scrollToIndex(42, { align: 'center' }))

    // Item centre 4250, viewport centre 300 → 3950.
    expect(h.viewport.offset).toBe(3950)
  })

  it('does not move an already-visible item for align auto', async () => {
    const h = harness()
    h.viewport.offset = 4000

    const result = await settle(h, h.scroller.scrollToIndex(41, { align: 'auto' }))
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(4000)
  })

  it('scrolls up to reach an item above for align auto', async () => {
    const h = harness()
    h.viewport.offset = 4000
    await settle(h, h.scroller.scrollToIndex(10, { align: 'auto' }))
    expect(h.viewport.offset).toBe(1000)
  })

  it('scrolls down to reach an item below for align auto', async () => {
    const h = harness()
    h.viewport.offset = 0
    await settle(h, h.scroller.scrollToIndex(20, { align: 'auto' }))
    // Item 20 spans [2000, 2100); aligned to the bottom of a 600px viewport.
    expect(h.viewport.offset).toBe(1500)
  })

  it('applies an extra offset', async () => {
    const h = harness()
    await settle(h, h.scroller.scrollToIndex(42, { align: 'start', offset: -8 }))
    expect(h.viewport.offset).toBe(4192)
  })

  it('clears a sticky header', async () => {
    const h = harness({ geometry: { scrollPaddingStart: 60 } })
    await settle(h, h.scroller.scrollToIndex(42, { align: 'start' }))

    // The item must land 60px down, so the scroll offset is 60px less.
    expect(h.viewport.offset).toBe(4140)
  })

  it('accounts for content above the list', async () => {
    const h = harness({ geometry: { scrollMargin: 500 } })
    await settle(h, h.scroller.scrollToIndex(42, { align: 'start' }))
    expect(h.viewport.offset).toBe(4700)
  })

  it('accounts for chrome at the bottom when aligning to the end', async () => {
    const h = harness({ geometry: { scrollPaddingEnd: 100 } })
    await settle(h, h.scroller.scrollToIndex(42, { align: 'end' }))

    // Visible area is 500px, so the item's bottom sits at 4300 → offset 3800.
    expect(h.viewport.offset).toBe(3800)
  })

  it('uses the browser maximum for the last item aligned to the end', async () => {
    // Borders and padding outside the list still occupy scrollable space, so our
    // own measurements would land a pixel or two short.
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({ viewport })

    await settle(h, h.scroller.scrollToIndex(999, { align: 'end' }))
    expect(h.viewport.offset).toBe(99_999.5)
  })

  it('stops at the last item rather than the footer below it', async () => {
    // The end shortcut asks the browser for its maximum, which with a footer is past
    // the last item by the footer's height — so taking it would leave the comment
    // that far off the top of the screen. A non-zero `spaceAfter` says the trailing
    // content has been measured, so the general case handles this item like any
    // other: item 999 spans [99_900, 100_000), aligned to the bottom of a 600px
    // viewport.
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({ viewport, geometry: { spaceAfter: 280 } })

    await settle(h, h.scroller.scrollToIndex(999, { align: 'end' }))
    expect(h.viewport.offset).toBe(99_400)
  })

  it('does not park the last item behind a sticky footer', async () => {
    // A sticky footer is in-flow content *and* overlapping chrome, so it lands in
    // `spaceAfter` and in `scrollPaddingEnd` both. An earlier attempt subtracted
    // only `spaceAfter` from the browser's maximum, which counts the composer twice
    // and puts the last comment exactly one composer-height too low — behind it.
    // The Playwright suite caught that at 80.25px in all three engines.
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({
      viewport,
      // 200px footer plus an 80px composer below the list; the composer also covers
      // the bottom 80px of the scrollport, leaving 520px of usable height.
      geometry: { spaceAfter: 280, scrollPaddingEnd: 80 },
    })

    await settle(h, h.scroller.scrollToIndex(999, { align: 'end' }))
    expect(h.viewport.offset).toBe(99_480)
  })

  it('does not scroll past the top when the footer is taller than the range', async () => {
    // A short list with a tall footer: the whole scrollable range is footer. Nothing
    // to align to, and negative is not an offset.
    const viewport = fakeViewport({ max: 200 })
    const h = harness({ viewport, count: 3, geometry: { spaceAfter: 900 } })

    await settle(h, h.scroller.scrollToIndex(2, { align: 'end' }))
    expect(h.viewport.offset).toBe(0)
  })

  it('leaves a footer out of the arithmetic for every other item', async () => {
    // `spaceAfter` decides whether the last item may take the browser-maximum
    // shortcut and nothing else. It is below every item, so it cannot move where any
    // of them sits — including the last one, once the shortcut is off.
    const withFooter = harness({ geometry: { spaceAfter: 400 } })
    const without = harness()

    await settle(withFooter, withFooter.scroller.scrollToIndex(42, { align: 'end' }))
    await settle(without, without.scroller.scrollToIndex(42, { align: 'end' }))
    expect(withFooter.viewport.offset).toBe(without.viewport.offset)
  })

  it('clamps a target beyond the scrollable range', async () => {
    const viewport = fakeViewport({ max: 5000 })
    const h = harness({ viewport })

    await settle(h, h.scroller.scrollToIndex(900, { align: 'start' }))
    expect(h.viewport.offset).toBe(5000)
  })

  it('clamps a negative target to zero', async () => {
    const h = harness()
    await settle(h, h.scroller.scrollToIndex(0, { align: 'start', offset: -500 }))
    expect(h.viewport.offset).toBe(0)
  })

  it('clamps an out-of-range index', async () => {
    // Ten 100px items in a 600px viewport can only scroll 400px, so asking for
    // item 9999 resolves to the last item and then to the end of the scroller —
    // clamped in the browser's space, not against our estimated total.
    const h = harness({ count: 10 })
    await settle(h, h.scroller.scrollToIndex(9999, { align: 'start' }))
    expect(h.viewport.offset).toBe(h.viewport.getMaxScrollOffset())
    expect(h.viewport.offset).toBe(400)

    await settle(h, h.scroller.scrollToIndex(-5, { align: 'start' }))
    expect(h.viewport.offset).toBe(0)
  })

  it('resolves immediately for an empty list rather than hanging', async () => {
    const cache = new SizeCache({ keys: [] })
    const viewport = fakeViewport()
    const scroller = createScroller({
      viewport,
      getCache: () => cache,
      getGeometry: () => ({}),
      applyCarry: () => {},
    })

    await expect(scroller.scrollToIndex(0)).resolves.toEqual({
      settled: false,
      deviation: 0,
      clamped: false,
      iterations: 0,
      reason: 'empty',
    })
  })
})

describe('a target outside the scrollable range', () => {
  /**
   * Ten 100px items in a 600px viewport: 1000px of content, so the maximum offset is 400
   * and item 8 (top 800) cannot be brought to the top. The scroller is right to stop at
   * 400 — this is a reachability limit, not a convergence failure — but it used to
   * describe that landing with `deviation: 0`, which is the same answer a flush landing
   * gives. The clamp is kept; what changed is that the request survives long enough to be
   * compared against. See #101.
   */
  it('reports the distance to the target it was asked for, not to the one it could reach', async () => {
    const h = harness({ count: 10, itemSize: 100 })
    expect(h.viewport.getMaxScrollOffset()).toBe(400)

    const result = await settle(h, h.scroller.scrollToIndex(8, { align: 'start' }))

    expect(h.viewport.offset).toBe(400)
    // The row sits 400px below the top of the viewport, and now says so.
    expect(800 - h.viewport.offset).toBe(400)
    expect(result).toEqual({
      settled: true,
      deviation: 400,
      clamped: true,
      iterations: 0,
      reason: 'converged',
    })
  })

  it('keeps settled true, because motion did stop with the target holding still', async () => {
    // `settled` answers "did it come to rest", `reason` answers "why did it stop", and
    // neither of them changes meaning here. A consumer that wants to know whether the row
    // is where it asked reads `deviation` and `clamped`.
    const h = harness({ count: 10, itemSize: 100 })

    const result = await settle(h, h.scroller.scrollToIndex(9, { align: 'start' }))

    expect(result.settled).toBe(true)
    expect(result.reason).toBe('converged')
    expect(result.clamped).toBe(true)
  })

  it('reports a negative deviation for a target clamped against the top', async () => {
    const h = harness({ count: 10, itemSize: 100 })

    const result = await settle(h, h.scroller.scrollToIndex(0, { align: 'start', offset: -500 }))

    expect(h.viewport.offset).toBe(0)
    // Asked for -500, got 0: the content is 500px *below* where it was asked to be, and
    // the sign says which way.
    expect(result.deviation).toBe(-500)
    expect(result.clamped).toBe(true)
  })

  it('reports a clamped landing for center near the end of the list', async () => {
    // Item 9 spans [900, 1000); centred in a 600px viewport it would want 900 + 50 - 300
    // = 650, which is 250 past the maximum.
    const h = harness({ count: 10, itemSize: 100 })

    const result = await settle(h, h.scroller.scrollToIndex(9, { align: 'center' }))

    expect(h.viewport.offset).toBe(400)
    expect(result.deviation).toBe(250)
    expect(result.clamped).toBe(true)
  })

  it('does not call the last item aligned to the end a clamp', async () => {
    // The one alignment where the maximum *is* the answer rather than a limit on it:
    // `requestedTargetFor` returns it directly, so the two coincide legitimately and the
    // deviation must stay exactly zero.
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({ viewport })

    const result = await settle(h, h.scroller.scrollToIndex(999, { align: 'end' }))

    expect(h.viewport.offset).toBe(99_999.5)
    expect(result.deviation).toBe(0)
    expect(result.clamped).toBe(false)
  })

  it('does not call an already-visible item under align auto a clamp', async () => {
    // `auto` returns the current offset when the item is fully visible. That is not a
    // clamp and must not start reporting as one.
    const h = harness({ count: 10, itemSize: 100 })

    const result = await settle(h, h.scroller.scrollToIndex(1, { align: 'auto' }))

    expect(h.viewport.offset).toBe(0)
    expect(result.deviation).toBe(0)
    expect(result.clamped).toBe(false)
  })

  it('applies offset to the last item aligned to the end, rather than dropping it', async () => {
    // The end shortcut returned the browser maximum and discarded `extra` entirely, so an
    // `offset` passed with this alignment on this item did nothing at all — and reported
    // deviation 0 while doing it. Lifting the last comment clear of a footer is the
    // request that wants this.
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({ viewport })

    const result = await settle(h, h.scroller.scrollToIndex(999, { align: 'end', offset: -50 }))

    expect(h.viewport.offset).toBe(99_949.5)
    // Reachable, so this is a landing like any other.
    expect(result.deviation).toBe(0)
    expect(result.clamped).toBe(false)
  })

  it('reports an offset that pushes the last item past the end as clamped', async () => {
    const viewport = fakeViewport({ max: 99_999.5 })
    const h = harness({ viewport })

    const result = await settle(h, h.scroller.scrollToIndex(999, { align: 'end', offset: 50 }))

    expect(h.viewport.offset).toBe(99_999.5)
    expect(result.deviation).toBe(50)
    expect(result.clamped).toBe(true)
  })
})

describe('scrollToIndex convergence', () => {
  it('re-aims as measurements correct the estimates', async () => {
    const h = harness({ count: 1000, itemSize: 100 })

    const promise = h.scroller.scrollToIndex(500, { align: 'start' })
    // First aim, from pure estimates.
    expect(h.viewport.offset).toBe(50_000)

    // The items above turn out to be much taller than estimated.
    for (let i = 0; i < 500; i++) h.cache.setSize(i, 300)
    h.scroller.notifyModelChanged()

    const result = await settle(h, promise)
    expect(result.settled).toBe(true)
    // 500 items at 300px each.
    expect(h.viewport.offset).toBe(150_000)
    expect(result.iterations).toBeGreaterThan(0)
  })

  it('keeps re-aiming while measurements keep arriving', async () => {
    const h = harness({ count: 1000, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(500)

    // Measurements trickle in over several rounds.
    for (let round = 0; round < 5; round++) {
      for (let i = round * 100; i < (round + 1) * 100; i++) h.cache.setSize(i, 200)
      h.scroller.notifyModelChanged()
      h.frames(2)
    }

    const result = await settle(h, promise)
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(100_000)
  })

  it('reports how many times it re-aimed', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)
    h.cache.setSize(3, 900)
    h.scroller.notifyModelChanged()

    const result = await settle(h, promise)
    expect(result.iterations).toBeGreaterThanOrEqual(1)
  })

  it('settles without re-aiming when the estimates were already right', async () => {
    const h = harness()
    for (let i = 0; i < 1000; i++) h.cache.setSize(i, 100)

    const result = await settle(h, h.scroller.scrollToIndex(42))
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(4200)
  })

  it('reports unsettled rather than hanging when the list never holds still', async () => {
    // An item that resizes every single frame can never converge. Reporting that
    // honestly is the point: every existing library claims success instead.
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)

    let size = 100
    const state = { done: false }
    const tracked = promise.then((r) => {
      state.done = true
      return r
    })

    for (let i = 0; i < 500 && !state.done; i++) {
      size += 1
      h.cache.setSize(3, size)
      h.scroller.notifyModelChanged()
      h.frames(1)
      await Promise.resolve()
    }

    const result = await tracked
    expect(result.settled).toBe(false)
    expect(Number.isFinite(result.deviation)).toBe(true)
  })

  it('settles when the write changes nothing', async () => {
    // No scroll event fires when the offset does not change. An event-driven
    // settle would hang here; a frame-driven one does not need a special case.
    const h = harness()
    h.viewport.offset = 4200

    const result = await settle(h, h.scroller.scrollToIndex(42, { align: 'start' }))
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(4200)
  })

  it('settles for content that cannot scroll at all', async () => {
    const viewport = fakeViewport({ max: 0 })
    const h = harness({ count: 3, viewport })

    const result = await settle(h, h.scroller.scrollToIndex(2))
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(0)
  })

  it('resolves without waiting when everything is already measured', async () => {
    // A fully measured list has nothing to converge towards, so making the caller
    // wait out the quiet period would only delay their highlight.
    const h = harness({ count: 20 })
    for (let i = 0; i < 20; i++) h.cache.setSize(i, 100)

    const result = await h.scroller.scrollToIndex(10, { align: 'start' })
    expect(result.settled).toBe(true)
    expect(result.deviation).toBe(0)
    expect(result.clamped).toBe(false)
    expect(h.viewport.offset).toBe(1000)
  })
})

describe('a main thread that stops delivering frames', () => {
  /**
   * How many frames a list that will never hold still is given before the loop gives up.
   *
   * The measure that matters for #92: the deadlines are budgets of the loop's own effort, so the
   * number of frames it gets before reporting one must not fall away as the gaps between them
   * grow. `msPerFrame` is the only variable.
   *
   * The row above the destination grows by 40px a frame — comfortably past any convergence
   * tolerance, so "the target moved" is never a judgement call — and deliberately *without*
   * `notifyModelChanged`. The loop re-resolves its target from the live cache every frame, so it
   * sees the movement either way; what leaving the notification out does is hold the quiet window
   * still, and that is a second clock with a second job. Notifying would put `MODEL_QUIET_MS`
   * between the frame rates being compared and decide which deadline fires rather than how much
   * of one the loop was given.
   */
  const framesUntilDeadline = async (
    msPerFrame: number,
  ): Promise<{ frames: number; result: ScrollResult }> => {
    const h = harness()
    let size = 100
    let given = 0

    const result = await settle(h, h.scroller.scrollToIndex(500), {
      msPerFrame,
      limit: 600,
      onFrame: () => {
        size += 40
        h.cache.setSize(3, size)
        given++
      },
    })
    return { frames: given, result }
  }

  it('converges after a block that outlasts the hard deadline', async () => {
    // The reproduction from #92: the clock runs past `HARD_DEADLINE_MS` with no frame delivered,
    // which in a browser is one long task between the call and the first frame.
    const h = harness({ count: 1000, itemSize: 100 })

    const promise = h.scroller.scrollToIndex(500, { align: 'start' })
    // The first aim, from estimates. A windowed list's offset is a sum of them, so this is
    // wrong by the estimator's error and the convergence loop is what corrects it.
    expect(h.viewport.offset).toBe(50_000)
    for (let i = 0; i < 500; i++) h.cache.setSize(i, 300)
    h.scroller.notifyModelChanged()

    // 8 seconds, past `HARD_DEADLINE_MS`, before `step` runs once.
    h.advance(8000)

    const result = await settle(h, promise)
    // On wall-clock deadlines this resolved `{ settled: false, reason: 'deadline',
    // iterations: 0 }` — `iterations: 0` being the tell that the loop never ran — and left the
    // view at the first aim. That is the consumer's 95px, uncorrected.
    expect(result.settled).toBe(true)
    expect(result.reason).toBe('converged')
    expect(result.iterations).toBeGreaterThan(0)
    expect(h.viewport.offset).toBe(150_000)
  })

  it('gives a device with long gaps as many chances as one at the cap', async () => {
    // The claim the credit makes, as a comparison rather than a threshold: 100ms frames are
    // charged in full, 250ms frames are charged 100ms each, so the slower run takes two and a
    // half times the wall clock and gets the same number of frames to converge in. Uncredited it
    // got two fifths of them — which is how four WebKit landings on a loaded CI runner ended
    // 300–580px short, reporting `deadline` honestly for a scroll that ran out of frames.
    const atCap = await framesUntilDeadline(100)
    const beyondCap = await framesUntilDeadline(250)

    expect(atCap.result.reason).toBe('deadline')
    expect(beyondCap.result.reason).toBe('deadline')
    // Which is also the statement that the budget is spent in frames and not in seconds: the same
    // count at two and a half times the gap is two and a half times the wall clock.
    expect(beyondCap.frames).toBeGreaterThan(atCap.frames * 0.9)
  })

  it('charges an ordinary frame rate in full', async () => {
    // The other half, and the reason the credit is only ever the excess: a list that will not
    // hold still while frames arrive perfectly normally is the case the deadlines exist for, and
    // it still spends its budget over ~2 seconds of 16ms frames rather than being forgiven them.
    // One that credited these would not bound anything.
    const steady = await framesUntilDeadline(16)

    expect(steady.result.reason).toBe('deadline')
    // Over a hundred 16ms frames, which is `SOFT_DEADLINE_MS` of them and about 2s of wall clock.
    expect(steady.frames).toBeGreaterThan(100)
  })
})

describe('scrollToIndex sub-pixel landing', () => {
  it('carries the fraction an integer-only engine refuses', async () => {
    // WebKit truncates scrollTop. Without the carry the landing is up to a whole
    // pixel short of the target, which fails a strict half-pixel criterion.
    const viewport = fakeViewport({ snap: 1 })
    const h = harness({ viewport, itemSize: 100.5 })
    for (let i = 0; i < 1000; i++) h.cache.setSize(i, 100.5)

    await settle(h, h.scroller.scrollToIndex(3, { align: 'start' }))

    // Target 301.5, engine takes 301, so 0.5 is carried visually.
    expect(h.viewport.offset).toBe(301)
    expect(h.carries.at(-1)).toBeCloseTo(0.5, 6)
  })

  it('carries nothing when the write lands exactly', async () => {
    const h = harness()
    await settle(h, h.scroller.scrollToIndex(42))
    expect(h.carries.at(-1)).toBe(0)
  })

  it('converges on a truncating engine at dPR 2, where the carry is all of the landing', async () => {
    // Why the default content offset includes the carry this scroller applied. The arrival
    // test no longer re-derives it from the residual — `carryFor` returns the whole residual
    // below `MAX_CARRY` and zero above it, so that form accepted anything within a pixel
    // whatever the tolerance said — and reads where the content is instead. Drop the carry
    // from that read and a 0.75px truncation it has already made good cannot satisfy a
    // 0.5px tolerance: this resolves `deadline` rather than converging.
    const viewport = fakeViewport({ snap: 1, devicePixelRatio: 2 })
    const h = harness({ viewport, itemSize: 100.75 })
    // All but the last, so the fully-measured fast path does not resolve this before the
    // convergence loop has run a frame — the arrival test is the read under examination.
    for (let i = 0; i < 999; i++) h.cache.setSize(i, 100.75)

    const result = await settle(h, h.scroller.scrollToIndex(1, { align: 'start' }))

    expect(result.reason).toBe('converged')
    expect(result.deviation).toBe(0)
    // A sub-pixel landing is not a clamp: the target was always reachable, the engine
    // just would not take the fraction. Distinguishing the two is the point of the flag.
    expect(result.clamped).toBe(false)
    // The platform took 100 and the carry moved the content the remaining 0.75.
    expect(h.viewport.offset).toBe(100)
    expect(h.carries.at(-1)).toBeCloseTo(0.75, 6)
  })

  it('refuses to carry a whole-pixel discrepancy', async () => {
    // A large difference means something else moved the scroll — usually a clamp
    // against a sizer that has not grown yet. Carrying it would shove the content.
    const viewport = fakeViewport({ max: 1000 })
    const h = harness({ viewport })

    await settle(h, h.scroller.scrollToIndex(500))
    expect(h.carries.every((c) => Math.abs(c) <= 1)).toBe(true)
  })
})

describe('scrollToIndex interruption', () => {
  it('is not cancelled by a scroll offset it does not recognise', async () => {
    // The browser moves `scrollTop` on its own more than it appears: clamping it
    // when content shrinks, adjusting it when a window of items is replaced. Those
    // are indistinguishable from a user drag by offset alone, so treating an
    // unrecognised offset as input cancels scrolls nobody asked to cancel.
    // Cancellation is driven by real input events instead — see the DOM tests.
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)

    h.viewport.offset = 900
    expect(h.scroller.notifyScroll(900)).toBe(false)
    expect(h.scroller.isScrolling()).toBe(true)

    await settle(h, promise)
  })

  it('recognises its own echo even after a second write', async () => {
    // Scroll events are delivered asynchronously, so two writes in one task
    // produce their events later. A single remembered offset would only match the
    // second, and the first would look like user input.
    const h = harness()
    const promise = h.scroller.scrollToIndex(42)

    h.scroller.markSelfWrite(1234)
    // The older intent still resolves as self-inflicted.
    expect(h.scroller.notifyScroll(1234)).toBe(true)
    expect(h.scroller.isScrolling()).toBe(true)

    await settle(h, promise)
  })

  it('recognises the echo of its own write and keeps going', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(42)

    // The browser reports back the rounded version of what we asked for.
    const self = h.scroller.notifyScroll(h.viewport.offset)
    expect(self).toBe(true)
    expect(h.scroller.isScrolling()).toBe(true)

    await settle(h, promise)
  })

  it('replaces an in-flight scroll with a new one, resolving the first honestly', async () => {
    const h = harness()
    const first = h.scroller.scrollToIndex(500)
    const second = h.scroller.scrollToIndex(10)

    await expect(first).resolves.toMatchObject({ settled: false })
    await settle(h, second)
    expect(h.viewport.offset).toBe(1000)
  })

  it('resolves an in-flight scroll when cancelled', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)
    h.scroller.cancel()

    await expect(promise).resolves.toMatchObject({ settled: false })
    expect(h.scroller.isScrolling()).toBe(false)
  })

  it('resolves an in-flight scroll on disposal', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)
    h.scroller.dispose()

    await expect(promise).resolves.toMatchObject({ settled: false })
  })

  it('reports the scrolling state so visibility events can be suppressed', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500)
    h.cache.setSize(0, 200)
    h.scroller.notifyModelChanged()
    await settle(h, promise)

    expect(h.scrollingChanges[0]).toBe(true)
    expect(h.scrollingChanges.at(-1)).toBe(false)
  })
})

describe('scrollToIndex smooth behaviour', () => {
  it('asks for the destination to be mounted before animating', () => {
    const requestRange = vi.fn()
    const cache = new SizeCache({ keys: keysFor(1000), defaultEstimate: 100 })
    const viewport = fakeViewport()
    const scroller = createScroller({
      viewport,
      getCache: () => cache,
      getGeometry: () => ({}),
      applyCarry: () => {},
      requestRange,
      now: () => 0,
      requestFrame: () => 0,
      cancelFrame: () => {},
    })

    void scroller.scrollToIndex(500, { behavior: 'smooth' })
    expect(requestRange).toHaveBeenCalledWith(500, 500)
  })

  it('approaches the target over several frames rather than jumping', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500, { behavior: 'smooth' })

    h.frames(1)
    const afterOneFrame = h.viewport.offset
    expect(afterOneFrame).toBeGreaterThan(0)
    expect(afterOneFrame).toBeLessThan(50_000)

    const result = await settle(h, promise)
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(50_000)
  })

  it('absorbs a target that moves mid-animation', async () => {
    const h = harness()
    const promise = h.scroller.scrollToIndex(500, { behavior: 'smooth' })

    h.frames(3)
    // Measurements land while the animation is still running.
    for (let i = 0; i < 500; i++) h.cache.setSize(i, 200)
    h.scroller.notifyModelChanged()

    const result = await settle(h, promise)
    expect(result.settled).toBe(true)
    expect(h.viewport.offset).toBe(100_000)
  })

  it('jumps instantly when reduced motion is preferred', async () => {
    const matchMedia = vi.fn().mockReturnValue({ matches: true })
    vi.stubGlobal('window', { ...globalThis, matchMedia })

    const h = harness()
    const promise = h.scroller.scrollToIndex(500, { behavior: 'smooth' })
    // Instant, not approached: the first write is already the target.
    expect(h.viewport.offset).toBe(50_000)
    await settle(h, promise)

    vi.unstubAllGlobals()
  })
})

describe('a target that moves while the scroll is in flight', () => {
  it('follows the item, not the index it happened to occupy', async () => {
    // Prepending shifts every index. Aiming at the remembered one lands on a different
    // item and reports success: a smooth scroll to comment 6018 with 40 comments
    // prepended mid-flight converged on the row that had inherited index 38, with a
    // deviation of zero. A window that grows upward is the case this library is for.
    const h = harness({ count: 100, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(80, { align: 'start', behavior: 'smooth' })

    h.frames(2)
    // 40 items arrive above, so the target's index becomes 120.
    h.cache.setKeys([...keysFor(40, 'older'), ...keysFor(100)])
    h.scroller.notifyModelChanged()

    const result = await settle(h, promise)

    expect(result.settled).toBe(true)
    // The destination is item 120 now: 120 × 100px.
    expect(h.viewport.getScrollOffset()).toBeCloseTo(12_000, 0)
  })

  it('keeps its last known position if the target leaves the collection', async () => {
    const h = harness({ count: 100, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(50, { align: 'start' })

    h.frames(1)
    // The target key is gone entirely — nothing to re-resolve against.
    h.cache.setKeys(keysFor(100, 'replaced'))
    h.scroller.notifyModelChanged()

    const result = await settle(h, promise)
    // It still ends, at the position it last knew, rather than hanging or aiming at NaN.
    expect(Number.isFinite(result.deviation)).toBe(true)
    expect(Number.isFinite(h.viewport.getScrollOffset())).toBe(true)
  })

  it('treats a structural change as the model moving, not just a measurement', async () => {
    // `scrollend` says the *scrolling* stopped; it says nothing about a target that is
    // still moving because items were inserted. Without invalidating it, the loop can
    // settle in the gap between an insertion and the measurements that follow it.
    const h = harness({ count: 100, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(50, { align: 'start', behavior: 'smooth' })
    h.frames(2)

    h.scroller.notifyModelChanged()
    const result = await settle(h, promise)
    expect(result.settled).toBe(true)
  })
})

describe('the convergence trace', () => {
  afterEach(() => {
    setTraceSink(null)
  })

  it('reports each frame as named fields', async () => {
    // The names matter as much as the values: this is the record a person reads to work
    // out why a landing was wrong, and four of its fields are booleans that would compile
    // fine in the wrong order.
    const steps: TraceEvent[] = []
    setTraceSink((event) => {
      if (event.topic === 'scroll.step') steps.push(event)
    })

    const h = harness({ count: 200, itemSize: 100 })
    await settle(h, h.scroller.scrollToIndex(80, { align: 'start' }))

    expect(steps.length).toBeGreaterThan(0)
    expect(steps[0]?.data).toMatchObject({
      key: 'c80',
      index: 80,
      target: 8000,
      // Both in the space `target` is in: where the content is, and how far it still has
      // to go from there.
      actual: expect.any(Number),
      remaining: expect.any(Number),
      arrived: expect.any(Boolean),
      targetMoved: expect.any(Boolean),
      quiet: expect.any(Boolean),
      settledExternally: expect.any(Boolean),
      stableFrames: expect.any(Number),
      elapsed: expect.any(Number),
    })
  })

  it('reports a credited gap once, with both halves of it', async () => {
    // `gap` and `credited` both, because the ratio is the diagnosis: this is a blocked main
    // thread, where a device merely running at 8fps would report the same event every frame
    // with a `gap` a little over the cap.
    const suspends: TraceEvent[] = []
    setTraceSink((event) => {
      if (event.topic === 'scroll.suspend') suspends.push(event)
    })

    const h = harness({ count: 1000, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(500)
    h.advance(8000)
    await settle(h, promise)

    expect(suspends).toHaveLength(1)
    // The whole 8-second block bar the 100ms of it a frame could plausibly have taken — and
    // `elapsed` is what the deadlines then see, which is that 100ms and not 8 seconds.
    expect(suspends[0]?.data).toMatchObject({ gap: 8016, credited: 7916, elapsed: 100 })
  })

  it('builds nothing when no sink is listening', async () => {
    // The call site asks `isTracing()` rather than `TRACING`, so a development build with
    // no sink attached does not assemble a record per frame.
    const h = harness({ count: 200, itemSize: 100 })
    const sink = vi.fn()
    setTraceSink(sink)
    setTraceSink(null)

    await settle(h, h.scroller.scrollToIndex(80, { align: 'start' }))
    expect(sink).not.toHaveBeenCalled()
  })
})

describe('smooth scrolling at different frame rates', () => {
  /** How far a smooth scroll has travelled after a fixed amount of *wall clock*. */
  const distanceAfter = (msPerFrame: number, totalMs: number): number => {
    const h = harness({ count: 1000, itemSize: 100 })
    void h.scroller.scrollToIndex(500, { align: 'start', behavior: 'smooth' })
    h.frames(Math.round(totalMs / msPerFrame), msPerFrame)
    return h.viewport.getScrollOffset()
  }

  it('covers the same ground in the same time at 60fps and at 15fps', () => {
    // A fixed fraction *per frame* ties the animation's duration to the frame rate: the same
    // scroll took twice as long at 30fps, and on a loaded CI runner four WebKit landings ran
    // out of deadline 300–580px short — the loop reporting `deadline` honestly for a scroll
    // that had simply run out of frames. Stepping by elapsed time decouples them.
    const fast = distanceAfter(16, 320)
    const slow = distanceAfter(64, 320)

    expect(fast).toBeGreaterThan(0)
    // Within a tenth: the integration is coarser at 15fps, not slower.
    expect(Math.abs(slow - fast) / fast).toBeLessThan(0.1)
  })

  it('covers all of the distance even at four frames a second', async () => {
    // Twenty frames of easing carry the animation to its target, where the old per-frame
    // fraction covered a third of the distance in the same time.
    //
    // It used to stop just short — 5 seconds at 4fps is twenty frames and the hard deadline
    // took the rest — and it now arrives, because 250ms gaps are charged at
    // `MAX_FRAME_GAP_MS` rather than in full: a device delivering four frames a second gets
    // the same number of them to converge in as one delivering ten, over more wall clock. The
    // deadline is still there and still bounds this; it is measured in the loop's own effort.
    const h = harness({ count: 1000, itemSize: 100 })
    const promise = h.scroller.scrollToIndex(500, { align: 'start', behavior: 'smooth' })
    const result = await settle(h, promise, { msPerFrame: 250, limit: 40 })

    expect(result.reason).toBe('converged')
    expect(h.viewport.getScrollOffset()).toBe(50_000)
  })
})
