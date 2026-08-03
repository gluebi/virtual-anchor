import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pretendIPhone, touch, unpretendIPhone } from './iosPlatform.test.helpers.js'
import { createEngine, layoutSignatureFor, type Engine } from './engine.js'
import { setTraceSink, type TraceEvent } from './trace.js'
import type { Surface } from './surface.js'
import type { ItemKey } from './types.js'
import type { Viewport } from './viewport.js'

/**
 * The engine's own scroll writes, on iOS.
 *
 * There were no engine-level iOS tests at all, which is exactly why issue #26
 * survived: the guard against writing `scrollTop` during a fling lived inside the
 * scroller and was tested there, while `engine.publish()` wrote straight past it
 * from six different triggers. Every one of those is a row in this file.
 *
 * The distinction under test is not "does it write" but *why* it was going to. A
 * measurement landing is postponable, because the fling is already moving the view by
 * more than the correction would; a prepend is not, because skipping it moves the
 * reader by the whole inserted height.
 */

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

interface Harness {
  engine: Engine
  scroller: HTMLElement
  /** Just the scroll writes, which is what this file is about. */
  scrollWrites: () => number[]
  /** Every gesture shift handed to the surface, in order. */
  shifts: () => number[]
  offset: () => number
  scroll: (value: number) => void
  scrollSettled: () => void
  resize: (size: number) => void
  measure: (key: ItemKey, size: number) => void
  mountItem: (key: ItemKey, height: number) => void
  contentWidth: (value: number) => void
}

const setup = (
  options: Partial<Parameters<typeof createEngine>[0]> & {
    count?: number
    /**
     * Derive the maximum from the content, as a browser does.
     *
     * Needed by anything about the *end* of the list: following writes
     * `getMaxScrollOffset()`, and a constant makes "at the bottom" unreachable, so
     * the first scroll event unpins and the follow branch is never exercised at all.
     */
    trackContent?: boolean
  } = {},
): Harness => {
  const { count = 200, trackContent = false, ...engineOptions } = options

  const scroller = document.createElement('div')
  document.body.appendChild(scroller)

  const state = { offset: 0, viewportSize: 800, contentWidth: 600, contentSize: 0, leadingSpace: 0 }
  const writes: string[] = []
  const elements = new Map<ItemKey, HTMLElement>()
  const scrollListeners: (() => void)[] = []
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
    dispose: () => {
      elements.clear()
    },
  }

  const viewport: Viewport = {
    getScrollOffset: () => state.offset,
    getViewportSize: () => state.viewportSize,
    getMaxScrollOffset: () =>
      trackContent
        ? Math.max(0, state.contentSize + state.leadingSpace - state.viewportSize)
        : 1_000_000,
    setScrollOffset: (next) => {
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
    layoutSignature: layoutSignatureFor(scroller),
    ...engineOptions,
  })
  engine.mount()

  return {
    engine,
    scroller,
    scrollWrites: () =>
      writes.filter((w) => w.startsWith('scroll:')).map((w) => Number(w.slice('scroll:'.length))),
    shifts: () =>
      writes.filter((w) => w.startsWith('shift:')).map((w) => Number(w.slice('shift:'.length))),
    offset: () => state.offset,
    scroll: (value) => {
      state.offset = value
      for (const listener of [...scrollListeners]) listener()
    },
    scrollSettled: () => {
      for (const listener of [...scrollEndListeners]) listener()
    },
    resize: (size) => {
      state.viewportSize = size
      for (const listener of [...sizeListeners]) listener(size)
    },
    measure: (key, size) => {
      const element = elements.get(key)
      if (element) FakeResizeObserver.deliverTo(element, size)
    },
    mountItem: (key, height) => {
      const element = document.createElement('div')
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, height))
      document.body.appendChild(element)
      engine.observeItem(element, key)
    },
    contentWidth: (value) => {
      state.contentWidth = value
    },
  }
}


/**
 * Put the list into live momentum: finger down, finger up, one frame of fling.
 *
 * The scroll event is what tells the gate this is a fling rather than a tap, and it
 * is the state every assertion below is made in.
 */
const fling = (h: Harness, to = 5000): void => {
  h.scroll(2000)
  touch(h.scroller, 'touchstart')
  touch(h.scroller, 'touchend')
  vi.advanceTimersByTime(50)
  h.scroll(to)
}

beforeEach(() => {
  vi.useFakeTimers()
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
  pretendIPhone()
})

afterEach(() => {
  unpretendIPhone()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('the engine on iOS WebKit', () => {
  it('does not write scrollTop when a row is measured on mount mid-fling', () => {
    // The hottest path of the bug. During a fling every row that scrolls into view
    // is measured on mount, and in a list of variable-height text almost none of
    // them match their estimate — so this ran, and wrote, on very nearly every frame.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.mountItem('c30', 450)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('does not write scrollTop when a ResizeObserver batch lands mid-fling', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    const before = h.scrollWrites().length

    h.measure('c30', 700)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('does not write scrollTop when the scrollport changes height mid-fling', () => {
    // On iOS this case *is* the URL bar collapsing as the reader flings, which is
    // about the most common way to lose a fling there.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.resize(600)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('applies the deferred correction once the fling settles', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    h.measure('c30', 700)
    const before = h.scrollWrites().length

    h.scrollSettled()

    // Exactly one write, not one per skipped correction: they all resolve to the
    // same anchor, so replaying them individually would write the same offset over.
    expect(h.scrollWrites().slice(before)).toHaveLength(1)
  })

  it('writes for a prepend even mid-fling', () => {
    // The deliberate exception. Deferring a model change would move the reader by the
    // whole inserted height — the one thing an anchored list promises cannot happen —
    // so a cancelled fling is accepted as the lesser harm.
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.engine.setOptions({ keys: [...KEYS(10, 'older'), ...KEYS(200)] })

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('writes for a reflow that discarded every measurement, even mid-fling', () => {
    const h = setup()
    h.mountItem('c30', 100)
    h.measure('c30', 700)
    fling(h)
    const before = h.scrollWrites().length

    // A width change is a real reflow: every measurement is invalidated, so every
    // offset in the list moved and the restore is not a wobble.
    h.contentWidth(320)
    h.resize(800)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('writes for an explicit setAnchor even mid-fling', () => {
    const h = setup()
    fling(h)
    const before = h.scrollWrites().length

    h.engine.setAnchor({ key: 'c40', offsetWithinItem: 0 })

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })

  it('does not record a restore intent for a write it refused', () => {
    // A phantom intent is consumed by the next momentum scroll event, which then skips
    // re-deriving the anchor for a scroll that really was the reader's — leaving the
    // anchor stale for the rest of the fling.
    //
    // The offset the refused write aimed at is taken from the trace rather than
    // hard-coded: it depends on the median estimator, so a literal would quietly stop
    // being the offset under test. Landing the next momentum frame exactly there is
    // what makes a phantom intent match, within `isSelfWrite`'s 1.5px tolerance.
    const seen: TraceEvent[] = []
    expect(setTraceSink((event) => seen.push(event))).toBe(true)

    try {
      const h = setup()
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 700)

      const refused = seen.find(
        (event) => event.topic === 'scroll.write' && event.data.deferred === true,
      )
      expect(refused).toBeDefined()

      const before = h.engine.getAnchor()
      h.scroll(Number(refused?.data.offset))

      expect(h.engine.getAnchor()).not.toEqual(before)
    } finally {
      setTraceSink(null)
    }
  })

  it('holds the follow pin rather than writing it mid-fling', () => {
    // Following writes on every publish, so a fling launched from the bottom hits it
    // at momentum onset — the worst possible moment to cancel one. `trackContent` is
    // what makes "at the bottom" reachable, and so what keeps `following` armed
    // through the scroll event instead of unpinning on it.
    const h = setup({ followOutput: true, trackContent: true })
    touch(h.scroller, 'touchstart')
    touch(h.scroller, 'touchend')
    vi.advanceTimersByTime(50)
    // A momentum frame that stays pinned to the end.
    h.scroll(h.offset())
    const before = h.scrollWrites().length

    h.mountItem('c30', 450)

    expect(h.scrollWrites().slice(before)).toEqual([])
  })

  it('reopens at the hard cap if the platform never reports a settle', () => {
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    h.measure('c30', 700)
    const before = h.scrollWrites().length

    vi.advanceTimersByTime(3100)

    expect(h.scrollWrites().slice(before)).toHaveLength(1)
  })

  it('holds the view with a paint offset instead of the refused scroll write', () => {
    // The whole point of #28. Deferring alone left the content lurching by the full
    // correction — measured at 389px per row on a phone — because nothing cancelled the
    // growth above the anchor. The shift is that cancellation, applied where the
    // platform cannot refuse it.
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length

    h.measure('c10', 700)

    expect(h.scrollWrites().slice(scrollsBefore)).toEqual([])
    const shift = h.shifts().at(-1)
    expect(shift).toBeDefined()
    expect(Math.abs(shift ?? 0)).toBeGreaterThan(0)
  })

  it('accumulates successive refused corrections into one shift', () => {
    // `estimateSize` rather than the harness default, which supplies only
    // `defaultEstimate` and so leaves the median estimator live: the second measurement
    // would then rebuild every unmeasured offset at once and produce a correction two
    // orders of magnitude past the cap. That is a real effect worth knowing about, but
    // it is not accumulation, and the consumer this bug was reported against supplies an
    // estimator — which is precisely why its corrections are per-row.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    h.mountItem('c12', 100)
    fling(h, 5000)

    h.measure('c10', 700)
    const first = h.shifts().at(-1) ?? 0
    h.measure('c12', 500)
    const second = h.shifts().at(-1) ?? 0

    // One running total, not two independent offsets — the second correction is
    // applied on top of the first, not instead of it.
    expect(Math.abs(second)).toBeGreaterThan(Math.abs(first))
  })

  it('derives the anchor from where the content is, not from scrollTop', () => {
    // The subtlest half of the compensation. While a shift is outstanding the content
    // has moved without `scrollTop`, so an anchor derived from the raw offset describes
    // a position the view is not at — and every momentum event would then re-derive it
    // wrong, compounding instead of holding.
    //
    // Observable as idempotence: once compensated, a further publish with nothing
    // changed must find no correction left to make.
    const h = setup({ estimateSize: () => 100 })
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    const held = h.shifts().at(-1) ?? 0
    expect(held).not.toBe(0)

    // A momentum frame that does not move: the anchor is re-derived here.
    h.scroll(5000)
    // A publish with no model change behind it.
    h.resize(800)

    expect(h.shifts().at(-1) ?? 0).toBe(held)
  })

  it('folds the shift into scrollTop once the gesture ends, and clears it', () => {
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    const shift = h.shifts().at(-1) ?? 0
    const offsetBefore = h.offset()

    h.scrollSettled()

    // `scrollTop` moves forward by exactly what the content was holding, and the
    // content offset returns to zero. Same visible position, different mechanism.
    expect(h.offset()).toBeCloseTo(offsetBefore + shift, 5)
    expect(h.shifts().at(-1)).toBe(0)
  })

  it('takes the write rather than holding a shift larger than the cap', () => {
    // Past the cap the scrollbar, `atBottom` and both edge thresholds are reading a
    // position the content is nowhere near, and only a shrinking amount of scroll range
    // is left to absorb it. Losing the fling is the lesser harm.
    const h = setup({ count: 400 })
    fling(h, 5000)
    const scrollsBefore = h.scrollWrites().length

    // One absurdly tall row: 40 000px against a 100px estimate, far past 2 viewports.
    h.mountItem('c10', 40_000)

    expect(h.scrollWrites().slice(scrollsBefore)).not.toEqual([])
    expect(h.shifts().at(-1) ?? 0).toBe(0)
  })

  it('leaves no shift outstanding off iOS', () => {
    unpretendIPhone()
    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)

    h.measure('c10', 700)

    // The gate is inert, so the write is taken and the paint offset is never used.
    expect(h.shifts().filter((px) => px !== 0)).toEqual([])
  })

  it('reports every correction it was about to make, deferred or not', () => {
    // The diagnostic that made this bug measurable on a device rather than a matter
    // of opinion: it is what produced the 389px figure in #28. Tested because it is
    // load-bearing for future device work, and because it costs bundle size that has
    // to be justified.
    const seen: TraceEvent[] = []
    expect(setTraceSink((event) => seen.push(event))).toBe(true)

    try {
      const h = setup()
      h.mountItem('c10', 100)
      fling(h, 5000)
      h.measure('c10', 700)

      const writes = seen.filter((event) => event.topic === 'scroll.write')
      expect(writes.length).toBeGreaterThan(0)

      const deferred = writes.find((event) => event.data.deferred === true)
      expect(deferred).toBeDefined()
      expect(deferred?.data.restore).toBe('measure')
      // The delta is the size of the uncorrected shift, which is the whole point of
      // reporting it — a sub-pixel wobble and a 389px lurch are the same event
      // otherwise.
      expect(Math.abs(Number(deferred?.data.delta))).toBeGreaterThan(0)
    } finally {
      setTraceSink(null)
    }
  })

  it('writes a measurement correction normally when no gesture is in flight', () => {
    const h = setup()
    h.mountItem('c10', 100)
    // Above the anchor, deliberately. A row measured *below* it moves nothing the
    // anchor resolves against, so there is no correction to make and no write to
    // suppress — which is precisely why a down-fling survives this bug and an
    // up-fling does not.
    h.scroll(5000)
    const before = h.scrollWrites().length

    h.measure('c10', 700)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })
})

describe('the engine off iOS', () => {
  beforeEach(() => {
    unpretendIPhone()
  })

  it('writes a measurement correction during a touch scroll, as it always has', () => {
    // The inertness guard. None of the above may cost anything on Chromium,
    // Firefox or desktop WebKit, where writing `scrollTop` does not cancel anything.
    const h = setup()
    h.mountItem('c30', 100)
    fling(h)
    const before = h.scrollWrites().length

    h.measure('c30', 700)

    expect(h.scrollWrites().slice(before)).not.toEqual([])
  })
})
