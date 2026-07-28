import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElementViewport, createWindowViewport } from './viewport.js'

/** jsdom reports zero for layout, so the values a real engine would give are stubbed. */
const stubLayout = (
  element: HTMLElement,
  layout: { scrollHeight: number; clientHeight: number; clientTop?: number; top?: number },
): void => {
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
    new DOMRect(0, layout.top ?? 0, 400, layout.clientHeight),
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

    deliver(target: Element, blockSize: number): void {
      this.callback(
        [
          {
            target,
            borderBoxSize: [{ blockSize, inlineSize: 0 }],
            contentRect: new DOMRect(0, 0, 0, blockSize),
          },
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

  it('does not report the synthetic first entry as a resize', () => {
    // `observe()` always delivers an entry for a newly observed element. Reported as a
    // resize it reads as the scrollport changing size one frame after mount, and a
    // consumer that treats that as a reflow discards every measurement it holds —
    // which is exactly how the `sizeSnapshot` feature came to do nothing.
    const element = document.createElement('div')
    document.body.appendChild(element)
    const onResize = vi.fn()

    createElementViewport(element).observeSize(onResize)
    const observer = FakeResizeObserver.latest!

    observer.deliver(element, 800)
    expect(onResize).toHaveBeenCalledExactlyOnceWith(800)

    // The same size again is not a change.
    observer.deliver(element, 800)
    expect(onResize).toHaveBeenCalledOnce()

    // A genuine change still reports.
    observer.deliver(element, 600)
    expect(onResize).toHaveBeenLastCalledWith(600)
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

  it('takes the window scroller size from innerHeight, not from the document', () => {
    // The critical distinction: `documentElement`'s border-box height is the CONTENT
    // height, so observing it made every content growth look like a viewport resize —
    // and a window-scrolled list erased its own measurement history as it scrolled.
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 700 })
    const onResize = vi.fn()

    const stop = createWindowViewport(window).observeSize(onResize)
    window.dispatchEvent(new Event('resize'))
    expect(onResize).toHaveBeenCalledWith(700)

    stop()
    onResize.mockClear()
    window.dispatchEvent(new Event('resize'))
    expect(onResize).not.toHaveBeenCalled()
  })

  it('gives a window scroller no gate target, since it cannot leave the screen', () => {
    expect(createWindowViewport(window).getGateTarget()).toBeNull()

    const element = document.createElement('div')
    expect(createElementViewport(element).getGateTarget()).toBe(element)
  })
})
