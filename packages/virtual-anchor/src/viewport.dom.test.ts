import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElementViewport, createWindowViewport } from './viewport.js'

/** jsdom reports zero for layout, so the values a real engine would give are stubbed. */
const stubLayout = (
  element: HTMLElement,
  layout: {
    scrollHeight: number
    clientHeight: number
    clientTop?: number
    top?: number
    /** The exact box height, which can be fractional where `clientHeight` cannot. */
    boxHeight?: number
    /** Border box height: `offsetHeight - clientHeight` is borders plus any scrollbar. */
    offsetHeight?: number
  },
): void => {
  Object.defineProperty(element, 'offsetHeight', {
    configurable: true,
    value: layout.offsetHeight ?? layout.clientHeight,
  })
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    value: layout.scrollHeight,
  })
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    value: layout.clientHeight,
  })
  Object.defineProperty(element, 'clientTop', {
    configurable: true,
    value: layout.clientTop ?? 0,
  })
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, layout.top ?? 0, 400, layout.boxHeight ?? layout.clientHeight),
  )
}

beforeEach(() => {
  document.body.replaceChildren()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createElementViewport', () => {
  const setup = () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    stubLayout(element, { scrollHeight: 10_000, clientHeight: 600, clientTop: 1, top: 50 })
    return { element, viewport: createElementViewport(element) }
  }

  it('is its own scrollport, measurement scope and gate target', () => {
    // All three coincide for an element scroller — the distinction only exists because a
    // document scroller has to answer them with different nodes.
    const { element, viewport } = setup()
    expect(viewport.getScrollportElement()).toBe(element)
    expect(viewport.getElement()).toBe(element)
    expect(viewport.getGateTarget()).toBe(element)
  })

  it('reads and writes the scroll offset', () => {
    const { element, viewport } = setup()
    expect(viewport.getScrollOffset()).toBe(0)

    viewport.setScrollOffset(1204.5)
    expect(element.scrollTop).toBe(1204.5)
    expect(viewport.getScrollOffset()).toBe(1204.5)
  })

  it('reports the visible extent', () => {
    const { viewport } = setup()
    expect(viewport.getViewportSize()).toBe(600)
  })

  it('reports a fractional extent exactly, rather than the rounded clientHeight', () => {
    // `clientHeight` is an integer: a scrollport 634.5px tall reports 635. Alignment
    // arithmetic is built from this number, so that half-pixel landed an `align: 'end'`
    // target below the visible bottom — on any scrollport with a fractional height, which a
    // flex layout under a wrapping header produces immediately.
    const element = document.createElement('div')
    stubLayout(element, {
      scrollHeight: 10_000,
      clientHeight: 635,
      offsetHeight: 635,
      boxHeight: 634.5,
    })

    expect(createElementViewport(element).getViewportSize()).toBe(634.5)
  })

  it('excludes borders and a horizontal scrollbar from the extent', () => {
    // `offsetHeight - clientHeight` is what the box height includes and the content height
    // does not: the horizontal borders, plus a horizontal scrollbar if there is one.
    const element = document.createElement('div')
    stubLayout(element, {
      scrollHeight: 10_000,
      clientHeight: 600,
      offsetHeight: 620,
      boxHeight: 619.5,
    })

    expect(createElementViewport(element).getViewportSize()).toBe(599.5)
  })

  it('never reports a negative extent', () => {
    const element = document.createElement('div')
    stubLayout(element, { scrollHeight: 100, clientHeight: 0, offsetHeight: 20, boxHeight: 0 })
    expect(createElementViewport(element).getViewportSize()).toBe(0)
  })

  it('takes the maximum offset from the DOM, not from an estimate', () => {
    // Clamping against our own estimated total is the root cause of TanStack
    // #1001: the estimate is not the document.
    const { viewport } = setup()
    expect(viewport.getMaxScrollOffset()).toBe(9400)
  })

  it('never reports a negative maximum for unscrollable content', () => {
    const element = document.createElement('div')
    stubLayout(element, { scrollHeight: 100, clientHeight: 600 })
    expect(createElementViewport(element).getMaxScrollOffset()).toBe(0)
  })

  it('subscribes passively and unsubscribes cleanly', () => {
    const { element, viewport } = setup()
    const add = vi.spyOn(element, 'addEventListener')
    const remove = vi.spyOn(element, 'removeEventListener')
    const listener = vi.fn()

    const off = viewport.addEventListener('scroll', listener)
    expect(add).toHaveBeenCalledWith('scroll', listener, { passive: true })

    element.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()

    off()
    element.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledWith('scroll', listener)
  })

  it('exposes the element and its own window for observers', () => {
    const { element, viewport } = setup()
    expect(viewport.getElement()).toBe(element)
    expect(viewport.getWindow()).toBe(window)
  })

  it('reports the device pixel ratio, defaulting sensibly', () => {
    const { viewport } = setup()
    expect(viewport.getDevicePixelRatio()).toBeGreaterThan(0)
  })
})

describe('createWindowViewport', () => {
  const stubWindow = (values: {
    scrollY?: number
    innerHeight?: number
    scrollHeight?: number
  }): void => {
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: values.scrollY ?? 0,
    })
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: values.innerHeight ?? 800,
    })
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      configurable: true,
      value: values.scrollHeight ?? 20_000,
    })
  }

  it('reads the offset from the window and the extent from the document', () => {
    // The platform forces this asymmetry: scrollY from the window, scrollHeight
    // from documentElement, and innerHeight rather than clientHeight so mobile
    // URL-bar behaviour is accounted for.
    stubWindow({ scrollY: 1500, innerHeight: 800, scrollHeight: 20_000 })
    const viewport = createWindowViewport(window)

    expect(viewport.getScrollOffset()).toBe(1500)
    expect(viewport.getViewportSize()).toBe(800)
    expect(viewport.getMaxScrollOffset()).toBe(19_200)
  })

  it('never reports a negative maximum for a short page', () => {
    stubWindow({ innerHeight: 800, scrollHeight: 400 })
    expect(createWindowViewport(window).getMaxScrollOffset()).toBe(0)
  })

  it('scrolls the window without animating', () => {
    stubWindow({})
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    createWindowViewport(window).setScrollOffset(940.25)
    // Explicit 'auto': a stray `scroll-behavior: smooth` would otherwise animate
    // every corrective write and fight the convergence loop.
    expect(scrollTo).toHaveBeenCalledWith({ top: 940.25, behavior: 'auto' })
  })

  it('subscribes on the window and unsubscribes cleanly', () => {
    stubWindow({})
    const viewport = createWindowViewport(window)
    const listener = vi.fn()

    const off = viewport.addEventListener('scroll', listener)
    window.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()

    off()
    window.dispatchEvent(new Event('scroll'))
    expect(listener).toHaveBeenCalledOnce()
  })

  it('exposes the documentElement for observers', () => {
    stubWindow({})
    const viewport = createWindowViewport(window)
    expect(viewport.getElement()).toBe(document.documentElement)
    expect(viewport.getWindow()).toBe(window)
    expect(viewport.getDevicePixelRatio()).toBeGreaterThan(0)
  })

  it('follows scrollingElement for the scrollport, while observers keep documentElement', () => {
    // Quirks mode: `body` is what scrolls, so `documentElement.scrollHeight` is not the page's
    // scroll extent and clamping against it is wrong — the TanStack #1001 failure this
    // interface's own doc warns about. `getElement()` must *not* follow, because it is the
    // measurement and input scope, and moving it once made every content growth look like a
    // viewport resize.
    stubWindow({ scrollY: 0, innerHeight: 800, scrollHeight: 20_000 })
    Object.defineProperty(document.body, 'scrollHeight', { configurable: true, get: () => 50_000 })
    const original = Object.getOwnPropertyDescriptor(Document.prototype, 'scrollingElement')
    Object.defineProperty(document, 'scrollingElement', {
      configurable: true,
      get: () => document.body,
    })

    try {
      const viewport = createWindowViewport(window)
      expect(viewport.getScrollportElement()).toBe(document.body)
      expect(viewport.getMaxScrollOffset()).toBe(49_200)
      expect(viewport.getElement()).toBe(document.documentElement)
    } finally {
      delete (document as unknown as Record<string, unknown>).scrollingElement
      delete (document.body as unknown as Record<string, unknown>).scrollHeight
      if (original) Object.defineProperty(Document.prototype, 'scrollingElement', original)
    }
  })

  it('falls back to documentElement when the document reports no scrollingElement', () => {
    // jsdom's default, and a real state for a document with no browsing context. The fallback is
    // what keeps the resolver from handing back null.
    stubWindow({ scrollY: 0, innerHeight: 800, scrollHeight: 20_000 })
    const viewport = createWindowViewport(window)
    expect(viewport.getScrollportElement()).toBe(document.documentElement)
    expect(viewport.getMaxScrollOffset()).toBe(19_200)
  })
})

describe('viewport size observation', () => {
  /** Controllable ResizeObserver — jsdom has none. */
  class FakeResizeObserver implements ResizeObserver {
    static latest: FakeResizeObserver | null = null
    disconnected = false

    constructor(private readonly callback: ResizeObserverCallback) {
      FakeResizeObserver.latest = this
    }

    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      this.disconnected = true
    }

    deliver(target: Element, blockSize: number, inlineSize: number): void {
      this.emit(target, blockSize, inlineSize, [{ blockSize, inlineSize }])
    }

    /** As older Safari delivers it: `borderBoxSize` is an empty list. */
    deliverWithoutBorderBox(target: Element, blockSize: number, inlineSize: number): void {
      this.emit(target, blockSize, inlineSize, [])
    }

    private emit(
      target: Element,
      blockSize: number,
      inlineSize: number,
      borderBoxSize: { blockSize: number; inlineSize: number }[],
    ): void {
      this.callback(
        [
          { target, borderBoxSize, contentRect: new DOMRect(0, 0, inlineSize, blockSize) },
        ] as unknown as ResizeObserverEntry[],
        this,
      )
    }
  }

  beforeEach(() => {
    FakeResizeObserver.latest = null
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: FakeResizeObserver,
    })
  })

  /** An observed element, with the observer that feeds it and the callback it feeds. */
  const observeElement = () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const onResize = vi.fn()
    createElementViewport(element).observeSize(onResize)
    return { element, observer: FakeResizeObserver.latest!, onResize }
  }

  it('drops a delivery that changed nothing, and reports one that did', () => {
    // The synthetic first entry `observe()` delivers for a newly observed element *is*
    // reported — there is nothing yet to compare it against. Not reading that one as a
    // change is the consumer's job: read as a reflow it discards every measurement one
    // frame after mount, which is how the `sizeSnapshot` feature came to do nothing.
    const { element, observer, onResize } = observeElement()

    observer.deliver(element, 800, 600)
    expect(onResize).toHaveBeenCalledOnce()

    // The same box again is not a change.
    observer.deliver(element, 800, 600)
    expect(onResize).toHaveBeenCalledOnce()

    // A height change still reports, carrying nothing: the callback says the scrollport
    // moved, and a consumer that wants a dimension asks the viewport for it.
    observer.deliver(element, 600, 600)
    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onResize).toHaveBeenLastCalledWith()
  })

  it('reports a width-only resize, which is the axis that reflows', () => {
    // The #34 defect: the consumer answers a resize by re-reading a fingerprint of the
    // scrollport's *width*, so swallowing a width-only delivery left every row height
    // measured under the old width — visible as rows drawn overlapping or with gaps,
    // healing only for the rows still mounted, which the item observer re-measures.
    const { element, observer, onResize } = observeElement()

    observer.deliver(element, 800, 800)
    onResize.mockClear()

    // A responsive column narrowing, or a sidebar opening beside the list: same height.
    observer.deliver(element, 800, 400)
    expect(onResize).toHaveBeenCalledOnce()

    // Still deduped on the pair, so the repeat costs the consumer nothing.
    observer.deliver(element, 800, 400)
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('falls back to the content rect on both axes when there is no border box', () => {
    // Older Safari delivers `borderBoxSize` as an empty list. Reading only
    // `contentRect.height` there would reintroduce the swallow on the inline axis.
    const { element, observer, onResize } = observeElement()

    observer.deliverWithoutBorderBox(element, 800, 800)
    expect(onResize).toHaveBeenCalledOnce()

    // One axis at a time, so each delivery reports only if the fallback read that axis:
    // width first, which is the one #34 was about, then height.
    observer.deliverWithoutBorderBox(element, 800, 400)
    expect(onResize).toHaveBeenCalledTimes(2)

    observer.deliverWithoutBorderBox(element, 600, 400)
    expect(onResize).toHaveBeenCalledTimes(3)
  })

  it('disconnects on cleanup', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)

    const stop = createElementViewport(element).observeSize(vi.fn())
    stop()
    expect(FakeResizeObserver.latest?.disconnected).toBe(true)
  })

  it('observes the border box, so padding and borders count', () => {
    const element = document.createElement('div')
    document.body.appendChild(element)
    const observe = vi.spyOn(FakeResizeObserver.prototype, 'observe')

    createElementViewport(element).observeSize(vi.fn())
    expect(observe).toHaveBeenCalledWith(element, { box: 'border-box' })
  })

  it('watches the window for a resize, not the document, and unsubscribes cleanly', () => {
    // The critical distinction: `documentElement`'s border-box height is the CONTENT
    // height, so observing it made every content growth look like a viewport resize —
    // and a window-scrolled list erased its own measurement history as it scrolled. The
    // window's own `resize` tracks the scrollport instead, and what the scrollport now
    // measures is `getViewportSize`'s answer rather than anything this callback carries.
    const onResize = vi.fn()

    const stop = createWindowViewport(window).observeSize(onResize)
    window.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledOnce()
    // With *no* arguments, which is the whole of the contract and the one thing handing
    // the callback straight to `addEventListener` would get wrong: the DOM calls a
    // listener with the `Event`, so the two implementations of this one interface would
    // disagree about what they pass — invisibly, since the type says neither.
    expect(onResize).toHaveBeenLastCalledWith()

    stop()
    window.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledOnce()
  })

  it('reports every window resize, even one that changes no size at all', () => {
    // The asymmetry with the element scroller, and the reason #34 was an element-scroller
    // bug only: this implementation dedups nothing. So a purely horizontal window drag —
    // the ordinary way a `windowScroller` list's scrollport changes width — already
    // reaches the consumer, which is handed no size and re-reads the fingerprint itself.
    const onResize = vi.fn()
    const stop = createWindowViewport(window).observeSize(onResize)

    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledTimes(2)

    stop()
  })

  it('gives a window scroller no gate target, since it cannot leave the screen', () => {
    expect(createWindowViewport(window).getGateTarget()).toBeNull()

    const element = document.createElement('div')
    expect(createElementViewport(element).getGateTarget()).toBe(element)
  })
})
