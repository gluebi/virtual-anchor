import { describe, expect, it, vi } from 'vitest'
import { type AnchorGeometry } from './anchor.js'
import { createScroller, type Scroller } from './scroller.js'
import { SizeCache } from './sizeCache.js'
import type { ItemKey, ScrollResult } from './types.js'
import type { Viewport } from './viewport.js'

const keysFor = (n: number): ItemKey[] =>
  Array.from({ length: n }, (_, i) => `c${String(i)}`)

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
    getContentClientTop: () => 0,
    addEventListener: () => () => {},
    getElement: () => null,
    getWindow: () => null,
    getDevicePixelRatio: () => 1,
  }
  return viewport
}

/** Drives the scroller's rAF loop manually so tests control every frame. */
interface Harness {
  scroller: Scroller
  viewport: FakeViewport
  cache: SizeCache
  /** Run queued frames, advancing the clock by 16ms each. */
  frames: (count: number) => void
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
    frames: (n) => {
      for (let i = 0; i < n; i++) {
        const pendingFrames = queue
        queue = []
        clock += 16
        for (const frame of pendingFrames) frame()
      }
    },
  }
}

/** Runs frames until the promise settles, or gives up. */
const settle = async (h: Harness, promise: Promise<ScrollResult>): Promise<ScrollResult> => {
  // A box rather than a `let`: TypeScript narrows a captured boolean to its literal
  // initialiser, so `!done` reads as always-true even though the promise flips it.
  const state = { done: false }
  const tracked = promise.then((result) => {
    state.done = true
    return result
  })
  for (let i = 0; i < 400 && !state.done; i++) {
    h.frames(1)
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
      iterations: 0,
      reason: 'empty',
    })
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
    h.scroller.notifyMeasured()

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
      h.scroller.notifyMeasured()
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
    h.scroller.notifyMeasured()

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
      h.scroller.notifyMeasured()
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
    expect(h.viewport.offset).toBe(1000)
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
    h.scroller.notifyMeasured()
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
    h.scroller.notifyMeasured()

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
