import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine, layoutSignatureFor, type Engine } from './engine.js'
import { EMPTY_STATE } from './store.js'
import type { Surface } from './surface.js'
import type { ItemKey, SlotName } from './types.js'
import type { Viewport } from './viewport.js'

/**
 * Integration tests for the engine.
 *
 * This is the module where `scrollMargin`, `scrollPaddingEnd`, `buffer`, `keepMounted`
 * and `sizeSnapshot` stop being arithmetic and start being wiring — and every one of
 * them had previously been tested only where its arithmetic lives, never where it is
 * connected. Predictably, that is where the defects were. These tests assert the wiring:
 * that an option reaches the thing it is supposed to reach, and that the ordering
 * between DOM writes holds.
 */

interface Harness {
  engine: Engine
  unmount: () => void
  /** Everything the surface was asked to draw, in order. */
  writes: string[]
  offset: () => number
  /** The scroller's own maximum, for assertions about the end of the list. */
  maxOffset: () => number
  setOffset: (value: number) => void
  scroll: (value: number) => void
  /** Fire `scrollend`, as the platform does once scrolling has stopped. */
  scrollSettled: () => void
  /** Dispatch a wheel, as a reader reaching for the scroller would. */
  userInput: () => void
  resize: (size: number) => void
  keys: (count: number, prefix?: string) => ItemKey[]
  /** Report a measured size for a key, as a ResizeObserver would. */
  measure: (key: ItemKey, size: number) => void
  viewportSize: number
  contentWidth: number
}

const KEYS = (count: number, prefix = 'c'): ItemKey[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`)

/** A fake ResizeObserver whose deliveries the test drives. */
class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()

  constructor(readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.add(target)
  }
  unobserve(target: Element): void {
    this.observed.delete(target)
  }
  disconnect(): void {
    this.observed.clear()
  }

  static deliverTo(target: Element, blockSize: number): void {
    for (const instance of FakeResizeObserver.instances) {
      if (!instance.observed.has(target)) continue
      instance.callback(
        [
          {
            target,
            borderBoxSize: [{ blockSize, inlineSize: 0 }],
            contentRect: new DOMRect(0, 0, 0, blockSize),
          },
        ] as unknown as ResizeObserverEntry[],
        instance,
      )
    }
  }
}

class FakeIntersectionObserver implements IntersectionObserver {
  readonly scrollMargin = '0px'
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]
  constructor(readonly callback: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
}

const setup = (
  options: Partial<Parameters<typeof createEngine>[0]> & {
    count?: number
    /**
     * Derive the maximum scroll offset from the content, as a browser does.
     *
     * Off by default so the existing tests keep their effectively-unbounded
     * scroller. Anything about the *end* of the list needs it: following writes
     * `getMaxScrollOffset()`, and a constant would have it write the same
     * fictional offset whatever the content did.
     */
    trackContent?: boolean
  } = {},
): Harness => {
  const { count = 50, trackContent = false, ...engineOptions } = options

  const scroller = document.createElement('div')
  const container = document.createElement('div')
  scroller.appendChild(container)
  document.body.appendChild(scroller)

  const state = {
    offset: 0,
    viewportSize: 800,
    contentWidth: 600,
    contentSize: 0,
    leadingSpace: 0,
  }
  const writes: string[] = []
  const elements = new Map<ItemKey, HTMLElement>()
  const scrollListeners: (() => void)[] = []
  /**
   * Kept apart from `scroll`, because the engine now treats them differently:
   * following lets go on a scroll event and takes hold again only once the
   * scrolling has settled. A harness that fired both together could not tell the
   * two apart, and the race that motivated the split would pass unnoticed.
   */
  const scrollEndListeners: (() => void)[] = []
  const sizeListeners: ((size: number) => void)[] = []

  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => state.contentWidth,
  })

  const surface: Surface = {
    setContentSize: (size) => {
      state.contentSize = size
      writes.push(`content:${String(size)}`)
    },
    setLeadingSpace: (px) => {
      state.leadingSpace = px
      writes.push(`lead:${String(px)}`)
    },
    setCarry: (px) => writes.push(`carry:${String(px)}`),
    setGestureShift: (px) => writes.push(`shift:${String(px)}`),
    setItemOffset: (key, offset) => writes.push(`item:${String(key)}@${String(offset)}`),
    attachItem: (key, element) => {
      elements.set(key, element)
      return () => elements.delete(key)
    },
    hasItem: (key) => elements.has(key),
    focusItem: (key) => elements.has(key),
    dispose: () => { elements.clear(); },
  }

  const viewport: Viewport = {
    getScrollOffset: () => state.offset,
    getViewportSize: () => state.viewportSize,
    getMaxScrollOffset: () =>
      trackContent
        ? Math.max(0, state.contentSize + state.leadingSpace - state.viewportSize)
        : 1_000_000,
    setScrollOffset: (next) => {
      // Clamped, as a real scroller clamps: following writes the maximum, and a
      // fake that accepted anything would pass a test the browser would fail.
      state.offset = trackContent
        ? Math.min(Math.max(next, 0), Math.max(0, state.contentSize + state.leadingSpace - state.viewportSize))
        : next
      writes.push(`scroll:${String(next)}`)
    },
    addEventListener: (type, listener) => {
      const list = type === 'scrollend' ? scrollEndListeners : scrollListeners
      list.push(listener)
      return () => {
        const i = list.indexOf(listener)
        if (i >= 0) list.splice(i, 1)
      }
    },
    observeSize: (onResize) => {
      sizeListeners.push(onResize)
      return () => {
        const i = sizeListeners.indexOf(onResize)
        if (i >= 0) sizeListeners.splice(i, 1)
      }
    },
    getGateTarget: () => scroller,
    getElement: () => scroller,
    getScrollportElement: () => scroller,
    getWindow: () => window,
    getDevicePixelRatio: () => 1,
  }

  const engine = createEngine({
    viewport,
    surface,
    keys: KEYS(count),
    defaultEstimate: 100,
    // As the React adapter does: knowing the signature up front means the first
    // scrollport observation is a comparison rather than a first learning.
    layoutSignature: layoutSignatureFor(scroller),
    ...engineOptions,
  })
  const unmount = engine.mount()

  return {
    engine,
    unmount,
    writes,
    offset: () => state.offset,
    maxOffset: () => viewport.getMaxScrollOffset(),
    setOffset: (value) => {
      state.offset = value
    },
    scroll: (value) => {
      state.offset = value
      for (const listener of [...scrollListeners]) listener()
    },
    scrollSettled: () => {
      for (const listener of [...scrollEndListeners]) listener()
    },
    // A real event on the real element, so this exercises the scroller's own
    // listener rather than a stand-in for it.
    userInput: () => {
      scroller.dispatchEvent(new Event('wheel'))
    },
    resize: (size) => {
      state.viewportSize = size
      for (const listener of [...sizeListeners]) listener(size)
    },
    keys: KEYS,
    measure: (key, size) => {
      const element = elements.get(key)
      if (element) FakeResizeObserver.deliverTo(element, size)
    },
    get viewportSize() {
      return state.viewportSize
    },
    set viewportSize(value: number) {
      state.viewportSize = value
    },
    get contentWidth() {
      return state.contentWidth
    },
    set contentWidth(value: number) {
      state.contentWidth = value
    },
  }
}

/**
 * Mount a slot element, as the React adapter's ref callback would.
 *
 * `resize` drives both halves of what a real resize is — the box the element
 * reports and the observer callback announcing it — because the engine measures
 * synchronously on attach and then trusts the observer for everything after.
 */
const mountSlot = (
  h: Harness,
  slot: SlotName,
  height: number,
): { element: HTMLElement; resize: (next: number) => void; detach: () => void } => {
  const element = document.createElement('div')
  const rect = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 600, height))
  document.body.appendChild(element)

  const stop = h.engine.observeSlot(element, slot)
  return {
    element,
    resize: (next) => {
      rect.mockReturnValue(new DOMRect(0, 0, 600, next))
      FakeResizeObserver.deliverTo(element, next)
    },
    detach: stop,
  }
}

/** Mount an element for a key, as the React adapter's ref callback would. */
const mountItem = (h: Harness, key: ItemKey, height: number): HTMLElement => {
  const element = document.createElement('div')
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, height))
  document.body.appendChild(element)
  h.engine.observeItem(element, key)
  return element
}

beforeEach(() => {
  FakeResizeObserver.instances = []
  document.body.replaceChildren()
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('engine option plumbing', () => {
  it('renders a window around the scroll offset, not the whole list', () => {
    const h = setup({ count: 1000 })
    const { renderedRange, visibleRange } = h.engine.store.getState()

    // 800px viewport, 100px estimates, 400px default buffer either side.
    expect(visibleRange).toEqual([0, 8])
    expect(renderedRange[1]).toBeGreaterThan(visibleRange[1])
    expect(renderedRange[1]).toBeLessThan(20)
  })

  it('widens the rendered range with `buffer`', () => {
    const narrow = setup({ count: 1000, buffer: 0 })
    const wide = setup({ count: 1000, buffer: 2000 })

    expect(wide.engine.store.getState().renderedRange[1]).toBeGreaterThan(
      narrow.engine.store.getState().renderedRange[1] + 15,
    )
  })

  it('shifts the visible range by `scrollMargin`', () => {
    // The list starts 500px down the scroller, so at offset 500 the first item is at
    // the top of the visible area. `engine.ts` is the only place this reaches DOM
    // geometry, and it had no test at all.
    const h = setup({ count: 1000, geometry: { scrollMargin: 500 } })
    expect(h.engine.store.getState().visibleRange[0]).toBe(0)

    h.scroll(500)
    expect(h.engine.store.getState().visibleRange[0]).toBe(0)

    h.scroll(1500)
    expect(h.engine.store.getState().visibleRange[0]).toBe(10)
  })

  it('publishes the same range tuple while the range has not moved', () => {
    // Identity is the contract a subscriber compares on, so an unchanged range must be the
    // unchanged *reference*. Without this, `computeRanges` allocated a fresh tuple per publish
    // and every consumer had to compare element-wise instead.
    const h = setup({ count: 1000 })
    const first = h.engine.store.getState()

    // A sub-item nudge: a new state is published — `version` always bumps — with the same range.
    h.scroll(10)
    const nudged = h.engine.store.getState()
    expect(nudged).not.toBe(first)
    expect(nudged.visibleRange).toBe(first.visibleRange)
    expect(nudged.renderedRange).toBe(first.renderedRange)

    // Far enough for the range to genuinely move, which must be a new tuple.
    h.scroll(5000)
    const moved = h.engine.store.getState()
    expect(moved.visibleRange).not.toBe(first.visibleRange)
    expect(moved.visibleRange[0]).toBeGreaterThan(first.visibleRange[0])
  })

  it('keeps one empty-range reference for an empty list', () => {
    // An empty list publishing a fresh `[0, -1]` each time would read as a change on every
    // publish, and the adapter seeds its comparison from `EMPTY_STATE`'s range.
    const h = setup({ count: 0 })
    expect(h.engine.store.getState().visibleRange).toBe(EMPTY_STATE.visibleRange)

    h.scroll(100)
    expect(h.engine.store.getState().visibleRange).toBe(EMPTY_STATE.visibleRange)
  })

  it('starts the visible range below `scrollPaddingStart`', () => {
    const plain = setup({ count: 1000 })
    const withHeader = setup({ count: 1000, geometry: { scrollPaddingStart: 250 } })

    plain.scroll(1000)
    withHeader.scroll(1000)

    // A 250px header means 250px more of the list is above the visible area.
    expect(withHeader.engine.store.getState().visibleRange[0]).toBe(
      plain.engine.store.getState().visibleRange[0] + 2,
    )
  })

  it('shortens the visible range with `scrollPaddingEnd`', () => {
    const plain = setup({ count: 1000 })
    const withFooter = setup({ count: 1000, geometry: { scrollPaddingEnd: 300 } })

    expect(withFooter.engine.store.getState().visibleRange[1]).toBeLessThan(
      plain.engine.store.getState().visibleRange[1],
    )
  })

  it('keeps a consumer-supplied key mounted far outside the range', () => {
    const h = setup({ count: 1000, keepMounted: ['c900'] })
    const keys = h.engine.store.getState().items.map((item) => item.key)

    expect(keys).toContain('c900')
    expect(keys).toContain('c0')
  })

  it('reflects options changed after construction', () => {
    const h = setup({ count: 1000 })
    const before = h.engine.store.getState().renderedRange[1]

    h.engine.setOptions({ buffer: 3000 })
    expect(h.engine.store.getState().renderedRange[1]).toBeGreaterThan(before + 20)
  })

  it('accepts an estimator after construction', () => {
    // The React adapter supplies options only this way, so an estimate read at construction
    // alone is an estimate the component API can never set.
    const h = setup({ count: 1000 })
    // 100px estimates from the harness.
    expect(h.engine.store.getState().totalSize).toBe(100_000)

    h.engine.setOptions({ estimateSize: () => 250 })
    expect(h.engine.store.getState().totalSize).toBe(250_000)
  })

  it('accepts a default estimate after construction', () => {
    const h = setup({ count: 1000 })
    h.engine.setOptions({ defaultEstimate: 40 })
    expect(h.engine.store.getState().totalSize).toBe(40_000)
  })

  it('holds the view when the estimate changes under it', () => {
    // A changed estimate moves every unmeasured item, which in an offset-addressed list drags
    // the viewport with it — react-window's #863. Here the anchor names a key, so re-deriving
    // the offset from it is what keeps the reader where they were.
    const h = setup({ count: 1000 })
    h.scroll(20_000)
    const anchor = h.engine.getAnchor()
    expect(anchor?.key).toBe('c200')

    h.engine.setOptions({ estimateSize: () => 250 })

    // Same comment under the same point of the viewport, at a wholly different offset.
    expect(h.engine.getAnchor()?.key).toBe('c200')
    expect(h.offset()).toBe(50_000)
  })

  it('holds the view when the geometry changes under it', () => {
    // The same class of event, and until the slots arrived `setOptions` did not treat
    // it as one: a changed `geometry` fell through to a publish that re-derived
    // nothing, so the reader was dragged by the difference.
    const h = setup({ count: 1000 })
    h.scroll(20_000)
    const anchor = h.engine.getAnchor()

    h.engine.setOptions({ geometry: { scrollMargin: 500 } })

    expect(h.engine.getAnchor()).toEqual(anchor)
    expect(h.offset()).toBe(20_500)
  })

  it('ignores a geometry object rebuilt with the same numbers', () => {
    // Re-aiming pushes back the convergence loop's quiet window, and a consumer whose
    // geometry object is rebuilt on an unrelated render would keep a smooth
    // `scrollToKey` from ever going quiet — it runs to its 5s hard deadline and
    // reports `deadline` with the scroll still in flight. Seen once per full
    // Playwright run until this compared by value rather than by reference.
    const h = setup({ count: 1000, geometry: { scrollMargin: 500 } })
    h.scroll(20_000)
    h.writes.length = 0

    h.engine.setOptions({ geometry: { scrollMargin: 500 } })

    expect(h.writes.filter((w) => w.startsWith('scroll:'))).toEqual([])
    expect(h.offset()).toBe(20_000)
  })
})

describe('engine DOM write ordering', () => {
  it('writes the content size before any scroll offset', () => {
    // Not incidental: after a prepend the restored offset exceeds the old maximum, and
    // a write past it is silently clamped — a several-hundred-pixel jump with nothing
    // logged anywhere.
    const h = setup({ count: 50 })
    h.writes.length = 0

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(50)] })

    const content = h.writes.findIndex((w) => w.startsWith('content:'))
    const scroll = h.writes.findIndex((w) => w.startsWith('scroll:'))
    expect(content).toBeGreaterThanOrEqual(0)
    if (scroll >= 0) expect(content).toBeLessThan(scroll)
  })

  it('positions every rendered item', () => {
    const h = setup({ count: 20 })
    const positioned = h.writes.filter((w) => w.startsWith('item:'))
    // Nothing is attached yet, so the surface is asked but has no elements — the point
    // is that publish asks for all of them.
    expect(positioned.length).toBeGreaterThan(0)
  })

  it('positions a newly attached item immediately, before any paint', () => {
    const h = setup({ count: 20 })
    h.writes.length = 0

    mountItem(h, 'c5', 100)
    expect(h.writes).toContain('item:c5@500')
  })
})

describe('engine anchoring', () => {
  it('holds the view when items are prepended', () => {
    const h = setup({ count: 50 })
    h.scroll(1000)
    const anchor = h.engine.getAnchor()
    expect(anchor?.key).toBe('c10')

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(50)] })

    // Ten unmeasured items at 100px each went in above, so the offset moves by exactly
    // that and the same comment stays under the same row.
    expect(h.offset()).toBe(2000)
    expect(h.engine.getAnchor()?.key).toBe('c10')
  })

  it('holds the view when an item above the viewport is measured taller', () => {
    const h = setup({ count: 50 })
    h.scroll(1000)

    const element = mountItem(h, 'c2', 400)
    FakeResizeObserver.deliverTo(element, 400)

    // c2 grew by 300px, all of it above the viewport, so the offset follows it.
    expect(h.offset()).toBe(1300)
    expect(h.engine.getAnchor()?.key).toBe('c10')
  })

  it('leaves the offset alone when an item below the viewport is measured', () => {
    const h = setup({ count: 50 })
    h.scroll(1000)

    const element = mountItem(h, 'c40', 900)
    FakeResizeObserver.deliverTo(element, 900)
    expect(h.offset()).toBe(1000)
  })

  it('restores a supplied anchor', () => {
    const h = setup({ count: 50 })
    h.engine.setAnchor({ key: 'c20', offsetWithinItem: 25 })
    expect(h.offset()).toBe(2025)
  })

  it('reports null for an anchor whose key has left the window', () => {
    const h = setup({ count: 50 })
    h.scroll(1000)
    h.engine.setOptions({ keys: KEYS(50, 'different') })

    // Holding position beats jumping to the top.
    expect(h.offset()).toBe(1000)
  })
})

describe('engine measurement invalidation', () => {
  it('discards measurements when the content width changes', () => {
    const h = setup({ count: 50 })
    const element = mountItem(h, 'c0', 250)
    FakeResizeObserver.deliverTo(element, 250)
    expect(h.engine.cache.measuredCount).toBe(1)

    h.contentWidth = 400
    h.resize(800)

    // A width change reflows every line box, so every measurement is stale.
    expect(h.engine.cache.measuredCount).toBe(0)
  })

  it('keeps measurements when only the height changes', () => {
    // A mobile URL bar hiding, devtools opening, a soft keyboard, a vertical drag.
    // None of them reflows a single line box, and discarding the cache for them is both
    // wasteful and — with a restored snapshot — destructive.
    const h = setup({ count: 50 })
    const element = mountItem(h, 'c0', 250)
    FakeResizeObserver.deliverTo(element, 250)
    expect(h.engine.cache.measuredCount).toBe(1)

    h.resize(500)
    expect(h.engine.cache.measuredCount).toBe(1)
  })

  it('survives the scrollport reporting its size for the first time', () => {
    // The C1 regression. A restored snapshot used to be destroyed one frame after mount
    // by the viewport's synthetic first observation, and `lastSizes` then guaranteed the
    // sizes never came back — so the whole feature did nothing.
    const probe = document.createElement('div')
    Object.defineProperty(probe, 'clientWidth', { configurable: true, get: () => 600 })
    document.body.appendChild(probe)
    const signature = layoutSignatureFor(probe)

    const h = setup({
      count: 50,
      sizeSnapshot: {
        version: 1,
        layoutSignature: signature,
        estimate: 100,
        sizes: [
          ['c30', 700],
          ['c31', 800],
        ],
      },
    })
    expect(h.engine.cache.measuredCount).toBe(2)

    h.resize(800)
    expect(h.engine.cache.measuredCount).toBe(2)
    expect(h.engine.cache.sizeOf(30)).toBe(700)
  })

  it('refuses a snapshot measured under a different layout', () => {
    const h = setup({
      count: 50,
      sizeSnapshot: {
        version: 1,
        layoutSignature: 'a-different-layout',
        estimate: 100,
        sizes: [['c30', 700]],
      },
    })
    expect(h.engine.cache.measuredCount).toBe(0)
  })
})

describe('engine scrolling', () => {
  it('reports unknown-key rather than empty for a key outside the window', () => {
    const h = setup({ count: 50 })
    return expect(h.engine.scrollToKey('nope')).resolves.toMatchObject({
      reason: 'unknown-key',
    })
  })

  it('reports empty for a list with no items', () => {
    const h = setup({ count: 0 })
    return expect(h.engine.scrollToKey('nope')).resolves.toMatchObject({ reason: 'empty' })
  })

  it('cancels an in-flight scroll on request', async () => {
    const h = setup({ count: 1000 })
    const promise = h.engine.scrollToIndex(500)
    h.engine.cancelScroll()
    await expect(promise).resolves.toMatchObject({ settled: false, reason: 'cancelled' })
  })

  it('mounts a distant scroll target without mounting everything in between', async () => {
    // The destination has to be mounted to be measured and aimed at. Reaching it by
    // widening the *contiguous* mounted range instead mounts the whole span: a smooth
    // scroll from item 0 to item 7,777 mounted 7,798 rows in one frame, which took 103
    // seconds of a single frame and never scrolled at all.
    const h = setup({ count: 10_000 })
    const promise = h.engine.scrollToIndex(9000, { behavior: 'smooth' })

    const { items, renderedRange } = h.engine.store.getState()
    // Two clusters — the viewport's and the target's — not one span joining them.
    expect(items.length).toBeLessThan(100)
    expect(renderedRange[1]).toBeLessThan(1000)
    expect(items.some((item) => item.index >= 8990 && item.index <= 9010)).toBe(true)
    expect(items.some((item) => item.index === 4500)).toBe(false)

    h.engine.cancelScroll()
    await promise
  })
})

describe('engine visibility', () => {
  it('reports items entering the viewport', () => {
    const events: string[] = []
    const h = setup({
      count: 1000,
      onVisibilityChange: (batch) => {
        for (const e of batch) events.push(`${e.phase}:${String(e.key)}`)
      },
    })
    expect(events).toContain('enter:c0')

    events.length = 0
    h.scroll(5000)
    expect(events).toContain('leave:c0')
    expect(events).toContain('enter:c50')
  })

  it('reports a dwell that completes while nothing else is happening', async () => {
    // Every other sample is driven by an event, and events stop when the user stops. A
    // dwell measured from the last of them was therefore never reached at rest: with
    // `dwellMs: 40`, scrolling to a comment and stopping reported nothing, forever.
    const events: string[] = []
    const h = setup({
      count: 1000,
      visibility: { dwellMs: 40 },
      onVisibilityChange: (batch) => {
        for (const event of batch) events.push(`${event.phase}:${String(event.key)}`)
      },
    })

    h.scroll(5000)
    // Nothing yet — the dwell has only just started.
    expect(events).toEqual([])

    // No further scroll, no measurement, no resize: only time passing.
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(events.some((entry) => entry.startsWith('enter:'))).toBe(true)
  })

  it('holds no timer open once everything visible has been reported', () => {
    // A settled list must not keep re-sampling: the follow-up exists for a pending
    // deadline, and an armed timer with nothing left to wait for would spin forever.
    vi.useFakeTimers()
    try {
      const h = setup({ count: 1000, visibility: { dwellMs: 0 } })
      h.scroll(5000)
      expect(vi.getTimerCount()).toBe(0)
      h.engine.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops a pending visibility timer on dispose', () => {
    vi.useFakeTimers()
    try {
      const h = setup({ count: 1000, visibility: { dwellMs: 500 } })
      h.scroll(5000)
      expect(vi.getTimerCount()).toBe(1)

      h.engine.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exposes per-item visibility and notifies subscribers', () => {
    const h = setup({ count: 1000 })
    expect(h.engine.getVisibility('c0').visible).toBe(true)

    const listener = vi.fn()
    const off = h.engine.subscribeVisibility('c0', listener)
    h.scroll(5000)
    expect(listener).toHaveBeenCalled()

    off()
    listener.mockClear()
    h.scroll(0)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('engine teardown', () => {
  it('removes what mount attached when disposed directly', () => {
    // `dispose()` used to leave mount's scroll, visibilitychange and pagehide listeners
    // attached, keeping the cache, store and tracker reachable — a whole engine retained
    // per disposed list for anyone using the core without the React adapter.
    const h = setup({ count: 50 })
    const removeDoc = vi.spyOn(document, 'removeEventListener')

    h.engine.dispose()
    expect(removeDoc).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  })

  it('is idempotent on mount', () => {
    const h = setup({ count: 50 })
    // A second mount used to add a second scroll listener and orphan the gate behind a
    // teardown closure nobody held.
    expect(h.engine.mount()).toBe(h.unmount)
  })

  it('stops publishing after disposal', () => {
    const h = setup({ count: 50 })
    const version = h.engine.store.getState().version
    h.engine.dispose()

    h.scroll(5000)
    expect(h.engine.store.getState().version).toBe(version)
  })
})

describe('engine item refs', () => {
  it('returns the same callback for a key across calls', () => {
    // The identity has to survive every render, or React runs cleanup-and-reattach for
    // every mounted item on every render.
    const h = setup({ count: 50 })
    expect(h.engine.itemRef('c3')).toBe(h.engine.itemRef('c3'))
    expect(h.engine.itemRef('c3')).not.toBe(h.engine.itemRef('c4'))
  })

  it('observes on attach and detaches on cleanup', () => {
    const h = setup({ count: 50 })
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, 120))
    document.body.appendChild(element)

    const detach = h.engine.itemRef('c3')(element)
    expect(h.engine.cache.sizeOf(3)).toBe(120)
    expect(detach).toBeTypeOf('function')
    detach?.()
  })

  it('does nothing when handed null', () => {
    const h = setup({ count: 50 })
    expect(h.engine.itemRef('c3')(null)).toBeUndefined()
  })
})

describe('engine measured slots', () => {
  it('shifts the visible range by a measured header, as `scrollMargin` would', () => {
    // The slot's whole promise: the consumer declares no number, and the list
    // behaves exactly as if they had declared the right one.
    const h = setup({ count: 1000 })
    const header = mountSlot(h, 'header', 500)

    expect(h.engine.store.getState().visibleRange[0]).toBe(0)
    h.scroll(1500)
    expect(h.engine.store.getState().visibleRange[0]).toBe(10)

    header.detach()
  })

  it('composes a measured header with the consumer’s own `scrollMargin`', () => {
    // They are different quantities: `scrollMargin` is the list's offset within the
    // document, which is page chrome *outside* the component, and the header is
    // inside it. Additive, not one replacing the other.
    const h = setup({ count: 1000, geometry: { scrollMargin: 200 } })
    mountSlot(h, 'header', 300)

    h.scroll(1500)
    expect(h.engine.store.getState().visibleRange[0]).toBe(10)
  })

  it('holds the view when the header grows', () => {
    // The headline. Every other virtual list either refuses to measure this content
    // (virtua's `startMargin`, TanStack's `scrollMargin`) or measures it and lets the
    // view jump — virtua #458, react-virtuoso #1245. Here the anchor names an item, so
    // the derived offset moves by exactly the header's delta and the reader does not
    // notice anything happened.
    const h = setup({ count: 1000 })
    const header = mountSlot(h, 'header', 300)

    h.scroll(1500)
    const anchorBefore = h.engine.getAnchor()
    const offsetBefore = h.offset()

    header.resize(700)

    expect(h.offset()).toBeCloseTo(offsetBefore + 400, 6)
    // Not merely compensated back — never disturbed. The anchor is the position of
    // record, and a geometry change is not a position change.
    expect(h.engine.getAnchor()).toEqual(anchorBefore)
  })

  it('holds the view when the header shrinks', () => {
    const h = setup({ count: 1000 })
    const header = mountSlot(h, 'header', 700)

    h.scroll(1500)
    const anchorBefore = h.engine.getAnchor()
    const offsetBefore = h.offset()

    header.resize(300)

    expect(h.offset()).toBeCloseTo(offsetBefore - 400, 6)
    expect(h.engine.getAnchor()).toEqual(anchorBefore)
  })

  it('gives the space back when a slot unmounts', () => {
    // react-virtuoso #1203: a header height cached past the header's own lifetime is
    // phantom padding that nothing can account for and nothing can clear.
    const h = setup({ count: 1000 })
    const header = mountSlot(h, 'header', 500)

    h.scroll(1500)
    const anchorBefore = h.engine.getAnchor()
    expect(h.engine.store.getState().visibleRange[0]).toBe(10)

    header.detach()

    // The space is returned by the offset shrinking, not by the reader being moved:
    // the list now starts 500px higher up the scroller, so holding the same comment
    // under the same pixel means scrolling 500px less far.
    expect(h.offset()).toBeCloseTo(1000, 6)
    expect(h.engine.getAnchor()).toEqual(anchorBefore)
    expect(h.engine.store.getState().visibleRange[0]).toBe(10)
  })

  it('counts a sticky header against both the origin and the usable height', () => {
    // It occupies in-flow space *and* covers the top of the scrollport, which is the
    // distinction react-virtuoso needed `headerHeight` and `fixedHeaderHeight` for.
    // At offset 500 a 500px sticky header puts list coordinate 0 at the scrollport
    // top — but the visible area starts below the sticky slot, so the first item
    // genuinely on screen is the one at list coordinate 500.
    const h = setup({ count: 1000 })
    mountSlot(h, 'stickyHeader', 500)

    h.scroll(500)
    expect(h.engine.store.getState().visibleRange[0]).toBe(5)
  })

  it('shrinks the visible range by a sticky footer', () => {
    const without = setup({ count: 1000 })
    const withComposer = setup({ count: 1000 })
    mountSlot(withComposer, 'stickyFooter', 300)

    expect(withComposer.engine.store.getState().visibleRange[1]).toBe(
      without.engine.store.getState().visibleRange[1] - 3,
    )
  })

  it('leaves the visible range alone for a footer that merely scrolls away', () => {
    // A footer is below every item, so it changes what the *end* of the scroller
    // means and nothing else. Only `align: 'end'` on the last item cares.
    const without = setup({ count: 1000 })
    const withFooter = setup({ count: 1000 })
    mountSlot(withFooter, 'footer', 300)

    expect(withFooter.engine.store.getState().visibleRange).toEqual(
      without.engine.store.getState().visibleRange,
    )
  })

  it('returns the same ref callback for a slot across calls', () => {
    const h = setup({ count: 50 })
    expect(h.engine.slotRef('header')).toBe(h.engine.slotRef('header'))
    expect(h.engine.slotRef('header')).not.toBe(h.engine.slotRef('footer'))
    expect(h.engine.slotRef('header')(null)).toBeUndefined()
  })

  it('survives an empty list with a header', () => {
    // TanStack #827 is `getTotalSize()` going negative for an empty list with a
    // margin set. Nothing can go negative here — the sizer covers items only and the
    // slot is a sibling — but the case is cheap to hold onto.
    const h = setup({ count: 0 })
    expect(() => {
      mountSlot(h, 'header', 300)
    }).not.toThrow()

    expect(h.engine.store.getState().totalSize).toBe(0)
    expect(h.engine.getAnchor()).toBeNull()
  })
})

describe('engine follow-output', () => {
  /** A follower: content-derived maximum, 50 items of 100px in an 800px port. */
  const following = (extra: Partial<Parameters<typeof setup>[0]> = {}) =>
    setup({ count: 50, trackContent: true, followOutput: true, ...extra })

  it('opens pinned to the end', () => {
    const h = following()
    // 50 × 100px of content in an 800px scrollport: the bottom is 4200.
    expect(h.offset()).toBe(4200)
    expect(h.engine.store.getState().atBottom).toBe(true)
  })

  it('holds the bottom when comments are appended', () => {
    const h = following()
    h.engine.setOptions({ keys: h.keys(60) })

    expect(h.offset()).toBe(5200)
    expect(h.engine.store.getState().atBottom).toBe(true)
  })

  it('holds the bottom while the last comment is still growing', () => {
    // The streaming case, and the one react-virtuoso #1245 is about: a message
    // arrives short and grows as its content lands. `onItemResize` already
    // publishes, so following needs no extra machinery to survive it.
    const h = following()
    mountItem(h, 'c49', 100)
    const before = h.offset()

    h.measure('c49', 900)

    // Against the scroller's own maximum rather than a computed number: measuring
    // one item also moves the *median* every unmeasured item is estimated from, so
    // the total is not simply 800px larger. Staying at the end is the claim, and
    // it is the claim whatever the rest of the list did.
    expect(h.offset()).toBeGreaterThan(before)
    expect(h.offset()).toBe(h.maxOffset())
    expect(h.engine.store.getState().atBottom).toBe(true)
  })

  it('is not disturbed by a prepend', () => {
    // Following pins the end; a prepend moves the start. Both are true at once,
    // and the reader stays looking at the newest comment.
    const h = following()
    h.engine.setOptions({ keys: [...h.keys(10, 'older'), ...h.keys(50)] })

    expect(h.offset()).toBe(5200)
    expect(h.engine.store.getState().atBottom).toBe(true)
  })

  it('lets go when the reader scrolls away, and takes hold again when they come back', () => {
    const h = following()

    // Input first, then the scroll it caused: input is the gate, position is the
    // test. The engine sees a wheel, then a scroll ending far from the bottom.
    h.userInput()
    h.scroll(1000)
    expect(h.engine.store.getState().atBottom).toBe(false)

    // An append no longer drags the reader down.
    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(1000)

    // Scrolling back to the bottom re-pins — once the scrolling has stopped.
    h.userInput()
    h.scroll(5200)
    h.scrollSettled()
    h.engine.setOptions({ keys: h.keys(70) })
    expect(h.offset()).toBe(6200)
  })

  it('does not take hold again until the scrolling has settled', () => {
    // The bug this split exists for. The first scroll event after a wheel can
    // arrive while the scrolling is still in flight — momentum, an engine that
    // scrolls asynchronously, a busy machine — so judging the position then
    // reads "not at the bottom" and the pin never comes back, because the
    // settle that follows carries no input to reconsider it.
    const h = following()

    // 50 × 100px in an 800px port: the bottom is 4200.
    h.userInput()
    h.scroll(1000)
    // Mid-flight, on the way back down and not there yet.
    h.scroll(3000)

    // Still unpinned, because nothing has said the scrolling is over — so the
    // append is held by the anchor rather than followed.
    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(3000)

    // Now it is over, at the bottom of the 60-item list.
    h.scroll(5200)
    h.scrollSettled()
    h.engine.setOptions({ keys: h.keys(70) })
    expect(h.offset()).toBe(6200)
  })

  it('takes hold again on the quiet timer when scrollend never comes', async () => {
    // Not a belt-and-braces fallback: Firefox has `onscrollend` on `window` — so
    // `supportsScrollEnd()` says yes — and fires nothing at all for a sequence of
    // wheel deltas. Measured in the demo: zero events across a 700ms wait, on the
    // exact gesture this feature exists for. Re-pinning on the event alone simply
    // never happened there.
    vi.useFakeTimers()
    try {
      const h = following()

      // Away from the end, then back to it — 50 × 100px in an 800px port, so the
      // bottom is 4200.
      h.userInput()
      h.scroll(1000)
      h.scroll(4200)

      // No `scrollSettled()` here, on purpose: this is the browser that does not
      // send one. Until the window goes quiet the reader is still considered to
      // be scrolling, so nothing is pinned yet.
      await vi.advanceTimersByTimeAsync(200)

      h.engine.setOptions({ keys: h.keys(60) })
      expect(h.offset()).toBe(5200)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a settle that no input preceded', () => {
    // The browser stops scrolling for its own reasons too — clamping after a
    // shrink, a window of items being replaced. A settle with no wheel or touch
    // behind it must not pin a reader who never asked to be.
    const h = following()
    h.userInput()
    h.scroll(1000)
    h.scrollSettled()
    expect(h.offset()).toBe(1000)

    // Second settle, no new input: nothing to reconsider.
    h.scroll(4200)
    h.scrollSettled()
    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(4200)
  })

  it('drops a pending re-pin when the engine is disposed', async () => {
    // The timer outlives the scroll that armed it, so teardown has to cancel it
    // or it fires into a disposed engine.
    vi.useFakeTimers()
    try {
      const h = following()
      h.userInput()
      h.scroll(1000)
      h.engine.dispose()

      await expect(vi.advanceTimersByTimeAsync(300)).resolves.not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not take hold again when the scrolling settles away from the end', () => {
    const h = following()

    h.userInput()
    h.scroll(1000)
    h.scrollSettled()

    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(1000)
  })

  it('ignores a scroll the user did not cause', () => {
    // The browser moves `scrollTop` on its own — clamping on a shrink, adjusting
    // when a window of items is replaced. Reading that as intent would unpin a
    // reader who never touched anything, which is why input is required.
    const h = following()
    h.scroll(1000)

    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(5200)
  })

  it('does not follow when the option is off', () => {
    const h = setup({ count: 50, trackContent: true })
    h.scroll(1000)
    h.engine.setOptions({ keys: h.keys(60) })

    // The anchor holds the reader's position instead, which is the default.
    expect(h.offset()).toBe(1000)
  })

  it('takes hold when the option is turned on, and lets go when turned off', () => {
    const h = setup({ count: 50, trackContent: true })
    h.scroll(1000)

    h.engine.setOptions({ followOutput: true })
    expect(h.offset()).toBe(4200)

    h.engine.setOptions({ followOutput: false })
    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(4200)
  })

  it('does not carry input from before following was switched on', () => {
    // The flag is only set while following, so a wheel that happened when the
    // list was not following cannot still be latched when it is — which would
    // unpin the reader on their first scroll after the option came on, without
    // them having touched anything since.
    const h = setup({ count: 50, trackContent: true })
    h.userInput()
    h.scroll(1000)

    h.engine.setOptions({ followOutput: true })
    expect(h.offset()).toBe(4200)

    h.engine.setOptions({ keys: h.keys(60) })
    expect(h.offset()).toBe(5200)
  })

  it('does not re-pin a reader who scrolled away, on an unchanged option', () => {
    // A consumer passing `followOutput` every render must not keep dragging the
    // reader back to the bottom.
    const h = following()
    h.userInput()
    h.scroll(1000)

    h.engine.setOptions({ followOutput: true })
    expect(h.offset()).toBe(1000)
  })
})

describe('engine atBottom', () => {
  it('reports a list too short to scroll as being at its end', () => {
    // Its end is on screen, so it is. A predicate built from `visibleRange[1] ===
    // count - 1` would say the same thing for the wrong reason — `indexAt` clamps,
    // so that is true for a short list at any scroll position at all.
    const h = setup({ count: 3, trackContent: true })
    expect(h.engine.store.getState().atBottom).toBe(true)
  })

  it('honours the threshold', () => {
    const h = setup({ count: 50, trackContent: true, atBottomThreshold: 50 })
    h.scroll(4160)
    expect(h.engine.store.getState().atBottom).toBe(true)

    h.scroll(4100)
    expect(h.engine.store.getState().atBottom).toBe(false)
  })
})

describe('engine edge notifications', () => {
  it('reports each edge once per crossing', () => {
    const edges: string[] = []
    const h = setup({
      count: 50,
      trackContent: true,
      edgeReachedThreshold: 300,
      onEdgeReached: (edge) => edges.push(edge),
    })

    // Starts at the top, so the start edge is reported immediately.
    expect(edges).toEqual(['start'])

    // Still near the top: not reported again.
    h.scroll(100)
    expect(edges).toEqual(['start'])

    h.scroll(2000)
    expect(edges).toEqual(['start'])

    h.scroll(4200)
    expect(edges).toEqual(['start', 'end'])

    // Away and back reports it again, because the latch was released.
    h.scroll(2000)
    h.scroll(4200)
    expect(edges).toEqual(['start', 'end', 'end'])
  })

  it('says nothing while a programmatic scroll is in flight', () => {
    // The whole reason this belongs in the library rather than in an `onScroll`
    // handler: a page fetched mid-animation moves the target the animation is
    // chasing, and the README tells consumers not to do it. Owning the callback
    // makes the mistake unavailable instead of merely documented.
    const edges: string[] = []
    const h = setup({
      count: 50,
      trackContent: true,
      edgeReachedThreshold: 300,
      onEdgeReached: (edge) => edges.push(edge),
    })
    edges.length = 0

    void h.engine.scrollToIndex(49, { align: 'end' })
    h.scroll(4200)

    expect(edges).toEqual([])
  })

  it('costs nothing when no listener is installed', () => {
    // The engine skips the whole computation, which is why the adapter spreads the
    // option conditionally rather than always handing over a wrapper.
    const h = setup({ count: 50, trackContent: true })
    expect(() => {
      h.scroll(4200)
    }).not.toThrow()
  })
})

describe('engine alignToBottom', () => {
  it('holds short content against the bottom', () => {
    // Three 100px comments in an 800px scrollport: 500px of space above them.
    const h = setup({ count: 3, trackContent: true, alignToBottom: true })
    expect(h.writes).toContain('lead:500')
  })

  it('adds nothing once the content fills the scrollport', () => {
    const h = setup({ count: 50, trackContent: true, alignToBottom: true })
    expect(h.writes.filter((w) => w.startsWith('lead:'))).toEqual(['lead:0'])
  })

  it('recomputes when the viewport changes', () => {
    const h = setup({ count: 3, trackContent: true, alignToBottom: true })
    h.resize(400)
    expect(h.writes).toContain('lead:100')
  })

  it('shifts the list origin, so offsets stay consistent with it', () => {
    // The spacer is space before the list, which is what `scrollMargin` means —
    // so it composes into the same inset rather than being a mechanism of its own.
    const h = setup({ count: 3, trackContent: true, alignToBottom: true })
    // Item 0 sits at list coordinate 0, which is 500px down the scroller.
    expect(h.engine.getAnchor()?.key).toBe('c0')
    expect(h.engine.getAnchor()?.offsetWithinItem).toBe(-500)
  })

  it('is off by default', () => {
    const h = setup({ count: 3, trackContent: true })
    expect(h.writes.filter((w) => w.startsWith('lead:'))).toEqual(['lead:0'])
  })
})
