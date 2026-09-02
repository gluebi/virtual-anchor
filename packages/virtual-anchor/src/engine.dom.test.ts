import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine, layoutSignatureFor, type Engine } from './engine.js'
import {
  acceptedScrollOffset,
  FakeResizeObserver,
  harnessState,
  installObservers,
  maxOffsetFor,
  recordingSurface,
} from './engineHarness.test.helpers.js'
import { EMPTY_STATE } from './store.js'
import type { ItemKey, SlotName } from './types.js'
import { createElementViewport, type Viewport } from './viewport.js'

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
  /** Resize the scrollport along the block axis, leaving its width alone. */
  resize: (size: number) => void
  /** Resize it along the inline axis instead — the axis that reflows text. */
  resizeWidth: (width: number) => void
  /**
   * Deliver the scrollport's current box unchanged, as `observe()` synthesises on mount.
   *
   * The delivery later ones are deduped against, so a test about a *swallowed* resize has
   * to do this before the resize it cares about.
   */
  observeScrollport: () => void
  keys: (count: number, prefix?: string) => ItemKey[]
  /** Report a measured size for a key, as a ResizeObserver would. */
  measure: (key: ItemKey, size: number) => void
  /**
   * `writes.length` at each `getViewportSize` call, one entry per read.
   *
   * Both halves of what it records are the assertion: the *count* says the scrollport was
   * read once for a pass rather than once per consumer of the answer, and the *position*
   * says the read happened before that pass wrote anything — which is what keeps it off the
   * far side of a style write, where it would force a layout instead of reading a flushed one.
   */
  viewportReadAt: number[]
  /**
   * `writes.length` at each `getScrollOffset` call, one entry per read.
   *
   * The same instrument as {@link viewportReadAt}, for the other layout-forcing read: it says
   * where in a pass the scroll offset was consulted, so a case can assert that no style write
   * landed in front of one.
   */
  scrollReadAt: number[]
  viewportSize: number
}

const KEYS = (count: number, prefix = 'c'): ItemKey[] =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i)}`)


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
    /** Truncate a written offset to an integer, as WebKit does. Same name and order as the iOS harness. */
    truncateWrites?: boolean
  } = {},
): Harness => {
  const { count = 50, trackContent = false, truncateWrites = false, ...engineOptions } = options

  const scroller = document.createElement('div')
  const container = document.createElement('div')
  scroller.appendChild(container)
  document.body.appendChild(scroller)

  const state = harnessState()
  const writes: string[] = []
  const viewportReadAt: number[] = []
  const scrollReadAt: number[] = []
  const elements = new Map<ItemKey, HTMLElement>()
  const scrollListeners: (() => void)[] = []
  /**
   * Kept apart from `scroll`, because the engine now treats them differently:
   * following lets go on a scroll event and takes hold again only once the
   * scrolling has settled. A harness that fired both together could not tell the
   * two apart, and the race that motivated the split would pass unnoticed.
   */
  const scrollEndListeners: (() => void)[] = []

  Object.defineProperty(scroller, 'clientWidth', {
    configurable: true,
    get: () => state.contentWidth,
  })

  const scrollportViewport = createElementViewport(scroller)

  /** Deliver the scrollport's current box, whatever the test last set it to. */
  const deliverScrollport = (): void => {
    FakeResizeObserver.deliverTo(scroller, state.viewportSize, state.contentWidth)
  }

  const surface = recordingSurface(state, writes, elements)

  const viewport: Viewport = {
    getScrollOffset: () => {
      scrollReadAt.push(writes.length)
      return state.offset
    },
    getViewportSize: () => {
      viewportReadAt.push(writes.length)
      return state.viewportSize
    },
    getMaxScrollOffset: () => (trackContent ? maxOffsetFor(state) : 1_000_000),
    setScrollOffset: (next) => {
      // Clamped, as a real scroller clamps: following writes the maximum, and a fake
      // that accepted anything would pass a test the browser would fail.
      state.offset = acceptedScrollOffset(state, next, { trackContent, truncateWrites })
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
    // The real implementation rather than a forwarding fake, because *whether* a resize
    // delivery reaches the engine at all is decided in there — and a fake that forwarded
    // every one of them is what let #34 through: a width-only delivery was swallowed, so
    // the layout signature was never re-read and stale row heights survived the reflow.
    observeSize: (onResize) => scrollportViewport.observeSize(onResize),
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
    viewportReadAt,
    scrollReadAt,
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
      deliverScrollport()
    },
    resizeWidth: (width) => {
      state.contentWidth = width
      deliverScrollport()
    },
    observeScrollport: deliverScrollport,
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

/**
 * Mount an element for a key, as the React adapter's ref callback would.
 *
 * Hands back the rect spy and the detach as well as the element, the shape `mountSlot`
 * already has. Both are needed to say anything about *whether* a row's rect was read and
 * about what happens when the same key mounts a second time — and a caller wanting only the
 * element still destructures one field rather than reaching for a second helper.
 */
/**
 * The values a write prefix was called with, in order, with consecutive repeats dropped.
 *
 * The real surface dedupes against the last value it wrote (`createDomSurface`), so a
 * repeat is a write the DOM never takes — and how many publishes a given act happens to
 * cost is rarely what a case is about. What it is usually about is the sequence of
 * *distinct* values a style went through.
 */
const written = (h: Harness, prefix: string): number[] => {
  const values = h.writes
    .filter((w) => w.startsWith(prefix))
    .map((w) => Number(w.slice(prefix.length)))
  return values.filter((value, i) => value !== values[i - 1])
}

const mountItem = (h: Harness, key: ItemKey, height: number) => {
  const element = document.createElement('div')
  const rect = vi
    .spyOn(element, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 600, height))
  document.body.appendChild(element)
  return { element, rect, detach: h.engine.observeItem(element, key) }
}

beforeEach(() => {
  installObservers()
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('engine option plumbing', () => {
  it('renders a window around the scroll offset, not the whole list', () => {
    const h = setup({ count: 1000 })
    const { renderedRange, visibleRange } = h.engine.store.getState()

    // 800px viewport, 100px estimates, a 2500px default buffer either side and half of that
    // again in slack so the range can be held — so the mounted range reaches about 46, and the
    // point stands: a window of a 1,000-item list, not the list.
    expect(visibleRange).toEqual([0, 8])
    expect(renderedRange[1]).toBeGreaterThan(visibleRange[1])
    expect(renderedRange[1]).toBeLessThan(60)
  })

  it('widens the rendered range with `buffer`', () => {
    const narrow = setup({ count: 1000, buffer: 0 })
    const wide = setup({ count: 1000, buffer: 2000 })

    expect(wide.engine.store.getState().renderedRange[1]).toBeGreaterThan(
      narrow.engine.store.getState().renderedRange[1] + 15,
    )
  })

  it('does not shortcut a landing while the destination is still an estimate', async () => {
    // The fast path used to key on `measuredCount === length`, which is a count and cannot say
    // *which* rows were measured — so a window whose rows are all freshly mounted estimates read
    // as fully known. This drives the path that asks the surface instead.
    const h = setup({ count: 500 })
    const result = await h.engine.scrollToIndex(120, { align: 'end' })
    expect(result.reason === 'converged' || result.reason === 'deadline').toBe(true)
    h.unmount()
  })

  it('bounds the default buffer in rows, not only in pixels', () => {
    // The default is a distance, which is right for what it buys and wrong for what it costs:
    // 2500px of 162px comments is about fifteen rows a side, and of 20px chips a hundred and
    // twenty-five. Mounting is charged per row, so the default is whichever bound is smaller.
    const tall = setup({ count: 5000, defaultEstimate: 400 })
    const short = setup({ count: 5000, defaultEstimate: 20 })

    const rowsOf = (h: Harness): number => {
      const { renderedRange } = h.engine.store.getState()
      return renderedRange[1] - renderedRange[0] + 1
    }

    // 20px rows, an 800px scrollport: unbounded, 2500px either side is 290 mounted rows. The
    // row bound cuts the buffer to 24 rows a side, which is about 90. The tall list is nowhere
    // near either bound and mounts what the pixels say.
    expect(rowsOf(short)).toBeLessThan(150)
    expect(rowsOf(tall)).toBeGreaterThan(5)
  })

  it('respects an explicit `buffer` without applying the row bound', () => {
    // The bound exists for the number nobody chose. A caller who states one is not second
    // guessed, however many rows it comes to.
    const bounded = setup({ count: 5000, defaultEstimate: 20 })
    const asked = setup({ count: 5000, defaultEstimate: 20, buffer: 4000 })

    const span = (h: Harness): number => {
      const { renderedRange } = h.engine.store.getState()
      return renderedRange[1] - renderedRange[0]
    }
    expect(span(asked)).toBeGreaterThan(span(bounded))
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

    // Well clear of the 2500px default, so this asserts that the option arrived rather than that
    // it happens to differ from whatever the default is this month.
    h.engine.setOptions({ buffer: 8000 })
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

    const { element } = mountItem(h, 'c2', 400)
    FakeResizeObserver.deliverTo(element, 400)

    // c2 grew by 300px, all of it above the viewport, so the offset follows it.
    expect(h.offset()).toBe(1300)
    expect(h.engine.getAnchor()?.key).toBe('c10')
  })

  it('leaves the offset alone when an item below the viewport is measured', () => {
    const h = setup({ count: 50 })
    h.scroll(1000)

    const { element } = mountItem(h, 'c40', 900)
    FakeResizeObserver.deliverTo(element, 900)
    expect(h.offset()).toBe(1000)
  })

  /**
   * The same pair as the two cases above, for a position the *scroller* chose rather than the
   * reader — and the anchor has to follow that move as faithfully.
   *
   * A fully measured list resolves `scrollToKey` on the fast path, synchronously, inside the
   * promise executor. The `scrollTop` write is synchronous too but its `scroll` event is not, so
   * there is a window in which the landing has been reported and the browser has not yet told
   * anyone about it. `isScrolling()` is already false by then, so nothing suppresses a restore —
   * and a restore from the pre-scroll anchor puts the view back where it started, undoing a
   * landing the promise called `converged` (#115).
   *
   * The harness stages the window for free: its viewport does not fire a scroll event when the
   * offset is written, so not calling `h.scroll()` *is* the race. Awaiting the promise at all is
   * what proves the fast path was taken — the convergence loop needs animation frames, which
   * nothing here runs — and `iterations: 0` says so a second time.
   */
  it('holds a fast-path landing when a row above it is re-measured', async () => {
    const h = setup({ count: 20, trackContent: true })
    for (const key of h.keys(20)) mountItem(h, key, 100)

    const result = await h.engine.scrollToKey('c5', { align: 'start' })
    expect(result).toEqual({
      settled: true,
      deviation: 0,
      clamped: false,
      iterations: 0,
      reason: 'converged',
    })
    expect(h.offset()).toBe(500)

    // What a late layout change does: a row *above* the target corrected after the aim was
    // taken against the old cache.
    h.measure('c0', 150)

    // c0 grew by 50, so keeping c5 under the viewport top means the offset becomes 550.
    expect(h.offset()).toBe(550)
    expect(h.engine.getAnchor()?.key).toBe('c5')
  })

  it('leaves a fast-path landing alone when a row below it is re-measured', () => {
    const h = setup({ count: 20, trackContent: true })
    for (const key of h.keys(20)) mountItem(h, key, 100)

    void h.engine.scrollToKey('c5', { align: 'start' })
    expect(h.offset()).toBe(500)

    h.measure('c15', 150)
    expect(h.offset()).toBe(500)
  })

  it('keeps holding a fast-path landing once its scroll event arrives', async () => {
    const h = setup({ count: 20, trackContent: true })
    for (const key of h.keys(20)) mountItem(h, key, 100)
    await h.engine.scrollToKey('c5', { align: 'start' })
    h.measure('c0', 150)

    // The event for the landing write, delivered late and now describing an offset the restore
    // above has already moved. Deriving from it must reach the same row rather than banking
    // whatever the stale anchor left behind — which is what made the original loss permanent
    // instead of transient.
    // Whatever offset is actually there, which is what the browser would report.
    h.scroll(h.offset())
    expect(h.engine.getAnchor()?.key).toBe('c5')

    h.measure('c1', 150)
    expect(h.offset()).toBe(600)
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
  // The root font size is read off `documentElement`, which outlives a test — so a case that
  // changes it has to put it back, or every signature taken after it starts from 20px.
  afterEach(() => {
    document.documentElement.style.removeProperty('font-size')
  })

  it('discards measurements when the width changes and the height does not', () => {
    // The #34 repro. The signature hashes the scrollport's width, and its only runtime
    // re-read used to be reached through a callback gated on the *block* size — so a
    // scrollport that reflowed without changing height kept every height measured at the
    // old width, and the prefix sum placed rows at offsets that did not match their heights.
    // Downstream that read as rows drawn overlapping or with gaps.
    // Twelve of the twenty mounted, so both halves of the invalidation are observable at
    // once: what a row on screen does, and what a row off it does.
    const h = setup({ count: 20 })
    // Measured on attach, as the engine measures every item it is handed.
    const reflowed = mountItem(h, 'c0', 250)
    for (const key of h.keys(12).slice(1)) mountItem(h, key, 250)
    expect(h.engine.cache.totalSize()).toBe(12 * 250 + 8 * 100)

    // The reflow itself: at the new width this row's text wraps to one line more. Without it
    // nothing here could tell a re-measurement from a cache that snapshotted its own contents
    // and wrote them back — every height would be identical either side of the clear, and the
    // restoring implementation would pass every assertion below.
    reflowed.rect.mockReturnValue(new DOMRect(0, 0, 400, 320))

    // Load-bearing: this is the delivery that sets what the next one is compared against.
    // Without it the width change below is a first delivery, which reports either way, and
    // the bug hides.
    h.observeScrollport()
    h.resizeWidth(400)

    // Read again, not restored: the row carries the height it has at the new width.
    expect(h.engine.cache.sizeOf(0)).toBe(320)

    // Every measurement taken at the old width is discarded — and the rows still on screen are
    // measured again immediately, under the new one. They do *not* wait for the item observer:
    // it reads a rect once per mount and only for a size the cache does not know, so a row whose
    // height is unchanged would never be asked again and would sit on its estimate for as long
    // as it stayed mounted. See #111.
    expect(h.engine.cache.measuredCount).toBe(12)
    // The eight nobody is looking at are back on their estimates, which is the discard.
    expect(h.engine.cache.totalSize()).toBe(320 + 11 * 250 + 8 * 100)
  })

  it('discards measurements when the root font size changes and the scrollport does not', () => {
    // The other half of #44. `observeSize` is the only thing that re-read the signature, so
    // only the *width* term ever had a trigger behind it. A root font size change re-wraps
    // every line without moving the scrollport, so nothing was delivered and every measured
    // height stayed keyed to a layout that no longer existed.
    //
    // Note what this test does not call: `resizeWidth`, or `observeScrollport`. There is no
    // scrollport resize here at all, which is the entire point.
    const h = setup({ count: 20 })
    for (const key of h.keys(12)) mountItem(h, key, 250)
    expect(h.engine.cache.totalSize()).toBe(12 * 250 + 8 * 100)

    // A user raising their browser's default size, or an app's accessibility text toggle.
    document.documentElement.style.fontSize = '20px'

    // The signal that was always there and nothing was asking: the rows on screen re-lay-out,
    // so their observers fire. One delivery is enough — the engine re-reads the signature
    // before it applies the batch.
    h.measure('c0', 300)

    // Every mounted row is measured again under the new layout, and the refill runs *after* the
    // batch and skips what it already delivered — so `c0` keeps the 300 it reported rather than
    // being re-read back to its mocked 250, and its neighbours get the height their boxes have.
    expect(h.engine.cache.measuredCount).toBe(12)
    // The rows nobody has mounted are back on their estimates rather than confidently wrong.
    expect(h.engine.cache.isMeasured(19)).toBe(false)
    // 250 for the eight, not 100: `refreshEstimate` learned a median from the batch, and
    // `clearAll` keeps the estimate it learned. Which is why `measuredCount` above is the
    // reading that discriminates here and the total is not.
    expect(h.engine.cache.totalSize()).toBe(11 * 250 + 300 + 8 * 250)
  })

  it('never leaves a mounted row on an estimate after discarding the cache', () => {
    // #111. `clearAll` makes every mounted row's size unknown and nothing else asks again:
    // `observeItem` reads a rect once per mount, and the ResizeObserver fires only when a box
    // *changes* — deduplicated by value on top of that. So a row whose height is the same under
    // the new layout was never re-delivered and stayed on its estimate while still on screen,
    // with every row below it positioned from that estimate.
    //
    // Mounted at exactly the 100px estimate, which is what makes this test say something the
    // one above does not: every total is identical whether the rows are measured or discarded,
    // so `measured` is the only reading that can tell. That is not a contrivance — it is the
    // reported shape of the bug. The rows whose estimate happens to match their height look
    // perfect, so the failure presents as one row with a gap under it rather than as list-wide
    // drift, and `VirtualItem.measured` is the only signal a consumer has.
    const h = setup({ count: 20 })
    for (const key of h.keys(6)) mountItem(h, key, 100)
    expect(h.engine.cache.measuredCount).toBe(6)

    h.observeScrollport()
    h.resizeWidth(400)

    // Same elements, same heights, nothing delivered — and still measured. No `totalSize` here
    // on purpose: it reads 20 × 100 before the clear, after a correct refill, and after the
    // broken one. `measured` is the only thing that separates them.
    for (let index = 0; index < 6; index++) expect(h.engine.cache.isMeasured(index)).toBe(true)
  })

  it('re-reads the signature at most once per rate-limit window', () => {
    // The top of the item batch is the hot path — every row measured during a fling — so the
    // read is rate-limited. A limit rather than a threshold: it decides nothing about the
    // content, only how often the question is asked. Below, both sides of the guard.
    let clock = 100
    const h = setup({ count: 20, now: () => clock })
    const rows = h.keys(20).map((key) => mountItem(h, key, 250))
    // Eight scrolled back out of view: their sizes stay in the cache, keyed, with no element
    // attached. That is what keeps `measuredCount` discriminating now that a clear refills the
    // rows that *are* attached — with all twenty mounted, the count would read the same on both
    // sides of the clear and the test would pass without the signature ever being re-read.
    for (const row of rows.slice(12)) row.detach()
    expect(h.engine.cache.measuredCount).toBe(20)

    document.documentElement.style.fontSize = '20px'

    // Inside the window — and this first one is inside it by construction, since the
    // signature was seeded moments ago at mount and there is nothing yet to differ from.
    h.measure('c0', 300)
    expect(h.engine.cache.measuredCount).toBe(20)

    // Past it, so the same change is now seen: the eight with no element lose their sizes,
    // the twelve still on screen are measured again under the new layout.
    clock = 400
    h.measure('c1', 300)
    expect(h.engine.cache.measuredCount).toBe(12)

    // Deliberately no `totalSize` assertion on either side. `refreshEstimate` ran on the first
    // batch — twenty samples, median 250 — and `clearAll` keeps the estimate it learned, which
    // is the whole point of learning one. So the discarded rows fall back to 250, the same
    // number they held, and the total is identical either way. `measuredCount` is the only
    // reading here that discriminates.
  })

  it('keeps measurements when only the height changes', () => {
    // A mobile URL bar hiding, devtools opening, a soft keyboard, a vertical drag.
    // None of them reflows a single line box, and discarding the cache for them is both
    // wasteful and — with a restored snapshot — destructive. This is the case the width
    // fix above must not swallow into itself.
    const h = setup({ count: 50 })
    const { element } = mountItem(h, 'c0', 250)
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

describe('engine range hysteresis', () => {
  /** The rendered range as the store currently holds it. */
  const rendered = (h: Harness): readonly [number, number] =>
    h.engine.store.getState().renderedRange

  it('holds the mounted range across a scroll, then recomputes once the buffer is spent', () => {
    // The distance is the claim. `publishes the same range tuple while the range has not moved`
    // above already covers a scroll too small to cross a row; this is a scroll of three rows
    // that would have moved the range before, and no longer does.
    const h = setup({ count: 2000, buffer: 1000 })
    const before = rendered(h)

    h.scroll(300)
    expect(rendered(h)).toEqual(before)

    h.scroll(4000)
    expect(rendered(h)).not.toEqual(before)
    expect(rendered(h)[0]).toBeGreaterThan(before[0])
  })

  it('never lets the mounted range fall inside the buffer', () => {
    // The invariant `blanking.spec.ts` chose `DEFAULT_BUFFER` against. Holding the range is only
    // allowed to spend *slack*; the coverage the buffer promises is not negotiable, so this
    // walks a scroll across many hold-and-recompute cycles and checks it at every step.
    const buffer = 1000
    const h = setup({ count: 2000, buffer })

    // A hold-and-recompute cycle is `buffer * RANGE_SLACK_RATIO` = 500px, so this walks eight of
    // them and lands in every phase of one: freshly recomputed, mid-hold, and at the trigger.
    for (let offset = 0; offset <= 4_000; offset += 137) {
      h.scroll(offset)
      const [from, to] = rendered(h)
      // 800px viewport, so the band the buffer demands is [offset - 1000, offset + 800 + 1000].
      const needFrom = h.engine.cache.indexAt(Math.max(0, offset - buffer))
      const needTo = h.engine.cache.indexAt(offset + h.viewportSize + buffer)
      expect(from, `mounted start at ${String(offset)}`).toBeLessThanOrEqual(needFrom)
      expect(to, `mounted end at ${String(offset)}`).toBeGreaterThanOrEqual(needTo)
    }
  })

  it('follows its own rows through a prepend rather than remounting around them', () => {
    // What holding by key buys, and the case two integers would get wrong: after ten rows are
    // inserted above, the held ends still name the same rows, so the mounted set is the same
    // set — shifted by ten, which is what the indices say.
    //
    // A small buffer and a position deep in a long list, deliberately: with the whole list
    // inside the buffer the range is [0, count-1] either way and the assertion would pass on a
    // recompute, proving nothing.
    const h = setup({ count: 2000, buffer: 200 })
    h.scroll(5000)
    const [from, to] = rendered(h)

    h.engine.setOptions({ keys: [...h.keys(10, 'older'), ...h.keys(2000)] })

    expect(rendered(h)).toEqual([from + 10, to + 10])
  })

  it('puts the slack on the edge that ran out, not behind the reader', () => {
    // Which edge failed coverage says which way the reader is going, without the engine
    // tracking a direction: coverage fails ahead of them, never behind. So a reader scrolling
    // down carries slack below and exactly the buffer above — half the resident rows of a
    // symmetric band, and one burst of first-measurements per recompute instead of two.
    const buffer = 1000
    const h = setup({ count: 4000, buffer })

    // Far enough in that neither edge is clamped against an end of the list.
    h.scroll(20_000)
    const [from, to] = rendered(h)

    const top = h.engine.cache.offsetOf(from)
    // `+ 1` is the row's far edge: `offsetOf` is the top of a row, and what has to clear the
    // band is the bottom of the last one.
    const bottom = h.engine.cache.offsetOf(to + 1)
    const visibleTop = 20_000
    const visibleBottom = 20_000 + h.viewportSize

    // Above: the guarantee and no more, within a row of rounding to a boundary.
    expect(visibleTop - top).toBeGreaterThanOrEqual(buffer)
    expect(visibleTop - top).toBeLessThan(buffer * (1 + 0.5))
    // Below: the guarantee plus the slack.
    expect(bottom - visibleBottom).toBeGreaterThanOrEqual(buffer * (1 + 0.5))
  })

  it('does not let the visibility deadline move the mounted range', async () => {
    // Holding only works if whatever moves the held ends also renders the result. The
    // visibility deadline timer wants a visible range and fires from `setTimeout`, outside any
    // publish — so calling the full `computeRanges` there moved the hold with nothing rendering
    // it. The next publish then found the hold covering, handed back the same tuple, and
    // `needsRerender` reported nothing to do while the DOM still held the previous rows. Far
    // enough into a scroll that leaves the scrollport with no mounted row over it at all.
    //
    // Two ingredients, and both are needed or this passes against the broken code: a `dwellMs`
    // so the tracker actually arms a deadline, and content that moves *without* a publish
    // behind it so the timer recomputes at an offset the last publish never saw.
    //
    // Asserted against an engine that reached the same place without a timer ever firing,
    // rather than against a literal — the claim is that the deadline changed nothing.
    vi.useFakeTimers()
    try {
      const withTimer = setup({
        count: 2000,
        buffer: 1000,
        visibility: { rule: { mode: 'any' }, dwellMs: 50 },
      })
      withTimer.scroll(100)
      withTimer.setOffset(5000)
      await vi.advanceTimersByTimeAsync(60)
      withTimer.scroll(5300)

      const without = setup({ count: 2000, buffer: 1000 })
      without.scroll(100)
      without.scroll(5300)

      expect(rendered(withTimer)).toEqual(rendered(without))
    } finally {
      vi.useRealTimers()
    }
  })

  it('recomputes when the window it was holding has paged away', () => {
    // The other half: no key resolves, which reads as nothing held.
    const h = setup({ count: 100 })
    h.scroll(600)
    const before = rendered(h)

    h.engine.setOptions({ keys: h.keys(100, 'other') })

    expect(rendered(h)).not.toEqual(before)
    expect(rendered(h)[0]).toBe(0)
  })

  it('drops a hold computed while the list was shorter than its own band', () => {
    // The hold's release was one-sided: only a hold too *narrow* to cover the buffer was revisited,
    // so one that was far too wide was kept for as long as its keys resolved. A list shorter than
    // its own band computes exactly that — the band spans everything, so the hold is the whole
    // list, and the two keys it pins are the list's first and last. Where those stay first and
    // last, as an opener and a footer row do, it never comes back.
    const buffer = 1000
    const h = setup({ buffer, keys: ['opener', 'footer'] })
    // Two rows against an 800px scrollport and a 1000px buffer: the whole list, correctly.
    expect(rendered(h)).toEqual([0, 1])

    const offset = 75_000
    h.engine.setOptions({ keys: ['opener', ...h.keys(1500), 'footer'] })
    h.scroll(offset)

    // Asked of the cache rather than written as a row count, as `never lets the mounted range fall
    // inside the buffer` above does: the band the reader needs, plus one slack of drift a side.
    const slack = buffer * 0.5
    const [from, to] = rendered(h)
    expect(from, `mounted ${String(to - from + 1)} of ${String(h.engine.cache.length)} rows`)
      .toBeGreaterThanOrEqual(h.engine.cache.indexAt(offset - buffer - slack))
    expect(to, `mounted ${String(to - from + 1)} of ${String(h.engine.cache.length)} rows`)
      .toBeLessThanOrEqual(h.engine.cache.indexAt(offset + h.viewportSize + buffer + slack))
  })
})

describe('engine paint-offset write ordering', () => {
  it('draws the paint offset after the last scroll read, not between', () => {
    // `publish` writes the paint offset once, last, and after every read — the comment there
    // says so, and the *banked* branch of `writeScroll` honoured it explicitly. The committed
    // branch did not: `commitScroll` flushed the carry itself, and it sits between the scroll
    // write and this pass's final two reads of `scrollTop`. A style write in front of a read is
    // a forced synchronous layout, and on WebKit it is every commit, because a truncated write
    // means the carry always moves — once per measured row through a fling.
    //
    // `truncateWrites` is what makes the carry non-zero at all, so this case cannot pass by the
    // paint offset simply never being written.
    const h = setup({ count: 200, truncateWrites: true })
    for (const key of h.keys(8)) mountItem(h, key, 100)
    h.scroll(900)

    h.writes.length = 0
    h.scrollReadAt.length = 0
    // A row above the viewport growing: the anchor holds the view, so the offset is re-derived
    // and committed — which is the path that carries.
    h.measure('c0', 137.5)

    const paintAt = h.writes.findIndex((write) => write.startsWith('paint:'))
    expect(paintAt, 'no paint offset was written, so this proves nothing').toBeGreaterThanOrEqual(0)
    // `Math.max()` of nothing is -Infinity, which would satisfy the bound below by the offset
    // never having been read at all.
    expect(h.scrollReadAt, 'nothing read the scroll offset, so this proves nothing').not.toHaveLength(0)
    // Every read happened at or before the point the paint offset was drawn. A read *after* it
    // would have been recorded at a `writes.length` past that index.
    expect(Math.max(...h.scrollReadAt)).toBeLessThanOrEqual(paintAt)
  })
})

describe('engine scrollport reads', () => {
  it('reads the scrollport height once per publish, before anything is written', () => {
    // `getViewportSize` is three DOM reads on an element scroller, and a publish reached it
    // twice: once through `computeRanges` and once more through the visibility sample. The
    // second runs after every mounted row's `top` has been written, so it was not a repeat but
    // a forced synchronous layout — once per scroll event — to re-answer what the same pass
    // had already answered.
    //
    // The zero is both halves of the claim: one entry says it was read once, and its position
    // says the read came before that pass wrote anything.
    const h = setup({ count: 50 })
    for (const key of h.keys(6)) mountItem(h, key, 250)

    h.writes.length = 0
    h.viewportReadAt.length = 0
    h.scroll(1000)

    expect(h.viewportReadAt).toEqual([0])
  })

  it('still reads it once per publish with a leading spacer to size', () => {
    // `syncSlack` is a third reason to want the height — it serves both ends of the box — and
    // the only one that runs before the content-size write rather than after, so a version that
    // hoisted just the two above would still leave this one, and still leave it first.
    const h = setup({ count: 50, alignToBottom: true, trackContent: true })

    h.writes.length = 0
    h.viewportReadAt.length = 0
    h.scroll(400)

    expect(h.viewportReadAt).toEqual([0])
  })
})

describe('engine mount measurement', () => {
  // Why the read is conditional at all is argued where the condition is, in `observeItem`.
  // These three pin the two halves of it and the property it rests on.

  it('measures a row it has no size for', () => {
    // The positive control, so the skip below cannot pass by the read having been deleted.
    const h = setup({ count: 20 })
    const first = mountItem(h, 'c0', 250)

    expect(first.rect).toHaveBeenCalled()
    expect(h.engine.cache.sizeOf(0)).toBe(250)
  })

  it('does not read a row’s rect when its height is already known', () => {
    const h = setup({ count: 20 })
    mountItem(h, 'c0', 250).detach()

    const remount = mountItem(h, 'c0', 250)
    expect(remount.rect).not.toHaveBeenCalled()
    expect(h.engine.cache.sizeOf(0)).toBe(250)
  })

  it('still corrects a row whose height changed while it was unmounted', () => {
    // The property the skip rests on, and it belongs to `resizer` rather than to the engine:
    // detaching forgets the remembered size, so the observer's synthetic first entry for the
    // replacement element is reported rather than dropped as a duplicate.
    const h = setup({ count: 20 })
    mountItem(h, 'c0', 250).detach()

    const remount = mountItem(h, 'c0', 300)
    expect(h.engine.cache.sizeOf(0)).toBe(250)

    FakeResizeObserver.deliverTo(remount.element, 300)
    expect(h.engine.cache.sizeOf(0)).toBe(300)
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

  /**
   * #50. `setOptions` publishes from the React render body and `publish` ends in a
   * sample, so the first sample of a list's life runs a whole commit phase before any
   * ref callback has measured a row. Under `once` that sample was the only one each
   * in-band row ever got, and it carried an estimate.
   *
   * A consumer marking forum comments read filters on `measured`, exactly as `satisfies`
   * advises. On a list short enough that every row is in the band at mount, all of them
   * latched unmeasured, all of them were discarded, and nothing could ever be marked
   * read — with no scroll left to recover from it.
   */
  it('spends the once-report on measured geometry, not the mount estimate', () => {
    const events: string[] = []
    const h = setup({
      count: 3,
      visibility: { rule: { mode: 'edge', edge: 'end' }, once: true },
      onVisibilityChange: (batch) => {
        for (const e of batch) {
          events.push(`${e.phase}:${String(e.key)}:${e.measured ? 'measured' : 'estimated'}`)
        }
      },
    })

    // Every trailing edge is inside the band already, but nothing has been measured.
    expect(events).toEqual([])

    // The commit phase: each ref callback attaches and measures synchronously. Deliberately
    // measuring *exactly* the estimate, which is the case the deferral leans on hardest —
    // `setSize` compares against the stored measurement rather than the estimate, so a row
    // that guesses right still reports a change and still publishes.
    for (const key of h.keys(3)) mountItem(h, key, 100)

    expect(events).toEqual(['enter:c0:measured', 'enter:c1:measured', 'enter:c2:measured'])
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

describe('engine trailing space', () => {
  /** Space held below the items. */
  const trails = (h: Harness): number[] => written(h, 'trail:')
  /** The sizer's own height, which is the items' total and must stay that way. */
  const sizes = (h: Harness): number[] => written(h, 'content:')

  it('carries a sticky footer to the bottom edge on a list that does not fill the scrollport', () => {
    // 300px of items and a 300px composer in an 800px box. `bottom: 0` lifts the
    // composer to the bottom edge from below it and cannot push it down to one, so
    // without the space it rests at its static position — the end of the items, 200px
    // short. 200 and not 500: it stops *at* the scrollport, which is the property the
    // next assertion is about.
    const h = setup({ count: 3, trackContent: true })
    mountSlot(h, 'stickyFooter', 300)

    expect(trails(h)).toEqual([0, 200])
    // Which is the property the whole mechanism rests on: filling *to* the scrollport
    // leaves the browser's maximum at 0, so no anchor, offset, band or alignment can
    // observe the space — and a short list still gets no scrollbar.
    expect(h.maxOffset()).toBe(0)
  })

  it('leaves the sizer at the items’ own total', () => {
    // The whole point of holding this as its own style. `setContentSize` means the
    // total scrollable content size, `totalSize` is the model every consumer reads,
    // and a sizer claiming 500px of comments would be a lie with 200px in it.
    const h = setup({ count: 3, trackContent: true })
    mountSlot(h, 'stickyFooter', 300)

    expect(sizes(h)).toEqual([300])
    expect(h.engine.store.getState().totalSize).toBe(300)
  })

  it('gives the space back when the viewport shrinks under the content', () => {
    const h = setup({ count: 3, trackContent: true })
    mountSlot(h, 'stickyFooter', 300)
    h.resize(400)

    // 400px of scrollport less a 300px composer leaves 100, which the items already
    // exceed — so there is nothing left to hold.
    expect(trails(h)).toEqual([0, 200, 0])
  })

  it('holds nothing once the items fill the scrollport', () => {
    const h = setup({ count: 50, trackContent: true })
    mountSlot(h, 'stickyFooter', 300)

    expect(trails(h)).toEqual([0])
  })

  it('holds nothing for a footer that merely scrolls away', () => {
    // The gate, and the line between the two kinds of trailing slot. A plain `footer`
    // is in-flow content belonging under the last comment; a list that pushed it to the
    // bottom of an unfilled scrollport would be doing something nobody asked for.
    const h = setup({ count: 3, trackContent: true })
    mountSlot(h, 'footer', 300)

    expect(trails(h)).toEqual([0])
  })

  it('counts the other slots against the space it holds', () => {
    // Everything else in the scrollport is room the space does not have to cover.
    // 800 less 300px of items, a 100px footer and a 300px composer is 100 — and the
    // footer is counted once, not again for sharing `spaceAfter` with the composer.
    const h = setup({ count: 3, trackContent: true })
    mountSlot(h, 'footer', 100)
    mountSlot(h, 'stickyFooter', 300)

    expect(trails(h)).toEqual([0, 100])
  })

  it('counts the consumer’s own `scrollMargin` against it too', () => {
    // Page content above a window-scrolled list is scrollable space as well, and it is
    // space no sum of *our* slots can see. Holding past it would push the page into
    // having a scroll range it did not have — the one thing this must not do.
    const h = setup({ count: 3, trackContent: true, geometry: { scrollMargin: 100 } })
    mountSlot(h, 'stickyFooter', 300)

    expect(trails(h)).toEqual([0, 100])
  })

  it('spends the slack once under `alignToBottom`', () => {
    // The two placements want the same 200px and only one of them may have it. They are
    // exclusive branches of one decision, so this is not really in doubt any more — but
    // short content held against the bottom *and* pushed away from it is the bug the
    // arrangement exists to rule out, and a case saying so costs nothing.
    const h = setup({ count: 3, trackContent: true, alignToBottom: true })
    mountSlot(h, 'stickyFooter', 300)

    expect(h.writes).toContain('lead:200')
    expect(trails(h)).toEqual([0])
  })

  it('gives the space back when the composer unmounts', () => {
    // react-virtuoso #1203 is a slot's height outliving the slot. The same argument
    // applies to space held on its behalf.
    const h = setup({ count: 3, trackContent: true })
    const composer = mountSlot(h, 'stickyFooter', 300)

    composer.detach()

    expect(trails(h)).toEqual([0, 200, 0])
  })

  it('holds the whole scrollport for an empty list with a composer', () => {
    // The case with no items to hide it: an empty state, a filter that matched
    // nothing, or the first render before a single row has measured.
    const h = setup({ count: 0, trackContent: true })
    mountSlot(h, 'stickyFooter', 300)

    expect(trails(h)).toEqual([0, 500])
    expect(sizes(h)).toEqual([0])
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
    expect(written(h, 'lead:')).toEqual([0])
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
    expect(written(h, 'lead:')).toEqual([0])
  })

  it('holds short content against the bottom of the scroller, not of the list', () => {
    // The defect the shared computation surfaced. `scrollMargin` is page content above
    // a window-scrolled list — the only mode where a consumer sets it — and it occupies
    // scrollport exactly as our own chrome does. Padding by the whole 500px on top of
    // it pushed the content 200px past the window's bottom, which is a scroll range on
    // a list that fits: the one thing holding content against the bottom must not do.
    const h = setup({
      count: 3,
      trackContent: true,
      alignToBottom: true,
      geometry: { scrollMargin: 200 },
    })

    expect(written(h, 'lead:')).toEqual([300])
  })

  it('counts the consumer’s own trailing space too', () => {
    // The same argument below the list, and the same omission: `spaceAfter` is in-flow
    // content after the last item, so it is scrollport the items do not have.
    const h = setup({
      count: 3,
      trackContent: true,
      alignToBottom: true,
      geometry: { spaceAfter: 100 },
    })

    expect(written(h, 'lead:')).toEqual([400])
  })
})
