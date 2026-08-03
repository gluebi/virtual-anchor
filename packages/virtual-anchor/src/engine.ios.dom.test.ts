import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEngine, layoutSignatureFor, type Engine } from './engine.js'
import type { Surface } from './surface.js'
import type { ItemKey, SlotName } from './types.js'
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

const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

const patched: string[] = []
const pretendIPhone = (): void => {
  const values: Record<string, unknown> = {
    userAgent: IPHONE_UA,
    platform: 'iPhone',
    maxTouchPoints: 5,
  }
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(navigator, name, { configurable: true, get: () => value })
    patched.push(name)
  }
  Object.defineProperty(window, 'ontouchend', { configurable: true, value: null })
}

const unpretendIPhone = (): void => {
  for (const name of patched) Reflect.deleteProperty(navigator, name)
  patched.length = 0
  Reflect.deleteProperty(window, 'ontouchend')
}

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
  writes: string[]
  /** Just the scroll writes, which is what this file is about. */
  scrollWrites: () => number[]
  offset: () => number
  setOffset: (value: number) => void
  scroll: (value: number) => void
  scrollSettled: () => void
  resize: (size: number) => void
  measure: (key: ItemKey, size: number) => void
  measureSlot: (slot: SlotName, size: number) => void
  mountItem: (key: ItemKey, height: number) => HTMLElement
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
  const slotElements = new Map<SlotName, HTMLElement>()
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
    writes,
    scrollWrites: () =>
      writes.filter((w) => w.startsWith('scroll:')).map((w) => Number(w.slice('scroll:'.length))),
    offset: () => state.offset,
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
    resize: (size) => {
      state.viewportSize = size
      for (const listener of [...sizeListeners]) listener(size)
    },
    measure: (key, size) => {
      const element = elements.get(key)
      if (element) FakeResizeObserver.deliverTo(element, size)
    },
    measureSlot: (slot, size) => {
      const element = slotElements.get(slot)
      if (element) FakeResizeObserver.deliverTo(element, size)
    },
    mountItem: (key, height) => {
      const element = document.createElement('div')
      vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, height))
      document.body.appendChild(element)
      engine.observeItem(element, key)
      return element
    },
    contentWidth: (value) => {
      state.contentWidth = value
    },
  }

  function mountSlot(slot: SlotName, height: number): void {
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 600, height))
    document.body.appendChild(element)
    slotElements.set(slot, element)
    engine.observeSlot(element, slot)
  }
  // Referenced so the helper is not dead code when a test wants a slot.
  void mountSlot
}

const touch = (element: HTMLElement, type: 'touchstart' | 'touchend' | 'touchcancel'): void => {
  element.dispatchEvent(new Event(type))
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
    // A phantom intent is consumed by the next momentum scroll event, which then
    // skips re-deriving the anchor for a scroll that really was the reader's —
    // leaving the anchor stale for the rest of the fling.
    //
    // The offset the refused restore *would* have written is learned by running the
    // same measurement with the gate open, rather than hard-coded: it depends on the
    // median estimator, so a literal here would silently stop being the offset under
    // test the moment that changed. Landing the next momentum frame exactly there is
    // what makes a phantom intent match, within `isSelfWrite`'s 1.5px tolerance.
    const reference = setup()
    reference.mountItem('c10', 100)
    reference.scroll(5000)
    const writesBefore = reference.scrollWrites().length
    reference.measure('c10', 700)
    const restored = reference.scrollWrites().at(writesBefore)
    expect(restored).toBeTypeOf('number')

    const h = setup()
    h.mountItem('c10', 100)
    fling(h, 5000)
    h.measure('c10', 700)
    expect(h.scrollWrites().at(-1)).not.toBe(restored)

    h.scroll(restored!)

    // Re-derived from where the fling actually is, not skipped as an echo.
    expect(h.engine.getAnchor()).toEqual(reference.engine.getAnchor())
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
