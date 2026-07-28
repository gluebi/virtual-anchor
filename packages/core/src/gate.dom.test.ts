import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScrollerGate } from './gate.js'

/** Controllable IntersectionObserver — jsdom has none. */
class FakeIntersectionObserver implements IntersectionObserver {
  static instances: FakeIntersectionObserver[] = []

  readonly root: Element | null
  readonly rootMargin = '0px'
  readonly thresholds: readonly number[]
  readonly observed = new Set<Element>()
  disconnected = false

  constructor(
    private readonly callback: IntersectionObserverCallback,
    init?: IntersectionObserverInit,
  ) {
    this.root = (init?.root as Element | null) ?? null
    this.thresholds = Array.isArray(init?.threshold) ? init.threshold : [init?.threshold ?? 0]
    FakeIntersectionObserver.instances.push(this)
  }

  observe(target: Element): void {
    this.observed.add(target)
  }

  unobserve(target: Element): void {
    this.observed.delete(target)
  }

  disconnect(): void {
    this.disconnected = true
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  /** Deliver an intersection: `bounds` is the element, `visible` the on-screen slice. */
  deliver(target: Element, bounds: DOMRect, visible: DOMRect | null): void {
    const entry = {
      target,
      isIntersecting: visible !== null,
      boundingClientRect: bounds,
      intersectionRect: visible ?? new DOMRect(0, 0, 0, 0),
      intersectionRatio: visible ? visible.height / (bounds.height || 1) : 0,
      rootBounds: null,
      time: 0,
    } as unknown as IntersectionObserverEntry
    this.callback([entry], this)
  }

  static latest(): FakeIntersectionObserver {
    const instance = FakeIntersectionObserver.instances.at(-1)
    if (!instance) throw new Error('no IntersectionObserver was constructed')
    return instance
  }
}

class FakeResizeObserver implements ResizeObserver {
  static instances: FakeResizeObserver[] = []
  disconnected = false

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }

  observe(): void {}
  unobserve(): void {}
  disconnect(): void {
    this.disconnected = true
  }

  deliver(target: Element, blockSize: number): void {
    const entries = [
      {
        target,
        borderBoxSize: [{ blockSize, inlineSize: 0 }],
        contentRect: new DOMRect(0, 0, 0, blockSize),
      },
    ] as unknown as ResizeObserverEntry[]
    this.callback(entries, this)
  }

  static latest(): FakeResizeObserver {
    const instance = FakeResizeObserver.instances.at(-1)
    if (!instance) throw new Error('no ResizeObserver was constructed')
    return instance
  }
}

let visibilityState: DocumentVisibilityState = 'visible'

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  FakeResizeObserver.instances = []
  Object.defineProperty(window, 'IntersectionObserver', {
    configurable: true,
    writable: true,
    value: FakeIntersectionObserver,
  })
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  })
  visibilityState = 'visible'
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState,
  })
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const setup = () => {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const onChange = vi.fn()
  const gate = createScrollerGate({ element, onChange })
  return { element, gate, onChange }
}

describe('createScrollerGate', () => {
  it('observes against the viewport, not the scroller itself', () => {
    // Using the scroller as its own root would always answer "yes, visible" —
    // which is exactly the question this is meant to answer.
    setup()
    expect(FakeIntersectionObserver.latest().root).toBeNull()
    expect(FakeIntersectionObserver.latest().thresholds).toEqual([0])
  })

  it('costs one observer of each kind, whatever the item count', () => {
    setup()
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(FakeResizeObserver.instances).toHaveLength(1)
  })

  it('starts open, so the first frame is not needlessly blank', () => {
    const { gate } = setup()
    expect(gate.isOpen()).toBe(true)
  })

  it('closes when the scroller leaves the screen', () => {
    const { element, gate, onChange } = setup()

    FakeIntersectionObserver.latest().deliver(element, new DOMRect(0, -900, 400, 600), null)
    expect(gate.isOpen()).toBe(false)
    expect(gate.getVisibleBand()).toBeNull()
    expect(onChange).toHaveBeenCalled()
  })

  it('reopens when the scroller comes back', () => {
    const { element, gate } = setup()
    const observer = FakeIntersectionObserver.latest()

    observer.deliver(element, new DOMRect(0, -900, 400, 600), null)
    observer.deliver(element, new DOMRect(0, 0, 400, 600), new DOMRect(0, 0, 400, 600))
    expect(gate.isOpen()).toBe(true)
    expect(gate.getVisibleBand()).toEqual({ start: 0, end: 600 })
  })

  it('reports the on-screen slice of a half-visible scroller', () => {
    // Neither pure geometry nor a bare "is it intersecting" boolean gets this
    // right: geometry thinks the whole scrollport is visible, and the boolean
    // says yes.
    const { element, gate } = setup()

    // A 600px scroller whose top 200px are above the fold.
    FakeIntersectionObserver.latest().deliver(
      element,
      new DOMRect(0, -200, 400, 600),
      new DOMRect(0, 0, 400, 400),
    )

    expect(gate.getVisibleBand()).toEqual({ start: 200, end: 600 })
  })

  it('reports the slice when the scroller runs off the bottom', () => {
    const { element, gate } = setup()

    // A 600px scroller starting 500px down an 800px viewport.
    FakeIntersectionObserver.latest().deliver(
      element,
      new DOMRect(0, 500, 400, 600),
      new DOMRect(0, 500, 400, 300),
    )

    expect(gate.getVisibleBand()).toEqual({ start: 0, end: 300 })
  })

  it('closes when the tab goes to the background', () => {
    const { gate, onChange } = setup()

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))

    expect(gate.isOpen()).toBe(false)
    expect(onChange).toHaveBeenCalled()
  })

  it('reopens when the tab comes back', () => {
    const { gate } = setup()

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))

    expect(gate.isOpen()).toBe(true)
  })

  it('closes when the scroller collapses to nothing', () => {
    // A closed <details>, a hidden tab panel, or `display: none`.
    const { element, gate, onChange } = setup()

    FakeResizeObserver.latest().deliver(element, 0)
    expect(gate.isOpen()).toBe(false)
    expect(onChange).toHaveBeenCalled()

    FakeResizeObserver.latest().deliver(element, 600)
    expect(gate.isOpen()).toBe(true)
  })

  it('stays closed if any single condition fails', () => {
    const { element, gate } = setup()

    FakeIntersectionObserver.latest().deliver(
      element,
      new DOMRect(0, 0, 400, 600),
      new DOMRect(0, 0, 400, 600),
    )
    expect(gate.isOpen()).toBe(true)

    visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    expect(gate.isOpen()).toBe(false)
    expect(gate.getVisibleBand()).toBeNull()
  })

  it('disconnects everything and stays closed after disposal', () => {
    const { gate, onChange } = setup()
    const io = FakeIntersectionObserver.latest()
    const ro = FakeResizeObserver.latest()

    gate.dispose()

    expect(io.disconnected).toBe(true)
    expect(ro.disconnected).toBe(true)
    expect(gate.isOpen()).toBe(false)
    expect(gate.getVisibleBand()).toBeNull()

    onChange.mockClear()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(onChange).not.toHaveBeenCalled()
  })

  it('is safe to dispose twice', () => {
    const { gate } = setup()
    gate.dispose()
    expect(() => {
      gate.dispose()
    }).not.toThrow()
  })

  it('works without observers at all, rather than throwing', () => {
    // A detached element has no defaultView. The gate degrades to "document
    // visibility only" instead of taking the list down with it.
    const detached = document.createElement('div')
    Object.defineProperty(detached, 'ownerDocument', {
      configurable: true,
      value: { defaultView: null, visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    })

    const gate = createScrollerGate({ element: detached })
    expect(gate.isOpen()).toBe(true)
    gate.dispose()
  })
})
